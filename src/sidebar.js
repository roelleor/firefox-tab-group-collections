const STORAGE_KEY = 'tab-group-collections.state';
const COLLAPSE_STORAGE_KEY = 'tab-group-collections.sidebar-collapsed';
const SORT_STORAGE_KEY = 'tab-group-collections.sidebar-sort';
const NEW_COLLECTION_OPTION = '__new_collection__';
const Shared = globalThis.TabGroupCollectionsShared;
const UiTheme = globalThis.TabGroupCollectionsUiTheme;
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
const GROUP_COLOR_SEQUENCE = Shared.GROUP_COLOR_SEQUENCE;

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
let openGroupDeleteMenuKey = null;
let openColorMenuKey = null;
let refreshTimerId = null;
let dragState = null;
let dragSourceNode = null;
let activeDropIndicator = null;
let sidebarKeyboard = null;

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

const ICON_PATHS = {
  pencil: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4'
  ],
  chevronRight: [
    'm9 18 6-6-6-6'
  ],
  chevronDown: [
    'm6 9 6 6 6-6'
  ],
  pin: [
    'M12 17v5',
    'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
  ],
  pinOff: [
    'M12 17v5',
    'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89',
    'm2 2 20 20',
    'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11'
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

function compareCollections(left, right, sortMode = uiState.sortMode) {
  return Shared.compareCollections(left, right, {
    sortMode,
    placeUncategorizedLast: true
  });
}

function getFilteredCollections(snapshot) {
  return Shared.getFilteredCollections(snapshot, uiState.filterText, {
    sortMode: uiState.sortMode,
    placeUncategorizedLast: true
  });
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

/** Keep disclosures attached to a group across renames and live/saved transitions. */
function getGroupUiKey(group) {
  return group.snapshotGroupId || group.key;
}

function buildColorMenu(group) {
  const menu = createNode('div', 'group-color-menu');
  menu.classList.toggle('hidden', openColorMenuKey !== getGroupUiKey(group));

  for (const color of GROUP_COLOR_SEQUENCE) {
    const swatchButton = createNode('button', 'group-color-option');
    swatchButton.type = 'button';
    swatchButton.title = `Set color to ${color}`;
    swatchButton.setAttribute('aria-label', `Set color to ${color}`);
    swatchButton.setAttribute('aria-pressed', String(color === group.color));
    swatchButton.classList.toggle('selected', color === group.color);

    const swatch = createNode('span', 'group-color-option-swatch');
    swatch.style.backgroundColor = GROUP_COLOR_MAP[color];
    swatchButton.appendChild(swatch);

    swatchButton.addEventListener('click', async () => {
      if (color === group.color) {
        openColorMenuKey = null;
        renderSnapshot(lastSnapshot);
        return;
      }

      await runAction('Updating group color…', async () => {
        const snapshot = await sendMessage({
          type: 'sidebar:updateGroupColor',
          currentWindowId,
          sourceKind: group.kind,
          groupId: group.runtimeGroupId || null,
          snapshotGroupId: group.snapshotGroupId,
          collectionId: group.collectionId,
          color
        });
        openColorMenuKey = null;
        renderSnapshot(snapshot);
      });
    });

    menu.appendChild(swatchButton);
  }

  return menu;
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

function isGroupDragExcludedTarget(target) {
  return Boolean(target?.closest(
    '.inline-icon-button, .group-dot-button, .move-button, .group-delete-button, .group-color-option'
  ));
}

function startGroupDrag(event, group, collectionId, row) {
  if (isGroupDragExcludedTarget(event.target)) {
    event.preventDefault();
    return;
  }

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
  openGroupDeleteMenuKey = null;

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
  const dotButton = createNode('button', 'group-dot-button');
  dotButton.type = 'button';
  dotButton.title = `Change color for "${group.title}"`;
  dotButton.setAttribute('aria-label', `Change color for ${group.title}`);
  dotButton.addEventListener('click', () => {
    const groupKey = getGroupUiKey(group);
    openColorMenuKey = openColorMenuKey === groupKey ? null : groupKey;
    openMovePanelKey = null;
    openDeleteMenuId = null;
    openGroupDeleteMenuKey = null;
    renderSnapshot(lastSnapshot);
  });

  const dot = createNode('span', 'group-dot');
  dot.classList.add(group.kind === 'snapshot' ? 'group-dot-closed' : 'group-dot-live');
  dot.style.borderColor = GROUP_COLOR_MAP[group.color] || '#8c9097';
  if (group.kind !== 'snapshot') {
    dot.style.backgroundColor = GROUP_COLOR_MAP[group.color] || '#8c9097';
  }
  dotButton.appendChild(dot);
  titleBar.appendChild(dotButton);

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
  titleRow.appendChild(createNode('span', 'group-title', group.title));
  groupButton.appendChild(titleRow);
  titleBar.appendChild(groupButton);

  const renameButton = createNode('button', 'inline-icon-button');
  renameButton.type = 'button';
  renameButton.title = `Rename "${group.title}"`;
  renameButton.setAttribute('aria-label', `Rename "${group.title}"`);
  renameButton.appendChild(createIcon('pencil'));
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
  wrapper.appendChild(buildColorMenu(group));

  return wrapper;
}

/** Render a group with a stable saved identity so keyboard focus can follow live/saved transitions. */
function renderGroup(group, collectionId, availableCollections) {
  const row = createNode('article', 'group-row');
  row.dataset.focusGroupId = getGroupUiKey(group);
  row.dataset.groupKey = group.key;
  const main = createNode('div', 'group-main');
  if (group.kind === 'live' || group.kind === 'snapshot') {
    main.draggable = true;
    main.addEventListener('dragstart', (event) => {
      startGroupDrag(event, group, collectionId, row);
    });
    main.addEventListener('dragend', () => {
      clearDragState();
    });
  }
  main.appendChild(createGroupContent({
    ...group,
    collectionId
  }));
  const tools = createNode('div', 'group-tools');

  if (group.kind === 'live' || group.kind === 'snapshot') {
    const dragHandle = createNode('button', 'drag-handle', '⋮⋮');
    dragHandle.type = 'button';
    dragHandle.title = `Drag "${group.title}" to reorder or move`;
    dragHandle.setAttribute('aria-label', `Move or reorder ${group.title}`);
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
    moveButton.setAttribute('aria-label', `Move ${group.title} to another collection`);
    moveButton.addEventListener('click', () => {
      const groupKey = getGroupUiKey(group);
      openMovePanelKey = openMovePanelKey === groupKey ? null : groupKey;
      openColorMenuKey = null;
      openDeleteMenuId = null;
      openGroupDeleteMenuKey = null;
      renderSnapshot(lastSnapshot);
    });
    tools.appendChild(moveButton);
  }

  const deleteButton = createNode('button', 'move-button danger-button group-delete-button', '×');
  deleteButton.type = 'button';
  deleteButton.dataset.focusRole = 'delete-group';
  deleteButton.title = `Delete options for "${group.title}"`;
  deleteButton.setAttribute('aria-label', `Delete options for ${group.title}`);
  deleteButton.addEventListener('click', () => {
    const groupKey = getGroupUiKey(group);
    openGroupDeleteMenuKey = openGroupDeleteMenuKey === groupKey ? null : groupKey;
    openColorMenuKey = null;
    openMovePanelKey = null;
    openDeleteMenuId = null;
    renderSnapshot(lastSnapshot);
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
    movePanel.classList.toggle('hidden', openMovePanelKey !== getGroupUiKey(group));

    const moveSelect = createNode('select', 'move-select');
    moveSelect.setAttribute('aria-label', `Move ${group.title} to collection`);
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
        openColorMenuKey = null;
        openMovePanelKey = null;
        openGroupDeleteMenuKey = null;
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
        openColorMenuKey = null;
        openMovePanelKey = null;
        openGroupDeleteMenuKey = null;
        renderSnapshot(snapshot);
      });
    });

    const cancelButton = createNode('button', 'action-button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', () => {
      openColorMenuKey = null;
      openMovePanelKey = null;
      openGroupDeleteMenuKey = null;
      renderSnapshot(lastSnapshot);
    });

    movePanel.append(applyButton, cancelButton);
    row.appendChild(movePanel);
  }

  const deleteMenu = createNode('div', 'delete-menu group-delete-menu');
  deleteMenu.classList.toggle('hidden', openGroupDeleteMenuKey !== getGroupUiKey(group));

  if (!Shared.isUncategorizedCollectionId(collectionId)) {
    const removeButton = createNode('button', 'action-button', 'Remove from Collection');
    removeButton.type = 'button';
    removeButton.addEventListener('click', async () => {
      await runAction('Removing group from collection…', async () => {
        const snapshot = await sendMessage({
          type: 'sidebar:removeGroupFromCollection',
          currentWindowId,
          sourceKind: group.kind,
          groupId: group.runtimeGroupId || null,
          snapshotGroupId: group.snapshotGroupId || null,
          collectionId
        });
        openColorMenuKey = null;
        openMovePanelKey = null;
        openGroupDeleteMenuKey = null;
        renderSnapshot(snapshot);
      });
    });
    deleteMenu.appendChild(removeButton);
  }

  const deleteForeverButton = createNode('button', 'action-button danger-button', 'Delete Group');
  deleteForeverButton.type = 'button';
  deleteForeverButton.addEventListener('click', async () => {
    const confirmed = window.confirm(
      group.kind === 'live'
        ? 'Delete this group and close its tabs?'
        : 'Delete this saved group and its tabs?'
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
      openColorMenuKey = null;
      openMovePanelKey = null;
      openGroupDeleteMenuKey = null;
      renderSnapshot(snapshot);
    });
  });
  deleteMenu.appendChild(deleteForeverButton);

  const cancelDeleteButton = createNode('button', 'action-button', 'Cancel');
  cancelDeleteButton.type = 'button';
  cancelDeleteButton.addEventListener('click', () => {
    openGroupDeleteMenuKey = null;
    renderSnapshot(lastSnapshot);
  });
  deleteMenu.appendChild(cancelDeleteButton);

  row.appendChild(deleteMenu);

  return row;
}

/** Keep collection actions unchanged while exposing native heading and disclosure controls. */
function renderCollection(collection, availableCollections, filterActive) {
  const totalGroupCount = collection.groups.length;
  const isFullyOpen = collection.liveGroupCount > 0 && collection.liveGroupCount === totalGroupCount;
  const isPartlyOpen = collection.liveGroupCount > 0 && collection.liveGroupCount < totalGroupCount;
  const hasLiveGroups = collection.liveGroupCount > 0;
  const card = createNode('section', 'collection-card');
  card.dataset.collectionId = collection.id;
  card.classList.toggle('is-open', isFullyOpen);
  card.classList.toggle('is-partly-open', isPartlyOpen);

  const header = createNode('div', 'collection-header');
  attachCollectionDropTarget(header, card, collection);
  const collapsed = isCollectionCollapsed(collection.id, filterActive);
  const content = createNode('div', 'collection-summary');
  content.title = collapsed ? 'Expand collection' : 'Collapse collection';
  content.addEventListener('click', () => {
    toggleCollectionCollapsed(collection.id);
  });
  const titleBar = createNode('div', 'collection-title-bar');
  const title = createNode('h2', 'collection-title');
  const titleButton = createNode('button', 'collection-title-button', collection.name);
  titleButton.type = 'button';
  title.appendChild(titleButton);
  titleBar.appendChild(title);

  if (!collapsed) {
    const renameCollectionButton = createNode('button', 'inline-icon-button');
    renameCollectionButton.type = 'button';
    renameCollectionButton.title = `Rename "${collection.name}"`;
    renameCollectionButton.setAttribute('aria-label', `Rename "${collection.name}"`);
    renameCollectionButton.appendChild(createIcon('pencil'));
    renameCollectionButton.addEventListener('click', async (event) => {
      event.stopPropagation();
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
        openGroupDeleteMenuKey = null;
        renderSnapshot(snapshot);
      });
    });
    if (!collection.isUncategorized) {
      titleBar.appendChild(renameCollectionButton);
    }
  }

  content.appendChild(titleBar);

  const preview = Shared.getCollectionPreview(collection);
  if (preview) {
    content.appendChild(createNode('p', 'collection-preview', preview));
  }

  header.appendChild(content);

  const headerControls = createNode('div', 'collection-header-controls');

  if (!collection.isUncategorized) {
    const pinButton = createNode('button', 'header-icon-button pin-toggle-button');
    pinButton.type = 'button';
    pinButton.title = collection.isPinned ? 'Unpin collection' : 'Pin collection';
    pinButton.setAttribute('aria-label', collection.isPinned ? 'Unpin collection' : 'Pin collection');
    pinButton.setAttribute('aria-pressed', String(collection.isPinned));
    pinButton.classList.toggle('is-active', collection.isPinned);
    pinButton.appendChild(createIcon(collection.isPinned ? 'pin' : 'pinOff'));
    pinButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await runAction(collection.isPinned ? 'Unpinning collection…' : 'Pinning collection…', async () => {
        const snapshot = await sendMessage({
          type: 'sidebar:setCollectionPinned',
          currentWindowId,
          collectionId: collection.id,
          pinned: !collection.isPinned
        });
        openGroupDeleteMenuKey = null;
        renderSnapshot(snapshot);
      });
    });
    headerControls.appendChild(pinButton);
  }

  const toggleButton = createNode('button', 'toggle-button');
  toggleButton.type = 'button';
  toggleButton.title = collapsed ? 'Expand collection' : 'Collapse collection';
  toggleButton.setAttribute('aria-label', collapsed ? 'Expand collection' : 'Collapse collection');
  toggleButton.appendChild(createIcon(collapsed ? 'chevronRight' : 'chevronDown'));
  toggleButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleCollectionCollapsed(collection.id);
  });
  headerControls.appendChild(toggleButton);
  header.appendChild(headerControls);
  card.appendChild(header);

  const body = createNode('div', 'collection-body');
  body.classList.toggle('hidden', collapsed);
  attachCollectionDropTarget(body, card, collection);

  const actions = createNode('div', 'collection-actions');

  if (!collection.isUncategorized) {
    const opensDirectlyInCurrentWindow = canOpenSavedCollectionInCurrentWindow(collection);
    const openButton = createNode('button', 'action-button collection-open-button', isFullyOpen ? 'Go to' : 'Open');
    openButton.type = 'button';
    openButton.dataset.focusRole = 'open';
    openButton.disabled = !collection.liveGroupCount && !collection.snapshotGroupCount;
    if (!hasLiveGroups && collection.snapshotGroupCount && !opensDirectlyInCurrentWindow) {
      openButton.setAttribute('aria-expanded', String(openCollectionMenuId === collection.id));
    }
    openButton.addEventListener('click', async () => {
      if (isPartlyOpen) {
        await runAction('Opening missing tab groups…', async () => {
          const snapshot = await sendMessage({
            type: 'sidebar:openCollection',
            currentWindowId,
            collectionId: collection.id,
            targetMode: 'append'
          });
          openCollectionMenuId = null;
          openGroupDeleteMenuKey = null;
          renderSnapshot(snapshot);
        });
        return;
      }

      if (isFullyOpen) {
        await runAction('Going to collection…', async () => {
          const snapshot = await sendMessage({
            type: 'sidebar:focusCollection',
            currentWindowId,
            collectionId: collection.id
          });
          openCollectionMenuId = null;
          openGroupDeleteMenuKey = null;
          renderSnapshot(snapshot);
        });
        return;
      }

      if (opensDirectlyInCurrentWindow) {
        await runAction('Opening collection in the current window…', async () => {
          const snapshot = await sendMessage({
            type: 'sidebar:openCollection',
            currentWindowId,
            collectionId: collection.id,
            targetMode: 'append'
          });
          openCollectionMenuId = null;
          openGroupDeleteMenuKey = null;
          renderSnapshot(snapshot);
        });
        return;
      }

      openCollectionMenuId = openCollectionMenuId === collection.id ? null : collection.id;
      openDeleteMenuId = null;
      openGroupDeleteMenuKey = null;
      renderSnapshot(lastSnapshot);
    });
    actions.appendChild(openButton);

    if (hasLiveGroups) {
      const closeButton = createNode('button', 'action-button', 'Close');
      closeButton.type = 'button';
      closeButton.addEventListener('click', async () => {
        await runAction('Closing collection…', async () => {
          const snapshot = await sendMessage({
            type: 'sidebar:closeCollection',
            currentWindowId,
            collectionId: collection.id
          });
          openCollectionMenuId = null;
          openDeleteMenuId = null;
          openGroupDeleteMenuKey = null;
          renderSnapshot(snapshot);
        });
      });
      actions.appendChild(closeButton);
    }

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
        openGroupDeleteMenuKey = null;
        renderSnapshot(snapshot);
      });
    });
    actions.appendChild(newGroupButton);
  } else {
    const deleteAllGroupsButton = createNode('button', 'action-button danger-button', 'Delete All Groups');
    deleteAllGroupsButton.type = 'button';
    deleteAllGroupsButton.addEventListener('click', async () => {
      const confirmed = window.confirm(
        'Delete all groups in Uncategorized?'
      );
      if (!confirmed) {
        return;
      }

      await runAction('Deleting all uncategorized groups…', async () => {
        const snapshot = await sendMessage({
          type: 'sidebar:deleteCollection',
          currentWindowId,
          collectionId: collection.id,
          mode: 'collection-and-groups'
        });
        openDeleteMenuId = null;
        openGroupDeleteMenuKey = null;
        renderSnapshot(snapshot);
      });
    });
    actions.appendChild(deleteAllGroupsButton);
  }

  if (!collection.isUncategorized) {
    const deleteButton = createNode('button', 'action-button collection-delete-button', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => {
      openDeleteMenuId = openDeleteMenuId === collection.id ? null : collection.id;
      openCollectionMenuId = null;
      openGroupDeleteMenuKey = null;
      renderSnapshot(lastSnapshot);
    });
    actions.appendChild(deleteButton);
  }

  body.appendChild(actions);

  const openMenu = createNode('div', 'open-menu');
  openMenu.classList.toggle(
    'hidden',
    hasLiveGroups || canOpenSavedCollectionInCurrentWindow(collection) || openCollectionMenuId !== collection.id
  );

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
      openGroupDeleteMenuKey = null;
      renderSnapshot(snapshot);
    });
  });

  const appendButton = createNode('button', 'action-button', 'Append Here');
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
      openGroupDeleteMenuKey = null;
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
      openGroupDeleteMenuKey = null;
      renderSnapshot(snapshot);
    });
  });

  const deleteGroupsButton = createNode('button', 'action-button danger-button', 'Delete Collection + Groups');
  deleteGroupsButton.type = 'button';
  deleteGroupsButton.addEventListener('click', async () => {
    const confirmed = window.confirm(
      `Delete the collection "${collection.name}" and all of its groups?`
    );
    if (!confirmed) {
      return;
    }

    await runAction('Deleting collection and groups…', async () => {
      const snapshot = await sendMessage({
        type: 'sidebar:deleteCollection',
        currentWindowId,
        collectionId: collection.id,
        mode: 'collection-and-groups'
      });
      openDeleteMenuId = null;
      openGroupDeleteMenuKey = null;
      renderSnapshot(snapshot);
    });
  });

  const cancelDeleteButton = createNode('button', 'action-button', 'Cancel');
  cancelDeleteButton.type = 'button';
  cancelDeleteButton.addEventListener('click', () => {
    openDeleteMenuId = null;
    openGroupDeleteMenuKey = null;
    renderSnapshot(lastSnapshot);
  });

  deleteMenu.append(deleteOnlyButton);
  if (collection.liveGroupCount || collection.snapshotGroupCount) {
    deleteMenu.append(deleteGroupsButton);
  }
  deleteMenu.append(cancelDeleteButton);
  if (!collection.isUncategorized) {
    body.appendChild(deleteMenu);
  }

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

function canOpenSavedCollectionInCurrentWindow(collection) {
  return Boolean(
    lastSnapshot?.currentWindowHasOnlyEmptyNewTab &&
    collection.liveGroupCount === 0 &&
    collection.snapshotGroupCount > 0
  );
}

function renderCollectionSection(title, collections, availableCollections, filterActive) {
  const section = createNode('section', 'collection-section');
  section.appendChild(createNode('h2', 'collection-section-title', title));

  const list = createNode('div', 'collection-section-list');
  for (const collection of collections) {
    list.appendChild(renderCollection(
      collection,
      availableCollections,
      filterActive
    ));
  }

  section.appendChild(list);
  return section;
}

/** Refresh the list while retaining keyboard focus and unfinished move destinations. */
function renderSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  const keyboardState = sidebarKeyboard?.capture();

  if (snapshot.createdCollectionId) {
    uiState.collapsedCollections[snapshot.createdCollectionId] = false;
    saveCollapsedCollections();
  }

  lastSnapshot = snapshot;
  clearError();

  const visibleCollections = getFilteredCollections(snapshot);
  const filterActive = uiState.filterText.trim().length > 0;
  statusNode.dataset.summary = Shared.buildSummaryText(snapshot);
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
    if (keyboardState) sidebarKeyboard.restore(keyboardState);
    return;
  }

  if (!visibleCollections.length) {
    collectionsNode.appendChild(renderEmptyState(
      `No collections or group names match "${uiState.filterText.trim()}".`
    ));
    if (keyboardState) sidebarKeyboard.restore(keyboardState);
    return;
  }

  const pinnedCollections = visibleCollections.filter((collection) => collection.isPinned && !collection.isUncategorized);
  const otherCollections = visibleCollections.filter((collection) => !collection.isPinned && !collection.isUncategorized);
  const uncategorizedCollections = visibleCollections.filter((collection) => collection.isUncategorized);

  if (pinnedCollections.length) {
    collectionsNode.appendChild(renderCollectionSection(
      'Pinned',
      pinnedCollections,
      snapshot.availableCollections,
      filterActive
    ));
  }

  if (otherCollections.length) {
    collectionsNode.appendChild(renderCollectionSection(
      'Collections',
      otherCollections,
      snapshot.availableCollections,
      filterActive
    ));
  }

  if (uncategorizedCollections.length) {
    collectionsNode.appendChild(renderCollectionSection(
      'Uncategorized',
      uncategorizedCollections,
      snapshot.availableCollections,
      filterActive
    ));
  }
  sidebarKeyboard?.enhance();
  if (keyboardState) sidebarKeyboard.restore(keyboardState);
}

/** Serialize user actions so held activation/reorder keys cannot submit overlapping mutations. */
async function runAction(message, task) {
  if (document.body.classList.contains('is-busy')) return;
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

/** Close only the requested disclosure, keeping the other sidebar UI state intact. */
function closeKeyboardPanel(panel) {
  if (panel.matches('.open-menu')) openCollectionMenuId = null;
  else if (panel.matches('.group-delete-menu')) openGroupDeleteMenuKey = null;
  else if (panel.matches('.delete-menu')) openDeleteMenuId = null;
  else if (panel.matches('.group-color-menu')) openColorMenuKey = null;
  else if (panel.matches('.move-panel')) openMovePanelKey = null;
  renderSnapshot(lastSnapshot);
}

/** Activate the first filtered collection through its normal Open/Go to handler. */
function activateKeyboardCollection(collectionId) {
  const findCard = () => Array.from(collectionsNode.querySelectorAll('.collection-card'))
    .find(card => card.dataset.collectionId === collectionId);
  let card = findCard();
  if (card.querySelector('.collection-body').classList.contains('hidden')) {
    setCollectionCollapsed(collectionId, false);
    card = findCard();
  }
  const button = card.querySelector('.collection-open-button:not(:disabled)') || card.querySelector('.collection-title-button');
  button.focus();
  if (button.matches('.collection-open-button')) button.click();
}

/** Reuse drag/drop placement to reorder a group against its actual neighboring saved/live group. */
async function reorderKeyboardGroup(row, offset) {
  const collectionId = row.closest('.collection-card').dataset.collectionId;
  const collection = lastSnapshot.collections.find(item => item.id === collectionId);
  const index = collection.groups.findIndex(group => group.key === row.dataset.groupKey);
  const group = collection.groups[index];
  const neighbor = collection.groups[index + offset];
  if (!group || !neighbor) return;
  await runAction('Reordering tab group…', async () => {
    const snapshot = await sendMessage({
      type: 'sidebar:dropGroup', currentWindowId,
      sourceKind: group.kind, sourceCollectionId: collectionId,
      groupId: group.runtimeGroupId || null, snapshotGroupId: group.snapshotGroupId || null,
      targetCollectionId: collectionId,
      targetGroupId: neighbor.runtimeGroupId || null,
      targetSnapshotGroupId: neighbor.snapshotGroupId || null,
      position: offset < 0 ? 'before' : 'after'
    });
    renderSnapshot(snapshot);
  });
}

/** Clear filtering and restore search focus for both the Clear button and Escape. */
function clearFilter() {
  uiState.filterText = '';
  filterInputNode.value = '';
  renderSnapshot(lastSnapshot);
  filterInputNode.focus();
}

sidebarKeyboard = globalThis.TabGroupCollectionsSidebarKeyboard.create({
  root: collectionsNode,
  filter: filterInputNode,
  onCollapse: setCollectionCollapsed,
  onActivate: activateKeyboardCollection,
  onClearFilter: clearFilter,
  onClosePanel: closeKeyboardPanel,
  onReorder: reorderKeyboardGroup
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
    return;
  }

  scheduleRefresh();
});

refreshSnapshot().catch((error) => {
  showError(error.message || 'Unable to load tab group collections.');
});

UiTheme.start();

filterInputNode.addEventListener('input', () => {
  uiState.filterText = filterInputNode.value;
  renderSnapshot(lastSnapshot);
});

clearFilterButtonNode.addEventListener('click', clearFilter);

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
  const requestedName = window.prompt('New collection name', '');
  if (requestedName === null) {
    return;
  }

  await runAction('Creating collection…', async () => {
    const resolvedWindowId = await ensureCurrentWindowId();
    const snapshot = await sendMessage({
      type: 'sidebar:createCollection',
      currentWindowId: resolvedWindowId,
      name: requestedName
    });
    openCollectionMenuId = null;
    openDeleteMenuId = null;
    openGroupDeleteMenuKey = null;
    renderSnapshot(snapshot);
  });
});
