import * as vscode from 'vscode';
import { registerCommand } from './features';

const shownKey = 'tsStructure.guideShown';

/** The Getting Started walkthrough: opened by Guide Me, and once on its own the first time the extension starts. */
export function registerGuide(context: vscode.ExtensionContext): void {
  const open = () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false);
  context.subscriptions.push(registerCommand('tsStructure.guideMe', open));
  // Tests and screenshot runs start a fresh profile every time; the guide would cover what they look at.
  if (!context.globalState.get(shownKey) && context.extensionMode !== vscode.ExtensionMode.Test) {
    void context.globalState.update(shownKey, true);
    void open();
  }
}
