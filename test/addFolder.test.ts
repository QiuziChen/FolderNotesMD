import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenDialogOptions, Uri } from 'vscode';
import { mergeNoteFolders, promptExistingFolders, validateSelectedFolders } from '../src/addFolder';

function uri(path: string, scheme = 'file', authority = ''): Uri {
  return { path, scheme, authority } as Uri;
}

const root = uri('/work/project');

test('folder picker selects only directories in the notes workspace and cancellation has no effect', async () => {
  let options: OpenDialogOptions | undefined;
  const ui = { showOpenDialog: async (value?: OpenDialogOptions) => {
    options = value;
    return undefined;
  } };
  assert.equal(await promptExistingFolders(root, ui), undefined);
  assert.equal(options?.defaultUri, root);
  assert.equal(options?.canSelectFiles, false);
  assert.equal(options?.canSelectFolders, true);
  assert.equal(options?.canSelectMany, true);
  assert.equal(options?.openLabel, 'Add Folder');
  assert.equal(await promptExistingFolders(root, { showOpenDialog: async () => [] }), undefined);
  const selection = [uri('/work/project/notes')];
  assert.equal(await promptExistingFolders(root, { showOpenDialog: async () => selection }), selection);
});

test('nested, Unicode, and spaced directory selections become relative paths without duplicate reads', async () => {
  const reads: string[] = [];
  const selections = [uri('/work/project/研究/Reading notes'), uri('/work/project/archive/'), uri('/work/project/archive')];
  const folders = await validateSelectedFolders(root, selections, { readDirectory: async path => {
    reads.push(path);
    return [];
  } });
  assert.deepEqual(folders, ['研究/Reading notes', 'archive']);
  assert.deepEqual(reads, folders);
  assert.deepEqual(mergeNoteFolders(['idea', 'note'], folders, []), ['idea', 'note', ...folders]);
});

test('workspace boundary validation rejects siblings, other providers, root, hidden, and traversal paths before reading', async () => {
  let reads = 0;
  const files = { readDirectory: async () => { reads++; return []; } };
  for (const selection of [
    uri('/work/project-neighbor/notes'),
    uri('/work/elsewhere/notes'),
    uri('/work/project/notes', 'vscode-remote'),
    uri('/work/project/notes', 'file', 'another-host'),
    root,
    uri('/work/project/'),
    uri('/work/project/.private'),
    uri('/work/project/notes/../outside'),
  ]) {
    await assert.rejects(validateSelectedFolders(root, [uri('/work/project/valid'), selection], files));
  }
  assert.equal(reads, 0);
});

test('directory validation accepts remote workspace descendants on the same provider and authority', async () => {
  const remoteRoot = uri('/home/user/project', 'vscode-remote', 'ssh-remote+host');
  const remoteFolder = uri('/home/user/project/notes', 'vscode-remote', 'ssh-remote+host');
  assert.deepEqual(await validateSelectedFolders(remoteRoot, [remoteFolder], { readDirectory: async () => [] }), ['notes']);
  assert.deepEqual(await validateSelectedFolders(uri('/'), [uri('/notes')], { readDirectory: async () => [] }), ['notes']);
});

test('a missing, unreadable, non-directory, or symlink selection aborts the whole addition without mutations', async () => {
  const current = ['idea'];
  for (const reason of ['Not found', 'Permission denied', 'Not a directory', 'Symbolic links are not followed']) {
    const reads: string[] = [];
    await assert.rejects(validateSelectedFolders(root, [uri('/work/project/good'), uri('/work/project/bad')], {
      readDirectory: async path => {
        reads.push(path);
        if (path === 'bad') throw new Error(reason);
        return [];
      },
    }), new RegExp(`Cannot add folder bad: ${reason}`));
    assert.deepEqual(reads, ['good', 'bad']);
    assert.deepEqual(current, ['idea']);
  }
});

test('merging preserves current folders and additions, deduplicates existing selections, and permits nested roots', () => {
  const current = Object.freeze(['idea', 'note', 'projects']);
  const additions = Object.freeze(['projects', 'projects/research', 'reading', 'reading']);
  assert.deepEqual(mergeNoteFolders(current, additions, []), ['idea', 'note', 'projects', 'projects/research', 'reading']);
  assert.deepEqual(current, ['idea', 'note', 'projects']);
  assert.deepEqual(additions, ['projects', 'projects/research', 'reading', 'reading']);
  assert.deepEqual(mergeNoteFolders(['idea', 'added-while-picker-open'], ['reading'], []), ['idea', 'added-while-picker-open', 'reading']);
  assert.throws(() => mergeNoteFolders(['reading'], ['Reading'], []), /case/);
});

test('overlapping legacy sources produce an actionable error without removing configured sources', () => {
  const legacy = [{ path: 'archive', folder: 'reference' }];
  for (const addition of ['archive', 'archive/reading']) {
    assert.throws(() => mergeNoteFolders(['note'], [addition], legacy), /Remove the overlapping entry from folderNotesMD\.legacySources/);
  }
  assert.throws(() => mergeNoteFolders(['note'], ['archive'], [{ path: 'archive/paper.md', folder: 'reference' }]), /overlaps/);
  assert.deepEqual(mergeNoteFolders(['note'], ['reading'], legacy), ['note', 'reading']);
  assert.deepEqual(legacy, [{ path: 'archive', folder: 'reference' }]);
});
