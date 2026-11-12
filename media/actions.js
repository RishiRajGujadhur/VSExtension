// The Actions view: Analyze and Edit tabs, a search box, then Pinned, Most Used and the actions by category.
// Hovering an action shows its full shortcut and its tools: an info tooltip, pin, and a menu (also on right-click).
// The arrangement (pinned order, hidden actions, folded sections, descriptions) lives in the extension.
(function () {
  const vscode = acquireVsCodeApi();
  const tabsBar = document.getElementById('tabs');
  const list = document.getElementById('list');
  const search = document.getElementById('search');
  const clear = document.getElementById('clear');
  const found = document.getElementById('found');
  const footer = document.getElementById('footer');
  const tip = document.getElementById('tip');
  const menu = document.getElementById('menu');
  const hint = document.getElementById('tip-hint');
  const saved = vscode.getState() || {};
  let data;
  let tab = saved.tab || 'analyze';
  let focusAfterRender;
  // The graphs that fit the symbol at the cursor, and whether a TypeScript or JavaScript editor is open.
  let cursorFits = [];
  let hasEditor = true;

  const save = (patch) => vscode.setState(Object.assign(saved, patch));
  const send = (change) => vscode.postMessage({ type: 'layout', change });
  const byCommand = (id) => data.actions.find((a) => a.id === id);
  const isPinned = (a) => data.layout.pinned.includes(a.id);
  const isHidden = (a) => data.layout.hidden.includes(a.id);

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const spoken = (shortcut) => shortcut.replace(/ /g, ', then ');
  const icon = (name) => {
    const i = make('i', `codicon codicon-${name}`);
    i.setAttribute('aria-hidden', 'true');
    return i;
  };

  // Where a searched word is found in a text: at the start of a word, or anywhere for three letters or more, so a
  // single letter doesn't light up every word that has it.
  const startsWord = (lower, i) => i === 0 || !/[a-z0-9]/.test(lower[i - 1]);
  function hitsOf(lower, w) {
    const hits = [];
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) {
      if (w.length >= 3 || startsWord(lower, i)) hits.push([i, i + w.length]);
    }
    return hits;
  }

  // Text with the searched words marked.
  function marked(text, words) {
    const span = document.createDocumentFragment();
    if (!words.length) {
      span.append(text);
      return span;
    }
    const lower = text.toLowerCase();
    const hits = words.flatMap((w) => hitsOf(lower, w));
    hits.sort((x, y) => x[0] - y[0]);
    let at = 0;
    for (const [from, to] of hits) {
      if (from < at) continue;
      span.append(text.slice(at, from), make('mark', '', text.slice(from, to)));
      at = to;
    }
    span.append(text.slice(at));
    return span;
  }

  // A shortcut in full, one key cap per chord, so Ctrl+Alt+S 1 reads as two steps: Ctrl+Alt+S, then 1.
  function keyCaps(shortcut) {
    const keys = make('span', 'keys');
    keys.title = `Shortcut: ${spoken(shortcut)}`;
    for (const chord of shortcut.split(' ')) keys.append(make('kbd', '', chord));
    return keys;
  }

  function toolButton(name, label, onClick, pressed) {
    const b = make('button', `tool ${name}`);
    b.type = 'button';
    // One tab stop per action: the tools are reached with the right arrow from it.
    b.tabIndex = -1;
    b.setAttribute('aria-label', label);
    if (name !== 'info') b.title = label;
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    b.append(icon({ info: 'info', pin: pressed ? 'pinned' : 'pin', show: 'eye', more: 'ellipsis' }[name]));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  function item(action, context) {
    const { words, inSearch, pinnedIndex } = context;
    const li = make('li', 'item');
    li.dataset.command = action.id;
    li.dataset.cmd = action.command;
    if (data.active === action.command) {
      li.classList.add('active-feature');
      li.setAttribute('aria-current', 'true');
    } else if (data.last === action.command) {
      li.classList.add('last-feature');
    }
    const run = make('button', 'run');
    run.type = 'button';
    const tile = make('span', 'tile');
    tile.append(icon(action.icon));
    const text = make('span', 'text');
    const label = make('span', 'label');
    label.append(marked(action.label, words));
    const detail = make('span', 'detail');
    detail.append(marked(action.detail, words));
    // Found by its old name: say which, so the new one makes sense.
    if (inSearch && action.formerly && words.length && words.some((w) => action.formerly.toLowerCase().includes(w)) && !words.every((w) => action.label.toLowerCase().includes(w))) {
      detail.append(make('span', 'formerly', ` · was ${action.formerly}`));
    }
    text.append(label, detail);
    if (data.last === action.command && data.active !== action.command) {
      const badge = make('span', 'last-run');
      badge.textContent = 'last run';
      label.append(' ', badge);
    }
    run.append(tile, text);
    run.setAttribute('aria-label', `${action.label}. ${action.detail}${action.startsFrom ? `. Starts from ${action.startsFrom}` : ''}${action.key ? `. Shortcut ${spoken(action.key)}` : ''}${isHidden(action) ? '. Hidden' : ''}`);
    run.addEventListener('click', () => vscode.postMessage({ type: 'run', id: action.id }));
    li.append(run);

    // A hidden action found by search is dimmed, with a crossed-out eye on its tile.
    if (isHidden(action)) {
      li.classList.add('is-hidden');
      tile.append(make('i', 'codicon codicon-eye-closed badge'));
    }

    // Shown on hover or focus: the full shortcut over the tools.
    const trail = make('span', 'trail');
    if (action.key) trail.append(keyCaps(action.key));
    const tools = make('span', 'tools');
    tools.append(toolButton('info', `About ${action.label}`, () => {}));
    if (isHidden(action)) tools.append(toolButton('show', `Show ${action.label} again`, () => send({ kind: 'show', command: action.id })));
    else tools.append(toolButton('pin', isPinned(action) ? `Unpin ${action.label}` : `Pin ${action.label} to the top`, () => togglePin(action), isPinned(action)));
    tools.append(toolButton('more', `More actions for ${action.label}…`, (b) => openMenu(action, b)));
    tools.lastChild.setAttribute('aria-haspopup', 'menu');
    trail.append(tools);
    li.append(trail);

    const infoButton = tools.querySelector('.info');
    infoButton.addEventListener('mouseenter', () => showTip(action, infoButton, 250));
    infoButton.addEventListener('mouseleave', hideTipSoon);
    infoButton.addEventListener('focus', () => showTip(action, infoButton, 0));
    infoButton.addEventListener('blur', hideTipSoon);
    infoButton.addEventListener('click', () => showTip(action, infoButton, 0));

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(action, tools.querySelector('.more'), { x: e.clientX, y: e.clientY });
    });
    run.addEventListener('keydown', (e) => itemKeys(e, action));
    tools.addEventListener('keydown', (e) => {
      const buttons = [...tools.querySelectorAll('.tool')];
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowRight' && i < buttons.length - 1) buttons[i + 1].focus();
      else if (e.key === 'ArrowLeft' && i > 0) buttons[i - 1].focus();
      else if (e.key === 'ArrowLeft' || e.key === 'Escape') run.focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });

    // Pinned actions can be dragged into a new order.
    if (pinnedIndex !== undefined && !inSearch) {
      li.draggable = true;
      li.classList.add('draggable');
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', action.id);
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
    }
    return li;
  }

  function togglePin(action) {
    focusAfterRender = action.id;
    send({ kind: isPinned(action) ? 'unpin' : 'pin', command: action.id });
  }

  function movePinned(action, delta) {
    const i = data.layout.pinned.indexOf(action.id);
    if (i < 0) return false;
    focusAfterRender = action.id;
    send({ kind: 'move', command: action.id, to: i + delta });
    return true;
  }

  function itemKeys(e, action) {
    if (e.key === 'ArrowRight' && !e.altKey) {
      e.preventDefault();
      e.target.closest('.item').querySelector('.tool').focus();
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (movePinned(action, e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      openMenu(action, e.target.closest('.item').querySelector('.more'));
    } else if (e.key === 'Delete' && !isHidden(action)) {
      e.preventDefault();
      moveFocusFrom(e.target);
      send({ kind: 'hide', command: action.id });
    }
  }

  // After an action leaves the list, the next one (or the one before) takes focus.
  function moveFocusFrom(run) {
    const runs = [...list.querySelectorAll('.run')];
    const i = runs.indexOf(run);
    const next = runs[i + 1] || runs[i - 1];
    focusAfterRender = next && next.closest('.item').dataset.command;
  }

  // A section: a heading that folds it, with a count, and its actions as a list.
  function section(id, title, actions, context = {}) {
    if (!actions.length) return;
    const folded = !context.inSearch && data.layout.collapsed.includes(id);
    const heading = make('h2');
    const toggle = make('button', 'section');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!folded));
    toggle.append(icon(folded ? 'chevron-right' : 'chevron-down'));
    // Graph categories carry their icon and say what they show.
    const category = id.startsWith('category:') && data.categories && data.categories[id.slice(9)];
    if (category) {
      toggle.append(icon(category.icon));
      toggle.title = category.description;
    } else if (context.icon) toggle.append(icon(context.icon));
    toggle.append(make('span', 'title', title), make('span', 'count', String(actions.length)));
    if (context.inSearch) toggle.disabled = true;
    else toggle.addEventListener('click', () => {
      focusAfterRender = `section:${id}`;
      send({ kind: 'toggleSection', id });
    });
    toggle.dataset.section = id;
    heading.append(toggle);
    list.append(heading);
    if (folded) return;
    const ul = make('ul', 'group');
    ul.setAttribute('aria-label', title);
    if (context.extra) heading.append(context.extra);
    actions.forEach((a, i) => ul.append(item(a, { ...context, pinnedIndex: id === 'pinned' ? i : undefined })));
    if (id === 'pinned') dropTarget(ul);
    list.append(ul);
  }

  // Dropping a dragged pinned action between others puts it there.
  function dropTarget(ul) {
    const at = (e) => {
      const items = [...ul.querySelectorAll('.item:not(.dragging)')];
      const i = items.findIndex((li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
      return i < 0 ? items.length : i;
    };
    ul.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      ul.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      const items = [...ul.querySelectorAll('.item:not(.dragging)')];
      const i = at(e);
      if (items[i]) items[i].classList.add('drop-before');
      else if (items.length) items[items.length - 1].classList.add('drop-after');
    });
    ul.addEventListener('dragleave', (e) => {
      if (!ul.contains(e.relatedTarget)) ul.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    });
    ul.addEventListener('drop', (e) => {
      e.preventDefault();
      const command = e.dataTransfer.getData('text/plain');
      if (data.layout.pinned.includes(command)) {
        focusAfterRender = command;
        send({ kind: 'move', command, to: at(e) });
      }
    });
  }

  function renderTabs() {
    tabsBar.textContent = '';
    for (const t of data.tabs) {
      const button = make('button', 'tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(t.id === tab));
      button.setAttribute('aria-controls', 'list');
      button.tabIndex = t.id === tab ? 0 : -1;
      button.append(icon(t.icon), document.createTextNode(t.label));
      const count = data.actions.filter((a) => a.tab === t.id && !(data.layout.hidden || []).includes(a.id)).length;
      button.title = `${t.label}: ${count} action${count === 1 ? '' : 's'}`;
      // A dot on the tab that has the action whose result is on screen.
      if (data.active && data.actions.some((a) => a.tab === t.id && a.command === data.active)) {
        const dot = make('span', 'tab-dot');
        dot.title = 'The feature on screen is in this tab';
        button.append(dot);
      }
      button.addEventListener('click', () => choose(t.id));
      tabsBar.append(button);
    }
  }

  function choose(id, focus) {
    tab = id;
    save({ tab });
    renderTabs();
    render();
    if (focus) tabsBar.querySelector('[aria-selected="true"]').focus();
  }

  // Every word must appear in the label, description, category, keywords or shortcut.
  const matches = (action, words) => {
    const text = `${action.label} ${action.detail} ${action.info} ${action.category} ${action.keywords || ''} ${action.key || ''}`.toLowerCase();
    return words.every((w) => hitsOf(text, w).length > 0);
  };

  function render() {
    hideTip();
    list.textContent = '';
    if (!data) return;
    document.body.classList.toggle('compact', data.layout.compact);
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    clear.hidden = !search.value;
    if (words.length) {
      // Search covers both tabs, hidden actions too.
      const hits = data.actions.filter((a) => matches(a, words));
      const perTab = data.tabs.map((t) => [t.label, hits.filter((a) => a.tab === t.id).length]).filter(([, n]) => n);
      found.textContent = hits.length ? `${hits.length} action${hits.length === 1 ? '' : 's'} found${perTab.length > 1 ? `: ${perTab.map(([l, n]) => `${n} in ${l}`).join(', ')}` : ''}` : 'No action found';
      section('search', 'Results', hits, { words, inSearch: true });
      if (!hits.length) {
        const none = make('p', 'none', 'No action matches. Try other words, such as "null", "references", "rename" or a key like "F7", or ask in plain words: ');
        const duck = make('button', 'link', 'Ask the rubber duck…');
        duck.type = 'button';
        duck.addEventListener('click', () => vscode.postMessage({ type: 'run', command: 'tsStructure.howDoI' }));
        none.append(duck);
        list.append(none);
      }
      restoreFocus();
      return;
    }
    found.textContent = '';
    const inTab = data.actions.filter((a) => a.tab === tab);
    const visible = inTab.filter((a) => !isHidden(a));
    const pinned = data.layout.pinned.map(byCommand).filter((a) => a && a.tab === tab && !isHidden(a));
    const top = data.layout.hideMostUsed ? [] : (data.mostUsed[tab] || []).map(byCommand).filter((a) => a && a.tab === tab);
    const context = { words: [] };
    if (tab === 'graphs') {
      // Graphs need something to start from: say so when no source file is open, else offer those that fit the cursor.
      const fitting = visible.filter((a) => cursorFits.includes(a.command));
      section('cursor', 'For the cursor', fitting, { ...context, icon: 'target' });
    }
    section('pinned', 'Pinned', pinned, context);
    section('mostUsed', data.usedOnce ? 'Most used' : 'Start here', top, context);
    const shown = new Set([...pinned, ...top]);
    for (const category of [...new Set(visible.map((a) => a.category))]) {
      section(`category:${category}`, category, visible.filter((a) => a.category === category && !shown.has(a)), context);
    }
    const hidden = inTab.filter(isHidden);
    if (hidden.length) {
      const all = make('button', 'link small', 'Show all');
      all.type = 'button';
      all.addEventListener('click', () => send({ kind: 'showAll' }));
      section('hidden', 'Hidden', hidden, { ...context, extra: all });
    }
    // A first-time tip, until something is pinned or the tip is dismissed.
    hint.hidden = !!(saved.hintDismissed || data.layout.pinned.length);
    restoreFocus();
  }

  function restoreFocus() {
    if (!focusAfterRender) return;
    const target = focusAfterRender.startsWith('section:')
      ? list.querySelector(`[data-section="${CSS.escape(focusAfterRender.slice(8))}"]`)
      : list.querySelector(`.item[data-command="${CSS.escape(focusAfterRender)}"] .run`);
    focusAfterRender = undefined;
    if (target) target.focus();
  }

  function renderHint() {
    hint.textContent = '';
    hint.append(icon('lightbulb'), make('span', '', 'Hover an action for its shortcut. Pin the ones you use to keep them on top, or right-click to hide them.'));
    const close = make('button', 'tool');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss tip');
    close.title = 'Dismiss tip';
    close.append(icon('close'));
    close.addEventListener('click', () => {
      save({ hintDismissed: true });
      hint.hidden = true;
    });
    hint.append(close);
  }

  function renderFooter() {
    footer.textContent = '';
    for (const link of data.footer) {
      const button = make('button', 'link');
      button.type = 'button';
      button.append(icon(link.icon), document.createTextNode(link.label));
      button.addEventListener('click', () => vscode.postMessage({ type: 'run', command: link.command }));
      footer.append(button);
    }
  }

  // The info tooltip: what the action does, its shortcut, and how often it was run. It stays while the pointer is
  // over it, and Escape closes it (WCAG 1.4.13).
  let tipTimer;
  let tipFor;
  function showTip(action, anchor, delay) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      tip.textContent = '';
      tip.append(make('strong', '', action.label), make('p', '', action.info));
      const facts = make('div', 'facts');
      if (action.key) {
        const row = make('div', 'fact');
        row.append(make('span', '', 'Shortcut'), keyCaps(action.key));
        facts.append(row);
      }
      const runs = (data.usage && data.usage[action.id]) || 0;
      const row = make('div', 'fact');
      row.append(make('span', '', 'Used'), make('span', '', runs ? `${runs} time${runs === 1 ? '' : 's'}` : 'not yet'));
      facts.append(row);
      if (action.formerly) {
        const was = make('div', 'fact');
        was.append(make('span', '', 'Formerly'), make('span', '', action.formerly));
        facts.append(was);
      }
      if (action.startsFrom) {
        const from = make('div', 'fact');
        from.append(make('span', '', 'Starts from'), make('span', '', action.startsFrom));
        facts.append(from);
      }
      if (action.levels) {
        const deep = make('div', 'fact');
        deep.append(make('span', '', 'Levels'), make('span', '', `${action.levels}, set in the chart`));
        facts.append(deep);
      }
      const where = make('div', 'fact');
      where.append(make('span', '', 'Category'), make('span', '', `${data.tabs.find((t) => t.id === action.tab).label} › ${action.category}`));
      facts.append(where);
      tip.append(facts);
      tip.hidden = false;
      tipFor = anchor;
      anchor.setAttribute('aria-describedby', 'tip');
      place(tip, anchor.getBoundingClientRect());
    }, delay);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tip.hidden = true;
    if (tipFor) tipFor.removeAttribute('aria-describedby');
    tipFor = undefined;
  }
  function hideTipSoon() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (!tip.matches(':hover')) hideTip();
    }, 150);
  }
  tip.addEventListener('mouseleave', hideTipSoon);

  // A floating box next to a rectangle, kept inside the view: below it, or above when there is no room.
  function place(box, rect, point) {
    box.style.left = '0px';
    box.style.top = '0px';
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const x = point ? point.x : rect.right - w;
    const below = point ? point.y : rect.bottom + 4;
    const y = below + h > window.innerHeight - 4 ? Math.max(4, (point ? point.y : rect.top - 4) - h) : below;
    box.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, x))}px`;
    box.style.top = `${y}px`;
  }

  // The menu of an action: run, pin, reorder, hide, change its shortcut, copy its id.
  let menuReturn;
  function openMenu(action, anchor, point) {
    hideTip();
    menu.textContent = '';
    const entries = [];
    const add = (label, iconName, onPick, key) => entries.push({ label, iconName, onPick, key });
    const sep = () => entries.push(undefined);
    add('Run', 'play', () => vscode.postMessage({ type: 'run', id: action.id }), 'Enter');
    // An analysis that can also be drawn: run it as a chart.
    const asGraph = action.tab !== 'graphs' && data.actions.find((a) => a.tab === 'graphs' && a.command === action.command);
    if (asGraph) add('Open as chart', 'graph-scatter', () => vscode.postMessage({ type: 'run', id: asGraph.id }));
    sep();
    if (isHidden(action)) add('Show again', 'eye', () => send({ kind: 'show', command: action.id }));
    else {
      add(isPinned(action) ? 'Unpin' : 'Pin to top', isPinned(action) ? 'pinned' : 'pin', () => togglePin(action));
      const i = data.layout.pinned.indexOf(action.id);
      if (i > 0) add('Move up', 'arrow-up', () => movePinned(action, -1), 'Alt+Up');
      if (i >= 0 && i < data.layout.pinned.length - 1) add('Move down', 'arrow-down', () => movePinned(action, 1), 'Alt+Down');
      add('Hide', 'eye-closed', () => {
        const run = list.querySelector(`.item[data-command="${CSS.escape(action.id)}"] .run`);
        if (run) moveFocusFrom(run);
        send({ kind: 'hide', command: action.id });
      }, 'Delete');
    }
    sep();
    add(action.key ? 'Change shortcut…' : 'Add a shortcut…', 'keyboard', () => vscode.postMessage({ type: 'changeShortcut', command: action.command }));
    add('Copy command ID', 'copy', () => vscode.postMessage({ type: 'copyId', command: action.command }));
    for (const entry of entries) {
      if (!entry) {
        menu.append(make('div', 'separator'));
        menu.lastChild.setAttribute('role', 'separator');
        continue;
      }
      const b = make('button', 'menuitem');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.append(icon(entry.iconName), make('span', 'grow', entry.label));
      if (entry.key) b.append(make('span', 'menukey', entry.key));
      b.addEventListener('click', () => {
        closeMenu(false);
        entry.onPick();
      });
      menu.append(b);
    }
    menu.setAttribute('aria-label', `${action.label} actions`);
    menu.hidden = false;
    menuReturn = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    place(menu, anchor.getBoundingClientRect(), point);
    menu.querySelector('.menuitem').focus();
  }
  function closeMenu(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (menuReturn) {
      menuReturn.setAttribute('aria-expanded', 'false');
      if (refocus && document.contains(menuReturn)) menuReturn.closest('.item').querySelector('.run').focus();
    }
    menuReturn = undefined;
  }
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.menuitem')];
    const i = items.indexOf(document.activeElement);
    const go = (j) => items[(j + items.length) % items.length].focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') closeMenu();
    else return;
    e.preventDefault();
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu(false);
  });
  window.addEventListener('blur', () => closeMenu(false));

  // Keyboard: arrows move between tabs and between actions, Home and End to the ends; typing searches; / or
  // Ctrl+F goes to the search box; Escape clears it.
  tabsBar.addEventListener('keydown', (e) => {
    const ids = data.tabs.map((t) => t.id);
    const i = ids.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      choose(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length], true);
    }
  });
  list.addEventListener('keydown', (e) => {
    const runs = [...list.querySelectorAll('.run, .section:not(:disabled)')];
    const i = runs.indexOf(document.activeElement);
    if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    let j;
    if (e.key === 'ArrowDown') j = Math.min(runs.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = runs.length - 1;
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Typing on the list starts a search.
      search.focus();
      search.value += e.key;
      render();
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    runs[j].focus();
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target === search;
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (e.key === 'Escape' && !tip.hidden) {
      hideTip();
    }
  });
  search.addEventListener('input', render);
  clear.addEventListener('click', () => {
    search.value = '';
    render();
    search.focus();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      render();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const first = list.querySelector('.run');
      if (first) {
        e.preventDefault();
        if (e.key === 'Enter' && search.value.trim()) first.click();
        else first.focus();
      }
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data.type === 'cursor') {
      cursorFits = event.data.fits || [];
      hasEditor = event.data.hasEditor !== false;
      if (data && tab === 'graphs') render();
      return;
    }
    if (event.data.type === 'tab') {
      if (data && data.tabs.some((t) => t.id === event.data.id)) choose(event.data.id, true);
      else tab = event.data.id;
      return;
    }
    if (event.data.type === 'active') {
      if (!data) return;
      data.active = event.data.active;
      data.last = event.data.last;
      renderTabs();
      render();
      return;
    }
    if (event.data.type !== 'actions') return;
    data = event.data;
    document.body.classList.toggle('accent-theme', data.accent === 'theme');
    if (!data.tabs.some((t) => t.id === tab)) tab = data.tabs[0].id;
    // Keep the focused action focused across the redraw.
    if (!focusAfterRender && list.contains(document.activeElement)) {
      const at = document.activeElement.closest('.item');
      const sectionButton = document.activeElement.closest('.section');
      if (at) focusAfterRender = at.dataset.command;
      else if (sectionButton) focusAfterRender = `section:${sectionButton.dataset.section}`;
    }
    renderTabs();
    render();
    renderFooter();
  });
  renderHint();
  vscode.postMessage({ type: 'ready' });
})();
