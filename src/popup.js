const errorNode = document.getElementById('popup-error');
const emptyNode = document.getElementById('popup-empty');
const sectionsNode = document.getElementById('popup-sections');
const openPanelButtonNode = document.getElementById('open-panel-button');
const searchInputNode = document.getElementById('popup-search');
const clearSearchButtonNode = document.getElementById('clear-search-button');
const Shared = globalThis.TabGroupCollectionsShared;
const UiTheme = globalThis.TabGroupCollectionsUiTheme;

let openChoiceCollectionId = null;
let lastSnapshot = null;
let lastWindowId = null;

function showError(message) {
  errorNode.textContent = message;
  errorNode.classList.remove('hidden');
}

function clearError() {
  errorNode.textContent = '';
  errorNode.classList.add('hidden');
}

function createNode(tagName, className, textContent) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (typeof textContent === 'string') {
    node.textContent = textContent;
  }
  return node;
}

const ICON_PATHS = {
  chevronRight: [
    'm9 18 6-6-6-6'
  ],
  chevronDown: [
    'm6 9 6 6 6-6'
  ]
};

function createIcon(name, className = 'icon-svg') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);

  for (const pathData of ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }

  return svg;
}

/** Prefer collection-name matches within each section, then retain the usual recent order. */
function compareCollections(left, right) {
  const query = Shared.normalizeFilterText(searchInputNode.value);
  if (query) {
    const nameMatchOrder = Number(right.name.toLowerCase().includes(query)) -
      Number(left.name.toLowerCase().includes(query));
    if (nameMatchOrder) {
      return nameMatchOrder;
    }
  }
  return Shared.compareCollections(left, right, { sortMode: 'last-active' });
}

async function getCurrentWindowId() {
  const tabs = await browser.tabs.query({ currentWindow: true });
  if (!tabs.length) {
    throw new Error('No browser window tabs were found.');
  }
  return tabs[0].windowId;
}

/** Run a collection request and count successful user actions toward the optional review invitation. */
async function sendMessage(payload) {
  const response = await browser.runtime.sendMessage(payload);
  if (response?.error) {
    throw new Error(response.error);
  }
  if (payload.type.startsWith('sidebar:') && payload.type !== 'sidebar:getSnapshot') {
    globalThis.TabGroupCollectionsReviewUi.recordActivity();
  }
  return response;
}

/** Keep the compact panel label stable while describing whether it opens or closes the sidebar. */
async function syncOpenPanelButton(currentWindowId) {
  const isOpen = typeof browser.sidebarAction?.isOpen === 'function'
    ? await browser.sidebarAction.isOpen({ windowId: currentWindowId })
    : false;
  const action = isOpen ? 'Close side panel' : 'Open side panel';
  openPanelButtonNode.classList.remove('hidden');
  openPanelButtonNode.setAttribute('aria-label', action);
  openPanelButtonNode.setAttribute('aria-pressed', String(isOpen));
  openPanelButtonNode.title = action;
  openPanelButtonNode.dataset.sidebarState = isOpen ? 'open' : 'closed';
}

async function waitForSidebarOpen(currentWindowId, timeoutMs = 2500) {
  if (typeof browser.sidebarAction?.isOpen !== 'function') {
    return true;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const isOpen = await browser.sidebarAction.isOpen({ windowId: currentWindowId });
    if (isOpen) {
      return true;
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 100);
    });
  }

  return false;
}

async function handleCollectionClick(collection, currentWindowId) {
  if (collection.liveGroupCount > 0 && collection.snapshotGroupCount > collection.liveGroupCount) {
    await sendMessage({
      type: 'sidebar:openCollection',
      currentWindowId,
      collectionId: collection.id,
      targetMode: 'append'
    });
    window.close();
    return;
  }

  if (collection.liveGroupCount > 0) {
    await sendMessage({
      type: 'sidebar:focusCollection',
      currentWindowId,
      collectionId: collection.id
    });
    window.close();
    return;
  }

  if (!collection.snapshotGroupCount) {
    return;
  }

  await sendMessage({
    type: 'sidebar:openCollection',
    currentWindowId,
    collectionId: collection.id,
    targetMode: 'append'
  });
  window.close();
}

async function openSavedCollection(collection, currentWindowId, targetMode) {
  await sendMessage({
    type: 'sidebar:openCollection',
    currentWindowId,
    collectionId: collection.id,
    targetMode
  });
  window.close();
}

function canOpenSavedCollectionInCurrentWindow(collection) {
  return Boolean(
    lastSnapshot?.currentWindowHasOnlyEmptyNewTab &&
    collection.liveGroupCount === 0 &&
    collection.snapshotGroupCount > 0
  );
}

function shouldShowOpenChoices(collection) {
  return (
    collection.liveGroupCount === 0 &&
    collection.snapshotGroupCount > 0 &&
    !canOpenSavedCollectionInCurrentWindow(collection)
  );
}

/** Mark literal name text, mapping lowercased matches back to their original character boundaries. */
function appendHighlightedText(node, text, query) {
  if (!query) {
    node.appendChild(document.createTextNode(text));
    return;
  }

  const normalizedText = text.toLowerCase();
  const sourceOffsets = [];
  let sourcePosition = 0;
  // Lowercasing İ produces two characters. Keep both mapped to the same original
  // character so matches after it stay aligned and partial matches highlight it whole.
  for (const character of text) {
    const end = sourcePosition + character.length;
    for (let index = 0; index < character.toLowerCase().length; index += 1) {
      sourceOffsets.push({ start: sourcePosition, end });
    }
    sourcePosition = end;
  }

  const ranges = [];
  let matchIndex = normalizedText.indexOf(query);
  while (matchIndex !== -1) {
    const start = sourceOffsets[matchIndex].start;
    const end = sourceOffsets[matchIndex + query.length - 1].end;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.end >= start) {
      previous.end = end;
    } else {
      ranges.push({ start, end });
    }
    matchIndex = normalizedText.indexOf(query, matchIndex + query.length);
  }

  let position = 0;
  for (const { start, end } of ranges) {
    node.appendChild(document.createTextNode(text.slice(position, start)));
    node.appendChild(createNode('mark', '', text.slice(start, end)));
    position = end;
  }
  node.appendChild(document.createTextNode(text.slice(position)));
}

/** Render each collection once, explaining group-only matches without changing its open action. */
function renderSection(title, collections, currentWindowId, query) {
  const section = createNode('section', 'popup-section');
  section.appendChild(createNode('h2', 'popup-section-title', title));

  const list = createNode('div', 'collection-list');
  for (const collection of collections) {
    const item = createNode('div', 'collection-item');
    const button = createNode('button', 'collection-link');
    button.type = 'button';
    button.classList.toggle('current', collection.isCurrent);
    button.disabled = collection.liveGroupCount === 0 && collection.snapshotGroupCount === 0;
    const copy = createNode('span', 'collection-link-copy');
    const label = createNode('span', 'collection-link-label');
    appendHighlightedText(label, collection.name, query);
    copy.appendChild(label);
    if (query && !collection.name.toLowerCase().includes(query)) {
      const matchingGroups = collection.visibleGroups;
      const detail = createNode('span', 'collection-link-match', 'Group: ');
      appendHighlightedText(detail, matchingGroups[0].title, query);
      if (matchingGroups.length > 1) {
        detail.appendChild(document.createTextNode(` +${matchingGroups.length - 1}`));
      }
      detail.title = matchingGroups.map((group) => group.title).join('\n');
      detail.setAttribute('aria-label', `Matching groups: ${matchingGroups.map((group) => group.title).join(', ')}`);
      copy.appendChild(detail);
    }
    button.appendChild(copy);
    if (shouldShowOpenChoices(collection)) {
      button.setAttribute('aria-expanded', String(openChoiceCollectionId === collection.id));
      const chevron = createNode('span', 'collection-link-chevron');
      chevron.appendChild(createIcon(openChoiceCollectionId === collection.id ? 'chevronDown' : 'chevronRight'));
      button.appendChild(chevron);
    }
    button.addEventListener('click', async () => {
      try {
        clearError();
        if (shouldShowOpenChoices(collection)) {
          openChoiceCollectionId = openChoiceCollectionId === collection.id ? null : collection.id;
          renderSnapshot(lastSnapshot, lastWindowId);
          // Rendering replaces the clicked row; keep keyboard focus on that same collection.
          Array.from(sectionsNode.querySelectorAll('.collection-link')).find((node) => (
            node.dataset.collectionId === collection.id
          ))?.focus();
          return;
        }
        await handleCollectionClick(collection, currentWindowId);
      } catch (error) {
        showError(error.message || 'Unable to open collection.');
      }
    });
    button.dataset.collectionId = collection.id;
    item.appendChild(button);

    if (shouldShowOpenChoices(collection)) {
      const openChoices = createNode('div', 'open-choices');
      openChoices.classList.toggle('hidden', openChoiceCollectionId !== collection.id);

      const newWindowButton = createNode('button', 'open-choice-button', 'New Window');
      newWindowButton.type = 'button';
      newWindowButton.addEventListener('click', async () => {
        try {
          clearError();
          await openSavedCollection(collection, currentWindowId, 'new-window');
        } catch (error) {
          showError(error.message || 'Unable to open collection.');
        }
      });

      const appendButton = createNode('button', 'open-choice-button', 'Append Here');
      appendButton.type = 'button';
      appendButton.addEventListener('click', async () => {
        try {
          clearError();
          await openSavedCollection(collection, currentWindowId, 'append');
        } catch (error) {
          showError(error.message || 'Unable to open collection.');
        }
      });

      openChoices.append(newWindowButton, appendButton);
      item.appendChild(openChoices);
    }

    list.appendChild(item);
  }

  section.appendChild(list);
  return section;
}

/** Filter only the in-memory popup snapshot; searching never sends a write or edits saved data. */
function renderSnapshot(snapshot, currentWindowId) {
  clearError();
  lastSnapshot = snapshot;
  lastWindowId = currentWindowId;
  sectionsNode.replaceChildren();
  const query = Shared.normalizeFilterText(searchInputNode.value);
  clearSearchButtonNode.classList.toggle('hidden', !searchInputNode.value);

  const visibleCollections = snapshot.collections.filter((collection) => (
    !collection.isUncategorized &&
    (collection.liveGroupCount > 0 || collection.snapshotGroupCount > 0)
  ));

  if (!visibleCollections.length) {
    emptyNode.textContent = 'No collections to open yet.';
    emptyNode.classList.remove('hidden');
    return;
  }

  const matchingCollections = Shared.getFilteredCollections({ collections: visibleCollections }, query);
  if (!matchingCollections.length) {
    emptyNode.textContent = `No collections or group names match “${searchInputNode.value.trim()}”.`;
    emptyNode.classList.remove('hidden');
    return;
  }

  emptyNode.classList.add('hidden');
  const pinnedCollections = matchingCollections
    .filter((collection) => collection.isPinned)
    .sort(compareCollections);
  const otherCollections = matchingCollections
    .filter((collection) => !collection.isPinned)
    .sort(compareCollections);

  if (pinnedCollections.length) {
    sectionsNode.appendChild(renderSection('Pinned', pinnedCollections, currentWindowId, query));
  }
  if (otherCollections.length) {
    sectionsNode.appendChild(renderSection('Collections', otherCollections, currentWindowId, query));
  }
}

/** Refresh results from the loaded snapshot and collapse choices that belong to an earlier query. */
function updateSearch() {
  openChoiceCollectionId = null;
  clearSearchButtonNode.classList.toggle('hidden', !searchInputNode.value);
  if (lastSnapshot) {
    renderSnapshot(lastSnapshot, lastWindowId);
  }
}

searchInputNode.addEventListener('input', updateSearch);
clearSearchButtonNode.addEventListener('click', () => {
  searchInputNode.value = '';
  updateSearch();
  searchInputNode.focus();
});

/** Move through visible collection actions while retaining native text editing and Tab order. */
function handlePopupKeydown(event) {
  // Candidate navigation and cancellation belong to the active input method.
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (searchInputNode.value) {
      searchInputNode.value = '';
      updateSearch();
      searchInputNode.focus();
    } else {
      window.close();
    }
    return;
  }

  // Choices join their parent collection in DOM order only while expanded.
  const buttons = Array.from(sectionsNode.querySelectorAll(
    '.collection-link:not(:disabled), .open-choices:not(.hidden) .open-choice-button:not(:disabled)'
  ));
  const activeElement = document.activeElement;
  const index = buttons.indexOf(activeElement);
  const isSearchEntry = activeElement === searchInputNode || activeElement === document.body;
  if (event.key === 'ArrowDown' && (isSearchEntry || index !== -1)) {
    event.preventDefault();
    buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
  } else if (event.key === 'ArrowUp' && index !== -1) {
    event.preventDefault();
    (index === 0 ? searchInputNode : buttons[index - 1]).focus();
  } else if (event.key === 'ArrowRight' && activeElement.matches('.collection-link[aria-expanded]')) {
    event.preventDefault();
    // Right opens the choices once; repeated presses must not collapse them.
    if (activeElement.getAttribute('aria-expanded') === 'false') {
      activeElement.click();
    }
  } else if (event.key === 'ArrowLeft' && index !== -1) {
    // Left also returns from either opening choice to its collection row.
    const collectionButton = activeElement.closest('.collection-item')
      ?.querySelector('.collection-link[aria-expanded]');
    if (collectionButton) {
      event.preventDefault();
      if (collectionButton.getAttribute('aria-expanded') === 'true') {
        collectionButton.click();
      }
    }
  }
}

document.addEventListener('keydown', handlePopupKeydown);

openPanelButtonNode.addEventListener('click', () => {
  clearError();

  const isOpen = openPanelButtonNode.dataset.sidebarState === 'open';
  const openFn = typeof browser.sidebarAction?.open === 'function'
    ? browser.sidebarAction.open.bind(browser.sidebarAction)
    : null;
  const closeFn = typeof browser.sidebarAction?.close === 'function'
    ? browser.sidebarAction.close.bind(browser.sidebarAction)
    : null;
  const toggleFn = typeof browser.sidebarAction?.toggle === 'function'
    ? browser.sidebarAction.toggle.bind(browser.sidebarAction)
    : null;

  if (!openFn && !closeFn && !toggleFn) {
    showError('Sidebar API is unavailable.');
    return;
  }

  try {
    const currentWindowId = lastWindowId;

    if (isOpen) {
      const operation = closeFn || toggleFn;
      operation().catch((error) => {
        console.error('Unable to close sidebar.', error);
      });
      window.setTimeout(() => {
        window.close();
      }, 120);
    } else {
      const operation = openFn || toggleFn;
      operation()
        .catch((error) => {
          if (!toggleFn || operation === toggleFn) {
            throw error;
          }
          return toggleFn();
        })
        .then(() => waitForSidebarOpen(currentWindowId))
        .then((didOpen) => {
          if (didOpen) {
            window.close();
          }
        })
        .catch((error) => {
          console.error('Unable to open sidebar.', error);
        });
    }
  } catch (error) {
    showError(error?.message || 'Unable to open panel.');
  }
});

// Focus immediately, before asynchronous sidebar checks or snapshot loading can delay typing.
searchInputNode.focus();

// Firefox can move focus back to the document when it finishes showing the
// toolbar panel. Restore search only if no control has since received focus.
window.addEventListener('focus', () => {
  window.requestAnimationFrame(() => {
    if (document.activeElement === document.body) {
      searchInputNode.focus();
    }
  });
});

(async () => {
  try {
    const currentWindowId = await getCurrentWindowId();
    await syncOpenPanelButton(currentWindowId);
    const snapshot = await sendMessage({
      type: 'sidebar:getSnapshot',
      currentWindowId
    });
    renderSnapshot(snapshot, currentWindowId);
  } catch (error) {
    showError(error.message || 'Unable to load collections.');
  }
})();

UiTheme.start();
