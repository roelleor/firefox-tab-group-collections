(function () {
  const Review = globalThis.TabGroupCollectionsReview;
  const card = document.querySelector('[data-review-card]');

  /** Keep optional reminder failures out of the collection workflow. */
  async function send(type, extra = {}) {
    try {
      const response = await browser.runtime.sendMessage({ type, ...extra });
      if (response?.error) throw new Error(response.error);
      return response;
    } catch (error) {
      console.error('Unable to update review invitation.', error);
      return null;
    }
  }

  /** Hide the card without stranding keyboard focus inside a hidden action. */
  function hideCard() {
    if (!card) return;
    const containedFocus = card.contains(document.activeElement);
    card.classList.add('hidden');
    if (containedFocus) document.getElementById('filter-input')?.focus();
  }

  /** Count only completed collection actions, never panel views or automatic refreshes. */
  function recordActivity() {
    void send('review:activity');
  }

  for (const link of document.querySelectorAll('[data-review-link]')) {
    link.href = Review.REVIEW_URL;
    // The background finishes saving the pause even when opening a tab closes the toolbar popup.
    const open = event => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      event.preventDefault();
      void send('review:open', { active: !(event.ctrlKey || event.metaKey || event.button === 1) });
    };
    link.addEventListener('click', open);
    link.addEventListener('auxclick', open);
  }

  for (const button of document.querySelectorAll('[data-review-dismiss]')) {
    button.addEventListener('click', () => {
      hideCard();
      void send('review:dismiss');
    });
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    const change = changes[Review.STORAGE_KEY];
    if (areaName !== 'local' || !change) return;
    if (change.newValue?.lastDismissedAt !== change.oldValue?.lastDismissedAt ||
        change.newValue?.lastReviewAt !== change.oldValue?.lastReviewAt) {
      hideCard();
    }
  });

  /** Claim the card only when this document opens; later collection activity never interrupts it. */
  async function start() {
    await send('review:visit');
    if (!card) return;
    const response = await send('review:show');
    card.classList.toggle('hidden', response?.showPrompt !== true);
  }

  globalThis.TabGroupCollectionsReviewUi = { recordActivity };
  void start();
})();
