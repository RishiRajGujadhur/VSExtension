import * as vscode from 'vscode';
import { languageSelector } from './refactorCommands';
import { isFeatureEnabled } from './features';

/** TypeScript errors about values that may be null or undefined ("Object is possibly 'undefined'", "'x' is possibly 'null'"). */
const nullabilityErrors = new Set([2531, 2532, 2533, 18047, 18048, 18049]);

/** Lightbulb actions on TypeScript's own errors that open the analysis explaining them. */
export class CompilerErrorActions implements vscode.CodeActionProvider {
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(languageSelector, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
  }

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    if (!isFeatureEnabled('nullability')) {
      return actions;
    }
    for (const diagnostic of context.diagnostics) {
      const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
      if (diagnostic.source !== 'ts' || !nullabilityErrors.has(Number(code))) {
        continue;
      }
      const name = document.getText(diagnostic.range);
      const action = new vscode.CodeAction(`Explain why '${name.length > 30 ? `${name.slice(0, 29)}…` : name}' may be null or undefined`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      // The end of the range is on the last name of an access such as `user.address`, which is what the error is about.
      action.command = { command: 'tsStructure.explainFinding', title: action.title, arguments: [document.uri, document.offsetAt(diagnostic.range.end) - 1, 'tsStructure.nullability'] };
      actions.push(action);
    }
    return actions;
  }
}
