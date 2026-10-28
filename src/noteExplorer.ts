import * as vscode from 'vscode';
import type { NoteRecord } from './model';

type NodeKind = 'new' | 'addFolder' | 'folders' | 'folder' | 'tags' | 'tag' | 'untagged' | 'recent' | 'note';

export interface ExplorerNode {
  readonly id: string;
  readonly label: string;
  readonly kind: NodeKind;
  readonly folder?: string;
  readonly tag?: string;
  readonly relativePath?: string;
  readonly note?: NoteRecord;
}

const roots: readonly ExplorerNode[] = [
  { id: 'new', label: 'New Note', kind: 'new' },
  { id: 'addFolder', label: 'Add Folder', kind: 'addFolder' },
  { id: 'folders', label: 'Browse by Folder', kind: 'folders' },
  { id: 'tags', label: 'Browse by Tag', kind: 'tags' },
  { id: 'recent', label: 'Recent Notes', kind: 'recent' },
];

function compareNotes(a: NoteRecord, b: NoteRecord): number {
  return a.title.localeCompare(b.title) || a.relativePath.localeCompare(b.relativePath);
}

function tagKey(tag: string): string {
  return tag.normalize('NFC').toLowerCase().normalize('NFC');
}

export class NoteExplorer implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly getNotes: () => readonly NoteRecord[],
    private readonly getUri: (relativePath: string) => vscode.Uri | undefined,
    private readonly getFolders: () => readonly string[],
    private readonly getTags: () => readonly string[] = () => [],
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    const isLeaf = node.kind === 'note' || node.kind === 'new' || node.kind === 'addFolder';
    const item = new vscode.TreeItem(node.label, isLeaf
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = node.id;

    if (node.kind === 'new') {
      item.iconPath = new vscode.ThemeIcon('add');
      item.command = { command: 'folderNotesMD.newNote', title: 'New Note' };
    } else if (node.kind === 'addFolder') {
      item.iconPath = new vscode.ThemeIcon('new-folder');
      item.description = 'Existing Markdown notes';
      item.tooltip = 'Add an existing folder from this workspace and discover its Markdown notes and YAML metadata.';
      item.command = { command: 'folderNotesMD.addFolder', title: 'Add Folder' };
    } else if (node.kind === 'note' && node.note) {
      const note = node.note;
      item.resourceUri = this.getUri(note.relativePath);
      item.contextValue = 'folderNotesMD.note';
      item.description = `${note.legacy ? 'Legacy · ' : ''}${note.relativePath}`;
      item.iconPath = new vscode.ThemeIcon(note.issues.length ? 'warning' : 'markdown');
      item.tooltip = [
        note.title,
        note.relativePath,
        ...(note.legacy ? ['Existing document'] : []),
        ...(note.tags.length ? [`Tags: ${note.tags.join(', ')}`] : []),
        ...note.issues.map((issue) => `Warning: ${issue}`),
      ].join('\n');
      item.command = {
        command: 'folderNotesMD.openNote',
        title: 'Open Note',
        arguments: [note.relativePath],
      };
    } else {
      if (node.kind === 'folder') {
        item.contextValue = 'folderNotesMD.folder';
        item.tooltip = `${node.folder}\nRemove Folder (Keep Files) stops managing this group without deleting its files.`;
      }
      const icon = node.kind === 'recent' ? 'history'
        : ['tags', 'tag', 'untagged'].includes(node.kind) ? 'tag' : 'folder';
      item.iconPath = new vscode.ThemeIcon(icon);
    }
    return item;
  }

  getChildren(node?: ExplorerNode): ExplorerNode[] {
    if (!node) return [...roots];
    if (node.kind === 'new' || node.kind === 'addFolder' || node.kind === 'note') return [];
    const notes = this.getNotes();
    if (node.kind === 'folders') {
      const folders = [...new Set([...this.getFolders(), ...notes.map(note => note.folder)])];
      return folders.map((folder) => ({
        id: `folders/${encodeURIComponent(folder)}`,
        label: folder,
        kind: 'folder',
        folder,
      }));
    }

    if (node.kind === 'tags') {
      const spellings = new Map<string, string>();
      for (const tag of this.getTags()) spellings.set(tagKey(tag), tag);
      for (const note of notes) {
        for (const tag of note.tags) {
          const key = tagKey(tag);
          if (!spellings.has(key)) spellings.set(key, tag);
        }
      }
      const tags = [...spellings.values()]
        .sort((a, b) => a.localeCompare(b));
      return [
        ...tags.map((tag): ExplorerNode => ({
          id: `tags/tag/${encodeURIComponent(tagKey(tag))}`,
          label: tag,
          kind: 'tag',
          tag,
        })),
        { id: 'tags/untagged', label: 'Untagged', kind: 'untagged' },
      ];
    }

    let visible: NoteRecord[];
    if (node.kind === 'recent') {
      visible = [...notes].sort((a, b) => b.mtime - a.mtime || compareNotes(a, b)).slice(0, 20);
    } else {
      visible = notes.filter((note) => node.kind === 'folder' ? note.folder === node.folder
        : node.kind === 'tag' ? note.tags.some((tag) => tagKey(tag) === tagKey(node.tag ?? ''))
        : node.kind === 'untagged' && note.tags.length === 0).sort(compareNotes);
    }
    return visible.map((note) => ({
      id: `${node.id}/note/${encodeURIComponent(note.relativePath)}`,
      label: note.title,
      kind: 'note',
      relativePath: note.relativePath,
      note,
    }));
  }
}
