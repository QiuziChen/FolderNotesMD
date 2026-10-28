import { DEFAULT_FOLDERS } from './model';

export interface LegacySource {
  path: string;
  folder: string;
}

export const DEFAULT_LEGACY_SOURCES: readonly LegacySource[] = Object.freeze([]);

/** Normalize portable workspace-relative paths; never resolve traversal segments. */
export function validateRelativePath(value: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('A nonempty workspace-relative path is required.');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /[\u0000-\u001f\u007f\u0085\u2028\u2029:<>"|?*]/u.test(normalized)) {
    throw new Error(`Path must be workspace-relative and portable: ${value}`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment.startsWith('.') || /[. ]$/u.test(segment))) {
    throw new Error(`Path cannot contain empty, hidden, or traversal segments: ${value}`);
  }
  return normalized;
}

export function validateLegacySources(value: unknown, folders: readonly string[] = DEFAULT_FOLDERS): LegacySource[] {
  if (!Array.isArray(value)) {
    throw new Error('FolderNotesMD legacySources must be an array of { path, folder } entries.');
  }
  const result: LegacySource[] = [];
  const seen = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string') {
      throw new Error('Each legacy source needs a relative path and folder.');
    }
    const folderValue: unknown = entry.folder ?? entry.type;
    if (typeof folderValue !== 'string') throw new Error('Each legacy source needs a relative path and folder.');
    const path = validateRelativePath(entry.path);
    const folder = validateRelativePath(folderValue);
    if (entry.folder !== undefined && entry.type !== undefined && entry.folder !== entry.type) {
      throw new Error(`Legacy source has conflicting folder and type fields: ${path}`);
    }
    const key = path.normalize('NFC').toLowerCase();
    if (folders.some(managed => {
      const managedKey = managed.normalize('NFC').toLowerCase();
      return key === managedKey || key.startsWith(`${managedKey}/`) || managedKey.startsWith(`${key}/`);
    })) {
      throw new Error(`Legacy source overlaps a managed note folder: ${path}`);
    }
    const previous = seen.get(key);
    if (previous !== undefined && previous !== folder) {
      throw new Error(`Legacy source has conflicting folders: ${path}`);
    }
    if (previous === undefined) {
      result.push({ path, folder });
      seen.set(key, folder);
    }
  }
  return result;
}
