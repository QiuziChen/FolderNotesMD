import * as vscode from 'vscode';
import { NoteRepository } from './noteRepository';
import { WorkspaceFiles } from './workspaceFiles';
import { NoteIndex } from './noteIndex';
import { NoteExplorer } from './noteExplorer';
import { promptNewNote } from './newNote';
import { DEFAULT_LEGACY_SOURCES, validateLegacySources } from './legacy';
import { DEFAULT_FOLDERS } from './model';
import { validateFolders, validateTags } from './configuration';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('FolderNotesMD');
  const diagnostics = vscode.languages.createDiagnosticCollection('folderNotesMD');
  let selected: vscode.WorkspaceFolder | undefined;
  let files: WorkspaceFiles | undefined;
  let repository: NoteRepository | undefined;
  let index: NoteIndex | undefined;
  let tags: string[] = [];
  let generation = 0;
  let disposed = false;
  const explorer = new NoteExplorer(() => index?.notes ?? [], path => files?.uri(path),
    () => repository?.folders ?? DEFAULT_FOLDERS, () => tags);
  const view = vscode.window.createTreeView('folderNotesMD.notes', { treeDataProvider: explorer });
  context.subscriptions.push(output, diagnostics, explorer, view, { dispose: () => { disposed = true; generation++; index?.dispose(); } });

  const reportError = async (error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    const action = await vscode.window.showErrorMessage(`FolderNotesMD: ${message}`, 'Show Details');
    if (action) output.show(true);
  };

  async function connect(folder?: vscode.WorkspaceFolder): Promise<void> {
    const run = ++generation;
    index?.dispose(); index = undefined; repository = undefined; files = undefined; tags = []; selected = folder;
    diagnostics.clear(); explorer.refresh();
    view.description = folder?.name;
    view.message = folder ? undefined : 'Open a workspace folder, or select a notes workspace to begin.';
    if (!folder) return;
    const adapter = new WorkspaceFiles(folder.uri);
    const settings = vscode.workspace.getConfiguration('folderNotesMD', folder.uri);
    let store: NoteRepository;
    try {
      const folders = validateFolders(settings.get<unknown>('folders', DEFAULT_FOLDERS));
      tags = validateTags(settings.get<unknown>('tags', []));
      const legacy = validateLegacySources(settings.get<unknown>('legacySources', DEFAULT_LEGACY_SOURCES), folders);
      store = new NoteRepository(adapter, folders, legacy);
    } catch (error) {
      view.message = 'Invalid FolderNotesMD settings. Correct the configuration, then refresh.';
      throw error;
    }
    const newIndex = new NoteIndex(store, folder.uri, errors => {
      if (disposed || run !== generation) return;
      output.clear();
      for (const message of errors) output.appendLine(message);
      view.message = errors.length ? `${errors.length} file or configuration issue(s). See FolderNotesMD output and note tooltips.` : undefined;
    });
    files = adapter; repository = store; index = newIndex;
    context.subscriptions.push(newIndex.onDidChange(() => {
      if (disposed || run !== generation) return;
      diagnostics.clear();
      for (const note of newIndex.notes) {
        if (note.issues.length) diagnostics.set(adapter.uri(note.relativePath), note.issues.map(issue => new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), issue, vscode.DiagnosticSeverity.Warning)));
      }
      explorer.refresh();
    }));
    await newIndex.refresh();
  }

  async function chooseRoot(force = false): Promise<boolean> {
    if (!force && selected && repository && files && index) return true;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error('Open your notes workspace in VS Code before creating or browsing notes.');
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the workspace folder containing your notes' });
    if (!folder) return false;
    await context.workspaceState.update('notesRoot', folder.uri.toString());
    await connect(folder);
    return true;
  }

  function register(name: string, action: (...args: any[]) => Promise<unknown> | unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: any[]) => {
      try { return await action(...args); } catch (error) { await reportError(error); }
    }));
  }

  function resolveNote(argument: unknown): vscode.Uri {
    if (argument instanceof vscode.Uri) return argument;
    const path = typeof argument === 'string' ? argument : argument && typeof argument === 'object' && 'relativePath' in argument ? argument.relativePath : undefined;
    if (typeof path === 'string' && files) return files.uri(path);
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'markdown') return active.uri;
    throw new Error('Select a note or open a Markdown document first.');
  }

  register('folderNotesMD.newNote', async () => {
    if (!await chooseRoot()) return;
    // A workspace or configuration change while the wizard is open must not redirect a write.
    const currentStore = repository!; const currentFiles = files!; const currentIndex = index!;
    const input = await promptNewNote(currentStore.folders, [...tags, ...currentIndex.tags()], vscode.window);
    if (!input) return;
    if (currentStore !== repository) throw new Error('The notes workspace or configuration changed. Start New Note again.');
    const path = await currentStore.create(input);
    await currentIndex.refresh();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(currentFiles.uri(path)));
  });
  register('folderNotesMD.refresh', async () => { if (await chooseRoot()) await index!.refresh(); });
  register('folderNotesMD.selectRoot', async () => { await chooseRoot(true); });
  register('folderNotesMD.configureFolders', async () => {
    await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', 'folderNotesMD.folders');
  });
  register('folderNotesMD.openNote', async argument => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(resolveNote(argument)));
  });
  register('folderNotesMD.preview', async argument => {
    const uri = resolveNote(argument);
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (selected && event.affectsConfiguration('folderNotesMD', selected.uri)) void connect(selected).catch(reportError);
  }), vscode.workspace.onDidChangeWorkspaceFolders(() => { void restoreRoot().catch(reportError); }));

  async function restoreRoot(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const saved = context.workspaceState.get<string>('notesRoot');
    const folder = folders.find(candidate => candidate.uri.toString() === selected?.uri.toString())
      ?? folders.find(candidate => candidate.uri.toString() === saved)
      ?? (folders.length === 1 ? folders[0] : undefined);
    await connect(folder);
  }
  try { await restoreRoot(); } catch (error) { await reportError(error); }
}
