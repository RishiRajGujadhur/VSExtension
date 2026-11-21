// @ts-check
/**
 * The Git reel player: draws a ReelPlan (src/reel/plan.ts) on a canvas, one frame at a time, as a pure function of the
 * plan, the time, the shape (16:9 or 9:16) and the theme. The same drawing is what Export records, so the preview is
 * the video. Captions are edited in the scene list under the timeline.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const FPS = 30;
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('screen'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const timeline = document.getElementById('timeline');
  const playhead = document.getElementById('playhead');
  const timeLabel = document.getElementById('time');
  const frameLabel = document.getElementById('frames');
  const sceneList = document.getElementById('sceneList');
  const playButton = document.getElementById('play');
  const exportButtons = document.getElementById('exports');
  const status = document.getElementById('status');
  const empty = document.getElementById('empty');
  const titleEl = document.getElementById('title');
  const baseEl = document.getElementById('base');

  /** @type {any} */
  let plan;
  /** Captions the reel would have without edits, by scene id. */
  let generated = {};
  let t = 0;
  let playing = false;
  let last = 0;
  let recording = false;
  let aspect = saved.aspect === '9:16' ? '9:16' : '16:9';
  let theme = saved.theme || 'midnight';
  /** Scenes left out of the reel (kept by the extension for this change). */
  let skipped = new Set();
  /** The voice-over: whether it is on, the voices, and each scene's clip decoded for Web Audio. */
  let voice = { on: false, voices: [], name: '' };
  const buffers = new Map();
  /** @type {AudioContext | undefined} */
  let audio;
  let sources = [];
  /** @type {MediaStreamAudioDestinationNode | undefined} */
  let recordDest;
  let cancelled = false;
  const progressBar = document.getElementById('progressBar');
  const cancelButton = document.getElementById('cancel');

  const themes = {
    midnight: { bg: '#0d0f16', grid: 'rgba(140,150,190,0.10)', panel: '#151925', border: '#2a3042', text: '#e8eaf2', muted: '#8e96ad', accent: '#7c6cf2', accentSoft: 'rgba(124,108,242,0.18)', add: '#3fb950', addSoft: 'rgba(63,185,80,0.16)', del: '#f85149', delSoft: 'rgba(248,81,73,0.15)', changed: '#d6a03a', code: '#0a0c12', keyword: '#c586c0', string: '#ce9178', number: '#b5cea8', comment: '#6a9955', call: '#dcdcaa' },
    graphite: { bg: '#1b1b1d', grid: 'rgba(255,255,255,0.06)', panel: '#232326', border: '#3a3a3f', text: '#ececee', muted: '#9a9aa3', accent: '#4ea1ff', accentSoft: 'rgba(78,161,255,0.16)', add: '#4cc38a', addSoft: 'rgba(76,195,138,0.15)', del: '#ff6b6b', delSoft: 'rgba(255,107,107,0.14)', changed: '#e5b454', code: '#151517', keyword: '#ff7ab2', string: '#ffa86b', number: '#d0bf69', comment: '#7f8c98', call: '#67b7a4' },
    paper: { bg: '#f7f5ef', grid: 'rgba(60,60,80,0.08)', panel: '#ffffff', border: '#ddd8cc', text: '#1f2328', muted: '#6b6f76', accent: '#5b4bdb', accentSoft: 'rgba(91,75,219,0.12)', add: '#1a7f37', addSoft: 'rgba(26,127,55,0.12)', del: '#cf222e', delSoft: 'rgba(207,34,46,0.10)', changed: '#9a6700', code: '#fbfaf7', keyword: '#8250df', string: '#0a3069', number: '#0550ae', comment: '#6e7781', call: '#953800' },
  };
  const style = getComputedStyle(document.body);
  const codeFont = (style.getPropertyValue('--vscode-editor-font-family') || 'Consolas, monospace').trim();
  const uiFont = (style.getPropertyValue('--vscode-font-family') || 'Segoe UI, sans-serif').trim();

  // ---------------------------------------------------------------------------------------------------------------
  // Time

  /** The scenes in the reel: all but those switched off. */
  const scenes = () => (plan ? plan.scenes.filter((s) => !skipped.has(s.id)) : []);
  const total = () => scenes().reduce((n, s) => n + s.seconds, 0);
  const startOf = (scene) => {
    let start = 0;
    for (const s of scenes()) {
      if (s === scene) return start;
      start += s.seconds;
    }
    return start;
  };
  /** The scene at a time, its index, when it starts and how far into it the time is (0 to 1). */
  function sceneAt(time) {
    let start = 0;
    const list = scenes();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (time < start + s.seconds || i === list.length - 1) return { scene: s, index: i, start, local: Math.max(0, time - start), p: Math.min(1, Math.max(0, (time - start) / s.seconds)) };
      start += s.seconds;
    }
    return undefined;
  }
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  // ---------------------------------------------------------------------------------------------------------------
  // Drawing helpers

  function size() {
    return aspect === '9:16' ? { W: 1080, H: 1920 } : { W: 1920, H: 1080 };
  }
  function round(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function panel(x, y, w, h, c, fill, stroke, r = 18) {
    round(x, y, w, h, r);
    ctx.fillStyle = fill || c.panel;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = stroke || c.border;
    ctx.stroke();
  }
  function text(str, x, y, font, color, align = 'left', base = 'alphabetic') {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = /** @type {CanvasTextAlign} */ (align);
    ctx.textBaseline = /** @type {CanvasTextBaseline} */ (base);
    ctx.fillText(str, x, y);
  }
  /** Cuts a line to the width, with "…". Remembered, since every frame draws the same lines again. */
  const fitted = new Map();
  function fit(str, width, font) {
    const key = `${font}|${Math.round(width)}|${str}`;
    const hit = fitted.get(key);
    if (hit !== undefined) return hit;
    if (fitted.size > 8000) fitted.clear();
    const result = measureFit(str, width, font);
    fitted.set(key, result);
    return result;
  }
  function measureFit(str, width, font) {
    ctx.font = font;
    if (ctx.measureText(str).width <= width) return str;
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(str.slice(0, mid) + '…').width <= width) lo = mid;
      else hi = mid - 1;
    }
    return str.slice(0, lo) + '…';
  }
  /** Splits words into lines that fit the width. */
  function wrap(str, width, font) {
    ctx.font = font;
    const words = String(str).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  function chip(str, x, y, c, font, align = 'left', fill, color) {
    ctx.font = font;
    const w = ctx.measureText(str).width + 36;
    const h = 46;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    round(left, y, w, h, h / 2);
    ctx.fillStyle = fill || c.accentSoft;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color || c.accent;
    ctx.globalAlpha *= 0.6;
    ctx.stroke();
    ctx.globalAlpha /= 0.6;
    text(str, left + w / 2, y + h / 2 + 1, font, c.text, 'center', 'middle');
    return w;
  }

  const KEYWORDS = new Set('abstract as async await break case catch class const continue default delete do else enum export extends false finally for foreach from function get if implements import in instanceof interface let new null of override private protected public readonly return set static super switch this throw true try type typeof undefined using var void while yield namespace string number boolean decimal int bool void select insert update delete where begin end declare exec procedure create alter table into values join on and or not is go set return raise raiserror throw'.split(' '));
  /** Code drawn with a few colors: keywords, strings, numbers, comments and calls. */
  function drawCode(str, x, y, font, c, maxWidth) {
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const shown = fit(str, maxWidth, font);
    const re = /(\/\/.*|--.*|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?|\b\d[\d_.]*\b|[A-Za-z_$@#][\w$#]*(?=\s*\()|[A-Za-z_$@#][\w$#]*|\s+|.)/g;
    let cx = x;
    for (const m of shown.matchAll(re)) {
      const tok = m[0];
      let color = c.text;
      if (/^(\/\/|--)/.test(tok)) color = c.comment;
      else if (/^["'`]/.test(tok)) color = c.string;
      else if (/^\d/.test(tok)) color = c.number;
      else if (KEYWORDS.has(tok.toLowerCase()) && /^[A-Za-z]/.test(tok)) color = c.keyword;
      else if (/^[A-Za-z_$@#]/.test(tok) && shown.slice(m.index + tok.length).trimStart().startsWith('(')) color = c.call;
      ctx.fillStyle = color;
      ctx.fillText(tok, cx, y);
      cx += ctx.measureText(tok).width;
    }
  }

  /** The dotted background, drawn once per theme and shape and then copied. */
  let backdrop;
  function background(c, W, H) {
    const key = `${theme}:${W}x${H}`;
    if (!backdrop || backdrop.key !== key) {
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const g = off.getContext('2d');
      g.fillStyle = c.bg;
      g.fillRect(0, 0, W, H);
      g.fillStyle = c.grid;
      for (let gx = 24; gx < W; gx += 48) for (let gy = 24; gy < H; gy += 48) g.fillRect(gx - 1.5, gy - 1.5, 3, 3);
      backdrop = { key, canvas: off };
    }
    ctx.drawImage(backdrop.canvas, 0, 0);
  }

  const kindName = { overview: 'Overview', diff: 'Change', flow: 'Flowchart', files: 'Other files', summary: 'Summary' };
  const sceneName = (s) => (s.kind === 'diff' ? (s.symbol ? `${s.symbol}()` : s.file.split('/').pop()) : s.kind === 'flow' ? `${s.symbol}() flowchart` : kindName[s.kind]);

  /** Where things go: 16:9 puts code and flowchart side by side, 9:16 stacks them and uses bigger type. */
  function layout(W, H) {
    const tall = H > W;
    const m = tall ? 56 : 64;
    return { tall, m, top: tall ? 150 : 120, captionH: tall ? 260 : 150, title: tall ? 64 : 60, body: tall ? 40 : 34, small: tall ? 30 : 26, code: tall ? 30 : 26 };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Scenes

  function drawOverview(s, p, c, W, H, L) {
    const cy = L.tall ? H * 0.36 : H * 0.36;
    const a = ease(p * 4);
    ctx.globalAlpha = a;
    chip(`${plan.meta.head} → ${plan.meta.base}`, W / 2, cy - 150, c, `600 ${L.small}px ${codeFont}`, 'center');
    const lines = wrap(plan.meta.title, W - 2 * L.m - 80, `700 ${L.title + 16}px ${uiFont}`).slice(0, 3);
    lines.forEach((line, i) => text(line, W / 2, cy + i * (L.title + 26) - (lines.length - 1) * 20, `700 ${L.title + 16}px ${uiFont}`, c.text, 'center', 'middle'));
    const stats = [
      [`+${plan.meta.additions}`, 'ADDITIONS', c.add, c.addSoft],
      [`−${plan.meta.deletions}`, 'DELETIONS', c.del, c.delSoft],
      [String(plan.meta.files), plan.meta.files === 1 ? 'FILE' : 'FILES', c.text, c.panel],
    ];
    const bw = L.tall ? 260 : 220;
    const bh = L.tall ? 170 : 150;
    const gap = 30;
    const sx = W / 2 - (stats.length * bw + (stats.length - 1) * gap) / 2;
    const sy = cy + lines.length * (L.title + 26) + 30;
    stats.forEach(([n, label, color, fill], i) => {
      const lift = (1 - ease(p * 4 - 0.2 - i * 0.15)) * 40;
      ctx.globalAlpha = ease(p * 4 - 0.2 - i * 0.15);
      panel(sx + i * (bw + gap), sy + lift, bw, bh, c, fill, color);
      text(n, sx + i * (bw + gap) + bw / 2, sy + lift + bh * 0.42, `700 ${L.title - 4}px ${codeFont}`, color, 'center', 'middle');
      text(label, sx + i * (bw + gap) + bw / 2, sy + lift + bh * 0.76, `600 ${L.small - 4}px ${uiFont}`, c.muted, 'center', 'middle');
    });
    ctx.globalAlpha = 1;
    if (plan.meta.skipped) text(`${plan.meta.skipped} file${plan.meta.skipped === 1 ? '' : 's'} left out: lock files, build output, secrets, binaries`, W / 2, sy + bh + 70, `${L.small - 2}px ${uiFont}`, c.muted, 'center', 'middle');
  }

  function drawDiff(s, p, c, W, H, L) {
    const head = `${s.file}${s.symbol ? `  ·  ${s.symbol}()` : ''}`;
    text(fit(head, W - 2 * L.m, `600 ${L.body}px ${codeFont}`), L.m, L.top + 20, `600 ${L.body}px ${codeFont}`, c.text, 'left', 'middle');
    const badges = `+${s.added}  −${s.removed}${s.isNew ? '  ·  new' : ''}`;
    text(badges, L.m, L.top + 20 + L.body + 14, `${L.small}px ${codeFont}`, c.muted, 'left', 'middle');
    const areaTop = L.top + 20 + L.body * 2 + 30;
    const areaBottom = H - L.captionH - 40;
    drawLines(s.lines, p, c, { x: L.m, y: areaTop, w: W - 2 * L.m, h: areaBottom - areaTop }, L);
  }

  /** A function's flowchart on its own: the whole chart first, then the view glides to the boxes that changed. */
  function drawFlowScene(s, p, c, W, H, L) {
    text(fit(`${s.file}  ·  ${s.symbol}()`, W - 2 * L.m, `600 ${L.body}px ${codeFont}`), L.m, L.top + 20, `600 ${L.body}px ${codeFont}`, c.text, 'left', 'middle');
    text('Flowchart: new boxes green, changed boxes amber', L.m, L.top + 20 + L.body + 14, `${L.small}px ${uiFont}`, c.muted, 'left', 'middle');
    const areaTop = L.top + 20 + L.body * 2 + 30;
    const areaBottom = H - L.captionH - 40;
    drawFlow(s.flow, p, c, { x: L.m, y: areaTop, w: W - 2 * L.m, h: areaBottom - areaTop }, L);
  }

  /** The diff, revealed line by line in the first part of the scene, scrolled when it is taller than its box. */
  function drawLines(lines, p, c, box, L) {
    panel(box.x, box.y, box.w, box.h, c, c.code);
    ctx.save();
    round(box.x, box.y, box.w, box.h, 18);
    ctx.clip();
    const lineH = Math.max(L.code + 10, Math.min(L.code + 20, (box.h - 40) / Math.max(1, lines.length)));
    const font = `${L.code}px ${codeFont}`;
    const visible = Math.floor((box.h - 40) / lineH);
    const overflow = Math.max(0, lines.length - visible);
    const scroll = overflow * ease((p - 0.25) / 0.6);
    const reveal = Math.ceil(lines.length * ease(p / 0.3));
    const gutter = L.code * 3.2;
    for (let i = 0; i < Math.min(lines.length, reveal); i++) {
      const l = lines[i];
      const y = box.y + 20 + (i - scroll) * lineH;
      if (y < box.y - lineH || y > box.y + box.h) continue;
      if (l.kind === 'add' || l.kind === 'del') {
        ctx.fillStyle = l.kind === 'add' ? c.addSoft : c.delSoft;
        ctx.fillRect(box.x, y, box.w, lineH);
        ctx.fillStyle = l.kind === 'add' ? c.add : c.del;
        ctx.fillRect(box.x, y, 5, lineH);
      }
      const mid = y + lineH / 2;
      // The words changed in a line changed in place, marked stronger.
      if (l.span && (l.kind === 'add' || l.kind === 'del')) {
        ctx.font = font;
        const before = l.text.slice(0, l.span[0]).replace(/\t/g, '  ');
        const part = l.text.slice(l.span[0], l.span[1]).replace(/\t/g, '  ');
        const x0 = box.x + gutter + 14 + ctx.measureText(before).width;
        const w = Math.min(ctx.measureText(part).width, box.x + box.w - 20 - x0);
        if (w > 0) {
          ctx.save();
          ctx.globalAlpha *= 0.42;
          ctx.fillStyle = l.kind === 'add' ? c.add : c.del;
          round(x0 - 3, y + 3, w + 6, lineH - 6, 5);
          ctx.fill();
          ctx.restore();
        }
      }
      if (l.kind === 'gap') {
        text(l.text, box.x + gutter, mid, `${L.code - 2}px ${codeFont}`, c.muted, 'left', 'middle');
        continue;
      }
      text(l.line ? String(l.line) : '', box.x + gutter - 26, mid, `${L.code - 4}px ${codeFont}`, c.muted, 'right', 'middle');
      text(l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '', box.x + gutter - 10, mid, font, l.kind === 'add' ? c.add : c.del, 'left', 'middle');
      drawCode(l.text.replace(/\t/g, '  '), box.x + gutter + 14, mid, font, c, box.w - gutter - 34);
    }
    ctx.restore();
  }

  /** The function's flowchart, scaled into its box: new boxes green, changed ones amber, drawn in as the scene goes. */
  function drawFlow(flow, p, c, box, L) {
    panel(box.x, box.y, box.w, box.h, c);
    const legendH = L.small + 34;
    const pad = 28;
    const innerW = box.w - 2 * pad;
    const innerH = box.h - 2 * pad - legendH;
    // The whole chart first; in a big chart the view then glides in on the boxes that changed, so they can be read.
    const whole = { x: 0, y: 0, w: flow.width, h: flow.height };
    const changedNodes = flow.nodes.filter((n) => n.state !== 'same');
    let focus = whole;
    if (changedNodes.length) {
      const x0 = Math.min(...changedNodes.map((n) => n.x)) - 120;
      const y0 = Math.min(...changedNodes.map((n) => n.y)) - 120;
      const x1 = Math.max(...changedNodes.map((n) => n.x + n.width)) + 120;
      const y1 = Math.max(...changedNodes.map((n) => n.y + n.height)) + 120;
      // At least the box's own shape, so a lone box is not blown up.
      const w = Math.max(x1 - x0, innerW / 1.6);
      const h = Math.max(y1 - y0, innerH / 1.6);
      focus = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
    }
    const fitScale = (r) => Math.min(innerW / Math.max(1, r.w), innerH / Math.max(1, r.h), 2.2);
    // Boxes are read at a scale of at least 1.6 (code at about 19px): when the changes do not fit at that size, the
    // view travels from one group of changed boxes to the next, top to bottom.
    let target = focus;
    if (changedNodes.length && fitScale(focus) < 1.6) {
      const k = 1.6;
      const vw = innerW / k;
      const vh = innerH / k;
      const stops = [];
      for (const n of [...changedNodes].sort((a, b) => a.y - b.y)) {
        const cx = n.x + n.width / 2;
        const cy = n.y + n.height / 2;
        const last = stops[stops.length - 1];
        if (last && Math.abs(cy - last.y) < vh * 0.55 && Math.abs(cx - last.x) < vw * 0.55) {
          last.x = (last.x * last.n + cx) / (last.n + 1);
          last.y = (last.y * last.n + cy) / (last.n + 1);
          last.n++;
        } else stops.push({ x: cx, y: cy, n: 1 });
      }
      const along = ease((p - 0.3) / 0.62) * (stops.length - 1);
      const a = stops[Math.floor(along)];
      const b = stops[Math.min(stops.length - 1, Math.floor(along) + 1)];
      const f = along - Math.floor(along);
      const cx = a.x + (b.x - a.x) * f;
      const cy = a.y + (b.y - a.y) * f;
      target = { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
    }
    const zoomIn = fitScale(target) > fitScale(whole) * 1.15 ? ease((p - 0.1) / 0.22) : 0;
    const view = { x: whole.x + (target.x - whole.x) * zoomIn, y: whole.y + (target.y - whole.y) * zoomIn, w: whole.w + (target.w - whole.w) * zoomIn, h: whole.h + (target.h - whole.h) * zoomIn };
    const scale = fitScale(view);
    const ox = box.x + pad + innerW / 2 - (view.x + view.w / 2) * scale;
    const oy = box.y + pad + innerH / 2 - (view.y + view.h / 2) * scale;
    const appear = ease(p / 0.12);
    ctx.save();
    round(box.x + 2, box.y + 2, box.w - 4, box.h - legendH - 4, 16);
    ctx.clip();
    ctx.globalAlpha = appear;
    ctx.lineWidth = Math.max(1.5, 2.5 * scale);
    ctx.strokeStyle = c.muted;
    for (const e of flow.edges) {
      ctx.beginPath();
      e.points.forEach((pt, i) => (i ? ctx.lineTo(ox + pt.x * scale, oy + pt.y * scale) : ctx.moveTo(ox + pt.x * scale, oy + pt.y * scale)));
      ctx.setLineDash(e.back ? [8, 6] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const pulse = 0.5 + 0.5 * Math.sin(p * Math.PI * 6);
    for (const n of flow.nodes) {
      const x = ox + n.x * scale;
      const y = oy + n.y * scale;
      const w = n.width * scale;
      const h = n.height * scale;
      const color = n.state === 'added' ? c.add : n.state === 'changed' ? c.changed : c.border;
      if (n.kind === 'start' || n.kind === 'end') {
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
        ctx.fillStyle = n.kind === 'start' ? c.accent : c.panel;
        ctx.fill();
        ctx.strokeStyle = c.accent;
        ctx.stroke();
        continue;
      }
      if (n.state !== 'same') {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 + 18 * pulse;
        round(x, y, w, h, Math.min(12, h / 3));
        ctx.fillStyle = n.state === 'added' ? c.addSoft : 'rgba(214,160,58,0.16)';
        ctx.fill();
        ctx.restore();
      }
      round(x, y, w, h, n.kind === 'decision' || n.kind === 'loop' || n.kind === 'switch' ? h / 2 : Math.min(12, h / 3));
      if (n.state === 'same') {
        ctx.fillStyle = c.code;
        ctx.fill();
      }
      ctx.lineWidth = n.state === 'same' ? Math.max(1, 1.5 * scale) : Math.max(2, 3.5 * scale);
      ctx.strokeStyle = color;
      ctx.setLineDash(n.state === 'changed' ? [8, 5] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      // The boxes are laid out for code at 12px: at this zoom, 12px times the zoom fills them.
      const fontPx = Math.min(28, 12 * scale);
      if (h > 12 && fontPx >= 8) {
        ctx.save();
        round(x, y, w, h, 6);
        ctx.clip();
        text(fit(n.label, w - 12, `${fontPx}px ${codeFont}`), x + w / 2, y + h / 2, `${fontPx}px ${codeFont}`, n.state === 'same' ? c.muted : c.text, 'center', 'middle');
        ctx.restore();
      }
    }
    ctx.restore();
    // Legend: what the colors mean, and the paths.
    const ly = box.y + box.h - legendH / 2 - 8;
    const added = flow.nodes.filter((n) => n.state === 'added').length;
    const changed = flow.nodes.filter((n) => n.state === 'changed').length;
    let lx = box.x + 24;
    const legend = (color, label, dashed) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash(dashed ? [6, 4] : []);
      round(lx, ly - 11, 30, 22, 6);
      ctx.stroke();
      ctx.setLineDash([]);
      text(label, lx + 40, ly, `${L.small - 2}px ${uiFont}`, c.muted, 'left', 'middle');
      ctx.font = `${L.small - 2}px ${uiFont}`;
      lx += 40 + ctx.measureText(label).width + 28;
    };
    if (added) legend(c.add, `${added} new`);
    if (changed) legend(c.changed, `${changed} changed`, true);
    const paths = [flow.newPaths ? `${flow.newPaths} new path${flow.newPaths === 1 ? '' : 's'}` : '', flow.gonePaths ? `${flow.gonePaths} gone` : ''].filter(Boolean).join(' · ') || `${flow.paths}${flow.truncated ? '+' : ''} path${flow.paths === 1 ? '' : 's'}`;
    text(paths, box.x + box.w - 24, ly, `${L.small - 2}px ${uiFont}`, c.muted, 'right', 'middle');
  }

  function drawFiles(s, p, c, W, H, L) {
    text('Files changed', L.m, L.top + 20, `700 ${L.title - 8}px ${uiFont}`, c.text, 'left', 'middle');
    const rowH = L.tall ? 74 : 58;
    const top = L.top + 90;
    const max = Math.floor((H - L.captionH - 60 - top) / rowH);
    const rows = s.files.slice(0, max);
    const most = Math.max(1, ...rows.map((f) => f.added + f.removed));
    rows.forEach((f, i) => {
      const a = ease(p * 3 - i * 0.12);
      if (a <= 0) return;
      ctx.globalAlpha = a;
      const y = top + i * rowH;
      const tag = { added: 'A', untracked: 'A', deleted: 'D', renamed: 'R', modified: 'M' }[f.status] || 'M';
      const color = tag === 'A' ? c.add : tag === 'D' ? c.del : tag === 'R' ? c.accent : c.changed;
      text(tag, L.m + 14, y + rowH / 2, `700 ${L.small}px ${codeFont}`, color, 'center', 'middle');
      const barW = L.tall ? 220 : 300;
      text(fit(f.file, W - 2 * L.m - barW - 200, `${L.small}px ${codeFont}`), L.m + 46, y + rowH / 2, `${L.small}px ${codeFont}`, c.text, 'left', 'middle');
      const bx = W - L.m - barW;
      const addW = (barW * f.added) / most;
      const delW = (barW * f.removed) / most;
      ctx.fillStyle = c.add;
      ctx.fillRect(bx, y + rowH / 2 - 6, addW * a, 12);
      ctx.fillStyle = c.del;
      ctx.fillRect(bx + addW * a, y + rowH / 2 - 6, delW * a, 12);
      text(`+${f.added} −${f.removed}`, bx - 20, y + rowH / 2, `${L.small - 4}px ${codeFont}`, c.muted, 'right', 'middle');
    });
    ctx.globalAlpha = 1;
    if (s.files.length > rows.length) text(`and ${s.files.length - rows.length} more`, L.m + 46, top + rows.length * rowH + 20, `${L.small - 2}px ${uiFont}`, c.muted, 'left', 'middle');
  }

  function drawSummary(s, p, c, W, H, L) {
    text('Summary', L.m, L.top + 20, `700 ${L.title}px ${uiFont}`, c.text, 'left', 'middle');
    let y = L.top + 120;
    s.points.forEach((point, i) => {
      const a = ease(p * 3 - i * 0.25);
      if (a <= 0) return;
      ctx.globalAlpha = a;
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(L.m + 12, y, 8, 0, Math.PI * 2);
      ctx.fill();
      const lines = wrap(point, W - 2 * L.m - 50, `${L.body}px ${uiFont}`);
      lines.forEach((line, j) => text(line, L.m + 40, y + j * (L.body + 12), `${L.body}px ${uiFont}`, c.text, 'left', 'middle'));
      y += lines.length * (L.body + 12) + 30;
    });
    ctx.globalAlpha = ease(p * 2 - 0.8);
    text('Made with Code X-Ray', W - L.m, H - L.captionH - 60, `${L.small - 4}px ${uiFont}`, c.muted, 'right', 'middle');
    ctx.globalAlpha = 1;
  }

  /** A caption's sentences: "fn(): " stays with the first one. */
  function sentencesOf(caption) {
    const parts = String(caption).split(/(?<=[.!?])\s+(?=[A-Z0-9"'(`])/).filter(Boolean);
    return parts.length ? parts : [String(caption)];
  }
  /** The sentence on screen at a point of the scene: each gets time by its length, like a subtitle. */
  function subtitle(s, p) {
    const parts = sentencesOf(s.caption);
    if (parts.length === 1) return { text: parts[0], index: 0, count: 1, local: p };
    const weights = parts.map((x) => x.length + 12);
    const sum = weights.reduce((a, b) => a + b, 0);
    let at = 0;
    for (let i = 0; i < parts.length; i++) {
      const share = weights[i] / sum;
      if (p < at + share || i === parts.length - 1) return { text: parts[i], index: i, count: parts.length, local: (p - at) / share };
      at += share;
    }
    return { text: parts[0], index: 0, count: 1, local: p };
  }

  /** The caption under each scene, one sentence at a time, with the dot of its kind. */
  function drawCaption(s, p, c, W, H, L) {
    const sub = subtitle(s, p);
    // Each sentence fades in; the first with the scene.
    const a = sub.index === 0 ? ease(p * 5 - 0.3) : ease(sub.local * 8);
    if (a <= 0) return;
    ctx.globalAlpha = a;
    const font = `${L.body}px ${uiFont}`;
    const lines = wrap(sub.text, W - 2 * L.m - 110 - (sub.count > 1 ? 80 : 0), font).slice(0, L.tall ? 4 : 2);
    const h = Math.max(90, lines.length * (L.body + 14) + 44);
    const y = H - L.m - h;
    panel(L.m, y, W - 2 * L.m, h, c, c.panel);
    ctx.fillStyle = s.captionSource === 'user' ? c.accent : c.add;
    ctx.beginPath();
    ctx.arc(L.m + 40, y + h / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    lines.forEach((line, i) => text(line, L.m + 72, y + h / 2 + (i - (lines.length - 1) / 2) * (L.body + 14), font, c.text, 'left', 'middle'));
    if (sub.count > 1) text(`${sub.index + 1}/${sub.count}`, W - L.m - 28, y + h / 2, `${L.small - 4}px ${codeFont}`, c.muted, 'right', 'middle');
    ctx.globalAlpha = 1;
  }

  /** One frame: the scene at this time with its chip, frame count and caption, faded in and out at its edges. */
  function draw(time) {
    const { W, H } = size();
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const c = themes[theme] || themes.midnight;
    background(c, W, H);
    if (!plan) return;
    const at = sceneAt(time);
    if (!at) return;
    const L = layout(W, H);
    const { scene: s, index, p } = at;
    const fadeIn = Math.min(1, at.local / 0.35);
    const fadeOut = Math.min(1, (s.seconds - at.local) / 0.3);
    const totalFrames = Math.round(total() * FPS);
    ctx.globalAlpha = 1;
    chip(`Scene ${index + 1} • ${fit(sceneName(s), L.tall ? 520 : 700, `600 ${L.small - 2}px ${uiFont}`)}`, L.m, L.m - 10, c, `600 ${L.small - 2}px ${uiFont}`);
    text(`Frame ${String(Math.min(totalFrames, Math.round(time * FPS))).padStart(3, '0')} / ${totalFrames}`, W - L.m, L.m + 13, `600 ${L.small - 4}px ${codeFont}`, c.muted, 'right', 'middle');
    ctx.save();
    ctx.globalAlpha = Math.min(fadeIn, fadeOut);
    const lift = (1 - ease(fadeIn)) * 24;
    ctx.translate(0, lift);
    if (s.kind === 'overview') drawOverview(s, p, c, W, H, L);
    else if (s.kind === 'diff') drawDiff(s, p, c, W, H, L);
    else if (s.kind === 'flow') drawFlowScene(s, p, c, W, H, L);
    else if (s.kind === 'files') drawFiles(s, p, c, W, H, L);
    else drawSummary(s, p, c, W, H, L);
    ctx.restore();
    ctx.globalAlpha = Math.min(fadeIn, fadeOut);
    drawCaption(s, p, c, W, H, L);
    ctx.globalAlpha = 1;
    // The progress line along the bottom edge.
    ctx.fillStyle = c.accent;
    ctx.fillRect(0, H - 6, (W * time) / Math.max(0.001, total()), 6);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Player

  function render() {
    draw(t);
    const length = total();
    playhead.style.left = `${(100 * t) / Math.max(0.001, length)}%`;
    timeLabel.textContent = fmt(t);
    frameLabel.textContent = `${fmt(length)} (${Math.round(length * FPS)} frames)`;
    const at = plan && sceneAt(t);
    sceneList.querySelectorAll('.scene').forEach((row) => row.classList.toggle('current', !!at && row.dataset.id === at.scene.id));
    timeline.querySelectorAll('.segment').forEach((seg, i) => seg.classList.toggle('current', !!at && at.index === i));
  }
  function loop(now) {
    if (!playing) return;
    t += (now - last) / 1000;
    last = now;
    if (t >= total()) {
      t = total();
      setPlaying(false);
    }
    render();
    if (playing) requestAnimationFrame(loop);
  }
  function setPlaying(on) {
    if (on && t >= total() - 0.01) t = 0;
    playing = on;
    if (on) startAudio(t);
    else stopAudio();
    playButton.replaceChildren(icon(on ? 'debug-pause' : 'play'), on ? ' Pause' : ' Play');
    playButton.setAttribute('aria-pressed', String(on));
    if (on) {
      last = performance.now();
      requestAnimationFrame(loop);
    }
  }
  function icon(name) {
    const i = document.createElement('i');
    i.className = `codicon codicon-${name}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
  }
  function seek(time) {
    t = Math.max(0, Math.min(total(), time));
    if (playing) startAudio(t);
    render();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Voice-over: each scene's clip starts a moment into its scene.

  const LEAD = 0.35;
  // Browsers start sound only after a click or a key in the page: the first one wakes the audio up.
  function unlockAudio() {
    if (!voice.on) return;
    audio = audio || new AudioContext();
    if (audio.state !== 'running') void audio.resume();
  }
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);
  async function loadClips(clips) {
    buffers.clear();
    const entries = Object.entries(clips || {});
    if (!entries.length) return;
    audio = audio || new AudioContext();
    await Promise.all(
      entries.map(async ([id, b64]) => {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        try {
          buffers.set(id, await audio.decodeAudioData(bytes.buffer));
        } catch {
          // A clip that does not decode is left out.
        }
      }),
    );
  }
  function stopAudio() {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    sources = [];
  }
  /** Plays the clips from a time of the reel: the one under way from its middle, the next ones when they come. */
  function startAudio(from) {
    stopAudio();
    if (!voice.on || !audio || !buffers.size) return;
    void audio.resume();
    const now = audio.currentTime + 0.05;
    let start = 0;
    for (const s of scenes()) {
      const buffer = buffers.get(s.id);
      const clipStart = start + LEAD;
      start += s.seconds;
      if (!buffer || from >= clipStart + buffer.duration) continue;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      if (recordDest) source.connect(recordDest);
      if (from <= clipStart) source.start(now + (clipStart - from));
      else source.start(now, from - clipStart);
      sources.push(source);
    }
  }

  function buildTimeline() {
    timeline.querySelectorAll('.segment').forEach((s) => s.remove());
    const length = total();
    scenes().forEach((s, i) => {
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = `segment kind-${s.kind}`;
      seg.style.flexGrow = String(s.seconds / length);
      seg.textContent = `${i + 1}. ${sceneName(s)}`;
      seg.title = `${s.caption} (${s.seconds}s)`;
      seg.addEventListener('click', (e) => {
        const r = timeline.getBoundingClientRect();
        seek(((e.clientX - r.left) / r.width) * length);
      });
      timeline.insertBefore(seg, playhead);
    });
  }

  function buildSceneList() {
    sceneList.textContent = '';
    plan.scenes.forEach((s, i) => {
      const row = document.createElement('li');
      row.className = `scene${skipped.has(s.id) ? ' skipped' : ''}`;
      row.dataset.id = s.id;
      const head = document.createElement('div');
      head.className = 'scene-head';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'scene-go';
      go.textContent = `${i + 1}. ${sceneName(s)}`;
      go.title = 'Go to this scene';
      go.addEventListener('click', () => {
        if (!skipped.has(s.id)) seek(startOf(s) + 0.01);
      });
      // In the reel or not: a switched-off scene stays in the list, dimmed.
      const include = document.createElement('input');
      include.type = 'checkbox';
      include.checked = !skipped.has(s.id);
      include.title = 'In the reel';
      include.setAttribute('aria-label', `Scene ${i + 1} in the reel`);
      include.addEventListener('change', () => {
        if (include.checked) skipped.delete(s.id);
        else skipped.add(s.id);
        row.classList.toggle('skipped', !include.checked);
        vscode.postMessage({ type: 'skip', id: s.id, skip: !include.checked });
        t = Math.min(t, total());
        buildTimeline();
        render();
      });
      // Its code in the editor, at the change.
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'link';
      open.textContent = 'Open';
      open.title = 'Open the code at this change';
      open.hidden = !s.file;
      open.addEventListener('click', () => vscode.postMessage({ type: 'open', file: s.file, line: s.line }));
      const badge = document.createElement('span');
      badge.className = `badge ${s.captionSource}`;
      badge.textContent = s.captionSource === 'user' ? 'Edited' : 'Generated';
      const seconds = document.createElement('span');
      seconds.className = 'seconds';
      seconds.textContent = `${s.seconds}s`;
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'link';
      reset.textContent = 'Reset';
      reset.title = 'Back to the generated caption';
      reset.hidden = s.captionSource !== 'user';
      head.append(include, go, badge, reset, open, seconds);
      const field = document.createElement('textarea');
      field.className = 'caption';
      field.rows = 2;
      field.value = s.caption;
      field.setAttribute('aria-label', `Caption of scene ${i + 1}`);
      field.addEventListener('input', () => {
        s.caption = field.value;
        s.captionSource = 'user';
        badge.className = 'badge user';
        badge.textContent = 'Edited';
        reset.hidden = false;
        vscode.postMessage({ type: 'caption', id: s.id, caption: s.caption });
        render();
      });
      reset.addEventListener('click', () => {
        s.caption = generated[s.id] || s.caption;
        s.captionSource = 'heuristic';
        field.value = s.caption;
        badge.className = 'badge heuristic';
        badge.textContent = 'Generated';
        reset.hidden = true;
        vscode.postMessage({ type: 'caption', id: s.id, caption: null });
        render();
      });
      row.append(head, field);
      sceneList.append(row);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Export: the canvas recorded while the reel plays, at its real speed.

  const formats = [
    { id: 'mp4', label: 'MP4', mime: ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'], withAudio: ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2'] },
    { id: 'webm', label: 'WebM', mime: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'], withAudio: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'] },
  ].map((f) => ({ ...f, supported: typeof MediaRecorder !== 'undefined' ? f.mime.find((m) => MediaRecorder.isTypeSupported(m)) : undefined }));

  function buildExports() {
    exportButtons.textContent = '';
    const usable = formats.filter((f) => f.supported);
    if (!usable.length) {
      const note = document.createElement('span');
      note.className = 'muted';
      note.textContent = 'Recording video is not available in this editor.';
      exportButtons.append(note);
    }
    for (const f of usable) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = f.id === usable[0].id ? 'primary' : '';
      b.append(icon('desktop-download'), ` Export ${f.label}`);
      b.title = `Record the reel as ${f.label} (it plays once, in real time: keep this tab in view)`;
      b.addEventListener('click', () => record(f));
      exportButtons.append(b);
    }
  }

  /** Records the reel; a failure is said in the panel and passed on, never left silent. */
  async function record(format) {
    if (recording || !plan) return;
    try {
      await recordReel(format);
    } catch (error) {
      recording = false;
      recordDest = undefined;
      document.body.classList.remove('recording');
      cancelButton.hidden = true;
      progressBar.parentElement.hidden = true;
      status.textContent = `Export failed: ${error && error.message ? error.message : error}`;
      vscode.postMessage({ type: 'save', ext: format.id, data: '', error: String(error && error.message ? error.message : error) });
    }
  }
  async function recordReel(format) {
    recording = true;
    setPlaying(false);
    document.body.classList.add('recording');
    const video = canvas.captureStream(FPS);
    // With the voice on, its sound goes into the video too.
    let withVoice = voice.on && audio && buffers.size > 0;
    if (withVoice && audio.state !== 'running') {
      await Promise.race([audio.resume(), new Promise((r) => setTimeout(r, 500))]);
      if (audio.state !== 'running') withVoice = false;
    }
    const voiceNote = voice.on && buffers.size > 0 && !withVoice ? ' (without the voice: click in the reel, then export again)' : '';
    if (withVoice) recordDest = audio.createMediaStreamDestination();
    const stream = new MediaStream([...video.getVideoTracks(), ...(withVoice ? recordDest.stream.getAudioTracks() : [])]);
    const mimeType = (withVoice && format.withAudio.find((m) => MediaRecorder.isTypeSupported(m))) || format.supported;
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 96_000 });
    recorder.onerror = (e) => {
      cancelled = true;
      status.textContent = `Export failed: ${(e && e.error && e.error.message) || 'the recorder stopped'}`;
    };
    cancelled = false;
    cancelButton.hidden = false;
    progressBar.parentElement.hidden = false;
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => (recorder.onstop = resolve));
    const length = total();
    t = 0;
    render();
    recorder.start(250);
    const begin = performance.now();
    startAudio(0);
    await new Promise((resolve) => {
      const step = (now) => {
        t = Math.min(length, (now - begin) / 1000);
        render();
        status.textContent = `Recording ${format.label}${withVoice ? ' with voice' : ''}: ${fmt(t)} of ${fmt(length)}`;
        progressBar.style.width = `${(100 * t) / Math.max(0.001, length)}%`;
        if (t >= length || cancelled) resolve(undefined);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    stopAudio();
    // The last frame stays a moment, so players don't cut it.
    await new Promise((r) => setTimeout(r, 300));
    recorder.stop();
    await done;
    video.getTracks().forEach((track) => track.stop());
    recordDest = undefined;
    cancelButton.hidden = true;
    progressBar.parentElement.hidden = true;
    progressBar.style.width = '0%';
    if (cancelled) {
      status.textContent = 'Export cancelled.';
      recording = false;
      document.body.classList.remove('recording');
      return;
    }
    status.textContent = `Saving…${voiceNote}`;
    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) throw new Error(`nothing was recorded (${mimeType}, audio ${audio ? audio.state : 'none'})`);
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      // The type may hold commas ("vp9,opus"): the data starts after ";base64,".
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(';base64,') + 8));
      };
      reader.readAsDataURL(blob);
    });
    vscode.postMessage({ type: 'save', ext: format.id, data, seconds: length, sound: { voice: voice.on, clips: buffers.size, audio: audio ? audio.state : 'none', included: !!withVoice, mimeType } });
    recording = false;
    document.body.classList.remove('recording');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Controls

  function setAspect(value) {
    aspect = value;
    vscode.setState({ ...vscode.getState(), aspect });
    document.querySelectorAll('[data-aspect]').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-aspect') === aspect)));
    document.body.dataset.aspect = aspect;
    render();
  }
  document.querySelectorAll('[data-aspect]').forEach((b) => b.addEventListener('click', () => setAspect(b.getAttribute('data-aspect'))));
  const themeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('theme'));
  themeSelect.value = theme;
  themeSelect.addEventListener('change', () => {
    theme = themeSelect.value;
    vscode.setState({ ...vscode.getState(), theme });
    render();
  });
  playButton.addEventListener('click', () => setPlaying(!playing));
  cancelButton.addEventListener('click', () => {
    cancelled = true;
  });
  // The reel as Markdown, for a pull request: the title, the totals and what each change does.
  document.getElementById('copyMarkdown').addEventListener('click', () => {
    if (!plan) return;
    const m = plan.meta;
    const lines = [`## ${m.title}`, '', `\`${m.head}\` → ${m.base} · ${m.files} file${m.files === 1 ? '' : 's'} · +${m.additions} / −${m.deletions}`, ''];
    for (const s of scenes()) {
      if (s.kind !== 'diff') continue;
      const flow = plan.scenes.find((f) => f.kind === 'flow' && f.id === `${s.id}#flow` && !skipped.has(f.id));
      const what = s.caption.replace(/^[^:]+\(\):\s*/, '').replace(/^[^:\s]+\.\w+:\s*/, '');
      lines.push(`- **${s.symbol ? `${s.symbol}()` : s.file.split('/').pop()}** (\`${s.file}\`): ${what}${flow ? ` _${flow.caption.replace(/^[^:]+:\s*/, '')}_` : ''}`);
    }
    lines.push('', '_Made with the Code X-Ray Git reel._');
    vscode.postMessage({ type: 'copy', text: lines.join('\n') });
  });
  const voiceToggle = document.getElementById('voiceToggle');
  const voiceSelect = /** @type {HTMLSelectElement} */ (document.getElementById('voiceSelect'));
  voiceToggle.addEventListener('click', () => {
    status.textContent = voice.on ? '' : 'Preparing the voice-over…';
    vscode.postMessage({ type: 'voice', on: !voice.on });
  });
  voiceSelect.addEventListener('change', () => vscode.postMessage({ type: 'voice', on: true, voice: voiceSelect.value }));
  function showVoice() {
    voiceToggle.setAttribute('aria-pressed', String(voice.on));
    voiceToggle.classList.toggle('on', voice.on);
    voiceToggle.replaceChildren(icon(voice.on ? 'unmute' : 'mute'));
    voiceToggle.title = voice.on ? 'Voice-over on: each caption is read by your computer’s voice (click to turn off)' : 'Voice-over: read the captions with your computer’s voice';
    voiceSelect.hidden = !voice.on || voice.voices.length < 2;
    voiceSelect.replaceChildren(...voice.voices.map((v) => new Option(v.replace(/^Microsoft\s+|\s+Desktop$/g, ''), v, false, v === voice.name)));
  }
  document.getElementById('restart').addEventListener('click', () => seek(0));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  // Dragging on the timeline scrubs.
  timeline.addEventListener('pointerdown', (e) => {
    const r = timeline.getBoundingClientRect();
    const to = (ev) => seek(((ev.clientX - r.left) / r.width) * total());
    to(e);
    const move = (ev) => to(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || recording) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'ArrowRight') seek(t + (e.shiftKey ? 5 : 1));
    else if (e.key === 'ArrowLeft') seek(t - (e.shiftKey ? 5 : 1));
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'e' || e.key === 'E') {
      // The first format this editor can make.
      const format = formats.find((f) => f.supported);
      if (format) record(format);
    } else if (e.key === 'v' || e.key === 'V') document.getElementById('voiceToggle').click();
    else if (e.key === 'End') seek(total());
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'plan') {
      plan = message.plan;
      generated = message.generated || {};
      skipped = new Set(message.skipped || []);
      voice = { on: !!(message.voice && message.voice.on), voices: (message.voice && message.voice.voices) || [], name: (message.voice && message.voice.name) || '' };
      showVoice();
      stopAudio();
      void loadClips(message.voice && message.voice.clips).then(() => {
        if (playing) startAudio(t);
      });
      empty.hidden = true;
      document.body.classList.add('has-plan');
      titleEl.textContent = plan.meta.title;
      baseEl.textContent = `${plan.meta.head} → ${plan.meta.base}`;
      t = Math.min(t, total());
      buildTimeline();
      buildSceneList();
      status.textContent = '';
      render();
    } else if (message.type === 'record') {
      // Asked by the extension (tests): record in this format, if this editor can.
      const format = formats.find((f) => f.id === message.format && f.supported);
      if (format) record(format);
      else vscode.postMessage({ type: 'save', ext: message.format, data: '' });
    } else if (message.type === 'busy') {
      status.textContent = message.text || '';
    } else if (message.type === 'saved') {
      status.textContent = message.text || '';
    }
  });

  buildExports();
  setAspect(aspect);
  render();
  vscode.postMessage({ type: 'ready' });

  // For tests: draws one frame at a time.
  window.reelFrame = (time) => {
    t = time;
    render();
    return canvas;
  };
})();
