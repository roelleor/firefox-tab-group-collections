(function (root) {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let refreshTimerId = null;

  function getMediaMode() {
    return mediaQuery.matches ? 'dark' : 'light';
  }

  function resolveMode(settingMode) {
    if (settingMode === 'dark') {
      return 'dark';
    }

    if (settingMode === 'light') {
      return 'light';
    }

    return getMediaMode();
  }

  async function getSettingMode() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'ui:getThemeMode' });
      if (response?.error) {
        return null;
      }

      return response?.mode || null;
    } catch (error) {
      return null;
    }
  }

  async function applyTheme() {
    const mode = resolveMode(await getSettingMode());
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }

  function start() {
    const refresh = () => {
      applyTheme().catch(() => {});
    };

    refresh();

    if (browser.runtime?.onMessage?.addListener) {
      browser.runtime.onMessage.addListener((message) => {
        if (message?.type === 'ui:themeModeChanged') {
          refresh();
        }
      });
    }

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', refresh);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(refresh);
    }

    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refresh();
      }
    });

    if (refreshTimerId === null) {
      refreshTimerId = window.setInterval(() => {
        if (!document.hidden) {
          refresh();
        }
      }, 2000);
    }
  }

  root.TabGroupCollectionsUiTheme = { start };
})(typeof globalThis !== 'undefined' ? globalThis : this);
