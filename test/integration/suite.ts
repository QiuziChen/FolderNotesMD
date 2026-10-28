import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WorkspaceFiles } from '../../src/workspaceFiles';
import { NoteRepository } from '../../src/noteRepository';
import { NoteIndex } from '../../src/noteIndex';
import { NoteExplorer } from '../../src/noteExplorer';
import { DEFAULT_FOLDERS } from '../../src/model';
import { parseNote, serializeNote } from '../../src/frontmatter';
import { validateSelectedFolders } from '../../src/addFolder';

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri;
  const oldIdea = await fs.readFile(path.join(root.fsPath, 'notes/idea.md'), 'utf8');
  const oldReference = await fs.readFile(path.join(root.fsPath, 'reading/old.md'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { publisher: string; name: string };
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'Extension registered');
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.deepEqual((await fs.readdir(root.fsPath)).sort(), ['notes', 'reading'], 'Activation must not create managed folders');
  assert.equal(await fs.readFile(path.join(root.fsPath, 'notes/idea.md'), 'utf8'), oldIdea);
  assert.equal(await fs.readFile(path.join(root.fsPath, 'reading/old.md'), 'utf8'), oldReference);
  console.log('PASS activation preserves existing files and directories');

  assert.equal(vscode.workspace.getConfiguration('folderNotesMD', root).inspect('folders')?.workspaceFolderValue, undefined);
  const defaultFolderFiles = new Map(DEFAULT_FOLDERS.map(folder => [`${folder}/preserved.md`, `# Existing ${folder} note\n`]));
  for (const [relativePath, text] of defaultFolderFiles) {
    await fs.mkdir(path.dirname(path.join(root.fsPath, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root.fsPath, relativePath), text);
  }
  await vscode.commands.executeCommand('folderNotesMD.removeFolder', 'idea');
  assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).inspect('folders')?.workspaceFolderValue, ['note'], 'Removing an inherited default writes a folder-level override');
  await vscode.commands.executeCommand('folderNotesMD.removeFolder', 'note');
  await vscode.commands.executeCommand('folderNotesMD.refresh');
  assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), [], 'Removing the final default persists an empty list across refresh');
  assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).inspect('folders')?.workspaceFolderValue, []);
  for (const [relativePath, text] of defaultFolderFiles) {
    assert.equal(await fs.readFile(path.join(root.fsPath, relativePath), 'utf8'), text, 'Removing a default folder preserves its files');
    assert.ok((await fs.stat(path.dirname(path.join(root.fsPath, relativePath)))).isDirectory());
    await fs.unlink(path.join(root.fsPath, relativePath));
  }
  for (const folder of DEFAULT_FOLDERS) await fs.rmdir(path.join(root.fsPath, folder));
  await vscode.workspace.getConfiguration('folderNotesMD', root).update('folders', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.commands.executeCommand('folderNotesMD.refresh');
  assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), [...DEFAULT_FOLDERS]);
  console.log('PASS Remove Folder handles inherited defaults, persists the final empty list, and preserves directories and files');

  const files = new WorkspaceFiles(root);
  assert.equal((await new NoteRepository(files).scan()).notes.length, 0, 'Defaults do not index personal legacy paths');
  const virtualRepository = new NoteRepository(new WorkspaceFiles(vscode.Uri.parse('fn-virtual:/notes')));
  await assert.rejects(virtualRepository.create({ title: 'No virtual writes', folder: 'note', tags: [] }), /filesystem-backed workspace/);
  const legacySources = [{ path: 'notes/idea.md', folder: 'idea' }, { path: 'reading', folder: 'note' }];
  const repository = new NoteRepository(files, DEFAULT_FOLDERS, legacySources);
  const initial = await repository.scan();
  assert.equal(initial.notes.length, 2);
  assert.ok(initial.notes.every(note => note.legacy && note.tags.length === 0));
  const index = new NoteIndex(repository, root, () => undefined);
  const explorer = new NoteExplorer(() => index.notes, relativePath => files.uri(relativePath), () => repository.folders, () => ['unused']);
  try {
    await index.refresh();
    const notePath = await repository.create({ title: '测试: shopping / learning', folder: 'note', tags: ['Plans', 'learning'] });
    const duplicatePath = await repository.create({ title: '测试: shopping / learning', folder: 'note', tags: [] });
    assert.notEqual(notePath, duplicatePath);
    assert.ok(duplicatePath.endsWith('-2.md'));
    const content = await files.readText(notePath);
    assert.equal(parseNote(content, 'note').metadata?.title, '测试: shopping / learning');
    assert.deepEqual(parseNote(content, 'note').metadata?.tags, ['Plans', 'learning'], 'A duplicate must not overwrite the original metadata');
    await eventually(() => index.notes.length === 4, 'watcher detects new notes');
    const parallel = await Promise.all([
      repository.create({ title: 'Concurrent note', folder: 'idea', tags: ['first'] }),
      new NoteRepository(new WorkspaceFiles(root)).create({ title: 'Concurrent note', folder: 'idea', tags: ['second'] }),
    ]);
    assert.notEqual(parallel[0], parallel[1], 'Concurrent creations must retain both notes');
    assert.deepEqual(parseNote(await files.readText(parallel[0]), 'idea').metadata?.tags, ['first']);
    assert.deepEqual(parseNote(await files.readText(parallel[1]), 'idea').metadata?.tags, ['second']);
    await eventually(() => index.notes.length === 6, 'watcher detects concurrent creation');
    console.log('PASS safe creation, duplicate titles, concurrent creation, and create watcher');

    const roots = explorer.getChildren();
    assert.deepEqual(roots.map(node => node.label), ['New Note', 'Add Folder', 'Browse by Folder', 'Browse by Tag', 'Recent Notes']);
    const addFolderNode = roots.find(node => node.kind === 'addFolder')!;
    assert.equal(explorer.getTreeItem(addFolderNode).command?.command, 'folderNotesMD.addFolder');
    assert.equal(explorer.getTreeItem(addFolderNode).collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.deepEqual(explorer.getChildren(addFolderNode), []);
    const foldersRoot = roots.find(node => node.kind === 'folders')!;
    const tagsRoot = roots.find(node => node.kind === 'tags')!;
    assert.deepEqual(explorer.getChildren(foldersRoot).map(node => node.label), ['idea', 'note']);
    for (const folderNode of explorer.getChildren(foldersRoot)) {
      assert.equal(explorer.getTreeItem(folderNode).contextValue, 'folderNotesMD.folder', 'Folder groups expose the removal context menu');
    }
    const unusedTag = explorer.getChildren(tagsRoot).find(node => node.label === 'unused');
    assert.ok(unusedTag, 'Configured unused tags are visible');
    assert.deepEqual(explorer.getChildren(unusedTag), []);
    const tags = explorer.getChildren(tagsRoot);
    assert.ok(tags.some(topic => topic.label === 'Plans'));
    assert.ok(tags.some(topic => topic.label === 'learning'));
    for (const topic of tags.filter(topic => ['Plans', 'learning'].includes(topic.label))) {
      assert.ok(explorer.getChildren(topic).some(note => note.relativePath === notePath));
    }
    await vscode.commands.executeCommand('folderNotesMD.openNote', notePath);
    assert.equal(vscode.window.activeTextEditor?.document.languageId, 'markdown');
    await vscode.commands.executeCommand('folderNotesMD.preview', files.uri(notePath));
    console.log('PASS sidebar folder/tag groups, native editor, and Markdown preview command');

    const badPath = 'note/broken.md';
    await fs.writeFile(path.join(root.fsPath, badPath), '---\ntitle: [unterminated\n---\n\n# Still accessible\n');
    await eventually(() => index.notes.some(note => note.relativePath === badPath && note.issues.length > 0), 'malformed YAML remains visible');
    await eventually(() => vscode.languages.getDiagnostics(files.uri(badPath)).length > 0, 'invalid YAML diagnostics');
    console.log('PASS malformed YAML remains browsable with diagnostics');

    const metadata = parseNote(content, 'note').metadata!;
    await fs.writeFile(path.join(root.fsPath, notePath), serializeNote({ ...metadata, tags: ['changed'] }));
    await eventually(() => index.tags().includes('changed') && !index.tags().includes('Plans'), 'external edit updates tags');
    const renamed = 'note/renamed.md';
    await fs.rename(path.join(root.fsPath, notePath), path.join(root.fsPath, renamed));
    await eventually(() => index.notes.some(note => note.relativePath === renamed) && !index.notes.some(note => note.relativePath === notePath), 'external rename updates index');
    await fs.unlink(path.join(root.fsPath, renamed));
    await eventually(() => !index.notes.some(note => note.relativePath === renamed), 'external deletion updates index');
    console.log('PASS external edit, rename, and deletion watchers');

    const uppercasePath = 'idea/UPPER.MD';
    const uppercaseMetadata = { ...metadata, folder: 'idea' as const, title: 'Uppercase extension', tags: ['uppercase-initial'] };
    await fs.writeFile(path.join(root.fsPath, uppercasePath), serializeNote(uppercaseMetadata));
    await eventually(() => index.notes.some(note => note.relativePath === uppercasePath && note.tags.includes('uppercase-initial')), 'external uppercase .MD creation');
    await fs.writeFile(path.join(root.fsPath, uppercasePath), serializeNote({ ...uppercaseMetadata, tags: ['uppercase-updated'] }));
    await eventually(() => index.notes.some(note => note.relativePath === uppercasePath && note.tags.includes('uppercase-updated')), 'external uppercase .MD edit');
    await fs.unlink(path.join(root.fsPath, uppercasePath));
    await eventually(() => !index.notes.some(note => note.relativePath === uppercasePath), 'external uppercase .MD deletion');
    console.log('PASS external uppercase Markdown create, edit, and delete watchers');

    const nestedFolder = 'note/nested/inner';
    const movedFolder = 'note/renamed-nested';
    const nestedPath = `${nestedFolder}/note.md`;
    const movedPath = `${movedFolder}/inner/note.md`;
    await fs.mkdir(path.join(root.fsPath, nestedFolder), { recursive: true });
    await fs.writeFile(path.join(root.fsPath, nestedPath), serializeNote({ ...metadata, title: 'Nested note' }));
    await eventually(() => index.notes.some(note => note.relativePath === nestedPath), 'nested note discovery');
    await fs.rename(path.join(root.fsPath, 'note/nested'), path.join(root.fsPath, movedFolder));
    await eventually(() => index.notes.some(note => note.relativePath === movedPath) && !index.notes.some(note => note.relativePath === nestedPath), 'nested directory rename updates all descendant paths');
    await fs.rm(path.join(root.fsPath, movedFolder), { recursive: true });
    await eventually(() => !index.notes.some(note => note.relativePath.startsWith(`${movedFolder}/`)), 'nested directory deletion removes all descendants');
    console.log('PASS external nested directory rename and deletion watchers');

    const bracketFolder = 'reading[old]';
    const bracketPath = `${bracketFolder}/old.md`;
    await fs.mkdir(path.join(root.fsPath, bracketFolder));
    await fs.writeFile(path.join(root.fsPath, bracketPath), '# Bracket legacy note\n');
    const bracketSources = [{ path: bracketFolder, folder: 'note' as const }];
    const bracketIndex = new NoteIndex(new NoteRepository(files, DEFAULT_FOLDERS, bracketSources), root, () => undefined);
    try {
      await bracketIndex.refresh();
      assert.ok(bracketIndex.notes.some(note => note.relativePath === bracketPath && note.legacy), 'Literal bracket folder is indexed');
      await fs.writeFile(path.join(root.fsPath, bracketPath), '# Updated bracket legacy note\n');
      await eventually(() => bracketIndex.notes.some(note => note.relativePath === bracketPath && note.title === 'Updated bracket legacy note'), 'literal bracket path external edit');
      const addedBracketPath = `${bracketFolder}/new.md`;
      await fs.writeFile(path.join(root.fsPath, addedBracketPath), '# New bracket legacy note\n');
      await eventually(() => bracketIndex.notes.some(note => note.relativePath === addedBracketPath), 'literal bracket path external creation');
      await fs.rm(path.join(root.fsPath, bracketFolder), { recursive: true });
      await eventually(() => !bracketIndex.notes.some(note => note.relativePath.startsWith(`${bracketFolder}/`)), 'literal bracket folder deletion');
      console.log('PASS literal bracket legacy folder discovery and external update watchers');
    } finally {
      bracketIndex.dispose();
    }

    const customFolders = ['idea', 'note', 'projects', 'archive', 'work[plans]/notes', 'idea/nested'];
    const customRepository = new NoteRepository(files, customFolders);
    const customIndex = new NoteIndex(customRepository, root, () => undefined);
    const customExplorer = new NoteExplorer(() => customIndex.notes, relativePath => files.uri(relativePath), () => customFolders);
    try {
      await customIndex.refresh();
      assert.equal(customExplorer.getChildren(customExplorer.getChildren().find(node => node.kind === 'folders')).length, 6, 'No three-folder limit');
      const customPath = await customRepository.create({ title: 'Custom folder', folder: 'work[plans]/notes', tags: ['personal'] });
      await eventually(() => customIndex.notes.some(note => note.relativePath === customPath && note.folder === 'work[plans]/notes'), 'watch custom nested folder with literal brackets');
      const nestedPath = await customRepository.create({ title: 'Nested root', folder: 'idea/nested', tags: ['nested'] });
      await eventually(() => customIndex.notes.some(note => note.relativePath === nestedPath && note.folder === 'idea/nested'), 'most specific configured folder');
      assert.equal(customIndex.notes.filter(note => note.relativePath === nestedPath).length, 1);
      const nestedMetadata = parseNote(await files.readText(nestedPath), 'idea/nested').metadata!;
      await fs.writeFile(path.join(root.fsPath, nestedPath), serializeNote({ ...nestedMetadata, tags: ['edited'] }));
      await eventually(() => customIndex.tags().includes('edited'), 'custom nested folder edit updates tags');
      await fs.rm(path.join(root.fsPath, 'work[plans]'), { recursive: true });
      await eventually(() => !customIndex.notes.some(note => note.relativePath === customPath), 'custom folder parent deletion');
      console.log('PASS more than three folders, nested roots, literal paths, and custom folder watchers');
    } finally {
      customExplorer.dispose(); customIndex.dispose();
    }

    await vscode.workspace.getConfiguration('folderNotesMD', root).update('folders', ['projects', 'archive'], vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.mkdir(path.join(root.fsPath, 'projects'), { recursive: true });
    const configuredBadPath = 'projects/broken.md';
    await fs.writeFile(path.join(root.fsPath, configuredBadPath), '---\ntitle: [unterminated\n---\n');
    await eventually(() => vscode.languages.getDiagnostics(files.uri(configuredBadPath)).length > 0, 'configuration change reconnects extension watchers');
    await eventually(() => vscode.languages.getDiagnostics(files.uri(badPath)).length === 0, 'removed folder diagnostics are cleared');
    await fs.writeFile(path.join(root.fsPath, configuredBadPath), '# Valid plain Markdown\n');
    await eventually(() => vscode.languages.getDiagnostics(files.uri(configuredBadPath)).length === 0, 'custom configured folder watcher clears resolved warning');
    console.log('PASS live folder configuration changes update extension indexing and diagnostics');

    const importedFolder = 'existing papers';
    const secondFolder = '资料';
    const importedText = new Map([
      [`${importedFolder}/nested/paper.md`, '---\ntitle: Existing research\ntags: [Optimization, optimization, ML]\nauthor: Someone\n---\n\n# Different body title\n'],
      [`${importedFolder}/plain.MD`, '# Existing plain note\n'],
      [`${importedFolder}/broken.md`, '---\ntags: [unterminated\n---\n# Broken imported note\n'],
      [`${secondFolder}/old.md`, '---\ntitle: Old topic note\ntopics: Research\ncustom: true\n---\n# Body\n'],
    ]);
    await fs.mkdir(path.join(root.fsPath, importedFolder, 'nested'), { recursive: true });
    await fs.mkdir(path.join(root.fsPath, secondFolder), { recursive: true });
    for (const [relativePath, text] of importedText) await fs.writeFile(path.join(root.fsPath, relativePath), text);
    await fs.writeFile(path.join(root.fsPath, importedFolder, 'ignore.txt'), 'Not Markdown');
    await vscode.commands.executeCommand('folderNotesMD.addFolder', [files.uri(importedFolder), files.uri(secondFolder)]);
    const expectedFolders = ['projects', 'archive', importedFolder, secondFolder];
    const folderSettings = vscode.workspace.getConfiguration('folderNotesMD', root);
    assert.deepEqual(folderSettings.get('folders'), expectedFolders, 'Add Folder preserves existing destinations');
    assert.deepEqual(folderSettings.inspect('folders')?.workspaceFolderValue, expectedFolders, 'Added folders persist in this workspace folder');
    const importedBadPath = `${importedFolder}/broken.md`;
    await eventually(() => vscode.languages.getDiagnostics(files.uri(importedBadPath)).length > 0, 'Add Folder reconnects extension and reports imported malformed YAML');
    assert.deepEqual(vscode.languages.getDiagnostics(files.uri(`${importedFolder}/nested/paper.md`)), [], 'Partial and custom YAML fields are accepted');
    await vscode.commands.executeCommand('folderNotesMD.addFolder', files.uri(importedFolder));
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), expectedFolders, 'Adding the same folder twice is idempotent');

    const importedIndex = new NoteIndex(new NoteRepository(files, expectedFolders), root, () => undefined);
    const importedExplorer = new NoteExplorer(() => importedIndex.notes, relativePath => files.uri(relativePath), () => expectedFolders);
    try {
      await importedIndex.refresh();
      const importedNotes = importedIndex.notes.filter(note => note.folder === importedFolder || note.folder === secondFolder);
      assert.equal(importedNotes.length, 4, 'Only Markdown files are imported recursively');
      const paper = importedNotes.find(note => note.relativePath === `${importedFolder}/nested/paper.md`)!;
      assert.equal(paper.title, 'Existing research');
      assert.equal(paper.folder, importedFolder);
      assert.deepEqual(paper.tags, ['Optimization', 'ML']);
      assert.deepEqual(paper.issues, []);
      assert.equal(importedNotes.find(note => note.relativePath.endsWith('/plain.MD'))?.title, 'Existing plain note');
      assert.deepEqual(importedNotes.find(note => note.folder === secondFolder)?.tags, ['Research']);
      const importedGroups = importedExplorer.getChildren(importedExplorer.getChildren().find(node => node.kind === 'folders'));
      const importedGroup = importedGroups.find(node => node.folder === importedFolder)!;
      assert.equal(importedExplorer.getChildren(importedGroup).length, 3, 'Added folder appears as a browsable group');
      const tagGroups = importedExplorer.getChildren(importedExplorer.getChildren().find(node => node.kind === 'tags'));
      const optimizationTag = tagGroups.find(node => node.label === 'Optimization')!;
      assert.ok(importedExplorer.getChildren(optimizationTag).some(note => note.relativePath === paper.relativePath));
      for (const [relativePath, text] of importedText) {
        assert.equal(await fs.readFile(path.join(root.fsPath, relativePath), 'utf8'), text, 'Import must preserve existing files byte-for-byte');
      }
      const repairedText = '---\ntitle: Repaired imported note\ntags: Imported\n---\n';
      await fs.writeFile(path.join(root.fsPath, importedBadPath), repairedText);
      await eventually(() => importedIndex.notes.some(note => note.relativePath === importedBadPath && note.tags.includes('Imported')), 'Imported folder watcher reads subsequent metadata edits');
      await eventually(() => vscode.languages.getDiagnostics(files.uri(importedBadPath)).length === 0, 'Actual extension watcher clears repaired imported YAML warning');
      console.log('PASS Add Folder command, persistent configuration, recursive YAML import, grouping, deduplication, unchanged files, and watchers');
    } finally {
      importedExplorer.dispose(); importedIndex.dispose();
    }

    const linkedFolder = path.join(root.fsPath, 'linked-import');
    await fs.symlink(path.join(root.fsPath, importedFolder), linkedFolder, 'dir');
    try {
      await assert.rejects(validateSelectedFolders(root, [vscode.Uri.file(linkedFolder)], files), /[Ss]ymbolic links/);
      await assert.rejects(validateSelectedFolders(root, [vscode.Uri.file(path.join(linkedFolder, 'nested'))], files), /[Ss]ymbolic links/);
    } finally {
      await fs.unlink(linkedFolder);
    }
    console.log('PASS Add Folder rejects real symbolic-link selections and ancestors');

    await fs.writeFile(path.join(root.fsPath, importedBadPath), importedText.get(importedBadPath)!);
    await eventually(() => vscode.languages.getDiagnostics(files.uri(importedBadPath)).length > 0, 'Imported folder is indexed before removal');
    const beforeRemoval = new Map<string, Buffer>();
    for (const relativePath of [...importedText.keys(), `${importedFolder}/ignore.txt`]) {
      beforeRemoval.set(relativePath, await fs.readFile(path.join(root.fsPath, relativePath)));
    }
    await vscode.commands.executeCommand('folderNotesMD.removeFolder', { kind: 'folder', folder: importedFolder });
    const afterRemovalFolders = ['projects', 'archive', secondFolder];
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), afterRemovalFolders, 'Removing a sidebar group preserves the other configured groups');
    await eventually(() => vscode.languages.getDiagnostics(files.uri(importedBadPath)).length === 0, 'Removing a folder clears its metadata diagnostics');
    const afterRemoval = await new NoteRepository(files, afterRemovalFolders).scan();
    assert.ok(!afterRemoval.notes.some(note => note.relativePath.startsWith(`${importedFolder}/`)));
    assert.ok(afterRemoval.notes.some(note => note.folder === secondFolder), 'Unrelated folders remain indexed');
    assert.ok((await fs.stat(path.join(root.fsPath, importedFolder))).isDirectory(), 'Removed folder stays on disk');
    assert.ok((await fs.stat(path.join(root.fsPath, importedFolder, 'nested'))).isDirectory(), 'Nested directory stays on disk');
    for (const [relativePath, bytes] of beforeRemoval) {
      assert.deepEqual(await fs.readFile(path.join(root.fsPath, relativePath)), bytes, 'Removal preserves Markdown and other file bytes');
    }
    await vscode.commands.executeCommand('folderNotesMD.addFolder', files.uri(importedFolder));
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), [...afterRemovalFolders, importedFolder], 'A removed folder can be added again');
    await eventually(() => vscode.languages.getDiagnostics(files.uri(importedBadPath)).length > 0, 'Re-adding restores metadata diagnostics');
    console.log('PASS Remove Folder sidebar argument, index removal, diagnostic cleanup, file preservation, and re-add');

    const nestedImport = `${importedFolder}/nested`;
    await vscode.commands.executeCommand('folderNotesMD.addFolder', files.uri(nestedImport));
    await vscode.commands.executeCommand('folderNotesMD.removeFolder', nestedImport);
    const coveredByParent = await new NoteRepository(files, vscode.workspace.getConfiguration('folderNotesMD', root).get<string[]>('folders')!).scan();
    assert.equal(coveredByParent.notes.find(note => note.relativePath === `${nestedImport}/paper.md`)?.folder, importedFolder, 'Removing a nested group keeps notes covered by its parent');
    await vscode.commands.executeCommand('folderNotesMD.addFolder', files.uri(nestedImport));
    await vscode.commands.executeCommand('folderNotesMD.removeFolder', importedFolder);
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), [...afterRemovalFolders, nestedImport], 'Removing a parent group preserves an explicitly configured nested group');
    const retainedNested = await new NoteRepository(files, [...afterRemovalFolders, nestedImport]).scan();
    assert.equal(retainedNested.notes.find(note => note.relativePath === `${nestedImport}/paper.md`)?.folder, nestedImport);
    assert.ok(!retainedNested.notes.some(note => note.relativePath === importedBadPath));
    await vscode.commands.executeCommand('folderNotesMD.addFolder', files.uri(importedFolder));
    await vscode.commands.executeCommand('folderNotesMD.removeFolder', nestedImport);
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), [...afterRemovalFolders, importedFolder]);
    console.log('PASS Remove Folder preserves nested configured groups and reassigns notes still covered by a parent');

    const legacyGroups = [
      { path: 'notes/idea.md', folder: 'legacy-only' },
      { path: 'reading', folder: secondFolder },
    ];
    await vscode.workspace.getConfiguration('folderNotesMD', root).update('legacySources', legacyGroups, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.commands.executeCommand('folderNotesMD.removeFolder', { kind: 'folder', folder: 'legacy-only' });
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('legacySources'), [legacyGroups[1]], 'Legacy-only folder removal removes its source mappings');
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), [...afterRemovalFolders, importedFolder], 'Legacy-only removal preserves managed folders');
    await vscode.commands.executeCommand('folderNotesMD.removeFolder', secondFolder);
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('folders'), ['projects', 'archive', importedFolder]);
    assert.deepEqual(vscode.workspace.getConfiguration('folderNotesMD', root).get('legacySources'), [], 'Removing a shared group clears both managed and legacy membership');
    assert.equal(await fs.readFile(path.join(root.fsPath, `${secondFolder}/old.md`), 'utf8'), importedText.get(`${secondFolder}/old.md`));
    assert.ok((await fs.stat(path.join(root.fsPath, secondFolder))).isDirectory());
    assert.equal(await fs.readFile(path.join(root.fsPath, 'notes/idea.md'), 'utf8'), oldIdea);
    assert.equal(await fs.readFile(path.join(root.fsPath, 'reading/old.md'), 'utf8'), oldReference);
    console.log('PASS Remove Folder clears legacy-only and shared group membership without changing source files');

    assert.equal(await fs.readFile(path.join(root.fsPath, 'notes/idea.md'), 'utf8'), oldIdea);
    assert.equal(await fs.readFile(path.join(root.fsPath, 'reading/old.md'), 'utf8'), oldReference);
    console.log('PASS legacy files remain byte-for-byte unchanged');
  } finally {
    explorer.dispose(); index.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
