import * as vscode from 'vscode';
import { remedies, showProblem } from './problems';
import { ProjectService } from '../analysis/project';
import { isValidIdentifier } from '../refactor/common';
import { IntroduceParameterOptions, describeIntroduceParameter, introduceParameter } from '../refactor/introduceParameter';
import { applyRefactor, reportError } from './applyRefactor';
import { previewEnabled } from './refactorCommands';
import { BACK, Flow, camelName, finished, inputStep, pickStep } from './editFlow';

const command = 'tsStructure.introduceParameter';
const lastModeKey = 'tsStructure.introduceParameter.mode';
const reserved = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await'.split(' '));

/**
 * Make it a parameter: a name, how callers supply the value, and (when the expression repeats) which copies change.
 * Each step has Back, help, and stays open while you look at the code.
 */
export async function runIntroduceParameter(projects: ProjectService, editor: vscode.TextEditor, memento?: vscode.Memento, fixedMode?: 'required' | 'optional'): Promise<void> {
  // Nothing selected: the expression at the cursor is selected first, as Expand Selection would.
  if (editor.selection.isEmpty) await vscode.commands.executeCommand('editor.action.smartSelect.expand');
  const document = editor.document;
  const start = document.offsetAt(editor.selection.start);
  const end = document.offsetAt(editor.selection.end);
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const version = document.version;
  try {
    const info = describeIntroduceParameter(projects.createVirtualProject(document.uri.fsPath, root), document.uri.fsPath, start, end);
    const short = info.expression.length > 40 ? `${info.expression.slice(0, 37)}…` : info.expression;
    const flow: Flow = { command, subject: info.functionName, steps: 1 + (fixedMode ? 0 : 1) + (info.occurrences > 1 ? 1 : 0) };
    // Names to offer: the suggested one, one from the type, one from the expression's last word.
    const fromType = info.type ? info.type.replace(/\[\]$/, 's').replace(/<.*$/, '').replace(/[^A-Za-z0-9_$]/g, '') : '';
    const lastWord = (info.expression.match(/[A-Za-z_$][\w$]*(?=[^\w$]*$)/) ?? [''])[0];
    const suggestions = [info.suggestedName, fromType && fromType[0].toLowerCase() + fromType.slice(1), lastWord, 'value'].filter((n) => n && isValidIdentifier(n) && !reserved.has(n) && !info.usedNames.includes(n));
    const freeName = (name: string) => { let i = 2; while (info.usedNames.includes(`${name}${i}`)) i++; return `${name}${i}`; };

    let step = 1;
    let name = info.suggestedName;
    let mode: 'required' | 'optional' = fixedMode ?? memento?.get<'required' | 'optional'>(lastModeKey) ?? 'required';
    let replaceAll = memento?.get<boolean>('tsStructure.introduceParameter.replaceAll', true) ?? true;
    let preview = previewEnabled();
    const steps: (() => Promise<boolean | typeof BACK | undefined>)[] = [
      async () => {
        const value = await inputStep(flow, step, {
          what: 'name',
          prompt: `New parameter for ${short}${info.type ? ` (${info.type})` : ''}. Spaces become camelCase; the bulb button offers other names.`,
          value: name,
          valueSelection: [0, name.length],
          suggestions,
          normalize: camelName,
          validate: (v) =>
            !v ? 'Enter a name.' : reserved.has(v) ? `'${v}' is a reserved word: try ${freeName(v)}.` : !isValidIdentifier(v) ? 'Use letters, digits, _ or $, not starting with a digit.' : info.usedNames.includes(v) ? `'${v}' is already used in ${info.functionName}: try ${freeName(v)}.` : undefined,
        });
        if (value === BACK || value === undefined) return value;
        name = value;
        return true;
      },
      ...(fixedMode ? [] : [async () => {
        const last = memento?.get<'required' | 'optional'>(lastModeKey);
        const modes = [
          { label: '$(arrow-right) Required', description: `callers pass ${short}${info.type ? `: ${info.type}` : ''}${last === 'required' ? ' · last used' : ''}`, detail: 'Every call gets the expression as a new argument, so the function no longer computes it itself.', mode: 'required' as const },
          { label: '$(symbol-parameter) Optional', description: `default value = ${short}; callers unchanged${last === 'optional' ? ' · last used' : ''}`, detail: 'The expression becomes the default value, so existing calls keep working and new callers may pass something else.', mode: 'optional' as const },
        ];
        const picked = await pickStep(flow, step, modes, { what: `how callers supply ${name}`, placeholder: 'How should existing callers supply the value? Enter repeats your last choice.', active: modes.find((m) => m.mode === mode) });
        if (picked === BACK || picked === undefined) return picked;
        mode = picked[0].mode;
        void memento?.update(lastModeKey, mode);
        return true;
      }]),
      ...(info.occurrences > 1 ? [async () => {
        const previewLook = (): vscode.QuickInputButton => ({ iconPath: new vscode.ThemeIcon(preview ? 'eye' : 'eye-closed'), tooltip: preview ? 'Changes open in the Refactor Preview first (click to apply straight away)' : 'Changes apply straight away (click to preview them first)' });
        let previewButton = previewLook();
        const choices = [
          { label: `$(replace-all) Replace all ${info.occurrences} occurrences`, detail: 'Every copy of the expression in the function becomes the parameter.', all: true },
          { label: '$(replace) Replace this occurrence only', detail: 'Only the selected expression; the other copies stay as they are.', all: false },
        ];
        const picked = await pickStep(flow, step, choices, {
          what: `${info.occurrences} copies`,
          placeholder: `${short} appears ${info.occurrences} times in ${info.functionName}`,
          active: choices.find((c) => c.all === replaceAll),
          buttons: [previewButton],
          onButton: (button, picker) => {
            if (button !== previewButton) return;
            preview = !preview;
            const old = previewButton;
            previewButton = previewLook();
            picker.buttons = picker.buttons.map((x) => (x === old ? previewButton : x));
            picker.placeholder = `${short} appears ${info.occurrences} times · ${preview ? 'preview first' : 'apply straight away'}`;
          },
        });
        if (picked === BACK || picked === undefined) return picked;
        replaceAll = picked[0].all;
        void memento?.update('tsStructure.introduceParameter.replaceAll', replaceAll);
        return true;
      }] : []),
    ];
    while (step <= steps.length) {
      const result = await steps[step - 1]();
      if (result === undefined) return;
      step = result === BACK ? Math.max(1, step - 1) : step + 1;
    }

    if (document.version !== version) {
      void showProblem('The file changed while Make it a parameter was open.', [remedies.runAgain(command)], 'warning');
      return;
    }
    const options: IntroduceParameterOptions = { name, mode, replaceAll };
    const result = introduceParameter(projects.createVirtualProject(document.uri.fsPath, root), document.uri.fsPath, start, end, options);
    if (await applyRefactor(result, preview)) {
      const files = result.changes.length;
      void finished(command, `added ${name} to ${info.functionName}${mode === 'required' && files > 1 ? `, and its callers in ${files - 1} other file${files === 2 ? '' : 's'}` : ''}.`, {
        file: document.uri.fsPath,
        changed: files,
        extra: { label: 'Change signature…', run: () => vscode.commands.executeCommand('tsStructure.changeSignature') },
      });
    }
  } catch (error) {
    reportError(error, 'Make it a parameter');
  }
}
