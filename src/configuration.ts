import { normalizeTags, validateTitle } from './frontmatter';
import { validateRelativePath } from './legacy';

/** Folder roots may be nested; the most specific root owns each indexed note. */
export function validateFolders(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(folder => typeof folder !== 'string')) {
    throw new Error('FolderNotesMD folders must be an array of workspace-relative folder paths.');
  }
  const result: string[] = [];
  const seen = new Map<string, string>();
  for (const item of value) {
    const folder = validateRelativePath(item);
    const key = folder.normalize('NFC').toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined && previous !== folder) {
      throw new Error(`Folder paths must not differ only by case or Unicode normalization: ${previous}, ${folder}`);
    }
    if (previous === undefined) {
      result.push(folder);
      seen.set(key, folder);
    }
  }
  return result;
}

export function validateTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string' || validateTitle(tag) !== undefined)) {
    throw new Error('Tags must be an array of nonempty, single-line text labels without control characters.');
  }
  return normalizeTags(value);
}
