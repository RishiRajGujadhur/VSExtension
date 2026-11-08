// The Actions view: tabs for Analyze and Edit, a search box, Most Used first, then the actions by category.
(function () {
  const vscode = acquireVsCodeApi();
  const tabsBar = document.getElementById('tabs');
  const list = document.getElementById('list');
  const search = document.getElementById('search');
  const footer = document.getElementById('footer');
  const saved = vscode.getState() || {};
  let data;
  let tab = saved.tab || 'analyze';

  const icon = (name) => {
    const i = document.createElement('i');
    i.className = `codicon codicon-${name}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
  };

  function item(action, showTab) {
    const button = document.createElement('button');
    button.className = 'item';
    button.title = [action.detail, action.key ? `Shortcut: ${action.key}` : ''].filter(Boolean).join('\n');
    const tile = document.createElement('span');
    tile.className = 'tile';
    tile.appendChild(icon(action.icon));
    const text = document.createElement('span');
    text.className = 'text';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = action.label;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = action.detail;
    text.append(label, detail);
    button.append(tile, text);
    if (showTab) {
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = data.tabs.find((t) => t.id === action.tab).label;
      button.appendChild(where);
    } else if (action.key) {
      const key = document.createElement('kbd');
      key.textContent = action.key.replace(/^Ctrl\+Alt\+S /, '');
      key.title = action.key;
      button.appendChild(key);
    }
    button.setAttribute('aria-label', `${action.label}. ${action.detail}${action.key ? `. Shortcut ${action.key}` : ''}`);
    button.addEventListener('click', () => vscode.postMessage({ type: 'run', command: action.command }));
    return button;
  }

  function section(title, actions, showTab) {
    if (!actions.length) return;
    const heading = document.createElement('h2');
    heading.textContent = title;
    list.appendChild(heading);
    const group = document.createElement('div');
    group.className = 'group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', title);
    actions.forEach((a) => group.appendChild(item(a, showTab)));
    list.appendChild(group);
  }

  function renderTabs() {
    tabsBar.textContent = '';
    for (const t of data.tabs) {
      const button = document.createElement('button');
      button.className = 'tab';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(t.id === tab));
      button.tabIndex = t.id === tab ? 0 : -1;
      button.append(icon(t.icon), document.createTextNode(t.label));
      button.addEventListener('click', () => choose(t.id));
      tabsBar.appendChild(button);
    }
  }

  function choose(id, focus) {
    tab = id;
    vscode.setState({ ...saved, tab });
    renderTabs();
    render();
    if (focus) tabsBar.querySelector('[aria-selected="true"]').focus();
  }

  // Every word must appear in the label, description, category or keywords.
  const matches = (action, words) => {
    const text = `${action.label} ${action.detail} ${action.category} ${action.keywords || ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };

  function render() {
    list.textContent = '';
    if (!data) return;
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      // Search covers both tabs.
      const found = data.actions.filter((a) => matches(a, words));
      section(`${found.length} found`, found, true);
      if (!found.length) {
        const none = document.createElement('p');
        none.className = 'none';
        none.textContent = 'No action matches. Try other words, such as "null", "references" or "rename".';
        list.appendChild(none);
      }
      return;
    }
    const inTab = data.actions.filter((a) => a.tab === tab);
    const top = (data.mostUsed[tab] || []).map((c) => inTab.find((a) => a.command === c)).filter(Boolean);
    section(data.usedOnce ? 'Most Used' : 'Start Here', top, false);
    const categories = [...new Set(inTab.map((a) => a.category))];
    for (const category of categories) section(category, inTab.filter((a) => a.category === category && !top.includes(a)), false);
  }

  function renderFooter() {
    footer.textContent = '';
    for (const link of data.footer) {
      const button = document.createElement('button');
      button.className = 'link';
      button.append(icon(link.icon), document.createTextNode(link.label));
      button.addEventListener('click', () => vscode.postMessage({ type: 'run', command: link.command }));
      footer.appendChild(button);
    }
  }

  // Keyboard: arrows move between tabs, and between actions; Escape clears the search.
  tabsBar.addEventListener('keydown', (e) => {
    const ids = data.tabs.map((t) => t.id);
    const i = ids.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      choose(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length], true);
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll('.item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      render();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      const first = list.querySelector('.item');
      if (first) {
        e.preventDefault();
        if (e.key === 'Enter' && search.value.trim()) first.click();
        else first.focus();
      }
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data.type !== 'actions') return;
    data = event.data;
    if (!data.tabs.some((t) => t.id === tab)) tab = data.tabs[0].id;
    renderTabs();
    render();
    renderFooter();
  });
  vscode.postMessage({ type: 'ready' });
})();
