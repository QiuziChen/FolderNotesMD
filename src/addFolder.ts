import type { Uri } from 'vscode';
import { validateFolders } from './configuration';
import { LegacySource, validateLegacySources, validateRelativePath } from './legacy';
import type { FileAccess } from './noteRepository';

type FolderPickerUI = Pick<typeof import('vscode').window, 'showOpenDialog'>;

/** The picker does not mutate settings, so cancelling leaves the workspace unchanged. */
export async function promptExistingFolders(root: Uri, ui: FolderPickerUI): Promise<Uri[] | undefined> {
  const selections = await ui.showOpenDialog({
    title: 'FolderNotesMD: Add Existing Note Folders',
    openLabel: 'Add Folder',
    defaultUri: root,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
  });
  return selections?.length ? selections : undefined;
}

/** Validate every selection before the caller persists any configuration. */
export async function validateSelectedFolders(
  root: Uri,
  selections: readonly Uri[],
  files: Pick<FileAccess, 'readDirectory'>,
): Promise<string[]> {
  const rootPath = root.path.replace(/\/$/u, '');
  const prefix = `${rootPath}/`;
  const folders = validateFolders(selections.map(selection => {
    if (selection.scheme !== root.scheme || selection.authority !== root.authority) {
      throw new Error('Choose a folder inside the selected notes workspace. To use another workspace, run FolderNotesMD: Select Notes Workspace.');
    }
    if (selection.path.replace(/\/$/u, '') === rootPath) {
      throw new Error('Choose a folder inside the selected notes workspace, rather than the workspace root.');
    }
    if (!selection.path.startsWith(prefix)) {
      throw new Error('Choose a folder inside the selected notes workspace. To use another workspace, run FolderNotesMD: Select Notes Workspace.');
    }
    return validateRelativePath(selection.path.slice(prefix.length).replace(/\/$/u, ''));
  }));
  for (const folder of folders) {
    try {
      // WorkspaceFiles rejects symlinks in every path component and files that are not directories.
      await files.readDirectory(folder);
    } catch (error) {
      throw new Error(`Cannot add folder ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return folders;
}

/** Call after asynchronous selection/validation, using the latest workspace settings. */
export function mergeNoteFolders(
  currentFolders: readonly string[],
  additions: readonly string[],
  legacySources: readonly LegacySource[],
): string[] {
  const folders = validateFolders([...currentFolders, ...additions]);
  try {
    validateLegacySources(legacySources, folders);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Legacy source overlaps')) {
      throw new Error(`${error.message}. Remove the overlapping entry from folderNotesMD.legacySources in workspace settings before adding this folder.`);
    }
    throw error;
  }
  return folders;
}
