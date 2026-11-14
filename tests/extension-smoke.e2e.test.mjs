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
      await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      firstUsedAt: Date.now() - 4 * 86400000,
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

  for (const key of ['ArrowDown', 'Enter', 'Escape']) {
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
  await input.sendKeys(Key.ENTER);
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search',
    'Enter without any results should leave search focused.');
  await input.clear();
  await input.sendKeys('tab-url-only');
  assert.deepEqual(await rows(), [], 'A tab URL must not make its collection match.');
  await driver.findElement(By.id('clear-search-button')).click();
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  assert.equal((await rows()).length, 4);
  const storedAfter = await extensionCall(driver, () => browser.storage.local.get(null));
  assert.deepEqual(storedAfter, storedBefore, 'Searching and clearing must not change stored data.');

  await input.sendKeys('archive');
  await input.sendKeys(Key.ENTER);
  assert.equal(await driver.findElement(By.css('.open-choices:not(.hidden)')).isDisplayed(), true);
  assert.equal(await driver.executeScript(() => document.activeElement.textContent.trim()), 'New Window',
    'Enter from search should focus New Window immediately.');
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

test('sidebar keyboard navigates collections, groups, and opening choices without changing click actions', async (t) => {
  const { driver } = await launchExtension(t);
  await seedCollections(driver);
  await waitForBodyText(driver, 'Admin');
  const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);
  const activeMatches = selector => driver.executeScript(selector => document.activeElement.matches(selector), selector);
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'filter-input');
  await press(Key.ARROW_DOWN);
  assert.ok(await activeMatches('button.collection-title-button'));
  await press(Key.ENTER);
  assert.equal(await driver.executeScript(() => document.activeElement.getAttribute('aria-expanded')), 'false');
  await press(Key.ARROW_RIGHT, Key.ARROW_RIGHT);
  assert.ok(await activeMatches('.group-button'), 'Right on an expanded heading enters its first group.');
  await press(Key.ARROW_LEFT);
  assert.ok(await activeMatches('.collection-title-button'));
  await press(Key.ARROW_LEFT);
  assert.equal(await driver.executeScript(() => document.activeElement.getAttribute('aria-expanded')), 'false');
  await press(Key.ARROW_UP);
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'filter-input');

  await press('Work');
  const composing = await driver.executeScript(() => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return { prevented: event.defaultPrevented, focus: document.activeElement.id };
  });
  assert.deepEqual(composing, { prevented: false, focus: 'filter-input' });
  await driver.executeScript(() => document.activeElement.setSelectionRange(0, 0));
  await press(Key.ARROW_RIGHT);
  assert.equal(await driver.executeScript(() => document.activeElement.selectionStart), 1);
  await press(Key.ARROW_DOWN, Key.ARROW_LEFT);
  assert.equal(await driver.executeScript(() => document.activeElement.getAttribute('aria-expanded')), 'true',
    'Filtered collections stay expanded.');
  await press(Key.ESCAPE);
  assert.equal(await driver.findElement(By.id('filter-input')).getAttribute('value'), '');
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'filter-input');
  await press('no results anywhere', Key.ENTER);
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'filter-input');
  await press(Key.ESCAPE, Key.ESCAPE);
  assert.ok(await activeMatches('#filter-input'), 'Escape keeps the persistent sidebar open.');
});

for (const targetMode of ['append', 'new-window']) {
  test(`sidebar keyboard opens saved collections using ${targetMode} choices`, async t => {
    const { driver } = await launchExtension(t);
    const currentWindowId = await getCurrentWindowId(driver);
    const created = await sendRuntimeMessage(driver, {
      type: 'sidebar:createCollection', currentWindowId, name: 'Saved keyboard'
    });
    const collectionId = created.createdCollectionId;
    await sendRuntimeMessage(driver, {
      type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Restored keyboard group'
    });
    await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
    await waitForBodyText(driver, 'Saved keyboard');
    const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);
    await driver.findElement(By.id('filter-input')).sendKeys('Saved keyboard', Key.ENTER);
    assert.equal(await driver.executeScript(() => document.activeElement.getAttribute('aria-expanded')), 'true');
    await press(Key.ARROW_DOWN);
    assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'New Window');
    await press(Key.ARROW_DOWN);
    assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'Append Here');
    await press(Key.ARROW_LEFT);
    assert.equal(await driver.executeScript(() => document.activeElement.getAttribute('aria-expanded')), 'false');
    await press(Key.ARROW_RIGHT, Key.ARROW_RIGHT);
    assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'New Window');
    await press(Key.ESCAPE);
    assert.equal(await driver.executeScript(() => document.activeElement.getAttribute('aria-expanded')), 'false');
    await press(Key.ENTER, Key.TAB, Key.TAB, Key.TAB);
    assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'New Window',
      'Tab follows the existing action row before reaching its opening choices.');
    if (targetMode === 'append') await press(Key.TAB);
    const windowsBefore = await driver.executeAsyncScript(done => browser.windows.getAll().then(windows => done(windows.length)));
    await press(Key.ENTER);
    await driver.wait(async () => {
      const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
      return snapshot.collections.find(collection => collection.id === collectionId)?.liveGroupCount === 1;
    }, 10000);
    const windowsAfter = await driver.executeAsyncScript(done => browser.windows.getAll().then(windows => done(windows.length)));
    assert.equal(windowsAfter, windowsBefore + Number(targetMode === 'new-window'));
  });
}

test('sidebar keyboard restores focus and unfinished move choices through refresh and cancellation', async t => {
  const { driver } = await launchExtension(t);
  await seedCollections(driver);
  await waitForBodyText(driver, 'Admin');
  const currentWindowId = await getCurrentWindowId(driver);
  const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  const work = snapshot.collections.find(collection => collection.name === 'Work');
  const group = work.groups[0];
  const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);
  await driver.executeScript(() => document.querySelector('.group-row .move-button:not(.group-delete-button)').focus());
  await press(Key.ENTER, Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.tagName), 'SELECT');
  await press(Key.HOME);
  const destination = await driver.executeScript(() => document.activeElement.value);
  await sendRuntimeMessage(driver, {
    type: 'sidebar:renameGroup', currentWindowId, collectionId: work.id, sourceKind: 'live',
    groupId: group.runtimeGroupId, snapshotGroupId: group.snapshotGroupId, title: 'Refreshed Admin'
  });
  await waitForBodyText(driver, 'Refreshed Admin');
  assert.equal(await driver.executeScript(() => document.activeElement.tagName), 'SELECT');
  assert.equal(await driver.executeScript(() => document.activeElement.value), destination);
  await press(Key.TAB, Key.ESCAPE);
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.move-button:not(.group-delete-button)')));
  await press(Key.ARROW_LEFT);
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.collection-title-button')));
  await driver.executeScript(() => document.querySelector('.pin-toggle-button').focus());
  await press(Key.ENTER);
  await driver.wait(() => driver.executeScript(() => document.querySelector('.pin-toggle-button').getAttribute('aria-pressed') === 'true'), 5000);
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.pin-toggle-button')),
    'Pinning may move a card between sections but must preserve focus.');
  await driver.executeScript(() => document.querySelector('.group-delete-button').focus());
  await press(Key.ENTER, Key.ARROW_DOWN, Key.ESCAPE);
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.group-delete-button')));
  await driver.executeScript(() => document.querySelector('.group-dot-button').focus());
  await press(Key.ARROW_RIGHT, Key.ARROW_DOWN, Key.ENTER);
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.group-dot-button')));
});

test('sidebar keyboard reorders saved groups and moves them without dragging', async t => {
  const { driver } = await launchExtension(t);
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, { type: 'sidebar:createCollection', currentWindowId, name: 'Keyboard order' });
  const collectionId = created.createdCollectionId;
  for (const title of ['First', 'Second', 'Third']) {
    await sendRuntimeMessage(driver, { type: 'sidebar:createGroup', currentWindowId, collectionId, title });
  }
  await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  await waitForBodyText(driver, 'Third');
  const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);
  await driver.executeScript(() => [...document.querySelectorAll('.group-button')].find(node => node.textContent === 'Second').focus());
  await driver.actions().keyDown(Key.ALT).sendKeys(Key.ARROW_UP).keyUp(Key.ALT).perform();
  await driver.wait(async () => (await driver.findElements(By.css('.group-title'))).length === 3 &&
    await driver.findElement(By.css('.group-title')).getText() === 'Second', 5000);
  assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'Second');
  await driver.actions().keyDown(Key.ALT).sendKeys(Key.ARROW_DOWN).keyUp(Key.ALT).perform();
  await driver.wait(async () => await driver.findElement(By.css('.group-title')).getText() === 'First', 5000);
  await driver.executeScript(() => document.activeElement.closest('.group-row').querySelector('.drag-handle').focus());
  await press(Key.ENTER, Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.tagName), 'SELECT');
  await press('u');
  assert.equal(await driver.executeScript(() => document.activeElement.selectedOptions[0].textContent), 'Uncategorized');
  await press(Key.TAB, Key.ENTER);
  await driver.wait(async () => {
    const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
    return snapshot.collections.find(collection => collection.isUncategorized)?.groups.some(group => group.title === 'Second');
  }, 5000);
  assert.equal(await driver.executeScript(() => document.activeElement.closest('.group-row')?.querySelector('.group-title').textContent), 'Second',
    'Focus should follow the moved group into its destination collection.');
});

test('sidebar keyboard retains a new move destination and recovers focus after rename and deletion', async t => {
  const { driver } = await launchExtension(t);
  await seedCollections(driver);
  await waitForBodyText(driver, 'Admin');
  const currentWindowId = await getCurrentWindowId(driver);
  const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  const work = snapshot.collections.find(collection => collection.name === 'Work');
  const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);
  await driver.executeScript(() => document.querySelector('.group-row .move-button:not(.group-delete-button)').focus());
  await press(Key.ENTER, Key.ARROW_DOWN, Key.END);
  const namePrompt = await driver.switchTo().alert();
  await namePrompt.sendKeys('New keyboard destination');
  await namePrompt.accept();
  await press(Key.TAB);
  await sendRuntimeMessage(driver, { type: 'sidebar:renameCollection', currentWindowId, collectionId: work.id, name: 'Renamed work' });
  await waitForBodyText(driver, 'Renamed work');
  assert.equal(await driver.executeScript(() => document.querySelector('.move-panel:not(.hidden) select').selectedOptions[0].textContent),
    'New collection: New keyboard destination');
  assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'Move');
  await press(Key.ENTER);
  await driver.wait(() => driver.executeScript(() => [...document.querySelectorAll('.collection-title')]
    .some(node => node.textContent === 'New keyboard destination')), 5000);
  assert.equal(await driver.executeScript(() => document.activeElement.closest('.collection-card')?.querySelector('.collection-title').textContent),
    'New keyboard destination');
  await driver.executeScript(() => {
    document.activeElement.closest('.group-row').querySelector('.inline-icon-button').focus();
  });
  await press(Key.ENTER);
  const renamePrompt = await driver.switchTo().alert();
  await renamePrompt.sendKeys('Renamed with keyboard');
  await renamePrompt.accept();
  await waitForBodyText(driver, 'Renamed with keyboard');
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.inline-icon-button')));
  await driver.executeScript(() => document.activeElement.closest('.group-row').querySelector('.group-delete-button').focus());
  await press(Key.ENTER, Key.ARROW_DOWN, Key.ARROW_DOWN, Key.ENTER);
  await (await driver.switchTo().alert()).accept();
  await driver.wait(() => driver.executeScript(() => ![...document.querySelectorAll('.group-title')].some(node => node.textContent === 'Renamed with keyboard')), 5000);
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.collection-title-button')),
    'Deleting the focused group returns to its surviving collection heading.');
});

test('sidebar keyboard keeps the focused collection visible when pinning moves it above the viewport', async t => {
  const { driver } = await launchExtension(t);
  const currentWindowId = await getCurrentWindowId(driver);
  const first = await sendRuntimeMessage(driver, { type: 'sidebar:createCollection', currentWindowId, name: 'A tall collection' });
  for (let index = 0; index < 8; index += 1) {
    await sendRuntimeMessage(driver, { type: 'sidebar:createGroup', currentWindowId, collectionId: first.createdCollectionId, title: `Tall group ${index}` });
  }
  await sendRuntimeMessage(driver, { type: 'sidebar:createCollection', currentWindowId, name: 'Z pin target' });
  await waitForBodyText(driver, 'Z pin target');
  await driver.findElement(By.id('sort-select')).sendKeys('A');
  await driver.executeScript(() => [...document.querySelectorAll('.collection-card')]
    .find(card => card.querySelector('.collection-title').textContent === 'Z pin target').querySelector('.pin-toggle-button').focus());
  await (await driver.switchTo().activeElement()).sendKeys(Key.ENTER);
  await driver.wait(() => driver.executeScript(() => document.activeElement.getAttribute('aria-pressed') === 'true'), 5000);
  assert.ok(await driver.executeScript(() => {
    const rect = document.activeElement.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  }), 'Focus must scroll into view when pinning relocates a card.');
});

for (const change of ['saved rename', 'live to saved']) {
  test(`sidebar review regression retains an open move form through ${change}`, async t => {
    const { driver } = await launchExtension(t);
    await seedCollections(driver);
    await waitForBodyText(driver, 'Admin');
    const currentWindowId = await getCurrentWindowId(driver);
    let snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
    const work = snapshot.collections.find(collection => collection.name === 'Work');
    if (change === 'saved rename') {
      await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId: work.id });
      await driver.wait(() => driver.executeScript(() => document.querySelector('.group-meta').textContent.includes('Closed')), 5000);
    }
    await driver.executeScript(() => document.querySelector('.group-row .move-button:not(.group-delete-button)').focus());
    const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);
    await press(Key.ENTER, Key.ARROW_DOWN, 'u');
    assert.equal(await driver.executeScript(() => document.activeElement.selectedOptions[0].textContent), 'Uncategorized');
    snapshot = await sendRuntimeMessage(driver, change === 'saved rename'
      ? { type: 'sidebar:renameGroup', currentWindowId, sourceKind: 'snapshot', collectionId: work.id,
        snapshotGroupId: work.groups[0].snapshotGroupId, title: 'Externally renamed saved group' }
      : { type: 'sidebar:closeCollection', currentWindowId, collectionId: work.id });
    const title = change === 'saved rename' ? 'Externally renamed saved group' : 'Admin';
    await driver.wait(() => driver.executeScript(title => [...document.querySelectorAll('.group-row')].some(row =>
      row.querySelector('.group-title').textContent === title && row.querySelector('.group-meta').textContent.includes('Closed')), title), 5000);
    assert.ok(await driver.executeScript(() => document.activeElement.matches('.move-select')),
      'The open form keeps focus across stable group identity changes.');
    assert.equal(await driver.executeScript(() => document.activeElement.selectedOptions[0].textContent), 'Uncategorized');
  });
}

test('sidebar review regression preserves manual scrolling during passive refresh', async t => {
  const { driver } = await launchExtension(t);
  await driver.manage().window().setRect({ width: 1000, height: 600 });
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, { type: 'sidebar:createCollection', currentWindowId, name: 'Tall before refresh' });
  for (let index = 0; index < 8; index += 1) {
    await sendRuntimeMessage(driver, { type: 'sidebar:createGroup', currentWindowId, collectionId: created.createdCollectionId, title: `Group ${index}` });
  }
  await waitForBodyText(driver, 'Group 7');
  const before = await driver.executeScript(() => {
    document.querySelector('.collection-title-button').focus();
    window.scrollTo(0, document.body.scrollHeight);
    return scrollY;
  });
  assert.ok(before > 500);
  await sendRuntimeMessage(driver, { type: 'sidebar:renameCollection', currentWindowId, collectionId: created.createdCollectionId, name: 'Tall after refresh' });
  await driver.wait(() => driver.executeScript(() => document.querySelector('.collection-title-button').textContent === 'Tall after refresh'), 5000);
  const after = await driver.executeScript(() => scrollY);
  assert.ok(Math.abs(after - before) <= 2, `Passive refresh must retain manual scroll: ${before} became ${after}.`);
});

test('sidebar review regression excludes closed move forms from pending refresh state', async t => {
  const { driver } = await launchExtension(t);
  await seedCollections(driver);
  await waitForBodyText(driver, 'Admin');
  // Exercise the controller's render-state interface on real rendered controls.
  // Closed forms have no pending user choice and must not add per-group restore work.
  const count = await driver.executeScript(() => {
    const controller = globalThis.TabGroupCollectionsSidebarKeyboard.create({
      root: document.getElementById('collections'), filter: document.getElementById('filter-input')
    });
    return controller.capture().forms.length;
  });
  assert.equal(count, 0);
});

test('quick panel search Enter focuses New Window and a second Enter opens it', async t => {
  const { driver, extensionBaseUrl } = await launchExtension(t);
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection', currentWindowId, name: 'Saved focus'
  });
  const collectionId = created.createdCollectionId;
  await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Focus demo'
  });
  await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  const originalHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow('tab');
  await driver.get(`${extensionBaseUrl}/src/popup.html`);
  await waitForBodyText(driver, 'Saved focus');
  const press = async (...keys) => (await driver.switchTo().activeElement()).sendKeys(...keys);
  await driver.findElement(By.id('popup-search')).sendKeys('Saved focus', Key.ENTER);
  assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'New Window');
  assert.ok(await driver.executeScript(() => document.activeElement.matches('.open-choice-button')));
  let snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  assert.equal(snapshot.collections.find(collection => collection.id === collectionId).liveGroupCount, 0,
    'The first Enter selects an opening choice without opening the collection.');
  await press(Key.ARROW_DOWN);
  assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'Append Here');
  await press(Key.ARROW_UP, Key.ARROW_UP, Key.ARROW_UP);
  assert.equal(await driver.executeScript(() => document.activeElement.id), 'popup-search');
  await press(Key.ENTER);
  assert.equal(await driver.executeScript(() => document.activeElement.textContent), 'New Window',
    'Enter from search also focuses an already expanded choice without collapsing it.');
  const before = await extensionCall(driver, () => browser.windows.getAll());
  await press(Key.ENTER);
  await driver.switchTo().window(originalHandle);
  await driver.wait(async () => {
    snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
    return snapshot.collections.find(collection => collection.id === collectionId)?.liveGroupCount === 1;
  }, 10000);
  const after = await extensionCall(driver, () => browser.windows.getAll());
  assert.equal(after.length, before.length + 1, 'The second Enter opens the collection in a new window.');
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
  await press(Key.ENTER);
  assert.equal(await driver.findElement(By.css('.collection-link')).getAttribute('aria-expanded'), 'true',
    'Enter from search should activate the first collection and reveal its opening choices.');
  assert.equal(await activeText(), 'New Window', 'Search Enter should focus the first opening choice.');
  await press(Key.ARROW_LEFT, Key.ARROW_UP);
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

for (const url of ['about:home', 'about:newtab', 'about:blank']) {
  test(`quick panel Enter opens a saved collection into a window containing only ${url}`, async t => {
    const { driver } = await launchExtension(t, { toolbarPopup: true });
    const currentWindowId = await getCurrentWindowId(driver);
    const created = await sendRuntimeMessage(driver, {
      type: 'sidebar:createCollection', currentWindowId, name: 'Saved quick open'
    });
    const collectionId = created.createdCollectionId;
    await sendRuntimeMessage(driver, {
      type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Restored group'
    });
    await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
    const originalHandle = await driver.getWindowHandle();
    const originalHandles = await driver.getAllWindowHandles();
    const windowId = await extensionCall(driver, async () => (await browser.windows.create({})).id);
    const newHandle = await driver.wait(async () => (await driver.getAllWindowHandles())
      .find(handle => !originalHandles.includes(handle)), 5000);
    await driver.switchTo().window(newHandle);
    // WebExtensions cannot navigate to about:home; WebDriver can load Firefox's own page.
    await driver.get(url);
    await driver.switchTo().window(originalHandle);
    const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId: windowId });
    assert.equal(snapshot.currentWindowHasOnlyEmptyNewTab, true,
      'Both panels must recognize a fresh window as available for direct opening.');
    const windowsBefore = await extensionCall(driver, async () => (await browser.windows.getAll()).length);
    await extensionCall(driver, async windowId => {
      await browser.windows.update(windowId, { focused: true });
      await browser.browserAction.openPopup({ windowId });
    }, windowId);
    await driver.wait(async () => extensionCall(driver, async () => (
      browser.extension.getViews({ type: 'popup' })[0]?.document.querySelector('.collection-link') != null
    )), 10000);
    await extensionCall(driver, async () => {
      const view = browser.extension.getViews({ type: 'popup' })[0];
      const search = view.document.getElementById('popup-search');
      search.focus();
      search.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await driver.wait(async () => {
      const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId: windowId });
      return snapshot.collections.find(collection => collection.id === collectionId)?.liveGroupCount === 1;
    }, 10000, 'Enter from search should reopen the collection directly.');
    const tabs = await extensionCall(driver, async windowId => browser.tabs.query({ windowId }), windowId);
    assert.equal(tabs.length, 1, 'The empty placeholder tab should be removed after restoring the group.');
    assert.notEqual(tabs[0].groupId, -1, 'The restored tab should belong to the saved group.');
    assert.equal(await extensionCall(driver, async () => (await browser.windows.getAll()).length), windowsBefore,
      'Opening into the fresh window must not create another window.');
  });
}

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

/** Inspect Firefox's saved groups only in the disposable browser, outside extension privileges. */
async function getNativeSavedGroups(driver, { flush = false } = {}) {
  await driver.setContext('chrome');
  try {
    return await driver.executeAsyncScript(function (flush, done) {
      const { SessionStore } = ChromeUtils.importESModule('moz-src:///browser/components/sessionstore/SessionStore.sys.mjs');
      const { TabStateFlusher } = ChromeUtils.importESModule('moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs');
      const browsers = [...Services.wm.getEnumerator('navigator:browser')]
        .flatMap(win => [...win.gBrowser.tabs].map(tab => tab.linkedBrowser));
      const ready = flush ? Promise.all(browsers.map(browser => TabStateFlusher.flush(browser))) : Promise.resolve();
      ready.then(() => done(SessionStore.getSavedTabGroups()), error => done({ error: String(error) }));
    }, flush);
  } finally {
    await driver.setContext('content');
  }
}

/** Create a populated native group and optionally put it alone in another browser window. */
async function createClosureFixture(t, { entireWindow = false } = {}) {
  const { driver } = await launchExtension(t);
  const server = createServer((request, response) => response.end('<title>Game page</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const currentWindowId = await getCurrentWindowId(driver);
  const created = await sendRuntimeMessage(driver, {
    type: 'sidebar:createCollection', currentWindowId, name: 'Games'
  });
  const collectionId = created.createdCollectionId;
  const snapshot = await sendRuntimeMessage(driver, {
    type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Wed games'
  });
  const group = snapshot.collections.find(c => c.id === collectionId).groups[0];
  const targetWindowId = await extensionCall(driver, async (groupId, baseUrl, entireWindow) => {
    const [first] = await browser.tabs.query({ groupId });
    await browser.tabs.update(first.id, { url: baseUrl + '/one' });
    const second = await browser.tabs.create({ url: baseUrl + '/two', active: false });
    await browser.tabs.group({ groupId, tabIds: [second.id] });
    if (!entireWindow) return first.windowId;
    const window = await browser.windows.create({ url: 'about:blank' });
    await browser.tabGroups.move(groupId, { windowId: window.id, index: -1 });
    const seed = (await browser.tabs.query({ windowId: window.id })).find(tab => tab.groupId === -1);
    await browser.tabs.remove(seed.id);
    return window.id;
  }, group.runtimeGroupId, baseUrl, entireWindow);
  const ready = async (expectedUrls = []) => {
    await driver.wait(async () => extensionCall(driver, async expectedUrls => {
      const tabs = await browser.tabs.query({});
      const urls = tabs.filter(tab => tab.groupId !== -1).map(tab => tab.url);
      return tabs.every(tab => tab.groupId === -1 || tab.status === 'complete') &&
        expectedUrls.every(url => urls.includes(url));
    }, expectedUrls), 10000);
    await getNativeSavedGroups(driver, { flush: true });
  };
  const urls = [baseUrl + '/one', baseUrl + '/two'];
  await ready(urls);
  await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  return { driver, currentWindowId, targetWindowId, collectionId, group, ready, urls };
}

for (const entireWindow of [false, true]) {
  for (const action of ['closeCollection', 'deleteGroup', 'deleteCollection']) {
    test(`${action} does not save native Firefox copies${entireWindow ? ' when the group fills its window' : ''}`, async t => {
      const f = await createClosureFixture(t, { entireWindow });
      const { driver, currentWindowId, targetWindowId, collectionId, group } = f;
      const cycles = action === 'closeCollection' ? 3 : 1;
      for (let cycle = 0; cycle < cycles; cycle++) {
        const snapshot = await sendRuntimeMessage(driver, {
          type: `sidebar:${action}`, currentWindowId, collectionId,
          sourceKind: 'live', groupId: group.runtimeGroupId, mode: 'collection-and-groups'
        });
        assert.deepEqual(await getNativeSavedGroups(driver), [], 'Closing must not populate Firefox saved groups.');
        const collection = snapshot.collections.find(c => c.id === collectionId);
        if (action === 'closeCollection') {
          assert.equal(collection.liveGroupCount, 0);
          assert.equal(collection.snapshotGroupCount, 1);
          assert.equal(collection.snapshotTabCount, 2);
        } else if (action === 'deleteGroup') {
          assert.equal(collection.snapshotGroupCount, 0);
        } else {
          assert.equal(collection, undefined);
        }
        if (entireWindow) {
          const tabs = await extensionCall(driver, async windowId => browser.tabs.query({ windowId }), targetWindowId);
          assert.equal(tabs.length, 1, 'A placeholder should keep the emptied window available.');
          assert.equal(tabs[0].groupId, -1);
          assert.equal(tabs[0].url, 'about:blank');
        }
        if (cycle < cycles - 1) {
          await sendRuntimeMessage(driver, { type: 'sidebar:openCollection', currentWindowId: targetWindowId, collectionId, targetMode: 'append' });
          await f.ready(f.urls);
        }
      }
    });
  }
}


for (const action of ['deleteGroup', 'closeCollection']) {
  test(`${action} preserves its group when Firefox cancels a tab closure`, async t => {
    const f = await createClosureFixture(t);
    const { driver, currentWindowId, collectionId, group } = f;
    const tabsBefore = await extensionCall(driver, async id => browser.tabs.query({ groupId: id }), group.runtimeGroupId);
    const canceledTabId = tabsBefore[action === 'closeCollection' ? 1 : 0].id;
    // Simulate the tabs.remove result after a canceled beforeunload prompt.
    // All other closures, saved sessions, restoration, and synchronization use Firefox itself.
    await extensionCall(driver, async tabId => {
      const bg = browser.extension.getBackgroundPage();
      bg.originalCloseForTest = bg.browser.tabs.remove;
      bg.browser.tabs.remove = async id => {
        if (id !== tabId) await bg.originalCloseForTest(id);
      };
    }, canceledTabId);
    let response;
    try {
      response = await extensionCall(driver, async message => browser.runtime.sendMessage(message), {
        type: `sidebar:${action}`, currentWindowId, collectionId, sourceKind: 'live', groupId: group.runtimeGroupId
      });
    } finally {
      await extensionCall(driver, async () => {
        const bg = browser.extension.getBackgroundPage();
        bg.browser.tabs.remove = bg.originalCloseForTest;
      });
    }
    assert.match(response.error || '', /cancel/i);
    await f.ready(tabsBefore.map(tab => tab.url));
    const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
    const collection = snapshot.collections.find(c => c.id === collectionId);
    assert.equal(collection.liveGroupCount, 1);
    assert.equal(collection.snapshotTabCount, 2);
    assert.equal(collection.groups[0].snapshotGroupId, group.snapshotGroupId);
    const tabsAfter = await extensionCall(driver, async id => browser.tabs.query({ groupId: id }), collection.groups[0].runtimeGroupId);
    assert.deepEqual(tabsAfter.map(tab => tab.url), tabsBefore.map(tab => tab.url));
    assert.deepEqual(await getNativeSavedGroups(driver), []);
  });
}

test('closing all visible group tabs preserves a hidden unrelated tab without saving the group', async t => {
  const f = await createClosureFixture(t, { entireWindow: true });
  const { driver, currentWindowId, targetWindowId, collectionId } = f;
  await driver.setContext('chrome');
  try {
    await driver.executeScript(function () {
      const win = [...Services.wm.getEnumerator('navigator:browser')]
        .find(win => [...win.gBrowser.tabGroups].some(group => group.label === 'Wed games'));
      const hidden = win.gBrowser.addTrustedTab('about:blank', { inBackground: true });
      win.gBrowser.hideTab(hidden);
    });
  } finally { await driver.setContext('content'); }
  const hiddenTabs = await extensionCall(driver, async windowId => (await browser.tabs.query({ windowId })).filter(tab => tab.hidden), targetWindowId);
  assert.equal(hiddenTabs.length, 1);
  await sendRuntimeMessage(driver, { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  const tabs = await extensionCall(driver, async windowId => browser.tabs.query({ windowId }), targetWindowId);
  assert.equal(tabs.some(tab => tab.id === hiddenTabs[0].id), true);
  assert.equal(tabs.filter(tab => !tab.hidden).length, 1);
  assert.equal(tabs.find(tab => !tab.hidden).groupId, -1);
  assert.deepEqual(await getNativeSavedGroups(driver), []);
});

test('a canceled Close keeps completed groups saved without reopening loose duplicates', async t => {
  const f = await createClosureFixture(t);
  const { driver, currentWindowId, collectionId } = f;
  const created = await sendRuntimeMessage(driver, { type: 'sidebar:createGroup', currentWindowId, collectionId, title: 'Still open' });
  const lastGroup = created.collections.find(c => c.id === collectionId).groups.find(g => g.title === 'Still open');
  await extensionCall(driver, async id => {
    const bg = browser.extension.getBackgroundPage();
    const [tab] = await browser.tabs.query({ groupId: id });
    bg.originalCloseForTest = bg.browser.tabs.remove;
    bg.browser.tabs.remove = async id => {
      if (id !== tab.id) await bg.originalCloseForTest(id);
    };
  }, lastGroup.runtimeGroupId);
  let response;
  try {
    response = await extensionCall(driver, async message => browser.runtime.sendMessage(message), { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  } finally {
    await extensionCall(driver, async () => {
      const bg = browser.extension.getBackgroundPage();
      bg.browser.tabs.remove = bg.originalCloseForTest;
    });
  }
  assert.match(response.error || '', /cancel/i);
  await f.ready();
  const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  const collection = snapshot.collections.find(c => c.id === collectionId);
  assert.equal(collection.liveGroupCount, 1);
  assert.equal(collection.snapshotTabCount, 3);
  assert.deepEqual(collection.groups.map(g => [g.title, g.kind]), [['Wed games', 'snapshot'], ['Still open', 'live']]);
  assert.equal((await extensionCall(driver, async () => browser.tabs.query({}))).filter(t => t.url.startsWith('http://127.0.0.1:')).length, 0);
  const reopened = await sendRuntimeMessage(driver, { type: 'sidebar:openCollection', currentWindowId, collectionId, targetMode: 'append' });
  assert.equal(reopened.collections.find(c => c.id === collectionId).liveGroupCount, 2);
  await f.ready(f.urls);
  assert.equal((await extensionCall(driver, async () => browser.tabs.query({}))).filter(t => t.url.startsWith('http://127.0.0.1:')).length, 2);
  assert.deepEqual(await getNativeSavedGroups(driver), []);
});

test('a partly canceled full-window Close restores session tabs in their original order', async t => {
  const f = await createClosureFixture(t, { entireWindow: true });
  const { driver, currentWindowId, collectionId, group } = f;
  await extensionCall(driver, async groupId => {
    const tabs = await browser.tabs.query({ groupId });
    const third = await browser.tabs.create({ windowId: tabs[0].windowId, url: tabs[0].url.replace('/one', '/three'), active: false });
    await browser.tabs.group({ groupId, tabIds: [third.id] });
    return browser.tabs.query({ groupId });
  }, group.runtimeGroupId);
  await driver.wait(async () => extensionCall(driver, async groupId => (
    await browser.tabs.query({ groupId })
  ).every(tab => tab.url.startsWith('http://127.0.0.1:') && tab.status === 'complete'), group.runtimeGroupId), 10000);
  await f.ready();
  const tabsBefore = await extensionCall(driver, async groupId => browser.tabs.query({ groupId }), group.runtimeGroupId);
  await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  await extensionCall(driver, async tabId => {
    const bg = browser.extension.getBackgroundPage();
    bg.originalCloseForTest = bg.browser.tabs.remove;
    bg.browser.tabs.remove = async id => { if (id !== tabId) await bg.originalCloseForTest(id); };
  }, tabsBefore[2].id);
  let response;
  try {
    response = await extensionCall(driver, async message => browser.runtime.sendMessage(message), { type: 'sidebar:closeCollection', currentWindowId, collectionId });
  } finally {
    await extensionCall(driver, async () => {
      const bg = browser.extension.getBackgroundPage();
      bg.browser.tabs.remove = bg.originalCloseForTest;
    });
  }
  assert.match(response.error || '', /cancel/i);
  await f.ready(tabsBefore.map(tab => tab.url));
  const snapshot = await sendRuntimeMessage(driver, { type: 'sidebar:getSnapshot', currentWindowId });
  const collection = snapshot.collections.find(c => c.id === collectionId);
  assert.equal(collection.liveGroupCount, 1);
  assert.equal(collection.snapshotTabCount, 3);
  const restored = await extensionCall(driver, async groupId => browser.tabs.query({ groupId }), collection.groups[0].runtimeGroupId);
  assert.deepEqual(restored.map(tab => tab.url), tabsBefore.map(tab => tab.url));
  assert.deepEqual(await getNativeSavedGroups(driver), []);
});
