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
  const BOX_REACH = 160; // how far a hovered box pushes the dots
  const BOX_PUSH = 22;
  const POINTER_PUSH = 14;
  const SPRING = 0.08;
  const DAMPING = 0.75;
  const PULSE_SPEED = 400; // pixels per second
  const PULSE_WIDTH = 80;
  const PULSE_DURATION = 2000; // ms

  /**
   * Starts the grid on a canvas. `chart()` returns the pan offset and the hovered box in screen pixels
   * ({ panX, panY, box: { x, y, w, h } | undefined }).
   */
  function create(canvas, chart) {
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let dots = []; // per grid cell: displacement and velocity
    let columns = 0;
    let rows = 0;
    let pointer;
    let pulses = [];
    let frame = 0;
    let enabled = true;
    let colors;

    // Theme colors, read from VS Code's CSS variables and normalized to [r, g, b].
    const probe = document.createElement('canvas').getContext('2d');
    const rgb = (color, fallback) => {
      probe.fillStyle = fallback;
      probe.fillStyle = color || fallback;
      const value = probe.fillStyle;
      if (value.startsWith('#')) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
      const parts = value.match(/[\d.]+/g) || [128, 128, 128];
      return parts.slice(0, 3).map(Number);
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
      dots = Array.from({ length: columns * rows }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));
      wake();
    }

    const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, a))})`;

    // How strongly a point glows: near the pointer, and where a click's wave is passing.
    function glow(x, y, now) {
      let value = 0;
      if (pointer) {
        const d = Math.hypot(x - pointer.x, y - pointer.y);
        if (d < HOVER_RADIUS) value = Math.pow(1 - d / HOVER_RADIUS, 2) * 0.6;
      }
      for (const pulse of pulses) {
        const age = now - pulse.time;
        const radius = (age / 1000) * PULSE_SPEED;
        const fromWave = Math.abs(Math.hypot(x - pulse.x, y - pulse.y) - radius);
        if (fromWave < PULSE_WIDTH) value = Math.max(value, (1 - fromWave / PULSE_WIDTH) * (1 - age / PULSE_DURATION));
      }
      return value;
    }

    // A push away from a rectangle, strongest at its edge and fading over `reach`.
    function push(x, y, box, reach, strength) {
      const cx = Math.max(box.x, Math.min(x, box.x + box.w));
      const cy = Math.max(box.y, Math.min(y, box.y + box.h));
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (!d || d > reach) return [0, 0];
      const amount = Math.pow(1 - d / reach, 2) * strength;
      return [(dx / d) * amount, (dy / d) * amount];
    }

    function draw() {
      frame = 0;
      const now = performance.now();
      pulses = pulses.filter((p) => now - p.time < PULSE_DURATION);
      const { panX, panY, box } = chart();
      // The grid moves with the chart when it is dragged.
      const offsetX = (((panX % GRID) + GRID) % GRID) - GRID;
      const offsetY = (((panY % GRID) + GRID) % GRID) - GRID;
      const still = reduceMotion.matches;
      let moving = !!pointer || pulses.length > 0;
      const positions = new Array(dots.length);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
          const index = j * columns + i;
          const dot = dots[index];
          const baseX = offsetX + i * GRID;
          const baseY = offsetY + j * GRID;
          let targetX = 0;
          let targetY = 0;
          if (!still) {
            if (box) {
              const [px, py] = push(baseX, baseY, box, BOX_REACH, BOX_PUSH);
              targetX += px;
              targetY += py;
            }
            if (pointer) {
              const [px, py] = push(baseX, baseY, { x: pointer.x, y: pointer.y, w: 0, h: 0 }, HOVER_RADIUS, POINTER_PUSH);
              targetX += px;
              targetY += py;
            }
          }
          // Spring toward the pushed position.
          dot.vx = (dot.vx + (targetX - dot.x) * SPRING) * DAMPING;
          dot.vy = (dot.vy + (targetY - dot.y) * SPRING) * DAMPING;
          dot.x += dot.vx;
          dot.y += dot.vy;
          if (Math.abs(dot.vx) + Math.abs(dot.vy) > 0.01) moving = true;
          positions[index] = { x: baseX + dot.x, y: baseY + dot.y, glow: glow(baseX + dot.x, baseY + dot.y, now) };
        }
      }

      ctx.clearRect(0, 0, width, height);
      const base = colors.light ? 0.1 : 0.07;
      // Wireframe lines between neighbors, blue where they glow.
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < columns; i++) {
          const p = positions[j * columns + i];
          for (const q of [i + 1 < columns ? positions[j * columns + i + 1] : undefined, j + 1 < rows ? positions[(j + 1) * columns + i] : undefined]) {
            if (!q) continue;
            const g = (p.glow + q.glow) / 2;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.lineWidth = 0.5 + g * 2;
            ctx.strokeStyle = g > 0.05 ? rgba(colors.accent, base + g * 1.2) : rgba(colors.dot, base);
            ctx.stroke();
          }
        }
      }
      // Dots on top: brighter and larger near the glow.
      for (const p of positions) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.9 + p.glow * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = p.glow > 0.05 ? rgba(colors.bright, 0.25 + p.glow) : rgba(colors.dot, colors.light ? 0.35 : 0.3);
        ctx.fill();
      }
      // Keep drawing only while something moves; an idle chart costs nothing.
      if (moving && enabled && !still) wake();
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
      /** Redraw after the chart moved or a box was hovered. */
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
