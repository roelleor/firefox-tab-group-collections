const STORAGE_KEY = 'tab-group-collections.state';
const COLLAPSE_STORAGE_KEY = 'tab-group-collections.sidebar-collapsed';
const SORT_STORAGE_KEY = 'tab-group-collections.sidebar-sort';
const NEW_COLLECTION_OPTION = '__new_collection__';
const GROUP_COLOR_MAP = {
  blue: '#4c8df6',
  cyan: '#44b8d2',
  green: '#52a56c',
  grey: '#8c9097',
  orange: '#dd8b47',
  pink: '#d7689a',
  purple: '#8b68d5',
  red: '#d1605a',
  yellow: '#d3b244'
};

const filterInputNode = document.getElementById('filter-input');
const filterStateNode = document.getElementById('filter-state');
const filterStateTextNode = document.getElementById('filter-state-text');
const clearFilterButtonNode = document.getElementById('clear-filter-button');
const sortSelectNode = document.getElementById('sort-select');
const createCollectionButtonNode = document.getElementById('create-collection-button');
const openAllButtonNode = document.getElementById('open-all-button');
const closeAllButtonNode = document.getElementById('close-all-button');
const statusNode = document.getElementById('status');
const errorBannerNode = document.getElementById('error-banner');
const collectionsNode = document.getElementById('collections');

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto'
});

let currentWindowId = null;
let lastSnapshot = null;
let openCollectionMenuId = null;
let openMovePanelKey = null;
let openDeleteMenuId = null;
let refreshTimerId = null;
let dragState = null;
let dragSourceNode = null;
let activeDropIndicator = null;

const uiState = {
  filterText: '',
  sortMode: loadSortMode(),
  collapsedCollections: loadCollapsedCollections()
};

sortSelectNode.value = uiState.sortMode;

function loadCollapsedCollections() {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveCollapsedCollections() {
  window.localStorage.setItem(
    COLLAPSE_STORAGE_KEY,
    JSON.stringify(uiState.collapsedCollections)
  );
}

function loadSortMode() {
  const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
  return raw === 'name' ? 'name' : 'last-active';
}

function saveSortMode() {
  window.localStorage.setItem(SORT_STORAGE_KEY, uiState.sortMode);
}

function setBusyState(isBusy, message = '') {
  document.body.classList.toggle('is-busy', isBusy);
  statusNode.textContent = isBusy ? message : (statusNode.dataset.summary || '');
}

function showError(message) {
  errorBannerNode.textContent = message;
  errorBannerNode.classList.remove('hidden');
}

function clearError() {
  errorBannerNode.textContent = '';
  errorBannerNode.classList.add('hidden');
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

async function ensureCurrentWindowId() {
  if (currentWindowId !== null) {
    return currentWindowId;
  }

  const tabs = await browser.tabs.query({ currentWindow: true });
  if (!tabs.length) {
    throw new Error('No browser window tabs were found.');
  }

  currentWindowId = tabs[0].windowId;
  return currentWindowId;
}

async function sendMessage(payload) {
  const response = await browser.runtime.sendMessage(payload);
  if (response?.error) {
    throw new Error(response.error);
  }

  return response;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return 'never active';
  }

  const diff = timestamp - Date.now();
  const absolute = Math.abs(diff);

  if (absolute < 60_000) {
    return 'just now';
  }

  const units = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000]
  ];

  for (const [unit, size] of units) {
    if (absolute >= size) {
      return relativeTimeFormatter.format(Math.round(diff / size), unit);
    }
  }

  return 'just now';
}

function getCollectionPreview(collection) {
  return collection.groups
    .map((group) => group.title)
    .filter(Boolean)
    .slice(0, 4)
    .join(' • ');
}

function buildSummaryText(snapshot, visibleCollections) {
  if (!snapshot.totalCollectionCount) {
    return 'No collections yet.';
  }

  const totalGroupCount = Number.isFinite(snapshot.totalGroupCount)
    ? snapshot.totalGroupCount
    : snapshot.collections.reduce((count, collection) => count + collection.groups.length, 0);
  const collectionLabel = snapshot.totalCollectionCount === 1 ? 'collection' : 'collections';
  const groupLabel = totalGroupCount === 1 ? 'group' : 'groups';

  if (visibleCollections === 0) {
    return `${snapshot.totalCollectionCount} ${collectionLabel}, ${totalGroupCount} ${groupLabel}.`;
  }

  return `${snapshot.totalCollectionCount} ${collectionLabel}, ${totalGroupCount} ${groupLabel}.`;
}

function getCollectionSortValue(collection) {
  return collection.lastActiveAt || collection.snapshotUpdatedAt || 0;
}

function compareCollections(left, right, sortMode = uiState.sortMode) {
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1;
  }

  if (sortMode === 'name') {
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  return (
    getCollectionSortValue(right) - getCollectionSortValue(left) ||
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );
}

function matchesFilter(collection, normalizedFilter) {
  if (!normalizedFilter) {
    return true;
  }

  if (collection.name.toLowerCase().includes(normalizedFilter)) {
    return true;
  }

  return collection.groups.some((group) => group.title.toLowerCase().includes(normalizedFilter));
}

function getVisibleGroups(collection, normalizedFilter) {
  if (!normalizedFilter) {
    return collection.groups;
  }

  return collection.groups.filter((group) => (
    collection.name.toLowerCase().includes(normalizedFilter) ||
    group.title.toLowerCase().includes(normalizedFilter)
  ));
}

function getFilteredCollections(snapshot) {
  const normalizedFilter = uiState.filterText.trim().toLowerCase();
  const collections = snapshot.collections
    .filter((collection) => matchesFilter(collection, normalizedFilter))
    .map((collection) => ({
      ...collection,
      visibleGroups: getVisibleGroups(collection, normalizedFilter)
    }));

  collections.sort((left, right) => compareCollections(left, right));

  return collections;
}

function isCollectionCollapsed(collectionId, filterActive) {
  if (filterActive) {
    return false;
  }

  return uiState.collapsedCollections[collectionId] === true;
}

function setCollectionCollapsed(collectionId, isCollapsed) {
  uiState.collapsedCollections[collectionId] = isCollapsed;
  saveCollapsedCollections();
  renderSnapshot(lastSnapshot);
}

function toggleCollectionCollapsed(collectionId) {
  const currentlyCollapsed = isCollectionCollapsed(collectionId, false);
  setCollectionCollapsed(collectionId, !currentlyCollapsed);
}

function setAllCollectionsCollapsed(isCollapsed) {
  if (!lastSnapshot) {
    return;
  }

  const nextState = {};
  for (const collection of lastSnapshot.collections) {
    nextState[collection.id] = isCollapsed;
  }
  uiState.collapsedCollections = nextState;
  saveCollapsedCollections();
  renderSnapshot(lastSnapshot);
}

function buildCollectionOptions(selectedCollectionId, availableCollections) {
  const fragment = document.createDocumentFragment();

  const sortedCollections = [...availableCollections].sort((left, right) => compareCollections(left, right));

  for (const collection of sortedCollections) {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = collection.name;
    option.selected = collection.id === selectedCollectionId;
    fragment.appendChild(option);
  }

  const newOption = document.createElement('option');
  newOption.value = NEW_COLLECTION_OPTION;
  newOption.textContent = 'New collection';
  fragment.appendChild(newOption);

  return fragment;
}

function buildGroupMeta(group) {
  const parts = [`${group.tabCount} ${group.tabCount === 1 ? 'tab' : 'tabs'}`];
  parts.push(group.locationLabel);
  return parts.join(' • ');
}

function resetNewCollectionOption(moveSelect) {
  const newOption = moveSelect.querySelector(`option[value="${NEW_COLLECTION_OPTION}"]`);
  if (newOption) {
    newOption.textContent = 'New collection';
  }
  delete moveSelect.dataset.newCollectionName;
}

function promptForNewCollectionName(moveSelect, fallbackValue) {
  const currentValue = moveSelect.dataset.newCollectionName || '';
  const nextName = window.prompt('New collection name', currentValue);
  if (nextName === null) {
    moveSelect.value = fallbackValue;
    resetNewCollectionOption(moveSelect);
    return false;
  }

  const trimmedName = nextName.trim();
  if (!trimmedName) {
    moveSelect.value = fallbackValue;
    resetNewCollectionOption(moveSelect);
    showError('Collection names cannot be empty.');
    return false;
  }

  const newOption = moveSelect.querySelector(`option[value="${NEW_COLLECTION_OPTION}"]`);
  if (newOption) {
    newOption.textContent = `New collection: ${trimmedName}`;
  }
  moveSelect.dataset.newCollectionName = trimmedName;
  return true;
}

function clearDropIndicator() {
  if (!activeDropIndicator) {
    return;
  }

  activeDropIndicator.node.classList.remove(activeDropIndicator.className);
  activeDropIndicator = null;
}

function setDropIndicator(node, className) {
  if (
    activeDropIndicator &&
    activeDropIndicator.node === node &&
    activeDropIndicator.className === className
  ) {
    return;
  }

  clearDropIndicator();
  node.classList.add(className);
  activeDropIndicator = { node, className };
}

function clearDragState() {
  clearDropIndicator();

  if (dragSourceNode) {
    dragSourceNode.classList.remove('drag-source');
    dragSourceNode = null;
  }

  dragState = null;
  document.body.classList.remove('is-dragging');
}

function startGroupDrag(event, group, collectionId, row) {
  dragState = {
    kind: group.kind,
    groupId: group.runtimeGroupId || null,
    snapshotGroupId: group.snapshotGroupId || null,
    sourceCollectionId: collectionId
  };
  dragSourceNode = row;
  row.classList.add('drag-source');
  document.body.classList.add('is-dragging');
  openMovePanelKey = null;
  openCollectionMenuId = null;
  openDeleteMenuId = null;

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(
      group.runtimeGroupId || group.snapshotGroupId || group.key
    ));
  }
}

function acceptGroupDrag(event) {
  if (!dragState) {
    return false;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  return true;
}

function getRowDropPosition(event, row) {
  const rect = row.getBoundingClientRect();
  return event.clientY < rect.top + (rect.height / 2) ? 'before' : 'after';
}

async function performGroupDrop(dropPayload, message) {
  const sourceDragState = dragState;
  clearDragState();

  if (!sourceDragState) {
    return;
  }

  await runAction(message, async () => {
    const snapshot = await sendMessage({
      type: 'sidebar:dropGroup',
      currentWindowId,
      sourceKind: sourceDragState.kind,
      sourceCollectionId: sourceDragState.sourceCollectionId,
      groupId: sourceDragState.groupId,
      snapshotGroupId: sourceDragState.snapshotGroupId,
      targetCollectionId: dropPayload.targetCollectionId,
      targetGroupId: dropPayload.targetGroupId,
      targetSnapshotGroupId: dropPayload.targetSnapshotGroupId,
      position: dropPayload.position
    });
    renderSnapshot(snapshot);
  });
}

function attachCollectionDropTarget(node, card, collection) {
  node.addEventListener('dragover', (event) => {
    if (!acceptGroupDrag(event)) {
      return;
    }

    if (event.target.closest('.group-row')) {
      return;
    }

    event.stopPropagation();
    setDropIndicator(card, 'drop-append');
  });

  node.addEventListener('drop', async (event) => {
    if (!acceptGroupDrag(event)) {
      return;
    }

    if (event.target.closest('.group-row')) {
      return;
    }

    event.stopPropagation();
    await performGroupDrop({
      targetCollectionId: collection.id,
      targetGroupId: null,
      targetSnapshotGroupId: null,
      position: 'append'
    }, dragState.kind === 'snapshot' ? 'Moving saved group…' : 'Moving tab group…');
  });
}

function attachGroupDropTarget(row, group, collection) {
  row.addEventListener('dragover', (event) => {
    if (!acceptGroupDrag(event)) {
      return;
    }

    if (
      (dragState.kind === 'live' && group.kind !== 'live') ||
      (dragState.kind === 'live' && dragState.groupId === group.runtimeGroupId) ||
      (dragState.kind === 'snapshot' && dragState.snapshotGroupId === group.snapshotGroupId)
    ) {
      event.stopPropagation();
      clearDropIndicator();
      return;
    }

    event.stopPropagation();
    const position = getRowDropPosition(event, row);
    setDropIndicator(row, position === 'before' ? 'drop-before' : 'drop-after');
  });

  row.addEventListener('drop', async (event) => {
    if (!acceptGroupDrag(event)) {
      return;
    }

    if (
      (dragState.kind === 'live' && group.kind !== 'live') ||
      (dragState.kind === 'live' && dragState.groupId === group.runtimeGroupId) ||
      (dragState.kind === 'snapshot' && dragState.snapshotGroupId === group.snapshotGroupId)
    ) {
      event.stopPropagation();
      return;
    }

    event.stopPropagation();
    const position = getRowDropPosition(event, row);
    const targetPayload = group.kind === 'live'
      ? {
        targetCollectionId: collection.id,
        targetGroupId: group.runtimeGroupId,
        targetSnapshotGroupId: null,
        position
      }
      : {
        targetCollectionId: collection.id,
        targetGroupId: null,
        targetSnapshotGroupId: group.snapshotGroupId,
        position
      };
    await performGroupDrop({
      ...targetPayload
    }, dragState.kind === 'snapshot' ? 'Moving saved group…' : 'Moving tab group…');
  });
}

function createGroupContent(group) {
  const wrapper = createNode('div', 'group-content');
  const heading = createNode('div', 'group-heading');
  const titleBar = createNode('div', 'group-title-bar');
  const groupButton = createNode('button', 'group-button');
  groupButton.type = 'button';
  groupButton.addEventListener('click', async () => {
    if (group.kind === 'live') {
      await runAction('Switching to tab group…', async () => {
        await sendMessage({
          type: 'sidebar:activateGroup',
          groupId: group.runtimeGroupId
        });
      });
      return;
    }

    await runAction('Opening tab group…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:openGroup',
        currentWindowId,
        collectionId: group.collectionId,
        snapshotGroupId: group.snapshotGroupId
      });
      renderSnapshot(snapshot);
    });
  });

  const titleRow = createNode('div', 'group-title-row');
  const dot = createNode('span', 'group-dot');
  dot.style.backgroundColor = GROUP_COLOR_MAP[group.color] || '#8c9097';
  titleRow.appendChild(dot);
  titleRow.appendChild(createNode('span', 'group-title', group.title));
  groupButton.appendChild(titleRow);
  titleBar.appendChild(groupButton);

  const renameButton = createNode('button', 'inline-icon-button', '✎');
  renameButton.type = 'button';
  renameButton.title = `Rename "${group.title}"`;
  renameButton.addEventListener('click', async () => {
    const nextTitle = window.prompt('Rename tab group', group.title);
    if (nextTitle === null) {
      return;
    }

    await runAction('Renaming tab group…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:renameGroup',
        currentWindowId,
        sourceKind: group.kind,
        groupId: group.runtimeGroupId || null,
        snapshotGroupId: group.snapshotGroupId,
        collectionId: group.collectionId,
        title: nextTitle
      });
      renderSnapshot(snapshot);
    });
  });
  titleBar.appendChild(renameButton);
  heading.appendChild(titleBar);

  wrapper.appendChild(heading);
  wrapper.appendChild(createNode('div', 'group-meta', buildGroupMeta(group)));

  return wrapper;
}

function renderGroup(group, collectionId, availableCollections) {
  const row = createNode('article', 'group-row');
  const main = createNode('div', 'group-main');
  main.appendChild(createGroupContent({
    ...group,
    collectionId
  }));
  const tools = createNode('div', 'group-tools');

  if (group.kind === 'live' || group.kind === 'snapshot') {
    const dragHandle = createNode('button', 'drag-handle', '⋮⋮');
    dragHandle.type = 'button';
    dragHandle.title = `Drag "${group.title}" to reorder or move`;
    dragHandle.draggable = true;
    dragHandle.addEventListener('dragstart', (event) => {
      startGroupDrag(event, group, collectionId, row);
    });
    dragHandle.addEventListener('dragend', () => {
      clearDragState();
    });
    tools.appendChild(dragHandle);
  }

  if (group.canMove) {
    const moveButton = createNode('button', 'move-button', '↔');
    moveButton.type = 'button';
    moveButton.title = `Move "${group.title}" to another collection`;
    moveButton.addEventListener('click', () => {
      openMovePanelKey = openMovePanelKey === group.key ? null : group.key;
      openDeleteMenuId = null;
      renderSnapshot(lastSnapshot);
    });
    tools.appendChild(moveButton);
  }

  const deleteButton = createNode('button', 'move-button danger-button group-delete-button', '×');
  deleteButton.type = 'button';
  deleteButton.title = group.kind === 'live'
    ? `Delete "${group.title}" and its tabs`
    : `Delete saved group "${group.title}"`;
  deleteButton.addEventListener('click', async () => {
    const confirmed = window.confirm(
      group.kind === 'live'
        ? `Delete the tab group "${group.title}" and all of its tabs?`
        : `Delete the saved group "${group.title}"?`
    );
    if (!confirmed) {
      return;
    }

    await runAction(group.kind === 'live' ? 'Deleting tab group…' : 'Deleting saved group…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:deleteGroup',
        currentWindowId,
        sourceKind: group.kind,
        groupId: group.runtimeGroupId || null,
        snapshotGroupId: group.snapshotGroupId || null,
        collectionId
      });
      openMovePanelKey = null;
      renderSnapshot(snapshot);
    });
  });
  tools.appendChild(deleteButton);

  attachGroupDropTarget(row, group, {
    id: collectionId
  });

  if (tools.childElementCount) {
    main.appendChild(tools);
  }

  row.appendChild(main);

  if (group.canMove) {
    const movePanel = createNode('div', 'move-panel');
    movePanel.classList.toggle('hidden', openMovePanelKey !== group.key);

    const moveSelect = createNode('select', 'move-select');
    moveSelect.appendChild(buildCollectionOptions(collectionId, availableCollections));
    moveSelect.addEventListener('change', () => {
      if (moveSelect.value === NEW_COLLECTION_OPTION) {
        promptForNewCollectionName(moveSelect, collectionId);
        return;
      }

      resetNewCollectionOption(moveSelect);
    });
    movePanel.appendChild(moveSelect);

    const applyButton = createNode('button', 'action-button', 'Move');
    applyButton.type = 'button';
    applyButton.addEventListener('click', async () => {
      const isNewCollection = moveSelect.value === NEW_COLLECTION_OPTION;
      const targetCollectionId = isNewCollection
        ? null
        : moveSelect.value;

      if (isNewCollection && !moveSelect.dataset.newCollectionName) {
        const accepted = promptForNewCollectionName(moveSelect, collectionId);
        if (!accepted) {
          return;
        }
      }

      const targetCollectionName = isNewCollection
        ? (moveSelect.dataset.newCollectionName || null)
        : null;

      if (targetCollectionId === collectionId && !targetCollectionName) {
        openMovePanelKey = null;
        renderSnapshot(lastSnapshot);
        return;
      }

      await runAction(group.kind === 'snapshot' ? 'Moving saved group…' : 'Moving group…', async () => {
        const snapshot = await sendMessage(group.kind === 'snapshot'
          ? {
            type: 'sidebar:dropGroup',
            currentWindowId,
            sourceKind: 'snapshot',
            sourceCollectionId: collectionId,
            groupId: null,
            snapshotGroupId: group.snapshotGroupId,
            targetCollectionId,
            targetCollectionName,
            targetGroupId: null,
            targetSnapshotGroupId: null,
            position: 'append'
          }
          : {
            type: 'sidebar:moveGroupToCollection',
            currentWindowId,
            groupId: group.runtimeGroupId,
            collectionId: targetCollectionId,
            targetCollectionName
          });
        openMovePanelKey = null;
        renderSnapshot(snapshot);
      });
    });

    const cancelButton = createNode('button', 'action-button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
      openMovePanelKey = null;
      renderSnapshot(lastSnapshot);
    });

    movePanel.append(applyButton, cancelButton);
    row.appendChild(movePanel);
  }

  return row;
}

function renderCollection(collection, availableCollections, filterActive) {
  const card = createNode('section', 'collection-card');
  card.classList.toggle('current', collection.isCurrent);

  const header = createNode('div', 'collection-header');
  attachCollectionDropTarget(header, card, collection);
  const collapsed = isCollectionCollapsed(collection.id, filterActive);
  const content = createNode('div', 'collection-summary');
  const titleBar = createNode('div', 'collection-title-bar');
  const titleButton = createNode('button', 'collection-title-button');
  titleButton.type = 'button';
  titleButton.title = collapsed ? 'Expand collection' : 'Collapse collection';
  titleButton.addEventListener('click', () => {
    toggleCollectionCollapsed(collection.id);
  });
  titleButton.appendChild(createNode('h2', 'collection-title', collection.name));
  titleBar.appendChild(titleButton);

  if (!collapsed) {
    const renameCollectionButton = createNode('button', 'inline-icon-button', '✎');
    renameCollectionButton.type = 'button';
    renameCollectionButton.title = `Rename "${collection.name}"`;
    renameCollectionButton.addEventListener('click', async () => {
      const nextName = window.prompt('Rename collection', collection.name);
      if (nextName === null) {
        return;
      }

      await runAction('Renaming collection…', async () => {
        const snapshot = await sendMessage({
          type: 'sidebar:renameCollection',
          currentWindowId,
          collectionId: collection.id,
          name: nextName
        });
        openDeleteMenuId = null;
        renderSnapshot(snapshot);
      });
    });
    titleBar.appendChild(renameCollectionButton);
  }

  const badgeRow = createNode('div', 'collection-badges');
  if (collection.isPinned) {
    badgeRow.appendChild(createNode('span', 'badge', 'Pinned'));
  }
  if (collection.isCurrent) {
    badgeRow.appendChild(createNode('span', 'badge current', 'Current'));
  }
  if (badgeRow.childElementCount) {
    titleBar.appendChild(badgeRow);
  }

  content.appendChild(titleBar);

  const preview = getCollectionPreview(collection);
  if (preview) {
    content.appendChild(createNode('p', 'collection-preview', preview));
  }

  header.appendChild(content);

  const toggleButton = createNode('button', 'toggle-button', collapsed ? '›' : '⌄');
  toggleButton.type = 'button';
  toggleButton.title = collapsed ? 'Expand collection' : 'Collapse collection';
  toggleButton.addEventListener('click', () => {
    toggleCollectionCollapsed(collection.id);
  });
  header.appendChild(toggleButton);
  card.appendChild(header);

  const body = createNode('div', 'collection-body');
  body.classList.toggle('hidden', collapsed);
  attachCollectionDropTarget(body, card, collection);

  const actions = createNode('div', 'collection-actions');

  const openButton = createNode('button', 'action-button', 'Open');
  openButton.type = 'button';
  openButton.addEventListener('click', async () => {
    if (collection.liveGroupCount > 0 && collection.snapshotGroupCount > collection.liveGroupCount) {
      await runAction('Opening missing tab groups…', async () => {
        const snapshot = await sendMessage({
          type: 'sidebar:openCollection',
          currentWindowId,
          collectionId: collection.id,
          targetMode: 'append'
        });
        openCollectionMenuId = null;
        renderSnapshot(snapshot);
      });
      return;
    }

    if (collection.liveGroupCount > 0) {
      await runAction('Opening collection…', async () => {
        const snapshot = await sendMessage({
          type: 'sidebar:focusCollection',
          currentWindowId,
          collectionId: collection.id
        });
        openCollectionMenuId = null;
        renderSnapshot(snapshot);
      });
      return;
    }

    openCollectionMenuId = openCollectionMenuId === collection.id ? null : collection.id;
    openDeleteMenuId = null;
    renderSnapshot(lastSnapshot);
  });
  actions.appendChild(openButton);

  const newGroupButton = createNode('button', 'action-button', 'New Group');
  newGroupButton.type = 'button';
  newGroupButton.addEventListener('click', async () => {
    const nextTitle = window.prompt('New tab group name', '');
    if (nextTitle === null) {
      return;
    }

    await runAction('Creating tab group…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:createGroup',
        currentWindowId,
        collectionId: collection.id,
        title: nextTitle
      });
      renderSnapshot(snapshot);
    });
  });
  actions.appendChild(newGroupButton);

  const deleteButton = createNode('button', 'action-button', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => {
    openDeleteMenuId = openDeleteMenuId === collection.id ? null : collection.id;
    openCollectionMenuId = null;
    renderSnapshot(lastSnapshot);
  });
  actions.appendChild(deleteButton);

  const pinButton = createNode('button', 'action-button', collection.isPinned ? 'Unpin' : 'Pin');
  pinButton.type = 'button';
  pinButton.addEventListener('click', async () => {
    await runAction(collection.isPinned ? 'Unpinning collection…' : 'Pinning collection…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:setCollectionPinned',
        currentWindowId,
        collectionId: collection.id,
        pinned: !collection.isPinned
      });
      renderSnapshot(snapshot);
    });
  });
  actions.appendChild(pinButton);

  body.appendChild(actions);

  const openMenu = createNode('div', 'open-menu');
  openMenu.classList.toggle('hidden', collection.liveGroupCount > 0 || openCollectionMenuId !== collection.id);

  const newWindowButton = createNode('button', 'action-button', 'New Window');
  newWindowButton.type = 'button';
  newWindowButton.disabled = !collection.snapshotGroupCount;
  newWindowButton.addEventListener('click', async () => {
    await runAction('Opening collection in a new window…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:openCollection',
        currentWindowId,
        collectionId: collection.id,
        targetMode: 'new-window'
      });
      openCollectionMenuId = null;
      renderSnapshot(snapshot);
    });
  });

  const appendButton = createNode('button', 'action-button', 'Current Window');
  appendButton.type = 'button';
  appendButton.disabled = !collection.snapshotGroupCount;
  appendButton.addEventListener('click', async () => {
    await runAction('Opening collection in the current window…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:openCollection',
        currentWindowId,
        collectionId: collection.id,
        targetMode: 'append'
      });
      openCollectionMenuId = null;
      renderSnapshot(snapshot);
    });
  });

  openMenu.append(newWindowButton, appendButton);
  body.appendChild(openMenu);

  const deleteMenu = createNode('div', 'delete-menu');
  deleteMenu.classList.toggle('hidden', openDeleteMenuId !== collection.id);

  const deleteOnlyButton = createNode('button', 'action-button', 'Delete Collection Only');
  deleteOnlyButton.type = 'button';
  deleteOnlyButton.addEventListener('click', async () => {
    const confirmed = window.confirm(
      'Delete this collection only? Its groups will be kept.'
    );
    if (!confirmed) {
      return;
    }

    await runAction('Deleting collection…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:deleteCollection',
        currentWindowId,
        collectionId: collection.id,
        mode: 'collection-only'
      });
      openDeleteMenuId = null;
      renderSnapshot(snapshot);
    });
  });

  const deleteGroupsButton = createNode('button', 'action-button danger-button', 'Delete Collection + Groups');
  deleteGroupsButton.type = 'button';
  deleteGroupsButton.addEventListener('click', async () => {
    await runAction('Deleting collection and groups…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:deleteCollection',
        currentWindowId,
        collectionId: collection.id,
        mode: 'collection-and-groups'
      });
      openDeleteMenuId = null;
      renderSnapshot(snapshot);
    });
  });

  const cancelDeleteButton = createNode('button', 'action-button', 'Cancel');
  cancelDeleteButton.type = 'button';
  cancelDeleteButton.addEventListener('click', () => {
    openDeleteMenuId = null;
    renderSnapshot(lastSnapshot);
  });

  deleteMenu.append(deleteOnlyButton);
  if (collection.liveGroupCount || collection.snapshotGroupCount) {
    deleteMenu.append(deleteGroupsButton);
  }
  deleteMenu.append(cancelDeleteButton);
  body.appendChild(deleteMenu);

  const groupList = createNode('div', 'group-list');
  for (const group of collection.visibleGroups) {
    groupList.appendChild(renderGroup(group, collection.id, availableCollections));
  }

  body.appendChild(groupList);
  card.appendChild(body);

  return card;
}

function renderEmptyState(message) {
  const node = createNode('section', 'empty-state');
  node.textContent = message;
  return node;
}

function renderSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  if (snapshot.createdCollectionId) {
    uiState.collapsedCollections[snapshot.createdCollectionId] = false;
    saveCollapsedCollections();
  }

  lastSnapshot = snapshot;
  clearError();

  const visibleCollections = getFilteredCollections(snapshot);
  const filterActive = uiState.filterText.trim().length > 0;
  statusNode.dataset.summary = buildSummaryText(snapshot, visibleCollections.length);
  statusNode.textContent = statusNode.dataset.summary;
  document.body.classList.toggle('has-filter', filterActive);
  filterStateNode.classList.toggle('hidden', !filterActive);
  filterStateTextNode.textContent = filterActive
    ? `Filtering by "${uiState.filterText.trim()}"`
    : '';
  collectionsNode.replaceChildren();

  if (!snapshot.collections.length) {
    collectionsNode.appendChild(renderEmptyState(
      'Create or save a tab group, then use the sidebar to cluster groups into collections.'
    ));
    return;
  }

  if (!visibleCollections.length) {
    collectionsNode.appendChild(renderEmptyState(
      `No collections or group names match "${uiState.filterText.trim()}".`
    ));
    return;
  }

  for (const collection of visibleCollections) {
    collectionsNode.appendChild(renderCollection(
      collection,
      snapshot.availableCollections,
      filterActive
    ));
  }
}

async function runAction(message, task) {
  clearError();
  setBusyState(true, message);

  try {
    await task();
  } catch (error) {
    showError(error.message || 'Something went wrong.');
  } finally {
    setBusyState(false, '');
  }
}

async function requestSnapshot() {
  currentWindowId = await ensureCurrentWindowId();
  return sendMessage({
    type: 'sidebar:getSnapshot',
    currentWindowId
  });
}

async function refreshSnapshot(message = 'Syncing collections…', silent = false) {
  if (silent) {
    try {
      const snapshot = await requestSnapshot();
      renderSnapshot(snapshot);
    } catch (error) {
      showError(error.message || 'Unable to refresh collections.');
    }
    return;
  }

  await runAction(message, async () => {
    const snapshot = await requestSnapshot();
    renderSnapshot(snapshot);
  });
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimerId);
  refreshTimerId = window.setTimeout(() => {
    refreshTimerId = null;
    refreshSnapshot('', true).catch((error) => {
      showError(error.message || 'Unable to refresh collections.');
    });
  }, 160);
}

function addLiveRefreshListeners() {
  browser.tabs.onActivated.addListener(scheduleRefresh);
  browser.tabs.onAttached.addListener(scheduleRefresh);
  browser.tabs.onCreated.addListener(scheduleRefresh);
  browser.tabs.onDetached.addListener(scheduleRefresh);
  browser.tabs.onMoved.addListener(scheduleRefresh);
  browser.tabs.onRemoved.addListener(scheduleRefresh);
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (
      Object.prototype.hasOwnProperty.call(changeInfo, 'groupId') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'url') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'status')
    ) {
      scheduleRefresh();
    }
  });

  if (browser.tabGroups) {
    browser.tabGroups.onCreated.addListener(scheduleRefresh);
    browser.tabGroups.onMoved.addListener(scheduleRefresh);
    browser.tabGroups.onRemoved.addListener(scheduleRefresh);
    browser.tabGroups.onUpdated.addListener(scheduleRefresh);
  }

  browser.windows.onFocusChanged.addListener(scheduleRefresh);
}

addLiveRefreshListeners();

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
    return;
  }

  scheduleRefresh();
});

refreshSnapshot().catch((error) => {
  showError(error.message || 'Unable to load tab group collections.');
});

filterInputNode.addEventListener('input', () => {
  uiState.filterText = filterInputNode.value;
  renderSnapshot(lastSnapshot);
});

clearFilterButtonNode.addEventListener('click', () => {
  uiState.filterText = '';
  filterInputNode.value = '';
  renderSnapshot(lastSnapshot);
});

openAllButtonNode.addEventListener('click', () => {
  setAllCollectionsCollapsed(false);
});

closeAllButtonNode.addEventListener('click', () => {
  setAllCollectionsCollapsed(true);
});

sortSelectNode.addEventListener('change', () => {
  uiState.sortMode = sortSelectNode.value === 'name' ? 'name' : 'last-active';
  saveSortMode();
  renderSnapshot(lastSnapshot);
});

createCollectionButtonNode.addEventListener('click', async () => {
  await runAction('Creating collection…', async () => {
    const snapshot = await sendMessage({
      type: 'sidebar:createCollection',
      currentWindowId
    });
    openCollectionMenuId = null;
    openDeleteMenuId = null;
    renderSnapshot(snapshot);
  });
});
