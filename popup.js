const errorNode = document.getElementById('popup-error');
const emptyNode = document.getElementById('popup-empty');
const sectionsNode = document.getElementById('popup-sections');
const openPanelButtonNode = document.getElementById('open-panel-button');

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

function getCollectionSortValue(collection) {
  return collection.lastActiveAt || collection.snapshotUpdatedAt || 0;
}

function compareCollections(left, right) {
  return (
    getCollectionSortValue(right) - getCollectionSortValue(left) ||
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );
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

async function openSidebarFromPopup() {
  if (typeof browser.sidebarAction?.open === 'function') {
    await browser.sidebarAction.open();
    return;
  }

  if (typeof browser.sidebarAction?.toggle === 'function') {
    await browser.sidebarAction.toggle();
    return;
  }

  throw new Error('Sidebar API is unavailable.');
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
      button.appendChild(createNode(
        'span',
        'collection-link-chevron',
        openChoiceCollectionId === collection.id ? '⌄' : '›'
      ));
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

openPanelButtonNode.addEventListener('click', async () => {
  try {
    clearError();
    await openSidebarFromPopup();
    window.close();
  } catch (error) {
    showError(error.message || 'Unable to open panel.');
  }
});

(async () => {
  try {
    const currentWindowId = await getCurrentWindowId();
    const snapshot = await sendMessage({
      type: 'sidebar:getSnapshot',
      currentWindowId
    });
    renderSnapshot(snapshot, currentWindowId);
  } catch (error) {
    showError(error.message || 'Unable to load collections.');
  }
})();
