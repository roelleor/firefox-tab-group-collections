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

test('extension popup hides Uncategorized while sidebar still shows it', async (t) => {
  await buildExtensionPackage();

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-group-collections-e2e-'));
  const options = new firefox.Options().addArguments('-profile', profileDir);
  const firefoxBinary = await resolveFirefoxBinary();
  if (firefoxBinary) {
    options.setBinary(firefoxBinary);
  }
  if (!process.env.E2E_FIREFOX_HEADFUL) {
    options.addArguments('-headless');
  }

  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .build();

  t.after(async () => {
    await driver.quit();
    await fs.rm(profileDir, { recursive: true, force: true });
  });

  await driver.installAddon(EXTENSION_PACKAGE_PATH, true);
  const extensionUuid = await waitForExtensionUuid(profileDir);
  const extensionBaseUrl = `moz-extension://${extensionUuid}`;

  await driver.get(`${extensionBaseUrl}/src/sidebar.html`);
  await driver.wait(until.elementLocated(By.css('main.app')), 10000);

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
