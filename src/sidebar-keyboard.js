/** Keyboard navigation and focus continuity for the sidebar's native controls. */
globalThis.TabGroupCollectionsSidebarKeyboard = (() => {
  const PANEL_SELECTOR = '.open-menu, .delete-menu, .group-color-menu, .move-panel';
  const NAVIGATION_SELECTOR = '.collection-title-button, .group-button, ' +
    '.open-menu button, .delete-menu button, .group-color-menu button, .move-panel button, .move-panel select';

  /** Ignore controls hidden by either their own panel or an ancestor collection. */
  function isAvailable(node) {
    return Boolean(node && !node.disabled && !node.closest('.hidden') && node.getClientRects().length);
  }

  /** Bind navigation to existing sidebar actions; rendering calls capture, enhance, then restore. */
  function create({ root, filter, onCollapse, onActivate, onClearFilter, onClosePanel, onReorder }) {
    let initializedFocus = false;

    /** Find a control by its opaque identity without interpolating collection names into selectors. */
    function findControl(key) {
      return Array.from(root.querySelectorAll('[data-focus-key]'))
        .find(node => node.dataset.focusKey === key && isAvailable(node));
    }

    /** Return primary rows and expanded choices in their displayed reading order. */
    function navigationItems() {
      return Array.from(root.querySelectorAll(NAVIGATION_SELECTOR)).filter(isAvailable);
    }

    /** Describe the focused control and unfinished move forms before replacing the list. */
    function capture() {
      const active = document.activeElement;
      const row = active.closest('.group-row');
      const card = active.closest('.collection-card');
      const panel = active.closest(PANEL_SELECTOR);
      const items = root.contains(active) ? navigationItems() : [];
      const following = items.filter(node => active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
      const rect = active.getBoundingClientRect();
      return {
        key: root.contains(active) ? active.dataset.focusKey : null,
        groupId: row?.dataset.focusGroupId,
        collectionId: card?.dataset.collectionId,
        returnKey: panel?.dataset.triggerKey,
        wasVisible: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
        followingKeys: following.map(node => node.dataset.focusKey),
        // Only an open form can contain an unfinished user choice. Closed forms
        // otherwise add work for every group on each keystroke and tab update.
        forms: Array.from(root.querySelectorAll('.move-panel:not(.hidden) .move-select')).filter(isAvailable).map(node => ({
          key: node.dataset.focusKey,
          value: node.value,
          name: node.dataset.newCollectionName
        }))
      };
    }

    /** Expose each panel's state and the control to return to when it closes. */
    function connectPanel(trigger, panel, id) {
      if (!trigger || !panel) return;
      panel.id = id;
      panel.dataset.triggerKey = trigger.dataset.focusKey;
      trigger.setAttribute('aria-controls', id);
      trigger.setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
    }

    /** Assign stable identities and disclosure semantics to newly rendered native controls. */
    function enhance() {
      for (const card of root.querySelectorAll('.collection-card')) {
        const collectionId = card.dataset.collectionId;
        for (const node of card.querySelectorAll('button, select')) {
          const row = node.closest('.group-row');
          const role = node.dataset.focusRole || node.classList[0];
          const choice = node.matches('.action-button, .group-color-option') && !node.dataset.focusRole
            ? (node.getAttribute('aria-label') || node.textContent)
            : '';
          // Group identities omit collection membership so focus can follow a moved group.
          node.dataset.focusKey = JSON.stringify([row ? row.dataset.focusGroupId : collectionId, role, choice]);
        }

        const body = card.querySelector('.collection-body');
        const id = `collection-body-${encodeURIComponent(collectionId)}`;
        connectPanel(card.querySelector('.toggle-button'), body, id);
        connectPanel(card.querySelector('.collection-title-button'), body, id);
        connectPanel(card.querySelector('.collection-open-button[aria-expanded]'), card.querySelector('.open-menu'), `${id}-open`);
        connectPanel(card.querySelector('.collection-delete-button'), card.querySelector('.collection-body > .delete-menu'), `${id}-delete`);
        for (const row of card.querySelectorAll('.group-row')) {
          const groupId = `${id}-${encodeURIComponent(row.dataset.focusGroupId)}`;
          connectPanel(row.querySelector('.group-dot-button'), row.querySelector('.group-color-menu'), `${groupId}-color`);
          connectPanel(row.querySelector('.move-button:not(.group-delete-button)'), row.querySelector('.move-panel'), `${groupId}-move`);
          connectPanel(row.querySelector('.group-delete-button'), row.querySelector('.group-delete-menu'), `${groupId}-delete`);
          const handle = row.querySelector('.drag-handle');
          const moveTrigger = row.querySelector('.move-button:not(.group-delete-button)');
          if (handle && moveTrigger) {
            handle.setAttribute('aria-controls', moveTrigger.getAttribute('aria-controls'));
            handle.setAttribute('aria-expanded', moveTrigger.getAttribute('aria-expanded'));
            handle.addEventListener('click', () => moveTrigger.click());
          }
          for (const node of row.querySelectorAll('.group-button, .drag-handle')) {
            node.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
            node.title = `${node.title ? `${node.title}. ` : ''}Alt+Up/Down to reorder`;
          }
        }
      }
    }

    /** Restore forms first, then the original control or a surviving nearby row after an update. */
    function restore(saved) {
      if (!saved.key && !saved.forms.length) return;
      // Resolve all surviving identities once, rather than scanning every control
      // again for each pending form or deleted-row fallback.
      const controls = new Map(Array.from(root.querySelectorAll('[data-focus-key]'))
        .filter(isAvailable).map(node => [node.dataset.focusKey, node]));
      for (const form of saved.forms) {
        const select = controls.get(form.key);
        if (!select) continue;
        if (Array.from(select.options).some(option => option.value === form.value)) select.value = form.value;
        if (form.name) {
          select.dataset.newCollectionName = form.name;
          select.selectedOptions[0].textContent = `New collection: ${form.name}`;
        }
      }
      if (!saved.key) return;
      const sameGroup = Array.from(root.querySelectorAll('.group-row'))
        .find(row => row.dataset.focusGroupId === saved.groupId);
      const sameCollection = Array.from(root.querySelectorAll('.collection-card'))
        .find(card => card.dataset.collectionId === saved.collectionId);
      const target = controls.get(saved.key) || controls.get(saved.returnKey) ||
        (isAvailable(sameGroup?.querySelector('.group-button')) && sameGroup.querySelector('.group-button')) ||
        (isAvailable(sameCollection?.querySelector('.collection-title-button')) && sameCollection.querySelector('.collection-title-button')) ||
        controls.get(saved.followingKeys.find(key => controls.has(key))) || navigationItems().at(-1) || filter;
      target.focus({ preventScroll: true });
      // Reveal controls relocated by an action, but respect someone who scrolled
      // away from their focus before a passive tab/storage refresh arrived.
      if (saved.wasVisible) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    /** Focus search on first opening only; later focus events must preserve the user's place. */
    function focusInitially() {
      if (initializedFocus || !document.hasFocus()) return;
      initializedFocus = true;
      if (document.activeElement === document.body) filter.focus();
    }

    /** Resolve a native disclosure's panel without treating collection bodies as action menus. */
    function controlledPanel(node) {
      const panel = document.getElementById(node?.getAttribute('aria-controls'));
      return panel?.matches(PANEL_SELECTOR) ? panel : null;
    }

    /** Close a panel through sidebar state, then return to its triggering control. */
    function dismiss(panel) {
      const key = panel.dataset.triggerKey;
      onClosePanel(panel);
      findControl(key)?.focus();
    }

    /** Add navigation without consuming input-method keys, native selects, or browser shortcuts. */
    function handleKeydown(event) {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      const active = document.activeElement;
      const row = active.closest('.group-row');
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
          ['ArrowUp', 'ArrowDown'].includes(event.key) && row && !active.matches('select, input, textarea')) {
        event.preventDefault();
        if (!document.body.classList.contains('is-busy')) onReorder(row, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || active.matches('select, textarea, [contenteditable="true"]')) return;
      if (active.matches('input') && active !== filter) return;
      const inList = root.contains(active);
      if (inList && document.body.classList.contains('is-busy')) {
        if (['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        const ownPanel = active.closest(PANEL_SELECTOR) || controlledPanel(active);
        const panel = isAvailable(ownPanel) ? ownPanel : Array.from(root.querySelectorAll(PANEL_SELECTOR)).filter(isAvailable).at(-1);
        event.preventDefault();
        event.stopPropagation();
        if (panel) dismiss(panel);
        else {
          if (filter.value) onClearFilter();
          filter.focus();
        }
        return;
      }
      const items = navigationItems();
      const searchEntry = active === filter || active === document.body;
      if (event.key === 'Enter' && searchEntry) {
        event.preventDefault();
        const first = root.querySelector('.collection-title-button');
        if (first) onActivate(first.closest('.collection-card').dataset.collectionId);
        return;
      }
      if ((event.key === 'ArrowDown' && searchEntry) ||
          (inList && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))) {
        event.preventDefault();
        const panel = controlledPanel(active);
        if (event.key === 'ArrowDown' && isAvailable(panel)) {
          Array.from(panel.querySelectorAll('button, select')).find(isAvailable)?.focus();
        } else if (event.key === 'Home') items[0]?.focus();
        else if (event.key === 'End') items.at(-1)?.focus();
        else if (event.key === 'ArrowDown') {
          (items.find(node => active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) || items.at(-1))?.focus();
        } else {
          (items.filter(node => active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING).at(-1) || filter).focus();
        }
        return;
      }
      if (!inList) return;
      const card = active.closest('.collection-card');
      const heading = card.querySelector('.collection-title-button');
      const panel = active.closest(PANEL_SELECTOR) || controlledPanel(active);
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (isAvailable(panel)) dismiss(panel);
        else if (active !== heading) heading.focus();
        else if (!filter.value.trim()) onCollapse(card.dataset.collectionId, true);
      } else if (event.key === 'ArrowRight') {
        if (active === heading || active.matches('.toggle-button')) {
          event.preventDefault();
          if (heading.getAttribute('aria-expanded') === 'false') onCollapse(card.dataset.collectionId, false);
          else card.querySelector('.group-button')?.focus();
        } else if (panel && controlledPanel(active)) {
          event.preventDefault();
          if (active.getAttribute('aria-expanded') === 'false') active.click();
          else Array.from(panel.querySelectorAll('button, select')).find(isAvailable)?.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('focus', focusInitially);
    focusInitially();
    return { capture, enhance, restore };
  }

  return { create };
})();
