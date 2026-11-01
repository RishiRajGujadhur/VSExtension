import * as ts from 'typescript';
import * as vscode from 'vscode';
import { ProjectService } from '../analysis/project';
import { normalizePath } from '../analysis/paths';
import { EffectAnalyzer, EffectKind, mutationKinds } from '../inspect/effects';
import { isFunctionWithBody } from '../structure/util';
import { languageSelector } from './refactorCommands';

const shortLabels: Record<EffectKind, string> = {
  'mutates-parameter': 'mutates arguments',
  'mutates-this': 'mutates this',
  'mutates-module': 'mutates module state',
  'mutates-import': 'mutates imports',
  'mutates-captured': 'mutates captured state',
  'writes-global': 'writes globals',
  global: 'reads globals',
  io: 'I/O',
  timer: 'timers',
  nondeterministic: 'nondeterministic',
};

/** Named functions and methods worth a lens: declarations, class members and `const f = () => …`. */
function lensTargets(sourceFile: ts.SourceFile): { fn: ts.Node & { body?: ts.Node }; anchor: ts.Node }[] {
  const targets: { fn: ts.Node & { body?: ts.Node }; anchor: ts.Node }[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && node.name) {
      targets.push({ fn: node, anchor: node.name });
    } else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isIdentifier(node.name)) {
      targets.push({ fn: node.initializer, anchor: node.name });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
}

/** CodeLens above each function: "pure" or a summary of its side effects; clicking opens the full analysis. */
export class SideEffectLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  /** Lenses of the last version of each document: VS Code asks again on scrolling and focus changes. */
  private readonly cache = new Map<string, { version: number; lenses: vscode.CodeLens[] }>();

  constructor(private readonly projects: ProjectService) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(languageSelector, this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tsStructure.codeLens')) {
          this.cache.clear();
          this.changed.fire();
        }
      }),
      // An edit elsewhere can change what a function's callees do.
      vscode.workspace.onDidSaveTextDocument(() => this.cache.clear()),
      vscode.workspace.onDidCloseTextDocument((d) => this.cache.delete(d.uri.toString())),
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('tsStructure').get('codeLens.sideEffects', false) || document.uri.scheme !== 'file') {
      return [];
    }
    const cached = this.cache.get(document.uri.toString());
    if (cached?.version === document.version) {
      return cached.lenses;
    }
    const lenses = this.compute(document);
    this.cache.set(document.uri.toString(), { version: document.version, lenses });
    return lenses;
  }

  private compute(document: vscode.TextDocument): vscode.CodeLens[] {
    try {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const project = this.projects.load(document.uri.fsPath, folder);
      const sourceFile = project.program.getSourceFile(normalizePath(document.uri.fsPath));
      if (!sourceFile || sourceFile.text !== document.getText()) {
        return [];
      }
      const analyzer = new EffectAnalyzer(project.checker);
      return lensTargets(sourceFile)
        .filter(({ fn }) => isFunctionWithBody(fn))
        .map(({ fn, anchor }) => {
          const effects = analyzer.effectsOf(fn as Parameters<EffectAnalyzer['effectsOf']>[0]);
          const kinds = [...new Set(effects.map((e) => e.kind))];
          const mutations = kinds.filter((k) => mutationKinds.has(k));
          const title = kinds.length === 0 ? '$(pass) pure' : `$(${mutations.length ? 'warning' : 'info'}) ${kinds.map((k) => shortLabels[k]).join(' · ')}`;
          const range = new vscode.Range(document.positionAt(anchor.getStart(sourceFile)), document.positionAt(anchor.end));
          return new vscode.CodeLens(range, {
            title,
            tooltip: kinds.length ? `${effects.length} side effect${effects.length === 1 ? '' : 's'}. Click for the full analysis.` : 'No side effects detected.',
            command: 'tsStructure.explainFinding',
            arguments: [document.uri, anchor.getStart(sourceFile), 'tsStructure.sideEffects'],
          });
        });
    } catch {
      return [];
    }
  }
}
