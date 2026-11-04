# Sidebar Keyboard Control Implementation Plan

> **For agentic workers:** Use direct execution in the existing checkout. The user requests no intermediate questions and a final review by gpt-6-astra at high effort.

**Goal:** Make every sidebar operation available from the keyboard while preserving existing mouse behavior and collection-opening rules.

**Architecture:** Add a sidebar keyboard controller around native buttons and selects. Give rendered controls stable identities so rebuilding the list preserves focus and unfinished move selections. Reuse existing click handlers and background messages.

**Tech Stack:** Plain JavaScript, Firefox WebExtensions, Selenium/Firefox E2E tests.

**Spec:** The user's request and the behavior contract below.

## Behavior contract

- Collection headings continue to toggle group visibility; use native buttons with expanded state.
- Filter receives initial focus without stealing it on subsequent window focus or refresh.
- Down from filter enters the first collection; Enter invokes its existing Open/Go to action (expanding its body if necessary).
- Up/Down traverse collection headings, group titles, and visible panel choices. Tab/Shift+Tab reach all controls normally.
- Right expands a collection or a control's choices; Left closes choices or returns to/collapses a collection.
- Home/End move to first/last navigation item when outside a text field or native select.
- Escape closes the innermost open panel, otherwise clears the filter, otherwise returns to filter. The persistent sidebar stays open.
- Keep native input editing, select behavior, browser modifier shortcuts, and IME composition intact.
- Alt+Up/Down on group controls reorders the group using the existing drop request. The drag handle also opens existing move controls when activated.
- Preserve focus after live refresh, rename, pin, move, delete, collapse, and panel cancellation. Preserve unfinished move selections during refresh.
- Keep window-opening behavior as implemented. Use the quick panel's Append Here label for the same append action.
- Add visible focus indicators and a compact, expandable keyboard-help section.

## Global Constraints

- Do not redesign the sidebar or change existing click actions.
- No new dependencies; operate only on temporary Firefox profiles in tests.
- Keep release actions within the user's explicit authorization; they subsequently requested committing, pushing the current branch, and pushing the new release tag.

## Review Focus

- Group identities change between live/saved states; focus must track the snapshot identity.
- Live refresh while choosing a move destination must retain the selected collection/name.
- Hidden/collapsed controls must not receive keyboard focus.
- Filtering forces collections expanded; Left must not silently change saved collapse preferences.
- Reordering mixed live/saved groups and moving between collections must retain all groups.

## Task 1: Keyboard navigation and focus persistence

**Files:** `src/sidebar.js`, `src/sidebar-keyboard.js`, `src/sidebar.css`, `src/sidebar.html`, `package.json`, `tests/extension-smoke.e2e.test.mjs`, `README.md`.

**Interfaces:** Existing sidebar click handlers and `sidebar:dropGroup` messages remain authoritative.

- [x] Add E2E tests for navigation, choices, cancellation, focus persistence, native input behavior, and reordering.
- [x] Run the new tests and observe missing keyboard behavior.
- [x] Implement semantic headings, stable focus restoration, keyboard navigation and reordering; document controls.
- [x] Run new E2E tests, `npm test`, `npm run check:js`, and full `npm run test:e2e`.
- [x] Obtain final fresh-context Astra high review; fix important findings with regression tests.

## Execution record

- Baseline: clean feature branch `codex/fix-empty-window-quick-open`, HEAD `a771493`.
- Baseline checks: 40 unit tests and JS syntax checks passed; two existing quick-panel keyboard E2E tests passed.
- User opted out of brainstorming questions and delegated all remaining choices.
- Direct executor: current Codex session; final reviewer: gpt-6-astra/high, per explicit user request.
- Added seven Firefox integration tests. Initial five failed against the unchanged implementation at the missing keyboard behaviors. All seven now pass.
- A regression test reproduced off-screen focus after pinning; restoring focus now scrolls the retained control into view.
- Unit suite: 40/40 passed; JS syntax and diff whitespace checks passed. Full Firefox suite in progress.
- Decision: keep native Tab order through the sidebar action row before opening choices; arrow keys provide the direct route into choices.
- Decision: Escape keeps the persistent sidebar open, returning to Filter after closing choices and clearing a query.
- Decision: preserve saved collapse preferences while filtering forces groups visible; Left returns to the heading without changing those preferences.
- Final review: gpt-6-astra/high reviewed the complete diff and reproduced three important issues in disposable Firefox. All three were addressed in one fix pass.
- Fixed: saved rename/live-to-saved transitions closed open disclosures. Four new regressions were run RED, then passed after disclosures switched to stable snapshot identities, scroll restoration respected prior visibility, and closed forms were excluded from pending state.
- Fixed: passive refresh scrolled back to an off-screen focused control. The failing test reproduced scrollY changing from 537.7 to 321.7; it now preserves the manual viewport while the pin-visibility test remains green.
- Fixed: repeated full-list scans for every hidden move form. Capture keeps only open forms, and restore builds one lookup for surviving controls and fallback keys. Search with no pending form/list focus skips restoration entirely.
- Post-review checks: 11/11 focused Firefox tests, 40/40 unit tests, JS syntax and whitespace checks passed. Final full Firefox suite in progress.
- Deferred minor: moving a group into a collapsed destination focuses the source collection heading. The destination stays collapsed and remains reachable; the user should assess whether focus should follow its heading instead.
- Deferred minor: canceling Move opened via the drag handle focuses the adjacent Move arrow button. Both controls open the same form; returning to the exact opener would be a small focus refinement.
- Integration: preserve the existing branch and uncommitted working diff for the user's inspection; no merge, push, or publication requested.
- Final verification: 34/34 full Firefox integration tests passed after the review fixes (119.7 seconds), 40/40 unit tests passed, final JS syntax and diff whitespace checks passed. The built extension is available in the existing ignored `dist/tab-group-collections.zip`.
- Release follow-up: version 1.7.0 dated 2026-11-04 includes this work and the previous commit's quick-open/closure fixes. Manifest, package, lockfile, changelog extraction, and built package versions were checked. The user explicitly requested committing, pushing the existing branch, and pushing tag 1.7.0.
