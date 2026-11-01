import * as path from 'path';
import * as ts from 'typescript';
import { analyzeImpact } from '../analysis/impact';
import { projectSourceFiles, resolveAlias } from '../analysis/referenceIndex';
import { AnalysisError } from '../analysis/types';
import { VirtualProject } from '../refactor/virtualProject';
import { ReportBuilder, ReportNode, Report, codeContext, plural } from '../structure/report';
import { accessExpression, enclosingFunction, functionLabel, identifierAt, referencesAt } from '../structure/util';

export type TypeDeclaration = ts.ClassLikeDeclaration | ts.InterfaceDeclaration;

export interface HeritageEdge {
  sub: TypeDeclaration;
  sup: TypeDeclaration;
  kind: 'extends' | 'implements';
  node: ts.ExpressionWithTypeArguments;
}

function isTypeDeclaration(node: ts.Node): node is TypeDeclaration {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node);
}

export function typeName(declaration: TypeDeclaration): string {
  if (declaration.name) {
    return declaration.name.text;
  }
  const parent = declaration.parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : 'anonymous class';
}

/** Every class and interface in the project with its direct supertypes and subtypes. */
export class HierarchyIndex {
  readonly edges: HeritageEdge[] = [];

  constructor(readonly program: ts.Program) {
    const checker = program.getTypeChecker();
    for (const sourceFile of projectSourceFiles(program)) {
      const visit = (node: ts.Node) => {
        if (isTypeDeclaration(node)) {
          for (const clause of node.heritageClauses ?? []) {
            for (const type of clause.types) {
              const symbol = checker.getSymbolAtLocation(type.expression);
              const resolved = symbol && resolveAlias(checker, symbol);
              for (const declaration of resolved?.declarations ?? []) {
                if (isTypeDeclaration(declaration)) {
                  this.edges.push({ sub: node, sup: declaration, kind: clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements', node: type });
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  supertypes(declaration: TypeDeclaration): HeritageEdge[] {
    return this.edges.filter((e) => e.sub === declaration);
  }

  subtypes(declaration: TypeDeclaration): HeritageEdge[] {
    return this.edges.filter((e) => e.sup === declaration);
  }

  /** All transitive subtypes, nearest first. */
  allSubtypes(declaration: TypeDeclaration): TypeDeclaration[] {
    const result: TypeDeclaration[] = [];
    const queue = [declaration];
    while (queue.length) {
      for (const edge of this.subtypes(queue.shift()!)) {
        if (!result.includes(edge.sub) && edge.sub !== declaration) {
          result.push(edge.sub);
          queue.push(edge.sub);
        }
      }
    }
    return result;
  }

  /** All transitive supertypes, nearest first. */
  allSupertypes(declaration: TypeDeclaration): TypeDeclaration[] {
    const result: TypeDeclaration[] = [];
    const queue = [declaration];
    while (queue.length) {
      for (const edge of this.supertypes(queue.shift()!)) {
        if (!result.includes(edge.sup) && edge.sup !== declaration) {
          result.push(edge.sup);
          queue.push(edge.sup);
        }
      }
    }
    return result;
  }
}

export type Member = ts.ClassElement | ts.TypeElement;

export function memberName(member: Member): string | undefined {
  const name = member.name;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) ? name.text : undefined;
}

export function membersOf(declaration: TypeDeclaration): Member[] {
  return (declaration.members as ts.NodeArray<Member>).filter((m) => memberName(m) !== undefined && !ts.isConstructorDeclaration(m) && !ts.isIndexSignatureDeclaration(m));
}

export function findMember(declaration: TypeDeclaration, name: string): Member | undefined {
  return membersOf(declaration).find((m) => memberName(m) === name);
}

function isAbstract(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Abstract) !== 0;
}

function kindLabel(declaration: TypeDeclaration): string {
  return ts.isInterfaceDeclaration(declaration) ? 'interface' : isAbstract(declaration) ? 'abstract class' : 'class';
}

/** The class or interface named or enclosing the cursor. */
export function typeAt(program: ts.Program, sourceFile: ts.SourceFile, offset: number): TypeDeclaration {
  const checker = program.getTypeChecker();
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a class or interface.');
  const symbol = checker.getSymbolAtLocation(identifier);
  const resolved = symbol && resolveAlias(checker, symbol);
  const declared = resolved?.declarations?.find((d): d is TypeDeclaration => isTypeDeclaration(d) && !d.getSourceFile().isDeclarationFile);
  if (declared) {
    return declared;
  }
  const enclosing = ts.findAncestor(identifier, isTypeDeclaration);
  if (enclosing) {
    return enclosing;
  }
  throw new AnalysisError(`'${identifier.text}' is not a class or interface in this project.`);
}

/** Inheritance Hierarchy Explorer: supertypes, subtypes and how members are overridden. */
export function hierarchyReport(project: VirtualProject, fileName: string, offset: number, root?: string): Report {
  const program = project.program();
  const target = typeAt(program, project.sourceFile(fileName), offset);
  const index = new HierarchyIndex(program);
  const builder = new ReportBuilder('hierarchy', `Hierarchy of ${typeName(target)}`);
  const where = (d: TypeDeclaration) => (root ? path.relative(root, d.getSourceFile().fileName).replace(/\\/g, '/') : path.basename(d.getSourceFile().fileName));
  const targetMembers = new Set(membersOf(target).map(memberName));

  const up = (declaration: TypeDeclaration, seen: Set<TypeDeclaration>): ReportNode[] =>
    index.supertypes(declaration).map((edge) => ({
      label: `${kindLabel(edge.sup)} ${typeName(edge.sup)}`,
      description: `${edge.kind} · ${where(edge.sup)}`,
      icon: ts.isInterfaceDeclaration(edge.sup) ? 'symbol-interface' : 'symbol-class',
      location: builder.at(edge.sup.name ?? edge.sup),
      tooltip: codeContext(edge.sup.name ?? edge.sup, 0),
      action: reroot(edge.sup),
      expanded: true,
      children: seen.has(edge.sup) ? undefined : up(edge.sup, new Set([...seen, edge.sup])),
    }));
  const down = (declaration: TypeDeclaration, seen: Set<TypeDeclaration>): ReportNode[] =>
    index.subtypes(declaration).map((edge) => {
      const overrides = membersOf(edge.sub).map(memberName).filter((n) => n && targetMembers.has(n));
      return {
        label: `${kindLabel(edge.sub)} ${typeName(edge.sub)}`,
        description: `${edge.kind}${overrides.length ? ` · overrides ${overrides.join(', ')}` : ''} · ${where(edge.sub)}`,
        icon: ts.isInterfaceDeclaration(edge.sub) ? 'symbol-interface' : 'symbol-class',
        location: builder.at(edge.sub.name ?? edge.sub),
        tooltip: codeContext(edge.sub.name ?? edge.sub, 0),
        action: reroot(edge.sub),
        expanded: true,
        children: seen.has(edge.sub) ? undefined : down(edge.sub, new Set([...seen, edge.sub])),
      };
    });

  const supers = up(target, new Set([target]));
  const subs = down(target, new Set([target]));
  const allSubs = index.allSubtypes(target);
  const allSupers = index.allSupertypes(target);
  // With the cursor on a member's name, that member is selected and opened.
  const atCursor = membersOf(target).find((m) => m.name && m.name.getStart() <= offset && offset <= m.name.end && m.getSourceFile() === project.sourceFile(fileName));
  const members: ReportNode[] = membersOf(target).map((member) => {
    const name = memberName(member)!;
    const overriding = allSubs.map((s) => findMember(s, name)).filter((m): m is Member => !!m);
    const overridden = allSupers.map((s) => findMember(s, name)).filter((m): m is Member => !!m);
    return {
      label: `${name}${ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ? '()' : ''}`,
      description: [isAbstract(member) ? 'abstract' : '', overridden.length ? `from ${overridden.map((m) => typeName(m.parent as TypeDeclaration)).join(', ')}` : '', overriding.length ? `${plural(overriding.length, 'override')}` : ''].filter(Boolean).join(' · '),
      icon: ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ? 'symbol-method' : 'symbol-property',
      location: builder.at(member.name ?? member),
      tooltip: codeContext(member.name ?? member, 0),
      focus: member === atCursor || undefined,
      expanded: member === atCursor || undefined,
      action: { kind: 'overrideImpact', command: 'tsStructure.overrideImpact', file: member.getSourceFile().fileName, offset: (member.name ?? member).getStart() },
      children: overriding.length
        ? overriding.map((m) => ({
            label: `${typeName(m.parent as TypeDeclaration)}.${name}`,
            icon: 'arrow-small-down',
            location: builder.at(m.name ?? m),
            tooltip: codeContext(m.name ?? m, 2),
            description: callsSuper(m, name) ? 'calls super' : undefined,
          }))
        : undefined,
    };
  });
  const roots: ReportNode[] = [
    { label: `${kindLabel(target)} ${typeName(target)}`, description: where(target), icon: ts.isInterfaceDeclaration(target) ? 'symbol-interface' : 'symbol-class', tone: 'ok', location: builder.at(target.name ?? target) },
    { label: 'Supertypes', description: plural(allSupers.length, 'type'), icon: 'type-hierarchy-super', expanded: true, children: supers.length ? supers : [{ label: 'none', icon: 'dash' }] },
    { label: 'Subtypes and implementations', description: plural(allSubs.length, 'type'), icon: 'type-hierarchy-sub', expanded: true, children: subs.length ? subs : [{ label: 'none in this project', icon: 'dash' }] },
    { label: 'Members', description: plural(members.length, 'member'), icon: 'symbol-field', expanded: true, children: members },
  ];
  // What the type gets from its supertypes without redeclaring, nearest supertype first.
  const inherited = new Map<string, Member>();
  for (const supertype of allSupers) {
    for (const member of membersOf(supertype)) {
      const name = memberName(member)!;
      if (!targetMembers.has(name) && !inherited.has(name)) {
        inherited.set(name, member);
      }
    }
  }
  if (inherited.size > 0) {
    roots.push({
      label: 'Inherited members',
      description: plural(inherited.size, 'member'),
      icon: 'symbol-field',
      expanded: members.length === 0,
      children: [...inherited].map(([name, member]) => ({
        label: `${name}${ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ? '()' : ''}`,
        description: [isAbstract(member) ? 'abstract' : '', `from ${typeName(member.parent as TypeDeclaration)}`].filter(Boolean).join(' · '),
        icon: ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ? 'symbol-method' : 'symbol-property',
        location: builder.at(member.name ?? member),
      })),
    });
  }
  return builder.finish(roots, `${plural(allSupers.length, 'supertype')}, ${plural(allSubs.length, 'subtype')}`);
}

/** Shows the hierarchy again from another type in it, unless that type comes from a library. */
function reroot(declaration: TypeDeclaration): ReportNode['action'] {
  const sourceFile = declaration.getSourceFile();
  return sourceFile.isDeclarationFile ? undefined : { kind: 'showHierarchy', command: 'tsStructure.typeHierarchy', file: sourceFile.fileName, offset: (declaration.name ?? declaration).getStart() };
}

function callsSuper(member: Member, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && node.name.text === name) {
      found = true;
    }
    if (!found) {
      ts.forEachChild(node, visit);
    }
  };
  visit(member);
  return found;
}

/** Override Impact Analyzer: what a change to a base member reaches through overrides, inheritance and dispatch. */
export function overrideImpactReport(project: VirtualProject, fileName: string, offset: number, root?: string): Report {
  const program = project.program();
  const checker = program.getTypeChecker();
  const sourceFile = project.sourceFile(fileName);
  const identifier = identifierAt(sourceFile, offset, 'Place the cursor on a method or property of a class or interface.');
  const symbol = checker.getSymbolAtLocation(identifier);
  const member = (symbol && resolveAlias(checker, symbol))?.declarations?.find(
    (d): d is Member => (ts.isClassElement(d) || ts.isTypeElement(d)) && isTypeDeclaration(d.parent) && !d.getSourceFile().isDeclarationFile,
  );
  if (!member) {
    throw new AnalysisError(`'${identifier.text}' is not a member of a class or interface in this project.`);
  }
  const owner = member.parent as TypeDeclaration;
  const name = memberName(member)!;
  const index = new HierarchyIndex(program);
  const builder = new ReportBuilder('overrideImpact', `Impact of changing ${typeName(owner)}.${name}`);
  const where = (n: ts.Node) => (root ? path.relative(root, n.getSourceFile().fileName).replace(/\\/g, '/') : path.basename(n.getSourceFile().fileName));
  const subtypes = index.allSubtypes(owner);

  const overridden = index
    .allSupertypes(owner)
    .map((s) => findMember(s, name))
    .filter((m): m is Member => !!m);
  const overrides: ReportNode[] = [];
  const inheriting: ReportNode[] = [];
  for (const sub of subtypes) {
    const own = findMember(sub, name);
    if (own) {
      const extendsBase = callsSuper(own, name);
      overrides.push({
        label: `${typeName(sub)}.${name}`,
        description: ts.isInterfaceDeclaration(sub) ? 'redeclared' : extendsBase ? 'calls super: affected' : isAbstract(member) || ts.isInterfaceDeclaration(owner) ? 'implements it' : 'replaces it: not affected by body changes',
        icon: extendsBase ? 'debug-step-into' : 'symbol-method',
        tone: extendsBase ? 'warning' : 'info',
        location: builder.at(own.name ?? own),
        tooltip: codeContext(own.name ?? own, 2),
        role: 'definition',
        // The override's own impact: its callers and the subtypes below it.
        action: { kind: 'overrideImpact', command: 'tsStructure.overrideImpact', file: own.getSourceFile().fileName, offset: (own.name ?? own).getStart() },
      });
    } else if (!ts.isInterfaceDeclaration(sub) && !ts.isInterfaceDeclaration(owner)) {
      const between = index.allSupertypes(sub).filter((s) => subtypes.includes(s) && findMember(s, name));
      if (between.length === 0) {
        inheriting.push({ label: typeName(sub), description: `inherits ${name} unchanged: affected · ${where(sub)}`, icon: 'symbol-class', tone: 'warning', location: builder.at(sub.name ?? sub), action: reroot(sub) });
      }
    }
  }

  // Call sites by the static type they call through.
  const family = new Set<ts.Node>([member, ...subtypes.map((s) => findMember(s, name)).filter((m): m is Member => !!m)]);
  const calls = { base: [] as ts.Node[], sub: new Map<string, ts.Node[]>(), superCalls: [] as ts.Node[] };
  const seen = new Set<ts.Node>();
  for (const declaration of family) {
    const nameNode = (declaration as ts.NamedDeclaration).name!;
    for (const reference of referencesAt(project.service, declaration.getSourceFile().fileName, nameNode.getStart())) {
      const access = accessExpression(reference);
      if (seen.has(reference) || access === reference || !ts.isPropertyAccessExpression(access)) {
        continue;
      }
      seen.add(reference);
      if (access.expression.kind === ts.SyntaxKind.SuperKeyword) {
        calls.superCalls.push(reference);
        continue;
      }
      const receiver = checker.getTypeAtLocation(access.expression);
      const receiverDeclaration = (receiver.getSymbol() ?? receiver.aliasSymbol)?.declarations?.find(isTypeDeclaration);
      if (!receiverDeclaration || receiverDeclaration === owner || index.allSupertypes(owner).includes(receiverDeclaration)) {
        calls.base.push(reference);
      } else {
        const key = typeName(receiverDeclaration);
        calls.sub.set(key, [...(calls.sub.get(key) ?? []), reference]);
      }
    }
  }
  const callRow = (node: ts.Node): ReportNode => ({
    label: `${functionLabel(enclosingFunction(node))}`,
    description: `${where(node)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
    icon: 'symbol-method',
    location: builder.at(node),
    tooltip: codeContext(node),
    role: 'read',
  });

  const impact = analyzeImpact({ program, checker }, { fileName, offset: (member.name ?? member).getStart(), scope: 'symbol' }, { includeInheritedMembers: true });
  const roots: ReportNode[] = [
    {
      label: `${typeName(owner)}.${name}`,
      description: overridden.length ? `overrides ${overridden.map((m) => `${typeName(m.parent as TypeDeclaration)}.${name}`).join(', ')}` : where(member),
      icon: 'symbol-method',
      tone: 'ok',
      location: builder.at(member.name ?? member),
      children: overridden.map((m) => ({ label: `${typeName(m.parent as TypeDeclaration)}.${name}`, description: 'base declaration: callers through it reach this one', icon: 'arrow-small-up', location: builder.at(m.name ?? m) })),
    },
    { label: 'Overrides in subtypes', description: plural(overrides.length, 'override'), icon: 'type-hierarchy-sub', expanded: true, children: overrides.length ? overrides : [{ label: 'none', icon: 'dash' }] },
  ];
  if (inheriting.length) {
    roots.push({ label: 'Subtypes that inherit it unchanged', description: plural(inheriting.length, 'type'), icon: 'symbol-class', tone: 'warning', expanded: true, children: inheriting });
  }
  roots.push({
    label: 'Call sites',
    description: plural(calls.base.length + calls.superCalls.length + [...calls.sub.values()].flat().length, 'call'),
    icon: 'call-incoming',
    expanded: true,
    children: [
      { label: `Through ${typeName(owner)} or a supertype: any implementation may run`, description: plural(calls.base.length, 'call'), icon: 'symbol-interface', tone: calls.base.length ? ('warning' as const) : undefined, children: calls.base.map(callRow) },
      ...[...calls.sub].map(([type, nodes]) => ({ label: `Through ${type}`, description: plural(nodes.length, 'call'), icon: 'symbol-class', children: nodes.map(callRow) })),
      { label: 'super calls from overrides', description: plural(calls.superCalls.length, 'call'), icon: 'debug-step-into', children: calls.superCalls.map(callRow) },
    ].filter((n) => n.children.length > 0),
  });
  roots.push({
    label: 'Impacted tests',
    description: plural(impact.tests.length, 'test'),
    icon: 'beaker',
    action: impact.tests.length ? { kind: 'runTests', tests: impact.tests.map((t) => t.test) } : undefined,
    children: impact.tests.map((t) => ({ label: t.test.titlePath.join(' › '), description: t.confidence, icon: 'beaker', location: { ...t.test.location, endLine: t.test.location.line, endCharacter: t.test.location.character } })),
  });
  return builder.finish(roots, `${plural(overrides.length, 'override')}, ${plural(inheriting.length, 'inheriting subtype')}, ${plural(impact.tests.length, 'test')}`);
}
