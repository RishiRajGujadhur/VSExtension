// While a sidebar view waits for its first content: a halftone field of dots where patches glow and fade at random.
// It covers the view from the moment the page loads, and fades away on the first 'actions' or 'card' message.
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cover = document.createElement('div');
  cover.id = 'xr-loading';
  Object.assign(cover.style, {
    position: 'fixed', inset: '0', zIndex: '50', pointerEvents: 'none',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))', transition: 'opacity 350ms ease-out',
  });
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading…';
  Object.assign(status.style, { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' });
  cover.append(canvas, status);
  document.body.prepend(cover);

  const g = canvas.getContext('2d');
  const GAP = 10;
  let width = 0;
  let height = 0;
  let twinkle = [];
  function size() {
    const ratio = window.devicePixelRatio || 1;
    width = cover.clientWidth;
    height = cover.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    // A fixed flicker for each dot, so the field is not a smooth gradient.
    twinkle = Array.from({ length: Math.ceil(width / GAP + 1) * Math.ceil(height / GAP + 1) }, () => [Math.random(), Math.random() * 6.28]);
  }

  // Glowing patches: each drifts slowly, brightens, then fades and comes back somewhere else.
  const patch = (now) => ({
    x: Math.random() * width, y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.03, vy: (Math.random() - 0.5) * 0.03,
    r: 30 + Math.random() * 70, born: now - (reduceMotion ? 900 : 0), life: 1800 + Math.random() * 2400,
  });
  let patches = [];

  function draw(now) {
    g.clearRect(0, 0, width, height);
    g.fillStyle = getComputedStyle(document.body).color || '#ccc';
    for (let i = 0; i < patches.length; i++) {
      if (now - patches[i].born > patches[i].life) patches[i] = patch(now);
    }
    const live = patches.map((p) => {
      const t = (now - p.born) / p.life;
      return { x: p.x + p.vx * (now - p.born), y: p.y + p.vy * (now - p.born), r2: p.r * p.r, a: Math.sin(Math.PI * t) };
    });
    const cols = Math.ceil(width / GAP + 1);
    let n = 0;
    for (let y = GAP / 2; y < height + GAP; y += GAP) {
      for (let x = GAP / 2, c = 0; x < width + GAP; x += GAP, c++) {
        let glow = 0;
        for (const p of live) {
          const dx = x - p.x;
          const dy = y - p.y;
          glow += p.a * Math.exp(-(dx * dx + dy * dy) / p.r2);
        }
        const [seed, phase] = twinkle[n++] || [0.5, 0];
        glow = Math.min(1, glow * (0.7 + 0.5 * seed) + 0.03 * (1 + Math.sin(now / 400 + phase)) * seed);
        // Away from the patches the field stays dark, with only a few dots catching the light.
        if (glow < 0.08) continue;
        g.globalAlpha = Math.min(1, 0.1 + glow);
        g.beginPath();
        g.arc(x, y, 0.5 + 1.9 * glow, 0, 6.2832);
        g.fill();
      }
      n = Math.ceil(y / GAP) * cols;
    }
    g.globalAlpha = 1;
  }

  let frame = 0;
  let last = 0;
  function tick(now) {
    // About 30 frames a second is plenty for a slow glow.
    if (now - last > 32) {
      last = now;
      draw(now);
    }
    frame = requestAnimationFrame(tick);
  }

  function start() {
    size();
    const now = performance.now();
    patches = Array.from({ length: Math.max(4, Math.round((width * height) / 30000)) }, () => {
      const p = patch(now);
      // Start at different points of their lives, so they don't all glow at once.
      p.born -= Math.random() * p.life;
      return p;
    });
    if (reduceMotion) draw(now);
    else frame = requestAnimationFrame(tick);
  }

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    cover.style.opacity = '0';
    setTimeout(() => {
      cancelAnimationFrame(frame);
      cover.remove();
    }, 380);
  }

  window.addEventListener('resize', () => !done && size());
  window.addEventListener('message', (event) => {
    if (event.data && (event.data.type === 'actions' || event.data.type === 'card')) finish();
  });
  if (cover.clientWidth) start();
  else requestAnimationFrame(start);
})();
