import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNote } from '../src/frontmatter';
import { validateLegacySources, validateRelativePath } from '../src/legacy';
import { DirectoryEntry, FileAccess, NoteRepository } from '../src/noteRepository';

type MemoryEntry = { kind: DirectoryEntry['kind']; text?: string; mtime: number };

class MemoryFiles implements FileAccess {
  readonly entries = new Map<string, MemoryEntry>([['', { kind: 'directory', mtime: 0 }]]);
  readonly unreadable = new Set<string>();
  writes = 0;

  put(path: string, text: string, mtime = 1): void {
    this.putParents(path);
    this.entries.set(path, { kind: 'file', text, mtime });
  }

  private putParents(path: string): void {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      this.entries.set(parts.slice(0, index).join('/'), { kind: 'directory', mtime: 0 });
    }
  }

  private get(path: string): MemoryEntry {
    const entry = this.entries.get(path);
    if (!entry) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    return entry;
  }

  async readDirectory(path: string): Promise<DirectoryEntry[]> {
    assert.equal(this.get(path).kind, 'directory');
    const prefix = path ? `${path}/` : '';
    return [...this.entries].flatMap(([name, entry]) => {
      if (!name.startsWith(prefix) || name === path) return [];
      const relative = name.slice(prefix.length);
      return relative && !relative.includes('/') ? [{ name: relative, kind: entry.kind }] : [];
    });
  }

  async readText(path: string): Promise<string> {
    if (this.unreadable.has(path)) throw new Error('Permission denied');
    const entry = this.get(path);
    assert.equal(entry.kind, 'file');
    return entry.text ?? '';
  }

  async stat(path: string): Promise<{ mtime: number }> {
    return { mtime: this.get(path).mtime };
  }

  async ensureDirectory(path: string): Promise<void> {
    this.writes++;
    this.putParents(`${path}/placeholder`);
  }

  async createFile(path: string, content: string): Promise<'created' | 'exists'> {
    if (this.entries.has(path)) return 'exists';
    this.writes++;
    this.put(path, content);
    return 'created';
  }
}

function validNote(title: string, folder = 'note', tags = '[planning]'): string {
  return `---\ntitle: ${title}\nfolder: ${folder}\ntags: ${tags}\ncreated: 2026-10-18\n---\n\n# ${title}\n`;
}

const legacySources = [
  { path: 'notes/idea.md', folder: 'idea' },
  { path: 'notes/thoughts.md', folder: 'reflection' },
  { path: 'reading', folder: 'note' },
];

test('initialization and scanning an empty workspace do not write files or create folders', async () => {
  const files = new MemoryFiles();
  const before = [...files.entries];
  const repository = new NoteRepository(files);
  assert.deepEqual(await repository.scan(), { notes: [], errors: [] });
  assert.equal(files.writes, 0);
  assert.deepEqual([...files.entries], before);
});

test('recursive scans discover managed notes and preserve existing documents without writes', async () => {
  const files = new MemoryFiles();
  files.put('note/planning/paper.md', validNote('Paper', 'note', '[shopping, planning]'), 50);
  files.put('notes/idea.md', '# Old ideas\n\n## Idea one\nText #shopping');
  files.put('notes/thoughts.md', '# Thoughts\n\nKeep this text.');
  files.put('reading/plans.md', '# Plans reading\n\n## First paper\n## Second paper');
  files.put('notes/routine.md', '# Routine');
  files.put('drafts/outline.md', '# Outline');
  const before = [...files.entries];
  const result = await new NoteRepository(files, ['idea', 'note'], legacySources).scan();
  assert.equal(result.notes.length, 4);
  assert.deepEqual(result.errors, []);
  const paper = result.notes.find(note => note.relativePath.includes('paper.md'))!;
  assert.equal(paper.title, 'Paper');
  assert.deepEqual(paper.tags, ['shopping', 'planning']);
  assert.equal(paper.mtime, 50);
  assert.equal(paper.legacy, false);
  const ideas = result.notes.find(note => note.relativePath === 'notes/idea.md')!;
  assert.equal(ideas.folder, 'idea');
  assert.equal(ideas.legacy, true);
  assert.deepEqual(ideas.tags, []);
  assert.deepEqual(ideas.issues, []);
  assert.equal(ideas.title, 'Old ideas');
  assert.equal(files.writes, 0);
  assert.deepEqual([...files.entries], before);
});

test('malformed YAML warns while plain Markdown remains browsable without metadata warnings', async () => {
  const files = new MemoryFiles();
  files.put('note/broken.md', '---\ntitle: [broken\n---\n\n# Broken paper\n');
  files.put('idea/plain.md', '# No metadata\n');
  files.put('reading/broken.md', '---\ntags: [broken\n---\n# Legacy broken');
  const result = await new NoteRepository(files, ['idea', 'note'], legacySources).scan();
  assert.equal(result.notes.length, 3);
  for (const note of result.notes) {
    assert.equal(note.issues.length > 0, note.relativePath !== 'idea/plain.md');
    assert.deepEqual(note.tags, []);
  }
  assert.equal(result.notes.find(note => note.relativePath === 'note/broken.md')?.title, 'Broken paper');
  assert.equal(result.notes.find(note => note.relativePath === 'idea/plain.md')?.title, 'No metadata');
  assert.equal(files.writes, 0);
});

test('unreadable notes remain visible and do not prevent indexing readable neighbors', async () => {
  const files = new MemoryFiles();
  files.put('note/unreadable.md', 'private contents');
  files.put('note/readable.md', validNote('Readable'));
  files.unreadable.add('note/unreadable.md');
  const result = await new NoteRepository(files, ['idea', 'note'], legacySources).scan();
  assert.equal(result.notes.length, 2);
  const inaccessible = result.notes.find(note => note.relativePath.includes('unreadable'))!;
  assert.equal(inaccessible.title, 'unreadable');
  assert.match(inaccessible.issues.join(' '), /Permission denied/u);
  assert.match(result.errors.join(' '), /note\/unreadable\.md/u);
  assert.equal(result.notes.find(note => note.title === 'Readable')?.issues.length, 0);
});

test('legacy sources can expose valid frontmatter tags and be disabled entirely', async () => {
  const files = new MemoryFiles();
  files.put('reading/paper.md', validNote('Existing', 'note', '[travel, shopping]'));
  const result = await new NoteRepository(files, ['idea', 'note'], legacySources).scan();
  assert.deepEqual(result.notes[0].tags, ['travel', 'shopping']);
  assert.equal(result.notes[0].legacy, true);
  assert.equal((await new NoteRepository(files, []).scan()).notes.length, 0);
  assert.equal(files.writes, 0);
});

test('folder classification stays authoritative when frontmatter declares a different folder', async () => {
  const files = new MemoryFiles();
  files.put('note/wrong-type.md', validNote('Wrong type', 'idea'));
  const result = await new NoteRepository(files, ['idea', 'note'], legacySources).scan();
  assert.equal(result.notes[0].folder, 'note');
  assert.ok(result.notes[0].issues.length > 0);
  assert.equal(files.writes, 0);
});

test('subsequent scans reflect external file edits, creation, deletion, and rename', async () => {
  const files = new MemoryFiles();
  files.put('note/old.md', validNote('Old'));
  const repository = new NoteRepository(files, ['note', 'reflection']);
  assert.equal((await repository.scan()).notes[0].title, 'Old');
  files.entries.delete('note/old.md');
  files.put('note/renamed.md', validNote('Updated', 'note', '[new-tag]'), 99);
  files.put('reflection/new.md', validNote('New thought', 'reflection'));
  const result = await repository.scan();
  assert.equal(result.notes.length, 2);
  assert.ok(!result.notes.some(note => note.relativePath === 'note/old.md'));
  const renamed = result.notes.find(note => note.relativePath === 'note/renamed.md')!;
  assert.equal(renamed.title, 'Updated');
  assert.deepEqual(renamed.tags, ['new-tag']);
  assert.equal(renamed.mtime, 99);
});

test('scans never follow symlink roots, nested directories, or direct legacy files', async () => {
  const files = new MemoryFiles();
  files.entries.set('note', { kind: 'symlink', mtime: 0 });
  files.put('idea/visible.md', validNote('Visible', 'idea'));
  files.entries.set('idea/linked', { kind: 'symlink', mtime: 0 });
  files.put('notes/idea.md', 'placeholder');
  files.entries.set('notes/idea.md', { kind: 'symlink', mtime: 0 });
  files.entries.set('reading', { kind: 'symlink', mtime: 0 });
  const result = await new NoteRepository(files, ['idea', 'note'], legacySources).scan();
  assert.deepEqual(result.notes.map(note => note.title), ['Visible']);
  assert.deepEqual(result.errors, []);
});

test('overlapping legacy mappings do not duplicate files', async () => {
  const files = new MemoryFiles();
  files.put('reading/paper.md', '# Paper');
  const repository = new NoteRepository(files, ['idea', 'note'], [
    { path: 'reading', folder: 'note' },
    { path: 'reading/paper.md', folder: 'note' },
  ]);
  assert.equal((await repository.scan()).notes.length, 1);
});

test('creation writes a Markdown note with exactly the four metadata fields and normalizes tags', async () => {
  const files = new MemoryFiles();
  const repository = new NoteRepository(files);
  const path = await repository.create({ title: '  Shopping Ideas  ', folder: 'idea', tags: [' shopping ', 'shopping', 'planning'] }, new Date(2026, 9, 18, 12));
  assert.equal(path, 'idea/2026-10-18-shopping-ideas.md');
  const text = await files.readText(path);
  const parsed = parseNote(text, 'idea');
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.metadata, { title: 'Shopping Ideas', folder: 'idea', tags: ['shopping', 'planning'], created: '2026-10-18' });
  assert.match(text, /# Shopping Ideas/u);
  assert.equal(files.entries.has('note'), false);
  assert.equal(files.entries.has('reflection'), false);
});

test('duplicate filenames receive suffixes without changing existing files', async () => {
  const files = new MemoryFiles();
  files.put('note/2026-10-18-paper.md', 'Existing content, preserve exactly.');
  files.put('note/2026-10-18-paper-2.md', 'Second existing content.');
  const path = await new NoteRepository(files).create({ title: 'Paper', folder: 'note', tags: [] }, new Date(2026, 9, 18));
  assert.equal(path, 'note/2026-10-18-paper-3.md');
  assert.equal(await files.readText('note/2026-10-18-paper.md'), 'Existing content, preserve exactly.');
  assert.equal(await files.readText('note/2026-10-18-paper-2.md'), 'Second existing content.');
});

test('concurrent creation retries the exclusive create operation safely', async () => {
  const files = new MemoryFiles();
  const repository = new NoteRepository(files);
  const input = { title: 'Same title', folder: 'note' as const, tags: [] };
  const paths = await Promise.all(Array.from({ length: 5 }, () => repository.create(input, new Date(2026, 9, 18))));
  assert.equal(new Set(paths).size, 5);
  assert.ok(paths.includes('note/2026-10-18-same-title.md'));
  assert.ok(paths.includes('note/2026-10-18-same-title-5.md'));
  assert.equal((await repository.scan()).notes.length, 5);
});

test('invalid creation input fails before any directories or files are written', async () => {
  const files = new MemoryFiles();
  const repository = new NoteRepository(files);
  await assert.rejects(repository.create({ title: '  ', folder: 'note', tags: [] }), /title/iu);
  await assert.rejects(repository.create({ title: 'Title', folder: 'note', tags: [] }, new Date(NaN)), /invalid date/iu);
  assert.equal(files.writes, 0);
  assert.equal(files.entries.size, 1);
});

test('relative path validation rejects workspace escapes and normalizes Windows separators', () => {
  assert.equal(validateRelativePath('reading\\papers\\paper.md'), 'reading/papers/paper.md');
  for (const path of ['', '/tmp/note.md', '../note.md', 'notes/../note.md', './notes', 'C:\\notes', '\\\\server\\notes', 'file:///notes', 'reading//paper.md', '.git/config', 'notes/.hidden/file.md', 'notes/trailing.']) {
    assert.throws(() => validateRelativePath(path), Error, path);
  }
  assert.throws(() => validateLegacySources([{ path: 'note/note.md', folder: 'note' }]), /overlaps/u);
  assert.deepEqual(validateLegacySources([{ path: 'outside', folder: 'Custom' }]), [{ path: 'outside', folder: 'Custom' }]);
  assert.throws(() => validateLegacySources([{ path: 'reading', folder: 'note' }, { path: 'reading', folder: 'idea' }]), /conflicting/u);
});


test('more than three custom roots, including nested roots, are indexed without duplicates', async () => {
  const files = new MemoryFiles();
  const folders = ['idea', 'note', 'work', 'work/design', 'personal/随笔'];
  for (const folder of folders) files.put(`${folder}/entry.md`, validNote(folder, folder));
  const repository = new NoteRepository(files, folders);
  const result = await repository.scan();
  assert.equal(result.notes.length, folders.length);
  assert.equal(new Set(result.notes.map(note => note.relativePath)).size, folders.length);
  for (const folder of folders) {
    const note = result.notes.find(note => note.relativePath === `${folder}/entry.md`)!;
    assert.equal(note.folder, folder);
    assert.deepEqual(note.issues, []);
  }
  const path = await repository.create({ title: 'Custom note', folder: 'personal/随笔', tags: ['planning', '自由标签'] }, new Date(2026, 9, 18));
  assert.equal(path, 'personal/随笔/2026-10-18-custom-note.md');
  assert.deepEqual(parseNote(await files.readText(path), 'personal/随笔').metadata?.tags, ['planning', '自由标签']);
});

test('reading old type/topics notes is non-destructive and retains all valid labels', async () => {
  const files = new MemoryFiles();
  const text = '---\ntitle: Old idea\ntype: Project Idea\ntopics: [Planning, work]\ncreated: 2026-10-18\n---\n\n# Original body\n';
  files.put('project-ideas/old.md', text);
  const result = await new NoteRepository(files, ['project-ideas']).scan();
  assert.deepEqual(result.notes[0].tags, ['Planning', 'work']);
  assert.equal(result.notes[0].folder, 'project-ideas');
  assert.equal(result.notes[0].title, 'Old idea');
  assert.deepEqual(result.notes[0].issues, []);
  assert.equal(await files.readText('project-ideas/old.md'), text);
  assert.equal(files.writes, 0);
});

test('unconfigured folders and invalid tags cannot create files', async () => {
  const files = new MemoryFiles();
  const repository = new NoteRepository(files);
  for (const folder of ['custom', '../escape', '/tmp/escape']) {
    await assert.rejects(repository.create({ title: 'Title', folder, tags: [] }), /configured note folder/);
  }
  for (const tags of [[''], ['bad\nlabel'], [42] as unknown as string[]]) {
    await assert.rejects(repository.create({ title: 'Title', folder: 'note', tags }), /Tags/);
  }
  assert.equal(files.writes, 0);
});

test('old legacy source type mappings remain readable with arbitrary group names', () => {
  assert.deepEqual(validateLegacySources([{ path: 'reading', type: 'Reference' }]), [{ path: 'reading', folder: 'Reference' }]);
  assert.throws(() => validateLegacySources([{ path: 'reading', folder: 'note', type: 'idea' }]), /conflicting/);
  assert.throws(() => validateLegacySources([{ path: 'custom', folder: 'note' }], ['custom/nested']), /overlaps/);
});
