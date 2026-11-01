import * as vscode from 'vscode';
import { Feature, featureOf, features } from '../structure/features';

export function isFeatureEnabled(id: string): boolean {
  return vscode.workspace.getConfiguration('tsStructure.features').get(id, true);
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
  const choice = await vscode.window.showInformationMessage(`${feature.title} is turned off in the TypeScript Structure settings.`, 'Turn On', 'Choose Features…');
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
  // A feature that is on by default is turned back on by removing the override.
  await config.update(id, enabled && inspected?.defaultValue === true ? undefined : enabled, target);
}

/** A checklist of every feature; unticking one hides its commands, menus, lenses and lightbulb entries. */
export async function configureFeatures(): Promise<void> {
  type Item = vscode.QuickPickItem & { feature: Feature };
  const items: Item[] = features.map((feature) => ({ label: feature.title, detail: feature.description, picked: isFeatureEnabled(feature.id), feature }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'TypeScript Structure Features',
    placeHolder: 'Untick the features you don’t use',
    canPickMany: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  const on = new Set(picked.map((p) => p.feature.id));
  const changed = features.filter((f) => on.has(f.id) !== isFeatureEnabled(f.id));
  for (const feature of changed) {
    await setFeature(feature.id, on.has(feature.id));
  }
  if (changed.length > 0) {
    void vscode.window.setStatusBarMessage(`TypeScript Structure: ${on.size} of ${features.length} features on`, 4000);
  }
}
