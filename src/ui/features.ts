import * as vscode from 'vscode';
import { Feature, enabledByDefault, featureOf, features } from '../structure/features';
import { featureIcon } from '../structure/icons';

export function isFeatureEnabled(id: string): boolean {
  const feature = features.find((f) => f.id === id);
  return vscode.workspace.getConfiguration('tsStructure.features').get(id, !feature || enabledByDefault(feature));
}

/**
 * Registers a command that is refused while its feature is turned off. Menus already hide such
 * commands; this covers keybindings, other extensions and links in reports and lenses.
 */
export function registerCommand(id: string, handler: (...args: any[]) => unknown): vscode.Disposable {
  const feature = featureOf(id);
  return vscode.commands.registerCommand(id, (...args: unknown[]) => {
    if (feature && !isFeatureEnabled(feature.id)) {
      void offerToEnable(feature);
      return undefined;
    }
    return handler(...args);
  });
}

async function offerToEnable(feature: Feature): Promise<void> {
  const off = enabledByDefault(feature) ? 'is turned off' : 'is an optional feature, off by default,';
  const choice = await vscode.window.showInformationMessage(`${feature.title} ${off} in the TypeScript Structure settings.`, 'Turn On', 'Choose Features…');
  if (choice === 'Turn On') {
    await setFeature(feature.id, true);
  } else if (choice) {
    await configureFeatures();
  }
}

/** Writes where the setting is already set, so a workspace override is not shadowed by a user setting. */
async function setFeature(id: string, enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('tsStructure.features');
  const inspected = config.inspect<boolean>(id);
  const target =
    inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  // Going back to the default removes the override instead of writing it out.
  await config.update(id, enabled === inspected?.defaultValue ? undefined : enabled, target);
}

/** Where each feature's own settings are, for its gear button in Choose Features. */
const featureSettings: Record<string, string> = {
  testImpact: 'tsImpact.',
  intentions: 'tsStructure.intentions',
  inspections: 'tsStructure.inspections',
  sideEffects: 'tsStructure.codeLens',
  deadExports: 'tsStructure.deadExports',
  duplicates: 'tsStructure.duplicates',
  argumentFlow: 'tsStructure.argumentFlow',
  refactorings: 'tsStructure.previewRefactorings',
};

/** A checklist of every feature; unticking one hides its commands, menus, lenses and lightbulb entries. */
export async function configureFeatures(): Promise<void> {
  type Item = vscode.QuickPickItem & { feature?: Feature };
  const item = (feature: Feature): Item => ({ label: `$(${featureIcon(feature)}) ${feature.title}`, detail: feature.description, picked: isFeatureEnabled(feature.id), feature });
  const items: Item[] = [
    { label: 'Core', kind: vscode.QuickPickItemKind.Separator },
    ...features.filter(enabledByDefault).map(item),
    { label: 'More features (off by default)', kind: vscode.QuickPickItemKind.Separator },
    ...features.filter((f) => !enabledByDefault(f)).map(item),
  ];
  // Title buttons tick everything or go back to the defaults; each feature's gear opens its settings.
  const allOn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check-all'), tooltip: 'Turn All On' };
  const defaults: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('discard'), tooltip: 'Back to Defaults' };
  const settings: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('gear'), tooltip: 'Settings of This Feature' };
  const picker = vscode.window.createQuickPick<Item>();
  picker.title = 'TypeScript Structure Features';
  picker.placeholder = 'Tick the features you want; the rest stay out of your menus';
  picker.canSelectMany = true;
  picker.matchOnDetail = true;
  picker.items = items.map((i) => (i.feature ? { ...i, buttons: [settings] } : i));
  picker.selectedItems = picker.items.filter((i) => i.picked);
  picker.buttons = [allOn, defaults];
  picker.onDidTriggerButton((button) => {
    picker.selectedItems = picker.items.filter((i) => i.feature && (button === allOn || enabledByDefault(i.feature)));
  });
  picker.onDidTriggerItemButton((e) => {
    picker.hide();
    void vscode.commands.executeCommand('workbench.action.openSettings', featureSettings[e.item.feature!.id] ?? `tsStructure.features.${e.item.feature!.id}`);
  });
  const picked = await new Promise<readonly Item[] | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems));
    picker.onDidHide(() => resolve(undefined));
    picker.show();
  });
  picker.dispose();
  if (!picked) {
    return;
  }
  const on = new Set(picked.flatMap((p) => (p.feature ? [p.feature.id] : [])));
  const changed = features.filter((f) => on.has(f.id) !== isFeatureEnabled(f.id));
  for (const feature of changed) {
    await setFeature(feature.id, on.has(feature.id));
  }
  if (changed.length > 0) {
    void vscode.window.setStatusBarMessage(`TypeScript Structure: ${on.size} of ${features.length} features on`, 4000);
  }
}
