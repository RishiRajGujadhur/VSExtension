// Code X-Ray Settings page: draws the sections and rows the extension sends, and sends back each change.
(function () {
  const vscode = acquireVsCodeApi();
  const { make, icon } = window.xrDom;
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let model = [];
  let current = saved.section || 'features';
  let query = '';
  /** Only the settings changed from their defaults, across every section. */
  let changedOnly = !!saved.changedOnly;

  const words = () => query.toLowerCase().split(/\s+/).filter(Boolean);
  const rowText = (row) =>
    `${row.label} ${row.description} ${row.key} ${row.badge || ''} ${(row.severities || []).flatMap((g) => g.items.map((i) => `${i.title} ${i.id}`)).join(' ')}`.toLowerCase();

  /** Text with its search words marked. */
  function marked(text) {
    const found = words();
    if (!found.length) return document.createTextNode(text);
    const span = document.createElement('span');
    const lower = text.toLowerCase();
    let at = 0;
    const hits = [];
    for (const w of found) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
    hits.sort((a, b) => a[0] - b[0]);
    for (const [from, to] of hits) {
      if (from < at) continue;
      span.append(text.slice(at, from), make('mark', '', text.slice(from, to)));
      at = to;
    }
    span.append(text.slice(at));
    return span;
  }

  /** Markdown-lite into elements: **bold**, `code` and [text](link) (shown as text); everything else stays text. */
  function richText(text) {
    const out = document.createDocumentFragment();
    const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;
    let at = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      out.append(marked(text.slice(at, m.index)));
      if (m[1] !== undefined) { const b = make('strong'); b.append(marked(m[1])); out.append(b); }
      else if (m[2] !== undefined) { const c = make('code'); c.append(marked(m[2])); out.append(c); }
      else out.append(marked(m[3]));
      at = pattern.lastIndex;
    }
    out.append(marked(text.slice(at)));
    return out;
  }

  const send = (message) => vscode.postMessage(message);
  const set = (key, value) => send({ type: 'set', key, value });

  function control(row) {
    const box = make('div', 'row-control');
    if (row.kind === 'boolean') {
      const sw = make('button', 'switch');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(row.value === true));
      sw.setAttribute('aria-label', row.label);
      sw.dataset.key = row.key;
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        set(row.key, on);
      });
      box.append(sw);
    } else if (row.kind === 'enum') {
      const select = make('select');
      select.setAttribute('aria-label', row.label);
      select.dataset.key = row.key;
      for (const o of row.options) {
        const option = make('option', '', o.label);
        option.value = o.value;
        if (o.description) option.title = o.description.replace(/\*\*|`/g, '');
        option.selected = String(row.value) === o.value;
        select.append(option);
      }
      select.addEventListener('change', () => set(row.key, select.value));
      box.append(select);
    } else if (row.kind === 'number' || row.kind === 'string') {
      const input = make('input', `field${row.kind === 'string' ? ' text' : ''}`);
      input.type = row.kind === 'number' ? 'number' : 'text';
      if (row.min !== undefined) input.min = String(row.min);
      if (row.max !== undefined) input.max = String(row.max);
      input.value = row.value === undefined || row.value === null ? '' : String(row.value);
      input.setAttribute('aria-label', row.label);
      input.dataset.key = row.key;
      const range = row.kind === 'number' && (row.min !== undefined || row.max !== undefined)
        ? `${row.min !== undefined ? row.min : '…'} to ${row.max !== undefined ? row.max : '…'}`
        : '';
      if (range) input.title = `From ${range}`;
      const commit = () => {
        if (row.kind === 'number') {
          const n = Number(input.value);
          const out = input.value.trim() === '' || Number.isNaN(n) || (row.min !== undefined && n < row.min) || (row.max !== undefined && n > row.max);
          // A value outside the range is not saved: the field says why and keeps the value to correct.
          input.classList.toggle('invalid', out);
          input.setAttribute('aria-invalid', String(out));
          input.title = out ? `Not saved: enter a number${range ? ` from ${range}` : ''}` : range ? `From ${range}` : '';
          if (!out) set(row.key, n);
        } else set(row.key, input.value);
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      box.append(input);
    } else if (row.kind === 'severities') {
      // Shown under the row (see severityList); the count of changes sits here.
      const changed = row.severities.reduce((n, g) => n + g.items.filter((i) => i.value).length, 0);
      box.append(make('span', 'tag', changed ? `${changed} changed` : 'all default'));
    } else {
      // Lists and objects are edited where VS Code shows them best.
      const edit = make('button', 'btn');
      edit.type = 'button';
      edit.append(icon('json'), Array.isArray(row.value) && row.value.length ? `${row.value.length} item${row.value.length === 1 ? '' : 's'} · Edit` : 'Edit in VS Code settings');
      edit.addEventListener('click', () => send({ type: 'json', key: row.key }));
      box.append(edit);
    }
    if (row.modified) {
      const reset = make('button', 'icon-btn');
      reset.type = 'button';
      reset.title = 'Reset to the default';
      reset.setAttribute('aria-label', `Reset ${row.label} to the default`);
      reset.append(icon('discard'));
      reset.addEventListener('click', () => send({ type: 'reset', key: row.key }));
      box.prepend(reset);
    }
    return box;
  }

  const severityChoices = ['default', 'error', 'warning', 'info', 'hint', 'off'];

  /** Inspections: Severity as a list: each inspection with its default and a choice, by language. */
  function severityList(row) {
    const box = make('div', 'severities');
    const found = query ? words() : [];
    for (const group of row.severities) {
      const items = group.items.filter((i) => !found.length || found.every((w) => `${i.title} ${i.id} ${row.label}`.toLowerCase().includes(w)));
      if (!items.length) continue;
      const details = make('details', 'severity-group');
      // Open when searching, or when something in it was changed.
      details.open = !!found.length || items.some((i) => i.value);
      const summary = make('summary', '', group.group);
      summary.append(make('span', 'count', String(items.length)));
      details.append(summary);
      for (const item of items) {
        const line = make('div', 'severity-row');
        const name = make('div', 'severity-name');
        name.append(marked(item.title), make('span', 'row-key', item.id));
        const select = make('select');
        select.setAttribute('aria-label', `${item.title}: how it is reported`);
        select.dataset.key = `${row.key}#${item.id}`;
        for (const choice of severityChoices) {
          const option = make('option', '', choice === 'default' ? `Default (${item.byDefault})` : choice[0].toUpperCase() + choice.slice(1));
          option.value = choice;
          option.selected = (item.value || 'default') === choice;
          select.append(option);
        }
        select.classList.toggle('changed', !!item.value);
        select.addEventListener('change', () => send({ type: 'severity', id: item.id, value: select.value }));
        line.append(name, select);
        details.append(line);
      }
      box.append(details);
    }
    return box;
  }

  function rowElement(row) {
    const el = make('div', 'row');
    el.dataset.key = row.key;
    const text = make('div', 'row-text');
    const title = make('div', 'row-title');
    if (row.modified) {
      const dot = make('span', 'modified-dot');
      dot.title = 'Changed from the default';
      title.append(dot);
    }
    title.append(marked(row.label));
    if (row.badge) title.append(make('span', 'badge', row.badge));
    if (row.scope === 'workspace') {
      const tag = make('span', 'tag', 'This workspace');
      tag.title = 'Set in this workspace’s settings, not your user settings';
      title.append(tag);
    }
    const desc = make('div', 'row-desc');
    desc.append(richText(row.description));
    text.append(title, desc);
    // What the chosen option of a list means.
    if (row.kind === 'enum') {
      const chosen = row.options.find((o) => o.value === String(row.value));
      if (chosen && chosen.description) {
        const hint = make('div', 'row-hint');
        hint.append(richText(`${chosen.label}: ${chosen.description}`));
        text.append(hint);
      }
    }
    if (query) text.append(make('div', 'row-key', row.key));
    const controls = control(row);
    // Copy the setting's ID, for settings.json or a message to a colleague.
    const copy = make('button', 'icon-btn copy-id');
    copy.type = 'button';
    copy.title = `Copy ${row.key}`;
    copy.setAttribute('aria-label', `Copy the setting ID ${row.key}`);
    copy.append(icon('copy'));
    copy.addEventListener('click', () => {
      send({ type: 'copy', key: row.key });
      copy.replaceChildren(icon('check'));
      setTimeout(() => copy.replaceChildren(icon('copy')), 1200);
    });
    controls.prepend(copy);
    el.append(text, controls);
    if (row.kind === 'severities') {
      el.classList.add('stacked');
      el.append(severityList(row));
    }
    return el;
  }

  function sideBar() {
    const side = make('aside', 'side');
    side.append(make('h1', '', 'Settings'), make('p', 'sub', 'Code X-Ray'));
    const search = make('div', 'search');
    const input = make('input');
    input.type = 'search';
    input.id = 'search';
    input.placeholder = 'Search settings';
    input.setAttribute('aria-label', 'Search settings');
    input.value = query;
    input.addEventListener('input', () => {
      query = input.value.trim();
      renderMain(true);
    });
    search.append(icon('search'), input);
    const nav = make('nav');
    nav.setAttribute('aria-label', 'Sections');
    for (const section of model) {
      const item = make('button', 'nav-item');
      item.type = 'button';
      item.dataset.section = section.id;
      item.append(icon(section.icon), make('span', '', section.title));
      const changed = section.rows.filter((r) => r.modified).length;
      if (changed) {
        const count = make('span', 'count', String(changed));
        count.title = `${changed} changed from the default`;
        item.append(count);
      }
      item.addEventListener('click', () => show(section.id, true));
      // Up and down move between sections, Home and End to the first and last.
      item.addEventListener('keydown', (e) => {
        const items = [...nav.querySelectorAll('.nav-item')];
        const at = items.indexOf(item);
        const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -2;
        if (to === -2 || !items[to]) return;
        e.preventDefault();
        items[to].focus();
        show(items[to].dataset.section, true);
      });
      nav.append(item);
    }
    const total = model.reduce((n, sec) => n + sec.rows.filter((r) => r.modified).length, 0);
    const filter = make('button', `nav-item filter${changedOnly ? ' on' : ''}`);
    filter.type = 'button';
    filter.id = 'changedOnly';
    filter.setAttribute('aria-pressed', String(changedOnly));
    filter.title = 'Show only the settings changed from their defaults, in every section';
    filter.append(icon('filter'), make('span', '', 'Changed only'));
    if (total) filter.append(make('span', 'count', String(total)));
    filter.addEventListener('click', () => {
      changedOnly = !changedOnly;
      vscode.setState({ ...saved, section: current, changedOnly });
      render();
    });
    const foot = make('div', 'side-foot');
    const open = make('button', 'link');
    open.type = 'button';
    open.append(icon('link-external'), 'Open in VS Code settings');
    open.addEventListener('click', () => send({ type: 'vscodeSettings' }));
    foot.append(open);
    side.append(search, filter, nav, foot);
    return side;
  }

  function sectionTools(section) {
    const tools = make('div', 'tools');
    const changed = section.rows.filter((r) => r.modified).length;
    if (changed) {
      const reset = make('button', 'btn', `Reset section (${changed})`);
      reset.type = 'button';
      reset.title = `Put the ${changed} changed setting${changed === 1 ? '' : 's'} of ${section.title} back to the default`;
      reset.addEventListener('click', () => send({ type: 'resetSection', section: section.id }));
      tools.append(reset);
    }
    if (section.id !== 'features') return changed ? tools : undefined;
    const all = make('button', 'btn', 'Turn all on');
    all.type = 'button';
    all.addEventListener('click', () => send({ type: 'features', on: true }));
    const core = make('button', 'btn', 'Core only');
    core.type = 'button';
    core.title = 'Only the features marked Core, as when Code X-Ray is first installed';
    core.addEventListener('click', () => send({ type: 'features', on: false }));
    tools.append(all, core);
    return tools;
  }

  let main;
  function renderMain(fade) {
    const page = make('div', 'page');
    if (query || changedOnly) {
      const found = words();
      const hits = model
        .map((s) => ({ s, rows: s.rows.filter((r) => (!changedOnly || r.modified) && found.every((w) => rowText(r).includes(w))) }))
        .filter((x) => x.rows.length);
      const head = make('div', 'page-head');
      const titles = make('div');
      const count = hits.reduce((n, x) => n + x.rows.length, 0);
      const what = changedOnly ? 'changed from the default' : '';
      const heading = changedOnly && !query ? 'Changed settings' : 'Search';
      const sentence = count
        ? `${count} setting${count === 1 ? '' : 's'} ${query ? `match “${query}”` : ''}${query && what ? ' and are ' : ''}${what}`
        : changedOnly && !query ? 'Every setting has its default value.' : `No setting matches “${query}”${what ? ' among the changed ones' : ''}`;
      titles.append(make('h2', '', heading), make('p', '', sentence.trim()));
      head.append(titles);
      page.append(head);
      for (const { s, rows } of hits) {
        page.append(make('div', 'group-title', s.title));
        const list = make('div', 'rows');
        rows.forEach((r) => list.append(rowElement(r)));
        page.append(list);
      }
      if (!count && query) page.append(make('div', 'empty', 'Try another word, or a setting’s ID such as tsStructure.warmUp.'));
    } else {
      const section = model.find((s) => s.id === current) || model[0];
      if (!section) return;
      current = section.id;
      const head = make('div', 'page-head');
      const titles = make('div');
      titles.append(make('h2', '', section.title));
      if (section.description) titles.append(make('p', '', section.description));
      head.append(titles);
      const tools = sectionTools(section);
      if (tools) head.append(tools);
      const list = make('div', 'rows');
      section.rows.forEach((r) => list.append(rowElement(r)));
      page.append(head, list);
    }
    main.replaceChildren(page);
    if (fade) {
      page.classList.add('xr-fade');
      main.scrollTop = 0;
    }
    document.querySelectorAll('.nav-item[data-section]').forEach((n) => n.setAttribute('aria-current', String(!query && !changedOnly && n.dataset.section === current)));
  }

  function show(id, fade) {
    current = id;
    query = '';
    if (changedOnly) {
      changedOnly = false;
      const filter = document.getElementById('changedOnly');
      if (filter) {
        filter.classList.remove('on');
        filter.setAttribute('aria-pressed', 'false');
      }
    }
    const search = document.getElementById('search');
    if (search) search.value = '';
    vscode.setState({ ...saved, section: current, changedOnly });
    renderMain(fade);
    window.scrollTo(0, 0);
  }

  /** Draws the page again for new values, keeping the focus and where the search box's cursor was. */
  function render() {
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.key || (active.id === 'search' ? '#search' : active.dataset.section ? `nav:${active.dataset.section}` : undefined) : undefined;
    const caret = active && active.id === 'search' ? active.selectionStart : undefined;
    main = make('main');
    app.replaceChildren(sideBar(), main);
    renderMain(false);
    if (focusKey === '#search') {
      const search = document.getElementById('search');
      search.focus();
      if (caret !== undefined) search.setSelectionRange(caret, caret);
    } else if (focusKey && focusKey.startsWith('nav:')) {
      const item = document.querySelector(`.nav-item[data-section="${focusKey.slice(4)}"]`);
      if (item) item.focus();
    } else if (focusKey) {
      const again = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]:not(.row)`);
      if (again) again.focus();
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'model') {
      const first = !model.length;
      model = message.sections;
      if (message.section && model.some((s) => s.id === message.section)) current = message.section;
      render();
      if (first) app.classList.add('xr-fade');
    } else if (message.type === 'show' && model.some((s) => s.id === message.section)) {
      show(message.section, true);
    }
  });
  // Ctrl+F (Cmd+F) and / go to the search box.
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
      e.preventDefault();
      const search = document.getElementById('search');
      if (search) { search.focus(); search.select(); }
    }
  });
  send({ type: 'ready' });
})();
