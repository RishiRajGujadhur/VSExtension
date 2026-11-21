import * as path from 'path';
import ts = require('typescript');
import { standaloneCharts } from '../inspect/controlFlowChart';
import { csharpFlowChart } from '../csharp/flow';
import { tsqlFlowChart } from '../tsql/flow';
import { isFunctionWithBody } from '../structure/util';
import { explainFunctionWalk, explainLines } from '../reel/describe';
import type { ControlFlowChart } from '../inspect/controlFlowChart';
import { FEATURE_PROTOTYPES, featureIntent, intentLabel, intentPhrase, intentsOf, nounsOf } from '../reel/intent';
import { codeAsWords, cosine } from '../reel/codeModelText';
import { MODEL_FEATURE_MARGIN, MODEL_FEATURE_MIN } from '../reel/plan';
import { listWords, verbPhrase } from '../reel/words';

/**
 * "Explain this code": what highlighted code does, in plain sentences, worked out on this computer. Code X-Ray's
 * rules read the code (its flowchart, its calls, its names); the code model, when you have downloaded it, only helps
 * name what a function is for when the rules cannot tell. Nothing is sent anywhere.
 */
export interface CodeExplanation {
  /** What was explained: "the function currentConfig()", "the highlighted lines in currentConfig()". */
  subject: string;
  /** One sentence on what it is: "currentConfig is an async function that returns a Config." */
  summary?: string;
  /** What it is for, and who said so. */
  purpose?: { text: string; by: 'rules' | 'model' };
  /** What it does, step by step. */
  steps: string[];
  /** For a whole function: its flowchart and the boxes each step is about, for the explanation video. */
  walk?: { name: string; chart: ControlFlowChart; nodes: number[][]; /** Its first line, up to the body: "async function poll(currentGeneration: number)". */ signature?: string };
}

/** The explanation of a function from its flowchart: the steps, and the boxes each one lights up. */
function fromChart(subject: string, name: string, chart: ControlFlowChart, summary?: string, signature?: string): CodeExplanation {
  const walk = explainFunctionWalk(chart);
  return { subject, summary, steps: walk.map((w) => w.text), walk: { name, chart, nodes: walk.map((w) => w.nodes), ...(signature ? { signature } : {}) } };
}

type Understand = (texts: string[]) => Promise<Float32Array[]>;

/** Explains the code between `start` and `end` of a file's text. */
export async function explainCode(file: string, text: string, start: number, end: number, understand?: Understand): Promise<CodeExplanation> {
  const ext = path.extname(file).toLowerCase();
  const selected = text.slice(start, end);
  const lines = selected.split('\n');
  if (ext === '.cs' || ext === '.sql') {
    try {
      const at = start + (selected.length - selected.trimStart().length);
      const chart = ext === '.cs' ? await csharpFlowChart(text, file, at) : tsqlFlowChart(text, file, at);
      const name = chart.name.replace(/\(\)$/, '');
      return withPurpose(fromChart(`${name}()`, name, chart, undefined, oneLine(lines.find((l) => l.trim()) ?? '')), name, file, lines, understand);
    } catch {
      return withPurpose({ subject: 'the highlighted lines', steps: explainLines(lines) }, undefined, file, lines, understand);
    }
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const fn = innermostFunction(source, start, end);
  const name = fn ? functionName(fn) : undefined;
  // Most of a function highlighted (or its first line): the function. A few of its lines: those lines.
  const whole = !!fn && (start <= fn.getStart(source) + 1 || (end - start) / Math.max(1, fn.end - fn.getStart(source)) >= 0.6);
  if (fn && name && whole) {
    const anchor = fn.name?.getStart(source) ?? (ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getStart(source) : fn.getStart(source));
    const chart = standaloneCharts(file, text)(anchor);
    const body = text.slice(fn.getStart(source), fn.end).split('\n');
    const head = fn.body ? text.slice(fn.getStart(source), fn.body.getStart(source)) : body[0];
    return withPurpose(fromChart(`the function ${name}()`, name, chart, signatureSentence(fn, name, source), oneLine(head.replace(/\s*=>\s*$/, ''))), name, file, body, understand);
  }
  return withPurpose({ subject: name ? `the highlighted lines in ${name}()` : 'the highlighted lines', steps: explainLines(lines) }, undefined, file, lines, understand);
}

/** What it is for: the rules first; the code model when they cannot tell and it is there. */
async function withPurpose(explanation: CodeExplanation, name: string | undefined, file: string, lines: string[], understand?: Understand): Promise<CodeExplanation> {
  const ruled = featureIntent({ name, file, added: lines }) ?? (name ? undefined : intentsOf({ added: lines }).find((i) => i.score >= 3));
  if (ruled) return { ...explanation, purpose: { text: intentLabel(ruled), by: 'rules' } };
  if (understand && name) {
    try {
      const [own, ...prototypes] = await understand([codeAsWords(name, lines), ...FEATURE_PROTOTYPES.map((p) => p.text)]);
      const ranked = prototypes.map((p, j) => ({ kind: FEATURE_PROTOTYPES[j].kind, score: cosine(p, own) })).sort((a, b) => b.score - a.score);
      const [best, next] = ranked;
      if (best.kind !== 'other' && best.score >= MODEL_FEATURE_MIN && best.score - next.score >= MODEL_FEATURE_MARGIN) {
        const phrase = intentPhrase(best.kind, nounsOf(name));
        return { ...explanation, purpose: { text: intentLabel({ kind: best.kind, phrase, score: best.score, evidence: ['the code model'] }), by: 'model' } };
      }
    } catch {
      // The model failed: the rules' explanation stands.
    }
  }
  // What its name says it does, when nothing more is known.
  if (name) {
    const said = verbPhrase(name);
    if (said && !/^(does|works|handles) /.test(said)) return { ...explanation, purpose: { text: said.charAt(0).toUpperCase() + said.slice(1), by: 'rules' } };
  }
  return explanation;
}

function innermostFunction(source: ts.SourceFile, start: number, end: number): ts.FunctionLikeDeclaration | undefined {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node) => {
    const s = node.getStart(source);
    // A function the highlight is in, or one it starts on.
    if (isFunctionWithBody(node) && ((s <= start && node.end >= end) || (start <= s && s < end && node.end >= end - 1))) found = node as ts.FunctionLikeDeclaration;
    if (node.getStart(source) <= end && node.end >= start) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function functionName(fn: ts.FunctionLikeDeclaration): string | undefined {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name))) return fn.name.text;
  const parent = fn.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

/** "currentConfig is an async function that takes the id and returns a Config, once it finishes." */
function signatureSentence(fn: ts.FunctionLikeDeclaration, name: string, source: ts.SourceFile): string {
  const isAsync = !!ts.getModifiers(fn as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  const params = fn.parameters.map((p) => p.name.getText(source)).filter((p) => /^\w+$/.test(p));
  let returns = fn.type?.getText(source);
  const promised = returns && /^Promise<(.+)>$/.exec(returns);
  if (promised) returns = promised[1];
  const kind = ts.isMethodDeclaration(fn) ? 'method' : ts.isConstructorDeclaration(fn) ? 'constructor' : 'function';
  const takes = params.length ? `takes ${listWords(params.map((p) => `the ${p}`))}` : '';
  const gives = returns && returns !== 'void' ? `returns ${/^[A-Z]/.test(returns) && !/[<|[]/.test(returns) ? `a ${returns}` : returns}${isAsync || promised ? ', once it finishes' : ''}` : '';
  const what = [takes, gives].filter(Boolean).join(' and ');
  return `${name} is ${isAsync ? 'an async' : 'a'} ${kind}${what ? ` that ${what}` : ''}.`;
}

/** Code on one line, spaces squeezed, cut to a length a title card can show. */
function oneLine(code: string, max = 90): string {
  const line = code.replace(/\s+/g, ' ').replace(/\s*\{\s*$/, '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
