import * as vscode from 'vscode';

/**
 * Shows the quick pick and waits for the answer: what `accepted` reads from it when the person accepts, or undefined
 * when they close it. The picker is disposed either way.
 */
export async function awaitPick<T extends vscode.QuickPickItem, R>(picker: vscode.QuickPick<T>, accepted: (picker: vscode.QuickPick<T>) => R): Promise<R | undefined> {
  try {
    return await new Promise<R | undefined>((resolve) => {
      picker.onDidAccept(() => resolve(accepted(picker)));
      picker.onDidHide(() => resolve(undefined));
      picker.show();
    });
  } finally {
    picker.dispose();
  }
}

/** The ticked items of a multi-select pick. */
export const ticked = <T extends vscode.QuickPickItem>(picker: vscode.QuickPick<T>): readonly T[] => picker.selectedItems;
