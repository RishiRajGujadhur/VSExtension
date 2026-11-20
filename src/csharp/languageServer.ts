import * as path from 'path';
import * as vscode from 'vscode';
import { hashText, normalizePath } from '../analysis/paths';
import { AnalysisError } from '../analysis/types';
import { csharpUsagesByName } from './nameSearch';
import { Report, ReportLocation, ReportNode, plural } from '../structure/report';
import { CallDirection, callGraphControls } from '../navigate/callGraph';
import { classifyCSharpUsage } from './usageKind';
import { Usage, UsageKind, isTestPath, usageReport } from '../structure/usageReport';

/**
 * C# through the language server the C# extension (or C# Dev Kit) runs: Find usages, Callers and calls and the family
 * tree, built from VS Code's standard reference, definition, call hierarchy, type hierarchy and symbol providers. The
 * reports have the same shape as the TypeScript ones, so the results view, the card and the charts show them as usual.
 *
 * Everything stays on the computer: these are the language server's own answers, nothing is guessed.
 */

export const isCSharp = (document: vscode.TextDocument): boolean => document.languageId === 'csharp';

/** Said when the language server has nothing: the C# extension is missing, or still loading the project. */
export class NoLanguageServer extends AnalysisError {
  constructor(what: string) {
    super(`No ${what} from the C# language server. Install the C# extension (or C# Dev Kit), or wait until it has loaded the project, then try again.`);
  }
}

const isTestFile = isTestPath;

/** Files read once per report: their text for code lines, hash for stale checks, and symbols for "in which method". */
class Sources {
  private readonly documents = new Map<string, vscode.TextDocument>();
  private readonly symbols = new Map<string, vscode.DocumentSymbol[]>();
  readonly hashes: Record<string, string> = {};

  async document(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const key = uri.toString();
    let document = this.documents.get(key);
    if (!document) {
      document = await vscode.workspace.openTextDocument(uri);
      this.documents.set(key, document);
      this.hashes[normalizePath(uri.fsPath)] = hashText(document.getText());
    }
    return document;
  }

  async location(uri: vscode.Uri, range: vscode.Range): Promise<ReportLocation> {
    await this.document(uri);
    return { file: normalizePath(uri.fsPath), line: range.start.line, character: range.start.character, endLine: range.end.line, endCharacter: range.end.character };
  }

  /** The trimmed code line, shortened. */
  async line(uri: vscode.Uri, line: number): Promise<string> {
    const text = (await this.document(uri)).lineAt(line).text.trim();
    return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  }

  /** The innermost method, property, constructor or type around the position, by name. */
  async enclosing(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
    const key = uri.toString();
    let symbols = this.symbols.get(key);
    if (!symbols) {
      const found = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri);
      symbols = (found ?? []).filter((s): s is vscode.DocumentSymbol => 'children' in s);
      this.symbols.set(key, symbols);
    }
    let name: string | undefined;
    let level: vscode.DocumentSymbol[] = symbols;
    for (;;) {
      const inside = level.find((s) => s.range.contains(position));
      if (!inside) return name;
      name = name && inside.kind !== vscode.SymbolKind.Class && inside.kind !== vscode.SymbolKind.Struct ? `${name}.${inside.name}` : inside.name;
      level = inside.children;
    }
  }
}



const asLocations = (found: (vscode.Location | vscode.LocationLink)[] | vscode.Location | undefined): vscode.Location[] =>
  (Array.isArray(found) ? found : found ? [found] : []).map((l) => ('targetUri' in l ? new vscode.Location(l.targetUri, l.targetSelectionRange ?? l.targetRange) : l));

const workspaceRoot = (uri: vscode.Uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;

/** Find usages: every reference the language server knows, by what it does and by file. */
export async function csharpUsagesReport(document: vscode.TextDocument, position: vscode.Position): Promise<Report> {
  const word = document.getWordRangeAtPosition(position);
  const name = word ? document.getText(word) : 'symbol';
  const [references, definitions] = await Promise.all([
    vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', document.uri, position),
    vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', document.uri, position),
  ]);
  const defs = asLocations(definitions);
  const all = [...(references ?? [])];
  // The definition is usually among the references; a slightly different range for it (with the `;`, say) is still it.
  for (const d of defs) if (!all.some((r) => r.uri.toString() === d.uri.toString() && r.range.intersection(d.range))) all.push(d);
  // No language server answered (no C# extension, or the solution still loading): find the name instead.
  if (!all.length) return usagesByName(document, position, name);

  const sources = new Sources();
  const usages: Usage[] = [];
  for (const location of all) {
    const text = (await sources.document(location.uri)).lineAt(location.range.start.line).text;
    const kind: UsageKind = defs.some((d) => d.uri.toString() === location.uri.toString() && d.range.intersection(location.range))
      ? 'definition'
      : classifyCSharpUsage(text, location.range.start.character, location.range.end.character);
    usages.push({
      kind,
      location: await sources.location(location.uri, location.range),
      line: text.trim(),
      where: await sources.enclosing(location.uri, location.range.start),
      atCursor: location.uri.toString() === document.uri.toString() && location.range.contains(position),
    });
  }
  const folderOf = (file: string) => {
    const root = workspaceRoot(vscode.Uri.file(file));
    return root ? path.relative(root, path.dirname(file)).split(path.sep).join('/') || '.' : '';
  };
  return usageReport(name, usages, folderOf, sources.hashes);
}

const callKey = (item: vscode.CallHierarchyItem) => `${item.uri.toString()}#${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
const maxPerLevel = 25;

/** Callers and calls: the language server's call hierarchy, a few levels each way. */
export async function csharpCallGraphReport(document: vscode.TextDocument, position: vscode.Position, options: { depth: number; direction: CallDirection }): Promise<Report> {
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', document.uri, position);
  const root = items?.[0];
  if (!root) throw new NoLanguageServer('call hierarchy here: put the cursor on a method');
  const sources = new Sources();
  let omitted = 0;
  const node = async (item: vscode.CallHierarchyItem, ranges: vscode.Range[], children: ReportNode[] | undefined): Promise<ReportNode> => ({
    label: item.name,
    description: `${path.basename(item.uri.fsPath)}:${item.selectionRange.start.line + 1}${ranges.length > 1 ? ` · ${ranges.length} calls` : ''}${isTestFile(item.uri.fsPath) ? ' · test' : ''}`,
    tooltip: item.detail,
    icon: item.kind === vscode.SymbolKind.Constructor ? 'symbol-constructor' : item.kind === vscode.SymbolKind.Property ? 'symbol-property' : 'symbol-method',
    location: await sources.location(item.uri, item.selectionRange),
    expanded: true,
    children,
  });
  async function walk(item: vscode.CallHierarchyItem, level: number, seen: Set<string>, incoming: boolean): Promise<ReportNode[]> {
    const calls = incoming
      ? (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item)) ?? []
      : (await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item)) ?? [];
    const shown = calls.slice(0, maxPerLevel);
    omitted += calls.length - shown.length;
    const nodes: ReportNode[] = [];
    for (const call of shown) {
      const other = 'from' in call ? call.from : call.to;
      const key = callKey(other);
      const again = seen.has(key);
      const deeper = !again && level < options.depth ? await walk(other, level + 1, new Set([...seen, key]), incoming) : undefined;
      const n = await node(other, call.fromRanges, deeper?.length ? deeper : undefined);
      if (again) n.description += ' · shown above';
      nodes.push(n);
    }
    return nodes;
  }
  const start = new Set([callKey(root)]);
  const roots: ReportNode[] = [];
  const summary: string[] = [];
  if (options.direction !== 'callees') {
    const callers = await walk(root, 1, start, true);
    const files = new Set(callers.map((c) => c.location?.file));
    roots.push({ label: 'Called by', description: callers.length ? `${plural(callers.length, 'caller')} in ${plural(files.size, 'file')}` : 'nothing in the solution calls it', icon: 'call-incoming', expanded: true, children: callers });
    summary.push(plural(callers.length, 'caller'));
  }
  if (options.direction !== 'callers') {
    const callees = await walk(root, 1, start, false);
    const files = new Set(callees.map((c) => c.location?.file));
    roots.push({ label: 'Calls', description: callees.length ? `${plural(callees.length, 'function')} in ${plural(files.size, 'file')}` : 'no methods of the solution', icon: 'call-outgoing', expanded: true, children: callees });
    summary.push(plural(callees.length, 'callee'));
  }
  const subject = await sources.location(root.uri, root.selectionRange);
  return {
    kind: 'callGraph',
    title: `Call graph of ${root.name}`,
    description: [...summary, plural(options.depth, 'level')].join(', '),
    roots,
    warnings: omitted ? [`${plural(omitted, 'call')} left out: only the first ${maxPerLevel} are listed at each step.`] : [],
    fileHashes: sources.hashes,
    subject,
    controls: callGraphControls(options.depth, options.direction),
  };
}

const typeIcon = (kind: vscode.SymbolKind) =>
  kind === vscode.SymbolKind.Interface ? 'symbol-interface' : kind === vscode.SymbolKind.Struct ? 'symbol-structure' : kind === vscode.SymbolKind.Enum ? 'symbol-enum' : 'symbol-class';
const typeWord = (kind: vscode.SymbolKind) => (kind === vscode.SymbolKind.Interface ? 'interface' : kind === vscode.SymbolKind.Struct ? 'struct' : kind === vscode.SymbolKind.Enum ? 'enum' : 'class');

/** Family tree: supertypes, subtypes and implementations from the language server's type hierarchy, and the members. */
export async function csharpHierarchyReport(document: vscode.TextDocument, position: vscode.Position): Promise<Report> {
  const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.prepareTypeHierarchy', document.uri, position);
  const target = items?.[0];
  if (!target) throw new NoLanguageServer('type hierarchy here: put the cursor on a class or interface');
  const sources = new Sources();
  const levels = 4;
  async function walk(item: vscode.TypeHierarchyItem, up: boolean, level: number, seen: Set<string>): Promise<ReportNode[]> {
    const found = (await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(up ? 'vscode.provideSupertypes' : 'vscode.provideSubtypes', item)) ?? [];
    const nodes: ReportNode[] = [];
    for (const t of found.slice(0, maxPerLevel)) {
      const key = `${t.uri.toString()}#${t.selectionRange.start.line}`;
      const deeper = !seen.has(key) && level < levels ? await walk(t, up, level + 1, new Set([...seen, key])) : [];
      nodes.push({
        label: t.name,
        description: `${typeWord(t.kind)} · ${path.basename(t.uri.fsPath)}:${t.selectionRange.start.line + 1}`,
        tooltip: t.detail,
        icon: typeIcon(t.kind),
        location: await sources.location(t.uri, t.selectionRange),
        expanded: true,
        children: deeper.length ? deeper : undefined,
      });
    }
    return nodes;
  }
  const start = new Set([`${target.uri.toString()}#${target.selectionRange.start.line}`]);
  const [supers, subs] = await Promise.all([walk(target, true, 1, start), walk(target, false, 1, start)]);
  // Members, from the file's outline.
  const outline = (await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', target.uri)) ?? [];
  const find = (list: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
    for (const s of list) {
      if (s.selectionRange.intersection(target.selectionRange)) return s;
      const inner = find(s.children ?? []);
      if (inner) return inner;
    }
    return undefined;
  };
  const self = find(outline.filter((s): s is vscode.DocumentSymbol => 'children' in s));
  const members: ReportNode[] = [];
  for (const m of self?.children ?? []) {
    members.push({ label: m.name, description: m.detail || vscode.SymbolKind[m.kind].toLowerCase(), icon: `symbol-${vscode.SymbolKind[m.kind].toLowerCase()}`, location: await sources.location(target.uri, m.selectionRange) });
  }
  const roots: ReportNode[] = [
    { label: `${typeWord(target.kind)} ${target.name}`, description: `${path.basename(target.uri.fsPath)}:${target.selectionRange.start.line + 1}`, icon: typeIcon(target.kind), tone: 'ok', location: await sources.location(target.uri, target.selectionRange) },
    { label: 'Supertypes', description: plural(supers.length, 'type'), icon: 'type-hierarchy-super', expanded: true, children: supers.length ? supers : [{ label: 'none', icon: 'dash' }] },
    { label: 'Subtypes and implementations', description: plural(subs.length, 'type'), icon: 'type-hierarchy-sub', expanded: true, children: subs.length ? subs : [{ label: 'none in this solution', icon: 'dash' }] },
    { label: 'Members', description: plural(members.length, 'member'), icon: 'symbol-field', expanded: true, children: members },
  ];
  return {
    kind: 'hierarchy',
    title: `Hierarchy of ${target.name}`,
    description: `${plural(supers.length, 'supertype')}, ${plural(subs.length, 'subtype')}, ${plural(members.length, 'member')}`,
    roots,
    warnings: [],
    fileHashes: sources.hashes,
  };
}

/** Find usages by name, with the bundled parser, in the workspace's C# files: for when no language server answers. */
async function usagesByName(document: vscode.TextDocument, position: vscode.Position, name: string): Promise<Report> {
  if (!/^@?[A-Za-z_]\w*$/.test(name)) throw new AnalysisError('Put the cursor on a name: a class, method, property, field, variable or parameter.');
  const uris = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**,**/node_modules/**,**/.git/**}', 4000);
  const open = new Map(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file').map((d) => [normalizePath(d.uri.fsPath), d]));
  const here = normalizePath(document.uri.fsPath);
  const files: { file: string; text: string }[] = [{ file: here, text: document.getText() }];
  for (const uri of uris) {
    const file = normalizePath(uri.fsPath);
    if (file === here) continue;
    const text = open.get(file)?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    files.push({ file, text });
  }
  const usages = await csharpUsagesByName(files, name.replace(/^@/, ''), { file: here, offset: document.offsetAt(position) });
  if (!usages.length) throw new AnalysisError(`No ${name} found in the workspace's C# files.`);
  const hashes = Object.fromEntries(files.filter((f) => usages.some((u) => u.location.file === f.file)).map((f) => [f.file, hashText(f.text)]));
  const folderOf = (file: string) => {
    const root = workspaceRoot(vscode.Uri.file(file));
    return root ? path.relative(root, path.dirname(file)).split(path.sep).join('/') || '.' : '';
  };
  const report = usageReport(name, usages, folderOf, hashes);
  report.warnings.push('Found by name: no C# language server answered, so other symbols with the same name are included. Install the C# extension (or C# Dev Kit) for exact results.');
  return report;
}
