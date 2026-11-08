// The Control Flow view: a function's flowchart with its decisions, loops and returns, and the Path Explorer.
(function () {
  const vscode = acquireVsCodeApi();
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('canvas');
  const scene = document.getElementById('scene');
  const list = document.getElementById('paths');
  const pinsBar = document.getElementById('pins');
  const summary = document.getElementById('pathSummary');
  const caption = document.getElementById('caption');
  const empty = document.getElementById('empty');
  const panel = document.getElementById('explorer');
  const state = vscode.getState() || {};
  let chart;
  let view = { x: 20, y: 20, k: 1 };
  let selected = -1;
  let pins = [];
  let cursorNode;
  let showImpossible = !!state.showImpossible;
  let slice;
  // A second path to compare with the selected one (Shift+click).
  let compared = -1;
  const comparison = document.getElementById('comparison');

  const el = (name, attrs, parent) => {
    const node = document.createElementNS(svgNs, name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  };

  // Light syntax coloring with theme colors: keywords, strings, numbers and called functions.
  const keywords = new Set('if else return let const var new typeof instanceof switch case default for of in while do throw catch finally try await async break continue true false null undefined this void delete yield function class'.split(' '));
  function codeLine(parent, text, x, y) {
    const line = el('text', { x, y, class: 'code' }, parent);
    const pattern = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\b\d[\d_.]*\b|[A-Za-z_$][\w$]*|\s+|.)/g;
    let match;
    while ((match = pattern.exec(text))) {
      const token = match[0];
      const span = el('tspan', {}, line);
      span.textContent = token;
      if (/^['"`]/.test(token)) span.setAttribute('class', 'string');
      else if (/^\d/.test(token)) span.setAttribute('class', 'number');
      else if (keywords.has(token)) span.setAttribute('class', 'keyword');
      else if (/^[A-Za-z_$]/.test(token) && text[pattern.lastIndex] === '(') span.setAttribute('class', 'call');
    }
    return line;
  }

  function nodeShape(g, n) {
    const { width: w, height: h } = n;
    if (n.kind === 'decision' || n.kind === 'switch') {
      el('path', { d: `M14,0 H${w - 14} L${w},${h / 2} L${w - 14},${h} H14 L0,${h / 2} Z`, class: 'shape' }, g);
    } else if (n.kind === 'start' || n.kind === 'end') {
      el('rect', { width: w, height: h, rx: h / 2, class: 'shape' }, g);
    } else {
      el('rect', { width: w, height: h, rx: n.kind === 'loop' ? 10 : 4, class: 'shape' }, g);
    }
  }

  function edgePath(points) {
    if (points.length === 2) {
      const [a, b] = points;
      const mid = (a.y + b.y) / 2;
      return `M${a.x},${a.y} C${a.x},${mid} ${b.x},${mid} ${b.x},${b.y - 2}`;
    }
    // A back edge: right, up, left, with rounded corners.
    const [a, b, c, d] = points;
    const r = 8;
    const up = c.y < b.y ? -1 : 1;
    return `M${a.x},${a.y} H${b.x - r} Q${b.x},${b.y} ${b.x},${b.y + up * r} V${c.y - up * r} Q${c.x},${c.y} ${c.x - r},${c.y} H${d.x + 2}`;
  }

  function render() {
    scene.textContent = '';
    if (!chart) return;
    const edges = el('g', { class: 'edges' }, scene);
    chart.edges.forEach((e, i) => {
      const g = el('g', { class: `edge ${e.kind}${e.back ? ' back' : ''}`, 'data-edge': i }, edges);
      el('path', { d: edgePath(e.points), class: 'line', 'marker-end': 'url(#arrow)' }, g);
      // A wide invisible stroke makes the edge easy to click.
      el('path', { d: edgePath(e.points), class: 'hit' }, g);
      if (e.label) {
        const label = el('g', { class: 'edge-label', transform: `translate(${e.labelAt.x},${e.labelAt.y})` }, g);
        const width = e.label.length * 6.6 + 12;
        el('rect', { x: -width / 2, y: -9, width, height: 18, rx: 9 }, label);
        el('text', { 'text-anchor': 'middle', y: 4 }, label).textContent = e.label;
        el('title', {}, label).textContent = 'Click to keep only the paths through this branch';
      }
    });
    // A frame around each spliced-in function, behind its boxes.
    const frames = el('g', { class: 'frames' });
    scene.insertBefore(frames, edges);
    const owners = new Map();
    for (const n of chart.nodes) if (n.owner) owners.set(n.owner, [...(owners.get(n.owner) || []), n]);
    for (const [owner, members] of owners) {
      const x0 = Math.min(...members.map((n) => n.x)) - 12;
      const y0 = Math.min(...members.map((n) => n.y)) - 24;
      const x1 = Math.max(...members.map((n) => n.x + n.width)) + 12;
      const y1 = Math.max(...members.map((n) => n.y + n.height)) + 10;
      el('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 8, class: 'frame' }, frames);
      el('text', { x: x0 + 8, y: y0 + 15, class: 'frame-label' }, frames).textContent = `↳ ${owner}()`;
    }
    const nodes = el('g', { class: 'nodes' }, scene);
    for (const n of chart.nodes) {
      const g = el('g', { class: `node ${n.kind}${n.unreachable ? ' unreachable' : ''}${n.location ? ' located' : ''}`, transform: `translate(${n.x},${n.y})`, 'data-node': n.id, tabindex: 0, role: 'button' }, nodes);
      g.setAttribute('aria-label', `${n.kind === 'statement' ? 'Code' : n.kind}: ${n.lines.join('; ')}${n.unreachable ? '. Unreachable' : ''}`);
      nodeShape(g, n);
      const textX = n.kind === 'decision' || n.kind === 'switch' || n.kind === 'loop' ? 26 : n.kind === 'start' || n.kind === 'end' ? 17 : 13;
      n.lines.forEach((line, i) => {
        if (n.kind === 'start' || n.kind === 'end') el('text', { x: n.width / 2, y: n.height / 2 + 4, 'text-anchor': 'middle', class: 'title' }, g).textContent = line;
        else codeLine(g, line, textX, 8 + 13 + i * 18);
      });
      if (n.kind === 'loop') el('text', { x: 10, y: n.height / 2 + 4, class: 'glyph' }, g).textContent = '↻';
      if (n.unreachable) el('title', {}, g).textContent = 'Unreachable: nothing leads here';
      if (n.calls && n.calls.length) {
        // Expand the called functions in place (or fold them back).
        const open = n.calls.every((c) => c.expanded);
        const names = [...new Set(n.calls.map((c) => c.name))].join(', ');
        const button = el('g', { class: 'expand', transform: `translate(${n.width - 2},${-2})`, role: 'button', tabindex: 0, 'aria-label': `${open ? 'Fold' : 'Expand'} the call to ${names}` }, g);
        el('rect', { x: -22, y: -8, width: 26, height: 16, rx: 8 }, button);
        el('text', { x: -9, y: 4, 'text-anchor': 'middle' }, button).textContent = open ? 'ƒ−' : 'ƒ+';
        el('title', {}, button).textContent = `${open ? 'Fold' : 'Expand'} ${names}() here`;
        button.dataset.keys = JSON.stringify(n.calls.map((c) => c.key));
        button.dataset.open = String(open);
      }
    }
    highlight();
  }

  // The paths that match the pinned branches, possible ones first.
  function matching() {
    return chart.paths.map((p, i) => ({ p, i })).filter(({ p }) => pins.every((e) => p.edges.includes(e)) && (showImpossible || p.feasible));
  }

  function renderList() {
    list.textContent = '';
    if (!chart) return;
    const found = matching();
    const possible = chart.paths.filter((p) => p.feasible).length;
    summary.textContent = `${possible} possible path${possible === 1 ? '' : 's'}${chart.paths.length > possible ? `, ${chart.paths.length - possible} impossible` : ''}${chart.truncated ? ' (first ' + chart.paths.length + ' shown)' : ''}`;
    pinsBar.textContent = '';
    if (slice) {
      const chip = document.createElement('button');
      chip.className = 'chip slice';
      chip.title = 'Clear the slice';
      chip.textContent = `${slice.direction === 'backward' ? '← What affects' : '→ What is affected by'} ${slice.name} (line ${slice.line}): ${slice.nodes.length} boxes ✕`;
      chip.addEventListener('click', () => { slice = undefined; renderList(); highlight(); });
      pinsBar.appendChild(chip);
    }
    for (const e of pins) {
      const edge = chart.edges[e];
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.title = 'Remove this branch from the filter';
      chip.textContent = `${chart.nodes[edge.from].lines[0].slice(0, 28)} → ${edge.label} ✕`;
      chip.addEventListener('click', () => { pins = pins.filter((x) => x !== e); afterPins(); });
      pinsBar.appendChild(chip);
    }
    found.forEach(({ p, i }, n) => {
      const item = document.createElement('li');
      item.className = `path${i === selected ? ' selected' : ''}${p.feasible ? '' : ' impossible'}`;
      item.tabIndex = 0;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === selected));
      const title = document.createElement('div');
      title.className = 'path-title';
      title.textContent = `${n + 1}. ${p.ending}`;
      item.appendChild(title);
      const steps = document.createElement('div');
      steps.className = 'path-steps';
      steps.textContent = p.steps.length ? p.steps.map((s) => s.text).join(' → ') : 'no branches';
      item.appendChild(steps);
      if (!p.feasible) {
        const why = document.createElement('div');
        why.className = 'path-reason';
        why.textContent = `Impossible: ${p.reason}`;
        item.appendChild(why);
      }
      const choose = (e) => {
        if ((e.shiftKey || e.ctrlKey || e.metaKey) && selected >= 0 && i !== selected) {
          compared = compared === i ? -1 : i;
          renderList();
          highlight();
        } else {
          compared = -1;
          select(i === selected ? -1 : i);
        }
      };
      item.addEventListener('click', choose);
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(e); } });
      if (i === compared) item.classList.add('compared');
      list.appendChild(item);
    });
    renderComparison();
    if (!found.length) {
      const none = document.createElement('li');
      none.className = 'none';
      none.textContent = 'No possible path takes all these branches.';
      list.appendChild(none);
    }
  }

  // Where two paths part: the branches they share, the first one they take differently, and how each ends.
  function renderComparison() {
    comparison.textContent = '';
    comparison.hidden = !(selected >= 0 && compared >= 0);
    if (comparison.hidden) return;
    const a = chart.paths[selected];
    const b = chart.paths[compared];
    let shared = 0;
    while (shared < a.steps.length && shared < b.steps.length && a.steps[shared].edge === b.steps[shared].edge) shared++;
    const line = (label, text, cls) => {
      const row = document.createElement('div');
      row.className = `compare-row ${cls || ''}`;
      const name = document.createElement('strong');
      name.textContent = label;
      row.append(name, document.createTextNode(text));
      comparison.appendChild(row);
    };
    line('Both: ', shared ? a.steps.slice(0, shared).map((s) => s.text).join(' → ') : 'no branch in common');
    line('A: ', [...a.steps.slice(shared).map((s) => s.text), a.ending].join(' → '), 'a');
    line('B: ', [...b.steps.slice(shared).map((s) => s.text), b.ending].join(' → '), 'b');
  }

  function select(i) {
    selected = i;
    renderList();
    highlight();
    const item = list.querySelector('.selected');
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  function afterPins() {
    const found = matching();
    selected = found.length === 1 ? found[0].i : found.some(({ i }) => i === selected) ? selected : -1;
    renderList();
    highlight();
  }

  // The selected path lights up and the rest dims; pinned branches show the union of their paths.
  function highlight() {
    if (!chart) return;
    const onNodes = new Set();
    const onEdges = new Set();
    const active = selected >= 0 ? [chart.paths[selected]] : pins.length ? matching().map(({ p }) => p) : [];
    // A slice lights up its boxes, and the edges between them, when no path is picked.
    if (!active.length && slice) {
      const inSlice = new Set(slice.nodes);
      active.push({ nodes: slice.nodes, edges: chart.edges.map((e, i) => (inSlice.has(e.from) && inSlice.has(e.to) ? i : -1)).filter((i) => i >= 0) });
    }
    for (const p of active) {
      p.nodes.forEach((n) => onNodes.add(n));
      p.edges.forEach((e) => onEdges.add(e));
    }
    const other = compared >= 0 && selected >= 0 ? chart.paths[compared] : undefined;
    const otherNodes = new Set(other ? other.nodes : []);
    const otherEdges = new Set(other ? other.edges : []);
    if (other) {
      other.nodes.forEach((n) => onNodes.add(n));
      other.edges.forEach((e) => onEdges.add(e));
    }
    const focus = active.length > 0;
    scene.querySelectorAll('.node').forEach((g) => {
      const id = Number(g.dataset.node);
      g.classList.toggle('on', focus && onNodes.has(id));
      g.classList.toggle('on2', otherNodes.has(id));
      g.classList.toggle('off', focus && !onNodes.has(id));
      g.classList.toggle('cursor', id === cursorNode);
      g.classList.toggle('criterion', !!slice && id === slice.at);
    });
    scene.querySelectorAll('.edge').forEach((g) => {
      const i = Number(g.dataset.edge);
      g.classList.toggle('on', focus && onEdges.has(i));
      g.classList.toggle('on2', otherEdges.has(i));
      g.classList.toggle('only2', otherEdges.has(i) && !(selected >= 0 && chart.paths[selected].edges.includes(i)));
      g.classList.toggle('off', focus && !onEdges.has(i));
      g.classList.toggle('pinned', pins.includes(i));
    });
  }

  // Clicks: a box opens its code; a branch label or line pins that branch; ƒ+ expands a call.
  const toggleCalls = (button) => vscode.postMessage({ type: 'expand', keys: JSON.parse(button.dataset.keys), expand: button.dataset.open !== 'true' });
  scene.addEventListener('click', (e) => {
    const expand = e.target.closest('.expand');
    if (expand) {
      e.stopPropagation();
      toggleCalls(expand);
      return;
    }
    const edge = e.target.closest('.edge');
    if (edge) {
      const i = Number(edge.dataset.edge);
      if (!chart.edges[i].label) return;
      pins = pins.includes(i) ? pins.filter((x) => x !== i) : [...pins, i];
      afterPins();
      return;
    }
    const g = e.target.closest('.node');
    if (g) open(chart.nodes[Number(g.dataset.node)]);
  });
  scene.addEventListener('keydown', (e) => {
    const expand = e.target.closest('.expand');
    if (expand && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      toggleCalls(expand);
      return;
    }
    const g = e.target.closest('.node');
    if (g && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      open(chart.nodes[Number(g.dataset.node)]);
    }
  });
  const open = (n) => n.location && vscode.postMessage({ type: 'open', location: n.location });

  // Pan by dragging, zoom with the wheel, Fit to see it all.
  function apply() {
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    document.getElementById('zoomLevel').textContent = `${Math.round(view.k * 100)}%`;
  }
  function fit(all) {
    if (!chart) return;
    const w = svg.clientWidth || 800;
    const h = svg.clientHeight || 600;
    let k = Math.min(1.2, (w - 40) / chart.width, (h - 40) / chart.height);
    if (k < 0.55 && !all) {
      // Too small to read when it all fits: start at the top at a readable size, centered on the start box.
      k = 0.85;
      const start = chart.nodes[0];
      view = { k, x: w / 2 - (start.x + start.width / 2) * k, y: 20 };
    } else {
      k = Math.max(0.2, k);
      view = { k, x: Math.max(20, (w - chart.width * k) / 2), y: 20 };
    }
    apply();
  }
  function zoom(f, cx, cy) {
    const k = Math.min(3, Math.max(0.2, view.k * f));
    const px = cx ?? svg.clientWidth / 2;
    const py = cy ?? svg.clientHeight / 2;
    view = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    apply();
  }
  let drag;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.node') || e.target.closest('.edge')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => { if (drag) { view.x = e.clientX - drag.x; view.y = e.clientY - drag.y; apply(); } });
  svg.addEventListener('pointerup', () => { drag = undefined; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || !e.shiftKey) zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // Export: Mermaid text is made by the extension; the SVG is the chart as drawn, with its colors written in.
  document.getElementById('mermaid').addEventListener('click', () => {
    const path = selected >= 0 ? chart.paths[selected] : undefined;
    vscode.postMessage({ type: 'mermaid', path: path ? { nodes: path.nodes, edges: path.edges } : undefined });
  });
  document.getElementById('save').addEventListener('click', () => {
    if (!chart) return;
    const box = scene.getBBox();
    const pad = 24;
    const copy = svg.cloneNode(true);
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight'];
    const originals = svg.querySelectorAll('*');
    copy.querySelectorAll('*').forEach((node, i) => {
      const style = getComputedStyle(originals[i]);
      node.setAttribute('style', props.map((p) => `${p}:${style.getPropertyValue(p)}`).join(';'));
      node.removeAttribute('tabindex');
    });
    copy.querySelectorAll('.hit, title').forEach((node) => node.remove());
    copy.removeAttribute('class');
    copy.setAttribute('xmlns', svgNs);
    copy.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.width + 2 * pad} ${box.height + 2 * pad}`);
    copy.setAttribute('width', String(Math.ceil(box.width + 2 * pad)));
    copy.setAttribute('height', String(Math.ceil(box.height + 2 * pad)));
    copy.querySelector('#scene').removeAttribute('transform');
    const background = el('rect', { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, fill: getComputedStyle(document.body).backgroundColor });
    copy.insertBefore(background, copy.querySelector('#scene'));
    vscode.postMessage({ type: 'save', svg: new XMLSerializer().serializeToString(copy) });
  });
  document.getElementById('zoomIn').addEventListener('click', () => zoom(1.2));
  document.getElementById('zoomOut').addEventListener('click', () => zoom(1 / 1.2));
  document.getElementById('zoomLevel').addEventListener('click', () => zoom(1 / view.k));
  document.getElementById('fit').addEventListener('click', () => fit(true));
  document.getElementById('togglePaths').addEventListener('click', (e) => {
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute('aria-pressed', String(!panel.hidden));
  });
  document.getElementById('clearPins').addEventListener('click', () => { pins = []; selected = -1; afterPins(); });
  const impossibleBox = document.getElementById('showImpossible');
  impossibleBox.checked = showImpossible;
  impossibleBox.addEventListener('change', () => {
    showImpossible = impossibleBox.checked;
    vscode.setState({ ...state, showImpossible });
    afterPins();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === '+' || e.key === '=') zoom(1.2);
    else if (e.key === '-') zoom(1 / 1.2);
    else if (e.key === '0') fit(true);
    else if (e.key === 'Escape') { pins = []; compared = -1; select(-1); }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'chart') {
      slice = undefined;
      const same = chart && message.chart && chart.name === message.chart.name && chart.file === message.chart.file;
      chart = message.chart;
      empty.hidden = !!chart;
      svg.classList.toggle('off', !chart);
      if (!same) {
        pins = [];
        selected = -1;
      } else {
        // After an edit, keep what was picked if it still exists.
        pins = pins.filter((e) => e < chart.edges.length);
        if (selected >= chart.paths.length) selected = -1;
      }
      caption.textContent = '';
      if (chart) {
        const strong = document.createElement('strong');
        strong.textContent = chart.name;
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = 'Control flow';
        caption.append(strong, kind);
      }
      render();
      renderList();
      if (!same) fit();
      else apply();
    } else if (message.type === 'slice') {
      slice = message.slice;
      selected = -1;
      pins = [];
      renderList();
      highlight();
    } else if (message.type === 'cursor') {
      cursorNode = message.id;
      highlight();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
