import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDate, noteFilename, titleSlug } from '../src/filenames';
import { normalizeTags, parseExistingNote, parseNote, serializeNote, validateTitle } from '../src/frontmatter';
import { DEFAULT_FOLDERS, isCalendarDate, NoteMetadata } from '../src/model';
import { validateFolders, validateTags } from '../src/configuration';

const metadata: NoteMetadata = {
  title: 'Plans: 成本与收益',
  folder: 'idea',
  tags: ['Daily Plans', '优化'],
  created: '2026-10-18',
};

function frontmatter(lines: string): string {
  return `---\n${lines}\n---\n\n# Body\n`;
}

const validFields = 'title: A note\nfolder: idea\ntags: []\ncreated: 2026-10-18';

test('default folders are general and custom folders have no fixed count', () => {
  assert.deepEqual(DEFAULT_FOLDERS, ['idea', 'note']);
  assert.deepEqual(validateFolders(['idea', 'note', 'projects', 'reading', 'projects/design']), ['idea', 'note', 'projects', 'reading', 'projects/design']);
  assert.deepEqual(validateFolders(['custom\\nested', 'custom/nested']), ['custom/nested']);
  assert.deepEqual(validateFolders([]), []);
  assert.throws(() => validateFolders(['notes', 'Notes']), /case/);
  for (const value of [null, 'notes', ['notes', 42], ['../notes'], ['/notes'], ['notes/../outside']]) {
    assert.throws(() => validateFolders(value));
  }
});

test('custom tag suggestions normalize without restricting the vocabulary', () => {
  assert.deepEqual(validateTags([' Work ', 'work', 'Café', 'CAFE\u0301', '随笔']), ['Work', 'Café', '随笔']);
  assert.deepEqual(validateTags([]), []);
  for (const value of [null, 'tag', [42], [''], ['first\nsecond']]) assert.throws(() => validateTags(value));
});

test('metadata roundtrips through YAML with Unicode, colon, and Markdown body', () => {
  const text = serializeNote(metadata);
  assert.deepEqual(parseNote(text, 'idea'), { metadata, issues: [] });
  assert.ok(text.endsWith('# Plans: 成本与收益\n\n'));
  assert.deepEqual(parseNote(`${text}$$x^2$$\n---\n`, 'idea').metadata, metadata);
});

test('BOM, CRLF, and a closing delimiter at EOF are supported', () => {
  const text = `\uFEFF${frontmatter(validFields).replace(/\n/g, '\r\n')}`;
  assert.equal(parseNote(text, 'idea').issues.length, 0);
  assert.equal(parseNote(`---\n${validFields}\n---`, 'idea').issues.length, 0);
});

test('titles and tags normalize while user tag spelling and ordering remain intact', () => {
  assert.deepEqual(normalizeTags(['  Café  ', 'CAFE\u0301', '优化', '优化', 'Mixed Case', '']), ['Café', '优化', 'Mixed Case']);
  const text = serializeNote({ ...metadata, title: '  Notes  ', tags: [' Tag ', 'tag', 'Second'] });
  const parsed = parseNote(text, 'idea').metadata;
  assert.equal(parsed?.title, 'Notes');
  assert.deepEqual(parsed?.tags, ['Tag', 'Second']);
});

test('missing, misplaced, unclosed, or empty frontmatter is reported without throwing', () => {
  for (const text of ['# Legacy note', `# Heading\n${frontmatter(validFields)}`, `---\n${validFields}`, '---\n---\n']) {
    const result = parseNote(text, 'idea');
    assert.equal(result.metadata, undefined);
    assert.ok(result.issues.length > 0);
  }
});

test('invalid YAML, duplicate keys, aliases, unsupported tags, and oversized metadata are rejected', () => {
  const cases = [
    `${validFields}\ntitle: Duplicate`,
    validFields.replace('tags: []', 'tags: [unfinished'),
    validFields.replace('title: A note', 'title: &title A note').replace('tags: []', 'tags: [*title]'),
    validFields.replace('title: A note', 'title: !!js/function function() {}'),
    `${validFields}\n# ${'x'.repeat(65536)}`,
  ];
  for (const fields of cases) {
    for (const parse of [parseNote, parseExistingNote]) {
      const result = parse(frontmatter(fields), 'idea');
      assert.equal(result.metadata, undefined);
      assert.ok(result.issues.length > 0);
    }
  }
});

test('existing notes accept optional metadata and ignore unrelated YAML fields', () => {
  assert.deepEqual(parseExistingNote('# Plain Markdown', 'reading'), { issues: [] });
  assert.deepEqual(parseExistingNote('---\n---\n', 'reading'), { metadata: { folder: 'reading' }, issues: [] });
  assert.deepEqual(parseExistingNote(frontmatter('title: Existing title\nauthor: Ada\nupdated: 2026-10-19\n__proto__: {polluted: true}'), 'reading'), {
    metadata: { folder: 'reading', title: 'Existing title' },
    issues: [],
  });
  assert.deepEqual(parseExistingNote(frontmatter('tags: [" Work ", work, "Café", "CAFE\\u0301"]'), 'reading'), {
    metadata: { folder: 'reading', tags: ['Work', 'Café'] },
    issues: [],
  });
});

test('existing scalar tags and legacy topics are one tag and explicit tags take precedence', () => {
  for (const field of ['tags', 'topics']) {
    assert.deepEqual(parseExistingNote(frontmatter(`${field}: " Research, planning "`), 'reading'), {
      metadata: { folder: 'reading', tags: ['Research, planning'] },
      issues: [],
    });
  }
  assert.deepEqual(parseExistingNote(frontmatter('type: Literature\ntopics: [Work, work, 随笔]'), 'reading').metadata?.tags, ['Work', '随笔']);
  assert.deepEqual(parseExistingNote(frontmatter('tags: []\ntopics: [ignored]'), 'reading').metadata?.tags, []);
  const invalidTags = parseExistingNote(frontmatter('tags: 42\ntopics: [ignored]'), 'reading');
  assert.deepEqual(invalidTags.metadata?.tags, []);
  assert.equal(invalidTags.issues.length, 1);
});

test('invalid existing metadata fields do not discard valid fields or tag entries', () => {
  const parsed = parseExistingNote(frontmatter('title: Preserved title\nfolder: elsewhere\ntags: [Work, 42, " ", work, Reading]\ncreated: 2026-02-29'), 'reading');
  assert.deepEqual(parsed.metadata, { folder: 'reading', title: 'Preserved title', tags: ['Work', 'Reading'] });
  assert.equal(parsed.issues.length, 3);
  assert.match(parsed.issues.join(' '), /expected reading/u);
  const invalidTitle = parseExistingNote(frontmatter('title: 42\ntags: research\ncreated: 2026-10-18'), 'reading');
  assert.deepEqual(invalidTitle.metadata, { folder: 'reading', tags: ['research'], created: '2026-10-18' });
  assert.equal(invalidTitle.issues.length, 1);
});

test('existing malformed frontmatter warns instead of being treated as missing', () => {
  for (const text of ['---', '---\ntitle: Unclosed', frontmatter('[not, a, mapping]')]) {
    const parsed = parseExistingNote(text, 'reading');
    assert.equal(parsed.metadata, undefined);
    assert.ok(parsed.issues.length > 0);
  }
});

test('frontmatter requires exactly four fields with their required value types', () => {
  const invalidFields = [
    `${validFields}\nupdated: 2026-10-19`,
    `${validFields}\n__proto__: {polluted: true}`,
    validFields.replace('title: A note\n', ''),
    validFields.replace('title: A note', 'title: 42'),
    validFields.replace('title: A note', 'title: " "'),
    validFields.replace('title: A note', 'title: "First\\nSecond"'),
    validFields.replace('folder: idea', 'folder: Other'),
    validFields.replace('tags: []', 'tags: shopping'),
    validFields.replace('tags: []', 'tags: [shopping, 3]'),
    validFields.replace('tags: []', 'tags: [" "]'),
    validFields.replace('tags: []', 'tags: ["First\\nSecond"]'),
    validFields.replace('tags: []', 'tags: ["Bad\\u0000Topic"]'),
    validFields.replace('created: 2026-10-18', 'created: 2026-02-29'),
    validFields.replace('created: 2026-10-18', 'created: 2026-10-18T12:00:00Z'),
    '[title, folder, tags, created]',
  ];
  for (const fields of invalidFields) {
    assert.equal(parseNote(frontmatter(fields), 'idea').metadata, undefined, fields);
  }
  assert.equal(parseNote(frontmatter(validFields), 'note').metadata, undefined);
});

test('title validation and serialization reject multiline titles', () => {
  assert.equal(validateTitle('Cost: α and β'), undefined);
  for (const title of ['', '  ', 'a\nb', 'a\rb', 'a\u2028b', 'a\0b']) {
    assert.ok(validateTitle(title));
    assert.throws(() => serializeNote({ ...metadata, title }));
  }
});

test('serialization rejects multiline tags and control characters', () => {
  for (const tag of ['First\nSecond', 'First\rSecond', 'First\u2028Second', 'Bad\0Topic']) {
    assert.throws(() => serializeNote({ ...metadata, tags: [tag] }));
  }
});

test('calendar validation handles leap years and malformed dates', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-10-18', '0001-01-01']) assert.ok(isCalendarDate(date), date);
  for (const date of ['1900-02-29', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-1', '0000-01-01']) assert.equal(isCalendarDate(date), false, date);
  assert.equal(localDate(new Date(2026, 9, 18, 23, 59)), '2026-10-18');
  assert.throws(() => localDate(new Date(Number.NaN)));
});

test('filename slugs preserve Unicode letters and remove filesystem separators', () => {
  assert.equal(titleSlug('  Cost: Plans / Tasks?  '), 'cost-plans-tasks');
  assert.equal(titleSlug('优化 / Café'), '优化-café');
  assert.equal(titleSlug('Cafe\u0301'), 'café');
  assert.equal(titleSlug('../../CON\\<>:"|?*'), 'con');
  assert.equal(titleSlug('... 😀'), 'note');
  assert.equal(titleSlug('First\nSecond'), 'first-second');
});

test('slug truncation is UTF-8 bounded and does not break a Unicode character', () => {
  const slug = titleSlug('优'.repeat(100));
  assert.equal(Buffer.byteLength(slug, 'utf8'), 96);
  assert.equal(slug, '优'.repeat(32));
  assert.equal(titleSlug(`${'a'.repeat(95)} x`), 'a'.repeat(95));
});

test('filenames use the required date and safely distinguish collision attempts', () => {
  assert.equal(noteFilename('A note', '2026-10-18'), '2026-10-18-a-note.md');
  assert.equal(noteFilename('A note', '2026-10-18', 1), '2026-10-18-a-note.md');
  assert.equal(noteFilename('A note', '2026-10-18', 2), '2026-10-18-a-note-2.md');
  assert.equal(noteFilename('A/note', '2026-10-18', 3), '2026-10-18-a-note-3.md');
  assert.ok(Buffer.byteLength(noteFilename('优'.repeat(100), '2026-10-18', Number.MAX_SAFE_INTEGER)) < 255);
  assert.throws(() => noteFilename('A note', '2026-02-30'));
  for (const attempt of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => noteFilename('A note', '2026-10-18', attempt));
  }
});


test('old type/topics metadata retains titles and labels under any configured folder', () => {
  const text = frontmatter('title: Old note\ntype: Project Idea\ntopics: [Projects, projects, 随笔]\ncreated: 2026-10-18');
  const parsed = parseNote(text, 'archive/projects');
  assert.deepEqual(parsed, {
    metadata: { title: 'Old note', folder: 'archive/projects', tags: ['Projects', '随笔'], created: '2026-10-18' },
    issues: [],
  });
  assert.ok(parseNote(text.replace('type: Project Idea', 'type: []'), 'archive/projects').issues.length);
  assert.ok(parseNote(text.replace('topics: [Projects, projects, 随笔]', 'topics: [42]'), 'archive/projects').issues.length);
  assert.ok(parseNote(text.replace('type: Project Idea', 'type: Project Idea\nfolder: archive/projects'), 'archive/projects').issues.length);
});
