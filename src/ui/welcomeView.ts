import * as vscode from 'vscode';
import * as fs from 'fs';
import { registerCommand } from './features';
import { welcomeSteps } from '../structure/welcome';
import { webviewPage, webviewRoots } from './webviewPage';

const shownKey = 'tsStructure.guideShown';
const doneKey = 'tsStructure.welcomeDone';

/** Links under the steps, besides the steps' own buttons. */
const extraCommands = [
  { label: 'How Do I…?', command: 'tsStructure.howDoI', icon: 'question' },
  { label: 'Shortcuts', command: 'tsStructure.shortcutSheet', icon: 'keyboard' },
  { label: 'Open the Actions View', command: 'tsStructure.actions.focus', icon: 'layout-sidebar-left' },
];

/**
 * The Code X-Ray Welcome page: animated shader lines behind the title, and the eight steps of the Getting Started
 * walkthrough as cards with their buttons and pictures. Guide Me opens it, and it opens once by itself the first
 * time the extension starts. VS Code's own walkthrough stays a link away.
 */
export function registerGuide(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  const walkthroughId = `${context.extension.id}#gettingStarted`;
  const steps = () => {
    const walkthrough = (context.extension.packageJSON.contributes?.walkthroughs ?? []).find((w: { id: string }) => w.id === 'gettingStarted');
    const read = (path: string) => {
      try {
        return fs.readFileSync(vscode.Uri.joinPath(context.extensionUri, path).fsPath, 'utf8');
      } catch {
        return undefined;
      }
    };
    return { title: walkthrough?.title ?? 'Get Started with Code X-Ray', description: walkthrough?.description ?? '', steps: welcomeSteps(walkthrough?.steps ?? [], read) };
  };
  const open = () => {
    if (panel) {
      panel.reveal();
      return;
    }
    panel = vscode.window.createWebviewPanel('tsStructure.welcome', 'Welcome to Code X-Ray', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: webviewRoots(context.extensionUri) });
    panel.iconPath = { light: vscode.Uri.joinPath(context.extensionUri, 'media', 'structure-light.svg'), dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'structure-dark.svg') };
    panel.webview.html = webviewPage(panel.webview, context.extensionUri, {
      title: 'Welcome to Code X-Ray',
      styles: ['welcome.css'],
      scripts: ['welcome.js'],
      images: true,
      body: '<canvas id="lines" aria-hidden="true"></canvas><main id="page"></main>',
    });
    const page = steps();
    const allowed = new Set([...page.steps.flatMap((s) => s.buttons.map((b) => b.command)), ...extraCommands.map((c) => c.command)]);
    const webview = panel.webview;
    panel.webview.onDidReceiveMessage(async (message: { type: string; command?: string; step?: string }) => {
      if (message.type === 'ready') {
        const send = page.steps.map((s) => ({ ...s, image: s.image && { ...s.image, src: webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, s.image.file)).toString() } }));
        void webview.postMessage({ type: 'welcome', title: page.title, description: page.description, steps: send, extra: extraCommands, done: context.globalState.get<string[]>(doneKey) ?? [] });
      } else if (message.type === 'run' && message.command && allowed.has(message.command)) {
        if (message.step) {
          const done = new Set(context.globalState.get<string[]>(doneKey) ?? []);
          done.add(message.step);
          await context.globalState.update(doneKey, [...done]);
        }
        await vscode.commands.executeCommand(message.command);
      } else if (message.type === 'walkthrough') {
        await vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthroughId, false);
      }
    });
    panel.onDidDispose(() => (panel = undefined));
  };
  context.subscriptions.push(
    registerCommand('tsStructure.guideMe', open),
    registerCommand('tsStructure.walkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthroughId, false)),
  );
  // Tests and screenshot runs start a fresh profile every time; the page would cover what they look at.
  if (!context.globalState.get(shownKey) && context.extensionMode !== vscode.ExtensionMode.Test) {
    void context.globalState.update(shownKey, true);
    open();
  }
}
