import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Shared = require('../src/shared.js');

test('pickNextGroupColor selects the first unused color before cycling', () => {
  assert.equal(Shared.pickNextGroupColor([]), 'blue');
  assert.equal(Shared.pickNextGroupColor([{ color: 'blue' }, { color: 'cyan' }]), 'green');

  const allColorsUsed = Shared.GROUP_COLOR_SEQUENCE.map((color) => ({ color }));
  assert.equal(Shared.pickNextGroupColor(allColorsUsed), 'blue');
});

test('getRestorableUrl sanitizes unsupported and blank URLs', () => {
  assert.equal(Shared.getRestorableUrl('https://example.com'), 'https://example.com');
  assert.equal(Shared.getRestorableUrl(' about:blank '), 'about:blank');
  assert.equal(Shared.getRestorableUrl('javascript:alert(1)'), 'about:blank');
  assert.equal(Shared.getRestorableUrl('file:///tmp/test.txt'), 'about:blank');
  assert.equal(Shared.getRestorableUrl('about:preferences'), 'about:blank');
  assert.equal(Shared.getRestorableUrl(''), 'about:blank');
});

test('collection and group name helpers normalize and validate inputs', () => {
  assert.equal(Shared.normalizeStoredGroupTitle('  Admin  '), 'Admin');
  assert.equal(Shared.getDisplayGroupTitle('   '), 'Untitled group');
  assert.equal(Shared.getCollectionName('  '), 'Untitled collection');
  assert.equal(Shared.getRequestedCollectionName('  Work  '), 'Work');
  assert.equal(Shared.getRequestedCollectionName(null), null);
  assert.throws(
    () => Shared.getRequestedCollectionName('   '),
    /Collection names cannot be empty\./,
  );
});

test('group color helpers normalize and validate supported colors', () => {
  assert.equal(Shared.getGroupColor('blue'), 'blue');
  assert.equal(Shared.getGroupColor('unsupported'), 'grey');
  assert.equal(Shared.getRequestedGroupColor(' green '), 'green');
  assert.throws(
    () => Shared.getRequestedGroupColor('mauve'),
    /Unsupported tab group color\./,
  );
});

test('insertSnapshotGroup inserts before, after, or appends without mutating input', () => {
  const original = [
    { id: 'a', title: 'One', color: 'blue', collapsed: false, tabs: [{ url: 'https://a.test' }] },
    { id: 'b', title: 'Two', color: 'green', collapsed: false, tabs: [{ url: 'https://b.test' }] },
  ];
  const inserted = { id: 'c', title: 'Three', color: 'red', collapsed: true, tabs: [{ url: 'https://c.test' }] };

  assert.deepEqual(
    Shared.insertSnapshotGroup(original, inserted, 'b', 'before').map((group) => group.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    Shared.insertSnapshotGroup(original, inserted, 'a', 'after').map((group) => group.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    Shared.insertSnapshotGroup(original, inserted, 'missing', 'after').map((group) => group.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    original.map((group) => group.id),
    ['a', 'b'],
  );
});

test('getMissingSnapshotGroups returns only saved groups that are not live', () => {
  const collection = {
    snapshot: {
      groups: [
        { id: 'g1', tabs: [] },
        { id: 'g2', tabs: [] },
        { id: 'g3', tabs: [] },
      ],
    },
  };
  const liveEntries = [
    { membership: { groupKey: 'g2' } },
  ];

  assert.deepEqual(
    Shared.getMissingSnapshotGroups(collection, liveEntries).map((group) => group.id),
    ['g1', 'g3'],
  );
});

test('compareCollections handles pinned, uncategorized, and sort mode rules', () => {
  const collections = [
    { name: 'Beta', isPinned: false, isUncategorized: false, lastActiveAt: 10, snapshotUpdatedAt: 0 },
    { name: 'Alpha', isPinned: true, isUncategorized: false, lastActiveAt: 5, snapshotUpdatedAt: 0 },
    { name: 'Uncategorized', isPinned: false, isUncategorized: true, lastActiveAt: 999, snapshotUpdatedAt: 0 },
    { name: 'Gamma', isPinned: false, isUncategorized: false, lastActiveAt: 20, snapshotUpdatedAt: 0 },
  ];

  const lastActiveSorted = [...collections].sort((left, right) => (
    Shared.compareCollections(left, right, {
      sortMode: 'last-active',
      placeUncategorizedLast: true,
    })
  ));
  assert.deepEqual(lastActiveSorted.map((collection) => collection.name), [
    'Alpha',
    'Gamma',
    'Beta',
    'Uncategorized',
  ]);

  const nameSorted = [...collections].sort((left, right) => (
    Shared.compareCollections(left, right, {
      sortMode: 'name',
      placeUncategorizedLast: true,
    })
  ));
  assert.deepEqual(nameSorted.map((collection) => collection.name), [
    'Alpha',
    'Beta',
    'Gamma',
    'Uncategorized',
  ]);
});

test('filter helpers match collection names and group titles and expose visible groups', () => {
  const snapshot = {
    collections: [
      {
        id: 'work',
        name: 'Work',
        isPinned: false,
        isUncategorized: false,
        lastActiveAt: 10,
        snapshotUpdatedAt: 0,
        groups: [
          { title: 'Admin' },
          { title: 'Docs' },
        ],
      },
      {
        id: 'play',
        name: 'Play',
        isPinned: false,
        isUncategorized: false,
        lastActiveAt: 5,
        snapshotUpdatedAt: 0,
        groups: [
          { title: 'Games' },
        ],
      },
    ],
  };

  assert.equal(Shared.matchesCollectionFilter(snapshot.collections[0], 'work'), true);
  assert.equal(Shared.matchesCollectionFilter(snapshot.collections[0], 'admin'), true);
  assert.equal(Shared.matchesCollectionFilter(snapshot.collections[1], 'admin'), false);

  const filtered = Shared.getFilteredCollections(snapshot, 'admin', { sortMode: 'last-active' });
  assert.deepEqual(filtered.map((collection) => collection.name), ['Work']);
  assert.deepEqual(filtered[0].visibleGroups.map((group) => group.title), ['Admin']);
});

test('summary and preview helpers produce stable compact display text', () => {
  assert.equal(
    Shared.getCollectionPreview({
      groups: [
        { title: 'Default' },
        { title: 'RUG' },
        { title: 'Admin' },
        { title: 'Docs' },
        { title: 'Ignored' },
      ],
    }),
    'Default • RUG • Admin • Docs',
  );

  assert.equal(
    Shared.buildSummaryText({
      totalCollectionCount: 0,
      totalGroupCount: 0,
      collections: [],
    }),
    'No collections yet.',
  );

  assert.equal(
    Shared.buildSummaryText({
      totalCollectionCount: 2,
      totalGroupCount: 5,
      collections: [],
    }),
    '2 collections, 5 groups.',
  );
});
