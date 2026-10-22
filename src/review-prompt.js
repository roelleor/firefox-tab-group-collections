(function (root) {
  const STORAGE_KEY = 'tab-group-collections.review-prompt';
  const REVIEW_URL = 'https://addons.mozilla.org/en-US/firefox/addon/tab-group-collections/reviews/';
  const MIN_AGE_MS = 14 * 86400000;
  const MIN_ACTIVE_DAYS = 5;

  /** Read only reminder preferences; collection names, groups, and tabs never enter this state. */
  function visit(raw, now) {
    const state = raw && typeof raw === 'object' ? raw : {};
    const timestamp = value => Number.isFinite(value) && value > 0 ? value : 0;
    return {
      firstUsedAt: timestamp(state.firstUsedAt) || now,
      activeDays: Array.isArray(state.activeDays)
        ? [...new Set(state.activeDays.filter(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)))].slice(0, MIN_ACTIVE_DAYS)
        : [],
      nextPromptAt: timestamp(state.nextPromptAt),
      lastDismissedAt: timestamp(state.lastDismissedAt),
      lastReviewAt: timestamp(state.lastReviewAt)
    };
  }

  /** Count a successful collection action once per local calendar day, keeping at most five dates. */
  function activity(raw, now) {
    const state = visit(raw, now);
    const date = new Date(now);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (state.activeDays.length < MIN_ACTIVE_DAYS && !state.activeDays.includes(day)) {
      state.activeDays.push(day);
    }
    return state;
  }

  /** Advance calendar months, clamping month-end dates rather than overflowing into the next month. */
  function monthsAfter(now, months) {
    const date = new Date(now);
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
    return date.getTime();
  }

  /** Reserve a single sidebar appearance; ignoring it also starts the three-month pause. */
  function claim(raw, now) {
    const state = visit(raw, now);
    const showPrompt = now - state.firstUsedAt >= MIN_AGE_MS &&
      state.activeDays.length >= MIN_ACTIVE_DAYS && now >= state.nextPromptAt;
    if (showPrompt) state.nextPromptAt = monthsAfter(now, 3);
    return { state, showPrompt };
  }

  /** Pause the card after dismissal without shortening an existing review-click pause. */
  function dismiss(raw, now) {
    const state = visit(raw, now);
    state.lastDismissedAt = now;
    state.nextPromptAt = Math.max(state.nextPromptAt, monthsAfter(now, 3));
    return state;
  }

  /** A link click earns a year of quiet; no attempt is made to detect a submitted review. */
  function reviewed(raw, now) {
    const state = visit(raw, now);
    state.lastReviewAt = now;
    state.nextPromptAt = Math.max(state.nextPromptAt, monthsAfter(now, 12));
    return state;
  }

  const api = { STORAGE_KEY, REVIEW_URL, visit, activity, claim, dismiss, reviewed };
  root.TabGroupCollectionsReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
