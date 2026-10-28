# FolderNotesMD

A lightweight VS Code extension for local Markdown notes, organized with custom folders and tags. Use it for ideas, meeting notes, reading, projects, or any other collection. Notes remain ordinary files in your workspace and open in VS Code's native Markdown editor and preview.

## Quick start

1. Download or clone this GitHub repository, then build and install the local VSIX package as described below.
2. Open the workspace folder where you want to keep notes.
3. Select **FolderNotesMD** in the Activity Bar, then **Add Folder** to include existing Markdown folders from this workspace.
4. Browse the discovered notes, or select **New Note**, choose a folder, enter a title, and choose or add tags.

The initial folders are `idea` and `note`. These are defaults, not fixed categories, and both can be removed from the sidebar. A folder is created only when you save a new note in it. Opening the sidebar does not create files or directories.

For a workspace containing multiple folders, run **FolderNotesMD: Select Notes Workspace** to choose which workspace folder contains the notes.

## Custom folders and tags

Select **Add Folder** in the sidebar to add existing directories. To configure additional destinations, run **FolderNotesMD: Configure Note Folders**, or edit the selected workspace folder's `.vscode/settings.json`:

```
{
  "folderNotesMD.folders": [
    "idea",
    "note",
    "meeting",
    "reading",
    "projects/app"
  ],
  "folderNotesMD.tags": ["work", "personal", "todo", "reference"]
}
```

`folderNotesMD.folders` replaces the default list. You can choose your own folder names and any number of folders. Paths are relative to the selected workspace folder; nested paths such as `projects/app` are supported. If configured folders overlap, a note belongs to the most specific configured folder. For example, with both `projects` and `projects/app` configured, `projects/app/example.md` belongs to `projects/app`. Absolute paths, traversal segments, hidden paths, and nonportable path characters are rejected. Removing a folder stops indexing files no longer covered by another configured folder or legacy source; its files remain unchanged.

`folderNotesMD.tags` supplies reusable suggestions. Tags found in indexed notes are offered as well. There is no fixed vocabulary or required tag. To create a new tag in the note wizard, select **Add new tag…**, submit the selection, and enter the tag. The picker reopens with your choices retained. Repeat as needed, then submit without **Add new tag…** selected to finish. You can also add or change tags directly in a note's YAML frontmatter.

Tags added during creation are saved with the completed note, not added automatically to the settings list. Pressing Escape at any wizard step cancels note creation. Settings changes update the sidebar without requiring a window reload.

## Browsing and editing

The sidebar contains **New Note**, **Add Folder**, **Browse by Folder**, **Browse by Tag**, and **Recent Notes**. Folder groups include configured folders even when empty. Tag groups combine configured tags with tags found in notes, including configured tags with no notes yet. A note with several tags appears under each tag. **Untagged** contains notes without indexed tags. **Recent Notes** shows the 20 most recently modified files.

To stop managing a folder, expand **Browse by Folder** and click the minus button beside its name, or right-click it and choose **Remove Folder (Keep Files)**. The command is also available in the Command Palette with a folder picker. Removal changes workspace settings only; it never deletes, moves, or edits the original directory or notes. This also works for empty folders and the defaults `idea` and `note`. Removing all configured folders saves an explicit empty list, so the defaults stay removed after restarting VS Code. **Add Folder** can restore an existing directory later.

Removing a group also removes any legacy-source mappings with that group name. Other groups and separately configured subfolders remain. Notes still covered by another configured folder remain indexed under that folder. Canceling the picker changes nothing.

Edit notes directly in VS Code. File changes update the in-memory index; **FolderNotesMD: Refresh** also rescans the selected workspace. Use **FolderNotesMD: Open Markdown Preview** or VS Code's standard Markdown preview command to preview a note. Math rendering uses VS Code's native `markdown.math.enabled` setting.

The extension uses no external services and makes no network requests. Symbolic links and hidden entries are skipped. Note creation requires a filesystem-backed workspace; virtual workspaces support browsing only.

## Files and metadata

New notes use `YYYY-MM-DD-title-slug.md` filenames. The date is the extension host's local calendar date. Slugs preserve Unicode letters and numbers. Duplicate names receive `-2`, `-3`, and subsequent suffixes without overwriting existing files, including concurrent creation. Editing a title does not rename the file.

A new note in `idea` has this form:

```
---
title: Improve the onboarding flow
folder: idea
tags:
  - work
  - todo
created: 2026-10-28
---

# Improve the onboarding flow
```

New notes use all four fields shown above. `folder` matches the configured folder that contains the note. `tags` is an array of strings and may be `[]`. Tags are trimmed, normalized to NFC, and deduplicated case-insensitively while retaining the first spelling. Titles and tags must be nonempty single-line text without control characters. `created` must be a valid `YYYY-MM-DD` date. Body hashtags are not indexed as tags. Existing files can use partial metadata, as described below.

Invalid metadata remains accessible in the sidebar with a warning icon and tooltip. Metadata warnings also appear in VS Code's Problems panel. File access and configuration errors appear in the **FolderNotesMD** Output channel. Scans do not modify existing files.

## Existing notes and compatibility

Select **Add Folder** in the sidebar, the title-bar folder button, or **FolderNotesMD: Add Folder** in the Command Palette. Choose one or more existing directories inside the selected notes workspace. The extension appends their relative paths to that workspace folder's `folderNotesMD.folders` setting, then recursively discovers `.md` files (including `.MD`). Each selected directory becomes a folder group and a destination for new notes. Previously configured folders are retained; adding the same folder again does not duplicate it. Canceling the picker changes nothing. Choose subdirectories, not the workspace root itself. Hidden paths and symbolic links are not supported.

Files without a valid YAML title use their first H1 or filename as the display title. YAML fields are optional: `title`, `tags`, and `created` are read when present, and additional fields are left untouched and ignored by the index. `tags` may be an array or a single string; a string is treated as one tag. The older `topics` field is read as tags when `tags` is absent. Files without tags appear under **Untagged**. The containing configured folder determines the folder group; a conflicting YAML `folder` value produces a warning. An invalid field does not discard other valid fields, and valid tags are retained if another tag is invalid. Malformed YAML remains browsable with a warning.

Adding folders writes workspace settings only. The extension does not split documents into separate notes or migrate, move, rename, delete, or rewrite existing files. Future edits, new files, and deletions update the sidebar automatically. You can also configure existing folders directly in `folderNotesMD.folders`.

For individual Markdown files or additional directories outside the configured folders, use optional legacy sources:

```
{
  "folderNotesMD.legacySources": [
    { "path": "archive/ideas.md", "folder": "idea" },
    { "path": "old-reading", "folder": "reading" }
  ]
}
```

The `folder` value supplies a group for these existing documents and follows the same naming rules as configured folder paths; it does not move files or create a new-note destination. Legacy sources are marked **Legacy**. Their default is `[]`. Source paths must be workspace-relative and must not overlap configured note folders. If **Add Folder** reports a legacy-source overlap, remove the corresponding legacy-source setting before adding that folder.

## Local development and tests

Use Node.js 22 or later and VS Code 1.100 or later. Open this extension's source folder, then run:

```
npm ci
npm run build
```

Press **F5** to launch the Extension Development Host. In that window, open a separate folder for your notes. The extension source does not need to live inside the notes workspace. Dependency installation requires network access.

Run unit tests and extension-host integration tests with:

```
npm test
npm run test:integration
```

Integration tests use an isolated temporary workspace and user-data directory. Set `VSCODE_EXECUTABLE_PATH` to an installed VS Code executable to use it; otherwise the runner downloads a test copy of VS Code. Tests do not use your personal notes.

## Build and install locally

From the repository folder, run:

```
npm ci
npm run package
```

In VS Code, run **Extensions: Install from VSIX…** and select `foldernotesmd-0.3.0.vsix`. Reload the VS Code window if prompted. If an older extension named **Research Journal** or **Folder Notes** is also installed, disable it and use the **FolderNotesMD** sidebar. Packaging creates a local file; it does not upload or publish the extension.

This project is distributed as source on GitHub and is not published to the VS Code Marketplace. The `foldernotesmd-local` publisher identifies the local VSIX package; no Marketplace account is required to build or install it.

## License

MIT. See the included `LICENSE` file for the full text. The standard license text is also available from the [Open Source Initiative](https://opensource.org/license/mit).
