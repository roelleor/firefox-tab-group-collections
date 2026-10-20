import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();
const EXTENSION_PACKAGE_PATH = path.join(ROOT_DIR, 'dist', 'tab-group-collections.zip');
const EXTENSION_ID = '{E6A63954-988C-4D10-BB29-754B8F7EAB4E}';

const commonFirefoxBinaries = [
  process.env.FIREFOX_BIN,
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/snap/bin/firefox',
].filter(Boolean);

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveFirefoxBinary() {
  for (const candidate of commonFirefoxBinaries) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function buildExtensionPackage() {
  await execFileAsync('./build.sh', { cwd: ROOT_DIR });
}

async function waitForExtensionUuid(profileDir) {
  const prefsPath = path.join(profileDir, 'prefs.js');

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await pathExists(prefsPath)) {
      const prefsText = await fs.readFile(prefsPath, 'utf8');
      const match = prefsText.match(/user_pref\("extensions\.webextensions\.uuids", "((?:[^"\\]|\\.)*)"\);/);

      if (match) {
        const rawJson = JSON.parse(`"${match[1]}"`);
        const mapping = JSON.parse(rawJson);
        const extensionUuid = mapping[EXTENSION_ID];
        if (extensionUuid) {
          return extensionUuid;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Could not resolve moz-extension UUID from Firefox profile.');
}

async function executeAsync(driver, script, ...args) {
  return driver.executeAsyncScript(script, ...args);
}

async function getCurrentWindowId(driver) {
  return executeAsync(
    driver,
    function (done) {
      browser.tabs.query({ currentWindow: true }).then((tabs) => {
        done(tabs[0]?.windowId ?? null);
      }, (error) => {
        done({ __error: error.message || String(error) });
      });
    },
  );
}

async function sendRuntimeMessage(driver, payload) {
  const response = await executeAsync(
    driver,
    function (message, done) {
      browser.runtime.sendMessage(message).then(done, (error) => {
        done({ __transportError: error.message || String(error) });
      });
    },
    payload,
  );

  if (response?.__transportError) {
    throw new Error(response.__transportError);
  }

  if (response?.error) {
    throw new Error(response.error);
  }

  return response;
}

async function seedCollections(driver) {
  const currentWindowId = await getCurrentWindowId(driver);
  assert.ok(currentWindowId, 'A Firefox window ID should be available.');

  const workSnapshot = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection',
    currentWindowId,
    name: 'Work'
  });
  const workCollectionId = workSnapshot.createdCollectionId;
  assert.ok(workCollectionId, 'Work collection should be created.');

  await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup',
    currentWindowId,
    collectionId: workCollectionId,
    title: 'Admin'
  });

  const throwawaySnapshot = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection',
    currentWindowId,
    name: 'Throwaway'
  });
  const throwawayCollectionId = throwawaySnapshot.createdCollectionId;
  assert.ok(throwawayCollectionId, 'Throwaway collection should be created.');

  await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup',
    currentWindowId,
    collectionId: throwawayCollectionId,
    title: 'Loose tab'
  });

  await sendRuntimeMessage(driver, {
    type: 'sidebar:deleteCollection',
    currentWindowId,
    collectionId: throwawayCollectionId,
    mode: 'collection-only'
  });
}

async function waitForBodyText(driver, matcher, timeout = 10000) {
  await driver.wait(async () => {
    const bodyText = await driver.findElement(By.css('body')).getText();
    return typeof matcher === 'string'
      ? bodyText.includes(matcher)
      : matcher.test(bodyText);
  }, timeout);
}

async function launchExtension(t) {
  await buildExtensionPackage();

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-group-collections-e2e-'));
  const options = new firefox.Options().addArguments('-no-remote', '-profile', profileDir);
  const firefoxBinary = await resolveFirefoxBinary();
  if (firefoxBinary) {
    options.setBinary(firefoxBinary);
  }
  if (!process.env.E2E_FIREFOX_HEADFUL) {
    options.addArguments('-headless');
  }

  let driver;
  t.after(async () => {
    try {
      if (driver) await driver.quit();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  // Firefox restricts WebDriver access to extension pages. Enable it only in
  // this disposable test process, which cannot connect to a running profile.
  const service = new firefox.ServiceBuilder().setEnvironment({
    ...process.env,
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1'
  });
  driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();

  await driver.installAddon(EXTENSION_PACKAGE_PATH, true);
  const extensionUuid = await waitForExtensionUuid(profileDir);
  const extensionBaseUrl = `moz-extension://${extensionUuid}`;

  await driver.get(`${extensionBaseUrl}/src/sidebar.html`);
  await driver.wait(until.elementLocated(By.css('main.app')), 10000);

  return { driver, extensionBaseUrl };
}

test('extension popup hides Uncategorized while sidebar still shows it', async (t) => {
  const { driver, extensionBaseUrl } = await launchExtension(t);
  await seedCollections(driver);

  await driver.navigate().refresh();
  await waitForBodyText(driver, /\bWork\b/);
  await waitForBodyText(driver, /\bUncategorized\b/);

  const sidebarBodyText = await driver.findElement(By.css('body')).getText();
  assert.match(sidebarBodyText, /\bWork\b/, 'Sidebar should show the regular Work collection.');
  assert.match(sidebarBodyText, /\bUncategorized\b/, 'Sidebar should show the Uncategorized section.');
  assert.match(sidebarBodyText, /\bLoose tab\b/, 'Sidebar should show the uncategorized group.');

  await driver.get(`${extensionBaseUrl}/src/popup.html`);
  await driver.wait(until.elementLocated(By.css('main.popup')), 10000);
  await waitForBodyText(driver, /\bWork\b/);

  const popupBodyText = await driver.findElement(By.css('body')).getText();
  assert.match(popupBodyText, /\bWork\b/, 'Popup should include the Work collection.');
  assert.doesNotMatch(popupBodyText, /\bUncategorized\b/, 'Popup should not expose Uncategorized.');
  assert.doesNotMatch(popupBodyText, /\bLoose tab\b/, 'Popup should not expose uncategorized groups.');
});

async function extensionCall(driver, action, ...args) {
  const source = `const done = arguments[arguments.length - 1];
    (${action.toString()})(...Array.from(arguments).slice(0, -1)).then(
      value => done({ value }), error => done({ error: error.message || String(error) })
    );`;
  const result = await executeAsync(driver, source, ...args);
  assert.equal(result.error, undefined);
  return result.value;
}

async function assertRenderedGroupTitles(driver, expected) {
  await driver.navigate().refresh();
  await driver.wait(async () => {
    // Read the titles together: background sync can replace rows between
    // separate WebDriver calls and make previously found elements stale.
    const text = await driver.executeScript(function () {
      return Array.from(document.querySelectorAll('.group-title'), title => title.textContent);
    });
    return JSON.stringify(text) === JSON.stringify(expected);
  }, 10000, 'Sidebar should render every distinct native group once.');
}

for (const mode of ['split', 'duplicate']) {
  test(`${mode} grouped tabs retain distinct names through sync and reopening`, async (t) => {
    const { driver } = await launchExtension(t);
    const currentWindowId = await getCurrentWindowId(driver);
    const created = await sendRuntimeMessage(driver, {
      type: 'sidebar:createCollection', currentWindowId, name: 'Synthetic groups'
    });
    const collectionId = created.createdCollectionId;
    const getCollection = snapshot => snapshot.collections.find(collection => collection.id === collectionId);
    const original = await sendRuntimeMessage(driver, {
      type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Original group'
    });
    const originalGroup = getCollection(original).groups[0];
    const tabId = await extensionCall(driver, async (groupId, mode) => {
      const [originalTab] = await browser.tabs.query({ groupId });
      const tab = mode === 'duplicate'
        ? await browser.tabs.duplicate(originalTab.id)
        : await browser.tabs.create({ url: 'about:blank', active: false });
      await browser.tabs.group({ groupId, tabIds: [tab.id] });
      return tab.id;
    }, originalGroup.runtimeGroupId, mode);
    // Stamp both tabs with the original membership before splitting the group.
    await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
    const splitGroupId = await extensionCall(driver, async tabId => {
      const groupId = await browser.tabs.group({ tabIds: [tabId] });
      await browser.tabGroups.update(groupId, { title: 'Split-off group', color: 'red' });
      return groupId;
    }, tabId);
    const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
    const collection = getCollection(snapshot);
    assert.deepEqual(collection.groups.map(group => group.title), ['Original group', 'Split-off group']);
    assert.deepEqual(collection.groups.map(group => group.runtimeGroupId), [originalGroup.runtimeGroupId, splitGroupId]);
    assert.equal(new Set(collection.groups.map(group => group.snapshotGroupId)).size, 2);
    assert.equal(collection.groups[0].snapshotGroupId, originalGroup.snapshotGroupId);
    await assertRenderedGroupTitles(driver, ['Original group', 'Split-off group']);

    const closed = await sendRuntimeMessage(driver, {
      type: 'sidebar:closeCollection', currentWindowId, collectionId
    });
    assert.equal(getCollection(closed).liveGroupCount, 0);
    assert.deepEqual(getCollection(closed).groups.map(group => group.title), ['Original group', 'Split-off group']);
    const reopened = await sendRuntimeMessage(driver, {
      type: 'sidebar:openCollection', currentWindowId, collectionId, targetMode: 'append'
    });
    assert.equal(getCollection(reopened).liveGroupCount, 2);
    assert.deepEqual(getCollection(reopened).groups.map(group => group.snapshotGroupId), collection.groups.map(group => group.snapshotGroupId));
    await assertRenderedGroupTitles(driver, ['Original group', 'Split-off group']);
  });
}

test('sync repairs an already-collided many-group collection without extra sidebar rows', async (t) => {
  const { driver } = await launchExtension(t);
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection', currentWindowId, name: 'Synthetic recovery'
  });
  const collectionId = created.createdCollectionId;
  const titles = ['Wednesday', 'Thursday morning', 'Thursday afternoon', 'Friday', 'Saturday'];
  for (const title of titles) {
    await sendRuntimeMessage(driver, { type: 'sidebar:createGroup', currentWindowId, collectionId, title });
  }
  await extensionCall(driver, async collectionId => {
    const storageKey = 'tab-group-collections.state';
    const membershipKey = 'tab-group-collections.membership';
    const state = (await browser.storage.local.get(storageKey))[storageKey];
    const groups = await browser.tabGroups.query({});
    for (let index = 0; index < groups.length; index += 1) {
      const groupKey = index === 3 ? 'friday-key' : 'shared-key';
      state.collections[collectionId].snapshot.groups[index].id = groupKey;
      for (const tab of await browser.tabs.query({ groupId: groups[index].id })) {
        await browser.sessions.setTabValue(tab.id, membershipKey, { collectionId, groupKey });
      }
    }
    await browser.storage.local.set({ [storageKey]: state });
  }, collectionId);
  const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  const collection = snapshot.collections.find(collection => collection.id === collectionId);
  assert.deepEqual(collection.groups.map(group => group.title), titles);
  assert.equal(collection.snapshotGroupCount, 5);
  assert.equal(new Set(collection.groups.map(group => group.snapshotGroupId)).size, 5);
  assert.equal(new Set(collection.groups.map(group => group.runtimeGroupId)).size, 5);
  await assertRenderedGroupTitles(driver, titles);
});
