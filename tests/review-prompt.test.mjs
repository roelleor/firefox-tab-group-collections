import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Review = require('../src/review-prompt.js');
const date = (month, day) => new Date(2026, month - 1, day, 12).getTime();

function eligibleState() {
  let state = Review.visit(null, date(1, 1));
  for (const day of [1, 2, 3, 4, 5]) state = Review.activity(state, date(1, day));
  return state;
}

test('review card requires two weeks and activity on five distinct days', () => {
  let state = Review.visit(null, date(1, 1));
  for (let i = 0; i < 10; i += 1) state = Review.activity(state, date(1, 1));
  assert.equal(Review.claim(state, date(2, 1)).showPrompt, false);
  for (const day of [2, 3, 4, 5]) state = Review.activity(state, date(1, day));
  assert.equal(Review.claim(state, date(1, 14)).showPrompt, false);
  assert.equal(Review.claim(state, date(1, 15)).showPrompt, true);
});

test('showing or dismissing the card pauses it for three calendar months', () => {
  const shown = Review.claim(eligibleState(), date(1, 31));
  assert.equal(shown.showPrompt, true);
  assert.equal(shown.state.nextPromptAt, date(4, 30));
  assert.equal(Review.claim(shown.state, date(2, 1)).showPrompt, false);
  const dismissed = Review.dismiss(shown.state, date(2, 1));
  assert.equal(Review.claim(dismissed, date(4, 30)).showPrompt, false);
  assert.equal(Review.claim(dismissed, date(5, 1)).showPrompt, true);
});

test('any review click pauses the card for a year and dismissal cannot shorten it', () => {
  const reviewed = Review.reviewed(eligibleState(), date(2, 1));
  assert.equal(Review.claim(reviewed, date(12, 1)).showPrompt, false);
  const dismissed = Review.dismiss(reviewed, date(2, 2));
  assert.equal(dismissed.nextPromptAt, new Date(2027, 1, 1, 12).getTime());
  assert.equal(Review.claim(dismissed, dismissed.nextPromptAt).showPrompt, true);
});

test('reminder state retains only five day stamps, without collection or tab data', () => {
  let state = eligibleState();
  for (let day = 6; day <= 30; day += 1) state = Review.activity(state, date(1, day));
  assert.equal(state.activeDays.length, 5);
  assert.deepEqual(Object.keys(state).sort(), [
    'activeDays', 'firstUsedAt', 'lastDismissedAt', 'lastReviewAt', 'nextPromptAt'
  ]);
});

async function service(t, initial = {}, { failStorage = false, failNavigation = false } = {}) {
  const stored = structuredClone(initial);
  const opened = [];
  let listener;
  const context = vm.createContext({
    TabGroupCollectionsReview: Review,
    console: { error() {} },
    browser: {
      storage: { local: {
        async get(key) { return { [key]: structuredClone(stored[key]) }; },
        async set(update) {
          if (failStorage) throw new Error('storage unavailable');
          await new Promise(resolve => setTimeout(resolve, 1));
          Object.assign(stored, structuredClone(update));
        }
      } },
      tabs: { async create(options) {
        if (failNavigation) throw new Error('navigation failed');
        opened.push(options);
      } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } }
    }
  });
  vm.runInContext(await fs.readFile(new URL('../src/review-background.js', import.meta.url), 'utf8'), context);
  return { stored, opened, send: type => listener({ type }) };
}

test('concurrent panels claim the card once and preserve all collection storage', async t => {
  const collections = { collections: { precious: { name: 'Keep me', snapshot: { groups: [] } } } };
  const app = await service(t, {
    [Review.STORAGE_KEY]: eligibleState(),
    'tab-group-collections.state': collections
  });
  const results = await Promise.all([app.send('review:show'), app.send('review:show')]);
  assert.equal(results.filter(result => result.showPrompt).length, 1);
  assert.deepEqual(app.stored['tab-group-collections.state'], collections);
});

test('review navigation uses the real AMO reviews URL and persists the yearly pause', async t => {
  const app = await service(t);
  await app.send('review:open');
  assert.equal(app.opened[0].url, 'https://addons.mozilla.org/en-US/firefox/addon/tab-group-collections/reviews/');
  assert.equal(app.stored[Review.STORAGE_KEY].lastReviewAt > 0, true);
  assert.equal(app.stored[Review.STORAGE_KEY].nextPromptAt > Date.now() + 360 * 86400000, true);
});

test('review link still opens if reminder preferences cannot be saved', async t => {
  const app = await service(t, {}, { failStorage: true });
  await app.send('review:open');
  assert.equal(app.opened.length, 1);
});

test('failed review navigation does not record a click or its yearly pause', async t => {
  const app = await service(t, {}, { failNavigation: true });
  const response = await app.send('review:open');
  assert.ok(response.error);
  assert.equal(app.stored[Review.STORAGE_KEY], undefined);
});
