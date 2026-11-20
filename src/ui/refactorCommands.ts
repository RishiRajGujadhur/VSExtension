import * as vscode from 'vscode';
import { explainUnsupported, otherLanguageInFront } from './otherLanguages';
import { activeFeature } from './activeFeature';
import { remedies, showProblem } from './problems';
import { ProjectService } from '../analysis/project';
import { openChangeSignature } from './changeSignaturePanel';
import { RefactorCommandProvider } from './codeActions';
import { IntentionProvider, chooseIntentions, showRewritesHere } from './intentionProvider';
import { runIntroduceParameter } from './introduceParameterUi';
import { runMoveMembers } from './moveMembersUi';
import { safeDeleteFile, safeDeleteSymbol } from './safeDeleteUi';
import { registerCommand } from './features';
import { AnalysisActionProvider } from './analysisActions';

export const languageSelector: vscode.DocumentSelector = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].map((language) => ({
  language,
  scheme: 'file',
}));

/** The active editor when it holds a TypeScript or JavaScript file on disk, otherwise an explanation. */
export function sourceEditor(): vscode.TextEditor | undefined {
  const isSource = (e: vscode.TextEditor | undefined) => !!e && vscode.languages.match(languageSelector, e.document) > 0;
  // A chart, the output or a Markdown file in front: the TypeScript file shown beside it is the one meant.
  const editor = isSource(vscode.window.activeTextEditor) ? vscode.window.activeTextEditor : vscode.window.visibleTextEditors.find(isSource);
  if (!editor || !isSource(editor)) {
    // A C# or T-SQL file in front: this command is TypeScript only; say what works in that language instead.
    const other = otherLanguageInFront();
    if (other) {
      explainUnsupported(other, activeFeature.recent());
      return undefined;
    }
    // No file open: straight to picking one (and then the symbol), instead of a message with a link to click.
    if (vscode.workspace.workspaceFolders?.length) {
      void import('./analysisActions').then((m) => m.openFileThenRun(activeFeature.recent()));
    } else {
      void showProblem('Open a folder or a TypeScript or JavaScript file first.', [remedies.openFile]);
    }
    return undefined;
  }
  return editor;
}

export function previewEnabled(): boolean {
  return vscode.workspace.getConfiguration('tsStructure').get('previewRefactorings', true);
}

/**
 * The eye button of a refactoring's picker: whether the changes open in the Refactor Preview first or apply straight
 * away, starting from the setting. Pressing it flips the choice and swaps the button's look in the picker.
 */
export class PreviewToggle {
  on = previewEnabled();
  button: vscode.QuickInputButton;

  /** `subject` is what is changed, as in "Changes" or "The delete"; `plural` picks the verbs that go with it. */
  constructor(private readonly subject = 'Changes', private readonly plural = true) {
    this.button = this.look();
  }

  /** Flips the choice if the button pressed is this one; returns whether it was. */
  pressed(button: vscode.QuickInputButton, picker: { buttons: readonly vscode.QuickInputButton[] }): boolean {
    if (button !== this.button) return false;
    this.on = !this.on;
    const old = this.button;
    this.button = this.look();
    picker.buttons = picker.buttons.map((b) => (b === old ? this.button : b));
    return true;
  }

  private look(): vscode.QuickInputButton {
    const [open, apply, them] = this.plural ? ['open', 'apply', 'them'] : ['opens', 'applies', 'it'];
    return {
      iconPath: new vscode.ThemeIcon(this.on ? 'eye' : 'eye-closed'),
      tooltip: this.on ? `${this.subject} ${open} in the Refactor Preview first (click to apply straight away)` : `${this.subject} ${apply} straight away (click to preview ${them} first)`,
    };
  }
}

export function registerRefactorings(context: vscode.ExtensionContext, projects: ProjectService): void {
  context.subscriptions.push(
    registerCommand('tsStructure.changeSignature', () => {
      const editor = sourceEditor();
      if (editor) {
        return openChangeSignature(context, projects, editor);
      }
    }),
    registerCommand('tsStructure.safeDelete', () => {
      const editor = sourceEditor();
      if (editor) {
        return safeDeleteSymbol(projects, editor);
      }
    }),
    registerCommand('tsStructure.chooseIntentions', chooseIntentions),
    registerCommand('tsStructure.showRewrites', showRewritesHere),
    // With several files selected in the Explorer, each is checked and deleted in turn.
    registerCommand('tsStructure.safeDeleteFile', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      for (const file of selected?.length ? selected : [uri]) {
        await safeDeleteFile(projects, file);
      }
    }),
    registerCommand('tsStructure.moveMembers', () => {
      const editor = sourceEditor();
      if (editor) {
        return runMoveMembers(projects, editor, context.workspaceState);
      }
    }),
    registerCommand('tsStructure.introduceOptionalParameter', () => {
      const editor = sourceEditor();
      if (editor) {
        return runIntroduceParameter(projects, editor, context.workspaceState, 'optional');
      }
    }),
    registerCommand('tsStructure.introduceParameter', () => {
      const editor = sourceEditor();
      if (editor) {
        return runIntroduceParameter(projects, editor, context.workspaceState);
      }
    }),
    vscode.languages.registerCodeActionsProvider(languageSelector, new RefactorCommandProvider(), {
      providedCodeActionKinds: RefactorCommandProvider.kinds,
    }),
    vscode.languages.registerCodeActionsProvider(languageSelector, new AnalysisActionProvider(), {
      providedCodeActionKinds: AnalysisActionProvider.kinds,
    }),
    vscode.languages.registerCodeActionsProvider(languageSelector, new IntentionProvider(), {
      providedCodeActionKinds: IntentionProvider.kinds,
    }),
  );
}
