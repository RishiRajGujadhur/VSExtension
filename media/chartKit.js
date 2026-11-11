// Shared by the analysis diagram and the Control Flow view: SVG elements, flowing lines, export as a standalone SVG,
// and the Grid and Flow toggles with their remembered setting.
//
// The flowing lines (attachFlowLines) are adapted from the node grid of robot-components
// (https://github.com/dashrobotco/robot-components, app/nodegrid/page.tsx). MIT License, Copyright (c) 2026 Robot FZCO;
// the full notice is in THIRD_PARTY_NOTICES.md.
(function () {
  const svgNs = 'http://www.w3.org/2000/svg';

  /** An SVG element with attributes, added to `parent` when given. */
  function el(name, attrs, parent) {
    const node = document.createElementNS(svgNs, name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  }

  /**
   * Flowing lines, drawn on a canvas under the chart the way robot-components' node grid draws its connections
   * (MIT): each line is a blue wire with soft cyan pulses travelling along it, in the direction the value or execution
   * goes. Canvas rather than SVG: the chart's own drawing doesn't repaint on every frame, and only lines in the window
   * are drawn. `attachFlowLines` is called once per page; `drawFlows` sets which lines carry the flow.
   */
  const WIRE = '#3B82F6';
  const PULSE_SPEED = 0.12; // screen pixels per millisecond
  const PULSE_SPACING = 100; // screen pixels between pulses
  const PULSE_WIDTH = 60; // screen pixels each pulse fades over
  const LEVELS = 8;
  let flowLines;
  function attachFlowLines(canvas, getView) {
    const ctx = canvas.getContext('2d');
    // A hidden path measures each line's shape once; the samples are kept by path data.
    const ruler = el('svg', { width: 0, height: 0, style: 'position:absolute;width:0;height:0;overflow:hidden', 'aria-hidden': 'true' });
    document.body.appendChild(ruler);
    const probe = el('path', {}, ruler);
    const samples = new Map();
    let lines = [];
    let frame = 0;
    let width = 0;
    let height = 0;
    let scale = 1;
    const motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    function sample(d) {
      let s = samples.get(d);
      if (s) return s;
      if (samples.size > 4000) samples.clear();
      probe.setAttribute('d', d);
      const length = probe.getTotalLength();
      const n = Math.max(2, Math.ceil(length / 6));
      const xs = new Float32Array(n + 1);
      const ys = new Float32Array(n + 1);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i <= n; i++) {
        const p = probe.getPointAtLength((length * i) / n);
        xs[i] = p.x;
        ys[i] = p.y;
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      s = { xs, ys, step: length / n, n, box: { x0, y0, x1, y1 } };
      samples.set(d, s);
      return s;
    }
    function fit() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (w === width && h === height && ratio === scale) return;
      width = w;
      height = h;
      scale = ratio;
      canvas.width = Math.max(1, Math.round(w * ratio));
      canvas.height = Math.max(1, Math.round(h * ratio));
    }
    function draw(now) {
      frame = 0;
      fit();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!lines.length) return;
      const v = getView();
      const k = v.k;
      ctx.setTransform(scale * k, 0, 0, scale * k, scale * v.x, scale * v.y);
      const margin = 20 / k;
      const vx0 = -v.x / k - margin, vy0 = -v.y / k - margin, vx1 = (width - v.x) / k + margin, vy1 = (height - v.y) / k + margin;
      const still = motion.matches;
      const spacing = PULSE_SPACING / k;
      const reach = PULSE_WIDTH / k;
      const at = still ? 0 : ((now * PULSE_SPEED) / k) % spacing;
      const solid = new Path2D();
      const dashed = new Path2D();
      const lit = Array.from({ length: LEVELS }, () => new Path2D());
      for (const line of lines) {
        const s = line.s;
        if (s.box.x1 < vx0 || s.box.x0 > vx1 || s.box.y1 < vy0 || s.box.y0 > vy1) continue;
        const wire = line.dashed ? dashed : solid;
        wire.moveTo(s.xs[0], s.ys[0]);
        for (let i = 1; i <= s.n; i++) wire.lineTo(s.xs[i], s.ys[i]);
        if (still) continue;
        // Brightness of each piece: its distance to the nearest pulse, with a cosine falloff.
        for (let i = 0; i < s.n; i++) {
          const mid = (i + 0.5) * s.step;
          const offset = (((mid - at) % spacing) + spacing) % spacing;
          const dist = Math.min(offset, spacing - offset);
          if (dist >= reach) continue;
          const b = (Math.cos((dist / reach) * Math.PI) + 1) / 2;
          if (b <= 0.02) continue;
          const path = lit[Math.min(LEVELS - 1, Math.floor(b * LEVELS))];
          path.moveTo(s.xs[i], s.ys[i]);
          path.lineTo(s.xs[i + 1], s.ys[i + 1]);
        }
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = WIRE;
      ctx.lineWidth = 2 / k;
      ctx.stroke(solid);
      ctx.setLineDash([5 / k, 4 / k]);
      ctx.stroke(dashed);
      ctx.setLineDash([]);
      lit.forEach((path, level) => {
        const b = (level + 0.5) / LEVELS;
        ctx.strokeStyle = `rgba(0, 200, 255, ${b * 0.9})`;
        ctx.lineWidth = (2 + b * 1.5) / k;
        ctx.stroke(path);
      });
      ctx.globalAlpha = 1;
      if (!still && !document.hidden) frame = requestAnimationFrame(draw);
    }
    function redraw() {
      if (!frame) frame = requestAnimationFrame(draw);
    }
    document.addEventListener('visibilitychange', redraw);
    motion.addEventListener && motion.addEventListener('change', redraw);
    new ResizeObserver(redraw).observe(canvas);
    flowLines = {
      set(items) {
        lines = items.map((item) => ({ s: sample(item.d), dashed: !!item.dashed }));
        redraw();
      },
      redraw,
    };
    return flowLines;
  }

  /**
   * Sets the lines that carry the flow: SVG path elements (a `back` class draws them dashed). Their own SVG stroke
   * steps aside for the canvas wire; arrowheads stay. Rings around circles turn while any line flows.
   */
  let carried = [];
  function drawFlows(scene, before, paths) {
    carried.forEach((p) => p.classList.remove('carried'));
    carried = paths.filter((p) => typeof p !== 'string');
    carried.forEach((p) => p.classList.add('carried'));
    if (scene.ownerSVGElement) scene.ownerSVGElement.classList.toggle('flowing', paths.length > 0);
    if (flowLines) {
      flowLines.set(paths.map((p) => (typeof p === 'string' ? { d: p } : { d: p.getAttribute('d'), dashed: !!p.closest('.back') })));
    }
  }
  /** The view moved: the canvas lines follow (needed only when they don't animate). */
  const redrawFlows = () => flowLines && flowLines.redraw();

  /**
   * The chart as a standalone SVG: the theme's colors written into each element, the background filled, and the
   * given parts (flowing lines, click targets…) left out. Returns the text and its size.
   */
  function exportSvg(svg, scene, leaveOut, adjust) {
    const box = scene.getBBox();
    const pad = 24;
    const copy = svg.cloneNode(true);
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing'];
    const originals = svg.querySelectorAll('*');
    copy.querySelectorAll('*').forEach((node, i) => {
      const style = getComputedStyle(originals[i]);
      node.setAttribute('style', props.map((p) => `${p}:${style.getPropertyValue(p)}`).join(';'));
      node.removeAttribute('data-vscode-context');
      node.removeAttribute('tabindex');
    });
    copy.querySelectorAll(['.flows', 'title', '.glyph-icon', ...(leaveOut || [])].join(',')).forEach((node) => node.remove());
    if (adjust) adjust(copy);
    copy.removeAttribute('class');
    copy.removeAttribute('role');
    copy.setAttribute('xmlns', svgNs);
    copy.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.width + 2 * pad} ${box.height + 2 * pad}`);
    copy.setAttribute('width', String(Math.ceil(box.width + 2 * pad)));
    copy.setAttribute('height', String(Math.ceil(box.height + 2 * pad)));
    const inner = copy.querySelector('#scene');
    inner.removeAttribute('transform');
    copy.insertBefore(el('rect', { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, fill: getComputedStyle(document.body).backgroundColor }), inner);
    return { text: new XMLSerializer().serializeToString(copy), width: box.width + 2 * pad, height: box.height + 2 * pad };
  }

  /**
   * The Grid and Flow buttons: pressed state, the grid shown or hidden, and the choice saved with the page's state.
   * `onFlowOff` stops a running animation when Flow is turned off.
   */
  function bindToggles(prefs, grid, save, onFlowOff) {
    const effects = document.getElementById('effects');
    const flow = document.getElementById('flowToggle');
    const show = () => {
      effects.setAttribute('aria-pressed', String(prefs.effects));
      flow.setAttribute('aria-pressed', String(prefs.flow));
      grid.setEnabled(prefs.effects);
    };
    effects.addEventListener('click', () => { prefs.effects = !prefs.effects; show(); save(); });
    flow.addEventListener('click', () => {
      prefs.flow = !prefs.flow;
      onFlowOff();
      show();
      save();
    });
    show();
  }

  /**
   * The character of a codicon, read from VS Code's icon font stylesheet, so SVG text can draw the same icons as the
   * rest of VS Code (with the `glyph-icon` class, which sets the font).
   */
  const glyphs = new Map();
  function glyph(name) {
    if (!glyphs.has(name)) {
      const probe = document.createElement('i');
      probe.className = `codicon codicon-${name}`;
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);
      const content = getComputedStyle(probe, '::before').content;
      probe.remove();
      glyphs.set(name, content && content !== 'none' ? content.replace(/^["']|["']$/g, '') : '');
    }
    return glyphs.get(name);
  }

  /**
   * The ring around a circle while lines flow: two arcs, one round each side, from where the flow enters the circle
   * to where it leaves. They are drawn by the flowing-lines canvas, so they look and move exactly like the lines.
   * Angles are in degrees (0 is right, 90 is down).
   */
  function ringPaths(cx, cy, r, fromDegrees, toDegrees) {
    const at = (deg) => ({ x: cx + r * Math.cos((deg * Math.PI) / 180), y: cy + r * Math.sin((deg * Math.PI) / 180) });
    const a = at(fromDegrees);
    const b = at(toDegrees);
    // Path data in chart coordinates, for drawFlows: the canvas draws them like any flowing line.
    return [1, 0].map((sweep) => `M${a.x},${a.y} A${r},${r} 0 0 ${sweep} ${b.x},${b.y}`);
  }

  /** An icon drawn in SVG at (x, y), its center; nothing when the icon is unknown. */
  function icon(parent, name, x, y, className) {
    const char = glyph(name);
    if (!char) return undefined;
    const text = el('text', { x, y, class: `glyph-icon${className ? ' ' + className : ''}`, 'aria-hidden': 'true' }, parent);
    text.textContent = char;
    return text;
  }

  /**
   * A right-click menu drawn by the page, so it can show icons; it works like a menu from the keyboard too (the
   * WAI-ARIA menu pattern). Items are '-' for a separator, { heading } or { icon, label, keys, run }.
   * A search field at the top filters the items as you type (Enter runs the first match, Escape clears it, then
   * closes); the actions used last come first under "Recent"; `footer` is a line of context at the bottom, such
   * as "Line 42 · cart.ts · 3 paths through".
   */
  const recentKey = 'chartKit.recentActions';
  function recentLabels() {
    try {
      const list = JSON.parse(localStorage.getItem(recentKey) || '[]');
      return Array.isArray(list) ? list.filter((l) => typeof l === 'string') : [];
    } catch {
      return [];
    }
  }
  function rememberAction(label) {
    try {
      localStorage.setItem(recentKey, JSON.stringify([label, ...recentLabels().filter((l) => l !== label)].slice(0, 5)));
    } catch {
      // Without storage there is simply no Recent group.
    }
  }
  function menu(element) {
    let returnTo;
    let entries = [];
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'menu-search';
    search.placeholder = 'Search actions…';
    search.setAttribute('aria-label', 'Search actions');
    search.spellcheck = false;
    const searchRow = document.createElement('div');
    searchRow.className = 'menu-search-row';
    const searchIcon = document.createElement('i');
    searchIcon.className = 'codicon codicon-search';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchRow.append(searchIcon, search);
    const list = document.createElement('div');
    list.className = 'menu-list';
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-label', 'Actions');
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No action matches';
    const footer = document.createElement('div');
    footer.className = 'menu-footer';

    function close(refocus) {
      if (element.hidden) return;
      element.hidden = true;
      if (refocus && returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
    }
    function button(item) {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      const i = document.createElement('i');
      i.className = `codicon codicon-${item.icon || 'blank'}`;
      i.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;
      b.append(i, label);
      if (item.keys) {
        const keys = document.createElement('kbd');
        keys.className = 'menu-keys';
        keys.textContent = item.keys;
        b.appendChild(keys);
      }
      b.addEventListener('click', () => {
        close(false);
        rememberAction(item.label);
        item.run();
      });
      return b;
    }
    const words = (text) => text.toLowerCase().split(/\s+/).filter(Boolean);
    // Every word typed is found in the label (or its shortcut), in any order: "dep sho" finds Show Its Dependences.
    const matches = (item, query) => words(query).every((w) => `${item.label} ${item.keys || ''}`.toLowerCase().includes(w));
    function fill() {
      list.textContent = '';
      const query = search.value.trim();
      const actions = entries.filter((item) => item !== '-' && !item.heading);
      let shown;
      if (query) {
        shown = actions.filter((item) => matches(item, query));
      } else {
        const recent = recentLabels().map((l) => actions.find((a) => a.label === l)).filter(Boolean).slice(0, 3);
        // A short menu needs no Recent group: everything is in view already.
        shown = recent.length && actions.length > 6 ? [{ heading: 'Recent' }, ...recent, '-', ...entries] : entries;
      }
      const tidy = shown.filter((item, i, all) => item !== '-' || (i > 0 && i < all.length - 1 && all[i - 1] !== '-' && !all[i - 1].heading));
      for (const item of tidy) {
        if (item === '-') {
          list.appendChild(Object.assign(document.createElement('div'), { className: 'separator', role: 'separator' }));
        } else if (item.heading) {
          const heading = document.createElement('div');
          heading.className = 'menu-heading';
          heading.setAttribute('role', 'presentation');
          heading.textContent = item.heading;
          list.appendChild(heading);
        } else {
          list.appendChild(button(item));
        }
      }
      empty.hidden = !!list.querySelector('[role="menuitem"]');
      const first = list.querySelector('[role="menuitem"]');
      list.querySelectorAll('.first-match').forEach((b) => b.classList.remove('first-match'));
      if (query && first) first.classList.add('first-match');
    }
    function open(items, x, y, from, context) {
      returnTo = from;
      entries = items;
      // A menu covers the hover card's place: the card closes (a pinned one stays).
      openCards.forEach((c) => c.hide());
      if (!items.some((item) => item !== '-' && !item.heading)) return;
      element.textContent = '';
      search.value = '';
      footer.textContent = context || '';
      footer.hidden = !context;
      element.append(searchRow, list, empty, footer);
      fill();
      element.hidden = false;
      // Kept inside the window.
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      element.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
      search.focus();
    }
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll('[role="menuitem"]')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) items[e.key === 'ArrowDown' ? 0 : items.length - 1].focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items.length) items[0].click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (search.value) {
          search.value = '';
          fill();
        } else close(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        close(true);
      }
    });
    list.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll('[role="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
      if (move !== undefined) {
        e.preventDefault();
        // Up from the first item goes back to the search field.
        if (move < 0) search.focus();
        else items[move % items.length].focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Typing on an item searches: the letter goes into the search field.
        search.focus();
      } else if (e.key === 'Backspace') {
        search.focus();
      }
    });
    element.addEventListener('focusout', (e) => { if (!element.contains(e.relatedTarget)) close(false); });
    window.addEventListener('pointerdown', (e) => { if (!element.contains(e.target)) close(false); }, true);
    window.addEventListener('blur', () => close(false));
    return { open, close, get isOpen() { return !element.hidden; } };
  }

  /**
   * The minimap: the whole chart in the corner with the visible part outlined, shown only when the chart is bigger
   * than the window. Click or drag in it to move there. `getView` and `setView` read and move the chart's view
   * ({ x, y, k }); `draw` takes the boxes as { x, y, w, h, kind, round }, one path per kind.
   */
  function minimap(map, svg, getView, setView) {
    const scene = map.querySelector('.mini-scene') || map.querySelector('g');
    const frame = map.querySelector('rect');
    let bounds;
    // Hidden by the person (M, or the background menu), whatever the chart's size.
    let off = false;
    function draw(boxes, pad = 20) {
      scene.textContent = '';
      bounds = undefined;
      if (!boxes.length) {
        update();
        return;
      }
      const left = Math.min(...boxes.map((b) => b.x)) - pad;
      const top = Math.min(...boxes.map((b) => b.y)) - pad;
      const right = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
      const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
      bounds = { x: left, y: top, w: right - left, h: bottom - top };
      map.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
      const shapes = {};
      for (const b of boxes) {
        const r = b.round ? Math.min(b.w, b.h) / 2 : 0;
        const d = r
          ? `M${b.x + r},${b.y}h${b.w - 2 * r}a${r},${r} 0 0 1 0,${b.h}h${-(b.w - 2 * r)}a${r},${r} 0 0 1 0,${-b.h}z`
          : `M${b.x},${b.y}h${b.w}v${b.h}h${-b.w}z`;
        (shapes[b.kind || 'plain'] = shapes[b.kind || 'plain'] || []).push(d);
      }
      for (const [kind, parts] of Object.entries(shapes)) el('path', { d: parts.join(''), class: `mini ${kind}` }, scene);
      update();
    }
    function update() {
      if (!bounds) {
        map.classList.add('off');
        return;
      }
      const view = getView();
      const vx = -view.x / view.k;
      const vy = -view.y / view.k;
      const vw = svg.clientWidth / view.k;
      const vh = svg.clientHeight / view.k;
      frame.setAttribute('x', vx);
      frame.setAttribute('y', vy);
      frame.setAttribute('width', vw);
      frame.setAttribute('height', vh);
      const fits = vx <= bounds.x && vy <= bounds.y && vx + vw >= bounds.x + bounds.w && vy + vh >= bounds.y + bounds.h;
      map.classList.toggle('off', fits || off);
    }
    let dragging = false;
    const moveTo = (e) => {
      const point = map.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const at = point.matrixTransform(map.getScreenCTM().inverse());
      const k = getView().k;
      setView({ k, x: svg.clientWidth / 2 - at.x * k, y: svg.clientHeight / 2 - at.y * k });
    };
    map.addEventListener('pointerdown', (e) => { dragging = true; map.setPointerCapture(e.pointerId); moveTo(e); });
    map.addEventListener('pointermove', (e) => { if (dragging) moveTo(e); });
    map.addEventListener('pointerup', () => { dragging = false; });
    window.addEventListener('resize', update);
    return {
      draw,
      update,
      get bounds() { return bounds; },
      get hidden() { return off; },
      set hidden(value) { off = !!value; update(); },
    };
  }

  /** An exported SVG (from exportSvg) drawn at twice its size as a PNG, given to `done` as base64. */
  function toPng(image, done, fail) {
    const picture = new Image();
    picture.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(image.width * scale);
      canvas.height = Math.ceil(image.height * scale);
      const context = canvas.getContext('2d');
      context.scale(scale, scale);
      context.drawImage(picture, 0, 0, image.width, image.height);
      done(canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));
    };
    picture.onerror = fail;
    picture.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(image.text);
  }

  /**
   * A view moved back so that at least `margin` pixels of the chart stay in the window: dragging or zooming can
   * not lose the chart off the side. `bounds` is the chart's box ({ x, y, w, h }) in chart units.
   */
  function clampView(view, bounds, width, height, margin = 80) {
    if (!bounds) return view;
    const left = bounds.x * view.k;
    const right = (bounds.x + bounds.w) * view.k;
    const top = bounds.y * view.k;
    const bottom = (bounds.y + bounds.h) * view.k;
    const m = Math.min(margin, width / 2, height / 2);
    // The chart's right edge stays right of the margin, its left edge left of the far margin; same up and down.
    const x = Math.min(Math.max(view.x, m - right), width - m - left);
    const y = Math.min(Math.max(view.y, m - bottom), height - m - top);
    return { k: view.k, x, y };
  }

  /**
   * Moves the view smoothly to `to` over a fifth of a second (at once when the system asks for reduced motion),
   * calling `set` with each step. Returns a function that stops it.
   */
  const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: true };
  let moving;
  function glide(from, to, set) {
    cancelAnimationFrame(moving);
    if (reduced.matches) {
      set(to);
      return;
    }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 200);
      const e = 1 - Math.pow(1 - t, 3);
      set({ k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      if (t < 1) moving = requestAnimationFrame(step);
    };
    moving = requestAnimationFrame(step);
  }

  /** The zoom presets menu, opened from the zoom level button. */
  function zoomPresets(menuControl, button, current, zoomTo, fit) {
    const r = button.getBoundingClientRect();
    const levels = [0.5, 0.75, 1, 1.5, 2];
    menuControl.open(
      [
        ...levels.map((k) => ({ icon: Math.abs(current - k) < 0.01 ? 'check' : 'blank', label: `${k * 100}%`, run: () => zoomTo(k) })),
        '-',
        { icon: 'screen-full', label: 'Fit', keys: '0', run: fit },
      ],
      r.left,
      r.bottom + 2,
      button,
    );
  }

  /** Arrow keys pan the chart by a step when the background (not a box) has the focus; Shift moves further. */
  function panKey(e, pan) {
    const step = e.shiftKey ? 240 : 60;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[e.key];
    if (!move) return false;
    e.preventDefault();
    pan(move[0], move[1]);
    return true;
  }

  /** Calls `refit` when the chart area changes size while the chart is still as Fit left it. */
  function refitOnResize(element, isFitted, refit) {
    let last = `${element.clientWidth}x${element.clientHeight}`;
    let timer;
    new ResizeObserver(() => {
      const size = `${element.clientWidth}x${element.clientHeight}`;
      if (size === last) return;
      last = size;
      clearTimeout(timer);
      timer = setTimeout(() => { if (isFitted()) refit(); }, 80);
    }).observe(element);
  }

  /**
   * A graph's options in the toolbar: "Levels − 3 +" for how deep it goes, and a row of pressed buttons for a choice
   * such as Callers / Both / Callees. `onChange(id, value)` runs the graph again with the new value.
   */
  function renderControls(container, controls, onChange) {
    container.textContent = '';
    container.hidden = !controls || !controls.length;
    for (const c of controls || []) {
      const group = document.createElement('span');
      group.className = 'control';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', c.label);
      group.title = c.description;
      const label = document.createElement('span');
      label.className = 'control-label';
      label.textContent = c.label;
      group.appendChild(label);
      if (c.kind === 'levels') {
        const step = (delta, text, name) => {
          const b = document.createElement('button');
          b.className = 'icon step';
          b.type = 'button';
          b.textContent = text;
          b.setAttribute('aria-label', `${name} ${c.label.toLowerCase()}`);
          b.title = `${name} (${c.label}: ${c.value})`;
          const next = Number(c.value) + delta;
          b.disabled = next < (c.min ?? 1) || next > (c.max ?? 9);
          b.addEventListener('click', () => onChange(c.id, next));
          return b;
        };
        const value = document.createElement('output');
        value.className = 'control-value';
        value.textContent = String(c.value);
        value.setAttribute('aria-live', 'polite');
        group.append(step(-1, '−', 'Fewer'), value, step(1, '+', 'More'));
      } else {
        for (const choice of c.choices || []) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'choice';
          b.textContent = choice.label;
          b.setAttribute('aria-pressed', String(choice.id === c.value));
          b.addEventListener('click', () => choice.id !== c.value && onChange(c.id, choice.id));
          group.appendChild(b);
        }
      }
      container.appendChild(group);
    }
  }

  /** Code as HTML with light syntax coloring: keywords, strings, numbers and called functions. */
  const keywordSet = new Set('if else return let const var new typeof instanceof switch case default for of in while do throw catch finally try await async break continue true false null undefined this void delete yield function class import export from as interface type extends implements'.split(' '));
  function highlightCode(text) {
    const out = document.createDocumentFragment();
    const pattern = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\b\d[\d_.]*\b|[A-Za-z_$][\w$]*|\s+|.)/g;
    let match;
    while ((match = pattern.exec(text))) {
      const token = match[0];
      const cls = /^['"`]/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : keywordSet.has(token) ? 'keyword' : /^[A-Za-z_$]/.test(token) && text[pattern.lastIndex] === '(' ? 'call' : '';
      if (!cls) {
        out.append(token);
        continue;
      }
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = token;
      out.append(span);
    }
    return out;
  }

  /**
   * The hover card of a chart's boxes: what the box is, where, its code, facts about it and the keys that act on it.
   * It opens a moment after the pointer rests on a box (at once on keyboard focus), stays while the pointer is on
   * it, and its pin keeps it open to compare boxes. Escape closes it.
   * Content: { icon, title, meta, code, facts: [[label, value]], keys: [[key, what]], note }.
   */
  const openCards = [];
  function hoverCard() {
    const card = document.createElement('div');
    card.className = 'hover-card';
    card.id = 'hoverCard';
    card.setAttribute('role', 'tooltip');
    card.hidden = true;
    document.body.appendChild(card);
    let timer;
    let pinned = false;
    let anchor;
    let shownFor;
    const iconEl = (name) => {
      const i = document.createElement('i');
      i.className = `codicon codicon-${name}`;
      i.setAttribute('aria-hidden', 'true');
      return i;
    };
    function render(c) {
      card.textContent = '';
      const head = document.createElement('div');
      head.className = 'card-head';
      if (c.icon) head.append(iconEl(c.icon));
      const title = document.createElement('strong');
      title.textContent = c.title;
      head.append(title);
      if (c.meta) {
        const meta = document.createElement('span');
        meta.className = 'card-meta';
        meta.textContent = c.meta;
        head.append(meta);
      }
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'card-pin';
      pin.title = pinned ? 'Unpin (Escape closes)' : 'Pin: keep this card open';
      pin.setAttribute('aria-pressed', String(pinned));
      pin.append(iconEl(pinned ? 'pinned' : 'pin'));
      pin.addEventListener('click', () => {
        pinned = !pinned;
        card.classList.toggle('pinned', pinned);
        render(c);
      });
      head.append(pin);
      card.append(head);
      if (c.code) {
        const pre = document.createElement('pre');
        pre.className = 'card-code';
        pre.append(highlightCode(c.code));
        card.append(pre);
      } else if (c.loading) {
        const pre = document.createElement('pre');
        pre.className = 'card-code loading';
        pre.textContent = 'Reading the code…';
        card.append(pre);
      }
      if (c.note) {
        const note = document.createElement('p');
        note.className = 'card-note';
        note.textContent = c.note;
        card.append(note);
      }
      const facts = (c.facts || []).filter((f) => f && f[1] !== undefined && f[1] !== '');
      if (facts.length) {
        const grid = document.createElement('dl');
        grid.className = 'card-facts';
        for (const [label, value] of facts) {
          const dt = document.createElement('dt');
          dt.textContent = label;
          const dd = document.createElement('dd');
          dd.textContent = value;
          grid.append(dt, dd);
        }
        card.append(grid);
      }
      if (c.keys && c.keys.length) {
        const keys = document.createElement('div');
        keys.className = 'card-keys';
        for (const [key, what] of c.keys) {
          const k = document.createElement('span');
          const kbd = document.createElement('kbd');
          kbd.textContent = key;
          k.append(kbd, ` ${what}`);
          keys.append(k);
        }
        card.append(keys);
      }
    }
    function place() {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      card.style.left = '0px';
      card.style.top = '0px';
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      // Beside the box (right, or left when there is no room), level with its top, kept in the window.
      let x = r.right + 10;
      if (x + w > window.innerWidth - 6) x = Math.max(6, r.left - w - 10);
      const y = Math.max(6, Math.min(r.top, window.innerHeight - h - 6));
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
    }
    function show(target, content, delay = 350, key) {
      if (pinned) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        anchor = target;
        shownFor = key;
        render(content);
        card.hidden = false;
        place();
      }, delay);
    }
    /** New content for the box already shown, such as its code once it has been read. */
    function update(content, key) {
      if (card.hidden || shownFor !== key) return;
      render(content);
      place();
    }
    function hide() {
      clearTimeout(timer);
      if (pinned) return;
      card.hidden = true;
      shownFor = undefined;
    }
    function hideSoon() {
      clearTimeout(timer);
      if (pinned) return;
      timer = setTimeout(() => { if (!card.matches(':hover')) hide(); }, 200);
    }
    card.addEventListener('mouseleave', hideSoon);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !card.hidden) {
        pinned = false;
        card.classList.remove('pinned');
        hide();
      }
    });
    const api = { show, update, hide, hideSoon, get pinned() { return pinned; }, get key() { return card.hidden ? undefined : shownFor; } };
    openCards.push(api);
    return api;
  }

  window.chartKit = { el, renderControls, hoverCard, highlightCode, drawFlows, attachFlowLines, redrawFlows, exportSvg, bindToggles, glyph, icon, ringPaths, menu, minimap, toPng, clampView, glide, zoomPresets, panKey, refitOnResize };
})();
