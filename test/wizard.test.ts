import assert from 'node:assert/strict';
import test from 'node:test';
import type { InputBoxOptions, QuickPickItem, QuickPickOptions } from 'vscode';
import { promptNewNote } from '../src/newNote';

interface Item extends QuickPickItem {
  tag?: string;
  folder?: string;
  addNew?: boolean;
}

type Action = {
  kind: 'pick';
  select: (items: readonly Item[], options: QuickPickOptions) => Item | Item[] | undefined;
} | {
  kind: 'input';
  value?: string;
  inspect?: (options: InputBoxOptions) => void | Promise<void>;
};

function choose(label: string): Action {
  return { kind: 'pick', select: (items) => {
    const item = items.find((entry) => entry.label === label);
    assert.ok(item, `Missing choice: ${label}`);
    return item;
  } };
}

function selected(items: readonly Item[]): Item[] {
  return items.filter((item) => item.picked);
}

function add(items: readonly Item[]): Item {
  const item = items.find((entry) => entry.addNew);
  assert.ok(item, 'Missing Add new tag action');
  return item;
}

async function run(actions: Action[], tags: readonly string[] = [], folders: readonly string[] = ['idea', 'note']) {
  let cursor = 0;
  const ui = {
    showQuickPick: async (items: readonly Item[], options: QuickPickOptions) => {
      const action = actions[cursor++];
      assert.equal(action?.kind, 'pick', 'Unexpected quick pick');
      assert.ok(action?.kind === 'pick');
      return action.select(items, options);
    },
    showInputBox: async (options: InputBoxOptions) => {
      const action = actions[cursor++];
      assert.equal(action?.kind, 'input', 'Unexpected input box');
      assert.ok(action?.kind === 'input');
      await action.inspect?.(options);
      return action.value;
    },
  } as unknown as Parameters<typeof promptNewNote>[2];
  const result = await promptNewNote(folders, tags, ui);
  assert.equal(cursor, actions.length, 'The wizard did not consume all expected steps');
  return result;
}

test('cancelling folder selection cancels the wizard', async () => {
  assert.equal(await run([{ kind: 'pick', select: () => undefined }]), undefined);
});

test('cancelling the title cancels the wizard', async () => {
  assert.equal(await run([choose('idea'), { kind: 'input' }]), undefined);
});

test('cancelling tag selection cancels the wizard', async () => {
  assert.equal(await run([
    choose('note'), { kind: 'input', value: 'A paper' },
    { kind: 'pick', select: () => undefined },
  ]), undefined);
});

test('cancelling a new tag cancels the entire wizard', async () => {
  assert.equal(await run([
    choose('note'), { kind: 'input', value: 'A reflection' },
    { kind: 'pick', select: (items) => [add(items)] },
    { kind: 'input' },
  ]), undefined);
});

test('empty tags are accepted and the default folders are offered', async () => {
  const result = await run([
    { kind: 'pick', select: (items) => {
      assert.deepEqual(items.map((item) => item.label), ['idea', 'note']);
      return items[0];
    } },
    { kind: 'input', value: '  A new idea  ', inspect: async (options) => {
      assert.ok(options.validateInput);
      assert.ok(await options.validateInput(''));
      assert.ok(await options.validateInput('first\nsecond'));
    } },
    { kind: 'pick', select: (items, options) => {
      assert.equal(options.canPickMany, true);
      assert.equal(items.length, 1);
      assert.equal(items[0].addNew, true);
      return [];
    } },
  ]);
  assert.deepEqual(result, { folder: 'idea', title: 'A new idea', tags: [] });
});

test('multiple existing tags can be selected', async () => {
  const result = await run([
    choose('note'), { kind: 'input', value: 'Shopping paper' },
    { kind: 'pick', select: (items) => items.filter((item) => item.tag !== undefined) },
  ], ['shopping', 'planning']);
  assert.equal(result?.folder, 'note');
  assert.deepEqual(result?.tags.slice().sort(), ['planning', 'shopping']);
});

test('adding multiple tags preserves the previous selection', async () => {
  const result = await run([
    choose('idea'), { kind: 'input', value: 'New directions' },
    { kind: 'pick', select: (items) => [
      ...items.filter((item) => item.tag === 'planning'), add(items),
    ] },
    { kind: 'input', value: ' travel ', inspect: async (options) => {
      assert.ok(options.validateInput);
      assert.ok(await options.validateInput('  '));
      assert.ok(await options.validateInput('one\ntwo'));
      assert.ok(await options.validateInput('one\u2028two'));
      assert.ok(await options.validateInput('one\u0000two'));
      assert.equal(await options.validateInput('travel'), undefined);
    } },
    { kind: 'pick', select: (items) => {
      assert.deepEqual(selected(items).map((item) => item.tag).sort(), ['planning', 'travel']);
      return [...selected(items), add(items)];
    } },
    { kind: 'input', value: 'tasks' },
    { kind: 'pick', select: (items) => {
      assert.deepEqual(selected(items).map((item) => item.tag).sort(), ['planning', 'tasks', 'travel']);
      return selected(items);
    } },
  ], ['planning', 'shopping']);
  assert.deepEqual(result?.tags.slice().sort(), ['planning', 'tasks', 'travel']);
});

test('a new tag matching an existing tag ignores case and reuses its spelling', async () => {
  const result = await run([
    choose('idea'), { kind: 'input', value: 'Shopping idea' },
    { kind: 'pick', select: (items) => [add(items)] },
    { kind: 'input', value: ' SHOPPING ' },
    { kind: 'pick', select: (items) => {
      assert.equal(items.filter((item) => item.tag !== undefined).length, 1);
      return selected(items);
    } },
  ], ['shopping']);
  assert.deepEqual(result?.tags, ['shopping']);
});

test('cancelling after adding a tag still cancels the wizard', async () => {
  assert.equal(await run([
    choose('note'), { kind: 'input', value: 'A reflection' },
    { kind: 'pick', select: (items) => [add(items)] },
    { kind: 'input', value: 'planning' },
    { kind: 'pick', select: () => undefined },
  ]), undefined);
});

test('a new tag reuses an existing Unicode-normalized spelling', async () => {
  const result = await run([
    choose('note'), { kind: 'input', value: 'A paper' },
    { kind: 'pick', select: (items) => [add(items)] },
    { kind: 'input', value: 'CAFE\u0301' },
    { kind: 'pick', select: (items) => {
      assert.equal(items.filter((item) => item.tag !== undefined).length, 1);
      return selected(items);
    } },
  ], ['café']);
  assert.deepEqual(result?.tags, ['café']);
});


test('custom folders have no three-folder limit and preserve nested paths', async () => {
  const folders = ['idea', 'note', 'projects', 'reference', 'projects/design'];
  const result = await run([
    { kind: 'pick', select: (items) => {
      assert.deepEqual(items.map(item => item.label), folders);
      return items.find(item => item.folder === 'projects/design');
    } },
    { kind: 'input', value: 'A design decision' },
    { kind: 'pick', select: () => [] },
  ], [], folders);
  assert.deepEqual(result, { folder: 'projects/design', title: 'A design decision', tags: [] });
});

test('no configured folders gives an actionable error', async () => {
  await assert.rejects(run([], [], []), /folderNotesMD\.folders/);
});
