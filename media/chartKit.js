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
   */
  function menu(element) {
    let returnTo;
    function close(refocus) {
      if (element.hidden) return;
      element.hidden = true;
      if (refocus && returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
    }
    function open(items, x, y, from) {
      returnTo = from;
      element.textContent = '';
      const tidy = items.filter((item, i, all) => item !== '-' || (i > 0 && i < all.length - 1 && all[i - 1] !== '-'));
      for (const item of tidy) {
        if (item === '-') {
          element.appendChild(Object.assign(document.createElement('div'), { className: 'separator', role: 'separator' }));
          continue;
        }
        if (item.heading) {
          const heading = document.createElement('div');
          heading.className = 'menu-heading';
          heading.setAttribute('role', 'presentation');
          heading.textContent = item.heading;
          element.appendChild(heading);
          continue;
        }
        const button = document.createElement('button');
        button.setAttribute('role', 'menuitem');
        button.tabIndex = -1;
        const i = document.createElement('i');
        i.className = `codicon codicon-${item.icon || 'blank'}`;
        i.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'menu-label';
        label.textContent = item.label;
        button.append(i, label);
        if (item.keys) {
          const keys = document.createElement('span');
          keys.className = 'menu-keys';
          keys.textContent = item.keys;
          button.appendChild(keys);
        }
        button.addEventListener('click', () => {
          close(false);
          item.run();
        });
        element.appendChild(button);
      }
      if (!element.querySelector('[role="menuitem"]')) return;
      element.hidden = false;
      // Kept inside the window.
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      element.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
      const first = element.querySelector('[role="menuitem"]');
      if (first) first.focus();
    }
    element.addEventListener('keydown', (e) => {
      const items = [...element.querySelectorAll('[role="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key];
      if (move !== undefined) {
        e.preventDefault();
        items[(move + items.length) % items.length].focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key.length === 1 && /\S/.test(e.key)) {
        // A letter moves to the next item starting with it.
        const next = [...items.slice(at + 1), ...items.slice(0, at + 1)].find((b) => b.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
        if (next) next.focus();
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

  window.chartKit = { el, renderControls, drawFlows, attachFlowLines, redrawFlows, exportSvg, bindToggles, glyph, icon, ringPaths, menu, minimap, toPng, clampView, glide, zoomPresets, panKey, refitOnResize };
})();
