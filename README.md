# Tab Group Collections

Firefox WebExtension that adds a collection layer on top of native Firefox tab groups.

## License

Starting with version 1.8.0, Tab Group Collections is licensed under the
**MIT License with Commons Clause License Condition v1.0**. The complete,
combined terms are in [LICENSE](LICENSE) and are included in release packages.

You can use the extension for free, including at work, and inspect, modify, and
share its source subject to those terms. The Commons Clause restricts selling
products or services whose value derives entirely or substantially from the
extension, including rebranded or lightly modified paid copies. Its definition
of selling also covers certain paid hosting, consulting, and support services;
see [the Commons Clause explanation](https://commonsclause.com/) for details.
The project is source available rather than open source.

This change does not revoke permissions for earlier versions already released
under MIT. The author may request voluntary donations to support development;
using the extension does not require a donation.

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
from search enters the results; Enter from search activates the first result.
When a saved collection needs opening choices, this focuses New Window immediately;
press Enter again to open it, or Down to choose Append Here.
Up and Down move through collections and their expanded New Window and Append
Here choices. Right opens those choices; Left
closes them and returns focus to the collection. Enter on a collection performs
its action: go to an open collection, restore its missing groups, or show opening
choices for a saved collection. In a window with just one ungrouped blank tab or
Firefox Home tab, saved collections open directly in that window from either
panel, replacing the placeholder tab. Enter on a choice opens the saved
collection. Tab and Shift+Tab also move between the choices. Escape clears a
query, then closes the popup when pressed again.

The sidebar keeps its management layout and starts with Filter focused. Down
enters the collection list; Up/Down moves through collection headings, groups,
and expanded choices. Tab and Shift+Tab reach every action and native dropdown.
Enter or Space on a collection heading expands/collapses it; Right expands it
and then enters its first group. Left returns to the heading or collapses it.
Filtered collections stay expanded. Enter from Filter invokes the first
collection's existing Open/Go to action. Saved collections offer New Window and
Append Here with the same opening rules as the quick panel.

Right opens an action's choices; Down enters them. Left or Escape closes choices
and returns focus to their button. Otherwise Escape clears filtering, then
returns to Filter, keeping the sidebar open. Home/End jumps to the first/last
navigation item outside text fields and dropdowns. Alt+Up/Down on a group or its
controls reorders it; activating the drag handle opens its existing move panel.
Text editing, dropdown keys, and input-method composition retain their native
behavior. Focus and unfinished move destinations survive live list updates.
An expandable Keyboard controls guide is available at the bottom of the sidebar.

Closing a collection keeps its groups saved in the extension. Close and delete
actions avoid creating additional Firefox saved groups. If an action empties a
window, it leaves one blank tab open. A canceled Close restores tabs from a
partly closed group using Firefox's undo history; if that history is unavailable,
their URLs are kept in a separate recovery collection. Existing Firefox saved copies remain
managed through Firefox's own controls.

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
- `src/sidebar-keyboard.js`: sidebar keyboard navigation and focus restoration
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
