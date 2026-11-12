// Draws an analysis as a flow chart: the subject in the middle, what flows in on the left and what
// flows out (or every other row) on the right. Rows become nodes; nodes with children fold and unfold.
(function () {
  const vscode = acquireVsCodeApi();
  const svgNs = 'http://www.w3.org/2000/svg';
  const MIN_W = 150;
  const MAX_W = 360;
  const H = 48;
  // The subject is drawn as a circle, between these sizes; values come in on its left and go out on its right.
  const CENTER_MIN = 104;
  const CENTER_MAX = 176;
  const GAP_X = 80;
  const GAP_Y = 14;
  const svg = document.getElementById('canvas');
  const scene = document.getElementById('scene');
  const empty = document.getElementById('empty');
  const caption = document.getElementById('caption');
  const searchBox = document.getElementById('search');
  const searchCount = document.getElementById('searchCount');
  const info = document.getElementById('info');
  const zoomLevel = document.getElementById('zoomLevel');
  const legend = document.getElementById('legend');
  const legendButton = document.getElementById('legendButton');
  let diagram;
  let view = { x: 0, y: 0, k: 1 };
  // The animated grid behind the chart (diagramGrid.js), the box under the pointer, and the box whose flow is shown.
  let grid;
  let hovered;
  let flowing;
  let layoutVersion = 0;
  let query = '';
  let matchIndex = -1;
  let shownNodes = [];
  let focused;
  let selected;

  // Boxes are as wide as their text, between MIN_W and MAX_W; longer text is cut with an ellipsis.
  const measure = document.createElement('canvas').getContext('2d');
  // The font is read once rather than per box (reading styles while building the chart forces layout), widths are
  // remembered, and long text is cut by halving instead of one character at a time.
  let fontFamily = getComputedStyle(document.body).fontFamily;
  const widths = new Map();
  new MutationObserver(() => { fontFamily = getComputedStyle(document.body).fontFamily; widths.clear(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const fontOf = (weight, size) => `${weight} ${size}px ${fontFamily}`;
  const textWidth = (text, font) => {
    const key = `${font}\u0000${text || ''}`;
    let width = widths.get(key);
    if (width === undefined) {
      if (widths.size > 20000) widths.clear();
      measure.font = font;
      width = measure.measureText(text || '').width;
      widths.set(key, width);
    }
    return width;
  };
  const fitText = (text, font, max) => {
    if (!text || textWidth(text, font) <= max) return text || '';
    let low = 1;
    let high = text.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (textWidth(text.slice(0, mid) + '…', font) <= max) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low) + '…';
  };
  const textOf = (node) => Math.max(textWidth(node.label, fontOf(600, 12)), textWidth(node.description, fontOf(400, 11)));
  const widthOf = (node) => (diagram && node === diagram.center
    ? Math.min(CENTER_MAX, Math.max(CENTER_MIN, Math.ceil(textOf(node) + 36)))
    : Math.min(MAX_W, Math.max(MIN_W, Math.ceil(textOf(node) + 30 + (node.icon ? 20 : 0)))));
  const { el } = window.chartKit;
  // Branch focus: after a double-click only the box, the boxes between it and the subject, and what is behind it are drawn.
  let isolated;
  let chain = new Set();
  const toneGlyphs = { ok: '✓', warning: '!', error: '✕', info: 'i' };
  const toneIcons = { ok: 'pass', warning: 'warning', error: 'error', info: 'info' };
  const toneWords = { ok: 'Safe', warning: 'Warning', error: 'Problem', info: 'Note' };
  /** What a screen reader says for a box: tone, text, side, kind and folding. */
  function spokenLabel(node) {
    const text = [node.label, node.description].filter(Boolean).join(', ');
    const parts = [`${node.tone ? `${toneWords[node.tone]}: ` : ''}${text}`];
    if (diagram && node === diagram.center) parts.push('the subject');
    else if (node.side < 0 && diagram.leftCaption) parts.push(diagram.leftCaption);
    else if (node.side > 0 && diagram.rightCaption) parts.push(diagram.rightCaption);
    if (node.kind === 'pattern') parts.push('design pattern');
    if (node.duplicates) parts.push(`${node.duplicates} the same`);
    if (node.children.length && node.collapsed && node !== diagram.center) parts.push(`${node.children.length} folded`);
    if (node.location) parts.push(`${node.location.file.split(/[\\/]/).pop()}, line ${node.location.line + 1}`);
    return parts.join('. ');
  }
  const visible = (node) => {
    if (node.collapsed) return [];
    return isolated && chain.has(node) && node !== isolated ? node.children.filter((c) => chain.has(c)) : node.children;
  };
  const roots = (nodes) => (isolated ? nodes.filter((n) => chain.has(n)) : nodes);
  const forEach = (nodes, visit) => nodes.forEach((n) => { visit(n); forEach(n.children, visit); });
  // Each box gets its parent and a key made of the labels on its way to the subject, which survives a re-run.
  const linkParents = (nodes, parent, side) => nodes.forEach((n) => { n.parent = parent; n.key = `${parent ? parent.key : side}/${n.label}`; linkParents(n.children, n, side); });

  // Zoom, position and folding are remembered per analysis title (the 20 most recent), also after the tab is reloaded.
  const state = vscode.getState() || {};
  const saved = state.memory || {};
  // Viewer preferences: the animated grid and the flow animation on click, both on unless turned off.
  const prefs = { effects: true, flow: true, ...(state.prefs || {}) };
  const saveState = () => vscode.setState({ memory: saved, prefs });
  let rememberTimer;
  function remember() {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => {
      if (!diagram) return;
      const collapsed = {};
      forEach([...diagram.left, ...diagram.right], (n) => { if (n.children.length) collapsed[n.key] = n.collapsed; });
      saved[diagram.title] = { view, collapsed, at: Date.now() };
      Object.keys(saved).sort((a, b) => saved[b].at - saved[a].at).slice(20).forEach((title) => delete saved[title]);
      saveState();
    }, 300);
  }
  const isMatch = (n) => !!query && `${n.label} ${n.description || ''}`.toLowerCase().includes(query);
  const allNodes = () => (diagram ? [diagram.center, ...(() => { const out = []; forEach([...diagram.left, ...diagram.right], (n) => out.push(n)); return out; })()] : []);

  // Tidy tree: each leaf takes the next row, each parent sits between its first and last child.
  function place(nodes, depth, side, rows) {
    for (const node of nodes) {
      const kids = visible(node);
      if (kids.length) {
        place(kids, depth + 1, side, rows);
        node.row = (kids[0].row + kids[kids.length - 1].row) / 2;
      } else {
        node.row = rows.next++;
      }
      node.depth = depth;
      node.side = side;
    }
    return rows.next;
  }

  function shift(nodes, by) {
    for (const node of nodes) {
      node.row += by;
      shift(visible(node), by);
    }
  }

  // Layout covers every unfolded box; painting puts only the boxes in and around the window into the document, so
  // a chart of thousands of boxes stays as quick as a small one. Below DETAIL_ZOOM boxes are drawn without text.
  const DETAIL_ZOOM = 0.45;
  let painted;
  let captions = {};

  function render() {
    scene.textContent = '';
    painted = undefined;
    if (!diagram) return;
    const leftRows = place(roots(diagram.left), 1, -1, { next: 0 });
    const rightRows = place(roots(diagram.right), 1, 1, { next: 0 });
    const rows = Math.max(leftRows, rightRows, 1);
    shift(roots(diagram.left), (rows - leftRows) / 2);
    shift(roots(diagram.right), (rows - rightRows) / 2);
    const center = diagram.center;
    center.row = (rows - 1) / 2;
    center.depth = 0;
    center.side = 0;
    // Each column is as wide as its widest box; left boxes line up on the edge facing the subject.
    const shown = [center];
    const collect = (nodes) => nodes.forEach((n) => { shown.push(n); collect(visible(n)); });
    collect(roots(diagram.left));
    collect(roots(diagram.right));
    shownNodes = shown;
    const columns = { '-1': [], '1': [] };
    for (const n of shown) {
      n.w = widthOf(n);
      if (n.side) columns[n.side][n.depth] = Math.max(columns[n.side][n.depth] || 0, n.w);
    }
    const edge = (side, depth) => {
      let at = center.w / 2 + GAP_X;
      for (let d = 1; d < depth; d++) at += (columns[side][d] || 0) + GAP_X;
      return at;
    };
    for (const n of shown) {
      n.px = n.side === 0 ? -n.w / 2 : n.side > 0 ? edge(1, n.depth) : -edge(-1, n.depth) - n.w;
      n.py = n.row * (H + GAP_Y);
    }
    captions = {
      left: diagram.leftCaption && roots(diagram.left).length ? -edge(-1, 1) : undefined,
      right: diagram.rightCaption && roots(diagram.right).length ? edge(1, 1) : undefined,
    };
    highlighted = [];
    layoutVersion++;
    drawMinimap();
    paint(true);
    apply();
  }

  /** The window in chart coordinates. */
  function viewport() {
    return { x0: -view.x / view.k, y0: -view.y / view.k, x1: ((svg.clientWidth || 800) - view.x) / view.k, y1: ((svg.clientHeight || 600) - view.y) / view.k };
  }

  /**
   * Puts the boxes and lines in and around the window into the document: the window plus one window's size on
   * every side, so panning redraws only now and then. `everything` draws the whole chart in detail, for export.
   */
  function paint(force, everything) {
    if (!diagram || !shownNodes.length) return;
    const v = viewport();
    const detail = everything || view.k >= DETAIL_ZOOM;
    if (!force && painted && painted.detail === detail && v.x0 >= painted.x0 && v.y0 >= painted.y0 && v.x1 <= painted.x1 && v.y1 <= painted.y1) return;
    const spanX = v.x1 - v.x0;
    const spanY = v.y1 - v.y0;
    const region = everything ? { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity } : { x0: v.x0 - spanX, y0: v.y0 - spanY, x1: v.x1 + spanX, y1: v.y1 + spanY };
    painted = { ...region, detail };
    const hadFocus = svg.contains(document.activeElement);
    scene.textContent = '';
    const center = diagram.center;
    const overlaps = (x0, y0, x1, y1) => x1 >= region.x0 && x0 <= region.x1 && y1 >= region.y0 && y0 <= region.y1;
    for (const n of shownNodes) {
      n.el = undefined;
      n.edgeEl = undefined;
    }

    const edges = el('g', { class: 'edges' }, scene);
    for (const node of shownNodes) {
      if (node === center) continue;
      // Arrows point the way the value moves: into the subject on the left, away from it on the right.
      const from = node.parent || center;
      const [a, b] = node.side < 0 ? [node, from] : [from, node];
      const x1 = a.px + a.w;
      const y1 = a.py + H / 2;
      const x2 = b.px;
      const y2 = b.py + H / 2;
      if (!overlaps(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2))) continue;
      const mid = (x1 + x2) / 2;
      node.edgeEl = el('path', { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 2},${y2}`, class: 'edge', 'marker-end': 'url(#arrow)' }, edges);
      if (node.kind === 'pattern') {
        // A pattern describes the code around the value; it is not where the value goes, so no arrow.
        node.edgeEl.classList.add('relation');
        node.edgeEl.removeAttribute('marker-end');
      }
    }

    edges.setAttribute('aria-hidden', 'true');
    const layer = el('g', { class: 'nodes', role: 'none' }, scene);
    for (const node of shownNodes) {
      if (!overlaps(node.px, node.py, node.px + node.w, node.py + H)) continue;
      const found = (query ? (isMatch(node) ? ' match' : ' dim') : '') + (node === selected ? ' selected' : '');
      // A box with no code of its own only gathers the boxes behind it: drawn as a dashed outline.
      const group = !node.location && node.children.length && !node.kind && node !== center ? ' group' : '';
      const g = el('g', { class: `node${node === center ? ' center' : ''}${node.kind ? ' ' + node.kind : ''}${group}${node.tone ? ' ' + node.tone : ''}${node.location ? ' located' : ''}${found}`, transform: `translate(${node.px},${node.py})`, tabindex: node === center ? 0 : -1 }, layer);
      node.el = g;
      g.diagramNode = node;
      g.setAttribute('role', 'treeitem');
      g.setAttribute('aria-level', String(node.depth + 1));
      g.setAttribute('aria-label', spokenLabel(node));
      if (node.children.length && node !== center) g.setAttribute('aria-expanded', String(!node.collapsed));
      if (node === selected) g.setAttribute('aria-selected', 'true');
      if (node === center) {
        // The subject: a circle, with a port where values come in and one where they go out.
        const r = node.w / 2;
        el('circle', { cx: r, cy: H / 2, r, class: 'box' }, g);
        if (captions.left !== undefined) el('circle', { cx: 0, cy: H / 2, r: 5, class: 'port in' }, g);
        if (captions.right !== undefined) el('circle', { cx: node.w, cy: H / 2, r: 5, class: 'port out' }, g);
      } else if (node.kind === 'pattern') {
        // Hexagon: a design pattern, not a step of the value.
        const w = node.w;
        el('path', { d: `M12,0 H${w - 12} L${w},${H / 2} L${w - 12},${H} H12 L0,${H / 2} Z`, class: 'box' }, g);
      } else {
        if (node.duplicates) el('rect', { x: 4, y: -4, width: node.w, height: H, rx: 12, class: 'box stack' }, g);
        el('rect', { width: node.w, height: H, rx: 12, class: 'box' }, g);
        if (node.duplicates) {
          const badge = el('g', { class: 'dup-badge', transform: `translate(${node.w - 14},${-4})`, 'aria-hidden': 'true' }, g);
          el('rect', { x: -14, y: -8, width: 28, height: 16, rx: 8 }, badge);
          el('text', { y: 4, 'text-anchor': 'middle' }, badge).textContent = `×${node.duplicates}`;
        }
      }
      if (node.tone) el('rect', { width: 4, height: H - 20, x: 5, y: 10, rx: 2, class: 'tone' }, g);
      if (node.location) {
        // Right-click offers the analyses the results view offers on a row.
        g.setAttribute('aria-haspopup', 'menu');
      }
      if (!detail) continue;
      if (node === center) {
        // Centered in the circle: its icon, the name and what it is.
        const mid = node.w / 2;
        const room = node.w - 24;
        window.chartKit.icon(g, node.icon || 'symbol-variable', mid, H / 2 - (node.description ? 24 : 16), 'box-icon');
        el('text', { x: mid, y: node.description ? H / 2 + 2 : H / 2 + 6, 'text-anchor': 'middle', class: 'label', 'aria-hidden': 'true' }, g).textContent = fitText(node.label, fontOf(600, 12), room);
        if (node.description) el('text', { x: mid, y: H / 2 + 18, 'text-anchor': 'middle', class: 'description', 'aria-hidden': 'true' }, g).textContent = fitText(node.description, fontOf(400, 11), room - 8);
        continue;
      }
      const iconName = node.icon || (node.kind === 'pattern' ? 'library' : undefined);
      const textX = iconName ? 32 : 14;
      const room = node.w - (node.tone ? 40 : 26) - (iconName ? 18 : 0);
      if (iconName) window.chartKit.icon(g, iconName, node.kind === 'pattern' ? 22 : 19, H / 2, 'box-icon');
      el('text', { x: textX, y: node.description ? 20 : H / 2 + 4, class: 'label', 'aria-hidden': 'true' }, g).textContent = fitText(node.label, fontOf(600, 12), room);
      if (node.description) el('text', { x: textX, y: 37, class: 'description', 'aria-hidden': 'true' }, g).textContent = fitText(node.description, fontOf(400, 11), room);
      if (node.tone && !window.chartKit.icon(g, toneIcons[node.tone], node.w - 16, 14, 'glyph')) el('text', { x: node.w - 16, y: 18, class: 'glyph', 'text-anchor': 'middle', 'aria-hidden': 'true' }, g).textContent = toneGlyphs[node.tone];
      if (node.children.length && node !== center) {
        // The fold button sits on the outer edge, where the children are.
        const toggle = el('g', { class: 'toggle', 'aria-hidden': 'true', transform: `translate(${node.side < 0 ? 0 : node.w},${H / 2})` }, g);
        el('circle', { r: 12, class: 'hit' }, toggle);
        el('circle', { r: 9 }, toggle);
        el('text', { y: 4, 'text-anchor': 'middle' }, toggle).textContent = node.collapsed ? String(node.children.length) : '−';
        el('title', {}, toggle).textContent = node.collapsed ? `Show ${node.children.length} more` : 'Fold';
      }
    }
    if (captions.left !== undefined) {
      el('text', { x: captions.left - 18, y: -14, 'text-anchor': 'end', class: 'side' }, scene).textContent = diagram.leftCaption;
      window.chartKit.icon(scene, 'arrow-circle-right', captions.left - 6, -18, 'side-icon');
    }
    if (captions.right !== undefined) {
      window.chartKit.icon(scene, 'arrow-circle-right', captions.right + 6, -18, 'side-icon');
      el('text', { x: captions.right + 18, y: -14, class: 'side' }, scene).textContent = diagram.rightCaption;
    }
    highlighted = [];
    drawFlows();
    if (pathNode) highlightPath(pathNode);
    if (focused && focused.el && (hadFocus || force) && document.activeElement !== searchBox) focused.el.focus({ preventScroll: true });
  }

  const branchBar = document.getElementById('branch');
  function isolate(node) {
    isolated = node;
    chain = new Set();
    if (node) {
      for (let p = node; p; p = p.parent) chain.add(p);
      for (let p = node.parent; p; p = p.parent) p.collapsed = false;
      node.collapsed = false;
    }
    branchBar.hidden = !node;
    if (node) document.getElementById('branchLabel').textContent = `Showing only ${node.label}`;
    render();
    fit();
    if (node && node.el) node.el.focus({ preventScroll: true });
  }
  document.getElementById('wholeChart').addEventListener('click', () => isolate(undefined));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target !== searchBox && legend.hidden && flowing) stopFlow();
    else if (e.key === 'Escape' && isolated && e.target !== searchBox && legend.hidden) isolate(undefined);
  });

  // Minimap (chartKit.minimap): the whole chart in the corner, shown when it is bigger than the window.
  const map = window.chartKit.minimap(document.getElementById('minimap'), svg, () => view, (v) => { view = v; apply(); });
  function drawMinimap() {
    if (!diagram || !shownNodes.length) return map.draw([]);
    map.draw(shownNodes.map((n) => (n === diagram.center
      ? { x: n.px, y: n.py + H / 2 - n.w / 2, w: n.w, h: n.w, kind: 'center', round: true }
      : { x: n.px, y: n.py, w: n.w, h: H, kind: n.kind || n.tone || 'plain' })));
  }
  const updateMinimapView = () => map.update();

  // The bar under the chart shows the whole text of the hovered or focused box, where it is, and what can be done with it.
  function showInfo(node) {
    info.textContent = '';
    if (!node) {
      info.textContent = 'Hover or focus a box for its full text. Click opens the code, the round button folds, right-click runs another analysis.';
      return;
    }
    const strong = document.createElement('strong');
    strong.textContent = node.label;
    info.appendChild(strong);
    const parts = [node.description, node.location ? `${node.location.file.split(/[\\/]/).pop()}:${node.location.line + 1}` : ''];
    const actions = [node.location ? 'Enter or click: open' : '', node.children.length && node !== diagram.center ? `Space: ${node.collapsed ? `show ${node.children.length} more` : 'fold'}` : '', node.location ? 'right-click: more analyses' : '', node !== diagram.center && node !== isolated ? 'double-click or B: only this branch' : ''];
    const rest = document.createElement('span');
    rest.textContent = [...parts, actions.filter(Boolean).join(', ')].filter(Boolean).map((t) => ` · ${t}`).join('');
    info.appendChild(rest);
    // The line of code the box points at, asked from the extension once and then remembered.
    infoKey = node.location ? `${node.location.file}:${node.location.line}` : undefined;
    if (infoKey && codeLines.has(infoKey)) showCode(codeLines.get(infoKey));
    else if (infoKey) vscode.postMessage({ type: 'peek', location: node.location });
  }

  const codeLines = new Map();
  const codeBlocks = new Map();
  let infoKey;

  // The hover card of a box: what it is, where, its code (read from the file), the facts the report gives, the
  // way to the subject and the keys that act on it.
  const card = window.chartKit.hoverCard();
  const cardKey = (node) => (node.location ? `${node.location.file}:${node.location.line}` : `node:${node.label}`);
  function cardContent(node) {
    const key = cardKey(node);
    const where = node.location ? `${node.location.file.split(/[\\/]/).pop()}:${node.location.line + 1}` : '';
    const way = [];
    for (let p = node.parent; p && p !== diagram.center; p = p.parent) way.unshift(p.label);
    const content = {
      icon: node.icon || (node === diagram.center ? 'target' : 'symbol-misc'),
      title: node.label,
      meta: where,
      code: node.location ? codeBlocks.get(key) : '',
      loading: node.location && !codeBlocks.has(key),
      facts: [
        ['Detail', node.description],
        node === diagram.center ? undefined : ['Way here', [diagram.center.label, ...way].join(' → ')],
        node.children.length ? ['Below it', `${node.children.length} box${node.children.length === 1 ? '' : 'es'}${node.collapsed ? ' (folded)' : ''}`] : undefined,
        node.duplicates > 1 ? ['Same box', `${node.duplicates} times in this report`] : undefined,
        node.tone === 'warning' || node.tone === 'error' ? ['Note', node.tone === 'error' ? 'a problem' : 'worth a look'] : undefined,
      ],
      keys: [
        ...(node.location ? [['Enter', 'open']] : []),
        ...(node.children.length && node !== diagram.center ? [['Space', node.collapsed ? 'unfold' : 'fold']] : []),
        ...(node !== diagram.center ? [['B', 'only this branch']] : []),
        ['Shift+F10', 'menu'],
      ],
    };
    return content;
  }
  let cardNode;
  function showCard(node, delay) {
    cardNode = node;
    card.show(node.el, cardContent(node), delay, cardKey(node));
    if (node.location && !codeBlocks.has(cardKey(node)) && !codeLines.has(cardKey(node))) vscode.postMessage({ type: 'peek', location: node.location });
  }
  function showCode(code) {
    if (!code) return;
    const line = document.createElement('code');
    line.textContent = code;
    info.appendChild(line);
  }

  // The way from a box to the subject stands out while the box is hovered or focused.
  let highlighted = [];
  let pathNode;
  function highlightPath(node) {
    pathNode = node;
    for (const item of highlighted) {
      item.classList.remove('onpath');
      if (item.classList.contains('edge') && !item.classList.contains('relation')) item.setAttribute('marker-end', 'url(#arrow)');
    }
    highlighted = [];
    if (!node || !diagram || node === diagram.center) return;
    for (let n = node; n; n = n.parent) {
      if (n.el) highlighted.push(n.el);
      if (n.edgeEl) highlighted.push(n.edgeEl);
    }
    if (diagram.center.el) highlighted.push(diagram.center.el);
    for (const item of highlighted) {
      item.classList.add('onpath');
      if (item.classList.contains('edge') && !item.classList.contains('relation')) item.setAttribute('marker-end', 'url(#arrowOn)');
    }
  }

  // Arrow keys walk the chart: outward to the first child, inward to the parent, up and down within a column.
  function neighbor(node, key) {
    const center = diagram.center;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const column = shownNodes.filter((n) => n.side === node.side && n.depth === node.depth).sort((a, b) => a.row - b.row);
      return column[column.indexOf(node) + (key === 'ArrowDown' ? 1 : -1)];
    }
    if (node === center) return key === 'ArrowRight' ? roots(diagram.right)[0] : roots(diagram.left)[0];
    const outward = node.side > 0 ? 'ArrowRight' : 'ArrowLeft';
    return key === outward ? visible(node)[0] : node.parent || center;
  }

  function ensureVisible(node) {
    const left = view.x + node.px * view.k;
    const top = view.y + node.py * view.k;
    if (left < 10 || top < 10 || left + node.w * view.k > svg.clientWidth - 10 || top + H * view.k > svg.clientHeight - 10) centerOn(node);
  }

  function onNodeKey(e, node) {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const box = node.el.getBoundingClientRect();
      openMenu(node, box.left + 12, box.bottom + 2);
      return;
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = neighbor(node, e.key);
      if (next) {
        // Scroll first: a box outside the window is drawn once it comes into view.
        ensureVisible(next);
        if (next.el) next.el.focus({ preventScroll: true });
      }
    } else if (e.key === 'Enter' && node.location) {
      vscode.postMessage({ type: 'open', location: node.location });
    } else if ((e.key === 'b' || e.key === 'B') && node !== diagram.center) {
      isolate(node === isolated ? undefined : node);
    } else if (e.key === ' ' && node.children.length && node !== diagram.center) {
      e.preventDefault();
      node.collapsed = !node.collapsed;
      render();
    }
  }

  // Zoom with + and -, 0 fits everything, Home returns to the subject. Not while typing in Find.
  window.addEventListener('keydown', (e) => {
    if (!diagram || e.target === searchBox || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoom(1.2);
    else if (e.key === '-') zoom(1 / 1.2);
    else if (e.key === '0') fit(true);
    else if (e.key === 'Home') { e.preventDefault(); centerOn(diagram.center); diagram.center.el.focus({ preventScroll: true }); }
  });

  // Every line carries moving pulses in the direction the value travels; after a click on a box only its way to the
  // subject and what is behind it do. Clicking the background or pressing Escape goes back to every line.
  function drawFlows() {
    if (!prefs.flow || !diagram) return window.chartKit.drawFlows(scene, null, []);
    const edges = [];
    if (!flowing || !shownNodes.includes(flowing) || flowing === diagram.center) {
      shownNodes.forEach((n) => n.edgeEl && edges.push(n.edgeEl));
    } else {
      for (let n = flowing; n; n = n.parent) if (n.edgeEl) edges.push(n.edgeEl);
      const behind = (n) => visible(n).forEach((c) => { if (c.edgeEl) edges.push(c.edgeEl); behind(c); });
      behind(flowing);
    }
    const lines = edges.filter((edge) => !edge.classList.contains('relation'));
    // The ring round the subject carries the flow too: in at its left, out at its right.
    const c = diagram.center;
    const rings = lines.length ? window.chartKit.ringPaths(c.px + c.w / 2, c.py + H / 2, c.w / 2 + 5, 180, 0) : [];
    window.chartKit.drawFlows(scene, null, [...lines, ...rings]);
  }

  function stopFlow() {
    flowing = undefined;
    drawFlows();
  }

  // Whether the view is as Fit left it, so resizing the tab fits again.
  let fitted = false;
  // Dragging and the wheel fire many events per frame: the view is redrawn once per frame.
  let applyFrame = 0;
  function applySoon() {
    if (!applyFrame) applyFrame = requestAnimationFrame(() => { applyFrame = 0; apply(); });
  }
  function apply() {
    view = window.chartKit.clampView(view, map.bounds, svg.clientWidth || 800, svg.clientHeight || 600);
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    window.chartKit.redrawFlows();
    paint(false);
    if (grid) grid.wake();
    zoomLevel.textContent = `${Math.round(view.k * 100)}%`;
    zoomLevel.setAttribute('aria-label', `Zoom ${Math.round(view.k * 100)}%, reset to 100%`);
    updateMinimapView();
    remember();
  }

  function fit(all) {
    const bounds = map.bounds;
    if (!bounds) return;
    const box = { x: bounds.x, y: bounds.y - 30, width: bounds.w, height: bounds.h + 30 };
    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;
    if (!box.width || !box.height) return;
    const k = Math.min(1.2, (width - 40) / box.width, (height - 40) / box.height);
    let to;
    if (k < 0.6 && diagram && !all) {
      // Too small to read when it all fits: show the subject at a readable size; drag or zoom out for the rest.
      const c = diagram.center;
      to = { k: 0.9, x: width / 2 - (c.px + c.w / 2) * 0.9, y: height / 2 - (c.py + H / 2) * 0.9 };
    } else {
      to = { k, x: width / 2 - (box.x + box.width / 2) * k, y: height / 2 - (box.y + box.height / 2) * k };
    }
    moveTo(to, !all);
    fitted = true;
  }

  /** Moves the view there: smoothly when asked by the person, at once when a chart first opens. */
  function moveTo(to, atOnce) {
    if (atOnce) {
      view = to;
      apply();
    } else {
      window.chartKit.glide(view, to, (v) => { view = v; apply(); });
    }
  }

  /** Pans so the box is in the middle of the window, at the current zoom. */
  function centerOn(node) {
    fitted = false;
    moveTo({ k: view.k, x: svg.clientWidth / 2 - (node.px + node.w / 2) * view.k, y: svg.clientHeight / 2 - (node.py + H / 2) * view.k });
  }

  // Find: matching boxes stand out, the rest fade; folded boxes holding a match unfold. Enter goes to the next match.
  function search(text) {
    query = text.trim().toLowerCase();
    matchIndex = -1;
    for (const n of allNodes().filter(isMatch)) {
      for (let p = n.parent; p; p = p.parent) p.collapsed = false;
    }
    render();
    // Only drawn boxes count: in the one-branch view, matches in other branches are mentioned, not jumped to.
    const count = shownNodes.filter(isMatch).length;
    const elsewhere = allNodes().filter(isMatch).length - count;
    searchCount.textContent = query ? (count ? `${count} found` : 'No boxes match') + (elsewhere ? `, ${elsewhere} in other branches` : '') : '';
  }

  function nextMatch(step) {
    const found = shownNodes.filter(isMatch);
    if (!found.length) return;
    matchIndex = (matchIndex + step + found.length) % found.length;
    const node = found[matchIndex];
    searchCount.textContent = `${matchIndex + 1} of ${found.length}`;
    centerOn(node);
    allNodes().forEach((n) => n.el && n.el.classList.remove('current'));
    if (node.el) node.el.classList.add('current');
  }

  searchBox.addEventListener('input', () => search(searchBox.value));
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { searchBox.value = ''; search(''); svg.focus(); }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchBox.focus(); searchBox.select(); }
  });

  function zoom(factor, cx, cy) {
    fitted = false;
    const k = Math.min(3, Math.max(0.15, view.k * factor));
    const px = cx === undefined ? svg.clientWidth / 2 : cx;
    const py = cy === undefined ? svg.clientHeight / 2 : cy;
    view = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    applySoon();
  }

  // One listener per event for every box, whatever the chart's size: the box is found from the event's target.
  const boxOf = (target) => {
    const g = target instanceof Element ? target.closest('.node') : null;
    return g ? g.diagramNode : undefined;
  };
  let pendingOpen;
  svg.addEventListener('click', (e) => {
    const node = boxOf(e.target);
    if (!node) return;
    if (e.target.closest('.toggle')) {
      node.collapsed = !node.collapsed;
      render();
      return;
    }
    // Clicking a box sends a wave through the grid and, with Flow animation on, animates the lines along its path.
    if (grid) grid.pulse(view.x + (node.px + node.w / 2) * view.k, view.y + (node.py + H / 2) * view.k);
    if (prefs.flow) {
      flowing = node;
      drawFlows();
    }
    // A single click opens the code; a double-click focuses on the branch instead, so the click waits a moment.
    clearTimeout(pendingOpen);
    if (node.location) pendingOpen = setTimeout(() => vscode.postMessage({ type: 'open', location: node.location }), 220);
  });
  svg.addEventListener('dblclick', (e) => {
    const node = boxOf(e.target);
    clearTimeout(pendingOpen);
    // Clicking a fold button twice quickly folds and unfolds; it is not a double-click on the box.
    if (node && node !== diagram.center && !e.target.closest('.toggle')) isolate(node);
  });
  svg.addEventListener('mouseover', (e) => {
    const node = boxOf(e.target);
    if (node === hovered) return;
    hovered = node;
    if (node && node.el) showCard(node, 350);
    else card.hideSoon();
    highlightPath(node || focused);
    showInfo(node || focused);
    if (grid) grid.wake();
  });
  svg.addEventListener('focusin', (e) => {
    const node = boxOf(e.target);
    if (!node) return;
    focused = node;
    if (node.el && card.key !== cardKey(node)) showCard(node, e.target.matches(':focus-visible') ? 0 : 350);
    highlightPath(node);
    showInfo(node);
  });
  svg.addEventListener('keydown', (e) => {
    const node = boxOf(e.target);
    if (node) onNodeKey(e, node);
  });

  // Right-click menu of a box: open its code, run another analysis on it, show only its branch or fold it.
  // Drawn by the page so it can show icons; it works like a menu from the keyboard as well (WAI-ARIA menu pattern).
  const boxMenu = document.getElementById('boxMenu');
  let analyses = [];
  let menuFor;
  function menuItems(node) {
    const items = [];
    if (node.location) {
      items.push({ icon: 'go-to-file', label: 'Open code', run: () => vscode.postMessage({ type: 'open', location: node.location }) });
      const main = analyses.filter((a) => !a.more);
      const more = analyses.filter((a) => a.more);
      if (main.length) items.push('-', ...main.map((a) => ({ icon: a.icon, label: a.label, run: () => vscode.postMessage({ type: 'analyze', command: a.command, location: node.location }) })));
      if (more.length) items.push({ heading: 'More analyses here' }, ...more.map((a) => ({ icon: a.icon, label: a.label, run: () => vscode.postMessage({ type: 'analyze', command: a.command, location: node.location }) })));
    }
    if (node === diagram.center) {
      // The subject: everything at once.
      items.push(
        { icon: 'play-circle', label: 'Animate every flow', run: () => { flowing = diagram.center; drawFlows(); } },
        { icon: 'unfold', label: 'Unfold all', run: () => setAll(false) },
        { icon: 'fold', label: 'Fold all', run: () => setAll(true) },
        ...(isolated ? [{ icon: 'filter', label: 'Show whole chart', run: () => isolate(undefined) }] : []),
        { icon: 'screen-full', label: 'Fit the whole chart', keys: '0', run: () => fit(true) },
      );
    } else {
      items.push('-', { icon: 'filter', label: node === isolated ? 'Show whole chart' : 'Show only this branch', keys: 'B', run: () => isolate(node === isolated ? undefined : node) });
      if (node.children.length) items.push({ icon: node.collapsed ? 'unfold' : 'fold', label: node.collapsed ? (node.duplicates ? `Show the ${node.duplicates} duplicates` : `Unfold (${node.children.length})`) : 'Fold', keys: 'Space', run: () => { node.collapsed = !node.collapsed; render(); } });
      items.push({ icon: 'play-circle', label: 'Animate its flow', run: () => { flowing = node; drawFlows(); } });
    }
    items.push('-', { icon: 'copy', label: 'Copy text', run: () => vscode.postMessage({ type: 'copy', text: [node.label, node.description].filter(Boolean).join(' · ') }) });
    if (node.location) items.push({ icon: 'location', label: 'Copy location', run: () => vscode.postMessage({ type: 'copy', text: `${node.location.file}:${node.location.line + 1}:${node.location.character + 1}` }) });
    if (node !== diagram.center) items.push({ icon: 'arrow-right', label: 'Copy the way here', run: () => vscode.postMessage({ type: 'copy', text: wayHere(node) }) });
    return items;
  }
  function backgroundMenu() {
    return [
      { icon: 'screen-full', label: 'Fit the whole chart', keys: '0', run: () => fit(true) },
      { icon: 'zoom-in', label: 'Actual size', run: () => zoom(1 / view.k) },
      { icon: 'home', label: 'Go to the subject', keys: 'Home', run: () => centerOn(diagram.center) },
      ...(isolated ? [{ icon: 'filter', label: 'Show whole chart', run: () => isolate(undefined) }] : []),
      '-',
      { icon: 'unfold', label: 'Unfold all', run: () => setAll(false) },
      { icon: 'fold', label: 'Fold all', run: () => setAll(true) },
      { icon: 'play-circle', label: 'Animate every flow', run: () => { flowing = diagram.center; drawFlows(); } },
      { icon: 'map', label: map.hidden ? 'Show minimap' : 'Hide minimap', keys: 'M', run: () => toggleMinimap() },
      '-',
      ...(warnings().length ? [{ icon: 'warning', label: `Next warning (${warnings().length})`, run: nextWarning }] : []),
      { icon: 'list-tree', label: 'Copy as an outline', run: () => vscode.postMessage({ type: 'copy', text: outlineText() }) },
      { icon: 'location', label: 'Copy all locations', run: () => vscode.postMessage({ type: 'copy', text: allNodes().filter((n) => n.location).map((n) => `${n.location.file}:${n.location.line + 1}  ${n.label}`).join('\n') }) },
      { icon: 'markdown', label: 'Copy as Mermaid', run: copyMermaid },
      { icon: 'save', label: 'Save as SVG', run: saveSvg },
      { icon: 'file-media', label: 'Save as PNG', run: savePng },
    ];
  }
  // The boxes that need a look, in reading order, and stepping through them.
  const warnings = () => allNodes().filter((n) => n.tone === 'warning' || n.tone === 'error');
  let warningAt = -1;
  function nextWarning() {
    const list = warnings();
    if (!list.length) return;
    warningAt = (warningAt + 1) % list.length;
    const node = list[warningAt];
    centerOn(node);
    if (node.el) node.el.focus({ preventScroll: true });
  }
  // The chart as an indented outline: the subject, then each side with its boxes.
  function outlineText() {
    const lines = [diagram.center.label + (diagram.center.description ? ` (${diagram.center.description})` : '')];
    const walk = (nodes, depth) => nodes.forEach((n) => {
      lines.push(`${'  '.repeat(depth)}- ${n.label}${n.description ? ` · ${n.description}` : ''}${n.location ? ` (${n.location.file.split(/[\\/]/).pop()}:${n.location.line + 1})` : ''}`);
      walk(n.children || [], depth + 1);
    });
    if (diagram.left.length) { lines.push('In:'); walk(diagram.left, 1); }
    if (diagram.right.length) { lines.push('Out:'); walk(diagram.right, 1); }
    return lines.join('\n');
  }
  const wayHere = (node) => {
    const way = [];
    for (let p = node; p && p !== diagram.center; p = p.parent) way.unshift(p.label);
    return [diagram.center.label, ...way].join(' → ');
  };
  const menu = window.chartKit.menu(boxMenu);
  function openMenu(node, x, y) {
    menuFor = node;
    const where = node.location ? `Line ${node.location.line + 1} · ${node.location.file.split(/[\\/]/).pop()}` : '';
    menu.open(menuItems(node), x, y, node.el, [where, node.children.length ? `${node.children.length} below it` : '', node.description].filter(Boolean).join(' · '));
  }
  const closeMenu = (refocus) => menu.close(refocus);
  svg.addEventListener('contextmenu', (e) => {
    const node = boxOf(e.target);
    e.preventDefault();
    if (node) openMenu(node, e.clientX, e.clientY);
    else if (diagram) {
      const files = new Set(allNodes().filter((n) => n.location).map((n) => n.location.file)).size;
      menu.open(backgroundMenu(), e.clientX, e.clientY, svg, `${diagram.center.label} · ${allNodes().length - 1} boxes${files ? ` · ${files} file${files === 1 ? '' : 's'}` : ''}${warnings().length ? ` · ${warnings().length} to look at` : ''}`);
    }
  });
  // Double-clicking the background fits the chart; arrow keys pan it while the background has the focus.
  svg.addEventListener('dblclick', (e) => {
    if (!boxOf(e.target)) fit(true);
  });
  svg.addEventListener('keydown', (e) => {
    if (e.target === svg) window.chartKit.panKey(e, (dx, dy) => { fitted = false; view = { k: view.k, x: view.x + dx, y: view.y + dy }; apply(); });
  });

  // Drag the background to pan; the wheel zooms around the pointer.
  let drag;
  svg.addEventListener('pointerdown', (e) => {
    card.hide();
    if (e.button !== 0 || e.target.closest('.node')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y, startX: e.clientX, startY: e.clientY };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
    svg.focus({ preventScroll: true });
  });
  svg.addEventListener('pointermove', (e) => {
    if (grid) {
      const rect = svg.getBoundingClientRect();
      grid.pointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
    if (!drag) return;
    fitted = false;
    view.x = e.clientX - drag.x;
    view.y = e.clientY - drag.y;
    applySoon();
  });
  svg.addEventListener('pointerup', (e) => {
    // A click on the background, not a drag, stops the flow animation.
    if (drag && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) stopFlow();
    drag = undefined;
    svg.classList.remove('dragging');
  });
  svg.addEventListener('pointerleave', () => {
    card.hideSoon();
    if (grid) grid.pointer(undefined);
    if (hovered) {
      hovered = undefined;
      highlightPath(focused);
      showInfo(focused);
    }
  });
  svg.addEventListener('wheel', (e) => {
    card.hide();
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  const setAll = (collapsed) => {
    if (!diagram) return;
    forEach([...diagram.left, ...diagram.right], (n) => { if (n.children.length) n.collapsed = collapsed; });
    render();
    fit();
  };
  // Save SVG: the chart as a standalone image, with the theme's colors written into it.
  function exportSvg() {
    if (!diagram) return;
    // The whole chart in detail, written out, then back to drawing what is in view.
    paint(true, true);
    const image = window.chartKit.exportSvg(svg, scene, [], (copy) => {
      for (const side of copy.querySelectorAll('.side')) side.textContent = side.textContent.toUpperCase();
    });
    paint(true);
    return image;
  }


  function saveSvg() {
    const image = exportSvg();
    if (image) vscode.postMessage({ type: 'save', svg: image.text, title: diagram.title });
  }

  // Save PNG: the same image drawn at twice the size, for chats and slides that do not show SVG.
  function savePng() {
    const image = exportSvg();
    if (!image) return;
    window.chartKit.toPng(
      image,
      (png) => vscode.postMessage({ type: 'savePng', png, title: diagram.title }),
      () => vscode.postMessage({ type: 'error', text: 'The chart could not be drawn as a PNG. Save SVG still works.' }),
    );
  }

  // Copy Mermaid: the chart as it is folded now, as text for Markdown and GitHub.
  function copyMermaid() {
    if (!diagram) return;
    const plain = (n) => ({ label: n.label, description: n.description, tone: n.tone, kind: n.kind, collapsed: n.collapsed && n !== diagram.center, children: n.children.map(plain) });
    vscode.postMessage({ type: 'mermaid', diagram: { title: diagram.title, center: plain(diagram.center), left: diagram.left.map(plain), right: diagram.right.map(plain) } });
  }

  document.getElementById('mermaid').addEventListener('click', copyMermaid);
  document.getElementById('otherGraphs').addEventListener('click', () => vscode.postMessage({ type: 'otherGraphs' }));
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'g' || e.key === 'G') && e.target !== searchBox && !e.ctrlKey && !e.metaKey && !e.altKey && !menu.isOpen) vscode.postMessage({ type: 'otherGraphs' });
  });
  zoomLevel.addEventListener('click', () => window.chartKit.zoomPresets(menu, zoomLevel, view.k, (k) => zoom(k / view.k), () => fit(true)));
  // The minimap can be hidden (M); the choice is kept with the other viewer preferences.
  map.hidden = prefs.minimap === false;
  function toggleMinimap() {
    map.hidden = !map.hidden;
    prefs.minimap = !map.hidden;
    saveState();
  }
  window.addEventListener('keydown', (e) => {
    if (e.target === searchBox || e.ctrlKey || e.metaKey || e.altKey || menu.isOpen) return;
    if (e.key === 'm' || e.key === 'M') toggleMinimap();
  });
  window.chartKit.refitOnResize(svg, () => fitted, () => fit(true));
  // The legend: what colors, arrows and buttons mean, and the keys. Escape closes it.
  const showLegend = (open) => {
    legend.hidden = !open;
    legendButton.setAttribute('aria-expanded', String(open));
  };
  legendButton.addEventListener('click', () => showLegend(legend.hidden));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !legend.hidden) showLegend(false); });
  document.getElementById('save').addEventListener('click', saveSvg);
  document.getElementById('savePng').addEventListener('click', savePng);
  document.getElementById('fit').addEventListener('click', () => fit(true));
  document.getElementById('zoomIn').addEventListener('click', () => zoom(1.2));
  document.getElementById('zoomOut').addEventListener('click', () => zoom(1 / 1.2));
  document.getElementById('expand').addEventListener('click', () => setAll(false));
  document.getElementById('collapse').addEventListener('click', () => setAll(true));

  const sameLocation = (a, b) => !!a && !!b && a.file === b.file && a.line === b.line && a.character === b.character;

  // The row selected in the results view: unfold to its box, mark it and bring it into view.
  function select(location) {
    const node = allNodes().find((n) => sameLocation(n.location, location));
    if (!node) return;
    let unfolded = false;
    for (let p = node.parent; p; p = p.parent) {
      if (p.collapsed) { p.collapsed = false; unfolded = true; }
    }
    selected = node;
    // A row outside the branch on its own brings the whole chart back, so its box can be shown.
    let inBranch = !isolated;
    for (let p = node; p && !inBranch; p = p.parent) inBranch = p === isolated;
    if (!inBranch) isolate(undefined);
    else if (unfolded) render();
    allNodes().forEach((n) => n.el && n.el.classList.toggle('selected', n === node));
    highlightPath(node);
    showInfo(node);
    ensureVisible(node);
  }

  window.addEventListener('message', (event) => {
    if (event.data.type === 'select') return select(event.data.location);
    if (event.data.type === 'peek') {
      const key = `${event.data.location.file}:${event.data.location.line}`;
      codeLines.set(key, event.data.code);
      codeBlocks.set(key, event.data.block || event.data.code || '');
      if (key === infoKey) showCode(event.data.code);
      // Several boxes can point at the same line: the card is updated for the box it was opened on.
      if (cardNode && cardKey(cardNode) === key) card.update(cardContent(cardNode), key);
      return;
    }
    if (event.data.type !== 'diagram') return;
    diagram = event.data.diagram;
    analyses = event.data.analyses || [];
    window.chartKit.renderControls(document.getElementById('graphControls'), event.data.controls, (id, value) => vscode.postMessage({ type: 'control', id, value }));
    closeMenu(false);
    card.hide();
    card.unpin();
    focused = undefined;
    flowing = undefined;
    selected = undefined;
    showInfo(undefined);
    if (diagram) {
      isolated = undefined;
      chain = new Set();
      branchBar.hidden = true;
      linkParents(diagram.left, undefined, 'in');
      linkParents(diagram.right, undefined, 'out');
    }
    const memory = diagram && saved[diagram.title];
    if (memory) forEach([...diagram.left, ...diagram.right], (n) => { if (n.key in memory.collapsed) n.collapsed = memory.collapsed[n.key]; });
    if (query) for (const n of allNodes().filter(isMatch)) for (let p = n.parent; p; p = p.parent) p.collapsed = false;
    empty.hidden = !!diagram;
    svg.classList.toggle('off', !diagram);
    caption.textContent = '';
    if (diagram) {
      const subject = document.createElement('strong');
      subject.textContent = diagram.center.label;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = diagram.title.replace(/ (of|in|since) .*$/, '');
      caption.append(subject, kind);
      caption.title = [diagram.title, diagram.center.description].filter(Boolean).join(': ');
    }
    render();
    if (memory) {
      view = { ...memory.view };
      apply();
    } else {
      fit();
    }
  });
  // The grid and the two toggles in the header.
  const onScreen = (n) => ({ x: view.x + n.px * view.k, y: view.y + n.py * view.k, w: n.w * view.k, h: H * view.k });
  grid = window.diagramGrid.create(document.getElementById('grid'), () => ({
    panX: view.x,
    panY: view.y,
    k: view.k,
    version: layoutVersion,
    get boxes() {
      return shownNodes.map(onScreen);
    },
    hovered: hovered && hovered.px !== undefined ? onScreen(hovered) : undefined,
  }));
  window.chartKit.attachFlowLines(document.getElementById('flowLines'), () => view);
  window.chartKit.bindToggles(prefs, grid, saveState, stopFlow);
  vscode.postMessage({ type: 'ready' });
})();
