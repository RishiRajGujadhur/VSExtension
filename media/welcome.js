// The Code X-Ray Welcome page: shader lines behind the title, then the Getting Started steps as cards.
(function () {
  const vscode = acquireVsCodeApi();
  const page = document.getElementById('page');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /*
   * The background: thin vertical lines of light. The window is cut into columns a few pixels wide; each column
   * glows along dashes that drift up or down at its own speed, brightest on a wide ring around the title and
   * fading towards the middle and the edges. Each colour channel is sampled a little to the side, which gives the
   * lines cool blue and warm fringes. Written for this page (WebGL 1); it stops when the tab is hidden and draws
   * a single still frame when the system asks for reduced motion.
   */
  const vertex = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const fragment = `
precision highp float;
uniform vec2 size;
uniform float time;
uniform float scale;

float hash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }

// The light of one column at a point: dashes moving along it, shaped across its width.
float column(float x, float y) {
  float width = 9.0 * scale;
  float c = floor(x / width);
  float across = 1.0 - abs(fract(x / width) - 0.5) * 2.0;
  float speed = (0.03 + 0.11 * hash(c + 3.7)) * (hash(c + 9.1) > 0.5 ? 1.0 : -1.0);
  float density = 0.7 + 2.6 * hash(c + 5.3);
  float dash = fract(y * density + time * speed + hash(c + 1.9) * 10.0);
  float glow = smoothstep(0.0, 0.18, dash) * smoothstep(0.62, 0.3, dash);
  // Many columns stay dark, so the lit ones stand apart.
  float strength = pow(smoothstep(0.42, 1.0, hash(c + 12.4)), 1.4);
  float twinkle = 0.65 + 0.35 * sin(time * (0.6 + hash(c + 2.2)) + hash(c) * 6.283);
  return glow * strength * twinkle * pow(across, 1.1);
}

void main() {
  vec2 uv = gl_FragCoord.xy / size;
  float aspect = size.x / size.y;
  vec2 centered = (uv - 0.5) * vec2(aspect, 1.0);
  // A wide ring around the middle, darkest where the title is.
  float r = length(centered * vec2(0.75, 1.0));
  float ring = exp(-pow((r - 0.42) / 0.2, 2.0));
  float middle = smoothstep(0.08, 0.32, abs(uv.y - 0.5));
  float sides = 1.0 - smoothstep(0.45, 0.95, abs(centered.x) / max(aspect * 0.5, 0.5));
  float envelope = (ring * 1.35 + 0.05) * mix(0.1, 1.0, middle) * sides;
  float x = gl_FragCoord.x;
  float shift = 2.0 * scale;
  vec3 light = vec3(column(x - shift, uv.y), column(x, uv.y), column(x + shift, uv.y)) * envelope;
  // Cool blue-white lines with warm ones among them.
  float warm = step(0.68, hash(floor(x / (9.0 * scale)) + 21.0));
  vec3 tint = mix(vec3(0.5, 0.68, 1.0), vec3(1.0, 0.72, 0.5), warm);
  vec3 colour = light * tint * 2.4;
  // Hot cores turn white.
  colour += vec3(pow(max(max(light.r, light.g), light.b), 3.0) * 1.6);
  gl_FragColor = vec4(colour, 1.0);
}`;

  function startLines(canvas) {
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) {
      document.body.classList.add('no-webgl');
      return;
    }
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      document.body.classList.add('no-webgl');
      return;
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    const size = gl.getUniformLocation(program, 'size');
    const time = gl.getUniformLocation(program, 'time');
    const scale = gl.getUniformLocation(program, 'scale');
    // Drawn at up to 1.5 pixels per CSS pixel: sharp enough for thin lines, light on the GPU.
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    let frame = 0;
    const started = performance.now();
    function resize() {
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    function draw(now) {
      gl.uniform2f(size, canvas.width, canvas.height);
      gl.uniform1f(scale, ratio);
      gl.uniform1f(time, reducedMotion.matches ? 14 : (now - started) / 1000 + 14);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function loop(now) {
      draw(now);
      frame = reducedMotion.matches || document.hidden ? 0 : requestAnimationFrame(loop);
    }
    const restart = () => {
      cancelAnimationFrame(frame);
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
  function pill(label, onClick, primary, iconName) {
    const b = make('button', `pill${primary ? ' primary' : ''}`);
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
    // The title over the lines.
    const hero = make('header', 'hero');
    const eyebrow = make('p', 'eyebrow');
    eyebrow.append(icon('pulse'), ' Offline static analysis for TypeScript, JavaScript and React');
    const title = make('h1', 'title', data.title);
    const lead = make('p', 'lead', data.description);
    const actions = make('div', 'hero-actions');
    const first = data.steps[0] && data.steps[0].buttons[0];
    actions.append(pill('Start the Tour', () => {
      const target = document.getElementById('steps');
      target.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      const firstCard = target.querySelector('.step');
      // Focus moves to the first step once the page has scrolled there; moving it sooner stops the scroll.
      if (firstCard) setTimeout(() => firstCard.focus({ preventScroll: true }), reducedMotion.matches ? 0 : 800);
    }, true, 'arrow-down'));
    if (first) actions.append(pill(first.label, () => run(first.command, data.steps[0].id)));
    const progress = make('p', 'progress');
    progress.id = 'progress';
    hero.append(eyebrow, title, lead, actions, progress);

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
      const number = make('span', 'step-number');
      number.append(make('span', 'n', String(i + 1)), icon('check'));
      number.setAttribute('aria-label', done.has(step.id) ? `Step ${i + 1}, done` : `Step ${i + 1}`);
      head.append(number, make('h2', 'step-title', step.title));
      const text = make('p', 'step-text');
      for (const piece of step.text) text.append(piece.bold ? make("strong", "", piece.text) : piece.text);
      const buttons = make('div', 'step-buttons');
      step.buttons.forEach((b, j) => buttons.append(pill(b.label, () => run(b.command, step.id), j === 0)));
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
    for (const c of data.extra) footer.append(pill(c.label, () => run(c.command), false, c.icon));
    footer.append(pill('VS Code Walkthrough', () => vscode.postMessage({ type: 'walkthrough' }), false, 'book'));
    page.append(hero, section, footer);
    updateProgress(data.steps.length);
  }

  function updateProgress(total) {
    const progress = document.getElementById('progress');
    if (progress) progress.textContent = done.size ? `${done.size} of ${total} steps tried` : `${total} short steps`;
  }

  function run(command, step) {
    vscode.postMessage({ type: 'run', command, step });
    if (!step || done.has(step)) return;
    done.add(step);
    const card = page.querySelector(`.step[data-step="${CSS.escape(step)}"]`);
    if (card) card.classList.add('done');
    updateProgress(page.querySelectorAll('.step').length);
  }

  // The hero dims a little as you scroll down to the steps, so the cards read well over the lines.
  window.addEventListener('scroll', () => document.body.style.setProperty('--scrolled', String(Math.min(1, window.scrollY / (window.innerHeight * 0.6)))), { passive: true });

  window.addEventListener('message', (event) => {
    if (event.data.type === 'welcome') render(event.data);
  });
  if (!window.matchMedia('(forced-colors: active)').matches) startLines(document.getElementById('lines'));
  vscode.postMessage({ type: 'ready' });
})();
