const STORAGE_KEY = 'tab-group-collections.state';
const TAB_MEMBERSHIP_KEY = 'tab-group-collections.membership';
const NONE_GROUP_ID = browser.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
const SYNC_DELAY_MS = 180;
const TRANSIENT_AUTO_COLLECTION_GRACE_MS = 30000;
const MAX_BADGE_COUNT = 99;
const {
  UNCATEGORIZED_COLLECTION_ID,
  UNCATEGORIZED_COLLECTION_NAME,
  normalizeStoredGroupTitle,
  getDisplayGroupTitle,
  getCollectionName,
  isUncategorizedCollectionId,
  getRequestedCollectionName,
  getGroupColor,
  getRequestedGroupColor,
  pickNextGroupColor,
  getSnapshotUrl,
  getRestorableUrl,
  cloneSnapshotGroup,
  insertSnapshotGroup,
  mergeSnapshotGroupsWithLiveOrder,
  getSnapshotGroupTabCount,
  getMissingSnapshotGroups,
} = globalThis.TabGroupCollectionsShared;

let syncTimerId = null;
let operationQueue = Promise.resolve();
let lastFocusedCollectionId = null;

function hasRequiredApis() {
  return Boolean(
    browser.tabGroups &&
    browser.tabs &&
    browser.sessions &&
    browser.storage &&
    browser.windows
  );
}

function getDefaultSnapshot() {
  return {
    groups: [],
    totalGroupCount: 0,
    totalTabCount: 0
  };
}

function getDefaultState() {
  return {
    nextCollectionNumber: 1,
    collections: {}
  };
}

function enqueueOperation(task) {
  const pending = operationQueue.then(task, task);
  operationQueue = pending.catch((error) => {
    console.error(error);
  });
  return pending;
}

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function nextCollectionName(state) {
  const name = `New collection (${state.nextCollectionNumber})`;
  state.nextCollectionNumber += 1;
  return name;
}

function isGeneratedCollectionName(name) {
  return /^New collection \(\d+\)$/.test(getCollectionName(name));
}

function isAutoNamedCollection(collection) {
  return Boolean(
    collection &&
    !isUncategorizedCollectionId(collection.id) &&
    (collection.autoNamed === true || isGeneratedCollectionName(collection.name))
  );
}

function sortTabs(tabs) {
  return [...tabs].sort((left, right) => (
    left.windowId - right.windowId ||
    left.index - right.index ||
    left.id - right.id
  ));
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return getDefaultSnapshot();
  }

  const groups = Array.isArray(snapshot.groups)
    ? snapshot.groups.map((group) => {
      const tabs = Array.isArray(group?.tabs)
        ? group.tabs.map((tab) => ({
          url: getSnapshotUrl(tab?.url)
        }))
        : [];

      return {
        id: typeof group?.id === 'string' && group.id ? group.id : createId('group'),
        title: normalizeStoredGroupTitle(group?.title),
        color: getGroupColor(group?.color),
        collapsed: Boolean(group?.collapsed),
        tabs
      };
    })
    : [];

  const totalTabCount = groups.reduce((count, group) => count + group.tabs.length, 0);

  return {
    groups,
    totalGroupCount: groups.length,
    totalTabCount
  };
}

function normalizeCollectionRecord(collection, collectionId) {
  const now = Date.now();
  const isUncategorized = isUncategorizedCollectionId(collectionId);

  return {
    id: collectionId,
    name: isUncategorized
      ? UNCATEGORIZED_COLLECTION_NAME
      : getCollectionName(collection?.name),
    autoNamed: isUncategorized
      ? false
      : collection?.autoNamed === true || (
        collection?.autoNamed !== false &&
        isGeneratedCollectionName(collection?.name)
      ),
    pinned: isUncategorized ? false : Boolean(collection?.pinned),
    createdAt: Number.isFinite(collection?.createdAt) ? collection.createdAt : now,
    updatedAt: Number.isFinite(collection?.updatedAt) ? collection.updatedAt : now,
    lastActiveAt: Number.isFinite(collection?.lastActiveAt) ? collection.lastActiveAt : 0,
    snapshotUpdatedAt: Number.isFinite(collection?.snapshotUpdatedAt) ? collection.snapshotUpdatedAt : 0,
    snapshot: normalizeSnapshot(collection?.snapshot)
  };
}

async function loadState() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];

  if (!stored || typeof stored !== 'object') {
    return getDefaultState();
  }

  const collections = {};
  for (const [collectionId, collection] of Object.entries(stored.collections || {})) {
    collections[collectionId] = normalizeCollectionRecord(collection, collectionId);
  }

  return {
    nextCollectionNumber: Number.isInteger(stored.nextCollectionNumber) && stored.nextCollectionNumber > 0
      ? stored.nextCollectionNumber
      : 1,
    collections
  };
}

async function saveState(state) {
  await browser.storage.local.set({ [STORAGE_KEY]: state });
}

function createUncategorizedCollectionRecord(state) {
  const now = Date.now();
  const collection = {
    id: UNCATEGORIZED_COLLECTION_ID,
    name: UNCATEGORIZED_COLLECTION_NAME,
    autoNamed: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: 0,
    snapshotUpdatedAt: 0,
    snapshot: getDefaultSnapshot()
  };

  state.collections[collection.id] = collection;
  return collection;
}

function createCollectionRecord(state, collectionId = createId('collection'), requestedName = null) {
  if (isUncategorizedCollectionId(collectionId)) {
    return createUncategorizedCollectionRecord(state);
  }

  const now = Date.now();
  const explicitName = getRequestedCollectionName(requestedName);
  const collection = {
    id: collectionId,
    name: explicitName || nextCollectionName(state),
    autoNamed: !explicitName,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: 0,
    snapshotUpdatedAt: 0,
    snapshot: getDefaultSnapshot()
  };

  state.collections[collection.id] = collection;
  return collection;
}

function ensureCollectionRecord(state, collectionId) {
  if (state.collections[collectionId]) {
    return state.collections[collectionId];
  }

  if (isUncategorizedCollectionId(collectionId)) {
    return createUncategorizedCollectionRecord(state);
  }

  return createCollectionRecord(state, collectionId);
}

function isValidMembership(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.groupKey === 'string' &&
    value.groupKey &&
    typeof value.collectionId === 'string' &&
    value.collectionId
  );
}

function sameMembership(left, right) {
  if (!isValidMembership(left) || !isValidMembership(right)) {
    return false;
  }

  return left.groupKey === right.groupKey && left.collectionId === right.collectionId;
}

async function getTabMembership(tabId) {
  try {
    const value = await browser.sessions.getTabValue(tabId, TAB_MEMBERSHIP_KEY);
    return isValidMembership(value) ? value : null;
  } catch (error) {
    return null;
  }
}

async function setTabMembership(tabId, membership) {
  await browser.sessions.setTabValue(tabId, TAB_MEMBERSHIP_KEY, membership);
}

async function clearTabMembership(tabId) {
  try {
    await browser.sessions.removeTabValue(tabId, TAB_MEMBERSHIP_KEY);
  } catch (error) {
    // Tabs can disappear mid-sync; stale session data is harmless in that case.
  }
}

function resolveExistingMembership(memberships) {
  const counts = new Map();
  const membershipByKey = new Map();
  let bestKey = null;
  let bestCount = 0;

  for (const membership of memberships) {
    if (!isValidMembership(membership)) {
      continue;
    }

    const key = `${membership.groupKey}\u0000${membership.collectionId}`;
    const nextCount = (counts.get(key) || 0) + 1;

    counts.set(key, nextCount);
    if (!membershipByKey.has(key)) {
      membershipByKey.set(key, membership);
    }

    if (nextCount > bestCount) {
      bestKey = key;
      bestCount = nextCount;
    }
  }

  return bestKey ? membershipByKey.get(bestKey) : null;
}

function getInheritableCollectionId(entry) {
  const collectionId = entry?.membership?.collectionId || null;
  if (!collectionId || isUncategorizedCollectionId(collectionId)) {
    return null;
  }

  return collectionId;
}

function findSiblingCollectionId(entries, startIndex) {
  const currentEntry = entries[startIndex];
  if (!currentEntry) {
    return null;
  }

  const previousEntry = entries[startIndex - 1];
  if (previousEntry && previousEntry.lastTabIndex + 1 === currentEntry.firstTabIndex) {
    const previousCollectionId = getInheritableCollectionId(previousEntry);
    if (previousCollectionId) {
      return previousCollectionId;
    }
  }

  const nextEntry = entries[startIndex + 1];
  if (nextEntry && currentEntry.lastTabIndex + 1 === nextEntry.firstTabIndex) {
    const nextCollectionId = getInheritableCollectionId(nextEntry);
    if (nextCollectionId) {
      return nextCollectionId;
    }
  }

  return null;
}

async function collectRuntime() {
  const [groups, tabs] = await Promise.all([
    browser.tabGroups.query({}),
    browser.tabs.query({})
  ]);

  const sortedTabs = sortTabs(tabs);
  const membershipByTabId = new Map();
  const memberships = await Promise.all(sortedTabs.map((tab) => getTabMembership(tab.id)));

  sortedTabs.forEach((tab, index) => {
    membershipByTabId.set(tab.id, memberships[index]);
  });

  const tabsByGroupId = new Map();
  for (const tab of sortedTabs) {
    if (tab.groupId === NONE_GROUP_ID) {
      continue;
    }

    if (!tabsByGroupId.has(tab.groupId)) {
      tabsByGroupId.set(tab.groupId, []);
    }

    tabsByGroupId.get(tab.groupId).push(tab);
  }

  const groupsByWindow = new Map();
  for (const group of groups) {
    const groupTabs = tabsByGroupId.get(group.id) || [];
    if (!groupTabs.length) {
      continue;
    }

    const entry = {
      group,
      tabs: groupTabs,
      windowId: group.windowId,
      tabCount: groupTabs.length,
      firstTabIndex: groupTabs[0].index,
      lastTabIndex: groupTabs[groupTabs.length - 1].index,
      existingMembership: resolveExistingMembership(
        groupTabs.map((tab) => membershipByTabId.get(tab.id))
      ),
      membership: null
    };

    if (!groupsByWindow.has(group.windowId)) {
      groupsByWindow.set(group.windowId, []);
    }

    groupsByWindow.get(group.windowId).push(entry);
  }

  for (const entries of groupsByWindow.values()) {
    entries.sort((left, right) => (
      left.firstTabIndex - right.firstTabIndex ||
      left.group.id - right.group.id
    ));
  }

  return {
    tabs: sortedTabs,
    membershipByTabId,
    groupsByWindow
  };
}

function buildAssignedMembershipMap(runtime) {
  const assignedMembershipByTabId = new Map(runtime.membershipByTabId);

  for (const entries of runtime.groupsByWindow.values()) {
    for (const entry of entries) {
      for (const tab of entry.tabs) {
        assignedMembershipByTabId.set(tab.id, entry.membership);
      }
    }
  }

  return assignedMembershipByTabId;
}

function buildEntriesByCollection(groupsByWindow) {
  const entriesByCollection = new Map();

  for (const entries of groupsByWindow.values()) {
    for (const entry of entries) {
      const collectionId = entry.membership.collectionId;
      if (!entriesByCollection.has(collectionId)) {
        entriesByCollection.set(collectionId, []);
      }

      entriesByCollection.get(collectionId).push(entry);
    }
  }

  for (const entries of entriesByCollection.values()) {
    entries.sort((left, right) => (
      left.windowId - right.windowId ||
      left.firstTabIndex - right.firstTabIndex ||
      left.group.id - right.group.id
    ));
  }

  return entriesByCollection;
}

function buildSnapshotFromGroups(groups) {
  const normalizedGroups = groups.map((group) => ({
    id: typeof group.id === 'string' && group.id ? group.id : createId('group'),
    title: normalizeStoredGroupTitle(group.title),
    color: getGroupColor(group.color),
    collapsed: Boolean(group.collapsed),
    tabs: Array.isArray(group.tabs)
      ? group.tabs.map((tab) => ({
        url: getSnapshotUrl(tab.url)
      }))
      : []
  }));

  const totalTabCount = normalizedGroups.reduce((count, group) => count + group.tabs.length, 0);

  return {
    groups: normalizedGroups,
    totalGroupCount: normalizedGroups.length,
    totalTabCount
  };
}

function buildSnapshotGroupFromEntry(entry) {
  return {
    id: entry.membership.groupKey,
    title: normalizeStoredGroupTitle(entry.group.title),
    color: getGroupColor(entry.group.color),
    collapsed: Boolean(entry.group.collapsed),
    tabs: entry.tabs.map((tab) => ({
      url: getSnapshotUrl(tab.url)
    }))
  };
}

function buildCollectionSnapshot(entries) {
  return buildSnapshotFromGroups(entries.map((entry) => buildSnapshotGroupFromEntry(entry)));
}

function mergeCollectionSnapshot(collection, entries) {
  const liveGroups = entries.map((entry) => buildSnapshotGroupFromEntry(entry));
  return buildSnapshotFromGroups(
    mergeSnapshotGroupsWithLiveOrder(collection.snapshot.groups, liveGroups)
  );
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setCollectionSnapshot(collection, groups) {
  const now = Date.now();
  collection.snapshot = buildSnapshotFromGroups(groups);
  collection.snapshotUpdatedAt = now;
  collection.updatedAt = now;
}

function removeSnapshotGroup(snapshot, snapshotGroupId) {
  const groups = snapshot.groups.map((group) => cloneSnapshotGroup(group));
  const index = groups.findIndex((group) => group.id === snapshotGroupId);
  if (index === -1) {
    return {
      removedGroup: null,
      groups
    };
  }

  const [removedGroup] = groups.splice(index, 1);
  return {
    removedGroup,
    groups
  };
}

async function updateLastFocusedCollection(state, assignedMembershipByTabId) {
  const [focusedTab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!focusedTab || focusedTab.groupId === NONE_GROUP_ID) {
    lastFocusedCollectionId = null;
    return false;
  }

  const membership = assignedMembershipByTabId.get(focusedTab.id);
  if (!membership) {
    lastFocusedCollectionId = null;
    return false;
  }

  if (membership.collectionId === lastFocusedCollectionId) {
    return false;
  }

  const collection = ensureCollectionRecord(state, membership.collectionId);
  collection.lastActiveAt = Date.now();
  lastFocusedCollectionId = membership.collectionId;
  return true;
}

function updateCollectionSnapshots(state, groupsByWindow) {
  const entriesByCollection = buildEntriesByCollection(groupsByWindow);
  let changed = false;
  const now = Date.now();

  for (const [collectionId, entries] of entriesByCollection) {
    const collection = ensureCollectionRecord(state, collectionId);
    const nextSnapshot = mergeCollectionSnapshot(collection, entries);

    if (!sameSnapshot(collection.snapshot, nextSnapshot)) {
      collection.snapshot = nextSnapshot;
      collection.snapshotUpdatedAt = now;
      collection.updatedAt = now;
      changed = true;
    }
  }

  return changed;
}

function freezeAutoNamedCollection(state, collectionId) {
  const collection = state.collections[collectionId];
  if (!isAutoNamedCollection(collection)) {
    return false;
  }

  collection.autoNamed = false;
  collection.updatedAt = Date.now();
  return true;
}

function finalizeAutoNamedCollectionTitle(state, collectionId, title) {
  const collection = state.collections[collectionId];
  if (!isAutoNamedCollection(collection)) {
    return false;
  }

  if (collection.snapshot.groups.length !== 1) {
    collection.autoNamed = false;
    collection.updatedAt = Date.now();
    return true;
  }

  const nextTitle = normalizeStoredGroupTitle(title);
  if (!nextTitle) {
    return false;
  }

  collection.name = nextTitle;
  collection.autoNamed = false;
  collection.updatedAt = Date.now();
  return true;
}

function updateAutoNamedCollectionTitles(state) {
  let changed = false;

  for (const collection of Object.values(state.collections)) {
    if (isUncategorizedCollectionId(collection.id)) {
      continue;
    }

    if (!isAutoNamedCollection(collection)) {
      continue;
    }

    if (collection.snapshot.groups.length !== 1) {
      collection.autoNamed = false;
      collection.updatedAt = Date.now();
      changed = true;
      continue;
    }

    const groupTitle = normalizeStoredGroupTitle(collection.snapshot.groups[0]?.title);
    if (!groupTitle) {
      continue;
    }

    if (collection.name !== groupTitle) {
      collection.name = groupTitle;
      collection.updatedAt = Date.now();
      changed = true;
    }
  }

  return changed;
}

function freezeAutoNamedCollectionsWithEstablishedLiveGroups(state, groupsByWindow) {
  const entriesByCollection = buildEntriesByCollection(groupsByWindow);
  let changed = false;

  for (const [collectionId, entries] of entriesByCollection) {
    const collection = state.collections[collectionId];
    if (!isAutoNamedCollection(collection)) {
      continue;
    }

    if (entries.some((entry) => entry.tabCount > 1)) {
      collection.autoNamed = false;
      collection.updatedAt = Date.now();
      changed = true;
    }
  }

  return changed;
}

function pruneTransientAutoNamedCollections(state, groupsByWindow) {
  const entriesByCollection = buildEntriesByCollection(groupsByWindow);
  let changed = false;
  const now = Date.now();

  for (const [collectionId, collection] of Object.entries(state.collections)) {
    if (!isAutoNamedCollection(collection)) {
      continue;
    }

    const liveEntries = entriesByCollection.get(collectionId) || [];
    if (liveEntries.length) {
      continue;
    }

    if (collection.snapshot.groups.length === 0) {
      delete state.collections[collectionId];
      changed = true;
      continue;
    }

    if (collection.snapshot.groups.length !== 1) {
      continue;
    }

    const ageMs = now - (Number.isFinite(collection.createdAt) ? collection.createdAt : now);
    if (ageMs <= TRANSIENT_AUTO_COLLECTION_GRACE_MS) {
      delete state.collections[collectionId];
      changed = true;
    }
  }

  return changed;
}

async function updateButtonState(state, groupsByWindow) {
  const collectionCount = Object.keys(state.collections).length;
  let openGroupCount = 0;

  for (const entries of groupsByWindow.values()) {
    openGroupCount += entries.length;
  }

  const badgeText = collectionCount
    ? String(Math.min(collectionCount, MAX_BADGE_COUNT))
    : '';
  const title = collectionCount
    ? `Open Tab Group Collections sidebar. ${collectionCount} collections, ${openGroupCount} live groups.`
    : 'Open Tab Group Collections sidebar.';

  await Promise.all([
    browser.browserAction.setTitle({ title }),
    browser.browserAction.setBadgeText({ text: '' }),
    browser.browserAction.setBadgeBackgroundColor({ color: '#2a5a49' })
  ]);
}

async function syncCollections() {
  const state = await loadState();
  const runtime = await collectRuntime();
  let stateChanged = false;
  const membershipWrites = [];
  const membershipClears = [];

  for (const entries of runtime.groupsByWindow.values()) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const existingMembership = entry.existingMembership;

      if (!existingMembership) {
        entry.membership = null;
        continue;
      }

      if (state.collections[existingMembership.collectionId]) {
        entry.membership = existingMembership;
        continue;
      }

      const siblingCollectionId = findSiblingCollectionId(entries, index);
      if (siblingCollectionId) {
        entry.membership = {
          groupKey: existingMembership.groupKey,
          collectionId: siblingCollectionId
        };
        continue;
      }

      entry.membership = null;
    }

    // New groups inherit the nearest sibling collection before we ever
    // generate a fresh one, which keeps saved groups aligned with the tab strip.
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.membership) {
        continue;
      }

      let collectionId = findSiblingCollectionId(entries, index);
      if (!collectionId) {
        const fallbackCollectionName = normalizeStoredGroupTitle(entry.group.title) || null;
        collectionId = createCollectionRecord(state, createId('collection'), fallbackCollectionName).id;
        stateChanged = true;
      }

      entry.membership = {
        groupKey: createId('group'),
        collectionId
      };
    }

    for (const entry of entries) {
      for (const tab of entry.tabs) {
        const currentMembership = runtime.membershipByTabId.get(tab.id);
        if (!sameMembership(currentMembership, entry.membership)) {
          membershipWrites.push(setTabMembership(tab.id, entry.membership));
        }
      }
    }
  }

  for (const tab of runtime.tabs) {
    if (tab.groupId !== NONE_GROUP_ID) {
      continue;
    }

    const currentMembership = runtime.membershipByTabId.get(tab.id);
    if (currentMembership) {
      membershipClears.push(clearTabMembership(tab.id));
    }
  }

  await Promise.all([...membershipWrites, ...membershipClears]);

  const assignedMembershipByTabId = buildAssignedMembershipMap(runtime);

  if (await updateLastFocusedCollection(state, assignedMembershipByTabId)) {
    stateChanged = true;
  }

  if (updateCollectionSnapshots(state, runtime.groupsByWindow)) {
    stateChanged = true;
  }

  if (updateAutoNamedCollectionTitles(state)) {
    stateChanged = true;
  }

  if (freezeAutoNamedCollectionsWithEstablishedLiveGroups(state, runtime.groupsByWindow)) {
    stateChanged = true;
  }

  if (pruneTransientAutoNamedCollections(state, runtime.groupsByWindow)) {
    stateChanged = true;
  }

  if (stateChanged) {
    await saveState(state);
  }

  await updateButtonState(state, runtime.groupsByWindow);

  return { state, runtime };
}

function buildCurrentCollectionId(groupsByWindow, currentWindowId) {
  const entries = groupsByWindow.get(currentWindowId) || [];
  const activeEntry = entries.find((entry) => entry.tabs.some((tab) => tab.active));
  return activeEntry?.membership?.collectionId || null;
}

function buildRuntimeGroupSnapshot(entry, currentWindowId) {
  return {
    key: `live-${entry.group.id}`,
    kind: 'live',
    runtimeGroupId: entry.group.id,
    snapshotGroupId: entry.membership.groupKey,
    title: getDisplayGroupTitle(entry.group.title),
    color: getGroupColor(entry.group.color),
    collapsed: Boolean(entry.group.collapsed),
    tabCount: entry.tabCount,
    active: entry.tabs.some((tab) => tab.active),
    locationLabel: entry.windowId === currentWindowId
      ? 'This window'
      : `Window ${entry.windowId}`,
    canMove: true
  };
}

function buildSavedGroupSnapshot(group, index) {
  return {
    key: `saved-${group.id || index}-${group.title || 'untitled'}`,
    kind: 'snapshot',
    snapshotGroupId: group.id,
    title: getDisplayGroupTitle(group.title),
    color: getGroupColor(group.color),
    collapsed: Boolean(group.collapsed),
    tabCount: group.tabs.length,
    active: false,
    locationLabel: 'Closed',
    canMove: true
  };
}

function buildCollectionGroupSnapshots(collection, liveEntries, currentWindowId) {
  const liveGroups = liveEntries.map((entry) => buildRuntimeGroupSnapshot(entry, currentWindowId));
  const liveGroupsById = new Map(liveGroups.map((group) => [group.snapshotGroupId, group]));
  const consumedIds = new Set();
  const groups = [];

  for (let index = 0; index < collection.snapshot.groups.length; index += 1) {
    const snapshotGroup = collection.snapshot.groups[index];
    const matchingLiveGroup = liveGroupsById.get(snapshotGroup.id);

    if (matchingLiveGroup) {
      groups.push(matchingLiveGroup);
      consumedIds.add(snapshotGroup.id);
      continue;
    }

    groups.push(buildSavedGroupSnapshot(snapshotGroup, index));
  }

  for (const liveGroup of liveGroups) {
    if (!consumedIds.has(liveGroup.snapshotGroupId)) {
      groups.push(liveGroup);
    }
  }

  return groups;
}

function buildSidebarSnapshot(syncedState, currentWindowId) {
  const { state, runtime } = syncedState;
  const entriesByCollection = buildEntriesByCollection(runtime.groupsByWindow);
  const collectionIds = new Set([
    ...Object.keys(state.collections),
    ...entriesByCollection.keys()
  ]);
  const currentCollectionId = buildCurrentCollectionId(runtime.groupsByWindow, currentWindowId);
  const collections = [];

  for (const collectionId of collectionIds) {
    const collection = state.collections[collectionId] || normalizeCollectionRecord({}, collectionId);
    const liveEntries = entriesByCollection.get(collectionId) || [];
    const liveTabCount = liveEntries.reduce((count, entry) => count + entry.tabCount, 0);
    const openWindowCount = new Set(liveEntries.map((entry) => entry.windowId)).size;
    const groups = buildCollectionGroupSnapshots(collection, liveEntries, currentWindowId);

    collections.push({
      id: collectionId,
      name: collection.name,
      isUncategorized: isUncategorizedCollectionId(collectionId),
      isPinned: Boolean(collection.pinned),
      isCurrent: collectionId === currentCollectionId,
      lastActiveAt: collection.lastActiveAt,
      snapshotUpdatedAt: collection.snapshotUpdatedAt,
      liveGroupCount: liveEntries.length,
      liveTabCount,
      openWindowCount,
      snapshotGroupCount: collection.snapshot.totalGroupCount,
      snapshotTabCount: collection.snapshot.totalTabCount,
      groups
    });
  }

  const collectionsForDisplay = collections.filter((collection) => (
    !collection.isUncategorized || collection.liveGroupCount > 0 || collection.snapshotGroupCount > 0
  ));

  const availableCollections = [
    ...collections,
    ...(collections.some((collection) => collection.id === UNCATEGORIZED_COLLECTION_ID)
      ? []
      : [{
        id: UNCATEGORIZED_COLLECTION_ID,
        name: UNCATEGORIZED_COLLECTION_NAME,
        isPinned: false,
        isUncategorized: true,
        lastActiveAt: 0,
        snapshotUpdatedAt: 0
      }])
  ]
    .map((collection) => ({
      id: collection.id,
      name: collection.name,
      isPinned: collection.isPinned,
      isUncategorized: Boolean(collection.isUncategorized),
      lastActiveAt: collection.lastActiveAt,
      snapshotUpdatedAt: collection.snapshotUpdatedAt
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base'
    }));

  return {
    currentWindowId,
    currentCollectionId,
    collections: collectionsForDisplay,
    availableCollections,
    totalCollectionCount: collectionsForDisplay.length,
    totalLiveGroupCount: collectionsForDisplay.reduce((count, collection) => count + collection.liveGroupCount, 0),
    totalGroupCount: collectionsForDisplay.reduce((count, collection) => count + collection.groups.length, 0)
  };
}

async function getUiThemeMode() {
  if (!browser.browserSettings?.overrideContentColorScheme?.get) {
    return { mode: null };
  }

  try {
    const result = await browser.browserSettings.overrideContentColorScheme.get({});
    return {
      mode: result?.value || null
    };
  } catch (error) {
    return {
      mode: null
    };
  }
}

function pickCollectionFocusTarget(liveEntries) {
  const candidates = [];

  for (const entry of liveEntries) {
    const tabs = sortTabs(entry.tabs);
    for (const tab of tabs) {
      candidates.push({ entry, tab });
    }
  }

  if (!candidates.length) {
    return null;
  }

  const withLastAccessed = candidates
    .filter(({ tab }) => Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0)
    .sort((left, right) => (
      right.tab.lastAccessed - left.tab.lastAccessed ||
      left.tab.windowId - right.tab.windowId ||
      left.tab.index - right.tab.index ||
      left.tab.id - right.tab.id
    ));

  return withLastAccessed[0] || candidates.find(({ tab }) => tab.active) || candidates[0];
}

function getAppendPlacementForCollection(liveEntries, currentWindowId) {
  if (!liveEntries.length) {
    if (!currentWindowId) {
      throw new Error('No current browser window was found.');
    }

    return {
      windowId: currentWindowId,
      index: -1
    };
  }

  const focusTarget = pickCollectionFocusTarget(liveEntries);
  if (!focusTarget) {
    throw new Error('Collection placement could not be resolved.');
  }

  const targetWindowId = focusTarget.tab.windowId;
  const windowEntries = liveEntries
    .filter((entry) => entry.windowId === targetWindowId)
    .sort((left, right) => left.firstTabIndex - right.firstTabIndex || left.group.id - right.group.id);
  const lastEntry = windowEntries[windowEntries.length - 1];

  return {
    windowId: targetWindowId,
    index: lastEntry ? lastEntry.firstTabIndex + lastEntry.tabCount : -1
  };
}

function findGroupEntry(groupsByWindow, groupId) {
  for (const entries of groupsByWindow.values()) {
    const entry = entries.find((candidate) => candidate.group.id === groupId);
    if (entry) {
      return entry;
    }
  }

  return null;
}

async function repositionGroup(entry, targetCollectionId, windowEntries) {
  const targetEntries = windowEntries.filter((candidate) => (
    candidate.group.id !== entry.group.id &&
    candidate.membership?.collectionId === targetCollectionId
  ));

  if (!targetEntries.length) {
    await browser.tabGroups.move(entry.group.id, { index: -1 });
    return;
  }

  const lastTarget = targetEntries[targetEntries.length - 1];
  let targetIndex = lastTarget.firstTabIndex + lastTarget.tabCount;

  if (entry.firstTabIndex < targetIndex) {
    targetIndex -= entry.tabCount;
  }

  if (targetIndex !== entry.firstTabIndex) {
    await browser.tabGroups.move(entry.group.id, { index: targetIndex });
  }
}

function getGroupPlacement(entry, syncedState, targetCollectionId, targetGroupId, position) {
  if (targetGroupId !== null && targetGroupId !== undefined) {
    const targetEntry = findGroupEntry(syncedState.runtime.groupsByWindow, targetGroupId);
    if (!targetEntry) {
      throw new Error('Drop target group not found.');
    }

    if (targetEntry.group.id === entry.group.id) {
      return null;
    }

    const targetPosition = position === 'before' ? 'before' : 'after';
    let targetIndex = targetEntry.firstTabIndex;

    if (targetPosition === 'after') {
      targetIndex += targetEntry.tabCount;
    }

    if (entry.windowId === targetEntry.windowId && entry.firstTabIndex < targetIndex) {
      targetIndex -= entry.tabCount;
    }

    return {
      targetCollectionId: targetEntry.membership.collectionId,
      windowId: targetEntry.windowId,
      index: targetIndex
    };
  }

  const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
  const targetEntries = entriesByCollection.get(targetCollectionId) || [];

  if (!targetEntries.length) {
    return {
      targetCollectionId,
      windowId: entry.windowId,
      index: -1
    };
  }

  const lastTarget = targetEntries[targetEntries.length - 1];
  let targetIndex = lastTarget.firstTabIndex + lastTarget.tabCount;

  if (entry.windowId === lastTarget.windowId && entry.firstTabIndex < targetIndex) {
    targetIndex -= entry.tabCount;
  }

  return {
    targetCollectionId,
    windowId: lastTarget.windowId,
    index: targetIndex
  };
}

function placeLiveGroupSnapshot(state, entry, targetCollectionId, targetSnapshotGroupId, position) {
  const sourceCollection = state.collections[entry.membership.collectionId];
  if (!sourceCollection) {
    return false;
  }

  const snapshotGroup = buildSnapshotGroupFromEntry(entry);
  const { groups: sourceGroups } = removeSnapshotGroup(sourceCollection.snapshot, entry.membership.groupKey);

  if (targetCollectionId === sourceCollection.id) {
    const targetGroups = insertSnapshotGroup(
      sourceGroups,
      snapshotGroup,
      targetSnapshotGroupId,
      position
    );
    setCollectionSnapshot(sourceCollection, targetGroups);
    return true;
  }

  setCollectionSnapshot(sourceCollection, sourceGroups);
  const targetCollection = ensureCollectionRecord(state, targetCollectionId);
  const targetGroups = insertSnapshotGroup(
    targetCollection.snapshot.groups,
    snapshotGroup,
    targetSnapshotGroupId,
    position
  );
  setCollectionSnapshot(targetCollection, targetGroups);
  return true;
}

function getGroupPlacementForSnapshotTarget(entry, syncedState, state, targetCollectionId) {
  const targetCollection = state.collections[targetCollectionId];
  if (!targetCollection) {
    return getGroupPlacement(entry, syncedState, targetCollectionId, null, 'append');
  }

  const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
  const liveEntryByGroupKey = new Map();

  for (const entries of entriesByCollection.values()) {
    for (const candidate of entries) {
      liveEntryByGroupKey.set(candidate.membership.groupKey, candidate);
    }
  }

  liveEntryByGroupKey.set(entry.membership.groupKey, entry);

  const targetLiveGroupKeys = new Set(
    (entriesByCollection.get(targetCollectionId) || []).map((candidate) => candidate.membership.groupKey)
  );
  targetLiveGroupKeys.add(entry.membership.groupKey);

  const orderedLiveGroupKeys = targetCollection.snapshot.groups
    .map((group) => group.id)
    .filter((groupKey) => targetLiveGroupKeys.has(groupKey));
  const entryIndex = orderedLiveGroupKeys.indexOf(entry.membership.groupKey);

  if (entryIndex === -1) {
    return getGroupPlacement(entry, syncedState, targetCollectionId, null, 'append');
  }

  for (let index = entryIndex + 1; index < orderedLiveGroupKeys.length; index += 1) {
    const nextEntry = liveEntryByGroupKey.get(orderedLiveGroupKeys[index]);
    if (nextEntry && nextEntry.group.id !== entry.group.id) {
      return getGroupPlacement(entry, syncedState, targetCollectionId, nextEntry.group.id, 'before');
    }
  }

  for (let index = entryIndex - 1; index >= 0; index -= 1) {
    const previousEntry = liveEntryByGroupKey.get(orderedLiveGroupKeys[index]);
    if (previousEntry && previousEntry.group.id !== entry.group.id) {
      return getGroupPlacement(entry, syncedState, targetCollectionId, previousEntry.group.id, 'after');
    }
  }

  if (entry.membership.collectionId === targetCollectionId) {
    return null;
  }

  return getGroupPlacement(entry, syncedState, targetCollectionId, null, 'append');
}

async function placeGroup(groupId, placement, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const entry = findGroupEntry(syncedState.runtime.groupsByWindow, groupId);

    if (!entry) {
      throw new Error('Tab group not found.');
    }

    let targetCollectionId = placement?.targetCollectionId || null;
    let stateChanged = false;

    if (!targetCollectionId) {
      targetCollectionId = createCollectionRecord(
        state,
        createId('collection'),
        placement?.targetCollectionName ?? null
      ).id;
      stateChanged = true;
    } else if (!state.collections[targetCollectionId]) {
      ensureCollectionRecord(state, targetCollectionId);
      stateChanged = true;
    }

    if (placement?.targetSnapshotGroupId) {
      if (placeLiveGroupSnapshot(
        state,
        entry,
        targetCollectionId,
        placement.targetSnapshotGroupId,
        placement?.position ?? 'append'
      )) {
        stateChanged = true;
      }
    }

    const resolvedPlacement = placement?.targetSnapshotGroupId
      ? getGroupPlacementForSnapshotTarget(entry, syncedState, state, targetCollectionId)
      : getGroupPlacement(
        entry,
        syncedState,
        targetCollectionId,
        placement?.targetGroupId ?? null,
        placement?.position ?? 'append'
      );

    if (!resolvedPlacement && entry.membership.collectionId === targetCollectionId) {
      if (stateChanged) {
        await saveState(state);
      }
      const refreshedState = await syncCollections();
      return buildSidebarSnapshot(refreshedState, currentWindowId || entry.windowId);
    }

    targetCollectionId = resolvedPlacement?.targetCollectionId || targetCollectionId;

    if (freezeAutoNamedCollection(state, entry.membership.collectionId)) {
      stateChanged = true;
    }
    if (freezeAutoNamedCollection(state, targetCollectionId)) {
      stateChanged = true;
    }

    if (stateChanged) {
      await saveState(state);
    }

    if (entry.membership.collectionId !== targetCollectionId) {
      if (!placement?.targetSnapshotGroupId) {
        const sourceCollection = state.collections[entry.membership.collectionId];
        if (sourceCollection) {
          const { groups: sourceGroups } = removeSnapshotGroup(
            sourceCollection.snapshot,
            entry.membership.groupKey
          );
          setCollectionSnapshot(sourceCollection, sourceGroups);
        }
      }

      const updatedMembership = {
        groupKey: entry.membership.groupKey,
        collectionId: targetCollectionId
      };

      await Promise.all(entry.tabs.map((tab) => setTabMembership(tab.id, updatedMembership)));
      entry.membership = updatedMembership;
      await saveState(state);
    }

    if (resolvedPlacement) {
      const shouldMoveGroup = (
        resolvedPlacement.index === -1 ||
        resolvedPlacement.windowId !== entry.windowId ||
        resolvedPlacement.index !== entry.firstTabIndex
      );

      if (shouldMoveGroup) {
        await browser.tabGroups.move(entry.group.id, {
          windowId: resolvedPlacement.windowId,
          index: resolvedPlacement.index
        });
      }
    }

    const refreshedState = await syncCollections();
    return buildSidebarSnapshot(refreshedState, currentWindowId || resolvedPlacement?.windowId || entry.windowId);
  });
}

async function getSidebarSnapshot(currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('This Firefox build does not expose the tab group APIs required by this add-on.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    return buildSidebarSnapshot(syncedState, currentWindowId);
  });
}

async function createCollection(currentWindowId, requestedName) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const state = await loadState();
    const collection = createCollectionRecord(
      state,
      createId('collection'),
      requestedName ?? null
    );
    collection.lastActiveAt = Date.now();
    await saveState(state);

    const syncedState = await syncCollections();
    const snapshot = buildSidebarSnapshot(syncedState, currentWindowId);
    snapshot.createdCollectionId = collection.id;
    return snapshot;
  });
}

async function renameCollection(collectionId, name, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) {
    throw new Error('Collection names cannot be empty.');
  }

  return enqueueOperation(async () => {
    const state = await loadState();
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    if (isUncategorizedCollectionId(collectionId)) {
      throw new Error('Uncategorized cannot be renamed.');
    }

    if (collection.name !== trimmedName) {
      collection.name = trimmedName;
      collection.autoNamed = false;
      collection.updatedAt = Date.now();
      await saveState(state);
    }

    const syncedState = await syncCollections();
    return buildSidebarSnapshot(syncedState, currentWindowId);
  });
}

async function setCollectionPinned(collectionId, pinned, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const state = await loadState();
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    if (isUncategorizedCollectionId(collectionId)) {
      throw new Error('Uncategorized cannot be pinned.');
    }

    const frozeAutoName = freezeAutoNamedCollection(state, collectionId);
    if (collection.pinned !== Boolean(pinned)) {
      collection.pinned = Boolean(pinned);
      collection.updatedAt = Date.now();
      await saveState(state);
    } else if (frozeAutoName) {
      await saveState(state);
    }

    const syncedState = await syncCollections();
    return buildSidebarSnapshot(syncedState, currentWindowId);
  });
}

async function focusCollection(collectionId, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    if (isUncategorizedCollectionId(collectionId)) {
      throw new Error('Uncategorized cannot be deleted.');
    }

    freezeAutoNamedCollection(state, collectionId);
    const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
    const liveEntries = entriesByCollection.get(collectionId) || [];
    const target = pickCollectionFocusTarget(liveEntries);

    if (!target) {
      throw new Error('This collection is not currently open.');
    }

    try {
      await browser.tabGroups.update(target.entry.group.id, { collapsed: false });
    } catch (error) {
      console.debug('Unable to expand tab group before focusing collection.', error);
    }

    await browser.windows.update(target.tab.windowId, { focused: true });
    await browser.tabs.update(target.tab.id, { active: true });
    collection.lastActiveAt = Date.now();
    await saveState(state);

    const refreshedState = await syncCollections();
    return buildSidebarSnapshot(refreshedState, target.tab.windowId);
  });
}

async function closeCollection(collectionId, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    if (freezeAutoNamedCollection(state, collectionId)) {
      await saveState(state);
    }

    const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
    const liveEntries = entriesByCollection.get(collectionId) || [];
    const tabIds = liveEntries.flatMap((entry) => entry.tabs.map((tab) => tab.id));

    if (!tabIds.length) {
      throw new Error('This collection is not currently open.');
    }

    await browser.tabs.remove(tabIds);

    const refreshedState = await syncCollections();
    return buildSidebarSnapshot(refreshedState, currentWindowId);
  });
}

async function moveGroupToCollection(groupId, collectionId, currentWindowId, targetCollectionName = null) {
  return placeGroup(groupId, {
    targetCollectionId: collectionId,
    targetCollectionName,
    targetGroupId: null,
    position: 'append'
  }, currentWindowId);
}

async function removeGroupFromCollection(sourceKind, groupId, snapshotGroupId, collectionId, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  if (sourceKind !== 'live' && sourceKind !== 'snapshot') {
    throw new Error('Unknown group remove mode.');
  }

  if (isUncategorizedCollectionId(collectionId)) {
    throw new Error('Groups in Uncategorized cannot be removed from their collection.');
  }

  if (sourceKind === 'live') {
    await enqueueOperation(async () => {
      const state = await loadState();
      if (freezeAutoNamedCollection(state, collectionId)) {
        await saveState(state);
      }
    });
    return moveGroupToCollection(
      groupId,
      UNCATEGORIZED_COLLECTION_ID,
      currentWindowId,
      null
    );
  }

  return placeSavedGroup(collectionId, snapshotGroupId, {
    targetCollectionId: UNCATEGORIZED_COLLECTION_ID,
    targetCollectionName: null,
    targetGroupId: null,
    targetSnapshotGroupId: null,
    position: 'append'
  }, currentWindowId);
}

async function deleteGroup(sourceKind, groupId, snapshotGroupId, collectionId, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  if (sourceKind !== 'live' && sourceKind !== 'snapshot') {
    throw new Error('Unknown group delete mode.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;

    if (sourceKind === 'live') {
      const entry = findGroupEntry(syncedState.runtime.groupsByWindow, groupId);
      if (!entry) {
        throw new Error('Tab group not found.');
      }

      const sourceCollection = state.collections[entry.membership.collectionId];
      if (sourceCollection) {
        freezeAutoNamedCollection(state, sourceCollection.id);
        const { groups } = removeSnapshotGroup(sourceCollection.snapshot, entry.membership.groupKey);
        setCollectionSnapshot(sourceCollection, groups);
        await saveState(state);
      }

      const tabIds = entry.tabs.map((tab) => tab.id);
      if (tabIds.length) {
        await browser.tabs.remove(tabIds);
      }

      const refreshedState = await syncCollections();
      return buildSidebarSnapshot(refreshedState, currentWindowId);
    }

    const sourceCollection = state.collections[collectionId];
    if (!sourceCollection) {
      throw new Error('Collection not found.');
    }

    freezeAutoNamedCollection(state, collectionId);
    const { removedGroup, groups } = removeSnapshotGroup(sourceCollection.snapshot, snapshotGroupId);
    if (!removedGroup) {
      throw new Error('Saved group not found.');
    }

    setCollectionSnapshot(sourceCollection, groups);
    await saveState(state);
    return buildSidebarSnapshot({ state, runtime: syncedState.runtime }, currentWindowId);
  });
}

async function activateGroup(groupId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const tabs = sortTabs(await browser.tabs.query({ groupId }));
    if (!tabs.length) {
      throw new Error('Tab group not found.');
    }

    try {
      await browser.tabGroups.update(groupId, { collapsed: false });
    } catch (error) {
      console.debug('Unable to expand tab group before activation.', error);
    }

    await browser.windows.update(tabs[0].windowId, { focused: true });
    await browser.tabs.update(tabs[0].id, { active: true });
    return { ok: true };
  });
}

async function renameGroup(sourceKind, groupId, snapshotGroupId, collectionId, title, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  if (sourceKind !== 'live' && sourceKind !== 'snapshot') {
    throw new Error('Unknown group rename mode.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const nextTitle = normalizeStoredGroupTitle(title);

    if (sourceKind === 'live') {
      const entry = findGroupEntry(syncedState.runtime.groupsByWindow, groupId);
      if (!entry) {
        throw new Error('Tab group not found.');
      }

      await browser.tabGroups.update(groupId, { title: nextTitle });
      const refreshedState = await syncCollections();
      if (finalizeAutoNamedCollectionTitle(refreshedState.state, entry.membership.collectionId, nextTitle)) {
        await saveState(refreshedState.state);
      }
      return buildSidebarSnapshot(refreshedState, currentWindowId || entry.windowId);
    }

    const collection = state.collections[collectionId];
    if (!collection) {
      throw new Error('Collection not found.');
    }

    const groups = collection.snapshot.groups.map((group) => (
      group.id === snapshotGroupId
        ? {
          ...cloneSnapshotGroup(group),
          title: nextTitle
        }
        : cloneSnapshotGroup(group)
    ));
    setCollectionSnapshot(collection, groups);
    finalizeAutoNamedCollectionTitle(state, collectionId, nextTitle);
    await saveState(state);
    return buildSidebarSnapshot({ state, runtime: syncedState.runtime }, currentWindowId);
  });
}

async function updateGroupColor(
  sourceKind,
  groupId,
  snapshotGroupId,
  collectionId,
  color,
  currentWindowId
) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  if (sourceKind !== 'live' && sourceKind !== 'snapshot') {
    throw new Error('Unknown group color mode.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const frozeAutoNamedCollection = freezeAutoNamedCollection(state, collectionId);
    const nextColor = getRequestedGroupColor(color);

    if (sourceKind === 'live') {
      const entry = findGroupEntry(syncedState.runtime.groupsByWindow, groupId);
      if (!entry) {
        throw new Error('Tab group not found.');
      }

      if (frozeAutoNamedCollection) {
        await saveState(state);
      }
      await browser.tabGroups.update(groupId, { color: nextColor });
      const refreshedState = await syncCollections();
      return buildSidebarSnapshot(refreshedState, currentWindowId || entry.windowId);
    }

    const collection = state.collections[collectionId];
    if (!collection) {
      throw new Error('Collection not found.');
    }

    let found = false;
    const groups = collection.snapshot.groups.map((group) => (
      group.id === snapshotGroupId
        ? (() => {
          found = true;
          return {
            ...cloneSnapshotGroup(group),
            color: nextColor
          };
        })()
        : cloneSnapshotGroup(group)
    ));
    if (!found) {
      throw new Error('Saved group not found.');
    }
    setCollectionSnapshot(collection, groups);
    await saveState(state);
    return buildSidebarSnapshot({ state, runtime: syncedState.runtime }, currentWindowId);
  });
}

async function createTabsForSnapshotGroup(snapshotGroup, collectionId, windowId, seedTab) {
  const snapshotTabs = snapshotGroup.tabs.length ? snapshotGroup.tabs : [{ url: 'about:blank' }];
  const createdTabs = [];

  if (seedTab) {
    createdTabs.push(seedTab);
  }

  const startIndex = seedTab ? 1 : 0;
  for (const snapshotTab of snapshotTabs.slice(startIndex)) {
    const tab = await browser.tabs.create({
      windowId,
      url: getRestorableUrl(snapshotTab.url),
      active: false
    });
    createdTabs.push(tab);
  }

  if (!createdTabs.length) {
    const tab = await browser.tabs.create({
      windowId,
      url: 'about:blank',
      active: false
    });
    createdTabs.push(tab);
  }

  const groupId = await browser.tabs.group({
    tabIds: createdTabs.map((tab) => tab.id)
  });

  await browser.tabGroups.update(groupId, {
    title: normalizeStoredGroupTitle(snapshotGroup.title),
    color: getGroupColor(snapshotGroup.color),
    collapsed: Boolean(snapshotGroup.collapsed)
  });

  const membership = {
    groupKey: snapshotGroup.id || createId('group'),
    collectionId
  };

  await Promise.all(createdTabs.map((tab) => setTabMembership(tab.id, membership)));
  return { groupId, membership };
}

async function createGroup(collectionId, currentWindowId, title) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    freezeAutoNamedCollection(state, collectionId);
    const nextColor = pickNextGroupColor(collection.snapshot.groups);
    const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
    const liveEntries = entriesByCollection.get(collectionId) || [];
    const placement = getAppendPlacementForCollection(liveEntries, currentWindowId);
    const tab = await browser.tabs.create({
      windowId: placement.windowId,
      url: 'about:blank',
      active: false
    });

    const groupId = await browser.tabs.group({
      tabIds: [tab.id]
    });

    await browser.tabGroups.update(groupId, {
      title: normalizeStoredGroupTitle(title),
      color: nextColor,
      collapsed: false
    });

    const membership = {
      groupKey: createId('group'),
      collectionId
    };
    await setTabMembership(tab.id, membership);

    if (placement.index !== -1) {
      await browser.tabGroups.move(groupId, {
        windowId: placement.windowId,
        index: placement.index
      });
    }

    collection.lastActiveAt = Date.now();
    await saveState(state);
    const refreshedState = await syncCollections();
    return buildSidebarSnapshot(refreshedState, placement.windowId);
  });
}

async function restoreSnapshotGroup(snapshotGroup, targetCollectionId, placement) {
  const { groupId } = await createTabsForSnapshotGroup(
    snapshotGroup,
    targetCollectionId,
    placement.windowId,
    null
  );

  if (placement.index !== -1) {
    await browser.tabGroups.move(groupId, {
      windowId: placement.windowId,
      index: placement.index
    });
  }

  return groupId;
}

function getSavedPlacement(state, syncedState, placement) {
  let targetCollectionId = placement?.targetCollectionId || null;
  let targetSnapshotGroupId = placement?.targetSnapshotGroupId || null;

  if (placement?.targetGroupId !== null && placement?.targetGroupId !== undefined) {
    const targetEntry = findGroupEntry(syncedState.runtime.groupsByWindow, placement.targetGroupId);
    if (!targetEntry) {
      throw new Error('Drop target group not found.');
    }

    targetCollectionId = targetEntry.membership.collectionId;
    targetSnapshotGroupId = targetEntry.membership.groupKey;
  }

  if (!targetCollectionId) {
    targetCollectionId = createCollectionRecord(
      state,
      createId('collection'),
      placement?.targetCollectionName ?? null
    ).id;
  } else {
    ensureCollectionRecord(state, targetCollectionId);
  }

  return {
    mode: 'snapshot',
    targetCollectionId,
    targetSnapshotGroupId,
    position: placement?.position || 'append'
  };
}

async function placeSavedGroup(sourceCollectionId, snapshotGroupId, placement, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const sourceCollection = state.collections[sourceCollectionId];

    if (!sourceCollection) {
      throw new Error('Source collection not found.');
    }

    freezeAutoNamedCollection(state, sourceCollectionId);
    const { removedGroup, groups: sourceGroups } = removeSnapshotGroup(sourceCollection.snapshot, snapshotGroupId);
    if (!removedGroup) {
      throw new Error('Saved group not found.');
    }

    const resolvedPlacement = getSavedPlacement(state, syncedState, placement);

    if (
      resolvedPlacement.mode === 'snapshot' &&
      resolvedPlacement.targetCollectionId === sourceCollectionId &&
      !resolvedPlacement.targetSnapshotGroupId
    ) {
      const existingIndex = sourceCollection.snapshot.groups.findIndex((group) => group.id === snapshotGroupId);
      if (existingIndex === sourceCollection.snapshot.groups.length - 1) {
        return buildSidebarSnapshot(syncedState, currentWindowId);
      }
    }

    freezeAutoNamedCollection(state, sourceCollectionId);
    freezeAutoNamedCollection(state, resolvedPlacement.targetCollectionId);

    setCollectionSnapshot(sourceCollection, sourceGroups);
    let targetCollection = state.collections[resolvedPlacement.targetCollectionId];
    if (!targetCollection) {
      targetCollection = createCollectionRecord(state, resolvedPlacement.targetCollectionId);
    }

    const targetGroupsBase = resolvedPlacement.targetCollectionId === sourceCollectionId
      ? sourceCollection.snapshot.groups
      : targetCollection.snapshot.groups;
    const targetGroups = insertSnapshotGroup(
      targetGroupsBase,
      removedGroup,
      resolvedPlacement.targetSnapshotGroupId,
      resolvedPlacement.position
    );
    setCollectionSnapshot(targetCollection, targetGroups);
    await saveState(state);
    return buildSidebarSnapshot({ state, runtime: syncedState.runtime }, currentWindowId);
  });
}

async function deleteCollection(collectionId, mode, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  if (mode !== 'collection-only' && mode !== 'collection-and-groups') {
    throw new Error('Unknown delete mode.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
    const liveEntries = entriesByCollection.get(collectionId) || [];

    if (mode === 'collection-and-groups') {
      const tabIds = liveEntries.flatMap((entry) => entry.tabs.map((tab) => tab.id));
      if (tabIds.length) {
        await browser.tabs.remove(tabIds);
      }
      delete state.collections[collectionId];
      await saveState(state);
      const refreshedState = await syncCollections();
      return buildSidebarSnapshot(refreshedState, currentWindowId);
    }

    const uncategorizedCollection = ensureCollectionRecord(state, UNCATEGORIZED_COLLECTION_ID);

    for (const entry of liveEntries) {
      const updatedMembership = {
        groupKey: entry.membership.groupKey,
        collectionId: uncategorizedCollection.id
      };

      await Promise.all(entry.tabs.map((tab) => setTabMembership(tab.id, updatedMembership)));
    }

    const liveGroupKeys = new Set(liveEntries.map((entry) => entry.membership.groupKey));
    for (const snapshotGroup of collection.snapshot.groups) {
      if (liveGroupKeys.has(snapshotGroup.id)) {
        continue;
      }

      const targetGroups = insertSnapshotGroup(
        uncategorizedCollection.snapshot.groups,
        snapshotGroup,
        null,
        'append'
      );
      setCollectionSnapshot(uncategorizedCollection, targetGroups);
    }

    delete state.collections[collectionId];
    await saveState(state);
    const refreshedState = await syncCollections();
    return buildSidebarSnapshot(refreshedState, currentWindowId);
  });
}

async function openCollection(collectionId, targetMode, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  if (targetMode !== 'append' && targetMode !== 'new-window') {
    throw new Error('Unknown collection open mode.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    freezeAutoNamedCollection(state, collectionId);
    const snapshotGroups = collection.snapshot.groups;
    if (!snapshotGroups.length) {
      throw new Error('This collection has no saved groups to open yet.');
    }

    const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
    const liveEntries = entriesByCollection.get(collectionId) || [];
    const groupsToOpen = targetMode === 'append'
      ? getMissingSnapshotGroups(collection, liveEntries)
      : snapshotGroups;

    if (!groupsToOpen.length) {
      return buildSidebarSnapshot(syncedState, currentWindowId);
    }

    let targetWindowId = currentWindowId;
    let seedTab = null;

    if (targetMode === 'new-window') {
      const firstUrl = getRestorableUrl(groupsToOpen[0].tabs[0]?.url);
      const createdWindow = await browser.windows.create({ url: firstUrl });
      targetWindowId = createdWindow.id;
      const tabs = sortTabs(await browser.tabs.query({ windowId: targetWindowId }));
      seedTab = tabs[0] || null;
    } else {
      const placement = getAppendPlacementForCollection(liveEntries, currentWindowId);
      targetWindowId = placement.windowId;
      let nextIndex = placement.index;

      for (const snapshotGroup of groupsToOpen) {
        await restoreSnapshotGroup(snapshotGroup, collectionId, {
          windowId: targetWindowId,
          index: nextIndex
        });
        if (nextIndex !== -1) {
          nextIndex += getSnapshotGroupTabCount(snapshotGroup);
        }
      }

      collection.lastActiveAt = Date.now();
      await saveState(state);

      const refreshedState = await syncCollections();
      return buildSidebarSnapshot(refreshedState, targetWindowId);
    }

    for (let index = 0; index < groupsToOpen.length; index += 1) {
      await createTabsForSnapshotGroup(
        groupsToOpen[index],
        collectionId,
        targetWindowId,
        index === 0 ? seedTab : null
      );
    }

    collection.lastActiveAt = Date.now();
    await saveState(state);

    const refreshedState = await syncCollections();
    return buildSidebarSnapshot(refreshedState, currentWindowId || targetWindowId);
  });
}

async function openGroup(collectionId, snapshotGroupId, currentWindowId) {
  if (!hasRequiredApis()) {
    throw new Error('Tab group APIs are unavailable in this Firefox build.');
  }

  return enqueueOperation(async () => {
    const syncedState = await syncCollections();
    const state = syncedState.state;
    const collection = state.collections[collectionId];

    if (!collection) {
      throw new Error('Collection not found.');
    }

    freezeAutoNamedCollection(state, collectionId);
    const entriesByCollection = buildEntriesByCollection(syncedState.runtime.groupsByWindow);
    const liveEntries = entriesByCollection.get(collectionId) || [];
    const existingLiveEntry = liveEntries.find((entry) => entry.membership.groupKey === snapshotGroupId);
    if (existingLiveEntry) {
      try {
        await browser.tabGroups.update(existingLiveEntry.group.id, { collapsed: false });
      } catch (error) {
        console.debug('Unable to expand tab group before activation.', error);
      }

      await browser.windows.update(existingLiveEntry.windowId, { focused: true });
      await browser.tabs.update(existingLiveEntry.tabs[0].id, { active: true });
      collection.lastActiveAt = Date.now();
      await saveState(state);
      const refreshedState = await syncCollections();
      return buildSidebarSnapshot(refreshedState, existingLiveEntry.windowId);
    }

    const snapshotGroup = collection.snapshot.groups.find((group) => group.id === snapshotGroupId);
    if (!snapshotGroup) {
      throw new Error('Saved group not found.');
    }

    const placement = getAppendPlacementForCollection(liveEntries, currentWindowId);
    const groupId = await restoreSnapshotGroup(snapshotGroup, collectionId, placement);
    collection.lastActiveAt = Date.now();
    await saveState(state);

    try {
      await browser.tabGroups.update(groupId, { collapsed: false });
    } catch (error) {
      console.debug('Unable to expand restored tab group before activation.', error);
    }

    const createdTabs = sortTabs(await browser.tabs.query({ groupId }));
    if (createdTabs.length) {
      await browser.windows.update(createdTabs[0].windowId, { focused: true });
      await browser.tabs.update(createdTabs[0].id, { active: true });
    }

    const refreshedState = await syncCollections();
    return buildSidebarSnapshot(refreshedState, createdTabs[0]?.windowId || placement.windowId);
  });
}

function scheduleSync() {
  if (!hasRequiredApis()) {
    return;
  }

  clearTimeout(syncTimerId);
  syncTimerId = setTimeout(() => {
    syncTimerId = null;
    enqueueOperation(async () => {
      await syncCollections();
    });
  }, SYNC_DELAY_MS);
}

async function openSidebarFromToolbar() {
  if (typeof browser.sidebarAction?.open === 'function') {
    await browser.sidebarAction.open();
    return;
  }

  if (typeof browser.sidebarAction?.toggle === 'function') {
    await browser.sidebarAction.toggle();
  }
}

async function initialize() {
  if (!hasRequiredApis()) {
    await Promise.all([
      browser.browserAction.setTitle({
        title: 'Tab Group Collections: this Firefox build does not expose tab group APIs.'
      }),
      browser.browserAction.setBadgeText({ text: '!' }),
      browser.browserAction.setBadgeBackgroundColor({ color: '#8b2e2e' })
    ]);
    return;
  }

  scheduleSync();
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  if (message.type === 'ui:getThemeMode') {
    return getUiThemeMode().catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:getSnapshot') {
    return getSidebarSnapshot(message.currentWindowId).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:renameCollection') {
    return renameCollection(message.collectionId, message.name, message.currentWindowId).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:createCollection') {
    return createCollection(message.currentWindowId, message.name).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:setCollectionPinned') {
    return setCollectionPinned(
      message.collectionId,
      message.pinned,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:focusCollection') {
    return focusCollection(
      message.collectionId,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:closeCollection') {
    return closeCollection(
      message.collectionId,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:moveGroupToCollection') {
    return moveGroupToCollection(
      message.groupId,
      message.collectionId,
      message.currentWindowId,
      message.targetCollectionName
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:dropGroup') {
    const task = message.sourceKind === 'snapshot'
      ? placeSavedGroup(message.sourceCollectionId, message.snapshotGroupId, {
        targetCollectionId: message.targetCollectionId,
        targetCollectionName: message.targetCollectionName,
        targetGroupId: message.targetGroupId,
        targetSnapshotGroupId: message.targetSnapshotGroupId,
        position: message.position
      }, message.currentWindowId)
      : placeGroup(message.groupId, {
        targetCollectionId: message.targetCollectionId,
        targetCollectionName: message.targetCollectionName,
        targetGroupId: message.targetGroupId,
        targetSnapshotGroupId: message.targetSnapshotGroupId,
        position: message.position
      }, message.currentWindowId);

    return task.catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:deleteCollection') {
    return deleteCollection(
      message.collectionId,
      message.mode,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:activateGroup') {
    return activateGroup(message.groupId).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:renameGroup') {
    return renameGroup(
      message.sourceKind,
      message.groupId,
      message.snapshotGroupId,
      message.collectionId,
      message.title,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:updateGroupColor') {
    return updateGroupColor(
      message.sourceKind,
      message.groupId,
      message.snapshotGroupId,
      message.collectionId,
      message.color,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:createGroup') {
    return createGroup(
      message.collectionId,
      message.currentWindowId,
      message.title
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:openGroup') {
    return openGroup(
      message.collectionId,
      message.snapshotGroupId,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:deleteGroup') {
    return deleteGroup(
      message.sourceKind,
      message.groupId,
      message.snapshotGroupId,
      message.collectionId,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:removeGroupFromCollection') {
    return removeGroupFromCollection(
      message.sourceKind,
      message.groupId,
      message.snapshotGroupId,
      message.collectionId,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  if (message.type === 'sidebar:openCollection') {
    return openCollection(
      message.collectionId,
      message.targetMode,
      message.currentWindowId
    ).catch((error) => ({
      error: error.message
    }));
  }

  return undefined;
});

browser.runtime.onInstalled.addListener(() => {
  initialize().catch(console.error);
});

browser.runtime.onStartup.addListener(() => {
  initialize().catch(console.error);
});

if (hasRequiredApis()) {
  browser.tabGroups.onCreated.addListener(scheduleSync);
  browser.tabGroups.onMoved.addListener(scheduleSync);
  browser.tabGroups.onRemoved.addListener(scheduleSync);
  browser.tabGroups.onUpdated.addListener(scheduleSync);
  browser.tabs.onActivated.addListener(scheduleSync);
  browser.tabs.onAttached.addListener(scheduleSync);
  browser.tabs.onCreated.addListener(scheduleSync);
  browser.tabs.onDetached.addListener(scheduleSync);
  browser.tabs.onMoved.addListener(scheduleSync);
  browser.tabs.onRemoved.addListener(scheduleSync);
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (
      Object.prototype.hasOwnProperty.call(changeInfo, 'groupId') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'pinned') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'url')
    ) {
      scheduleSync();
    }
  });
  browser.windows.onFocusChanged.addListener(scheduleSync);
}

if (browser.browserSettings?.overrideContentColorScheme?.onChange?.addListener) {
  browser.browserSettings.overrideContentColorScheme.onChange.addListener(() => {
    browser.runtime.sendMessage({ type: 'ui:themeModeChanged' }).catch(() => {});
  });
}

initialize().catch(console.error);
