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
function backgroundFixture(savedGroups, liveGroups, { cancelTabId = null, failTabId = null, retainClosedSessions = true } = {}) {
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
  const removedTabIds = [];
  const recentlyClosed = [];
  const loggedErrors = [];
  let nextTabId = 1000;
  let onMessage;
  const browser = {
    tabGroups: {
      query: async () => structuredClone(groups),
      update: async (id, properties) => Object.assign(groups.find(group => group.id === id), properties),
      onCreated: event, onMoved: event, onRemoved: event, onUpdated: event
    },
    tabs: {
      query: async query => structuredClone(query.active ? [] : tabs.filter(tab => (
        (query.windowId === undefined || query.windowId === tab.windowId) &&
        (query.groupId === undefined || query.groupId === tab.groupId)
      ))),
      create: async properties => {
        const tab = { id: nextTabId++, index: tabs.length, groupId: -1, ...properties };
        tabs.push(tab);
        return structuredClone(tab);
      },
      get: async id => {
        const tab = tabs.find(tab => tab.id === id);
        if (!tab) throw new Error('Invalid tab ID');
        return structuredClone(tab);
      },
      group: async ({ groupId, createProperties, tabIds }) => {
        if (groupId === undefined) {
          groupId = Math.max(0, ...groups.map(group => group.id)) + 1;
          groups.push({ id: groupId, windowId: createProperties.windowId });
        }
        for (const tab of tabs.filter(tab => tabIds.includes(tab.id))) tab.groupId = groupId;
        return groupId;
      },
      remove: async ids => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          removedTabIds.push(id);
          if (id === failTabId) throw new Error('Tab removal failed');
          if (id === cancelTabId) continue;
          const index = tabs.findIndex(tab => tab.id === id);
          if (index !== -1) {
            const [tab] = tabs.splice(index, 1);
            recentlyClosed.unshift({ tab: { ...tab, sessionId: String(id) } });
          }
          for (let index = groups.length - 1; index >= 0; index--) {
            if (!tabs.some(tab => tab.groupId === groups[index].id)) groups.splice(index, 1);
          }
        }
      },
      onActivated: event, onAttached: event, onCreated: event, onDetached: event,
      onMoved: event, onRemoved: event, onUpdated: event
    },
    sessions: {
      getRecentlyClosed: async () => structuredClone(retainClosedSessions ? recentlyClosed : []),
      restore: async sessionId => {
        const index = recentlyClosed.findIndex(session => session.tab.sessionId === sessionId);
        const [{ tab }] = recentlyClosed.splice(index, 1);
        const restored = { ...tab, id: nextTabId++ };
        tabs.push(restored);
        memberships.set(restored.id, memberships.get(tab.id));
        return { tab: restored };
      },
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
  const context = vm.createContext({
    browser, crypto: { randomUUID }, console: { ...console, error: error => loggedErrors.push(error) },
    setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(backgroundSource, context);
  return {
    async snapshot() {
      const snapshot = await onMessage({ type: 'sidebar:getSnapshot', currentWindowId: 1 });
      assert.equal(snapshot.error, undefined);
      return structuredClone(snapshot.collections.find(collection => collection.id === 'work'));
    },
    saved: () => storedState.collections.work.snapshot.groups,
    stored: () => structuredClone(storedState),
    send: message => onMessage({ currentWindowId: 1, ...message }),
    memberships,
    tabs,
    groups,
    removedTabIds
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

for (const action of ['closeCollection', 'deleteGroup', 'deleteCollection']) {
  test(`${action} stops when closing is canceled and retains the collection and group identity`, async () => {
    const group = savedGroup('wed-key', 'Wed games', ['https://games.test/one', 'https://games.test/two']);
    const fixture = backgroundFixture([group], [group], { cancelTabId: 1 });
    const result = await fixture.send({
      type: `sidebar:${action}`, collectionId: 'work', sourceKind: 'live',
      groupId: 1, mode: 'collection-and-groups'
    });
    assert.match(result.error || '', /cancel/i);
    assert.deepEqual(fixture.saved(), [group], 'A canceled delete must keep its saved group.');
    assert.deepEqual(fixture.tabs.filter(tab => tab.groupId === 1).map(tab => tab.id), [1, 2]);
    assert.deepEqual(fixture.memberships.get(1), { collectionId: 'work', groupKey: 'wed-key' });
    assert.equal(fixture.groups.length, 1);
    assert.equal(fixture.removedTabIds.includes(2), false, 'Cancellation must stop further tab closures.');
    assert.equal(fixture.tabs.some(tab => tab.groupId === -1), false, 'An unused placeholder must be cleaned up.');
  });
}

test('a partial delete failure retains the surviving group identity and saved record', async () => {
  const group = savedGroup('wed-key', 'Wed games', ['https://games.test/one', 'https://games.test/two']);
  const fixture = backgroundFixture([group], [group], { failTabId: 2 });
  const result = await fixture.send({ type: 'sidebar:deleteGroup', collectionId: 'work', sourceKind: 'live', groupId: 1 });
  assert.equal(result.error, 'Tab removal failed');
  assert.equal(fixture.saved().length, 1, 'Keep the saved record until tab removal succeeds.');
  const snapshot = await fixture.snapshot();
  assert.equal(snapshot.liveGroupCount, 1);
  assert.equal(snapshot.groups[0].snapshotGroupId, 'wed-key');
  assert.deepEqual(fixture.tabs.map(tab => tab.id), [2]);
});

test('a canceled Close without undo history preserves closed browser-page URLs in a recovery collection', async () => {
  const group = savedGroup('wed-key', 'Wed games', ['about:config', 'https://games.test/two']);
  const fixture = backgroundFixture([group], [group], { cancelTabId: 2, retainClosedSessions: false });
  const result = await fixture.send({ type: 'sidebar:closeCollection', collectionId: 'work' });
  assert.match(result.error || '', /Recovered tabs/);
  await fixture.snapshot();
  const savedUrls = Object.values(fixture.stored().collections).flatMap(c => c.snapshot.groups.flatMap(g => g.tabs.map(t => t.url)));
  assert.deepEqual(savedUrls.sort(), ['about:config', 'https://games.test/two'].sort());
  assert.equal(fixture.tabs.some(tab => tab.url === 'about:blank'), false);
});

test('closing all visible tabs leaves a visible placeholder and preserves unrelated hidden tabs', async () => {
  const group = savedGroup('wed-key', 'Wed games');
  const fixture = backgroundFixture([group], [group]);
  fixture.tabs.push({ id: 42, index: 1, windowId: 1, groupId: -1, url: 'https://hidden.test', hidden: true });
  const result = await fixture.send({ type: 'sidebar:closeCollection', collectionId: 'work' });
  assert.equal(result.error, undefined);
  assert.equal(fixture.tabs.some(tab => tab.id === 42), true);
  assert.equal(fixture.tabs.filter(tab => !tab.hidden).length, 1);
  assert.equal(fixture.tabs.find(tab => !tab.hidden).url, 'about:blank');
});

test('a Close canceled on its second tab retains both saved URLs after sync', async () => {
  const group = savedGroup('wed-key', 'Wed games', ['https://games.test/one', 'https://games.test/two']);
  const fixture = backgroundFixture([group], [group], { cancelTabId: 2 });
  const result = await fixture.send({ type: 'sidebar:closeCollection', collectionId: 'work' });
  assert.match(result.error || '', /cancel/i);
  await fixture.snapshot();
  assert.deepEqual(fixture.saved().map(group => group.tabs), [group.tabs]);
});
