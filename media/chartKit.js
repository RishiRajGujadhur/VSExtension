// Shared by the analysis diagram and the Control Flow view: SVG elements, flowing lines, export as a standalone SVG,
// and the Grid and Flow toggles with their remembered setting.
(function () {
  const svgNs = 'http://www.w3.org/2000/svg';

  /** An SVG element with attributes, added to `parent` when given. */
  function el(name, attrs, parent) {
    const node = document.createElementNS(svgNs, name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  }

  /** Replaces the layer of flowing lines: one pulsing copy of each path, drawn under `before` (the boxes). */
  function drawFlows(scene, before, paths) {
    const old = scene.querySelector('.flows');
    if (old) old.remove();
    if (!paths.length) return;
    const layer = el('g', { class: 'flows' });
    scene.insertBefore(layer, before);
    for (const d of paths) el('path', { d, class: 'flow' }, layer);
  }

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
    copy.querySelectorAll(['.flows', 'title', ...(leaveOut || [])].join(',')).forEach((node) => node.remove());
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
      if (!prefs.flow) onFlowOff();
      show();
      save();
    });
    show();
  }

  window.chartKit = { el, drawFlows, exportSvg, bindToggles };
})();
