# Tab Group Collections

Firefox WebExtension that adds a collection layer on top of native Firefox tab groups.

## What It Does

- Organizes native Firefox tab groups into higher-level collections
- Keeps collection membership in sync with live tab groups
- Provides a sidebar for managing collections and groups
- Supports renaming, pinning, moving, deleting, and reopening groups
- Includes a compact popup with search for collection and tab group names

To open either panel with a keyboard shortcut while Firefox is active, go to
**Add-ons → gear menu → Manage Extension Shortcuts** and assign shortcuts to
**Open quick panel** and **Open side panel** under **Tab Group Collections**.
Neither command has a shortcut assigned by default. For a temporary development
installation, reload the extension in `about:debugging` after updating it to make
the commands available.

The popup focuses search when it opens and keeps a fixed width while filtering.
Collection-name matches stay compact;
group-name matches show the matching group beneath the collection. Individual
tab titles and URLs are not searched. Use Tab to move between controls. Down
from search enters the results; Up and Down move through collections and their
expanded New Window and Append Here choices. Right opens those choices; Left
closes them and returns focus to the collection. Enter on the collection toggles
the choices; Enter on a choice opens the saved collection. Tab and Shift+Tab also
move between the choices. Escape clears a query, then closes the popup when
pressed again.

Both panels include a quiet link to the extension's Mozilla Add-ons reviews page.
The sidebar also offers a dismissible invitation after two weeks and successful
collection actions on five distinct days. Showing or dismissing that card pauses
it for three calendar months. Clicking any review link pauses it for a year;
the permanent links remain available. The extension cannot detect whether a
review was submitted. Reminder preferences are stored locally under a separate
key, with at most five activity dates and no collection names or tab information.

## Project Files

- `src/background.js`: collection state, tab-group sync, open/move/delete actions
- `src/sidebar.html`, `src/sidebar.css`, `src/sidebar.js`: main management UI
- `src/popup.html`, `src/popup.css`, `src/popup.js`: quick-open popup
- `src/shared.js`: shared collection/group logic used by background and UI
- `src/review-*.js`, `src/review.css`: local review reminder timing, links, and presentation
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

Run the automated checks with:

```bash
npm test
npm run check:js
npm run test:e2e
```

The E2E tests launch Firefox with fresh temporary profiles and synthetic groups.
They do not use your normal Firefox profile or stored collections.

## Notes

- The extension uses `browser.storage.local` for collection state.
- During development, uninstalling a temporary extension can clear stored data.
- The Firefox add-on ID is fixed in `manifest.json` under `browser_specific_settings.gecko.id`.
