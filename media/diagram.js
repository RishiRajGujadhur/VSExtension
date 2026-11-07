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
  const info = document.getElementById('info');
  const zoomLevel = document.getElementById('zoomLevel');
  const legend = document.getElementById('legend');
  const legendButton = document.getElementById('legendButton');
  let diagram;
  let view = { x: 0, y: 0, k: 1 };
  let query = '';
  let matchIndex = -1;
  let shownNodes = [];
  let focused;
  let selected;

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
  // Branch focus: after a double-click only the box, the boxes between it and the subject, and what is behind it are drawn.
  let isolated;
  let chain = new Set();
  const visible = (node) => {
    if (node.collapsed) return [];
    return isolated && chain.has(node) && node !== isolated ? node.children.filter((c) => chain.has(c)) : node.children;
  };
  const roots = (nodes) => (isolated ? nodes.filter((n) => chain.has(n)) : nodes);
  const forEach = (nodes, visit) => nodes.forEach((n) => { visit(n); forEach(n.children, visit); });
  // Each box gets its parent and a key made of the labels on its way to the subject, which survives a re-run.
  const linkParents = (nodes, parent, side) => nodes.forEach((n) => { n.parent = parent; n.key = `${parent ? parent.key : side}/${n.label}`; linkParents(n.children, n, side); });

  // Zoom, position and folding are remembered per analysis title (the 20 most recent), also after the tab is reloaded.
  const saved = (vscode.getState() || {}).memory || {};
  let rememberTimer;
  function remember() {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => {
      if (!diagram) return;
      const collapsed = {};
      forEach([...diagram.left, ...diagram.right], (n) => { if (n.children.length) collapsed[n.key] = n.collapsed; });
      saved[diagram.title] = { view, collapsed, at: Date.now() };
      Object.keys(saved).sort((a, b) => saved[b].at - saved[a].at).slice(20).forEach((title) => delete saved[title]);
      vscode.setState({ memory: saved });
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

  function render() {
    scene.textContent = '';
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
        if (node.kind === 'pattern') {
          // A pattern describes the code around the value; it is not where the value goes, so no arrow.
          node.edgeEl.classList.add('relation');
          node.edgeEl.removeAttribute('marker-end');
        }
        linkAll(node, visible(node), side);
      }
    };
    linkAll(center, roots(diagram.left), -1);
    linkAll(center, roots(diagram.right), 1);

    const layer = el('g', { class: 'nodes' }, scene);
    const draw = (node) => {
      const found = (query ? (isMatch(node) ? ' match' : ' dim') : '') + (node === selected ? ' selected' : '');
      // A box with no code of its own only gathers the boxes behind it: drawn as a dashed outline.
      const group = !node.location && node.children.length && !node.kind && node !== center ? ' group' : '';
      const g = el('g', { class: `node${node === center ? ' center' : ''}${node.kind ? ' ' + node.kind : ''}${group}${node.tone ? ' ' + node.tone : ''}${node.location ? ' located' : ''}${found}`, transform: `translate(${x(node)},${y(node)})`, tabindex: node === center ? 0 : -1 }, layer);
      node.el = g;
      g.addEventListener('focus', () => { focused = node; highlightPath(node); showInfo(node); });
      g.addEventListener('mouseenter', () => { highlightPath(node); showInfo(node); });
      g.addEventListener('mouseleave', () => { highlightPath(focused); showInfo(focused); });
      g.addEventListener('keydown', (e) => onNodeKey(e, node));
      g.addEventListener('dblclick', (e) => { e.stopPropagation(); if (node !== center) isolate(node); });
      el('title', {}, g).textContent = [node.label, node.description].filter(Boolean).join('\n');
      if (node.kind === 'pattern') {
        // Hexagon: a design pattern, not a step of the value.
        const w = node.w;
        el('path', { d: `M12,0 H${w - 12} L${w},${H / 2} L${w - 12},${H} H12 L0,${H / 2} Z`, class: 'box' }, g);
      } else {
        el('rect', { width: node.w, height: H, rx: 6, class: 'box' }, g);
      }
      if (node.tone) el('rect', { width: 4, height: H - 8, x: 3, y: 4, rx: 2, class: 'tone' }, g);
      el('text', { x: 14, y: node.description ? 20 : H / 2 + 4, class: 'label' }, g).textContent = fitText(node.label, fontOf(600, 12), node.w - 26);
      if (node.description) el('text', { x: 14, y: 37, class: 'description' }, g).textContent = fitText(node.description, fontOf(400, 11), node.w - 26);
      if (node.location) {
        // Right-click offers the analyses the results view offers on a row.
        g.dataset.vscodeContext = JSON.stringify({ webviewSection: 'node', file: node.location.file, line: node.location.line, character: node.location.character, preventDefaultContextMenuItems: true });
        // A single click opens the code; a double-click focuses on the branch instead, so the click waits a moment.
        let pending;
        g.addEventListener('click', () => {
          clearTimeout(pending);
          pending = setTimeout(() => vscode.postMessage({ type: 'open', location: node.location }), 220);
        });
        g.addEventListener('dblclick', () => clearTimeout(pending));
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
    drawAll(roots(diagram.left));
    drawAll(roots(diagram.right));
    if (diagram.leftCaption && roots(diagram.left).length) el('text', { x: -edge(-1, 1), y: -14, 'text-anchor': 'end', class: 'side' }, scene).textContent = diagram.leftCaption + ' →';
    if (diagram.rightCaption && roots(diagram.right).length) el('text', { x: edge(1, 1), y: -14, class: 'side' }, scene).textContent = '→ ' + diagram.rightCaption;
    highlighted = [];
    drawMinimap();
    apply();
    if (focused && focused.el && document.activeElement !== searchBox) focused.el.focus({ preventScroll: true });
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
    if (e.key === 'Escape' && isolated && e.target !== searchBox && legend.hidden) isolate(undefined);
  });

  // Minimap: the whole chart in the corner with the visible part outlined, shown when the chart is bigger than the
  // window. Click or drag in it to move there.
  const minimap = document.getElementById('minimap');
  const miniScene = document.getElementById('miniScene');
  const miniView = document.getElementById('miniView');
  let bounds;
  function drawMinimap() {
    miniScene.textContent = '';
    bounds = undefined;
    if (!diagram || !shownNodes.length) return;
    const pad = 20;
    const left = Math.min(...shownNodes.map((n) => n.px)) - pad;
    const top = Math.min(...shownNodes.map((n) => n.py)) - pad;
    const right = Math.max(...shownNodes.map((n) => n.px + n.w)) + pad;
    const bottom = Math.max(...shownNodes.map((n) => n.py + H)) + pad;
    bounds = { x: left, y: top, w: right - left, h: bottom - top };
    minimap.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
    for (const n of shownNodes) {
      el('rect', { x: n.px, y: n.py, width: n.w, height: H, rx: 6, class: `mini${n === diagram.center ? ' center' : ''}${n.kind ? ' ' + n.kind : ''}${n.tone ? ' ' + n.tone : ''}` }, miniScene);
    }
  }
  function updateMinimapView() {
    if (!bounds) {
      minimap.classList.add('off');
      return;
    }
    const vx = -view.x / view.k;
    const vy = -view.y / view.k;
    const vw = svg.clientWidth / view.k;
    const vh = svg.clientHeight / view.k;
    miniView.setAttribute('x', vx);
    miniView.setAttribute('y', vy);
    miniView.setAttribute('width', vw);
    miniView.setAttribute('height', vh);
    const fits = vx <= bounds.x && vy <= bounds.y && vx + vw >= bounds.x + bounds.w && vy + vh >= bounds.y + bounds.h;
    minimap.classList.toggle('off', fits);
  }
  let miniDrag = false;
  const moveTo = (e) => {
    const point = minimap.createSVGPoint();
    point.x = e.clientX;
    point.y = e.clientY;
    const at = point.matrixTransform(minimap.getScreenCTM().inverse());
    view = { k: view.k, x: svg.clientWidth / 2 - at.x * view.k, y: svg.clientHeight / 2 - at.y * view.k };
    apply();
  };
  minimap.addEventListener('pointerdown', (e) => { miniDrag = true; minimap.setPointerCapture(e.pointerId); moveTo(e); });
  minimap.addEventListener('pointermove', (e) => { if (miniDrag) moveTo(e); });
  minimap.addEventListener('pointerup', () => { miniDrag = false; });
  window.addEventListener('resize', () => updateMinimapView());

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
  let infoKey;
  function showCode(code) {
    if (!code) return;
    const line = document.createElement('code');
    line.textContent = code;
    info.appendChild(line);
  }

  // The way from a box to the subject stands out while the box is hovered or focused.
  let highlighted = [];
  function highlightPath(node) {
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
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = neighbor(node, e.key);
      if (next && next.el) { next.el.focus({ preventScroll: true }); ensureVisible(next); }
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

  function apply() {
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    zoomLevel.textContent = `${Math.round(view.k * 100)}%`;
    updateMinimapView();
    remember();
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
  // Save SVG: the chart as a standalone image, with the theme's colors written into it.
  function exportSvg() {
    if (!diagram) return;
    const box = scene.getBBox();
    const pad = 24;
    const out = svg.cloneNode(true);
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing'];
    const originals = svg.querySelectorAll('*');
    out.querySelectorAll('*').forEach((copy, i) => {
      const style = getComputedStyle(originals[i]);
      copy.setAttribute('style', props.map((p) => `${p}:${style.getPropertyValue(p)}`).join(';'));
      copy.removeAttribute('data-vscode-context');
      copy.removeAttribute('tabindex');
    });
    for (const side of out.querySelectorAll('.side')) side.textContent = side.textContent.toUpperCase();
    out.removeAttribute('class');
    out.removeAttribute('role');
    out.setAttribute('xmlns', svgNs);
    out.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.width + 2 * pad} ${box.height + 2 * pad}`);
    out.setAttribute('width', String(Math.ceil(box.width + 2 * pad)));
    out.setAttribute('height', String(Math.ceil(box.height + 2 * pad)));
    out.querySelector('#scene').removeAttribute('transform');
    const background = el('rect', { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, fill: getComputedStyle(document.body).backgroundColor });
    out.insertBefore(background, out.querySelector('#scene'));
    return { text: new XMLSerializer().serializeToString(out), width: box.width + 2 * pad, height: box.height + 2 * pad };
  }

  function saveSvg() {
    const image = exportSvg();
    if (image) vscode.postMessage({ type: 'save', svg: image.text, title: diagram.title });
  }

  // Save PNG: the same image drawn at twice the size, for chats and slides that do not show SVG.
  function savePng() {
    const image = exportSvg();
    if (!image) return;
    const picture = new Image();
    picture.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(image.width * scale);
      canvas.height = Math.ceil(image.height * scale);
      const context = canvas.getContext('2d');
      context.scale(scale, scale);
      context.drawImage(picture, 0, 0, image.width, image.height);
      vscode.postMessage({ type: 'savePng', png: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), title: diagram.title });
    };
    picture.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(image.text);
  }

  // Copy Mermaid: the chart as it is folded now, as text for Markdown and GitHub.
  function copyMermaid() {
    if (!diagram) return;
    const plain = (n) => ({ label: n.label, description: n.description, tone: n.tone, kind: n.kind, collapsed: n.collapsed && n !== diagram.center, children: n.children.map(plain) });
    vscode.postMessage({ type: 'mermaid', diagram: { title: diagram.title, center: plain(diagram.center), left: diagram.left.map(plain), right: diagram.right.map(plain) } });
  }

  document.getElementById('mermaid').addEventListener('click', copyMermaid);
  zoomLevel.addEventListener('click', () => zoom(1 / view.k));
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
    if (unfolded) render();
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
      if (key === infoKey) showCode(event.data.code);
      return;
    }
    if (event.data.type !== 'diagram') return;
    diagram = event.data.diagram;
    focused = undefined;
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
    caption.textContent = diagram ? [diagram.title, diagram.center.description].filter(Boolean).join(' · ') : '';
    render();
    if (memory) {
      view = { ...memory.view };
      apply();
    } else {
      fit();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
