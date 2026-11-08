// The Control Flow view: a function's flowchart with its decisions, loops and returns, and the Path Explorer.
// Start and end are circles; boxes, branch labels and the background each have a right-click menu; a minimap,
// search, an info bar and keyboard moves along the flow help with large functions.
(function () {
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('canvas');
  const scene = document.getElementById('scene');
  const list = document.getElementById('paths');
  const pinsBar = document.getElementById('pins');
  const summary = document.getElementById('pathSummary');
  const caption = document.getElementById('caption');
  const empty = document.getElementById('empty');
  const panel = document.getElementById('explorer');
  const info = document.getElementById('info');
  const searchBox = document.getElementById('search');
  const searchCount = document.getElementById('searchCount');
  const legend = document.getElementById('legend');
  const legendButton = document.getElementById('legendButton');
  const state = vscode.getState() || {};
  let chart;
  let analyses = [];
  let view = { x: 20, y: 20, k: 1 };
  let selected = -1;
  // Branches (edge indexes) and boxes (node ids) the listed paths must go through.
  let pins = [];
  let nodePins = [];
  let cursorNode;
  let showImpossible = !!state.showImpossible;
  let slice;
  // A second path to compare with the selected one (Shift+click), and one previewed by hovering the list.
  let compared = -1;
  let preview = -1;
  // Groups of paths with the same ending that are unfolded, and a group previewed by hovering its heading.
  const openGroups = new Set();
  let previewGroup;
  const comparison = document.getElementById('comparison');
  let query = '';
  let matches = [];
  let matchAt = -1;

  const kit = window.chartKit;
  const { el } = kit;
  // The animated grid and flowing lines, shared with the analysis diagram (diagramGrid.js, chartKit.js).
  const prefs = { effects: true, flow: true, ...(state.prefs || {}) };
  // Zoom and position per function (the 20 most recent), so reopening a function puts it back where it was.
  const views = state.views || {};
  const saveState = () => {
    state.prefs = prefs;
    state.views = views;
    state.explorer = !panel.hidden;
    vscode.setState(state);
  };
  let grid;
  let hovered;
  let focusedNode;
  let flowing;
  let layoutVersion = 0;
  let edgeShapes = [];
  const isTerminal = (n) => n.kind === 'start' || n.kind === 'end';
  const isDecision = (n) => n.kind === 'decision' || n.kind === 'switch' || n.kind === 'loop';
  const keyOf = () => (chart ? `${chart.file}#${chart.name}` : '');
  const kindIcons = { decision: 'question', switch: 'list-selection', loop: 'sync', return: 'reply', throw: 'error', catch: 'shield', finally: 'check-all', break: 'debug-step-out', continue: 'debug-continue' };
  const kindWords = { start: 'Start', end: 'End', decision: 'Decision', switch: 'Switch', loop: 'Loop', return: 'Return', throw: 'Throw', catch: 'Catch', finally: 'Finally', statement: 'Code' };

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
    if (n.kind === 'start') {
      // Start: a filled circle with a play mark; the function's name is written beside it.
      kit.flowRing(g, w / 2, h / 2, w / 2 + 5, -90, 90);
      el('circle', { cx: w / 2, cy: h / 2, r: w / 2, class: 'shape' }, g);
      kit.icon(g, 'play', w / 2 + 1, h / 2, 'terminal-icon');
    } else if (n.kind === 'end') {
      // End: a ring around a dot, like the end of a UML activity.
      kit.flowRing(g, w / 2, h / 2, w / 2 + 5, -90, 90);
      el('circle', { cx: w / 2, cy: h / 2, r: w / 2, class: 'shape' }, g);
      el('circle', { cx: w / 2, cy: h / 2, r: w / 2 - 7, class: 'core' }, g);
    } else if (n.kind === 'decision' || n.kind === 'switch') {
      el('path', { d: `M14,0 H${w - 14} L${w},${h / 2} L${w - 14},${h} H14 L0,${h / 2} Z`, class: 'shape' }, g);
    } else {
      el('rect', { width: w, height: h, rx: 12, class: 'shape' }, g);
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

  // Edges leave and enter circles at their rim, not at the corner of their square.
  function edgePoints(e) {
    const points = e.points.map((p) => ({ ...p }));
    const from = chart.nodes[e.from];
    const to = chart.nodes[e.to];
    if (points.length === 2) {
      if (isTerminal(from)) points[0] = { x: from.x + from.width / 2, y: from.y + from.height };
      if (isTerminal(to)) points[1] = { x: to.x + to.width / 2, y: to.y };
    }
    return points;
  }

  const lineOf = (n) => (n.location ? n.location.line + 1 : undefined);
  const pathsThrough = (n) => chart.paths.filter((p) => p.feasible && p.nodes.includes(n.id)).length;

  function render() {
    scene.textContent = '';
    touched = [];
    if (!chart) return;
    const edges = el('g', { class: 'edges' }, scene);
    layoutVersion++;
    edgeShapes = chart.edges.map((e) => edgePath(edgePoints(e)));
    chart.edges.forEach((e, i) => {
      const g = el('g', { class: `edge ${e.kind}${e.back ? ' back' : ''}`, 'data-edge': i }, edges);
      el('path', { d: edgeShapes[i], class: 'line', 'marker-end': 'url(#arrow)' }, g);
      // A wide invisible stroke makes the edge easy to click.
      el('path', { d: edgeShapes[i], class: 'hit' }, g);
      if (e.label) {
        const label = el('g', { class: 'edge-label', transform: `translate(${e.labelAt.x},${e.labelAt.y})` }, g);
        // Yes and no carry a mark as well as a color, so they read without color too.
        const mark = e.kind === 'true' ? 'check' : e.kind === 'false' ? 'close' : undefined;
        const width = e.label.length * 6.6 + 12 + (mark ? 14 : 0);
        el('rect', { x: -width / 2, y: -9, width, height: 18, rx: 9 }, label);
        if (mark) kit.icon(label, mark, -width / 2 + 11, 0, 'edge-mark');
        el('text', { 'text-anchor': 'middle', x: mark ? 7 : 0, y: 4 }, label).textContent = e.label;
        el('title', {}, label).textContent = 'Click to keep only the paths through this branch; right-click for more';
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
      const g = el('g', { class: `node ${n.kind}${n.unreachable ? ' unreachable' : ''}${n.location ? ' located' : ''}`, transform: `translate(${n.x},${n.y})`, 'data-node': n.id, tabindex: n.kind === 'start' ? 0 : -1, role: 'button', 'aria-haspopup': 'menu' }, nodes);
      g.setAttribute('aria-label', spoken(n));
      nodeShape(g, n);
      if (n.kind === 'start') {
        el('text', { x: n.width + 16, y: n.height / 2 + 5, class: 'title' }, g).textContent = `${chart.name}()`;
      } else if (n.kind === 'end') {
        el('text', { x: n.width + 14, y: n.height / 2 + 4, class: 'terminal-label' }, g).textContent = 'end';
      } else {
        const textX = isDecision(n) ? 26 : 13;
        n.lines.forEach((line, i) => codeLine(g, line, textX, 8 + 13 + i * 18));
        // Each kind carries an icon in its corner: ? for a decision, ↻ for a loop, ↩ for a return…
        const kindIcon = kindIcons[n.kind];
        if (kindIcon) kit.icon(g, kindIcon, isDecision(n) ? 13 : n.width - 11, isDecision(n) ? n.height / 2 : 11, `kind-icon ${n.kind}`);
        // The line it starts on, so the chart and the code are easy to match up.
        const line = lineOf(n);
        // It sits just above the box's top left corner, clear of the code and of the arrow coming in.
        if (line) el('text', { x: isDecision(n) && n.kind !== 'loop' ? 14 : 2, y: -4, class: 'line-badge' }, g).textContent = `L${line}`;
      }
      const tip = [`${kindWords[n.kind] || n.kind}${lineOf(n) ? `, line ${lineOf(n)}` : ''}`, n.unreachable ? 'Unreachable: nothing leads here' : '', isTerminal(n) ? '' : n.text]
        .filter(Boolean)
        .join('\n');
      el('title', {}, g).textContent = tip;
      if (n.calls && n.calls.length) {
        // Expand the called functions in place (or fold them back).
        const open = n.calls.every((c) => c.expanded);
        const names = [...new Set(n.calls.map((c) => c.name))].join(', ');
        const button = el('g', { class: 'expand', transform: `translate(${n.width - 2},${-2})`, role: 'button', tabindex: -1, 'aria-label': `${open ? 'Fold' : 'Expand'} the call to ${names}` }, g);
        el('rect', { x: -22, y: -8, width: 26, height: 16, rx: 8 }, button);
        el('text', { x: -9, y: 4, 'text-anchor': 'middle' }, button).textContent = open ? 'ƒ−' : 'ƒ+';
        el('title', {}, button).textContent = `${open ? 'Fold' : 'Expand'} ${names}() here`;
        button.dataset.keys = JSON.stringify(n.calls.map((c) => c.key));
        button.dataset.open = String(open);
      }
    }
    drawMinimap();
    highlight();
  }

  // What a screen reader says for a box.
  function spoken(n) {
    if (n.kind === 'start') return `Start of ${chart.name}`;
    if (n.kind === 'end') return 'End of the function';
    const parts = [`${kindWords[n.kind] || n.kind}: ${n.lines.join('; ')}`];
    if (lineOf(n)) parts.push(`line ${lineOf(n)}`);
    if (n.unreachable) parts.push('unreachable');
    if (n.calls && n.calls.length) parts.push('calls can be expanded');
    return parts.join(', ');
  }

  // The minimap: kinds in their colors, the boxes of the picked path lit up.
  const map = kit.minimap(document.getElementById('minimap'), svg, () => view, (v) => { view = v; apply(); });
  let minimapKey;
  function drawMinimap(on) {
    const key = `${layoutVersion}|${on ? [...on].sort((a, b) => a - b).join(',') : ''}`;
    if (key === minimapKey) return;
    minimapKey = key;
    if (!chart) return map.draw([]);
    map.draw(chart.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      w: n.width,
      h: n.height,
      round: isTerminal(n),
      kind: on && on.has(n.id) ? 'on' : isTerminal(n) ? 'terminal' : n.kind === 'loop' ? 'loop' : isDecision(n) ? 'decision' : 'plain',
    })));
  }

  // The paths that match the pinned branches and boxes, possible ones first.
  function matching() {
    return chart.paths.map((p, i) => ({ p, i })).filter(({ p }) => pins.every((e) => p.edges.includes(e)) && nodePins.every((n) => p.nodes.includes(n)) && (showImpossible || p.feasible));
  }

  const shortCode = (n) => (n.kind === 'start' ? `${chart.name}()` : n.kind === 'end' ? 'end' : n.lines[0].slice(0, 28));

  function chip(text, title, onClick, extra) {
    const button = document.createElement('button');
    button.className = `chip${extra ? ' ' + extra : ''}`;
    button.title = title;
    button.textContent = `${text} ✕`;
    button.addEventListener('click', onClick);
    pinsBar.appendChild(button);
  }

  function renderList() {
    list.textContent = '';
    if (!chart) return;
    const found = matching();
    const possible = chart.paths.filter((p) => p.feasible).length;
    const unreachable = chart.nodes.filter((n) => n.unreachable).length;
    summary.textContent = `${possible} possible path${possible === 1 ? '' : 's'}${chart.paths.length > possible ? `, ${chart.paths.length - possible} impossible` : ''}${chart.truncated ? ' (first ' + chart.paths.length + ' shown)' : ''}${unreachable ? `, ${unreachable} unreachable box${unreachable === 1 ? '' : 'es'}` : ''}`;
    pinsBar.textContent = '';
    if (slice) {
      chip(`${slice.direction === 'backward' ? '← What affects' : '→ What is affected by'} ${slice.name} (line ${slice.line}): ${slice.nodes.length} boxes`, 'Clear the slice', () => { slice = undefined; renderList(); highlight(); }, 'slice');
    }
    for (const e of pins) {
      const edge = chart.edges[e];
      chip(`${shortCode(chart.nodes[edge.from])} → ${edge.label}`, 'Remove this branch from the filter', () => { pins = pins.filter((x) => x !== e); afterPins(); });
    }
    for (const id of nodePins) {
      chip(`through ${shortCode(chart.nodes[id])}`, 'Remove this box from the filter', () => { nodePins = nodePins.filter((x) => x !== id); afterPins(); }, 'through');
    }
    // Paths that end the same way are grouped under that ending, folded, when there are several of them.
    const groups = new Map();
    for (const f of found) groups.set(f.p.ending, [...(groups.get(f.p.ending) || []), f]);
    const grouping = groups.size < found.length;
    let number = 0;
    const addPath = ({ p, i }, n, into, level) => {
      const item = document.createElement('li');
      item.className = `path${i === selected ? ' selected' : ''}${p.feasible ? '' : ' impossible'}`;
      item.tabIndex = i === selected || (selected < 0 && n === 0) ? 0 : -1;
      item.dataset.path = i;
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-level', String(level));
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
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose(e);
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = item.getBoundingClientRect();
          menu.open(pathMenu(i), r.left + 20, r.top + r.height / 2, item);
        }
      });
      // Hovering a path shows its route on the chart until the pointer leaves.
      item.addEventListener('mouseenter', () => { preview = i; highlight(); });
      item.addEventListener('mouseleave', () => { preview = -1; highlight(); });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu.open(pathMenu(i), e.clientX, e.clientY, item);
      });
      if (i === compared) item.classList.add('compared');
      into.appendChild(item);
    };
    for (const [ending, members] of groups) {
      if (!grouping || members.length < 2) {
        members.forEach((m) => addPath(m, number++, list, 1));
        continue;
      }
      const open = openGroups.has(ending) || members.some((m) => m.i === selected || m.i === compared);
      const head = document.createElement('li');
      head.className = 'path-group';
      head.tabIndex = -1;
      head.setAttribute('role', 'treeitem');
      head.setAttribute('aria-level', '1');
      head.setAttribute('aria-expanded', String(open));
      const chevron = document.createElement('i');
      chevron.className = `codicon codicon-chevron-${open ? 'down' : 'right'}`;
      chevron.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'path-title';
      title.textContent = ending;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${members.length} paths`;
      head.append(chevron, title, count);
      const toggle = () => {
        if (openGroups.has(ending)) openGroups.delete(ending);
        else openGroups.add(ending);
        renderList();
        const again = [...list.querySelectorAll('.path-group')].find((g) => g.querySelector('.path-title').textContent === ending);
        if (again) again.focus();
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
          e.preventDefault();
          toggle();
        }
      });
      // Hovering the group shows all of its paths at once.
      head.addEventListener('mouseenter', () => { previewGroup = members.map((m) => m.i); highlight(); });
      head.addEventListener('mouseleave', () => { previewGroup = undefined; highlight(); });
      list.appendChild(head);
      const inner = document.createElement('ul');
      inner.setAttribute('role', 'group');
      inner.hidden = !open;
      members.forEach((m) => addPath(m, number++, inner, 2));
      if (open) list.appendChild(inner);
    }
    if (!list.querySelector('[tabindex="0"]')) {
      const first = list.querySelector('li.path, li.path-group');
      if (first) first.tabIndex = 0;
    }
    renderComparison();
    if (!found.length) {
      const none = document.createElement('li');
      none.className = 'none';
      none.textContent = 'No possible path takes all these branches.';
      list.appendChild(none);
    }
  }

  // Up and down move between paths in the list.
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...list.querySelectorAll('li.path, li.path-group')];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const next = items[{ ArrowDown: Math.min(items.length - 1, at + 1), ArrowUp: Math.max(0, at - 1), Home: 0, End: items.length - 1 }[e.key]];
    items.forEach((li) => (li.tabIndex = -1));
    next.tabIndex = 0;
    next.focus();
  });

  // A path in words, for the clipboard.
  function pathText(i) {
    const p = chart.paths[i];
    return [`${chart.name}: ${p.ending}`, ...p.steps.map((s, n) => `${n + 1}. ${s.text}`), p.feasible ? '' : `Impossible: ${p.reason}`].filter(Boolean).join('\n');
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

  // The selected (or previewed) path lights up and the rest dims; pinned branches show the union of their paths.
  function highlight() {
    if (!chart) return;
    const onNodes = new Set();
    const onEdges = new Set();
    const shownPath = preview >= 0 ? preview : selected;
    const active = shownPath >= 0 ? [chart.paths[shownPath]] : previewGroup ? previewGroup.map((i) => chart.paths[i]) : pins.length || nodePins.length ? matching().map(({ p }) => p) : [];
    // A slice lights up its boxes, and the edges between them, when no path is picked.
    if (!active.length && slice) {
      const inSlice = new Set(slice.nodes);
      active.push({ nodes: slice.nodes, edges: chart.edges.map((e, i) => (inSlice.has(e.from) && inSlice.has(e.to) ? i : -1)).filter((i) => i >= 0) });
    }
    for (const p of active) {
      p.nodes.forEach((n) => onNodes.add(n));
      p.edges.forEach((e) => onEdges.add(e));
    }
    const other = compared >= 0 && selected >= 0 && preview < 0 ? chart.paths[compared] : undefined;
    const otherNodes = new Set(other ? other.nodes : []);
    const otherEdges = new Set(other ? other.edges : []);
    if (other) {
      other.nodes.forEach((n) => onNodes.add(n));
      other.edges.forEach((e) => onEdges.add(e));
    }
    const focus = active.length > 0;
    const found = new Set(matches);
    scene.querySelectorAll('.node').forEach((g) => {
      const id = Number(g.dataset.node);
      g.classList.toggle('on', focus && onNodes.has(id));
      g.classList.toggle('on2', otherNodes.has(id));
      g.classList.toggle('off', (focus && !onNodes.has(id)) || (!!query && !found.has(id)));
      g.classList.toggle('match', found.has(id));
      g.classList.toggle('current-match', matchAt >= 0 && matches[matchAt] === id);
      g.classList.toggle('cursor', id === cursorNode);
      g.classList.toggle('criterion', !!slice && id === slice.at);
      g.classList.toggle('through', nodePins.includes(id));
    });
    scene.querySelectorAll('.edge').forEach((g) => {
      const i = Number(g.dataset.edge);
      g.classList.toggle('on', focus && onEdges.has(i));
      g.classList.toggle('on2', otherEdges.has(i));
      g.classList.toggle('only2', otherEdges.has(i) && !(shownPath >= 0 && chart.paths[shownPath].edges.includes(i)));
      g.classList.toggle('off', (focus && !onEdges.has(i)) || !!query);
      g.classList.toggle('pinned', pins.includes(i));
    });
    drawMinimap(focus ? onNodes : undefined);
    drawFlows();
  }

  // Every line carries execution's pulses; a picked path, or the paths through a clicked box, narrow it to those.
  // A compared path keeps its own orange line.
  function drawFlows() {
    const lines = new Set();
    const elements = scene.querySelectorAll('.edge');
    if (prefs.flow && chart) {
      const shownPath = preview >= 0 ? preview : selected;
      if (shownPath >= 0) {
        chart.paths[shownPath].edges.forEach((e) => lines.add(e));
      } else if (previewGroup) {
        previewGroup.forEach((i) => chart.paths[i].edges.forEach((e) => lines.add(e)));
      } else if (flowing !== undefined) {
        // A clicked box: execution flowing through it, on every possible path that reaches it.
        for (const p of chart.paths) if (p.feasible && p.nodes.includes(flowing)) p.edges.forEach((e) => lines.add(e));
      } else {
        // Nothing picked: every line that isn't faded.
        elements.forEach((g, i) => { if (!g.classList.contains('off')) lines.add(i); });
      }
    }
    kit.drawFlows(scene, null, [...lines].filter((e) => elements[e]).map((e) => elements[e].querySelector('.line')));
  }

  function stopFlow() {
    flowing = undefined;
    highlight();
  }

  function animateFrom(n) {
    if (grid) grid.pulse(view.x + (n.x + n.width / 2) * view.k, view.y + (n.y + n.height / 2) * view.k);
    flowing = n.id;
    if (!prefs.flow) {
      prefs.flow = true;
      document.getElementById('flowToggle').setAttribute('aria-pressed', 'true');
      saveState();
    }
    highlight();
  }

  // The bar under the chart: the whole code of the hovered or focused box, where it is and how many paths pass it.
  function showInfo(n) {
    info.textContent = '';
    if (!chart) return;
    if (!n) {
      info.textContent = 'Hover a box for its code. Click opens it, right-click for more, double-click zooms to it.';
      return;
    }
    const head = document.createElement('strong');
    head.textContent = n.kind === 'start' ? `${chart.name}()` : n.kind === 'end' ? 'End' : `${kindWords[n.kind] || n.kind}${lineOf(n) ? ` · line ${lineOf(n)}` : ''}`;
    const facts = document.createElement('span');
    facts.className = 'facts';
    const through = pathsThrough(n);
    facts.textContent = n.unreachable ? 'unreachable' : `${through} possible path${through === 1 ? '' : 's'} through it`;
    info.append(head, facts);
    if (!isTerminal(n)) {
      const code = document.createElement('code');
      code.textContent = n.text.split('\n').slice(0, 3).join('  ⏎  ') + (n.text.split('\n').length > 3 ? '  …' : '');
      info.appendChild(code);
    }
  }

  // Clicks: a box opens its code; a branch label or line pins that branch; ƒ+ expands a call.
  const toggleCalls = (button) => vscode.postMessage({ type: 'expand', keys: JSON.parse(button.dataset.keys), expand: button.dataset.open !== 'true' });
  const nodeOf = (target) => {
    const g = target.closest && target.closest('.node');
    return g ? chart.nodes[Number(g.dataset.node)] : undefined;
  };
  const nodeEl = (n) => scene.querySelector(`.node[data-node="${n.id}"]`);
  function togglePin(i) {
    pins = pins.includes(i) ? pins.filter((x) => x !== i) : [...pins, i];
    afterPins();
  }
  function toggleThrough(n) {
    nodePins = nodePins.includes(n.id) ? nodePins.filter((x) => x !== n.id) : [...nodePins, n.id];
    if (panel.hidden) togglePanel(true);
    afterPins();
  }
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
      if (chart.edges[i].label) togglePin(i);
      return;
    }
    const n = nodeOf(e.target);
    if (n) {
      animateFrom(n);
      focus(n);
      open(n);
    }
  });
  scene.addEventListener('dblclick', (e) => {
    const n = nodeOf(e.target);
    if (n) zoomTo(n);
  });
  let touched = [];
  function touchEdges(n) {
    touched.forEach((g) => g.classList.remove('touch'));
    touched = [];
    if (!n) return;
    const elements = scene.querySelectorAll('.edge');
    chart.edges.forEach((e, i) => {
      if (e.from === n.id || e.to === n.id) touched.push(elements[i]);
    });
    touched.forEach((g) => g.classList.add('touch'));
  }
  scene.addEventListener('mouseover', (e) => {
    const n = nodeOf(e.target);
    if (n !== hovered) {
      hovered = n;
      touchEdges(n);
      showInfo(n || focusedNode);
      if (grid) grid.wake();
    }
  });
  scene.addEventListener('focusin', (e) => {
    const n = nodeOf(e.target);
    if (n) {
      focusedNode = n;
      showInfo(n);
    }
  });
  const open = (n) => n.location && vscode.postMessage({ type: 'open', location: n.location });

  // Keyboard: one tab stop for the chart; arrows follow the flow (down to what comes next, up to what came before,
  // left and right along the row), Enter opens, F animates, Shift+F10 opens the menu.
  function focus(n) {
    const g = nodeEl(n);
    if (!g) return;
    scene.querySelectorAll('.node[tabindex="0"]').forEach((x) => x.setAttribute('tabindex', '-1'));
    g.setAttribute('tabindex', '0');
    g.focus({ preventScroll: true });
    focusedNode = n;
    showInfo(n);
    ensureVisible(n);
  }
  function neighbor(n, key) {
    const centerX = (m) => m.x + m.width / 2;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const down = key === 'ArrowDown';
      const linked = chart.edges.filter((e) => !e.back && (down ? e.from === n.id : e.to === n.id)).map((e) => chart.nodes[down ? e.to : e.from]);
      return linked.sort((a, b) => Math.abs(centerX(a) - centerX(n)) - Math.abs(centerX(b) - centerX(n)))[0];
    }
    const right = key === 'ArrowRight';
    const row = chart.nodes.filter((m) => m !== n && Math.abs(m.y + m.height / 2 - (n.y + n.height / 2)) < Math.max(m.height, n.height) / 2 && (right ? m.x > n.x : m.x < n.x));
    return row.sort((a, b) => Math.abs(a.x - n.x) - Math.abs(b.x - n.x))[0];
  }
  function ensureVisible(n) {
    const w = svg.clientWidth;
    const h = svg.clientHeight;
    const left = view.x + n.x * view.k;
    const top = view.y + n.y * view.k;
    const right = left + n.width * view.k;
    const bottom = top + n.height * view.k;
    if (left >= 10 && top >= 10 && right <= w - 10 && bottom <= h - 10) return;
    centerOn(n);
  }
  function centerOn(n, k = view.k) {
    fitted = false;
    moveTo({ k, x: svg.clientWidth / 2 - (n.x + n.width / 2) * k, y: svg.clientHeight / 2 - (n.y + n.height / 2) * k });
  }
  function zoomTo(n) {
    centerOn(n, Math.max(view.k, 1.2));
  }
  scene.addEventListener('keydown', (e) => {
    const expand = e.target.closest('.expand');
    if (expand && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      toggleCalls(expand);
      return;
    }
    const n = nodeOf(e.target);
    if (!n) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(n);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = neighbor(n, e.key);
      if (next) focus(next);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = nodeEl(n).getBoundingClientRect();
      menu.open(boxMenuItems(n), r.left + 12, r.bottom - 4, nodeEl(n));
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      animateFrom(n);
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      toggleThrough(n);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focus(chart.nodes.find((m) => m.kind === 'start'));
    } else if (e.key === 'End') {
      e.preventDefault();
      focus(chart.nodes.find((m) => m.kind === 'end') || n);
    }
  });

  // Right-click menus: a box, a branch label, a path in the list, or the background.
  const menu = kit.menu(document.getElementById('boxMenu'));
  function boxMenuItems(n) {
    const items = [];
    if (n.location) items.push({ icon: 'go-to-file', label: 'Open Code', keys: 'Enter', run: () => open(n) });
    items.push(
      { icon: 'play-circle', label: 'Animate Paths Through Here', keys: 'F', run: () => animateFrom(n) },
      { icon: 'filter', label: nodePins.includes(n.id) ? 'Stop Filtering by This Box' : 'Only Paths Through Here', keys: 'T', run: () => toggleThrough(n) },
      { icon: 'zoom-in', label: 'Zoom to This Box', run: () => zoomTo(n) },
    );
    if (n.calls && n.calls.length) {
      const openCalls = n.calls.every((c) => c.expanded);
      const names = [...new Set(n.calls.map((c) => c.name))].join(', ');
      items.push({ icon: openCalls ? 'fold' : 'unfold', label: `${openCalls ? 'Fold' : 'Expand'} ${names}() Here`, run: () => vscode.postMessage({ type: 'expand', keys: n.calls.map((c) => c.key), expand: !openCalls }) });
    }
    if (n.location && !isTerminal(n)) {
      items.push(
        '-',
        { icon: 'arrow-left', label: 'What Affects This Box', run: () => vscode.postMessage({ type: 'sliceAt', location: n.location, direction: 'backward' }) },
        { icon: 'arrow-right', label: 'What This Box Affects', run: () => vscode.postMessage({ type: 'sliceAt', location: n.location, direction: 'forward' }) },
      );
      const main = analyses.filter((a) => !a.more);
      const more = analyses.filter((a) => a.more);
      const run = (a) => () => vscode.postMessage({ type: 'analyze', command: a.command, location: n.location });
      if (main.length) items.push('-', ...main.map((a) => ({ icon: a.icon, label: a.label, run: run(a) })));
      if (more.length) items.push({ heading: 'More analyses here' }, ...more.map((a) => ({ icon: a.icon, label: a.label, run: run(a) })));
    }
    if (!isTerminal(n)) items.push('-', { icon: 'copy', label: 'Copy Code', run: () => vscode.postMessage({ type: 'copy', text: n.text }) });
    if (n.location) items.push({ icon: 'location', label: 'Copy Location', run: () => vscode.postMessage({ type: 'copy', text: `${n.location.file}:${n.location.line + 1}:${n.location.character + 1}` }) });
    return items;
  }
  function edgeMenuItems(i) {
    const e = chart.edges[i];
    const items = [];
    if (e.label) items.push({ icon: 'filter', label: pins.includes(i) ? 'Stop Filtering by This Branch' : `Only Paths Taking “${e.label}”`, run: () => togglePin(i) });
    items.push(
      { icon: 'arrow-up', label: 'Go to Where It Comes From', run: () => focus(chart.nodes[e.from]) },
      { icon: 'arrow-down', label: 'Go to Where It Leads', run: () => focus(chart.nodes[e.to]) },
    );
    return items;
  }
  function pathMenu(i) {
    return [
      { icon: 'check', label: i === selected ? 'Unpick This Path' : 'Pick This Path', run: () => { compared = -1; select(i === selected ? -1 : i); } },
      ...(selected >= 0 && i !== selected ? [{ icon: 'diff', label: 'Compare with the Picked Path', keys: 'Shift+Click', run: () => { compared = i; renderList(); highlight(); } }] : []),
      { icon: 'copy', label: 'Copy Path as Text', run: () => vscode.postMessage({ type: 'copy', text: pathText(i) }) },
      { icon: 'markdown', label: 'Copy as Mermaid with This Path', run: () => vscode.postMessage({ type: 'mermaid', path: { nodes: chart.paths[i].nodes, edges: chart.paths[i].edges } }) },
    ];
  }
  function backgroundMenu() {
    const withCalls = chart.nodes.filter((n) => n.calls && n.calls.length);
    const folded = withCalls.flatMap((n) => n.calls.filter((c) => !c.expanded).map((c) => c.key));
    const unfolded = withCalls.flatMap((n) => n.calls.filter((c) => c.expanded).map((c) => c.key));
    const unreachable = chart.nodes.filter((n) => n.unreachable);
    return [
      { icon: 'screen-full', label: 'Fit the Whole Function', keys: '0', run: () => fit(true) },
      { icon: 'zoom-in', label: 'Actual Size', run: () => zoom(1 / view.k) },
      ...(cursorNode !== undefined ? [{ icon: 'target', label: 'Go to the Cursor Box', keys: 'C', run: () => focus(chart.nodes[cursorNode]) }] : []),
      ...(unreachable.length ? [{ icon: 'warning', label: `Go to Unreachable Code (${unreachable.length})`, run: () => nextUnreachable() }] : []),
      '-',
      ...(folded.length ? [{ icon: 'unfold', label: `Expand All Calls (${folded.length})`, run: () => vscode.postMessage({ type: 'expand', keys: folded, expand: true }) }] : []),
      ...(unfolded.length ? [{ icon: 'fold', label: 'Fold All Calls', run: () => vscode.postMessage({ type: 'expand', keys: unfolded, expand: false }) }] : []),
      { icon: 'list-tree', label: panel.hidden ? 'Show Path Explorer' : 'Hide Path Explorer', keys: 'P', run: () => togglePanel(panel.hidden) },
      { icon: 'map', label: map.hidden ? 'Show Minimap' : 'Hide Minimap', keys: 'M', run: () => toggleMinimap() },
      { icon: 'play-circle', label: 'Animate Every Path', run: () => animateFrom(chart.nodes.find((m) => m.kind === 'start')) },
      '-',
      { icon: 'markdown', label: 'Copy as Mermaid', run: () => copyMermaid() },
      { icon: 'save', label: 'Save as SVG', run: () => saveSvg() },
      { icon: 'file-media', label: 'Save as PNG', run: () => savePng() },
    ];
  }
  let unreachableAt = -1;
  function nextUnreachable() {
    const unreachable = chart.nodes.filter((n) => n.unreachable);
    if (!unreachable.length) return;
    unreachableAt = (unreachableAt + 1) % unreachable.length;
    focus(unreachable[unreachableAt]);
    centerOn(unreachable[unreachableAt]);
  }
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!chart) return;
    const n = nodeOf(e.target);
    const edge = e.target.closest('.edge');
    if (n) {
      focus(n);
      menu.open(boxMenuItems(n), e.clientX, e.clientY, nodeEl(n));
    } else if (edge) {
      menu.open(edgeMenuItems(Number(edge.dataset.edge)), e.clientX, e.clientY, svg);
    } else {
      menu.open(backgroundMenu(), e.clientX, e.clientY, svg);
    }
  });

  // Search: boxes whose code has the words light up, the rest fade; Enter goes to the next one.
  function search(text) {
    query = text.trim().toLowerCase();
    matches = query && chart ? chart.nodes.filter((n) => `${n.text} ${n.kind === 'start' ? chart.name : ''}`.toLowerCase().includes(query)).map((n) => n.id) : [];
    matchAt = matches.length ? 0 : -1;
    searchCount.textContent = query ? (matches.length ? `1 of ${matches.length}` : 'No match') : '';
    highlight();
    if (matches.length) centerOn(chart.nodes[matches[0]]);
  }
  function nextMatch(step) {
    if (!matches.length) return;
    matchAt = (matchAt + step + matches.length) % matches.length;
    searchCount.textContent = `${matchAt + 1} of ${matches.length}`;
    highlight();
    centerOn(chart.nodes[matches[matchAt]]);
  }
  searchBox.addEventListener('input', () => search(searchBox.value));
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.altKey && matches.length) focus(chart.nodes[matches[matchAt]]);
      else nextMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      searchBox.value = '';
      search('');
      const start = chart && chart.nodes.find((m) => m.kind === 'start');
      if (start) focus(start);
    }
  });

  // Pan by dragging, zoom with the wheel (Shift+wheel pans sideways), Fit to see it all.
  // Whether the view is as Fit left it, so resizing the tab fits again.
  let fitted = false;
  // Dragging and the wheel fire many events per frame: the view is redrawn once per frame.
  let applyFrame = 0;
  function applySoon() {
    if (!applyFrame) applyFrame = requestAnimationFrame(() => { applyFrame = 0; apply(); });
  }
  function apply() {
    view = kit.clampView(view, map.bounds, svg.clientWidth || 800, svg.clientHeight || 600);
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    kit.redrawFlows();
    if (grid) grid.wake();
    map.update();
    document.getElementById('zoomLevel').textContent = `${Math.round(view.k * 100)}%`;
    rememberView();
  }
  let rememberTimer;
  function rememberView() {
    clearTimeout(rememberTimer);
    rememberTimer = setTimeout(() => {
      if (!chart) return;
      views[keyOf()] = { ...view, at: Date.now() };
      Object.keys(views).sort((a, b) => views[b].at - views[a].at).slice(20).forEach((k) => delete views[k]);
      saveState();
    }, 400);
  }
  function fit(all) {
    if (!chart) return;
    const w = svg.clientWidth || 800;
    const h = svg.clientHeight || 600;
    let k = Math.min(1.2, (w - 40) / chart.width, (h - 40) / chart.height);
    let to;
    if (k < 0.55 && !all) {
      // Too small to read when it all fits: start at the top at a readable size, centered on the start circle.
      k = 0.85;
      const start = chart.nodes.find((n) => n.kind === 'start') || chart.nodes[0];
      to = { k, x: w / 2 - (start.x + start.width / 2) * k, y: 20 };
    } else {
      k = Math.max(0.2, k);
      to = { k, x: Math.max(20, (w - chart.width * k) / 2), y: 20 };
    }
    moveTo(to, !all);
    fitted = true;
  }
  /** Moves the view there: smoothly when the person asked, at once when a chart first opens. */
  function moveTo(to, atOnce) {
    if (atOnce) {
      view = to;
      apply();
    } else {
      kit.glide(view, to, (v) => { view = v; apply(); });
    }
  }
  function zoom(f, cx, cy) {
    fitted = false;
    const k = Math.min(3, Math.max(0.2, view.k * f));
    const px = cx ?? svg.clientWidth / 2;
    const py = cy ?? svg.clientHeight / 2;
    view = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    applySoon();
  }
  let drag;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.node') || e.target.closest('.edge')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y, startX: e.clientX, startY: e.clientY };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
    svg.focus({ preventScroll: true });
  });
  svg.addEventListener('pointermove', (e) => {
    if (grid) {
      const r = svg.getBoundingClientRect();
      grid.pointer({ x: e.clientX - r.left, y: e.clientY - r.top });
    }
    if (drag) { fitted = false; view.x = e.clientX - drag.x; view.y = e.clientY - drag.y; applySoon(); }
  });
  svg.addEventListener('pointerup', (e) => {
    // A click on the background, not a drag, stops the flowing lines.
    if (drag && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4 && flowing !== undefined) stopFlow();
    drag = undefined;
    svg.classList.remove('dragging');
  });
  svg.addEventListener('pointerleave', () => {
    if (grid) grid.pointer(undefined);
    hovered = undefined;
    touchEdges(undefined);
    showInfo(focusedNode);
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Shift+wheel moves the chart sideways.
      fitted = false;
      view.x -= e.deltaY || e.deltaX;
      applySoon();
      return;
    }
    const r = svg.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Export: Mermaid text is made by the extension; SVG and PNG are the chart as drawn, with its colors written in.
  function copyMermaid() {
    const path = selected >= 0 ? chart.paths[selected] : undefined;
    vscode.postMessage({ type: 'mermaid', path: path ? { nodes: path.nodes, edges: path.edges } : undefined });
  }
  const image = () => kit.exportSvg(svg, scene, ['.hit', '.expand']);
  function saveSvg() {
    if (chart) vscode.postMessage({ type: 'save', svg: image().text });
  }
  function savePng() {
    if (!chart) return;
    kit.toPng(image(), (png) => vscode.postMessage({ type: 'savePng', png }), () => vscode.postMessage({ type: 'error', text: 'The chart could not be drawn as a PNG. Save as SVG still works.' }));
  }
  function togglePanel(show) {
    panel.hidden = !show;
    document.getElementById('togglePaths').setAttribute('aria-pressed', String(show));
    saveState();
    if (grid) grid.wake();
    map.update();
  }
  function toCursor() {
    if (chart && cursorNode !== undefined && chart.nodes[cursorNode]) focus(chart.nodes[cursorNode]);
  }
  document.getElementById('mermaid').addEventListener('click', copyMermaid);
  document.getElementById('save').addEventListener('click', saveSvg);
  document.getElementById('savePng').addEventListener('click', savePng);
  document.getElementById('zoomIn').addEventListener('click', () => zoom(1.2));
  document.getElementById('zoomOut').addEventListener('click', () => zoom(1 / 1.2));
  const zoomButton = document.getElementById('zoomLevel');
  zoomButton.addEventListener('click', () => kit.zoomPresets(menu, zoomButton, view.k, (k) => zoom(k / view.k), () => fit(true)));
  // Double-clicking the background fits; arrow keys pan while the background has the focus.
  svg.addEventListener('dblclick', (e) => {
    if (!nodeOf(e.target) && !e.target.closest('.edge')) fit(true);
  });
  svg.addEventListener('keydown', (e) => {
    if (e.target === svg) kit.panKey(e, (dx, dy) => { fitted = false; view = { k: view.k, x: view.x + dx, y: view.y + dy }; apply(); });
  });
  // The minimap can be hidden (M); the choice is kept.
  map.hidden = prefs.minimap === false;
  function toggleMinimap() {
    map.hidden = !map.hidden;
    prefs.minimap = !map.hidden;
    saveState();
  }
  kit.refitOnResize(svg, () => fitted, () => fit(true));
  document.getElementById('fit').addEventListener('click', () => fit(true));
  document.getElementById('toCursor').addEventListener('click', toCursor);
  document.getElementById('togglePaths').addEventListener('click', () => togglePanel(panel.hidden));
  document.getElementById('clearPins').addEventListener('click', () => { pins = []; nodePins = []; selected = -1; afterPins(); });
  legendButton.addEventListener('click', () => {
    legend.hidden = !legend.hidden;
    legendButton.setAttribute('aria-expanded', String(!legend.hidden));
    legendButton.setAttribute('aria-pressed', String(!legend.hidden));
  });
  const impossibleBox = document.getElementById('showImpossible');
  impossibleBox.checked = showImpossible;
  impossibleBox.addEventListener('change', () => {
    showImpossible = impossibleBox.checked;
    state.showImpossible = showImpossible;
    vscode.setState(state);
    afterPins();
  });
  if (state.explorer === false) togglePanel(false);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchBox.focus();
      searchBox.select();
      return;
    }
    if (e.target instanceof HTMLInputElement || menu.isOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoom(1.2);
    else if (e.key === '-') zoom(1 / 1.2);
    else if (e.key === '0') fit(true);
    else if (e.key === 'c' || e.key === 'C') toCursor();
    else if (e.key === 'p' || e.key === 'P') togglePanel(panel.hidden);
    else if (e.key === 'm' || e.key === 'M') toggleMinimap();
    else if (e.key === 'Escape') {
      if (!legend.hidden) {
        legend.hidden = true;
        legendButton.setAttribute('aria-expanded', 'false');
        legendButton.setAttribute('aria-pressed', 'false');
        return;
      }
      pins = [];
      nodePins = [];
      compared = -1;
      flowing = undefined;
      select(-1);
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'chart') {
      slice = undefined;
      flowing = undefined;
      preview = -1;
      if (message.analyses) analyses = message.analyses;
      const same = chart && message.chart && chart.name === message.chart.name && chart.file === message.chart.file;
      chart = message.chart;
      empty.hidden = !!chart;
      svg.classList.toggle('off', !chart);
      if (!same) {
        pins = [];
        nodePins = [];
        selected = -1;
        focusedNode = undefined;
      } else {
        // After an edit, keep what was picked if it still exists.
        pins = pins.filter((e) => e < chart.edges.length);
        nodePins = nodePins.filter((n) => n < chart.nodes.length);
        if (selected >= chart.paths.length) selected = -1;
        if (compared >= chart.paths.length) compared = -1;
        focusedNode = focusedNode && chart.nodes[focusedNode.id];
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
      if (query) search(searchBox.value);
      render();
      renderList();
      showInfo(focusedNode);
      if (!same) {
        // Back where it was the last time this function was open, or fitted.
        const remembered = chart && views[keyOf()];
        if (remembered) {
          view = { x: remembered.x, y: remembered.y, k: remembered.k };
          apply();
        } else fit();
      } else apply();
    } else if (message.type === 'slice') {
      slice = message.slice;
      selected = -1;
      pins = [];
      nodePins = [];
      renderList();
      highlight();
    } else if (message.type === 'cursor') {
      cursorNode = message.id;
      highlight();
    }
  });
  // The grid behind the chart: every box bends it, the hovered one pushes further.
  const onScreen = (n) => ({ x: view.x + n.x * view.k, y: view.y + n.y * view.k, w: n.width * view.k, h: n.height * view.k });
  grid = window.diagramGrid.create(document.getElementById('grid'), () => ({
    panX: view.x,
    panY: view.y,
    k: view.k,
    version: layoutVersion,
    get boxes() {
      return chart ? chart.nodes.map(onScreen) : [];
    },
    hovered: hovered ? onScreen(hovered) : undefined,
  }));
  kit.attachFlowLines(document.getElementById('flowLines'), () => view);
  kit.bindToggles(prefs, grid, saveState, stopFlow);
  vscode.postMessage({ type: 'ready' });
})();
