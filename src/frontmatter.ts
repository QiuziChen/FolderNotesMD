import { parseDocument, stringify } from 'yaml';
import { isCalendarDate, NoteMetadata } from './model';
import { validateRelativePath } from './legacy';

export interface ParsedNote {
  metadata?: NoteMetadata;
  issues: string[];
}

export interface ParsedExistingNote {
  metadata?: Partial<NoteMetadata>;
  issues: string[];
}

const METADATA_FIELDS = ['title', 'folder', 'tags', 'created'] as const;
const LEGACY_METADATA_FIELDS = ['title', 'type', 'topics', 'created'] as const;
const MAX_FRONTMATTER_LENGTH = 64 * 1024;

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const input of tags) {
    const tag = input.trim().normalize('NFC');
    const key = tag.toLowerCase().normalize('NFC');
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

export function validateTitle(value: string): string | undefined {
  if (!value.trim()) return 'Enter a nonempty title.';
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value)) {
    return 'The title must be one line without control characters.';
  }
  return undefined;
}

function validateMetadata(value: unknown, expectedFolder: string, allowLegacy = true): ParsedNote {
  if (!(value instanceof Map)) {
    return { issues: ['Frontmatter must be a YAML mapping.'] };
  }

  // Old notes keep their content and labels; the configured folder controls grouping.
  const legacy = allowLegacy && !value.has('folder') && !value.has('tags')
    && (value.has('type') || value.has('topics'));
  const fields = legacy ? LEGACY_METADATA_FIELDS : METADATA_FIELDS;
  const issues: string[] = [];
  for (const key of value.keys()) {
    if (typeof key !== 'string' || !fields.some((field) => field === key)) {
      issues.push(`Frontmatter may contain only ${fields.join(', ')}.`);
      break;
    }
  }
  for (const field of fields) {
    if (!value.has(field)) issues.push(`Missing frontmatter field: ${field}.`);
  }

  const title: unknown = value.get('title');
  const folder: unknown = legacy ? expectedFolder : value.get('folder');
  const tags: unknown = value.get(legacy ? 'topics' : 'tags');
  const created: unknown = value.get('created');

  if (typeof title !== 'string') {
    issues.push('The title must be a string.');
  } else {
    const issue = validateTitle(title);
    if (issue) issues.push(issue);
  }
  if (legacy && (typeof value.get('type') !== 'string' || validateTitle(value.get('type')) !== undefined)) {
    issues.push('The legacy type must be a nonempty, single-line string.');
  }
  if (typeof folder !== 'string') {
    issues.push('The folder must be a workspace-relative path.');
  } else {
    try {
      if (validateRelativePath(folder) !== expectedFolder) {
        issues.push(`The folder must match its configured folder: expected ${expectedFolder}.`);
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Invalid folder path.');
    }
  }
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || validateTitle(tag) !== undefined)) {
    issues.push('The tags field must be an array of nonempty, single-line strings without control characters; an empty array is allowed.');
  }
  if (typeof created !== 'string' || !isCalendarDate(created)) {
    issues.push('The created field must be a valid calendar date in YYYY-MM-DD format.');
  }

  if (issues.length) return { issues };
  return {
    metadata: {
      title: (title as string).trim(),
      folder: expectedFolder,
      tags: normalizeTags(tags as string[]),
      created: created as string,
    },
    issues,
  };
}

function readFrontmatter(text: string): { present: boolean; value?: unknown; issues: string[] } {
  const content = text.replace(/^\uFEFF/u, '');
  const opening = /^---[ \t]*(?:\r?\n|$)/u.exec(content);
  if (!opening) return { present: false, issues: [] };

  const remainder = content.slice(opening[0].length);
  const closing = /^---[ \t]*\r?$/mu.exec(remainder);
  if (!closing) return { present: true, issues: ['YAML frontmatter is missing its closing --- delimiter.'] };
  if (closing.index > MAX_FRONTMATTER_LENGTH) {
    return { present: true, issues: ['YAML frontmatter exceeds the 65,536-character limit.'] };
  }

  try {
    const document = parseDocument(remainder.slice(0, closing.index), {
      schema: 'core',
      strict: true,
      uniqueKeys: true,
    });
    const diagnostics = [...document.errors, ...document.warnings];
    if (diagnostics.length) return { present: true, issues: diagnostics.map((diagnostic) => `Invalid YAML: ${diagnostic.message}`) };
    // A Map avoids object-prototype keys. No aliases are needed by this schema.
    const value: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
    return { present: true, value, issues: [] };
  } catch (error: unknown) {
    return { present: true, issues: [`Invalid YAML: ${error instanceof Error ? error.message : 'Unable to parse frontmatter.'}`] };
  }
}

export function parseNote(text: string, expectedFolder: string): ParsedNote {
  const parsed = readFrontmatter(text);
  if (!parsed.present) return { issues: ['Missing YAML frontmatter at the start of the file.'] };
  if (parsed.issues.length) return { issues: parsed.issues };
  return validateMetadata(parsed.value, expectedFolder);
}

/** Read existing documents without requiring or rewriting the new-note schema. */
export function parseExistingNote(text: string, expectedFolder: string): ParsedExistingNote {
  const parsed = readFrontmatter(text);
  if (!parsed.present || parsed.issues.length) return { issues: parsed.issues };
  const value = parsed.value;
  if (value === null) return { metadata: { folder: expectedFolder }, issues: [] };
  if (!(value instanceof Map)) return { issues: ['Frontmatter must be a YAML mapping.'] };

  const metadata: Partial<NoteMetadata> = { folder: expectedFolder };
  const issues: string[] = [];
  if (value.has('title')) {
    const title: unknown = value.get('title');
    if (typeof title !== 'string' || validateTitle(title) !== undefined) {
      issues.push('The title must be a nonempty, single-line string without control characters.');
    } else metadata.title = title.trim();
  }
  if (value.has('folder')) {
    const folder: unknown = value.get('folder');
    if (typeof folder !== 'string') issues.push('The folder must be a workspace-relative path.');
    else {
      try {
        if (validateRelativePath(folder) !== expectedFolder) {
          issues.push(`The folder must match its configured folder: expected ${expectedFolder}.`);
        }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : 'Invalid folder path.');
      }
    }
  }
  const tagField = value.has('tags') ? 'tags' : value.has('topics') ? 'topics' : undefined;
  if (tagField) {
    const tags: unknown = value.get(tagField);
    const entries: unknown[] = typeof tags === 'string' ? [tags] : Array.isArray(tags) ? tags : [];
    const valid = entries.filter((tag): tag is string => typeof tag === 'string' && validateTitle(tag) === undefined);
    if ((!Array.isArray(tags) && typeof tags !== 'string') || valid.length !== entries.length) {
      issues.push(`The ${tagField} field must be a nonempty, single-line string or an array of such strings without control characters; an empty array is allowed.`);
    }
    metadata.tags = normalizeTags(valid);
  }
  if (value.has('created')) {
    const created: unknown = value.get('created');
    if (typeof created !== 'string' || !isCalendarDate(created)) {
      issues.push('The created field must be a valid calendar date in YYYY-MM-DD format.');
    } else metadata.created = created;
  }
  return { metadata, issues };
}

export function serializeNote(metadata: NoteMetadata): string {
  const result = validateMetadata(new Map(Object.entries(metadata)), metadata.folder, false);
  if (!result.metadata) throw new Error(result.issues.join(' '));
  const normalized = result.metadata;
  const yaml = stringify(normalized, { lineWidth: 0 });
  return `---\n${yaml}---\n\n# ${normalized.title}\n\n`;
}
