import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

import { Builder, By, Key, until } from 'selenium-webdriver';
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

async function launchExtension(t, { toolbarPopup = false, classicScrollbars = false } = {}) {
  await buildExtensionPackage();

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-group-collections-e2e-'));
  const options = new firefox.Options().addArguments('-no-remote', '-profile', profileDir);
  if (toolbarPopup) {
    options.setPreference('extensions.openPopupWithoutUserGesture.enabled', true);
  }
  if (classicScrollbars) {
    options.setPreference('ui.useOverlayScrollbars', 0);
  }
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

test('review invitations stay available, share cooldowns, and open this extension’s reviews', async t => {
  const { driver, extensionBaseUrl } = await launchExtension(t);
  const reviewKey = 'tab-group-collections.review-prompt';
  const reviewUrl = 'https://addons.mozilla.org/en-US/firefox/addon/tab-group-collections/reviews/';
  await driver.wait(async () => (await extensionCall(driver, async key =>
    (await browser.storage.local.get(key))[key], reviewKey))?.firstUsedAt, 10000);
  assert.equal(await driver.findElement(By.css('[data-review-card]')).isDisplayed(), false);
  const currentWindowId = await getCurrentWindowId(driver);
  const work = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection', currentWindowId, name: 'Work'
  });
  await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup', currentWindowId, collectionId: work.createdCollectionId, title: 'Admin'
  });
  await waitForBodyText(driver, 'Admin');
  await driver.findElement(By.css('.pin-toggle-button')).click();
  await driver.wait(async () => (await extensionCall(driver, async key =>
    (await browser.storage.local.get(key))[key], reviewKey)).activeDays.length === 1, 10000);

  await extensionCall(driver, async key => {
    await browser.storage.local.set({ [key]: {
      firstUsedAt: Date.now() - 20 * 86400000,
      activeDays: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'],
      nextPromptAt: 0, lastDismissedAt: 0, lastReviewAt: 0
    } });
  }, reviewKey);
  await driver.navigate().refresh();
  const card = await driver.findElement(By.css('[data-review-card]'));
  await driver.wait(until.elementIsVisible(card), 10000);
  assert.equal(await driver.findElement(By.css('.review-footer')).isDisplayed(), true);
  assert.equal(await driver.findElement(By.css('.review-footer a')).getAttribute('href'), reviewUrl);

  async function screenshot(name, selector) {
    if (!process.env.E2E_SCREENSHOTS_DIR) return;
    await fs.mkdir(process.env.E2E_SCREENSHOTS_DIR, { recursive: true });
    await driver.executeScript('window.scrollTo(0, 0)');
    await executeAsync(driver, done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const image = await driver.findElement(By.css(selector)).takeScreenshot(true);
    await fs.writeFile(path.join(process.env.E2E_SCREENSHOTS_DIR, name), image, 'base64');
  }
  // Allow for Firefox's automatically opened native sidebar beside this test tab.
  await driver.manage().window().setRect({ width: 800, height: 1050 });
  const contentWidth = await driver.executeScript('return innerWidth');
  await driver.manage().window().setRect({ width: 800 + 380 - contentWidth, height: 1050 });
  await extensionCall(driver, async () => browser.browserSettings.overrideContentColorScheme.set({ value: 'light' }));
  await driver.wait(async () => await driver.executeScript('return document.documentElement.dataset.theme') === 'light', 5000);
  await screenshot('sidebar-light.png', 'main');
  await extensionCall(driver, async () => browser.browserSettings.overrideContentColorScheme.set({ value: 'dark' }));
  await driver.wait(async () => await driver.executeScript('return document.documentElement.dataset.theme') === 'dark', 5000);
  await screenshot('sidebar-dark.png', 'main');
  await driver.findElement(By.css('[data-review-dismiss]')).sendKeys(Key.ENTER);
  await driver.wait(until.elementIsNotVisible(card), 10000);
  assert.equal(await driver.executeScript('return document.activeElement.id'), 'filter-input');
  assert.equal(await driver.findElement(By.css('.review-footer')).isDisplayed(), true);
  const paused = await extensionCall(driver, async key =>
    (await browser.storage.local.get(key))[key], reviewKey);
  assert.ok(paused.lastDismissedAt > 0);

  await driver.navigate().refresh();
  await waitForBodyText(driver, 'Work');
  assert.equal(await driver.findElement(By.css('[data-review-card]')).isDisplayed(), false);
  await driver.get(`${extensionBaseUrl}/src/popup.html`);
  await waitForBodyText(driver, 'Work');
  assert.equal(await driver.findElement(By.css('.review-footer a')).getAttribute('href'), reviewUrl);
  assert.equal(await driver.executeScript('return document.activeElement.id'), 'popup-search');
  const dimensions = await driver.executeScript('return {width: document.body.clientWidth, scroll: document.body.scrollWidth, viewport: innerWidth}');
  assert.equal(dimensions.width, 280, JSON.stringify(dimensions));
  assert.equal(dimensions.scroll <= dimensions.width, true, JSON.stringify(dimensions));
  await extensionCall(driver, async () => browser.browserSettings.overrideContentColorScheme.set({ value: 'light' }));
  await driver.wait(async () => await driver.executeScript('return document.documentElement.dataset.theme') === 'light', 5000);
  await screenshot('quick-panel-light.png', 'main');
  await extensionCall(driver, async () => browser.browserSettings.overrideContentColorScheme.set({ value: 'dark' }));
  await driver.wait(async () => await driver.executeScript('return document.documentElement.dataset.theme') === 'dark', 5000);
  await screenshot('quick-panel-dark.png', 'main');

  const before = await extensionCall(driver, async () =>
    (await browser.storage.local.get('tab-group-collections.state'))['tab-group-collections.state']);
  const sourceHandle = await driver.getWindowHandle();
  const handlesBeforeReview = await driver.getAllWindowHandles();
  await driver.findElement(By.css('.review-footer a')).sendKeys(Key.ENTER);
  await driver.switchTo().window(sourceHandle);
  await driver.wait(async () => (await extensionCall(driver, async () =>
    browser.tabs.query({}))).some(tab => tab.url === reviewUrl), 10000);
  const reviewed = await extensionCall(driver, async key =>
    (await browser.storage.local.get(key))[key], reviewKey);
  assert.ok(reviewed.nextPromptAt > Date.now() + 360 * 86400000);
  const after = await extensionCall(driver, async () =>
    (await browser.storage.local.get('tab-group-collections.state'))['tab-group-collections.state']);
  assert.deepEqual(after, before, 'Review actions must leave every collection and saved tab unchanged.');
  if (process.env.E2E_VERIFY_REVIEW_PAGE) {
    const reviewHandle = (await driver.getAllWindowHandles()).find(handle => !handlesBeforeReview.includes(handle));
    assert.ok(reviewHandle, 'The review link should open a new browser tab.');
    await driver.switchTo().window(reviewHandle);
    await driver.wait(until.titleMatches(/^Reviews for Tab Group Collections/), 20000);
    assert.equal(await driver.getCurrentUrl(), reviewUrl);
    assert.match(await driver.findElement(By.css('h1')).getText(), /Tab Group Collections/);
    console.log('Verified live Mozilla review page:', await driver.getTitle());
  }
});

test('popup searches collection and live or saved group names without changing stored data', async (t) => {
  const { driver, extensionBaseUrl } = await launchExtension(t);
  const currentWindowId = await getCurrentWindowId(driver);
  const ids = {};
  for (const [name, titles] of [
    ['Design', ['Design system']],
    ['Work', ['Newsletter design', 'Design review']],
    ['Archive', ['Design archive']],
    ['Reading', ['Articles']]
  ]) {
    const created = await sendRuntimeMessage(driver, {
      type: 'sidebar:createCollection', currentWindowId, name
    });
    ids[name] = created.createdCollectionId;
    for (const title of titles) {
      await sendRuntimeMessage(driver, {
        type: 'sidebar:createGroup', currentWindowId, collectionId: ids[name], title
      });
    }
  }
  await sendRuntimeMessage(driver, {
    type: 'sidebar:closeCollection', currentWindowId, collectionId: ids.Archive
  });
  for (const collectionId of [ids.Design, ids.Work]) {
    await sendRuntimeMessage(driver, {
      type: 'sidebar:setCollectionPinned', currentWindowId, collectionId, pinned: true
    });
  }
  // This page exists only in the disposable test profile. Its title must never
  // make its Reading collection appear in a search for "design".
  const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  const readingGroup = snapshot.collections.find(collection => collection.id === ids.Reading).groups[0];
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Design tab title only</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pageUrl = `http://127.0.0.1:${server.address().port}/tab-url-only`;
  const tabId = await extensionCall(driver, async (groupId, url) => {
    const tab = await browser.tabs.create({ url, active: false });
    await browser.tabs.group({ groupId, tabIds: [tab.id] });
    return tab.id;
  }, readingGroup.runtimeGroupId, pageUrl);
  await driver.wait(async () => (
    await extensionCall(driver, async id => (await browser.tabs.get(id)).title, tabId)
  ) === 'Design tab title only', 10000);

  await driver.get(`${extensionBaseUrl}/src/popup.html`);
  await waitForBodyText(driver, /\bArchive\b/);
  const searchInputs = await driver.findElements(By.css('#popup-search'));
  assert.equal(searchInputs.length, 1, 'The popup should provide a search field.');
  const input = searchInputs[0];
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  await input.sendKeys(Key.TAB);
  assert.equal(await driver.executeScript(() => document.activeElement.classList.contains('collection-link')), true,
    'Tab from an empty search should reach the collection list.');
  await driver.switchTo().activeElement().sendKeys(Key.chord(Key.SHIFT, Key.TAB));
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  const storedBefore = await extensionCall(driver, () => browser.storage.local.get(null));
  const rows = () => driver.executeScript(() => Array.from(
    document.querySelectorAll('.collection-link-label'), node => node.textContent
  ));

  await input.sendKeys('  DeSiGn  ');
  assert.deepEqual(await rows(), ['Design', 'Work', 'Archive']);
  const matches = await driver.executeScript(() => Array.from(document.querySelectorAll('.collection-link'), row => ({
    name: row.querySelector('.collection-link-label').textContent,
    detail: row.querySelector('.collection-link-match')?.textContent || '',
    highlight: row.querySelector('mark')?.textContent || ''
  })));
  assert.equal(matches[0].detail, '', 'A collection-name match needs no group subtitle.');
  assert.equal(matches[0].highlight, 'Design');
  assert.match(matches[1].detail, /Group: Newsletter design.*\+1/);
  assert.equal(matches[1].highlight, 'design');
  assert.equal(matches[2].detail, 'Group: Design archive');

  for (const key of ['ArrowDown', 'Escape']) {
    const composing = await driver.executeScript(function (key) {
      const input = document.getElementById('popup-search');
      const event = new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return { focus: document.activeElement.id, query: input.value, prevented: event.defaultPrevented };
    }, key);
    assert.deepEqual(composing, { focus: 'popup-search', query: '  DeSiGn  ', prevented: false },
      `Composing ${key} must remain available to the input method.`);
  }

  await input.sendKeys(Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.querySelector('.collection-link-label')?.textContent), 'Design');
  await driver.switchTo().activeElement().sendKeys(Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.querySelector('.collection-link-label')?.textContent), 'Work');
  await driver.switchTo().activeElement().sendKeys(Key.ARROW_UP);
  await driver.switchTo().activeElement().sendKeys(Key.ARROW_UP);
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  await input.sendKeys(Key.ESCAPE);
  assert.equal(await input.getAttribute('value'), '');
  assert.equal((await rows()).length, 4);

  await input.sendKeys('tab title only');
  assert.deepEqual(await rows(), []);
  assert.match(await driver.findElement(By.id('popup-empty')).getText(), /No collections or group names match/);
  await input.clear();
  await input.sendKeys('tab-url-only');
  assert.deepEqual(await rows(), [], 'A tab URL must not make its collection match.');
  await driver.findElement(By.id('clear-search-button')).click();
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  assert.equal((await rows()).length, 4);
  const storedAfter = await extensionCall(driver, () => browser.storage.local.get(null));
  assert.deepEqual(storedAfter, storedBefore, 'Searching and clearing must not change stored data.');

  await input.sendKeys('archive');
  await input.sendKeys(Key.ARROW_DOWN, Key.ENTER);
  assert.equal(await driver.findElement(By.css('.open-choices:not(.hidden)')).isDisplayed(), true);
  assert.equal(await driver.executeScript(() => document.activeElement.classList.contains('collection-link')), true);
  await driver.switchTo().activeElement().sendKeys(Key.TAB);
  assert.equal(await driver.executeScript(() => document.activeElement.textContent.trim()), 'New Window',
    'Tab should enter the expanded collection choices.');
  await driver.switchTo().activeElement().sendKeys(Key.TAB);
  assert.equal(await driver.executeScript(() => document.activeElement.textContent.trim()), 'Append Here');
  await driver.switchTo().activeElement().sendKeys(Key.chord(Key.SHIFT, Key.TAB));
  assert.equal(await driver.executeScript(() => document.activeElement.textContent.trim()), 'New Window');
  await driver.switchTo().activeElement().sendKeys(Key.chord(Key.SHIFT, Key.TAB));
  assert.equal(await driver.executeScript(() => document.activeElement.querySelector('.collection-link-label')?.textContent), 'Archive');

  await driver.navigate().refresh();
  await waitForBodyText(driver, /\bArchive\b/);
  assert.equal(await driver.findElement(By.id('popup-search')).getAttribute('value'), '');
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');

  await sendRuntimeMessage(driver, {
    type: 'sidebar:renameCollection', currentWindowId, collectionId: ids.Design, name: 'İDesign'
  });
  await driver.navigate().refresh();
  await waitForBodyText(driver, 'İDesign');
  const unicodeInput = await driver.findElement(By.id('popup-search'));
  for (const [query, expectedHighlight] of [['design', 'Design'], ['İ', 'İ'], ['i', 'İ']]) {
    await unicodeInput.clear();
    await unicodeInput.sendKeys(query);
    const label = await driver.executeScript(function (collectionId) {
      const row = Array.from(document.querySelectorAll('.collection-link')).find(row => row.dataset.collectionId === collectionId);
      return { text: row.querySelector('.collection-link-label').textContent, mark: row.querySelector('mark').textContent };
    }, ids.Design);
    assert.deepEqual(label, { text: 'İDesign', mark: expectedHighlight }, 'Highlights must follow original character boundaries.');
  }
});

test('toolbar popup keeps its width while searching and expanding saved choices', async (t) => {
  const { driver } = await launchExtension(t, { toolbarPopup: true, classicScrollbars: true });
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection', currentWindowId, name: 'Saved width demo'
  });
  const collectionId = created.createdCollectionId;
  await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup', currentWindowId, collectionId, title: `Planning ${'long group name '.repeat(12)}`
  });
  await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  await extensionCall(driver, async () => browser.browserAction.openPopup());
  await driver.wait(async () => extensionCall(driver, async () => {
    const view = browser.extension.getViews({ type: 'popup' })[0];
    return view?.document.querySelectorAll('.collection-link').length === 1;
  }), 10000);
  const dimensions = () => extensionCall(driver, async () => {
    // Firefox debounces its native panel resize after content mutations.
    await new Promise(resolve => setTimeout(resolve, 300));
    const view = browser.extension.getViews({ type: 'popup' })[0];
    return { width: view.innerWidth, clientWidth: view.document.documentElement.clientWidth, contentWidth: view.document.documentElement.scrollWidth };
  });
  const original = await dimensions();
  for (const query of ['Planning', 'x'.repeat(160), 'Saved', '']) {
    await extensionCall(driver, async query => {
      const view = browser.extension.getViews({ type: 'popup' })[0];
      const input = view.document.getElementById('popup-search');
      input.value = query;
      input.dispatchEvent(new view.Event('input', { bubbles: true }));
    }, query);
    const size = await dimensions();
    assert.equal(size.width, original.width, `Search must not resize the actual popup: ${query.slice(0, 12)}`);
    assert.ok(size.contentWidth <= size.clientWidth,
      `Search content must fit without horizontal overflow: ${query.slice(0, 12)} ${JSON.stringify(size)}`);
  }
  await extensionCall(driver, async () => {
    browser.extension.getViews({ type: 'popup' })[0].document.querySelector('.collection-link').click();
  });
  assert.equal((await dimensions()).width, original.width, 'Expanded opening choices must keep the same width.');
  await extensionCall(driver, async () => {
    browser.extension.getViews({ type: 'popup' })[0].document.getElementById('popup-sections').style.minHeight = '900px';
  });
  const scrolling = await dimensions();
  assert.equal(scrolling.width, original.width, 'Vertical scrolling must keep the popup width fixed.');
  assert.ok(scrolling.clientWidth < scrolling.width, 'This case must exercise a scrollbar that consumes layout width.');
  assert.ok(scrolling.contentWidth <= scrolling.clientWidth, 'A vertical scrollbar must not cause horizontal overflow.');
});

test('popup arrows enter results from search and navigate saved collection choices', async (t) => {
  const { driver, extensionBaseUrl } = await launchExtension(t);
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection', currentWindowId, name: 'Saved arrows'
  });
  const collectionId = created.createdCollectionId;
  await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Arrow demo'
  });
  await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  await driver.get(`${extensionBaseUrl}/src/popup.html`);
  await waitForBodyText(driver, 'Saved arrows');
  const activeText = () => driver.executeScript(() => document.activeElement.textContent.trim());
  const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);

  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  await press(Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.dataset.collectionId), collectionId,
    'Down should enter results immediately from an empty search.');
  await press(Key.ARROW_UP);
  await driver.executeScript(() => document.activeElement.blur());
  await press(Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.dataset.collectionId), collectionId,
    'Down should enter results even if Firefox has left focus on the popup document.');
  await press(Key.ARROW_RIGHT);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'true',
    'Right should expand a saved collection without opening its tabs.');
  await press(Key.ARROW_DOWN);
  assert.equal(await activeText(), 'New Window');
  await press(Key.ARROW_DOWN);
  assert.equal(await activeText(), 'Append Here');
  await press(Key.ARROW_DOWN);
  assert.equal(await activeText(), 'Append Here', 'Down at the last choice should stay there.');
  await press(Key.ARROW_UP);
  assert.equal(await activeText(), 'New Window');
  await press(Key.ARROW_UP);
  assert.equal(await driver.executeScript(() => document.activeElement.dataset.collectionId), collectionId);
  await press(Key.ARROW_RIGHT);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'true',
    'Repeated Right must keep choices expanded.');
  await press(Key.ENTER);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'false');
  await press(Key.ARROW_LEFT);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'false',
    'Left must not open collapsed choices.');
  await press(Key.ENTER);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'true',
    'Enter should open collapsed choices.');
  await press(Key.ARROW_LEFT);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'false',
    'Left should close expanded choices.');
  await press(Key.ARROW_LEFT);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'false',
    'Repeated Left must keep choices closed.');
  for (const choiceIndex of [1, 2]) {
    await press(Key.ARROW_RIGHT);
    for (let step = 0; step < choiceIndex; step += 1) await press(Key.ARROW_DOWN);
    assert.equal(await activeText(), choiceIndex === 1 ? 'New Window' : 'Append Here');
    await press(Key.ARROW_LEFT);
    assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'false',
      'Left from an opening choice should close the choices.');
    assert.equal(await driver.executeScript(() => document.activeElement.dataset.collectionId), collectionId,
      'Closing choices should return focus to their collection.');
  }
  await press(Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.dataset.collectionId), collectionId,
    'Collapsed choices must not receive arrow focus.');
  await press(Key.ARROW_UP);
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  await press('Saved');
  await driver.executeScript(() => document.activeElement.setSelectionRange(0, 0));
  await driver.actions().sendKeys(Key.ARROW_RIGHT).perform();
  assert.equal(await driver.executeScript(() => document.activeElement.selectionStart), 1,
    'Right in search must still move the text cursor.');
  await driver.actions().sendKeys(Key.ARROW_LEFT).perform();
  assert.equal(await driver.executeScript(() => document.activeElement.selectionStart), 0,
    'Left in search must still move the text cursor.');
  await press(Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.dataset.collectionId), collectionId);
});

test('toolbar popup restores focus and saved collections can be appended using only Tab and Enter', async (t) => {
  const { driver, extensionBaseUrl } = await launchExtension(t, { toolbarPopup: true });
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection', currentWindowId, name: 'Saved collection'
  });
  const collectionId = created.createdCollectionId;
  await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Saved group'
  });
  await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  await extensionCall(driver, async () => browser.browserAction.openPopup());
  const popupState = () => extensionCall(driver, async () => browser.extension.getViews({ type: 'popup' }).map(view => ({
    id: view.document.activeElement?.id,
    ready: view.document.readyState === 'complete' && view.document.querySelectorAll('.collection-link').length > 0,
    focused: view.document.hasFocus()
  })));
  await driver.wait(async () => (await popupState())[0]?.ready, 10000);
  await driver.wait(async () => {
    const state = (await popupState())[0];
    return state?.focused && state.id === 'popup-search';
  }, 5000,
    'The actual toolbar popup should focus search after the browser takes focus.');
  const focusedCollectionId = await extensionCall(driver, async () => {
    const view = browser.extension.getViews({ type: 'popup' })[0];
    view.document.querySelector('.collection-link').focus();
    view.dispatchEvent(new view.Event('focus'));
    await new Promise(resolve => view.requestAnimationFrame(resolve));
    return view.document.activeElement.dataset.collectionId;
  });
  assert.equal(focusedCollectionId, collectionId, 'Window focus must not steal focus from an existing control.');
  await extensionCall(driver, async () => {
    const view = browser.extension.getViews({ type: 'popup' })[0];
    view.document.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await driver.wait(async () => (
    await extensionCall(driver, async () => browser.extension.getViews({ type: 'popup' }).length)
  ) === 0, 5000, 'Escape with an empty query should close the toolbar popup.');

  // Keep the original sidebar tab available: activating a collection closes
  // the popup page, including when this keyboard test opens it in its own tab.
  const originalHandle = await driver.getWindowHandle();
  const originalHandles = await driver.getAllWindowHandles();
  await extensionCall(driver, async url => browser.tabs.create({ url, active: true }), `${extensionBaseUrl}/src/popup.html`);
  const popupHandle = await driver.wait(async () => (
    await driver.getAllWindowHandles()
  ).find(handle => !originalHandles.includes(handle)), 5000);
  await driver.switchTo().window(popupHandle);
  await waitForBodyText(driver, 'Saved collection');
  await driver.findElement(By.id('popup-search')).sendKeys(Key.TAB, Key.ENTER);
  assert.equal(await driver.executeScript(() => document.activeElement.classList.contains('collection-link')), true);
  await driver.switchTo().activeElement().sendKeys(Key.TAB, Key.TAB, Key.ENTER);
  await driver.switchTo().window(originalHandle);
  await driver.wait(async () => {
    const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
    return snapshot.collections.find(collection => collection.id === collectionId)?.liveGroupCount === 1;
  }, 10000, 'Enter on Append Here should reopen the saved collection.');
});

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
