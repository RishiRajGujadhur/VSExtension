import ts = require('typescript');
import { normalizePath } from '../analysis/paths';
import { SourceLocation } from '../analysis/types';
import { EditCollector, FunctionNode, FunctionTarget, applyFileEdits, functionAt, introducedErrors, isValidIdentifier, usagesOf } from './common';
import { Edit, replace } from './edits';
import { Conflict, RefactorError, RefactorResult } from './types';
import { VirtualProject, preferences } from './virtualProject';

export interface ParameterInfo {
  name: string;
  /** Type annotation text, or '' when there is none. */
  type: string;
  optional: boolean;
  /** Default value text in the declaration, or ''. */
  initializer: string;
  rest: boolean;
  /** Destructuring patterns cannot be renamed. */
  renamable: boolean;
}

export interface FunctionInfo {
  name: string;
  kind: string;
  location: SourceLocation;
  parameters: ParameterInfo[];
  returnType: string;
  /** JavaScript files have no type annotations. */
  typed: boolean;
}

export interface CallContext {
  call: ts.CallExpression;
  /** Argument text by original parameter index, with nested call sites already rewritten. */
  argumentText(index: number): string | undefined;
}

export interface ParameterSpec {
  /** Index of the existing parameter this row keeps; undefined adds a new parameter. */
  originalIndex?: number;
  name: string;
  type?: string;
  optional?: boolean;
  initializer?: string;
  /** For new parameters: the argument added at existing call sites. Empty leaves it out. */
  callValue?: string | ((context: CallContext) => string | undefined);
}

export interface SignatureSpec {
  /** New function name; omitted or unchanged keeps it. */
  name?: string;
  parameters: ParameterSpec[];
  /** New return type text; undefined keeps it and '' removes it. */
  returnType?: string;
  /**
   * Edits inside the function itself, applied together with the signature change.
   * Used by Introduce Parameter to replace the selected expression.
   */
  bodyEdits?: (fn: FunctionNode) => Edit[];
}

export function describeFunction(project: VirtualProject, fileName: string, offset: number): FunctionInfo {
  const target = functionAt(project, fileName, offset);
  return infoOf(project, target);
}

function infoOf(project: VirtualProject, target: FunctionTarget): FunctionInfo {
  const sourceFile = target.fn.getSourceFile();
  return {
    name: target.name,
    kind: ts.isMethodDeclaration(target.fn) || ts.isMethodSignature(target.fn) ? 'method' : 'function',
    location: project.locationOf(target.nameNode),
    parameters: target.fn.parameters.map((p) => ({
      name: p.name.getText(sourceFile),
      type: p.type?.getText(sourceFile) ?? '',
      optional: !!p.questionToken,
      initializer: p.initializer?.getText(sourceFile) ?? '',
      rest: !!p.dotDotDotToken,
      renamable: ts.isIdentifier(p.name),
    })),
    returnType: target.fn.type?.getText(sourceFile) ?? '',
    typed: !/\.[cm]?jsx?$/i.test(sourceFile.fileName),
  };
}

/**
 * Changes a function's parameters, name and return type, and rewrites every call site.
 * Implementations and declarations of the same member in interfaces, base classes and
 * subclasses get the same parameter change.
 */
export function changeSignature(project: VirtualProject, fileName: string, offset: number, spec: SignatureSpec, label = 'Change Signature'): RefactorResult {
  const target = functionAt(project, fileName, offset);
  const info = infoOf(project, target);
  const conflicts = validate(info, spec);
  const { usages, related } = usagesOf(project, target);
  const edits = new EditCollector();

  for (const usage of usages) {
    if (usage.kind === 'call') {
      const conflict = rewriteCall(usage.call, target, spec, edits);
      if (conflict) {
        conflicts.push(conflict);
      }
    } else if (usage.kind === 'other') {
      conflicts.push({ message: `'${target.name}' is ${usage.reason}.`, location: project.locationOf(usage.node) });
    }
  }

  for (const fn of [target.fn, ...related.map((r) => r.fn)]) {
    rewriteDeclaration(project, fn, spec, edits, conflicts);
  }
  if (spec.bodyEdits) {
    for (const edit of spec.bodyEdits(target.fn)) {
      edits.add(normalizePath(target.fn.getSourceFile().fileName), edit);
    }
  }

  if (spec.name !== undefined && spec.name !== target.name) {
    const sourceFile = target.nameNode.getSourceFile();
    const locations = project.service.findRenameLocations(sourceFile.fileName, target.nameNode.getStart(sourceFile), false, false, preferences) ?? [];
    for (const location of locations) {
      const text = `${location.prefixText ?? ''}${spec.name}${location.suffixText ?? ''}`;
      edits.add(location.fileName, replace(location.textSpan.start, location.textSpan.start + location.textSpan.length, text));
    }
  }

  applyFileEdits(project, edits.byFile);
  conflicts.push(...introducedErrors(project, usages.map((u) => u.node.getSourceFile().fileName)));
  return { label, changes: project.changes(), conflicts };
}

function validate(info: FunctionInfo, spec: SignatureSpec): Conflict[] {
  if (spec.name !== undefined && !isValidIdentifier(spec.name)) {
    throw new RefactorError(`'${spec.name}' is not a valid name.`);
  }
  const names = new Set<string>();
  spec.parameters.forEach((p, i) => {
    const original = p.originalIndex !== undefined ? info.parameters[p.originalIndex] : undefined;
    if (p.originalIndex !== undefined && !original) {
      throw new RefactorError(`Parameter ${p.originalIndex + 1} does not exist.`);
    }
    if (original && !original.renamable && p.name !== original.name) {
      throw new RefactorError(`Destructured parameter ${original.name} cannot be renamed.`);
    }
    if ((!original || original.renamable) && !isValidIdentifier(p.name)) {
      throw new RefactorError(`'${p.name}' is not a valid parameter name.`);
    }
    if (names.has(p.name)) {
      throw new RefactorError(`Duplicate parameter name '${p.name}'.`);
    }
    names.add(p.name);
    if (original?.rest && i !== spec.parameters.length - 1) {
      throw new RefactorError(`Rest parameter ...${original.name} must stay last.`);
    }
  });
  const conflicts: Conflict[] = [];
  let sawOptional = false;
  for (const p of spec.parameters) {
    const original = p.originalIndex !== undefined ? info.parameters[p.originalIndex] : undefined;
    const optional = (p.optional ?? original?.optional ?? false) || !!(p.initializer ?? original?.initializer) || !!original?.rest;
    if (!optional && sawOptional) {
      conflicts.push({ message: `Required parameter '${p.name}' follows an optional one.` });
    }
    sawOptional ||= optional;
  }
  return conflicts;
}

function rewriteCall(call: ts.CallExpression, target: FunctionTarget, spec: SignatureSpec, edits: EditCollector): Conflict | undefined {
  const sourceFile = call.getSourceFile();
  const args = call.arguments;
  const restIndex = target.fn.parameters.findIndex((p) => p.dotDotDotToken);
  const spreadIndex = args.findIndex((a) => ts.isSpreadElement(a));
  const location = { file: normalizePath(sourceFile.fileName), ...sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)) };
  if (spreadIndex >= 0) {
    // Positions after a spread are unknown, so only a change that leaves them in place is safe.
    const unchanged = spec.parameters.every((p, i) => i < spreadIndex ? p.originalIndex === i : true) &&
      spec.parameters.slice(spreadIndex).every((p, i) => p.originalIndex === spreadIndex + i) &&
      spec.parameters.length >= target.fn.parameters.length;
    if (!unchanged) {
      return { message: `A call with a spread argument cannot be rewritten: ${call.getText(sourceFile)}`, location };
    }
    return undefined;
  }

  edits.add(normalizePath(sourceFile.fileName), {
    start: args.pos,
    end: args.end,
    render: (sub) => {
      const argText = (index: number) => {
        const arg = args[index];
        return arg ? sub(arg.getStart(sourceFile), arg.end) : undefined;
      };
      const values: (string | undefined)[] = spec.parameters.map((p) => {
        if (p.originalIndex === undefined) {
          const value = typeof p.callValue === 'function' ? p.callValue({ call, argumentText: argText }) : p.callValue;
          return value === '' ? undefined : value;
        }
        if (p.originalIndex === restIndex) {
          const rest = args.slice(restIndex).map((a) => sub(a.getStart(sourceFile), a.end));
          return rest.length > 0 ? rest.join(', ') : undefined;
        }
        return argText(p.originalIndex);
      });
      while (values.length > 0 && values[values.length - 1] === undefined) {
        values.pop();
      }
      return joinList(values.map((v) => v ?? 'undefined'), args, sourceFile);
    },
  });
  return undefined;
}

function rewriteDeclaration(project: VirtualProject, fn: FunctionNode, spec: SignatureSpec, edits: EditCollector, conflicts: Conflict[]): void {
  const sourceFile = fn.getSourceFile();
  const fileName = normalizePath(sourceFile.fileName);
  const typed = !/\.[cm]?jsx?$/i.test(fileName);
  const params = fn.parameters;

  spec.parameters.forEach((p) => {
    const original = p.originalIndex !== undefined ? params[p.originalIndex] : undefined;
    if (original && ts.isIdentifier(original.name) && original.name.text !== p.name) {
      // Rename the parameter's uses inside the body; the declaration itself is rebuilt below.
      const locations = project.service.findRenameLocations(sourceFile.fileName, original.name.getStart(sourceFile), false, false, preferences) ?? [];
      for (const location of locations) {
        if (location.textSpan.start !== original.name.getStart(sourceFile)) {
          const text = `${location.prefixText ?? ''}${p.name}${location.suffixText ?? ''}`;
          edits.add(location.fileName, replace(location.textSpan.start, location.textSpan.start + location.textSpan.length, text));
        }
      }
    }
  });

  params.forEach((param, index) => {
    if (spec.parameters.some((p) => p.originalIndex === index) || !ts.isIdentifier(param.name) || !('body' in fn) || !fn.body) {
      return;
    }
    const uses = (project.service.findReferences(sourceFile.fileName, param.name.getStart(sourceFile)) ?? [])
      .flatMap((g) => g.references)
      .filter((r) => !r.isDefinition);
    if (uses.length > 0) {
      conflicts.push({
        message: `Removed parameter '${param.name.text}' is still used in the body of ${nameOf(fn)}.`,
        location: project.locationOf(param),
      });
    }
  });

  const needsParens = ts.isArrowFunction(fn) && !fn.getChildren(sourceFile).some((c) => c.kind === ts.SyntaxKind.OpenParenToken);
  const listEdit: Edit = {
    start: needsParens ? params[0].getStart(sourceFile) : params.pos,
    end: params.end,
    render: (sub) => {
      const texts = spec.parameters.map((p) => {
        const original = p.originalIndex !== undefined ? params[p.originalIndex] : undefined;
        if (!original) {
          return parameterText(p.name, typed ? p.type ?? '' : '', typed && !!p.optional, p.initializer ?? '', false);
        }
        const name = ts.isIdentifier(original.name) ? p.name : sub(original.name.getStart(sourceFile), original.name.end);
        const type = !typed ? '' : p.type !== undefined ? p.type : original.type ? sub(original.type.getStart(sourceFile), original.type.end) : '';
        const optional = typed && (p.optional ?? !!original.questionToken);
        const initializer = p.initializer !== undefined ? p.initializer : original.initializer ? sub(original.initializer.getStart(sourceFile), original.initializer.end) : '';
        const modifiers = original.modifiers ? original.modifiers.map((m) => m.getText(sourceFile)).join(' ') + ' ' : '';
        return modifiers + parameterText(name, type, optional, initializer, !!original.dotDotDotToken);
      });
      const list = joinList(texts, params, sourceFile);
      return needsParens ? `(${list})` : list;
    },
  };
  edits.add(fileName, listEdit);

  if (spec.returnType !== undefined && typed) {
    const current = fn.type?.getText(sourceFile) ?? '';
    if (spec.returnType !== current) {
      if (fn.type) {
        const start = spec.returnType ? fn.type.getStart(sourceFile) : params.end + sourceFile.text.slice(params.end).indexOf(')') + 1;
        edits.add(fileName, replace(start, fn.type.end, spec.returnType ? spec.returnType : ''));
      } else {
        const close = params.end + sourceFile.text.slice(params.end).indexOf(')') + 1;
        edits.add(fileName, replace(close, close, `: ${spec.returnType}`));
      }
    }
  }
}

function parameterText(name: string, type: string, optional: boolean, initializer: string, rest: boolean): string {
  // A parameter with a default value cannot also be marked optional.
  const question = optional && !initializer && !rest ? '?' : '';
  return `${rest ? '...' : ''}${name}${question}${type ? `: ${type}` : ''}${initializer ? ` = ${initializer}` : ''}`;
}

/** Joins list items, keeping one-per-line layout when the original list used it. */
function joinList(items: string[], original: ts.NodeArray<ts.Node>, sourceFile: ts.SourceFile): string {
  if (original.length > 1) {
    const first = sourceFile.getLineAndCharacterOfPosition(original[0].getStart(sourceFile));
    const second = sourceFile.getLineAndCharacterOfPosition(original[1].getStart(sourceFile));
    if (second.line > first.line) {
      const leading = sourceFile.text.slice(original.pos, original[0].getStart(sourceFile));
      const trailing = sourceFile.text.slice(original[original.length - 1].end, original.end);
      const indent = ' '.repeat(first.character);
      return leading + items.join(`,\n${indent}`) + trailing;
    }
  }
  return items.join(', ');
}

function nameOf(fn: FunctionNode): string {
  const parent = fn.parent;
  if ('name' in fn && fn.name) {
    return fn.name.getText();
  }
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name) {
    return parent.name.getText();
  }
  return 'the function';
}
