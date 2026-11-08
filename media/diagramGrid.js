/*
 * The animated dot grid behind the analysis diagram.
 *
 * Adapted from the node grid of robot-components (https://github.com/dashrobotco/robot-components,
 * app/nodegrid/page.tsx: the spring-pushed dot grid, the hover glow and the click pulse wave), reworked for
 * a VS Code webview: theme colors, a grid that pans with the chart, and drawing only while something moves.
 *
 * MIT License
 *
 * Copyright (c) 2026 Robot FZCO
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function () {
  const GRID = 40; // spacing between dots, in screen pixels
  const HOVER_RADIUS = 120; // the glow around the pointer
  const POINTER_PUSH = 14;
  const BOX_REACH = 90; // every box bends the grid this far around it
  const BOX_PUSH = 16;
  const HOVER_REACH = 160; // a hovered box pushes further
  const HOVER_PUSH = 24;
  const INSIDE_MARGIN = 7; // dots under a box move just past its nearest edge
  const MAX_SHIFT = 40;
  const NEAR_RADIUS = 46; // dots this close to a box are drawn brighter
  const SPRING = 0.08;
  const DAMPING = 0.75;
  const PULSE_SPEED = 400; // pixels per second
  const PULSE_WIDTH = 80;
  const PULSE_DURATION = 2000; // ms
  const LEVELS = 5; // glow is drawn in a few brightness steps, one path each

  /**
   * Starts the grid on a canvas. `chart()` returns the pan offset, the boxes in screen pixels and the hovered
   * box ({ panX, panY, boxes: [{ x, y, w, h }], hovered }). Boxes only bend the grid; call layout() when they move.
   */
  function create(canvas, chart) {
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let columns = 0;
    let rows = 0;
    // Per dot: spring displacement and velocity, the displacement the boxes ask for, and nearness to a box.
    let dx, dy, vx, vy, tx, ty, near, glowOf, xs, ys;
    let targetsKey = '';
    let pointer;
    let pulses = [];
    let frame = 0;
    let enabled = true;
    let colors;

    const probe = document.createElement('canvas').getContext('2d');
    const rgb = (color, fallback) => {
      probe.fillStyle = fallback;
      probe.fillStyle = color || fallback;
      const value = probe.fillStyle;
      if (value.startsWith('#')) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
      return (value.match(/[\d.]+/g) || [128, 128, 128]).slice(0, 3).map(Number);
    };
    function readColors() {
      const style = getComputedStyle(document.body);
      const variable = (name) => style.getPropertyValue(name).trim();
      const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
      colors = {
        dot: rgb(variable('--vscode-editorLineNumber-foreground'), light ? '#6e7681' : '#858585'),
        accent: rgb(variable('--vscode-focusBorder'), '#2563eb'),
        bright: light ? [40, 40, 40] : [235, 235, 235],
        light,
      };
    }

    function resize() {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      columns = Math.ceil(width / GRID) + 3;
      rows = Math.ceil(height / GRID) + 3;
      const n = columns * rows;
      [dx, dy, vx, vy, tx, ty, near, glowOf, xs, ys] = Array.from({ length: 10 }, () => new Float32Array(n));
      targetsKey = '';
      wake();
    }

    const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, a))})`;
    const origin = (pan) => (((pan % GRID) + GRID) % GRID) - GRID;

    /**
     * Where the boxes push each dot: dots under a box go just past its nearest edge, dots around it are pushed
     * away with a falloff, so the grid bends around every box. Only the dots near each box are visited, and this
     * runs only when the boxes, the pan or the hovered box change.
     */
    function computeTargets(state) {
      tx.fill(0);
      ty.fill(0);
      near.fill(0);
      const ox = origin(state.panX);
      const oy = origin(state.panY);
      const bend = (box, reach, strength) => {
        const i0 = Math.max(0, Math.ceil((box.x - reach - ox) / GRID));
        const i1 = Math.min(columns - 1, Math.floor((box.x + box.w + reach - ox) / GRID));
        const j0 = Math.max(0, Math.ceil((box.y - reach - oy) / GRID));
        const j1 = Math.min(rows - 1, Math.floor((box.y + box.h + reach - oy) / GRID));
        for (let j = j0; j <= j1; j++) {
          const y = oy + j * GRID;
          for (let i = i0; i <= i1; i++) {
            const x = ox + i * GRID;
            const k = j * columns + i;
            const left = x - box.x;
            const right = box.x + box.w - x;
            const top = y - box.y;
            const bottom = box.y + box.h - y;
            if (left > 0 && right > 0 && top > 0 && bottom > 0) {
              // Under the box: out through the nearest edge.
              const m = Math.min(left, right, top, bottom);
              if (m === left) tx[k] -= left + INSIDE_MARGIN;
              else if (m === right) tx[k] += right + INSIDE_MARGIN;
              else if (m === top) ty[k] -= top + INSIDE_MARGIN;
              else ty[k] += bottom + INSIDE_MARGIN;
              near[k] = 1;
              continue;
            }
            const cx = Math.max(box.x, Math.min(x, box.x + box.w));
            const cy = Math.max(box.y, Math.min(y, box.y + box.h));
            const ex = x - cx;
            const ey = y - cy;
            const d = Math.hypot(ex, ey);
            if (d === 0 || d > reach) continue;
            const amount = Math.pow(1 - d / reach, 2) * strength;
            tx[k] += (ex / d) * amount;
            ty[k] += (ey / d) * amount;
            if (d < NEAR_RADIUS) near[k] = Math.max(near[k], 1 - d / NEAR_RADIUS);
          }
        }
      };
      for (const box of state.boxes) bend(box, BOX_REACH, BOX_PUSH);
      if (state.hovered) bend(state.hovered, HOVER_REACH, HOVER_PUSH);
      for (let k = 0; k < tx.length; k++) {
        const shift = Math.hypot(tx[k], ty[k]);
        if (shift > MAX_SHIFT) {
          tx[k] *= MAX_SHIFT / shift;
          ty[k] *= MAX_SHIFT / shift;
        }
      }
    }

    function draw() {
      frame = 0;
      const now = performance.now();
      pulses = pulses.filter((p) => now - p.time < PULSE_DURATION);
      const state = chart();
      const hovered = state.hovered;
      const key = `${state.panX},${state.panY},${state.k},${state.version},${hovered ? `${hovered.x},${hovered.y}` : ''},${width},${height}`;
      if (key !== targetsKey) {
        targetsKey = key;
        computeTargets(state);
      }
      const ox = origin(state.panX);
      const oy = origin(state.panY);
      const still = reduceMotion.matches;
      let moving = pulses.length > 0;
      const n = columns * rows;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
          const k = j * columns + i;
          const baseX = ox + i * GRID;
          const baseY = oy + j * GRID;
          let targetX = tx[k];
          let targetY = ty[k];
          if (pointer && !still) {
            const px = baseX - pointer.x;
            const py = baseY - pointer.y;
            const d = Math.hypot(px, py);
            if (d > 0 && d < HOVER_RADIUS) {
              const amount = Math.pow(1 - d / HOVER_RADIUS, 2) * POINTER_PUSH;
              targetX += (px / d) * amount;
              targetY += (py / d) * amount;
            }
          }
          if (still) {
            dx[k] = targetX;
            dy[k] = targetY;
          } else {
            vx[k] = (vx[k] + (targetX - dx[k]) * SPRING) * DAMPING;
            vy[k] = (vy[k] + (targetY - dy[k]) * SPRING) * DAMPING;
            dx[k] += vx[k];
            dy[k] += vy[k];
            if (Math.abs(vx[k]) + Math.abs(vy[k]) > 0.02) moving = true;
          }
          const x = baseX + dx[k];
          const y = baseY + dy[k];
          xs[k] = x;
          ys[k] = y;
          glowOf[k] = glow(x, y, now);
        }
      }

      ctx.clearRect(0, 0, width, height);
      // Lines: one path for the plain ones, one per brightness step for the glowing ones.
      const base = colors.light ? 0.16 : 0.14;
      const plain = new Path2D();
      const edging = new Path2D(); // lines bending around a box, a little stronger so the bend shows
      const lit = Array.from({ length: LEVELS }, () => new Path2D());
      const line = (a, b) => {
        const g = (glowOf[a] + glowOf[b]) / 2;
        const path = g > 0.05 ? lit[Math.min(LEVELS - 1, Math.floor(g * LEVELS))] : near[a] > 0.2 || near[b] > 0.2 ? edging : plain;
        path.moveTo(xs[a], ys[a]);
        path.lineTo(xs[b], ys[b]);
      };
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
          const k = j * columns + i;
          if (i + 1 < columns) line(k, k + 1);
          if (j + 1 < rows) line(k, k + columns);
        }
      }
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = rgba(colors.dot, base);
      ctx.stroke(plain);
      ctx.strokeStyle = rgba(colors.dot, base * 2.2);
      ctx.stroke(edging);
      lit.forEach((path, level) => {
        const g = (level + 0.5) / LEVELS;
        ctx.lineWidth = 0.5 + g * 2;
        ctx.strokeStyle = rgba(colors.accent, base + g * 1.2);
        ctx.stroke(path);
      });
      // Dots: grey far from boxes, brighter and larger next to them and where they glow; one path per step.
      const dots = Array.from({ length: LEVELS + 1 }, () => new Path2D());
      for (let k = 0; k < n; k++) {
        const level = Math.max(glowOf[k], near[k] * 0.55);
        const step = level > 0.05 ? 1 + Math.min(LEVELS - 1, Math.floor(level * LEVELS)) : 0;
        const r = step ? 0.9 + ((step - 0.5) / LEVELS) * 2 : 0.9;
        dots[step].moveTo(xs[k] + r, ys[k]);
        dots[step].arc(xs[k], ys[k], r, 0, Math.PI * 2);
      }
      dots.forEach((path, step) => {
        ctx.fillStyle = step ? rgba(colors.bright, 0.2 + ((step - 0.5) / LEVELS) * 0.8) : rgba(colors.dot, colors.light ? 0.35 : 0.3);
        ctx.fill(path);
      });
      // Keep drawing only while dots move or a wave runs; a resting pointer costs nothing.
      if (moving && enabled && !still) wake();
    }

    // How strongly a point glows: near the pointer, and where a click's wave is passing.
    function glow(x, y, now) {
      let value = 0;
      if (pointer) {
        const d = Math.hypot(x - pointer.x, y - pointer.y);
        if (d < HOVER_RADIUS) value = Math.pow(1 - d / HOVER_RADIUS, 2) * 0.6;
      }
      for (const pulse of pulses) {
        const age = now - pulse.time;
        const fromWave = Math.abs(Math.hypot(x - pulse.x, y - pulse.y) - (age / 1000) * PULSE_SPEED);
        if (fromWave < PULSE_WIDTH) value = Math.max(value, (1 - fromWave / PULSE_WIDTH) * (1 - age / PULSE_DURATION));
      }
      return value;
    }

    function wake() {
      if (!frame && enabled) frame = requestAnimationFrame(draw);
    }

    readColors();
    new ResizeObserver(resize).observe(canvas);
    // VS Code changes the body's theme class when the color theme changes.
    new MutationObserver(() => { readColors(); wake(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    reduceMotion.addEventListener('change', wake);
    resize();

    return {
      /** The pointer moved over the chart (screen pixels), or left it (undefined). */
      pointer(position) {
        pointer = position;
        wake();
      },
      /** A wave from a point, such as the box that was clicked. */
      pulse(x, y) {
        if (!reduceMotion.matches) pulses.push({ x, y, time: performance.now() });
        wake();
      },
      /** Redraw after the chart moved, was zoomed or a box was hovered. */
      wake,
      setEnabled(on) {
        enabled = on;
        canvas.hidden = !on;
        if (on) wake();
      },
    };
  }

  window.diagramGrid = { create };
})();
