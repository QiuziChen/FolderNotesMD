export const DEFAULT_FOLDERS: readonly string[] = Object.freeze(['idea', 'note']);

export interface NewNoteInput {
  title: string;
  folder: string;
  tags: string[];
}

export interface NoteMetadata extends NewNoteInput {
  created: string;
}

export interface NoteRecord {
  relativePath: string;
  title: string;
  folder: string;
  tags: string[];
  created?: string;
  mtime: number;
  legacy: boolean;
  issues: string[];
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}
