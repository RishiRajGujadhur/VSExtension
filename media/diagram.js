// Draws an analysis as a flow chart: the subject in the middle, what flows in on the left and what
// flows out (or every other row) on the right. Rows become nodes; nodes with children fold and unfold.
(function () {
  const vscode = acquireVsCodeApi();
  const svgNs = 'http://www.w3.org/2000/svg';
  const W = 240;
  const H = 48;
  const GAP_X = 80;
  const GAP_Y = 14;
  const svg = document.getElementById('canvas');
  const scene = document.getElementById('scene');
  const empty = document.getElementById('empty');
  const caption = document.getElementById('caption');
  let diagram;
  let view = { x: 0, y: 0, k: 1 };

  const shorten = (text, max) => (text && text.length > max ? text.slice(0, max - 1) + '…' : text || '');
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
    const x = (n) => n.side * n.depth * (W + GAP_X) - W / 2;
    const y = (n) => n.row * (H + GAP_Y);
    center.px = x(center);
    center.py = y(center);

    const edges = el('g', { class: 'edges' }, scene);
    const link = (from, to, side) => {
      // Arrows point the way the value moves: into the subject on the left, away from it on the right.
      const [a, b] = side < 0 ? [to, from] : [from, to];
      const x1 = x(a) + W;
      const y1 = y(a) + H / 2;
      const x2 = x(b);
      const y2 = y(b) + H / 2;
      const mid = (x1 + x2) / 2;
      el('path', { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 2},${y2}`, class: 'edge', 'marker-end': 'url(#arrow)' }, edges);
    };
    const linkAll = (parent, nodes, side) => {
      for (const node of nodes) {
        link(parent, node, side);
        linkAll(node, visible(node), side);
      }
    };
    linkAll(center, diagram.left, -1);
    linkAll(center, diagram.right, 1);

    const layer = el('g', { class: 'nodes' }, scene);
    const draw = (node) => {
      const g = el('g', { class: `node${node === center ? ' center' : ''}${node.tone ? ' ' + node.tone : ''}${node.location ? ' located' : ''}`, transform: `translate(${x(node)},${y(node)})`, tabindex: node.location ? 0 : -1 }, layer);
      el('title', {}, g).textContent = [node.label, node.description].filter(Boolean).join('\n');
      el('rect', { width: W, height: H, rx: 6, class: 'box' }, g);
      if (node.tone) el('rect', { width: 4, height: H - 8, x: 3, y: 4, rx: 2, class: 'tone' }, g);
      el('text', { x: 14, y: node.description ? 20 : H / 2 + 4, class: 'label' }, g).textContent = shorten(node.label, 32);
      if (node.description) el('text', { x: 14, y: 37, class: 'description' }, g).textContent = shorten(node.description, 40);
      if (node.location) {
        // Right-click offers the analyses the results view offers on a row.
        g.dataset.vscodeContext = JSON.stringify({ webviewSection: 'node', file: node.location.file, line: node.location.line, character: node.location.character, preventDefaultContextMenuItems: true });
        const open = () => vscode.postMessage({ type: 'open', location: node.location });
        g.addEventListener('click', open);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      }
      if (node.children.length && node !== center) {
        // The fold button sits on the outer edge, where the children are.
        const toggle = el('g', { class: 'toggle', transform: `translate(${node.side < 0 ? 0 : W},${H / 2})` }, g);
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
    if (diagram.leftCaption && diagram.left.length) el('text', { x: -(W + GAP_X) - W / 2, y: -14, class: 'side' }, scene).textContent = diagram.leftCaption + ' →';
    if (diagram.rightCaption && diagram.right.length) el('text', { x: W + GAP_X - W / 2, y: -14, class: 'side' }, scene).textContent = '→ ' + diagram.rightCaption;
    apply();
  }

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
      view = { k: 0.9, x: width / 2 - (c.px + W / 2) * 0.9, y: height / 2 - (c.py + H / 2) * 0.9 };
    } else {
      view = { k, x: width / 2 - (box.x + box.width / 2) * k, y: height / 2 - (box.y + box.height / 2) * k };
    }
    apply();
  }

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
    empty.hidden = !!diagram;
    svg.classList.toggle('off', !diagram);
    caption.textContent = diagram ? [diagram.title, diagram.center.description].filter(Boolean).join(' · ') : '';
    render();
    fit();
  });
  vscode.postMessage({ type: 'ready' });
})();
