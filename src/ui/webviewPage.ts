import * as vscode from 'vscode';

/**
 * What every Code X-Ray webview shares: where its files come from, the page skeleton with its security policy and
 * VS Code's icon font, icon buttons, opening code beside a chart, and saving a chart as an image.
 */

const mediaRoot = (extensionUri: vscode.Uri) => vscode.Uri.joinPath(extensionUri, 'media');
const codiconRoot = (extensionUri: vscode.Uri) => vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');

/** The folders a webview may load files from: the extension's media and VS Code's icon font. */
export function webviewRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [mediaRoot(extensionUri), codiconRoot(extensionUri)];
}

/** A media file as the webview can load it. */
export function mediaUri(webview: vscode.Webview, extensionUri: vscode.Uri, name: string): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot(extensionUri), name));
}

/**
 * A page: a strict content security policy (only the extension's own styles, fonts and scripts, and data: images
 * when a page draws pictures), the icon font, the page's stylesheets, its body and then its scripts.
 */
export function webviewPage(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  page: { title: string; styles: string[]; scripts: string[]; body: string; bodyAttributes?: string; images?: boolean },
): string {
  const source = webview.cspSource;
  const icons = webview.asWebviewUri(vscode.Uri.joinPath(codiconRoot(extensionUri), 'codicon.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${source}; font-src ${source}; script-src ${source};${page.images ? ' img-src data:;' : ''}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${icons}">
${page.styles.map((s) => `<link rel="stylesheet" href="${mediaUri(webview, extensionUri, s)}">`).join('\n')}
<title>${page.title}</title>
</head>
<body${page.bodyAttributes ? ` ${page.bodyAttributes}` : ''}>
${page.body}
${page.scripts.map((s) => `<script src="${mediaUri(webview, extensionUri, s)}"></script>`).join('\n')}
</body>
</html>`;
}

/** An icon button whose tooltip and accessible name are the same words. */
export const iconButton = (id: string, icon: string, title: string, extra = '') =>
  `<button id="${id}" class="icon" title="${title}" aria-label="${title}" ${extra}><i class="codicon codicon-${icon}" aria-hidden="true"></i></button>`;

/** From a chart tab, the editor group code opens in, so the chart stays in view; undefined from an editor. */
export function besideChartColumn(): vscode.ViewColumn | undefined {
  const groups = vscode.window.tabGroups;
  if (!(groups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview)) return undefined;
  return groups.all.find((g) => g !== groups.activeTabGroup)?.viewColumn ?? vscode.ViewColumn.Beside;
}

/** Asks where to save a chart's image, offering the workspace folder and a name from the chart's title. */
export async function saveImage(content: Buffer, extension: 'svg' | 'png', title = 'diagram'): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const name = `${title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram'}.${extension}`;
  const kind = extension.toUpperCase();
  const target = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined, filters: { [`${kind} image`]: [extension] }, title: `Save Diagram as ${kind}` });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, content);
  if ((await vscode.window.showInformationMessage(`Diagram saved to ${vscode.workspace.asRelativePath(target)}.`, 'Open')) === 'Open') {
    await vscode.commands.executeCommand('vscode.open', target);
  }
}
