import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Severity } from '../inspect/inspection';
import { parseCSharp } from './parser';

/**
 * Inspections for C#, from the bundled parser's syntax tree: slips the code itself shows, without types, so each one
 * is safe to report. Each finding is a character range in the file, like the TypeScript inspections'.
 */

export interface CSharpFinding {
  inspection: string;
  message: string;
  severity: Severity;
  start: number;
  end: number;
}

export const csharpInspections: { id: string; title: string; severity: Severity }[] = [
  { id: 'csharpEmptyCatch', title: 'Empty catch block (C#)', severity: 'warning' },
  { id: 'csharpThrowEx', title: 'throw ex loses the stack trace (C#)', severity: 'warning' },
  { id: 'csharpAsyncVoid', title: 'async void method (C#)', severity: 'warning' },
  { id: 'csharpSelfAssignment', title: 'Assignment to itself (C#)', severity: 'warning' },
  { id: 'csharpSelfComparison', title: 'Comparison with itself (C#)', severity: 'warning' },
  { id: 'csharpIdenticalBranches', title: 'Identical if and else branches (C#)', severity: 'warning' },
  { id: 'csharpEmptyIf', title: 'if with an empty statement (C#)', severity: 'warning' },
  { id: 'csharpConstantCondition', title: 'Constant condition (C#)', severity: 'info' },
];
const severityOf = new Map(csharpInspections.map((i) => [i.id, i.severity]));

const same = (a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined) => !!a && !!b && a.text.replace(/\s+/g, '') === b.text.replace(/\s+/g, '');
/** Code whose value may differ each time it runs: calls, increments, `new`, `await`. Comparing it with itself is fine. */
const mayChange = (n: SyntaxNode) => /\(|\+\+|--|\bnew\b|\bawait\b/.test(n.text);

export function inspectCSharp(tree: Tree): CSharpFinding[] {
  const findings: CSharpFinding[] = [];
  const report = (inspection: string, node: SyntaxNode, message: string) =>
    findings.push({ inspection, message, severity: severityOf.get(inspection) ?? 'warning', start: node.startIndex, end: node.endIndex });
  const all = (type: string) => tree.rootNode.descendantsOfType(type).filter((n): n is SyntaxNode => !!n);

  for (const clause of all('catch_clause')) {
    const block = clause.namedChildren.find((c) => c?.type === 'block');
    if (block && block.namedChildCount === 0 && !block.text.includes('//') && !block.text.includes('/*')) {
      report('csharpEmptyCatch', clause.child(0) ?? clause, 'Empty catch block: the error is swallowed. Handle it, log it, or say in a comment why it is safe to ignore.');
    }
    // catch (Exception ex) { … throw ex; } resets the stack trace; `throw;` keeps it.
    const declaration = clause.namedChildren.find((c) => c?.type === 'catch_declaration');
    const name = declaration?.namedChildren.filter((c) => c?.type === 'identifier')[1]?.text;
    if (name && block) {
      for (const t of block.descendantsOfType('throw_statement')) {
        if (t && t.namedChild(0)?.type === 'identifier' && t.namedChild(0)?.text === name) report('csharpThrowEx', t, `throw ${name} resets the stack trace: use throw; to rethrow it as it was.`);
      }
    }
  }

  for (const method of [...all('method_declaration'), ...all('local_function_statement')]) {
    const modifiers = method.namedChildren.filter((c) => c?.type === 'modifier').map((c) => c!.text);
    const returns = method.childForFieldName('returns') ?? method.childForFieldName('type');
    if (!modifiers.includes('async') || returns?.text !== 'void') continue;
    // Event handlers (object sender, …EventArgs e) have to be async void.
    const parameters = method.childForFieldName('parameters')?.text ?? '';
    if (/\(\s*object\??\s+\w+\s*,\s*\w*EventArgs\b/.test(parameters)) continue;
    report('csharpAsyncVoid', method.childForFieldName('name') ?? method, 'async void: callers cannot await it and its exceptions crash the process. Return Task instead (event handlers excepted).');
  }

  for (const assignment of all('assignment_expression')) {
    const left = assignment.childForFieldName('left') ?? assignment.namedChild(0);
    const right = assignment.childForFieldName('right') ?? assignment.namedChild(1);
    const operator = assignment.text.slice((left?.endIndex ?? 0) - assignment.startIndex, (right?.startIndex ?? 0) - assignment.startIndex).trim();
    if (operator === '=' && same(left, right) && !mayChange(left!)) report('csharpSelfAssignment', assignment, `${left!.text} is assigned to itself: nothing changes. Was another variable meant (this.${left!.text} = ${left!.text})?`);
  }

  for (const binary of all('binary_expression')) {
    const left = binary.childForFieldName('left');
    const right = binary.childForFieldName('right');
    const operator = binary.childForFieldName('operator')?.text ?? binary.text.slice((left?.endIndex ?? 0) - binary.startIndex, (right?.startIndex ?? 0) - binary.startIndex).trim();
    if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(operator) && same(left, right) && !mayChange(left!)) {
      report('csharpSelfComparison', binary, `${left!.text} ${operator} ${right!.text} compares a value with itself: always ${['==', '<=', '>=', '&&', '||'].includes(operator) ? 'true (or the value)' : 'false'}.`);
    }
  }

  for (const statement of all('if_statement')) {
    const condition = statement.childForFieldName('condition');
    const consequence = statement.childForFieldName('consequence');
    const alternative = statement.childForFieldName('alternative');
    if (consequence?.type === 'empty_statement') report('csharpEmptyIf', consequence, 'if (…); with a semicolon: the statement after it runs either way.');
    if (consequence && alternative && alternative.type !== 'if_statement' && same(consequence, alternative) && consequence.text.trim().length > 2) {
      report('csharpIdenticalBranches', condition ?? statement, 'The if and else branches are the same: the condition makes no difference.');
    }
    if (condition && /^(true|false)$/.test(condition.text.trim())) report('csharpConstantCondition', condition, `The condition is always ${condition.text.trim()}.`);
  }
  for (const loop of all('while_statement')) {
    const condition = loop.childForFieldName('condition');
    if (condition?.text.trim() === 'false') report('csharpConstantCondition', condition, 'while (false): the loop never runs.');
  }
  return findings.sort((a, b) => a.start - b.start);
}

/** The C# inspections of a file's text. */
export async function inspectCSharpText(text: string): Promise<CSharpFinding[]> {
  const tree = await parseCSharp(text);
  try {
    return inspectCSharp(tree);
  } finally {
    tree.delete();
  }
}
