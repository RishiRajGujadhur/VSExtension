import type { Node as SyntaxNode } from 'web-tree-sitter';
import { parseCSharp } from './parser';
import { classifyCSharpUsage } from './usageKind';
import { Usage } from '../structure/usageReport';

/**
 * Find usages in C# without a language server: every identifier with the name, from the bundled parser, in the files
 * given. It can't tell two symbols of the same name apart (that needs types), so the report says it matched by name.
 */

export interface CSharpFile {
  file: string;
  text: string;
}

/** Declarations whose `name` is the declared symbol. */
const declarations = new Set([
  'class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration', 'delegate_declaration',
  'method_declaration', 'constructor_declaration', 'property_declaration', 'event_declaration', 'local_function_statement',
  'variable_declarator', 'parameter', 'enum_member_declaration', 'type_parameter', 'catch_declaration', 'foreach_statement',
]);
const types = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration']);
const members = new Set(['method_declaration', 'constructor_declaration', 'property_declaration', 'local_function_statement']);

/** Where a node is: Type.Member, or the type alone. */
function enclosing(node: SyntaxNode): string | undefined {
  let member: string | undefined;
  for (let p = node.parent; p; p = p.parent) {
    if (!member && members.has(p.type)) member = p.childForFieldName('name')?.text;
    if (types.has(p.type)) {
      const type = p.childForFieldName('name')?.text;
      return member ? `${type}.${member}` : type;
    }
  }
  return member;
}

export async function csharpUsagesByName(files: CSharpFile[], name: string, cursor: { file: string; offset: number }): Promise<Usage[]> {
  const usages: Usage[] = [];
  const word = new RegExp(`(^|[^\\w@])@?${name.replace(/[^\w]/g, '')}(?![\\w])`);
  for (const { file, text } of files) {
    // Most files don't mention the name: they are not parsed.
    if (!word.test(text)) continue;
    const tree = await parseCSharp(text);
    try {
      const lines = text.split(/\r?\n/);
      for (const id of tree.rootNode.descendantsOfType('identifier')) {
        if (!id || id.text.replace(/^@/, '') !== name) continue;
        const parent = id.parent;
        const declared = !!parent && declarations.has(parent.type) && (parent.childForFieldName('name')?.id === id.id || (parent.type === 'foreach_statement' && parent.childForFieldName('left')?.id === id.id));
        const row = id.startPosition.row;
        const line = lines[row] ?? '';
        usages.push({
          kind: declared ? 'definition' : classifyCSharpUsage(line, id.startPosition.column, id.endPosition.column),
          location: { file, line: row, character: id.startPosition.column, endLine: id.endPosition.row, endCharacter: id.endPosition.column },
          line: line.trim(),
          where: enclosing(id),
          atCursor: file === cursor.file && cursor.offset >= id.startIndex && cursor.offset <= id.endIndex,
        });
      }
    } finally {
      tree.delete();
    }
  }
  return usages;
}
