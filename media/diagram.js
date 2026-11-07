// Draws an analysis as a flow chart: the subject in the middle, what flows in on the left and what
// flows out (or every other row) on the right. Rows become nodes; nodes with children fold and unfold.
(function () {
  const vscode = acquireVsCodeApi();
  const svgNs = 'http://www.w3.org/2000/svg';
  const MIN_W = 150;
  const MAX_W = 360;
  const H = 48;
  const GAP_X = 80;
  const GAP_Y = 14;
  const svg = document.getElementById('canvas');
  const scene = document.getElementById('scene');
  const empty = document.getElementById('empty');
  const caption = document.getElementById('caption');
  const searchBox = document.getElementById('search');
  const searchCount = document.getElementById('searchCount');
  let diagram;
  let view = { x: 0, y: 0, k: 1 };
  let query = '';
  let matchIndex = -1;
  let shownNodes = [];
  let focused;

  // Boxes are as wide as their text, between MIN_W and MAX_W; longer text is cut with an ellipsis.
  const measure = document.createElement('canvas').getContext('2d');
  const fontOf = (weight, size) => `${weight} ${size}px ${getComputedStyle(document.body).fontFamily}`;
  const textWidth = (text, font) => { measure.font = font; return measure.measureText(text || '').width; };
  const fitText = (text, font, max) => {
    if (!text || textWidth(text, font) <= max) return text || '';
    let cut = text.length;
    while (cut > 1 && textWidth(text.slice(0, cut) + '…', font) > max) cut--;
    return text.slice(0, cut) + '…';
  };
  const widthOf = (node) => Math.min(MAX_W, Math.max(MIN_W, Math.ceil(Math.max(textWidth(node.label, fontOf(600, 12)), textWidth(node.description, fontOf(400, 11))) + 30)));
  const el = (name, attrs, parent) => {
    const node = document.createElementNS(svgNs, name);
    for (const [key, value] of Object.entries(attrs || {})) {
      node.setAttribute(key, String(value));
    }
    if (parent) parent.appendChild(node);
    return node;
  };
  const visible = (node) => (node.collapsed ? [] : node.children);
  const forEach = (nodes, visit) => nodes.forEach((n) => { visit(n); forEach(n.children, visit); });
  const linkParents = (nodes, parent) => nodes.forEach((n) => { n.parent = parent; linkParents(n.children, n); });
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

  function render() {
    scene.textContent = '';
    if (!diagram) return;
    const leftRows = place(diagram.left, 1, -1, { next: 0 });
    const rightRows = place(diagram.right, 1, 1, { next: 0 });
    const rows = Math.max(leftRows, rightRows, 1);
    shift(diagram.left, (rows - leftRows) / 2);
    shift(diagram.right, (rows - rightRows) / 2);
    const center = diagram.center;
    center.row = (rows - 1) / 2;
    center.depth = 0;
    center.side = 0;
    // Each column is as wide as its widest box; left boxes line up on the edge facing the subject.
    const shown = [center];
    const collect = (nodes) => nodes.forEach((n) => { shown.push(n); collect(visible(n)); });
    collect(diagram.left);
    collect(diagram.right);
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
    const x = (n) => n.px;
    const y = (n) => n.py;

    const edges = el('g', { class: 'edges' }, scene);
    const link = (from, to, side) => {
      // Arrows point the way the value moves: into the subject on the left, away from it on the right.
      const [a, b] = side < 0 ? [to, from] : [from, to];
      const x1 = x(a) + a.w;
      const y1 = y(a) + H / 2;
      const x2 = x(b);
      const y2 = y(b) + H / 2;
      const mid = (x1 + x2) / 2;
      return el('path', { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 2},${y2}`, class: 'edge', 'marker-end': 'url(#arrow)' }, edges);
    };
    const linkAll = (parent, nodes, side) => {
      for (const node of nodes) {
        node.edgeEl = link(parent, node, side);
        linkAll(node, visible(node), side);
      }
    };
    linkAll(center, diagram.left, -1);
    linkAll(center, diagram.right, 1);

    const layer = el('g', { class: 'nodes' }, scene);
    const draw = (node) => {
      const found = query ? (isMatch(node) ? ' match' : ' dim') : '';
      const g = el('g', { class: `node${node === center ? ' center' : ''}${node.tone ? ' ' + node.tone : ''}${node.location ? ' located' : ''}${found}`, transform: `translate(${x(node)},${y(node)})`, tabindex: node === center ? 0 : -1 }, layer);
      node.el = g;
      g.addEventListener('focus', () => { focused = node; highlightPath(node); });
      g.addEventListener('mouseenter', () => highlightPath(node));
      g.addEventListener('mouseleave', () => highlightPath(focused));
      g.addEventListener('keydown', (e) => onNodeKey(e, node));
      el('title', {}, g).textContent = [node.label, node.description].filter(Boolean).join('\n');
      el('rect', { width: node.w, height: H, rx: 6, class: 'box' }, g);
      if (node.tone) el('rect', { width: 4, height: H - 8, x: 3, y: 4, rx: 2, class: 'tone' }, g);
      el('text', { x: 14, y: node.description ? 20 : H / 2 + 4, class: 'label' }, g).textContent = fitText(node.label, fontOf(600, 12), node.w - 26);
      if (node.description) el('text', { x: 14, y: 37, class: 'description' }, g).textContent = fitText(node.description, fontOf(400, 11), node.w - 26);
      if (node.location) {
        // Right-click offers the analyses the results view offers on a row.
        g.dataset.vscodeContext = JSON.stringify({ webviewSection: 'node', file: node.location.file, line: node.location.line, character: node.location.character, preventDefaultContextMenuItems: true });
        const open = () => vscode.postMessage({ type: 'open', location: node.location });
        g.addEventListener('click', open);
      }
      if (node.children.length && node !== center) {
        // The fold button sits on the outer edge, where the children are.
        const toggle = el('g', { class: 'toggle', transform: `translate(${node.side < 0 ? 0 : node.w},${H / 2})` }, g);
        el('circle', { r: 9 }, toggle);
        el('text', { y: 4, 'text-anchor': 'middle' }, toggle).textContent = node.collapsed ? String(node.children.length) : '−';
        el('title', {}, toggle).textContent = node.collapsed ? `Show ${node.children.length} more` : 'Fold';
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          node.collapsed = !node.collapsed;
          render();
        });
      }
    };
    draw(center);
    const drawAll = (nodes) => nodes.forEach((n) => { draw(n); drawAll(visible(n)); });
    drawAll(diagram.left);
    drawAll(diagram.right);
    if (diagram.leftCaption && diagram.left.length) el('text', { x: -edge(-1, 1), y: -14, 'text-anchor': 'end', class: 'side' }, scene).textContent = diagram.leftCaption + ' →';
    if (diagram.rightCaption && diagram.right.length) el('text', { x: edge(1, 1), y: -14, class: 'side' }, scene).textContent = '→ ' + diagram.rightCaption;
    highlighted = [];
    apply();
    if (focused && focused.el && document.activeElement !== searchBox) focused.el.focus({ preventScroll: true });
  }

  // The way from a box to the subject stands out while the box is hovered or focused.
  let highlighted = [];
  function highlightPath(node) {
    for (const item of highlighted) {
      item.classList.remove('onpath');
      if (item.classList.contains('edge')) item.setAttribute('marker-end', 'url(#arrow)');
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
      if (item.classList.contains('edge')) item.setAttribute('marker-end', 'url(#arrowOn)');
    }
  }

  // Arrow keys walk the chart: outward to the first child, inward to the parent, up and down within a column.
  function neighbor(node, key) {
    const center = diagram.center;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const column = shownNodes.filter((n) => n.side === node.side && n.depth === node.depth).sort((a, b) => a.row - b.row);
      return column[column.indexOf(node) + (key === 'ArrowDown' ? 1 : -1)];
    }
    if (node === center) return key === 'ArrowRight' ? diagram.right[0] : diagram.left[0];
    const outward = node.side > 0 ? 'ArrowRight' : 'ArrowLeft';
    return key === outward ? visible(node)[0] : node.parent || center;
  }

  function ensureVisible(node) {
    const left = view.x + node.px * view.k;
    const top = view.y + node.py * view.k;
    if (left < 10 || top < 10 || left + node.w * view.k > svg.clientWidth - 10 || top + H * view.k > svg.clientHeight - 10) centerOn(node);
  }

  function onNodeKey(e, node) {
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = neighbor(node, e.key);
      if (next && next.el) { next.el.focus({ preventScroll: true }); ensureVisible(next); }
    } else if (e.key === 'Enter' && node.location) {
      vscode.postMessage({ type: 'open', location: node.location });
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

  function apply() {
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  }

  function fit(all) {
    const box = scene.getBBox();
    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;
    if (!box.width || !box.height) return;
    const k = Math.min(1.2, (width - 40) / box.width, (height - 40) / box.height);
    if (k < 0.6 && diagram && !all) {
      // Too small to read when it all fits: show the subject at a readable size; drag or zoom out for the rest.
      const c = diagram.center;
      view = { k: 0.9, x: width / 2 - (c.px + c.w / 2) * 0.9, y: height / 2 - (c.py + H / 2) * 0.9 };
    } else {
      view = { k, x: width / 2 - (box.x + box.width / 2) * k, y: height / 2 - (box.y + box.height / 2) * k };
    }
    apply();
  }

  /** Pans so the box is in the middle of the window, at the current zoom. */
  function centerOn(node) {
    view = { k: view.k, x: svg.clientWidth / 2 - (node.px + node.w / 2) * view.k, y: svg.clientHeight / 2 - (node.py + H / 2) * view.k };
    apply();
  }

  // Find: matching boxes stand out, the rest fade; folded boxes holding a match unfold. Enter goes to the next match.
  function search(text) {
    query = text.trim().toLowerCase();
    matchIndex = -1;
    for (const n of allNodes().filter(isMatch)) {
      for (let p = n.parent; p; p = p.parent) p.collapsed = false;
    }
    render();
    const count = allNodes().filter(isMatch).length;
    searchCount.textContent = query ? (count ? `${count} found` : 'No boxes match') : '';
  }

  function nextMatch(step) {
    const found = allNodes().filter(isMatch);
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
    const k = Math.min(3, Math.max(0.15, view.k * factor));
    const px = cx === undefined ? svg.clientWidth / 2 : cx;
    const py = cy === undefined ? svg.clientHeight / 2 : cy;
    view = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    apply();
  }

  // Drag the background to pan; the wheel zooms around the pointer.
  let drag;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.node')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.x = e.clientX - drag.x;
    view.y = e.clientY - drag.y;
    apply();
  });
  svg.addEventListener('pointerup', () => { drag = undefined; svg.classList.remove('dragging'); });
  svg.addEventListener('wheel', (e) => {
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
  document.getElementById('fit').addEventListener('click', () => fit(true));
  document.getElementById('zoomIn').addEventListener('click', () => zoom(1.2));
  document.getElementById('zoomOut').addEventListener('click', () => zoom(1 / 1.2));
  document.getElementById('expand').addEventListener('click', () => setAll(false));
  document.getElementById('collapse').addEventListener('click', () => setAll(true));

  window.addEventListener('message', (event) => {
    if (event.data.type !== 'diagram') return;
    diagram = event.data.diagram;
    focused = undefined;
    if (diagram) linkParents([...diagram.left, ...diagram.right], undefined);
    if (query) for (const n of allNodes().filter(isMatch)) for (let p = n.parent; p; p = p.parent) p.collapsed = false;
    empty.hidden = !!diagram;
    svg.classList.toggle('off', !diagram);
    caption.textContent = diagram ? [diagram.title, diagram.center.description].filter(Boolean).join(' · ') : '';
    render();
    fit();
  });
  vscode.postMessage({ type: 'ready' });
})();
