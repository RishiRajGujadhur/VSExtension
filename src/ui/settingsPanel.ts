import * as vscode from 'vscode';
import { features, enabledByDefault } from '../structure/features';
import { isFeatureEnabled, setFeature, updateSetting } from './features';
import { webviewPage, webviewRoots } from './webviewPage';
import { builtInInspections } from '../inspect/registry';
import type { Severity } from '../inspect/inspection';
import { csharpInspections } from '../csharp/inspections';
import { tsqlInspections } from '../tsql/inspections';
import { Credit, credits } from '../structure/credits';

const severityKey = 'tsStructure.inspections.severity';

/**
 * Code X-Ray Settings: one page for everything the extension can be told, in the style of an app's settings screen.
 * A sidebar of sections (Features first, then Animations and every settings group the extension contributes), a search
 * across all of them, and one row per setting: its name, what it does, and a switch, list, field or a link to VS Code's
 * settings for lists and objects. Changes are written at once and the page follows edits made anywhere else.
 *
 * The rows come from package.json (contributes.configuration), so a new setting shows up here without code.
 */

interface Row {
  key: string;
  label: string;
  /** Markdown-lite: **bold**, `code` and [links](…) are shown, the rest is text. */
  description: string;
  kind: 'boolean' | 'enum' | 'number' | 'string' | 'json' | 'severities';
  value: unknown;
  /** Changed from its default, somewhere (user or workspace). */
  modified: boolean;
  /** Where it is set: shown as a small tag when it is the workspace. */
  scope?: 'workspace';
  options?: { value: string; label: string; description?: string }[];
  min?: number;
  max?: number;
  /** A badge beside the name, such as "Core". */
  badge?: string;
  /** For Inspections: Severity: every inspection by language, with its default and the choice made. */
  severities?: { group: string; items: { id: string; title: string; byDefault: Severity; value?: string }[] }[];
}

interface Section {
  id: string;
  title: string;
  icon: string;
  description: string;
  rows: Row[];
  /** The Credits page: libraries and models, instead of settings. */
  credits?: Credit[];
}

interface ConfigProperty {
  type?: string | string[];
  enum?: unknown[];
  enumDescriptions?: string[];
  markdownEnumDescriptions?: string[];
  description?: string;
  markdownDescription?: string;
  minimum?: number;
  maximum?: number;
  order?: number;
  deprecationMessage?: string;
}

const icons: Record<string, string> = {
  Features: 'extensions',
  Animations: 'sparkle',
  General: 'settings-gear',
  Scope: 'filter',
  Inspections: 'checklist',
  Intentions: 'wand',
  'Affected tests': 'beaker',
  'Ghost exports': 'export',
  'Déjà vu': 'files',
  'Arguments passed in': 'call-incoming',
  'Side-effect notes': 'zap',
};

const blurbs: Record<string, string> = {
  Features: 'Turn parts of Code X-Ray on or off. A part that is off hides its commands, menus and actions.',
  Animations: 'Motion in the Actions view and the charts. Both also stay still when your system asks for reduced motion.',
  General: 'How results, menus and refactorings behave.',
  Scope: 'Which files the analyses look at.',
};

/** `results.followCursor` → "Results: Follow cursor". */
function labelOf(key: string): string {
  const parts = key.replace(/^(tsStructure|tsImpact)\./, '').split('.');
  const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const last = cap(words(parts.pop()!));
  return parts.length ? `${cap(parts.map(words).join(' '))}: ${last}` : last;
}

/**
 * A name and description for the row. A description that starts with its own name in bold ("**Button animations**: …")
 * gives the name; otherwise it comes from the key, without a prefix that only repeats the section (Inspections:).
 */
function titled(key: string, description: string, section: string): { label: string; description: string } {
  const named = /^\*\*([^*]+)\*\*:\s*/.exec(description);
  if (named) return { label: named[1], description: description.slice(named[0].length).replace(/^./, (c) => c.toUpperCase()) };
  const label = labelOf(key);
  const prefix = `${section.toLowerCase()}: `;
  return { label: label.toLowerCase().startsWith(prefix) ? label.slice(prefix.length).replace(/^./, (c) => c.toUpperCase()) : label, description };
}

function rowOf(key: string, property: ConfigProperty, section: string): Row | undefined {
  if (property.deprecationMessage) return undefined;
  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect(key);
  const type = Array.isArray(property.type) ? property.type[0] : property.type;
  const kind: Row['kind'] = property.enum ? 'enum' : type === 'boolean' ? 'boolean' : type === 'number' || type === 'integer' ? 'number' : type === 'string' ? 'string' : 'json';
  const enumText = property.markdownEnumDescriptions ?? property.enumDescriptions;
  if (key === severityKey) {
    // Not an object to edit as JSON: a list of every inspection with its own choice.
    const chosen = (config.get<Record<string, string>>(key) ?? {}) as Record<string, string>;
    const group = (name: string, list: readonly { id: string; title: string; severity: Severity }[]) => ({ group: name, items: list.map((i) => ({ id: i.id, title: i.title, byDefault: i.severity, value: chosen[i.id] })) });
    return {
      key,
      ...titled(key, 'How each inspection is reported, or off. Default keeps its own severity.', section),
      kind: 'severities',
      value: chosen,
      modified: inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined,
      scope: inspected?.workspaceValue !== undefined ? 'workspace' : undefined,
      severities: [
        group('TypeScript and JavaScript', builtInInspections.map((i) => ({ id: i.id, title: i.title, severity: i.defaultSeverity }))),
        group('C#', csharpInspections),
        group('T-SQL', tsqlInspections),
      ],
    };
  }
  return {
    key,
    ...titled(key, property.markdownDescription ?? property.description ?? '', section),
    kind,
    value: config.get(key),
    modified: inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined,
    scope: inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined ? 'workspace' : undefined,
    options: property.enum?.map((v, i) => ({ value: String(v), label: String(v), description: enumText?.[i] })),
    min: property.minimum,
    max: property.maximum,
  };
}

/** Every section of the page, read fresh from the settings. */
export function sections(manifest: { contributes: { configuration: { title: string; properties: Record<string, ConfigProperty> }[] } }): Section[] {
  const featureRows: Row[] = features.map((f) => {
    const key = `tsStructure.features.${f.id}`;
    const inspected = vscode.workspace.getConfiguration().inspect(key);
    return {
      key,
      label: f.title,
      description: f.description,
      kind: 'boolean',
      value: isFeatureEnabled(f.id),
      modified: inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined,
      scope: inspected?.workspaceValue !== undefined ? 'workspace' : undefined,
      badge: enabledByDefault(f) ? 'Core' : undefined,
    };
  });
  const groups = manifest.contributes.configuration
    .filter((group) => group.title !== 'Features')
    .map((group) => {
      const rows = Object.entries(group.properties)
        .sort(([, a], [, b]) => (a.order ?? 1000) - (b.order ?? 1000))
        .map(([key, property]) => rowOf(key, property, group.title))
        .filter((row): row is Row => !!row);
      return { id: group.title.toLowerCase().replace(/[^a-z]+/g, '-'), title: group.title, icon: icons[group.title] ?? 'settings', description: blurbs[group.title] ?? '', rows };
    });
  // Features first, then Animations and General, then the rest in the order the extension lists them.
  const first = ['Animations', 'General'];
  groups.sort((a, b) => (first.indexOf(a.title) + 1 || 99) - (first.indexOf(b.title) + 1 || 99));
  const creditsPage: Section = {
    id: 'credits',
    title: 'Credits',
    icon: 'heart',
    description: 'Code X-Ray is built on the work of others. These are the libraries it bundles and the models it can download, with their authors and licenses.',
    rows: [],
    credits,
  };
  return [{ id: 'features', title: 'Features', icon: icons.Features, description: blurbs.Features, rows: featureRows }, ...groups, creditsPage];
}

/** Clears a setting wherever it is set: user, workspace and folder. */
async function resetSetting(key: string): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect(key);
  if (inspected?.workspaceValue !== undefined) await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  if (inspected?.globalValue !== undefined) await config.update(key, undefined, vscode.ConfigurationTarget.Global);
}

export class SettingsPanel {
  static readonly viewType = 'tsStructure.settings';
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri, private readonly manifest: Parameters<typeof sections>[0], private readonly extensionId: string) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('tsStructure.openSettings', (section?: string) => this.open(section)),
      vscode.workspace.onDidChangeConfiguration((e) => (e.affectsConfiguration('tsStructure') || e.affectsConfiguration('tsImpact')) && this.post()),
    );
  }

  open(section?: string): void {
    if (this.panel) {
      this.panel.reveal();
      if (section) void this.panel.webview.postMessage({ type: 'show', section });
      return;
    }
    this.panel = vscode.window.createWebviewPanel(SettingsPanel.viewType, 'Code X-Ray Settings', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: webviewRoots(this.extensionUri) });
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'structure-light.svg'), dark: vscode.Uri.joinPath(media, 'structure-dark.svg') };
    this.panel.webview.html = webviewPage(this.panel.webview, this.extensionUri, {
      title: 'Code X-Ray Settings',
      styles: ['settings.css'],
      scripts: ['dom.js', 'settings.js'],
      body: '<div id="app" class="settings"></div>',
    });
    this.panel.webview.onDidReceiveMessage(async (message: { type: string; key?: string; value?: unknown; id?: string; on?: boolean; section?: string; index?: unknown; which?: string }) => {
      if (message.type === 'ready') {
        this.post(section);
      } else if (message.type === 'set' && this.known(message.key)) {
        const feature = message.key.match(/^tsStructure\.features\.(\w+)$/)?.[1];
        if (feature) await setFeature(feature, message.value === true);
        else await updateSetting(message.key, message.value);
      } else if (message.type === 'reset' && this.known(message.key)) {
        await resetSetting(message.key);
      } else if (message.type === 'features') {
        // Turn every feature on, or only the core ones.
        for (const f of features) await setFeature(f.id, message.on === true || enabledByDefault(f));
      } else if (message.type === 'json' && this.known(message.key)) {
        await vscode.commands.executeCommand('workbench.action.openSettings', message.key);
      } else if (message.type === 'severity' && typeof message.id === 'string') {
        // One inspection's choice inside the Inspections: Severity object; Default removes it.
        const current = { ...((vscode.workspace.getConfiguration().get<Record<string, string>>(severityKey) ?? {}) as Record<string, string>) };
        if (message.value === 'default' || !message.value) delete current[message.id];
        else current[message.id] = String(message.value);
        await updateSetting(severityKey, Object.keys(current).length ? current : undefined);
      } else if (message.type === 'resetSection' && typeof message.section === 'string') {
        // Every changed setting in the section back to its default.
        const target = sections(this.manifest).find((x) => x.id === message.section);
        for (const row of target?.rows.filter((r) => r.modified) ?? []) await resetSetting(row.key);
      } else if (message.type === 'copy' && this.known(message.key)) {
        await vscode.env.clipboard.writeText(message.key);
        void vscode.window.setStatusBarMessage(`Copied ${message.key}`, 3000);
      } else if (message.type === 'openCredit' && typeof message.index === 'number') {
        // Only the pages of the credits themselves: a link of the list, opened in the browser.
        const credit = credits[message.index];
        const url = message.which === 'license' ? credit?.licenseUrl : credit?.url;
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (message.type === 'openNotices') {
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(this.extensionUri, 'THIRD_PARTY_NOTICES.md'));
      } else if (message.type === 'vscodeSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.extensionId}`);
      }
    });
    this.panel.onDidDispose(() => (this.panel = undefined));
  }

  /** Only the settings the page shows can be changed from it. */
  private known(key: string | undefined): key is string {
    return !!key && sections(this.manifest).some((s) => s.rows.some((r) => r.key === key));
  }

  private post(section?: string): void {
    if (!this.panel) return;
    void Promise.resolve(this.panel.webview.postMessage({ type: 'model', sections: sections(this.manifest), section })).then(undefined, () => undefined);
  }
}
