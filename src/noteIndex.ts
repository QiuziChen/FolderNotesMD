import * as vscode from 'vscode';
import { NoteRecord } from './model';
import { NoteRepository } from './noteRepository';

/** A disposable, in-memory projection. Scans and watcher updates never write notes. */
export class NoteIndex implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watchers: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private requested = false;
  private disposed = false;
  notes: readonly NoteRecord[] = [];

  constructor(private readonly repository: NoteRepository, root: vscode.Uri, private readonly report: (errors: readonly string[]) => void) {
    const sources = [...repository.folders, ...repository.legacySources.map(source => source.path)];
    const prefix = root.path.replace(/\/$/, '') + '/';
    const relevant = (uri: vscode.Uri): boolean => {
      if (uri.scheme !== root.scheme || uri.authority !== root.authority || !uri.path.startsWith(prefix)) return false;
      const path = uri.path.slice(prefix.length);
      return sources.some(source => path === source || path.startsWith(source + '/') || source.startsWith(path + '/'));
    };
    // Include directory events: deleting a parent need not emit events for each child.
    // Filter literal paths here, so brackets in legacy paths never become glob syntax.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**'));
    const update = (uri: vscode.Uri): void => { if (relevant(uri)) this.schedule(); };
    this.watchers.push(watcher, watcher.onDidCreate(update), watcher.onDidChange(update), watcher.onDidDelete(update));
    this.watchers.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (relevant(document.uri)) this.schedule();
    }));
  }

  tags(): string[] {
    const result = new Map<string, string>();
    for (const note of this.notes) for (const tag of note.tags) {
      const key = tag.normalize('NFC').toLowerCase().normalize('NFC');
      if (!result.has(key)) result.set(key, tag);
    }
    return [...result.values()].sort((a, b) => a.localeCompare(b));
  }

  schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch(error => this.report([String(error)])); }, 150);
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.requested = true;
    if (!this.pending) {
      this.pending = this.drain().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.disposed) {
      this.requested = false;
      const result = await this.repository.scan();
      if (this.disposed) return;
      this.notes = result.notes;
      this.report(result.errors);
      this.changed.fire();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.dispose();
    this.changed.dispose();
  }
}
