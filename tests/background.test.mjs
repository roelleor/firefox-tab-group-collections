import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const STORAGE_KEY = 'tab-group-collections.state';
const MEMBERSHIP_KEY = 'tab-group-collections.membership';
const sharedSource = fs.readFileSync(new URL('../src/shared.js', import.meta.url), 'utf8');
const backgroundSource = fs.readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

function savedGroup(id, title, urls = [`https://example.test/${title}`]) {
  return { id, title, color: 'blue', collapsed: false, tabs: urls.map(url => ({ url })) };
}

// Run the real background script, replacing only Firefox's external APIs.
function backgroundFixture(savedGroups, liveGroups) {
  let storedState = {
    collections: { work: { name: 'Work', autoNamed: false, snapshot: { groups: savedGroups } } }
  };
  const memberships = new Map();
  const tabs = [];
  const groups = liveGroups.map((group, index) => {
    for (const savedTab of group.tabs) {
      const tab = {
        id: tabs.length + 1, index: tabs.length, windowId: group.windowId || 1,
        groupId: index + 1, active: false, ...savedTab
      };
      tabs.push(tab);
      memberships.set(tab.id, { collectionId: 'work', groupKey: group.id });
    }
    return { id: index + 1, title: group.title, color: group.color, windowId: group.windowId || 1 };
  });
  const event = { addListener() {} };
  let onMessage;
  const browser = {
    tabGroups: { query: async () => structuredClone(groups), onCreated: event, onMoved: event, onRemoved: event, onUpdated: event },
    tabs: {
      query: async query => structuredClone(query.active ? [] : tabs),
      onActivated: event, onAttached: event, onCreated: event, onDetached: event,
      onMoved: event, onRemoved: event, onUpdated: event
    },
    sessions: {
      getTabValue: async (id, key) => {
        assert.equal(key, MEMBERSHIP_KEY);
        return structuredClone(memberships.get(id));
      },
      setTabValue: async (id, key, value) => {
        assert.equal(key, MEMBERSHIP_KEY);
        memberships.set(id, structuredClone(value));
      }
    },
    storage: { local: {
      get: async key => ({ [key]: structuredClone(storedState) }),
      set: async data => { storedState = structuredClone(data[STORAGE_KEY]); }
    } },
    windows: { onFocusChanged: event },
    browserAction: { setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } }, onInstalled: event, onStartup: event }
  };
  const context = vm.createContext({ browser, crypto: { randomUUID }, console, setTimeout() {}, clearTimeout() {} });
  vm.runInContext(sharedSource, context);
  vm.runInContext(backgroundSource, context);
  return {
    async snapshot() {
      const snapshot = await onMessage({ type: 'sidebar:getSnapshot', currentWindowId: 1 });
      assert.equal(snapshot.error, undefined);
      return structuredClone(snapshot.collections.find(collection => collection.id === 'work'));
    },
    saved: () => storedState.collections.work.snapshot.groups,
    memberships
  };
}

test('sync repairs the repeated group identities shown in a many-group collection', async () => {
  const groups = ['Wed', 'Thu morning', 'Thu afternoon', 'Fri', 'Sat'].map((title, index) => (
    savedGroup(index === 3 ? 'friday-key' : 'shared-key', title)
  ));
  const fixture = backgroundFixture(groups, groups);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.title), ['Wed', 'Thu morning', 'Thu afternoon', 'Fri', 'Sat']);
  assert.equal(new Set(snapshot.groups.map(group => group.runtimeGroupId)).size, 5);
  assert.equal(new Set(snapshot.groups.map(group => group.snapshotGroupId)).size, 5);
  assert.deepEqual(fixture.saved().map(group => group.tabs), groups.map(group => group.tabs));
  const identities = [...fixture.memberships.values()].map(value => value.groupKey);
  await fixture.snapshot();
  assert.deepEqual([...fixture.memberships.values()].map(value => value.groupKey), identities);
});

test('split groups get separate identities even when the new group precedes the original', async () => {
  const original = savedGroup('original-key', 'Original', ['https://a.test', 'https://b.test']);
  const fixture = backgroundFixture([original], [
    savedGroup('original-key', 'Split', ['https://b.test']),
    savedGroup('original-key', 'Original', ['https://a.test'])
  ]);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.title), ['Split', 'Original']);
  assert.equal(snapshot.groups[1].snapshotGroupId, 'original-key');
  assert.notEqual(snapshot.groups[0].snapshotGroupId, 'original-key');
  assert.equal(snapshot.snapshotGroupCount, 2);
});

test('group identity collisions are repaired across windows', async () => {
  const original = savedGroup('same-key', 'Original');
  const other = { ...savedGroup('same-key', 'Other window'), windowId: 2 };
  const fixture = backgroundFixture([original], [original, other]);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.title), ['Original', 'Other window']);
  assert.equal(new Set(snapshot.groups.map(group => group.snapshotGroupId)).size, 2);
  assert.deepEqual(snapshot.groups.map(group => group.locationLabel), ['This window', 'Window 2']);
});

test('repair keeps closed groups when a later duplicate is still live', async () => {
  const closed = savedGroup('same-key', 'Closed original');
  const live = savedGroup('same-key', 'Live split');
  const fixture = backgroundFixture([closed, live], [live]);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => [group.title, group.kind]), [
    ['Closed original', 'snapshot'], ['Live split', 'live']
  ]);
  assert.equal(new Set(fixture.saved().map(group => group.id)).size, 2);
  assert.deepEqual(fixture.saved().map(group => group.tabs), [closed.tabs, live.tabs]);
});

test('repair preserves every closed snapshot with a duplicate identity', async () => {
  const groups = [savedGroup('same-key', 'Closed one'), savedGroup('same-key', 'Closed two')];
  const fixture = backgroundFixture(groups, []);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.title), ['Closed one', 'Closed two']);
  assert.equal(new Set(fixture.saved().map(group => group.id)).size, 2);
  assert.deepEqual(fixture.saved().map(group => group.tabs), groups.map(group => group.tabs));
});

test('sync leaves healthy group identities and closed snapshots intact', async () => {
  const live = savedGroup('live-key', 'Live');
  const closed = savedGroup('closed-key', 'Closed');
  const fixture = backgroundFixture([live, closed], [live]);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.snapshotGroupId), ['live-key', 'closed-key']);
  assert.deepEqual(fixture.saved(), [live, closed]);
});

test('repair uses tab URLs to distinguish identically named groups after tabs change', async () => {
  const closed = savedGroup('same-key', 'Same title', ['https://closed.test/precious']);
  const savedLive = savedGroup('same-key', 'Same title', ['https://live.test']);
  const live = savedGroup('same-key', 'Same title', ['https://live.test', 'https://live.test/new-tab']);
  const fixture = backgroundFixture([closed, savedLive], [live]);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.kind), ['snapshot', 'live']);
  assert.deepEqual(fixture.saved().map(group => group.tabs), [closed.tabs, live.tabs]);
});

test('ambiguous recovery retains saved URLs instead of guessing which snapshot is live', async () => {
  const saved = [
    savedGroup('same-key', 'Same title', ['https://closed.test/one']),
    savedGroup('same-key', 'Same title', ['https://closed.test/two'])
  ];
  const live = savedGroup('same-key', 'Same title', ['https://current.test']);
  const fixture = backgroundFixture(saved, [live]);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.kind), ['snapshot', 'snapshot', 'live']);
  assert.deepEqual(fixture.saved().map(group => group.tabs), [saved[0].tabs, saved[1].tabs, live.tabs]);
  assert.equal(new Set(fixture.saved().map(group => group.id)).size, 3);
});

test('a renamed live group cannot claim a closed snapshot by its title alone', async () => {
  const saved = [
    savedGroup('same-key', 'Closed original', ['https://closed.test/precious']),
    savedGroup('same-key', 'Live original', ['https://live.test'])
  ];
  const live = savedGroup('same-key', 'Closed original', ['https://current.test']);
  const fixture = backgroundFixture(saved, [live]);
  const snapshot = await fixture.snapshot();
  assert.deepEqual(snapshot.groups.map(group => group.kind), ['snapshot', 'snapshot', 'live']);
  assert.deepEqual(fixture.saved().map(group => group.tabs), [saved[0].tabs, saved[1].tabs, live.tabs]);
});

test('a shared URL does not let a live group overwrite other saved URLs', async () => {
  const saved = [
    savedGroup('same-key', 'Same title', ['https://common.test', 'https://closed.test/precious']),
    savedGroup('same-key', 'Same title', ['https://old-live.test'])
  ];
  const live = savedGroup('same-key', 'Same title', ['https://common.test', 'https://current.test']);
  const fixture = backgroundFixture(saved, [live]);
  await fixture.snapshot();
  assert.deepEqual(fixture.saved().map(group => group.tabs), [saved[0].tabs, saved[1].tabs, live.tabs]);
});
