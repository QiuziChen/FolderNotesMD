import type { QuickPickItem } from 'vscode';
import { validateFolders } from './configuration';
import { LegacySource, validateLegacySources, validateRelativePath } from './legacy';

type FolderRemovalUI = Pick<typeof import('vscode').window, 'showQuickPick'>;

interface FolderItem extends QuickPickItem {
  folder: string;
}

export interface RemovedNoteFolder {
  folders: string[];
  legacySources: LegacySource[];
}

/** Select a sidebar group to stop indexing; no files or directories are removed. */
export async function promptFolderRemoval(
  folders: readonly string[],
  ui: FolderRemovalUI,
): Promise<string | undefined> {
  // Legacy group labels may differ only by case; each visible group remains selectable.
  const choices = [...new Set(folders.map(folder => validateRelativePath(folder)))];
  if (!choices.length) return undefined;
  const selection = await ui.showQuickPick<FolderItem>(
    choices.map(folder => ({ label: folder, folder, description: 'Keep all files and folders' })),
    {
      title: 'FolderNotesMD: Remove Folder',
      placeHolder: 'Remove a folder from the sidebar. All files and folders will be kept.',
      canPickMany: false,
      ignoreFocusOut: true,
    },
  );
  return selection?.folder;
}

/** Only configuration changes are returned; the caller persists explicit empty arrays. */
export function removeNoteFolder(
  currentFolders: readonly string[],
  legacySources: readonly LegacySource[],
  folder: string,
): RemovedNoteFolder {
  const target = validateRelativePath(folder);
  const folders = validateFolders(currentFolders);
  const sources = validateLegacySources(legacySources, folders);
  return {
    folders: folders.filter(candidate => candidate !== target),
    legacySources: sources.filter(source => source.folder !== target),
  };
}
