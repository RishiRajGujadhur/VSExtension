// The Value path panel: the latest "Why this value" result as a card with a timeline of the values.
(function () {
  const vscode = acquireVsCodeApi();
  const box = document.getElementById('card');
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
  const tool = (name, label, type) => {
    const b = make('button', 'card-tool');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    b.addEventListener('click', () => vscode.postMessage({ type }));
    return b;
  };

  function render(card, stale) {
    box.textContent = '';
    if (!card) {
      box.append(make('p', 'empty', 'Run Why this value on a variable to see its values here.'));
      return;
    }
    const head = make('div', 'card-head');
    const title = make('span', 'card-title');
    title.append(icon('git-merge'), make('strong', '', card.subject));
    head.append(title);
    if (card.timing) {
      const time = make('span', 'card-time');
      time.title = 'How long the analysis took';
      time.append(icon('clock'), card.timing);
      head.append(time);
    }
    head.append(tool('copy', 'Copy as Markdown', 'copy'), tool('list-tree', 'Show as a list (the Results view)', 'list'));
    box.append(head);

    box.append(make('p', 'card-summary', `${card.summary}.`));
    if (stale) {
      const note = make('p', 'card-stale');
      note.append(icon('warning'), ' Files changed since this ran. ');
      const again = make('button', 'link', 'Run it again');
      again.type = 'button';
      again.addEventListener('click', () => vscode.postMessage({ type: 'rerun' }));
      note.append(again);
      box.append(note);
    }
    if (card.needs) box.append(make('p', 'card-needs', card.needs));
    for (const w of card.warnings) box.append(make('p', 'card-warning', w));

    const line = make('ol', 'timeline');
    for (const v of card.values) {
      const li = make('li', 'step value');
      const button = make('button', 'step-card');
      button.type = 'button';
      button.disabled = !v.location;
      if (v.location) button.title = 'Open where this value comes from';
      const tile = make('span', 'step-tile');
      tile.append(icon(v.icon === 'symbol-constant' ? 'symbol-constant' : 'symbol-variable'));
      const text = make('span', 'step-text');
      const top = make('span', 'step-top');
      top.append(make('strong', '', v.title), make('span', 'step-badge', v.ways));
      const when = make('span', 'step-when');
      if (v.always) when.append(make('span', 'infinity', '∞'), ` ${v.when}`);
      else when.append(icon('filter'), ` ${v.when}`);
      text.append(top, when);
      button.append(tile, text);
      button.addEventListener('click', () => v.location && vscode.postMessage({ type: 'open', location: v.location }));
      li.append(button);
      line.append(li);
    }
    const next = make('li', 'step next');
    const nextButton = make('button', 'step-card');
    nextButton.type = 'button';
    const nextTile = make('span', 'step-tile');
    nextTile.append(icon('arrow-right'));
    const nextText = make('span', 'step-text');
    nextText.append(make('strong', '', 'Next'), make('span', 'step-when', 'Run another analysis here'));
    nextButton.append(nextTile, nextText, icon('chevron-right'));
    nextButton.addEventListener('click', () => vscode.postMessage({ type: 'next' }));
    next.append(nextButton);
    line.append(next);
    box.append(line);
    if (card.impossible) box.append(make('p', 'card-needs', `Left out: ${card.impossible}.`));
  }

  window.addEventListener('message', (event) => {
    if (event.data.type !== 'card') return;
    document.body.classList.toggle('accent-pink', event.data.accent === 'pink');
    document.body.classList.toggle('accent-theme', event.data.accent === 'theme');
    render(event.data.card, event.data.stale);
  });
  vscode.postMessage({ type: 'ready' });
})();
