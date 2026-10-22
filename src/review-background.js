(function () {
  const Review = globalThis.TabGroupCollectionsReview;
  let pending = Promise.resolve();

  /** Serialize preference changes across popup/sidebar windows, writing only the reminder key. */
  function updatePreferences(action) {
    const operation = pending.then(async () => {
      const raw = (await browser.storage.local.get(Review.STORAGE_KEY))[Review.STORAGE_KEY];
      const now = Date.now();
      const result = action === 'show'
        ? Review.claim(raw, now)
        : { state: Review[action](raw, now) };
      if (JSON.stringify(raw) !== JSON.stringify(result.state)) {
        await browser.storage.local.set({ [Review.STORAGE_KEY]: result.state });
      }
      return { showPrompt: result.showPrompt === true };
    });
    pending = operation.catch(() => {});
    return operation;
  }

  /** Open Mozilla first so a reminder-storage failure cannot prevent a voluntary review. */
  async function openReview(active) {
    await browser.tabs.create({ url: Review.REVIEW_URL, active });
    await updatePreferences('reviewed').catch(error => {
      console.error('Unable to save review reminder preference.', error);
    });
    return {};
  }

  browser.runtime.onMessage.addListener(message => {
    const actions = {
      'review:visit': 'visit',
      'review:activity': 'activity',
      'review:show': 'show',
      'review:dismiss': 'dismiss'
    };
    const action = actions[message?.type];
    const operation = message?.type === 'review:open'
      ? openReview(message.active !== false)
      : action ? updatePreferences(action) : null;
    return operation?.catch(error => ({ error: error.message })) ?? undefined;
  });
})();
