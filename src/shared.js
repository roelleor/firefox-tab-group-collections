(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.TabGroupCollectionsShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_COLLECTION_NAME = 'Untitled collection';
  const DEFAULT_GROUP_COLOR = 'grey';
  const UNCATEGORIZED_COLLECTION_ID = 'collection-uncategorized';
  const UNCATEGORIZED_COLLECTION_NAME = 'Uncategorized';
  const GROUP_COLOR_SEQUENCE = [
    'blue',
    'cyan',
    'green',
    'orange',
    'pink',
    'purple',
    'red',
    'yellow',
    'grey'
  ];

  function localeCompareByName(leftName, rightName) {
    return leftName.localeCompare(rightName, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  function normalizeStoredGroupTitle(title) {
    return typeof title === 'string' ? title.trim() : '';
  }

  function getDisplayGroupTitle(title) {
    return normalizeStoredGroupTitle(title) || 'Untitled group';
  }

  function getCollectionName(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    return trimmed || DEFAULT_COLLECTION_NAME;
  }

  function isUncategorizedCollectionId(collectionId) {
    return collectionId === UNCATEGORIZED_COLLECTION_ID;
  }

  function getRequestedCollectionName(name) {
    if (name === undefined || name === null) {
      return null;
    }

    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      throw new Error('Collection names cannot be empty.');
    }

    return trimmed;
  }

  function getGroupColor(color) {
    return typeof color === 'string' && GROUP_COLOR_SEQUENCE.includes(color)
      ? color
      : DEFAULT_GROUP_COLOR;
  }

  function getRequestedGroupColor(color) {
    const normalized = typeof color === 'string' ? color.trim() : '';
    if (!GROUP_COLOR_SEQUENCE.includes(normalized)) {
      throw new Error('Unsupported tab group color.');
    }

    return normalized;
  }

  function pickNextGroupColor(groups) {
    const usedColors = new Set(groups.map((group) => getGroupColor(group.color)));
    const unusedColor = GROUP_COLOR_SEQUENCE.find((color) => !usedColors.has(color));
    if (unusedColor) {
      return unusedColor;
    }

    return GROUP_COLOR_SEQUENCE[groups.length % GROUP_COLOR_SEQUENCE.length];
  }

  function getSnapshotUrl(url) {
    return typeof url === 'string' ? url : '';
  }

  function getRestorableUrl(url) {
    const trimmed = typeof url === 'string' ? url.trim() : '';

    if (!trimmed) {
      return 'about:blank';
    }

    if (
      /^(javascript|data|file|chrome|resource|view-source):/i.test(trimmed) ||
      /^about:(?!blank$)/i.test(trimmed)
    ) {
      return 'about:blank';
    }

    return trimmed;
  }

  function cloneSnapshotGroup(group) {
    return {
      id: typeof group?.id === 'string' ? group.id : '',
      title: normalizeStoredGroupTitle(group?.title),
      color: getGroupColor(group?.color),
      collapsed: Boolean(group?.collapsed),
      tabs: Array.isArray(group?.tabs)
        ? group.tabs.map((tab) => ({
          url: getSnapshotUrl(tab?.url)
        }))
        : []
    };
  }

  function insertSnapshotGroup(groups, snapshotGroup, targetSnapshotGroupId, position) {
    const nextGroups = groups.map((group) => cloneSnapshotGroup(group));
    const normalizedGroup = cloneSnapshotGroup(snapshotGroup);

    if (!targetSnapshotGroupId) {
      nextGroups.push(normalizedGroup);
      return nextGroups;
    }

    const targetIndex = nextGroups.findIndex((group) => group.id === targetSnapshotGroupId);
    if (targetIndex === -1) {
      nextGroups.push(normalizedGroup);
      return nextGroups;
    }

    const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
    nextGroups.splice(insertIndex, 0, normalizedGroup);
    return nextGroups;
  }

  function getSnapshotGroupTabCount(snapshotGroup) {
    return Math.max(snapshotGroup.tabs.length, 1);
  }

  function getMissingSnapshotGroups(collection, liveEntries) {
    const liveGroupKeys = new Set(liveEntries.map((entry) => entry.membership.groupKey));
    return collection.snapshot.groups.filter((group) => !liveGroupKeys.has(group.id));
  }

  function getCollectionSortValue(collection) {
    return collection.lastActiveAt || collection.snapshotUpdatedAt || 0;
  }

  function compareCollections(left, right, options = {}) {
    const sortMode = options.sortMode || 'last-active';
    const placeUncategorizedLast = Boolean(options.placeUncategorizedLast);

    if (placeUncategorizedLast && left.isUncategorized !== right.isUncategorized) {
      return left.isUncategorized ? 1 : -1;
    }

    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }

    if (sortMode === 'name') {
      return localeCompareByName(left.name, right.name);
    }

    return (
      getCollectionSortValue(right) - getCollectionSortValue(left) ||
      localeCompareByName(left.name, right.name)
    );
  }

  function normalizeFilterText(filterText) {
    return typeof filterText === 'string' ? filterText.trim().toLowerCase() : '';
  }

  function matchesCollectionFilter(collection, normalizedFilter) {
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

  function getFilteredCollections(snapshot, filterText, options = {}) {
    const normalizedFilter = normalizeFilterText(filterText);
    const collections = snapshot.collections
      .filter((collection) => matchesCollectionFilter(collection, normalizedFilter))
      .map((collection) => ({
        ...collection,
        visibleGroups: getVisibleGroups(collection, normalizedFilter)
      }));

    collections.sort((left, right) => compareCollections(left, right, options));
    return collections;
  }

  function getCollectionPreview(collection) {
    return collection.groups
      .map((group) => group.title)
      .filter(Boolean)
      .slice(0, 4)
      .join(' • ');
  }

  function buildSummaryText(snapshot) {
    if (!snapshot.totalCollectionCount) {
      return 'No collections yet.';
    }

    const totalGroupCount = Number.isFinite(snapshot.totalGroupCount)
      ? snapshot.totalGroupCount
      : snapshot.collections.reduce((count, collection) => count + collection.groups.length, 0);
    const collectionLabel = snapshot.totalCollectionCount === 1 ? 'collection' : 'collections';
    const groupLabel = totalGroupCount === 1 ? 'group' : 'groups';

    return `${snapshot.totalCollectionCount} ${collectionLabel}, ${totalGroupCount} ${groupLabel}.`;
  }

  return {
    DEFAULT_COLLECTION_NAME,
    DEFAULT_GROUP_COLOR,
    UNCATEGORIZED_COLLECTION_ID,
    UNCATEGORIZED_COLLECTION_NAME,
    GROUP_COLOR_SEQUENCE,
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
    getSnapshotGroupTabCount,
    getMissingSnapshotGroups,
    getCollectionSortValue,
    compareCollections,
    normalizeFilterText,
    matchesCollectionFilter,
    getVisibleGroups,
    getFilteredCollections,
    getCollectionPreview,
    buildSummaryText,
  };
});
