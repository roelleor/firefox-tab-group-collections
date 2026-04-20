const errorNode = document.getElementById('popup-error');
const emptyNode = document.getElementById('popup-empty');
const sectionsNode = document.getElementById('popup-sections');
const openPanelButtonNode = document.getElementById('open-panel-button');
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

function compareCollections(left, right) {
  return Shared.compareCollections(left, right, { sortMode: 'last-active' });
}

async function getCurrentWindowId() {
  const tabs = await browser.tabs.query({ currentWindow: true });
  if (!tabs.length) {
    throw new Error('No browser window tabs were found.');
  }
  return tabs[0].windowId;
}

async function sendMessage(payload) {
  const response = await browser.runtime.sendMessage(payload);
  if (response?.error) {
    throw new Error(response.error);
  }
  return response;
}

async function syncOpenPanelButton(currentWindowId) {
  if (typeof browser.sidebarAction?.isOpen !== 'function') {
    openPanelButtonNode.classList.remove('hidden');
    openPanelButtonNode.textContent = 'Open Side Panel';
    openPanelButtonNode.dataset.sidebarState = 'closed';
    return;
  }

  const isOpen = await browser.sidebarAction.isOpen({ windowId: currentWindowId });
  openPanelButtonNode.classList.remove('hidden');
  openPanelButtonNode.textContent = isOpen ? 'Close Side Panel' : 'Open Side Panel';
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

function renderSection(title, collections, currentWindowId) {
  const section = createNode('section', 'popup-section');
  section.appendChild(createNode('h2', 'popup-section-title', title));

  const list = createNode('div', 'collection-list');
  for (const collection of collections) {
    const item = createNode('div', 'collection-item');
    const button = createNode('button', 'collection-link');
    button.type = 'button';
    button.classList.toggle('current', collection.isCurrent);
    button.disabled = collection.liveGroupCount === 0 && collection.snapshotGroupCount === 0;
    const label = createNode('span', 'collection-link-label', collection.name);
    button.appendChild(label);
    if (collection.liveGroupCount === 0 && collection.snapshotGroupCount > 0) {
      const chevron = createNode('span', 'collection-link-chevron');
      chevron.appendChild(createIcon(openChoiceCollectionId === collection.id ? 'chevronDown' : 'chevronRight'));
      button.appendChild(chevron);
    }
    button.addEventListener('click', async () => {
      try {
        clearError();
        if (collection.liveGroupCount === 0 && collection.snapshotGroupCount > 0) {
          openChoiceCollectionId = openChoiceCollectionId === collection.id ? null : collection.id;
          renderSnapshot(lastSnapshot, lastWindowId);
          return;
        }
        await handleCollectionClick(collection, currentWindowId);
      } catch (error) {
        showError(error.message || 'Unable to open collection.');
      }
    });
    item.appendChild(button);

    if (collection.liveGroupCount === 0 && collection.snapshotGroupCount > 0) {
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

function renderSnapshot(snapshot, currentWindowId) {
  clearError();
  lastSnapshot = snapshot;
  lastWindowId = currentWindowId;
  sectionsNode.replaceChildren();

  const visibleCollections = snapshot.collections.filter((collection) => (
    !collection.isUncategorized &&
    (collection.liveGroupCount > 0 || collection.snapshotGroupCount > 0)
  ));

  if (!visibleCollections.length) {
    emptyNode.textContent = 'No collections to open yet.';
    emptyNode.classList.remove('hidden');
    return;
  }

  emptyNode.classList.add('hidden');
  const pinnedCollections = visibleCollections
    .filter((collection) => collection.isPinned)
    .sort(compareCollections);
  const otherCollections = visibleCollections
    .filter((collection) => !collection.isPinned)
    .sort(compareCollections);

  if (pinnedCollections.length) {
    sectionsNode.appendChild(renderSection('Pinned', pinnedCollections, currentWindowId));
  }
  if (otherCollections.length) {
    sectionsNode.appendChild(renderSection('Collections', otherCollections, currentWindowId));
  }
}

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
