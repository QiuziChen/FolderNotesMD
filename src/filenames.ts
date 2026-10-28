import { isCalendarDate } from './model';

const MAX_SLUG_BYTES = 96;

export function localDate(date: Date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Cannot format an invalid date.');
  const value = [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  if (!isCalendarDate(value)) throw new RangeError('The date must have a year between 0001 and 9999.');
  return value;
}

export function titleSlug(title: string): string {
  const slug = title.normalize('NFC').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  let result = '';
  let bytes = 0;
  for (const character of slug) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_SLUG_BYTES) break;
    result += character;
    bytes += size;
  }
  return result.replace(/-+$/u, '') || 'note';
}

export function noteFilename(title: string, date: string, attempt: number = 1): string {
  if (!isCalendarDate(date)) throw new RangeError('A valid YYYY-MM-DD date is required.');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('The filename attempt must be a positive safe integer.');
  const suffix = attempt === 1 ? '' : `-${attempt}`;
  return `${date}-${titleSlug(title)}${suffix}.md`;
}
