import * as vscode from 'vscode';
import { open } from 'node:fs/promises';
import { FileAccess, DirectoryEntry } from './noteRepository';
import { validateRelativePath } from './legacy';

/** All paths are relative to the selected workspace, never the extension directory. */
export class WorkspaceFiles implements FileAccess {
  constructor(readonly root: vscode.Uri) {}

  uri(relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...validateRelativePath(relativePath).split('/'));
  }

  private async rejectSymlinks(relativePath: string, allowMissing = false): Promise<void> {
    let uri = this.root;
    for (const part of validateRelativePath(relativePath).split('/')) {
      uri = vscode.Uri.joinPath(uri, part);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.SymbolicLink) {
          throw new Error(`Symbolic links are not followed: ${relativePath}`);
        }
      } catch (error) {
        if (allowMissing && isMissing(error)) return;
        throw error;
      }
    }
  }

  async readDirectory(relativePath: string): Promise<DirectoryEntry[]> {
    if (relativePath) await this.rejectSymlinks(relativePath);
    const entries = await vscode.workspace.fs.readDirectory(relativePath ? this.uri(relativePath) : this.root);
    return entries.map(([name, type]) => ({
      name,
      kind: type & vscode.FileType.SymbolicLink ? 'symlink' : type & vscode.FileType.Directory ? 'directory' : 'file',
    }));
  }

  async readText(relativePath: string): Promise<string> {
    await this.rejectSymlinks(relativePath);
    return new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(this.uri(relativePath)));
  }

  async stat(relativePath: string): Promise<{ mtime: number }> {
    await this.rejectSymlinks(relativePath);
    return vscode.workspace.fs.stat(this.uri(relativePath));
  }

  async ensureDirectory(relativePath: string): Promise<void> {
    this.requireWritableWorkspace();
    await this.rejectSymlinks(relativePath, true);
    await vscode.workspace.fs.createDirectory(this.uri(relativePath));
  }

  async createFile(relativePath: string, content: string): Promise<'created' | 'exists'> {
    this.requireWritableWorkspace();
    await this.rejectSymlinks(relativePath, true);
    const uri = this.uri(relativePath);
    // WorkspaceEdit.createFile can race between simultaneous requests. The OS-level
    // exclusive create is necessary to avoid overwriting notes, even across windows.
    let handle;
    try {
      handle = await open(uri.fsPath, 'wx');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return 'exists';
      throw error;
    }
    try {
      await handle.writeFile(content, 'utf8');
    } catch (error) {
      throw new Error(`The new file ${relativePath} may be incomplete because writing failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await handle.close();
    }
    return 'created';
  }

  private requireWritableWorkspace(): void {
    if (this.root.scheme !== 'file') {
      throw new Error('Creating notes requires a filesystem-backed workspace. This virtual workspace supports browsing only.');
    }
  }

}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && ['FileNotFound', 'ENOENT'].includes(String(error.code));
}
