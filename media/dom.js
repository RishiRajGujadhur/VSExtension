// Small DOM helpers shared by the sidebar views and the Welcome page.
(function () {
  /** A new element with an optional class name and text. */
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** A codicon, hidden from screen readers (the text beside it says what it is). */
  function icon(name) {
    const i = make('i', `codicon codicon-${name}`);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }
  window.xrDom = { make, icon };
})();
