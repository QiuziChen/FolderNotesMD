import type { QuickPickItem } from 'vscode';
import { normalizeTags, validateTitle } from './frontmatter';
import type { NewNoteInput } from './model';

type WizardUI = Pick<typeof import('vscode').window, 'showQuickPick' | 'showInputBox'>;

interface FolderItem extends QuickPickItem {
  folder: string;
}

interface TagItem extends QuickPickItem {
  tag?: string;
  addNew?: boolean;
}

function validateTag(value: string): string | undefined {
  if (!value.trim()) return 'Enter a tag.';
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value)) {
    return 'A tag must be one line without control characters.';
  }
  return undefined;
}

/** Gather input only; cancelling any step leaves notes and settings unchanged. */
export async function promptNewNote(
  folders: readonly string[],
  tags: readonly string[],
  ui: WizardUI,
): Promise<NewNoteInput | undefined> {
  if (!folders.length) throw new Error('Use Add Folder in the sidebar, or configure folderNotesMD.folders before creating a note.');
  const folder = await ui.showQuickPick<FolderItem>(
    folders.map((folder) => ({ label: folder, folder })),
    { title: 'FolderNotesMD: New Note', placeHolder: 'Select a note folder', ignoreFocusOut: true },
  );
  if (!folder) return undefined;

  const title = await ui.showInputBox({
    title: 'FolderNotesMD: New Note',
    prompt: 'Enter note title',
    ignoreFocusOut: true,
    validateInput: validateTitle,
  });
  if (title === undefined) return undefined;

  const available = normalizeTags(tags);
  let selected: string[] = [];
  while (true) {
    const items: TagItem[] = available.map((tag) => ({
      label: tag,
      tag,
      picked: selected.includes(tag),
    }));
    items.push({
      label: '$(add) Add new tag…',
      description: 'Enter a new tag, then continue selecting',
      addNew: true,
    });
    const choices = await ui.showQuickPick<TagItem>(items, {
      title: 'FolderNotesMD: New Note',
      placeHolder: 'Select tags, or add a tag. Submit without Add to finish.',
      canPickMany: true,
      ignoreFocusOut: true,
    });
    if (choices === undefined) return undefined;
    selected = normalizeTags(choices.flatMap((item) => item.tag === undefined ? [] : [item.tag]));
    if (!choices.some((item) => item.addNew)) {
      return { folder: folder.folder, title: title.trim(), tags: selected };
    }

    const input = await ui.showInputBox({
      title: 'New Tag',
      prompt: 'Enter one tag',
      ignoreFocusOut: true,
      validateInput: validateTag,
    });
    if (input === undefined) return undefined;
    const trimmed = input.trim().normalize('NFC');
    const existing = available.find((tag) => tag.toLowerCase().normalize('NFC') === trimmed.toLowerCase().normalize('NFC'));
    const tag = existing ?? trimmed;
    if (existing === undefined) available.push(tag);
    selected = normalizeTags([...selected, tag]);
  }
}
