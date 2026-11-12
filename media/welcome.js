// The Code X-Ray Welcome page: an ASCII field behind a pixel-font title, then the Getting Started steps as cards.
(function () {
  const vscode = acquireVsCodeApi();
  const page = document.getElementById('page');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /*
   * The background: a grid of characters drawn from a slowly moving noise field. Each cell shows a character as
   * dense as the field is bright there (" .·:;+*#"), dim grey where it is faint and teal where it is strong, and
   * the field fades out behind the title on the left. Written for this page with a 2D canvas: the characters are
   * drawn once into an atlas and copied from it, at most 24 times a second; it stops while the tab is hidden and is
   * one still frame when the system asks for reduced motion.
   */
  const ramp = ' .·:;+*#';
  const cell = 12;

  // Value noise in three dimensions (x, y, time), smoothed, two octaves.
  const perm = new Uint8Array(512);
  {
    let seed = 7;
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      seed = (seed * 16807) % 2147483647;
      const j = seed % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  }
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const corner = (x, y, z) => perm[(perm[(perm[x & 255] + y) & 255] + z) & 255] / 255;
  function noise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
    const plane = (k) => lerp(lerp(corner(xi, yi, k), corner(xi + 1, yi, k), u), lerp(corner(xi, yi + 1, k), corner(xi + 1, yi + 1, k), u), v);
    return lerp(plane(zi), plane(zi + 1), w);
  }
  const field = (x, y, t) => noise(x * 0.09, y * 0.12, t) * 0.7 + noise(x * 0.23 + 40, y * 0.3, t * 1.7) * 0.3;
  // Rain mode (an Easter egg, below): each column of the field falls at its own speed.
  let rain = false;
  const fall = (x, t) => (rain ? t * (14 + (perm[x & 255] % 9) * 3) : 0);

  function startAscii(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    // The atlas: each character of the ramp in grey and in teal, one cell each.
    const atlas = document.createElement('canvas');
    const colours = ['rgba(150, 156, 160, 0.55)', '#2fd4c9'];
    atlas.width = ramp.length * cell * ratio;
    atlas.height = colours.length * cell * ratio;
    const a = atlas.getContext('2d');
    a.scale(ratio, ratio);
    a.font = `${cell - 1}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
    a.textAlign = 'center';
    a.textBaseline = 'middle';
    colours.forEach((colour, row) => {
      a.fillStyle = colour;
      [...ramp].forEach((ch, i) => a.fillText(ch, i * cell + cell / 2, row * cell + cell / 2 + 1));
    });
    let cols = 0, rows = 0, frame = 0, last = 0;
    const started = performance.now();
    function resize() {
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
      cols = Math.ceil(window.innerWidth / cell);
      rows = Math.ceil(window.innerHeight / cell);
    }
    function draw(now) {
      const t = (reducedMotion.matches ? 30 : (now - started) / 1000 + 30) * 0.12;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const size = cell * ratio;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          // Faint on the left where the title is, full from about a third of the way across.
          const side = Math.min(1, Math.max(0, (x / cols - 0.22) / 0.3));
          const v = field(x, y - fall(x, t), t) * (0.25 + 0.75 * side);
          const level = Math.max(0, (v - 0.32) / 0.5);
          const index = Math.min(ramp.length - 1, Math.floor(level * ramp.length));
          if (index <= 0) continue;
          const teal = level > 0.62 ? 1 : 0;
          ctx.drawImage(atlas, index * size, teal * size, size, size, x * size, y * size, size, size);
        }
      }
    }
    function loop(now) {
      if (now - last > 1000 / 24) {
        last = now;
        draw(now);
      }
      frame = reducedMotion.matches || document.hidden ? 0 : requestAnimationFrame(loop);
    }
    const restart = () => {
      cancelAnimationFrame(frame);
      last = 0;
      frame = requestAnimationFrame(loop);
    };
    resize();
    restart();
    window.addEventListener('resize', () => {
      resize();
      restart();
    });
    document.addEventListener('visibilitychange', restart);
    reducedMotion.addEventListener('change', restart);
  }

  /*
   * The title in a pixel font: each letter is 5 by 7 squares, drawn as SVG so it stays sharp at any size. The
   * squares come in at random over half a second, like characters settling on a screen. The h1 keeps the words
   * as text for screen readers and search; the drawing is hidden from them.
   */
  const glyphs = {
    A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.', C: '.###.|#...#|#....|#....|#....|#...#|.###.',
    D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
    G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#', I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
    J: '..###|...#.|...#.|...#.|#..#.|#..#.|.##..', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
    M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#', O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
    P: '####.|#...#|#...#|####.|#....|#....|#....', Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
    S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
    V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
    Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####', '-': '.....|.....|.....|#####|.....|.....|.....',
    ' ': '.....|.....|.....|.....|.....|.....|.....',
  };
  const svgNS = 'http://www.w3.org/2000/svg';
  /** Words wrapped into lines of at most `width` characters. */
  function wrap(text, width) {
    const lines = [];
    for (const word of text.toUpperCase().split(/\s+/)) {
      const lastLine = lines[lines.length - 1];
      if (lastLine !== undefined && lastLine.length + 1 + word.length <= width) lines[lines.length - 1] = `${lastLine} ${word}`;
      else lines.push(word);
    }
    return lines;
  }
  function pixelTitle(text) {
    const lines = wrap(text, 11);
    const columns = Math.max(...lines.map((l) => l.length)) * 6 - 1;
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${columns} ${lines.length * 9 - 2}`);
    svg.setAttribute('class', 'pixel-title');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.setProperty('--columns', String(columns));
    const squares = [];
    lines.forEach((line, row) => {
      [...line].forEach((ch, i) => {
        const glyph = (glyphs[ch] || glyphs[' ']).split('|');
        glyph.forEach((bits, gy) => [...bits].forEach((bit, gx) => {
          if (bit !== '#') return;
          const r = document.createElementNS(svgNS, 'rect');
          r.setAttribute('x', String(i * 6 + gx));
          r.setAttribute('y', String(row * 9 + gy));
          r.setAttribute('width', '1.02');
          r.setAttribute('height', '1.02');
          squares.push(r);
          svg.appendChild(r);
        }));
      });
    });
    if (!reducedMotion.matches && !document.hidden) {
      // In random order, a few squares at a time; whatever happens to the timers, all are shown after a second.
      const order = squares.map((r) => [Math.random(), r]).sort((x, y) => x[0] - y[0]).map(([, r]) => r);
      for (const r of order) r.style.opacity = '0';
      const step = Math.ceil(order.length / 18);
      let at = 0;
      const tick = () => {
        order.slice(at, at + step).forEach((r) => (r.style.opacity = ''));
        at += step;
        if (at < order.length) setTimeout(tick, 30);
      };
      setTimeout(tick, 60);
      setTimeout(() => order.forEach((r) => (r.style.opacity = '')), 1000);
    }
    return svg;
  }

  const make = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const icon = (name) => {
    const i = make('i', `codicon codicon-${name}`);
    i.setAttribute('aria-hidden', 'true');
    return i;
  };
  /** A button: `box` is the white square one, the rest read as uppercase links. */
  function button(label, onClick, box, iconName) {
    const b = make('button', box ? 'box-button' : 'link-button');
    b.type = 'button';
    if (iconName) b.append(icon(iconName));
    b.append(label);
    b.addEventListener('click', onClick);
    return b;
  }

  let done = new Set();
  function render(data) {
    done = new Set(data.done);
    page.textContent = '';
    // The title over the ASCII field.
    const hero = make('header', 'hero');
    const title = make('h1', 'title');
    title.append(make('span', 'visually-hidden', data.title), pixelTitle(data.title));
    const lead = make('p', 'lead', data.description);
    const tagline = make('p', 'tagline', 'Offline static analysis for TypeScript, JavaScript and React');
    const actions = make('div', 'hero-actions');
    const first = data.steps[0] && data.steps[0].buttons[0];
    actions.append(button('Start the tour', () => {
      const target = document.getElementById('steps');
      target.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      const firstCard = target.querySelector('.step');
      // Focus moves to the first step once the page has scrolled there; moving it sooner stops the scroll.
      if (firstCard) setTimeout(() => firstCard.focus({ preventScroll: true }), reducedMotion.matches ? 0 : 800);
    }, true));
    if (first) actions.append(button(first.label, () => run(first.command, data.steps[0].id)));
    actions.append(button('Next step', () => {
      const next = [...page.querySelectorAll('.step')].find((c) => !c.classList.contains('done')) || page.querySelector('.step');
      if (!next) return;
      next.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
      setTimeout(() => next.focus({ preventScroll: true }), reducedMotion.matches ? 0 : 700);
    }));
    const progress = make('span', 'progress');
    progress.id = 'progress';
    actions.append(progress);
    const top = make('div', 'hero-top');
    top.append(title, lead, tagline);
    hero.append(top, actions);

    // The steps.
    const section = make('section', 'steps');
    section.id = 'steps';
    section.setAttribute('aria-label', 'Steps');
    const list = make('ol', 'step-list');
    data.steps.forEach((step, i) => {
      const li = make('li', 'step');
      li.tabIndex = -1;
      li.dataset.step = step.id;
      if (done.has(step.id)) li.classList.add('done');
      const head = make('div', 'step-head');
      const number = make('span', 'step-number', String(i + 1).padStart(2, '0'));
      number.setAttribute('aria-label', done.has(step.id) ? `Step ${i + 1}, done` : `Step ${i + 1}`);
      const mark = make('span', 'step-done', '[x]');
      mark.setAttribute('aria-hidden', 'true');
      head.append(number, make('h2', 'step-title', step.title), mark);
      if (step.key) {
        const key = make('kbd', 'step-key', step.key);
        key.title = `${step.buttons[0].label} has this shortcut`;
        head.append(key);
      }
      const text = make('p', 'step-text');
      for (const piece of step.text) text.append(piece.bold ? make('strong', '', piece.text) : piece.text);
      const buttons = make('div', 'step-buttons');
      step.buttons.forEach((b, j) => buttons.append(button(b.label, () => run(b.command, step.id), j === 0)));
      li.append(head, text, buttons);
      if (step.image) {
        const figure = make('figure', 'step-picture');
        const img = make('img');
        img.src = step.image.src;
        img.alt = step.image.alt;
        img.loading = 'lazy';
        figure.append(img);
        if (step.image.caption) figure.append(make('figcaption', '', step.image.caption));
        li.append(figure);
      }
      list.append(li);
    });
    section.append(list);

    const footer = make('footer', 'more');
    for (const c of data.extra) footer.append(button(c.label, () => run(c.command), false, c.icon));
    footer.append(button('VS Code walkthrough', () => vscode.postMessage({ type: 'walkthrough' }), false, 'book'));
    page.append(hero, section, footer);
    updateProgress(data.steps.length);
  }

  function updateProgress(total) {
    const progress = document.getElementById('progress');
    if (!progress) return;
    progress.textContent = done.size >= total ? `All ${total} steps tried. You know your way around.` : done.size ? `${done.size}/${total} steps tried` : `${total} short steps`;
    if (done.size) {
      const again = make('button', 'link-button', 'Start over');
      again.type = 'button';
      again.addEventListener('click', () => {
        done = new Set();
        page.querySelectorAll('.step.done').forEach((c) => c.classList.remove('done'));
        vscode.postMessage({ type: 'startOver' });
        updateProgress(total);
      });
      progress.append(' ', again);
    }
  }

  function run(command, step) {
    vscode.postMessage({ type: 'run', command, step });
    if (!step || done.has(step)) return;
    done.add(step);
    const card = page.querySelector(`.step[data-step="${CSS.escape(step)}"]`);
    if (card) card.classList.add('done');
    updateProgress(page.querySelectorAll('.step').length);
  }

  // The field dims as you scroll down to the steps, so the cards read well over it.
  window.addEventListener('scroll', () => document.body.style.setProperty('--scrolled', String(Math.min(1, window.scrollY / (window.innerHeight * 0.6)))), { passive: true });

  /*
   * Not in any menu: the old cheat code, up up down down left right left right b a, makes the field rain.
   * Entering it again stops the rain. With reduced motion it switches to a still picture of rain.
   */
  const cheat = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let entered = 0;
  window.addEventListener('keydown', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    entered = key === cheat[entered] ? entered + 1 : key === cheat[0] ? 1 : 0;
    if (entered < cheat.length) return;
    entered = 0;
    rain = !rain;
    let note = document.getElementById('note');
    if (!note) {
      note = make('div', 'note');
      note.id = 'note';
      note.setAttribute('role', 'status');
      document.body.append(note);
    }
    note.textContent = rain ? 'Rain mode. Enter the code again to stop it.' : 'Rain stopped.';
    note.classList.add('shown');
    clearTimeout(note.timer);
    note.timer = setTimeout(() => note.classList.remove('shown'), 2600);
    window.dispatchEvent(new Event('resize'));
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key) || (e.target.closest && e.target.closest('input, textarea'))) return;
    const card = page.querySelectorAll('.step')[Number(e.key) - 1];
    if (!card) return;
    card.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
    card.focus({ preventScroll: true });
  });

  window.addEventListener('message', (event) => {
    if (event.data.type === 'welcome') render(event.data);
  });
  if (!window.matchMedia('(forced-colors: active)').matches) startAscii(document.getElementById('lines'));
  vscode.postMessage({ type: 'ready' });
})();
