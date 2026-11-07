/** Small inline icons for webview buttons, drawn like VS Code's codicons (16px, current color). */
const paths: Record<string, string> = {
  preview: '<path d="M8 3C4.5 3 1.7 5.3 1 8c.7 2.7 3.5 5 7 5s6.3-2.3 7-5c-.7-2.7-3.5-5-7-5zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  apply: '<path d="M13.6 3.6 6 11.2 2.4 7.6l-1 1L6 13.2l8.6-8.6z"/>',
  reset: '<path d="M3.5 2v3.5H7V4.5H5.2A5 5 0 1 1 3 8H2a6 6 0 1 0 2-4.5V2z"/>',
  close: '<path d="m8 7.3 4.1-4.1.7.7L8.7 8l4.1 4.1-.7.7L8 8.7l-4.1 4.1-.7-.7L7.3 8 3.2 3.9l.7-.7z"/>',
  add: '<path d="M14 7.5H8.5V2h-1v5.5H2v1h5.5V14h1V8.5H14z"/>',
  search: '<path d="M10.5 2a3.5 3.5 0 0 0-2.8 5.6L2.6 12.7l.7.7 5.1-5.1A3.5 3.5 0 1 0 10.5 2zm0 6a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>',
  replace: '<path d="M3 3h6v1H4v3H3zm10 10H7v-1h5V9h1zM5 9l-2.5 2.5L5 14v-2h4v-1H5zM11 7l2.5-2.5L11 2v2H7v1h4z"/>',
  save: '<path d="M12.5 2h-9l-1.5 1.5v9L3.5 14h9l1.5-1.5v-9zM5 3h5v3H5zm8 9.1-.9.9H3.9l-.9-.9V3.9l.9-.9H4v4h7V3h1.1l.9.9z"/>',
  copy: '<path d="M4 4V2h9v9h-2v2H2V4zm1 0h6v6h1V3H5zm-2 1v7h7V5z"/>',
  up: '<path d="M8 3 3 8l.7.7L7.5 5V13h1V5l3.8 3.7L13 8z"/>',
  down: '<path d="m8 13 5-5-.7-.7L8.5 11V3h-1v8L3.7 7.3 3 8z"/>',
  remove: '<path d="M6 2h4v1h3v1H3V3h3zM4 5h8l-.6 9H4.6zm1.1 1 .5 7h4.8l.5-7z"/>',
};

export function icon(name: keyof typeof paths): string {
  return `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${paths[name]}</svg>`;
}

/** Buttons styled like VS Code's own: same height, 2px corners, primary and secondary colors, icon then label. */
export const buttonCss = `
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box; min-height: 26px; padding: 4px 12px; margin: 0;
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 18px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button .icon { flex: none; }
  button.icon-only { min-height: 22px; padding: 2px 4px; background: transparent; color: var(--vscode-icon-foreground, currentColor); border-color: transparent; }
  button.icon-only:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, .31)); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .actions .spacer { flex: 1; }
`;
