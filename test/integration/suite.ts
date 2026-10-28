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
    assert.deepEqual(roots.map(node => node.label), ['New Note', 'Browse by Folder', 'Browse by Tag', 'Recent Notes']);
    assert.deepEqual(explorer.getChildren(roots[1]).map(node => node.label), ['idea', 'note']);
    const unusedTag = explorer.getChildren(roots[2]).find(node => node.label === 'unused');
    assert.ok(unusedTag, 'Configured unused tags are visible');
    assert.deepEqual(explorer.getChildren(unusedTag), []);
    const tags = explorer.getChildren(roots[2]);
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
      assert.equal(customExplorer.getChildren(customExplorer.getChildren()[1]).length, 6, 'No three-folder limit');
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

    assert.equal(await fs.readFile(path.join(root.fsPath, 'notes/idea.md'), 'utf8'), oldIdea);
    assert.equal(await fs.readFile(path.join(root.fsPath, 'reading/old.md'), 'utf8'), oldReference);
    console.log('PASS legacy files remain byte-for-byte unchanged');
  } finally {
    explorer.dispose(); index.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
