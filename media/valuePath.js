// The result panel: the result on show as a card. A Value path shows its values on a timeline; any other result
// shows its groups as steps with their rows (the first few, the rest one click away; rows inside rows fold).
(function () {
  const vscode = acquireVsCodeApi();
  const box = document.getElementById('card');
  const make = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const icon = (name) => {
    const i = make('i', `codicon codicon-${name}`);
    i.setAttribute('aria-hidden', 'true');
    return i;
  };
  const tool = (name, label, type) => {
    const b = make('button', 'card-tool');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    if (type !== 'none') b.addEventListener('click', () => vscode.postMessage({ type }));
    return b;
  };
  const toneIcons = { ok: 'pass', warning: 'warning', error: 'error', info: 'info' };
  const toneWords = { ok: 'Safe', warning: 'Warning', error: 'Problem', info: 'Note' };
  const SHOWN = 4;
  /** Which groups and rows were opened, by their path, so a redraw keeps them open. */
  const opened = new Set();

  function head(card) {
    const top = make('div', 'card-head');
    const title = make('span', 'card-title');
    title.append(icon(card.icon), make('span', 'card-heading', card.heading));
    if (card.subject) title.append(make('strong', 'card-subject', card.subject));
    top.append(title);
    // The timing chip and the buttons wrap together, as one group, when the title needs the line.
    const tools = make('span', 'card-tools');
    top.append(tools);
    if (card.timing) {
      const time = make('span', 'card-time');
      time.title = `How long the analysis took${card.ranAt ? `; it ran at ${card.ranAt}` : ''}`;
      time.append(icon('clock'), card.timing);
      tools.append(time);
    }
    tools.append(tool('copy', 'Copy as Markdown', 'copy'), tool('graph', 'Draw as chart', 'chart'), tool('list-tree', 'Show as a list (the Results view)', 'list'));
    return top;
  }

  function staleNote() {
    const note = make('p', 'card-stale');
    note.append(icon('warning'), ' Files changed since this ran. ');
    const again = make('button', 'link', 'Run it again');
    again.type = 'button';
    again.addEventListener('click', () => vscode.postMessage({ type: 'rerun' }));
    note.append(again);
    return note;
  }

  function stepCard(content, onClick, className = '') {
    const button = make('button', `step-card ${className}`.trim());
    button.type = 'button';
    button.append(...content);
    if (onClick) button.addEventListener('click', onClick);
    else button.disabled = true;
    return button;
  }

  function nextStep() {
    const next = make('li', 'step next');
    const tile = make('span', 'step-tile');
    tile.append(icon('arrow-right'));
    const text = make('span', 'step-text');
    text.append(make('strong', '', 'Next'), make('span', 'step-when', 'Run another analysis here'));
    next.append(stepCard([tile, text, icon('chevron-right')], () => vscode.postMessage({ type: 'next' })));
    return next;
  }

  const open = (location) => vscode.postMessage({ type: 'open', location });

  // ---- A Value path: each value with how many ways lead to it and what has to be true.
  function valueSteps(value, line) {
    for (const v of value.values) {
      const li = make('li', 'step value');
      const tile = make('span', 'step-tile');
      tile.append(icon(v.icon === 'symbol-constant' ? 'symbol-constant' : 'symbol-variable'));
      const text = make('span', 'step-text');
      const top = make('span', 'step-top');
      top.append(make('strong', '', v.title), make('span', 'step-badge', v.ways));
      const when = make('span', 'step-when');
      if (v.always) when.append(make('span', 'infinity', '∞'), ` ${v.when}`);
      else when.append(icon('filter'), ` ${v.when}`);
      text.append(top, when);
      const button = stepCard([tile, text], v.location ? () => open(v.location) : undefined);
      if (v.location) button.title = 'Open where this value comes from';
      li.append(button);
      line.append(li);
    }
  }

  // ---- Any other result: its groups as steps, rows inside.
  const matches = (row) => !filter || `${row.label} ${row.description || ''}`.toLowerCase().includes(filter) || row.children.some(matches);
  const isTestRow = (row) => /(^|[\s/\\·(])[\w.-]+[._](test|spec)\.[cm]?[jt]sx?\b/.test(`${row.label} ${row.description || ''}`) || (row.location && /(\.|_)(test|spec)\.[cm]?[jt]sx?$|[\\/](__tests__|tests?)[\\/]/.test(row.location.file));
  function rowList(rows, more, pathKey, depth) {
    const list = make('ul', 'rows');
    rows = rows.filter(matches);
    const showAll = !!filter || opened.has(`${pathKey}/all`);
    const shown = showAll ? rows : rows.slice(0, SHOWN);
    shown.forEach((row, i) => {
      const key = `${pathKey}/${i}`;
      const li = make('li', `row${row.tone ? ` tone-${row.tone}` : ''}${isTestRow(row) ? ' test' : ''}`);
      li.title = [row.label, row.description].filter(Boolean).join(' — ');
      const line = make('div', 'row-line');
      const hasChildren = row.children.length > 0;
      if (hasChildren) {
        const fold = make('button', 'row-fold');
        fold.type = 'button';
        const isOpen = opened.has(key) || (!!filter && row.children.some(matches));
        fold.setAttribute('aria-expanded', String(isOpen));
        fold.setAttribute('aria-label', `${isOpen ? 'Fold' : 'Unfold'} ${row.label}`);
        fold.append(icon(isOpen ? 'chevron-down' : 'chevron-right'));
        fold.addEventListener('click', () => { isOpen ? opened.delete(key) : opened.add(key); redraw(); });
        line.append(fold);
      } else {
        line.append(make('span', 'row-fold-space'));
      }
      const label = make(row.location ? 'button' : 'span', 'row-label');
      if (row.location) {
        label.type = 'button';
        label.title = 'Open the code';
        label.addEventListener('click', () => open(row.location));
      }
      if (row.tone && toneIcons[row.tone]) {
        const t = icon(toneIcons[row.tone]);
        t.classList.add('row-tone');
        label.append(t, make('span', 'visually-hidden', `${toneWords[row.tone]}: `));
      } else if (isTestRow(row)) {
        const t = icon('beaker');
        t.classList.add('row-test');
        label.append(t, make('span', 'visually-hidden', 'Test: '));
      } else if (row.icon) {
        label.append(icon(row.icon));
      }
      label.append(make('span', 'row-text', row.label));
      line.append(label);
      if (row.description) line.append(make('span', 'row-desc', row.description));
      li.append(line);
      if (hasChildren && (opened.has(key) || (filter && row.children.some(matches))) && depth < 6) li.append(rowList(row.children, row.more, key, depth + 1));
      list.append(li);
    });
    const hidden = rows.length - shown.length + (showAll ? more : 0);
    if (!showAll && rows.length > SHOWN) {
      list.append(make('li', 'row shown-count', `showing ${SHOWN} of ${rows.length + more}`));
      const all = make('button', 'link more', `+ ${rows.length - SHOWN + more} more`);
      all.type = 'button';
      all.addEventListener('click', () => { opened.add(`${pathKey}/all`); redraw(); });
      list.append(make('li', 'row more-row')).append(all);
    } else if (more) {
      list.append(make('li', 'row more-row', `+ ${more} more in the Results list`));
    }
    void hidden;
    return list;
  }

  function groupSteps(rows, line) {
    rows.forEach((group, i) => {
      if (!matches(group)) return;
      const li = make('li', `step value${group.tone ? ` tone-${group.tone}` : ''}`);
      const tile = make('span', 'step-tile');
      tile.append(icon(group.tone && toneIcons[group.tone] ? toneIcons[group.tone] : group.icon || 'circle-small'));
      const text = make('span', 'step-text');
      const top = make('span', 'step-top');
      top.append(make('strong', '', group.label));
      const count = group.children.length + group.more;
      if (count) top.append(make('span', 'step-badge', String(count)));
      text.append(top);
      if (group.description) text.append(make('span', 'step-when', group.description));
      li.append(stepCard([tile, text], group.location ? () => open(group.location) : undefined, group.children.length ? 'has-rows' : ''));
      if (group.children.length) li.append(rowList(group.children, group.more, `g${i}`, 1));
      line.append(li);
    });
  }

  let filter = '';
  /** The filter box and the expand and fold buttons above the groups. */
  function rowTools(card) {
    const bar = make('div', 'row-tools');
    const search = make('input', 'row-filter');
    search.type = 'search';
    search.placeholder = 'Filter rows (/)';
    search.setAttribute('aria-label', 'Filter the rows of the result');
    search.value = filter;
    search.addEventListener('input', () => {
      filter = search.value.trim().toLowerCase();
      redraw();
      const again = box.querySelector('.row-filter');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; filter = ''; redraw(); box.querySelector('.row-filter')?.focus(); } });
    const expandAll = tool('expand-all', 'Expand all', 'none');
    expandAll.addEventListener('click', () => {
      const walk = (rows, key) => rows.forEach((r, i) => { const k = `${key}/${i}`; if (r.children.length) { opened.add(k); walk(r.children, k); } });
      (card.rows || []).forEach((g, i) => { opened.add(`g${i}/all`); walk(g.children, `g${i}`); });
      redraw();
    });
    const foldAll = tool('collapse-all', 'Fold all', 'none');
    foldAll.addEventListener('click', () => { opened.clear(); redraw(); });
    bar.append(search, expandAll, foldAll);
    return bar;
  }
  // / goes to the filter box.
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && !(e.target.closest && e.target.closest('input, textarea'))) {
      const search = box.querySelector('.row-filter');
      if (search) { e.preventDefault(); search.focus(); }
    }
  });

  let last;
  function redraw() {
    if (last) render(last.card, last.stale);
  }

  function render(card, stale) {
    last = { card, stale };
    const scroll = window.scrollY;
    box.textContent = '';
    if (!card) {
      box.append(make('p', 'empty', 'Run an analysis, such as Data flow or Why this value, and its result shows here as a card.'));
      return;
    }
    box.append(head(card));
    if (card.summary) box.append(make('p', 'card-summary', `${card.summary}.`));
    if (stale) box.append(staleNote());
    for (const w of card.warnings) box.append(make('p', 'card-warning', w));
    if (card.value && card.value.needs) box.append(make('p', 'card-needs', card.value.needs));
    const line = make('ol', 'timeline');
    box.append(line);
    if (card.value) valueSteps(card.value, line);
    else {
      if ((card.rows || []).length) box.insertBefore(rowTools(card), line);
      else box.insertBefore(make('p', 'empty', 'Nothing found. Try another symbol, or a wider scope where the analysis asks for one.'), line);
      groupSteps(card.rows || [], line);
      if (filter && !line.querySelector('.step.value')) line.prepend(make('li', 'empty no-match', `No row matches “${filter}”.`));
    }
    line.append(nextStep());
    if (card.value && card.value.impossible) box.append(make('p', 'card-needs', `Left out: ${card.value.impossible}.`));
    window.scrollTo(0, scroll);
  }

  window.addEventListener('message', (event) => {
    if (event.data.type !== 'card') return;
    document.body.classList.toggle('accent-pink', event.data.accent === 'pink');
    document.body.classList.toggle('accent-theme', event.data.accent === 'theme');
    // Another analysis, or another subject, starts folded again; the same one run again keeps what was open.
    if (!last || !event.data.card || last.card?.heading !== event.data.card.heading || last.card?.subject !== event.data.card.subject) { opened.clear(); filter = ''; }
    render(event.data.card, event.data.stale);
  });
  vscode.postMessage({ type: 'ready' });
})();
