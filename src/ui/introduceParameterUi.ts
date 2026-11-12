import * as vscode from 'vscode';
import { remedies, showProblem } from './problems';
import { ProjectService } from '../analysis/project';
import { isValidIdentifier } from '../refactor/common';
import { IntroduceParameterOptions, describeIntroduceParameter, introduceParameter } from '../refactor/introduceParameter';
import { applyRefactor, reportError } from './applyRefactor';
import { previewEnabled } from './refactorCommands';

const lastModeKey = 'tsStructure.introduceParameter.mode';

export async function runIntroduceParameter(projects: ProjectService, editor: vscode.TextEditor, memento?: vscode.Memento, fixedMode?: 'required' | 'optional'): Promise<void> {
  const document = editor.document;
  const start = document.offsetAt(editor.selection.start);
  const end = document.offsetAt(editor.selection.end);
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const version = document.version;
  try {
    const info = describeIntroduceParameter(projects.createVirtualProject(document.uri.fsPath, root), document.uri.fsPath, start, end);
    const short = info.expression.length > 40 ? `${info.expression.slice(0, 37)}…` : info.expression;

    const name = await vscode.window.showInputBox({
      title: `Make it a parameter of ${info.functionName}`,
      prompt: `New parameter for ${short}${info.type ? ` (${info.type})` : ''}`,
      value: info.suggestedName,
      valueSelection: [0, info.suggestedName.length],
      validateInput: (value) =>
        /\s/.test(value.trim()) ? `Names can't contain spaces: try ${camel(value)}.` : !isValidIdentifier(value.trim()) ? 'Enter a valid name: letters, digits, _ or $, not starting with a digit.' : info.usedNames.includes(value.trim()) ? `'${value.trim()}' is already used in ${info.functionName}.` : undefined,
    });
    if (!name) {
      return;
    }

    // The last choice comes first, so Enter repeats it.
    const last = memento?.get<'required' | 'optional'>(lastModeKey);
    const modes = [
      { label: 'Required', description: `callers pass ${short}${info.type ? `: ${info.type}` : ''}`, detail: 'Every call gets the expression as a new argument, so the function no longer computes it itself.', mode: 'required' as const },
      { label: 'Optional', description: `default value = ${short}; callers unchanged`, detail: 'The expression becomes the default value, so existing calls keep working and new callers may pass something else.', mode: 'optional' as const },
    ].sort((a, b) => Number(b.mode === last) - Number(a.mode === last));
    const mode = fixedMode ? modes.find((m) => m.mode === fixedMode) : await vscode.window.showQuickPick(modes, { title: `Make '${name.trim()}' a parameter`, placeHolder: 'How should existing callers supply the value?' });
    if (!mode) {
      return;
    }
    void memento?.update(lastModeKey, mode.mode);

    let replaceAll = false;
    if (info.occurrences > 1) {
      const lastAll = memento?.get<boolean>('tsStructure.introduceParameter.replaceAll', true);
      const choice = await vscode.window.showQuickPick(
        [
          { label: `Replace all ${info.occurrences} occurrences`, detail: 'Every copy of the expression in the function becomes the parameter.', all: true },
          { label: 'Replace this occurrence only', detail: 'Only the selected expression; the other copies stay as they are.', all: false },
        ].sort((a, b) => Number(b.all === lastAll) - Number(a.all === lastAll)),
        { title: `${short} occurs ${info.occurrences} times in ${info.functionName}` },
      );
      if (!choice) {
        return;
      }
      replaceAll = choice.all;
      void memento?.update('tsStructure.introduceParameter.replaceAll', choice.all);
    }

    if (document.version !== version) {
      void showProblem('The file changed while Make it a parameter was open.', [remedies.runAgain('tsStructure.introduceParameter')], 'warning');
      return;
    }
    const options: IntroduceParameterOptions = { name: name.trim(), mode: mode.mode, replaceAll };
    const result = introduceParameter(projects.createVirtualProject(document.uri.fsPath, root), document.uri.fsPath, start, end, options);
    if (await applyRefactor(result, previewEnabled())) {
      const files = result.changes.length;
      void vscode.window.setStatusBarMessage(`Added parameter ${options.name} to ${info.functionName}${mode.mode === 'required' && files > 1 ? `, and its callers in ${files - 1} other file${files === 2 ? '' : 's'}` : ''}`, 5000);
    }
  } catch (error) {
    reportError(error, 'Make it a parameter');
  }
}

/** "total price" as totalPrice: what a name with spaces would be as an identifier. */
function camel(text: string): string {
  const words = text.trim().split(/[\s_-]+/).filter(Boolean);
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('');
}
