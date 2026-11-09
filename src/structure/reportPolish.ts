import { Report, ReportNode, forEachReportNode, plural, titleParts } from './report';

/**
 * Finishing touches each analysis's report gets before it is shown: an order that puts what matters first, counts
 * and markers (such as which rows are in tests), and warnings that follow from the rows. They work on the report's
 * rows alone, so every way a report is made (run, re-run, restored) gets them, and each is tested on plain data.
 */
export const isTestPath = (file: string | undefined): boolean => !!file && /(\.|_)(test|spec)\.[cm]?[jt]sx?$|[\\/](__tests__|test|tests)[\\/]/.test(file);

const lineOf = (n: ReportNode) => n.location?.line ?? Number.MAX_SAFE_INTEGER;
const byLine = (a: ReportNode, b: ReportNode) => (a.location?.file ?? '').localeCompare(b.location?.file ?? '') || lineOf(a) - lineOf(b);
const leaves = (nodes: readonly ReportNode[] | undefined): ReportNode[] => {
  const out: ReportNode[] = [];
  forEachReportNode(nodes ?? [], (n) => { if (!n.children?.length) out.push(n); });
  return out;
};
const append = (node: ReportNode, text: string) => {
  if (!node.description?.includes(text)) node.description = node.description ? `${node.description} · ${text}` : text;
};
/** Marks rows located in test files, once. */
const markTests = (nodes: readonly ReportNode[] | undefined) =>
  forEachReportNode(nodes ?? [], (n) => { if (!n.children?.length && isTestPath(n.location?.file)) append(n, 'test'); });
const root = (report: Report, label: string | RegExp) => report.roots.find((r) => (typeof label === 'string' ? r.label === label : label.test(r.label)));
const filesOf = (nodes: readonly ReportNode[]) => {
  const files = new Set<string>();
  forEachReportNode(nodes, (n) => { if (n.location) files.add(n.location.file); });
  return files;
};

type Polish = (report: Report) => void;

/** Find Usages groups that declare, import or export the symbol rather than use it. */
const declaring = (group: ReportNode) => /^(Definitions|Imports|Exports)/.test(group.label);

const polishers: Record<string, Polish> = {
  // Find Usages: the file you are in first, then the busiest; lines in order; how many functions; recursion; tests.
  usages(report) {
    const subject = titleParts(report).subject;
    let usedOutsideTests = false;
    for (const group of report.roots) {
      const files = group.children ?? [];
      for (const file of files) file.children?.sort(byLine);
      const here = (f: ReportNode) => (f.children ?? []).some((c) => c.focus);
      files.sort((a, b) => Number(here(b)) - Number(here(a)) || (b.children?.length ?? 0) - (a.children?.length ?? 0));
      const usages = files.flatMap((f) => f.children ?? []);
      const functions = new Set(usages.map((u) => u.description?.split(' · ')[0]).filter(Boolean));
      if (functions.size > 1) append(group, `in ${plural(functions.size, 'function')}`);
      if (group.label === 'Calls' && subject) {
        for (const u of usages) if (u.description?.split(' · ')[0] === subject) append(u, 'recursive call');
      }
      if (!declaring(group) && files.some((f) => !f.description?.includes('test'))) usedOutsideTests = true;
    }
    const used = report.roots.some((g) => !declaring(g));
    if (used && !usedOutsideTests && subject) report.warnings.push(`${subject} is used only in tests: production code never reaches it.`);
  },

  // Data Flow: rows in tests marked, the files it crosses counted, and a way on when the value goes nowhere.
  dataFlow(report) {
    const flowIn = root(report, 'Flows in');
    const flowOut = root(report, 'Flows out');
    markTests([...(flowIn?.children ?? []), ...(flowOut?.children ?? [])]);
    const files = filesOf(report.roots).size;
    if (files > 1 && report.description && !report.description.includes('files')) report.description += `, across ${plural(files, 'file')}`;
    if (flowOut && !flowOut.children?.length) {
      flowOut.children = [{ label: 'Not passed on, returned or stored', description: 'Find Usages lists every place that names it', icon: 'info' }];
    }
  },

  // Nullability: unsafe uses first, how many there are, and what makes a safe value safe.
  nullability(report) {
    const uses = root(report, 'Uses');
    if (uses?.children) {
      const rank = (n: ReportNode) => (n.tone === 'warning' || n.tone === 'error' ? 0 : n.tone === 'ok' ? 2 : 1);
      uses.children.sort((a, b) => rank(a) - rank(b) || byLine(a, b));
      const unsafe = uses.children.filter((n) => n.tone === 'warning' || n.tone === 'error').length;
      if (unsafe && report.description && !report.description.includes('unsafe')) report.description += `, ${plural(unsafe, 'unsafe use')}`;
    }
    const guards = root(report, 'Ruled out by');
    if (guards?.children?.length && report.roots[0]) append(report.roots[0], `ruled out by ${plural(guards.children.length, 'check')}`);
  },

  // Promise Rejections: sources in line order, and handled paths counted beside the unhandled ones.
  rejections(report) {
    const sources = root(report, 'Rejection sources');
    sources?.children?.sort(byLine);
    const where = root(report, 'Where rejections go');
    const results = leaves(where?.children);
    const handled = results.filter((r) => r.tone === 'ok' || r.tone === 'info').length;
    if (handled && report.description && !report.description.includes('handled')) report.description += `, ${handled} handled`;
    if (!root(report, 'Unhandled') && results.length) {
      report.roots.unshift({ label: 'Every rejection is handled', description: plural(results.length, 'path'), icon: 'pass', tone: 'ok' });
    }
  },

  // Dead Exports: the files with the most first, line numbers, how many files, entry points sorted and folded.
  deadExports(report) {
    for (const group of report.roots) {
      if (group.label === 'Entry points') {
        group.children?.sort((a, b) => a.label.localeCompare(b.label));
        group.expanded = false;
        continue;
      }
      group.children?.sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0) || a.label.localeCompare(b.label));
      forEachReportNode(group.children ?? [], (n) => { if (n.location && !n.children?.length) append(n, `line ${n.location.line + 1}`); });
      if (group.children?.length && group.label !== 'How to fix') append(group, `in ${plural(group.children.length, 'file')}`);
    }
    let types = 0;
    forEachReportNode(report.roots, (n) => { if (/(^| · )type( · |$)/.test(n.description ?? '')) types++; });
    if (types && report.description) report.description += `, ${plural(types, 'type')} among them`;
  },

  // Exception Flow: thrown errors in line order, error types by how often, uncaught paths in the summary.
  exceptions(report) {
    for (const label of ['Thrown here', 'Thrown by called functions']) root(report, label)?.children?.sort(byLine);
    const types = root(report, 'Error types');
    types?.children?.sort((a, b) => parseInt(b.description ?? '0') - parseInt(a.description ?? '0'));
    const uncaught = root(report, 'Uncaught');
    if (uncaught?.children?.length && report.description && !report.description.includes('uncaught')) report.description += `, ${uncaught.children.length} uncaught`;
  },

  // Duplicates: copies in one file or only in tests say so; the biggest copy is in the summary.
  duplicates(report) {
    let largest = 0;
    for (const group of report.roots) {
      const copies = (group.children ?? []).filter((c) => c.location);
      if (!copies.length) continue;
      largest = Math.max(largest, ...copies.map((c) => (c.location!.endLine - c.location!.line + 1)));
      markTests(copies);
      if (new Set(copies.map((c) => c.location!.file)).size === 1) append(group, 'all in one file');
      const differs = /Differs in: (.*)/.exec(group.tooltip ?? '');
      if (differs) append(group, plural(differs[1].split(', ').length, 'difference'));
      if (copies.every((c) => isTestPath(c.location!.file))) {
        group.tone = 'info';
        append(group, 'only in tests, often fine');
      }
    }
    if (largest && report.description) report.description += `, largest ${plural(largest, 'line')}`;
  },

  // Re-exports: numbered hops, barrel files named, importers in tests marked, how many files import it.
  reexports(report) {
    const chain = root(report, 'Resolution from the cursor');
    chain?.children?.forEach((step, i, all) => {
      if (i < all.length - 1) step.label = `${i + 1}. ${step.label}`;
      if (/(^|[\\/])index\.[cm]?[jt]sx?( |$)/.test(step.description ?? '') || /(^|[\\/])index\.[cm]?[jt]sx?$/.test(step.location?.file ?? '')) append(step, 'barrel');
    });
    const imported = root(report, 'Imported through');
    markTests(imported?.children);
    const importers = filesOf(imported?.children ?? []).size;
    if (importers && report.description) report.description += `, imported in ${plural(importers, 'file')}`;
  },

  // Inheritance: subtypes in tests marked, members by how often they are overridden, a count in the summary.
  hierarchy(report) {
    markTests(root(report, 'Subtypes and implementations')?.children);
    const members = root(report, 'Members');
    members?.children?.sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0));
    const overridden = (members?.children ?? []).filter((m) => m.children?.length).length;
    if (overridden && report.description) report.description += `, ${plural(overridden, 'member')} overridden`;
    const subtypes = root(report, 'Subtypes and implementations');
    const subtypeFiles = filesOf(subtypes?.children ?? []).size;
    if (subtypeFiles > 1 && subtypes) append(subtypes, `in ${plural(subtypeFiles, 'file')}`);
    // A plain "none" says what it means.
    const supers = root(report, 'Supertypes');
    if (supers?.children?.length === 1 && supers.children[0].label === 'none') supers.children[0].label = 'extends and implements nothing';
    if (subtypes?.children?.length === 1 && subtypes.children[0].label === 'none') subtypes.children[0].label = 'nothing extends or implements it';
  },
  overrideImpact(report) {
    markTests(root(report, 'Call sites')?.children);
  },

  // Dependency Path: barrel hops named, and how many modules the paths go through.
  dependencyPath(report) {
    const paths = root(report, 'Shortest paths');
    const modules = new Set<string>();
    for (const p of paths?.children ?? []) {
      for (const hop of p.children ?? []) {
        if (hop.location) modules.add(hop.location.file);
        if (/[\\/]index\.[cm]?[jt]sx?:|^index\.[cm]?[jt]sx?:/.test(hop.label) || /[\\/]index\.[cm]?[jt]sx?$/.test(hop.location?.file ?? '')) append(hop, 'barrel');
      }
    }
    if (modules.size && report.description) report.description += `, through ${plural(modules.size, 'module')}`;
    // Shortest first, and type-only imports said to cost nothing at run time.
    paths?.children?.sort((a, b) => (a.children?.length ?? 0) - (b.children?.length ?? 0));
    forEachReportNode(paths?.children ?? [], (hop) => { if (/\bimport type\b|\bexport type\b/.test(hop.label)) append(hop, 'type only: no run-time dependency'); });
    root(report, /^Modules on these paths/)?.children?.sort((a, b) => a.label.localeCompare(b.label));
  },

  // Graph Diff: test files marked, removed imports shown as an improvement, files changed in the summary.
  graphDiff(report) {
    for (const group of report.roots) markTests(group.children);
    const removed = root(report, 'Removed imports');
    if (removed?.children?.length) removed.tone = 'ok';
    const files = filesOf(report.roots).size;
    if (files && report.description && !report.description.includes('files')) report.description += `, ${plural(files, 'file')} involved`;
    // New cycles are the news: first, and open.
    const cycles = root(report, 'New import cycles');
    if (cycles) {
      report.roots.splice(report.roots.indexOf(cycles), 1);
      report.roots.unshift({ ...cycles, expanded: true });
    }
    root(report, 'Biggest changes in importers')?.children?.sort((a, b) => parseInt((b.description ?? '').replace(/[^\d-]/g, '') || '0') - parseInt((a.description ?? '').replace(/[^\d-]/g, '') || '0'));
  },

  // Argument Propagation: risky values first, values that differ only in case, call sites in tests marked.
  argumentFlow(report) {
    markTests(root(report, 'Where values come from')?.children);
    const values = root(report, 'Values that can arrive');
    if (values?.children) {
      const risky = (n: ReportNode) => (/undefined|null|omitted/.test(n.label) ? 0 : 1);
      values.children.sort((a, b) => risky(a) - risky(b) || a.label.localeCompare(b.label));
      const literals = values.children.map((v) => v.label).filter((l) => /^['"`].*['"`]$/.test(l));
      const byCase = new Map<string, string[]>();
      for (const l of literals) byCase.set(l.toLowerCase(), [...(byCase.get(l.toLowerCase()) ?? []), l]);
      for (const same of byCase.values()) {
        if (same.length > 1) report.warnings.push(`${same.join(' and ')} differ only in letter case: a typo, or a value that should be normalized?`);
      }
      if (report.description) report.description += `, ${plural(values.children.length, 'distinct value')}`;
    }
    const from = root(report, 'Where values come from');
    const callFiles = filesOf(from?.children ?? []).size;
    if (from && callFiles > 1) append(from, `from ${plural(callFiles, 'file')}`);
  },
};

Object.assign(polishers, {
  // Inspect Code: busiest files first, problems in line order, tests marked, the most common problem, the fixes.
  inspectCode(report: Report) {
    let top: { label: string; count: number } | undefined;
    let fixable = 0;
    for (const rule of report.roots) {
      const files = rule.children ?? [];
      files.sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0));
      for (const file of files) {
        file.children?.sort(byLine);
        if (file.description?.includes('fixable')) fixable++;
        if (isTestPath(file.children?.[0]?.location?.file)) append(file, 'test');
      }
      if (files.length > 1) append(rule, `in ${plural(files.length, 'file')}`);
      const count = files.reduce((n, f) => n + (f.children?.length ?? 0), 0);
      if (!top || count > top.count) top = { label: rule.label, count };
    }
    if (top && report.roots.length > 1 && report.description) report.description += `; most common: ${top.label} (${top.count})`;
    if (fixable) report.roots.unshift({ label: `${plural(fixable, 'file')} can be fixed in one go`, description: 'right-click a file, or a finding, for its fix', icon: 'lightbulb', tone: 'info' });
  },

  // Structural search: busiest files first, tests marked, identical matches counted, the commonest placeholder value.
  structuralSearch(report: Report) {
    if (!report.roots.length) {
      report.roots.push({ label: 'No match', description: 'loosen the pattern with placeholders such as $x$ or $args$, or search a wider scope', icon: 'info', tone: 'info' });
      return;
    }
    report.roots.sort((a, b) => (b.children?.length ?? 0) - (a.children?.length ?? 0));
    const sameText = new Map<string, number>();
    const bindings = new Map<string, number>();
    for (const file of report.roots) {
      markTests(file.children);
      for (const m of file.children ?? []) {
        sameText.set(m.label, (sameText.get(m.label) ?? 0) + 1);
        for (const b of (m.description ?? '').split(/,\s*/).filter((x) => /=/.test(x))) bindings.set(b, (bindings.get(b) ?? 0) + 1);
      }
    }
    forEachReportNode(report.roots, (m) => {
      const n = sameText.get(m.label) ?? 0;
      if (!m.children?.length && n > 1) append(m, `${n} identical`);
    });
    const common = [...bindings].sort((a, b) => b[1] - a[1])[0];
    if (common && common[1] > 1 && report.description) report.description += `; most common: ${common[0]} (${common[1]})`;
  },
});

/** Applies the finishing touches for the report's kind; a report polished twice is unchanged. */
export function polishReport(report: Report): Report {
  if (report.polished) return report;
  polishers[report.kind]?.(report);
  report.polished = true;
  return report;
}
