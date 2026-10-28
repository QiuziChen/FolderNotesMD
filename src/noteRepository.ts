import { localDate, noteFilename } from './filenames';
import { parseExistingNote, serializeNote, validateTitle } from './frontmatter';
import { DEFAULT_LEGACY_SOURCES, LegacySource, validateLegacySources, validateRelativePath } from './legacy';
import { DEFAULT_FOLDERS, NewNoteInput, NoteMetadata, NoteRecord } from './model';
import { validateFolders, validateTags } from './configuration';

export interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink';
}

/** Paths use '/' separators. Only readDirectory accepts '' to mean the journal root. */
export interface FileAccess {
  readDirectory(relativePath: string): Promise<DirectoryEntry[]>;
  readText(relativePath: string): Promise<string>;
  stat(relativePath: string): Promise<{ mtime: number }>;
  ensureDirectory(relativePath: string): Promise<void>;
  /** Must create with exclusive/non-overwriting semantics, including concurrent calls. */
  createFile(relativePath: string, content: string): Promise<'created' | 'exists'>;
}

export interface ScanResult {
  notes: NoteRecord[];
  errors: string[];
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'FileNotFound');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallbackTitle(text: string, path: string): string {
  let body = text.replace(/^\uFEFF/u, '');
  const opening = /^---[ \t]*\r?\n/u.exec(body);
  if (opening) {
    const remainder = body.slice(opening[0].length);
    const closing = /^---[ \t]*\r?$/mu.exec(remainder);
    if (closing) body = remainder.slice(closing.index + closing[0].length);
  }
  const heading = /^ {0,3}#\s+(.+?)\s*#*\s*$/mu.exec(body)?.[1]?.trim();
  if (heading) return heading;
  return (path.split('/').pop() ?? path).replace(/\.md$/iu, '');
}

export class NoteRepository {
  readonly folders: readonly string[];
  readonly legacySources: readonly LegacySource[];

  constructor(
    private readonly files: FileAccess,
    folders: readonly string[] = DEFAULT_FOLDERS,
    legacySources: readonly LegacySource[] = DEFAULT_LEGACY_SOURCES,
  ) {
    this.folders = Object.freeze(validateFolders(folders));
    this.legacySources = Object.freeze(validateLegacySources(legacySources, this.folders));
  }

  /** Read only: missing folders are normal and initialization never writes metadata. */
  async scan(): Promise<ScanResult> {
    const notes: NoteRecord[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    const visitedFolders = new Set<string>();
    const directories = new Map<string, Promise<DirectoryEntry[]>>();
    const list = (path: string): Promise<DirectoryEntry[]> => {
      let pending = directories.get(path);
      if (!pending) {
        pending = this.files.readDirectory(path).catch(error => {
          if (!isMissing(error)) errors.push(`Cannot read folder ${path || '(workspace root)'}: ${message(error)}`);
          return [];
        });
        directories.set(path, pending);
      }
      return pending;
    };
    const add = async (path: string, folder: string, legacy: boolean): Promise<void> => {
      if (seen.has(path) || !/\.md$/iu.test(path)) return;
      seen.add(path);
      let text = '';
      let mtime = 0;
      let readable = true;
      const issues: string[] = [];
      try {
        text = await this.files.readText(path);
      } catch (error) {
        // A file deleted during a scan should disappear rather than leave a stale item.
        if (isMissing(error)) return;
        readable = false;
        const issue = `Cannot read note: ${message(error)}`;
        issues.push(issue);
        errors.push(`${path}: ${issue}`);
      }
      try {
        mtime = (await this.files.stat(path)).mtime;
      } catch (error) {
        if (isMissing(error)) return;
        const issue = `Cannot read modification time: ${message(error)}`;
        issues.push(issue);
        errors.push(`${path}: ${issue}`);
      }
      const parsed = readable ? parseExistingNote(text, folder) : undefined;
      if (parsed) issues.push(...parsed.issues);
      const metadata = parsed?.metadata;
      notes.push({
        relativePath: path,
        title: metadata?.title ?? fallbackTitle(text, path),
        folder,
        tags: metadata?.tags ?? [],
        created: metadata?.created,
        mtime,
        legacy,
        issues,
      });
    };
    const walk = async (path: string, folder: string, legacy: boolean): Promise<void> => {
      if (visitedFolders.has(path)) return;
      visitedFolders.add(path);
      const entries = await list(path);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.kind === 'symlink' || entry.name.startsWith('.')) continue;
        let child: string;
        try {
          child = validateRelativePath(`${path}/${entry.name}`);
        } catch (error) {
          errors.push(message(error));
          continue;
        }
        if (entry.kind === 'directory') await walk(child, folder, legacy);
        else await add(child, folder, legacy);
      }
    };
    const resolve = async (path: string): Promise<DirectoryEntry | undefined> => {
      let parent = '';
      const parts = path.split('/');
      for (let index = 0; index < parts.length; index++) {
        const entry = (await list(parent)).find(candidate => candidate.name === parts[index]);
        if (!entry || entry.kind === 'symlink') return undefined;
        if (index === parts.length - 1) return entry;
        if (entry.kind !== 'directory') return undefined;
        parent = parent ? `${parent}/${entry.name}` : entry.name;
      }
      return undefined;
    };

    // Visit deepest roots first so overlapping roots classify each note exactly once.
    // Managed folders take precedence over optional legacy sources.
    for (const path of [...this.folders].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const entry = await resolve(path);
      if (entry?.kind === 'directory') await walk(path, path, false);
      else if (entry) errors.push(`Expected a note folder but found a file: ${path}`);
    }
    for (const source of this.legacySources) {
      const entry = await resolve(source.path);
      if (entry?.kind === 'directory') await walk(source.path, source.folder, true);
      else if (entry?.kind === 'file') await add(source.path, source.folder, true);
    }
    return { notes, errors };
  }

  async create(input: NewNoteInput, date: Date = new Date()): Promise<string> {
    const titleError = validateTitle(input.title);
    if (titleError) throw new Error(titleError);
    if (!this.folders.includes(input.folder)) throw new Error('Select a configured note folder.');
    const tags = validateTags(input.tags);
    if (!Number.isFinite(date.getTime())) throw new Error('Cannot create a note with an invalid date.');
    const metadata: NoteMetadata = {
      title: input.title.trim(),
      folder: input.folder,
      tags,
      created: localDate(date),
    };
    const content = serializeNote(metadata);
    const folder = input.folder;
    try {
      await this.files.ensureDirectory(folder);
      for (let attempt = 1; attempt <= 10000; attempt++) {
        const path = validateRelativePath(`${folder}/${noteFilename(metadata.title, metadata.created, attempt)}`);
        if (await this.files.createFile(path, content) === 'created') return path;
      }
      throw new Error('Too many notes share this title and date. Choose a different title.');
    } catch (error) {
      throw new Error(`Cannot create note in ${folder}: ${message(error)}`);
    }
  }
}
