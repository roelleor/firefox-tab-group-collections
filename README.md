# Tab Group Collections

Firefox WebExtension that adds a collection layer on top of native Firefox tab groups.

## What It Does

- Organizes native Firefox tab groups into higher-level collections
- Keeps collection membership in sync with live tab groups
- Provides a sidebar for managing collections and groups
- Supports renaming, pinning, moving, deleting, and reopening groups
- Includes a compact popup for quick collection access

## Project Files

- `src/background.js`: collection state, tab-group sync, open/move/delete actions
- `src/sidebar.html`, `src/sidebar.css`, `src/sidebar.js`: main management UI
- `src/popup.html`, `src/popup.css`, `src/popup.js`: quick-open popup
- `src/shared.js`: shared collection/group logic used by background and UI
- `src/icons/`: extension icon assets
- `build.sh`: packages the extension into `dist/tab-group-collections.zip`

## Development

Load the extension temporarily in Firefox via `about:debugging`, or build the zip first:

```bash
./build.sh
```

The packaged artifact is written to:

```text
dist/tab-group-collections.zip
```

## Notes

- The extension uses `browser.storage.local` for collection state.
- During development, uninstalling a temporary extension can clear stored data.
- The Firefox add-on ID is fixed in `manifest.json` under `browser_specific_settings.gecko.id`.
