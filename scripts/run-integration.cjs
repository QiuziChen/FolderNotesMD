const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

(async () => {
  // Terminals embedded in Electron may export this; the test host must run as VS Code.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Keep macOS Unix-domain socket paths below their 104-byte limit.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fn-'));
  const notesWorkspace = path.join(directory, 'workspace');
  await fs.mkdir(path.join(notesWorkspace, 'notes'), { recursive: true });
  await fs.mkdir(path.join(notesWorkspace, 'reading'), { recursive: true });
  await fs.writeFile(path.join(notesWorkspace, 'notes', 'idea.md'), '# Existing projects\n\n#body-tag\n');
  await fs.writeFile(path.join(notesWorkspace, 'reading', 'old.md'), '# Existing reference\n\nUnchanged.\n');
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../dist/test/integration/suite.js'),
      ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : {}),
      launchArgs: [notesWorkspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(directory, 'u'), '--extensions-dir', path.join(directory, 'e')],
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
