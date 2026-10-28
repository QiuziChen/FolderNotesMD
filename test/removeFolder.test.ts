import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuickPickItem, QuickPickOptions } from 'vscode';
import { DEFAULT_FOLDERS } from '../src/model';
import { promptFolderRemoval, removeNoteFolder } from '../src/removeFolder';

test('removing either default folder retains the other and never restores removed defaults', () => {
  assert.deepEqual(removeNoteFolder(DEFAULT_FOLDERS, [], 'idea'), { folders: ['note'], legacySources: [] });
  assert.deepEqual(removeNoteFolder(DEFAULT_FOLDERS, [], 'note'), { folders: ['idea'], legacySources: [] });
  const first = removeNoteFolder(DEFAULT_FOLDERS, [], 'idea');
  assert.deepEqual(removeNoteFolder(first.folders, first.legacySources, 'note'), { folders: [], legacySources: [] });
  assert.deepEqual(DEFAULT_FOLDERS, ['idea', 'note']);
});

test('folder removal uses exact paths and preserves nested roots, parents, and similarly named folders', () => {
  const folders = Object.freeze(['projects', 'projects/research', 'projects/research/notes', 'projects/research-extra', 'other']);
  assert.deepEqual(removeNoteFolder(folders, [], 'projects/research'), {
    folders: ['projects', 'projects/research/notes', 'projects/research-extra', 'other'],
    legacySources: [],
  });
  assert.deepEqual(removeNoteFolder(folders, [], 'projects'), {
    folders: ['projects/research', 'projects/research/notes', 'projects/research-extra', 'other'],
    legacySources: [],
  });
  assert.equal(folders.length, 5);
});

test('all legacy sources with the removed group label are removed while other groups remain', () => {
  const sources = Object.freeze([
    Object.freeze({ path: 'archive/ideas.md', folder: 'idea' }),
    Object.freeze({ path: 'old-ideas', folder: 'idea' }),
    Object.freeze({ path: 'references', folder: 'reading' }),
    Object.freeze({ path: 'old-ideas-child', folder: 'idea/nested' }),
  ]);
  assert.deepEqual(removeNoteFolder(DEFAULT_FOLDERS, sources, 'idea'), {
    folders: ['note'],
    legacySources: [
      { path: 'references', folder: 'reading' },
      { path: 'old-ideas-child', folder: 'idea/nested' },
    ],
  });
  assert.equal(sources.length, 4);
});

test('legacy-only groups can be removed without changing configured folders', () => {
  const sources = [{ path: 'archive/reference.md', folder: 'reading' }, { path: 'old', folder: 'archive' }];
  assert.deepEqual(removeNoteFolder(['note'], sources, 'reading'), {
    folders: ['note'],
    legacySources: [{ path: 'old', folder: 'archive' }],
  });
  assert.deepEqual(removeNoteFolder([], [{ path: 'old', folder: 'archive' }], 'archive'), {
    folders: [], legacySources: [],
  });
});

test('unknown valid targets are a no-op and normalized path separators identify the same folder', () => {
  const sources = [{ path: 'archive', folder: 'reading' }];
  assert.deepEqual(removeNoteFolder(['note', 'projects/research'], sources, 'missing'), {
    folders: ['note', 'projects/research'], legacySources: sources,
  });
  assert.deepEqual(removeNoteFolder(['note', 'projects/research'], sources, 'projects\\research'), {
    folders: ['note'], legacySources: sources,
  });
});

test('invalid targets or invalid configuration fail without changing the inputs', () => {
  const folders = ['note'];
  const sources = [{ path: 'archive', folder: 'reading' }];
  for (const target of ['', '.', '../note', '/note', '.hidden']) {
    assert.throws(() => removeNoteFolder(folders, sources, target));
  }
  assert.throws(() => removeNoteFolder(['note', 'Note'], [], 'note'), /case/);
  assert.throws(() => removeNoteFolder(['note'], [{ path: 'note/old.md', folder: 'reading' }], 'note'), /overlaps/);
  assert.deepEqual(folders, ['note']);
  assert.deepEqual(sources, [{ path: 'archive', folder: 'reading' }]);
});

test('folder removal picker is single-selection, explains file retention, and cancellation returns undefined', async () => {
  let calls = 0;
  const ui = {
    showQuickPick: async (items: readonly QuickPickItem[], options: QuickPickOptions) => {
      calls++;
      assert.deepEqual(items.map(item => item.label), ['idea', 'note', 'reading']);
      assert.ok(items.every(item => /Keep all files and folders/.test(item.description ?? '')));
      assert.equal(options.canPickMany, false);
      assert.match(options.placeHolder ?? '', /All files and folders will be kept/);
      return undefined;
    },
  } as unknown as Parameters<typeof promptFolderRemoval>[1];
  assert.equal(await promptFolderRemoval(['idea', 'note', 'reading'], ui), undefined);
  assert.equal(calls, 1);
});

test('folder removal picker returns the selected group and does not open with no folders', async () => {
  let calls = 0;
  const ui = {
    showQuickPick: async (items: readonly QuickPickItem[]) => {
      calls++;
      return items.find(item => item.label === 'reading');
    },
  } as unknown as Parameters<typeof promptFolderRemoval>[1];
  assert.equal(await promptFolderRemoval(['note', 'reading'], ui), 'reading');
  assert.equal(await promptFolderRemoval([], ui), undefined);
  assert.equal(calls, 1);
});

test('folder removal picker retains distinct managed and legacy labels that differ only by case', async () => {
  const ui = {
    showQuickPick: async (items: readonly QuickPickItem[]) => {
      assert.deepEqual(items.map(item => item.label), ['note', 'Note']);
      return items.find(item => item.label === 'Note');
    },
  } as unknown as Parameters<typeof promptFolderRemoval>[1];
  assert.equal(await promptFolderRemoval(['note', 'Note', 'note'], ui), 'Note');
});
