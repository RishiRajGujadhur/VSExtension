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

/** A literal or a freshly built object: a value written into the code, not one computed from elsewhere. */
const isLiteral = (text: string) => /^(['"`].*['"`]|-?\d[\d_.]*n?|true|false|null|undefined|new [A-Z]\w*\(.*\)|\[.*\]|\{.*\})$/.test(text.trim());
/** The kind of change a write makes, from its code. */
const writeKind = (code: string) => (/(\+\+|--)/.test(code) ? 'increment' : /[-+*/%&|^]=|\?\?=|&&=|\|\|=/.test(code) ? 'compound assignment' : /\.(push|pop|shift|unshift|splice|sort|reverse|set|delete|add|clear)\(/.test(code) ? 'changed in place' : 'assignment');

Object.assign(polishers, {
  // Data Flow, more: call sites counted, literal values and values set at import time marked, the type and reach.
  dataFlow: ((base: Polish) => (report: Report) => {
    base(report);
    const incoming = forEachFind(report.roots, (n) => n.label === 'Incoming values from call sites');
    if (incoming?.children?.length) {
      const callFiles = new Set(incoming.children.map((c) => c.description?.split(' · ').pop()).filter(Boolean)).size;
      append(incoming, `${plural(incoming.children.length, 'call site')}${callFiles > 1 ? ` in ${plural(callFiles, 'file')}` : ''}`);
      for (const c of incoming.children) {
        if (isLiteral(c.label)) append(c, 'literal value');
        if (/^module scope\b/.test(c.description ?? '')) append(c, 'set when the module loads');
      }
    }
    // The type of the value, from the row at the cursor ("line 18 · PaymentMethod · at cursor").
    const atCursor = forEachFind(report.roots, (n) => /(^| · )at cursor$/.test(n.description ?? ''));
    const type = atCursor?.description?.split(' · ').slice(-2, -1)[0];
    if (type && !/^line \d+$/.test(type) && report.description && !report.description.includes(' type ')) report.description += `, type ${type}`;
    // How far the value travels: the functions it is read or passed on in.
    const out = root(report, 'Flows out');
    const reached = new Set<string>();
    forEachReportNode(out?.children ?? [], (n) => {
      const fn = (n.description ?? '').split(' · ').find((part) => part && !/^line \d+$|\.[cm]?[jt]sx?$|^then |^\d+ /.test(part));
      if (fn && fn !== 'module scope') reached.add(fn);
    });
    if (out && reached.size > 1) append(out, `reaches ${plural(reached.size, 'function')}`);
  })(polishers.dataFlow),

  // Explain Value Path: conditions every value needs lifted out, branches in words, the simplest and commonest marked.
  explainValue(report: Report) {
    const values = report.roots.filter((r) => /^= /.test(r.label));
    if (!values.length) return;
    const conditionsOf = (v: ReportNode) => (v.children ?? []).flatMap((way) => way.children ?? []);
    // A branch label in words: "yes" is "the yes branch"; "case 'admin'" stays.
    for (const v of values) for (const c of conditionsOf(v)) {
      if (c.description === 'yes' || c.description === 'no') c.description = `the ${c.description} branch`;
    }
    const ways = (v: ReportNode) => v.children?.length ?? 0;
    const counts = values.map((v) => Math.max(0, ...(v.children ?? []).map((w) => w.children?.length ?? 0)));
    for (const v of values) if (!conditionsOf(v).length) append(v, 'no condition: always, unless changed later');
    const most = Math.max(...values.map(ways));
    if (values.length > 1 && most > 1 && values.filter((v) => ways(v) === most).length === 1) append(values.find((v) => ways(v) === most)!, 'the most ways lead here');
    // A condition on every way to every value is needed for the variable to be set here at all.
    const everyWay = values.flatMap((v) => v.children ?? []);
    const shared = everyWay.length > 1 ? (everyWay[0].children ?? []).map((c) => c.label).filter((label) => everyWay.every((w) => (w.children ?? []).some((c) => c.label === label))) : [];
    if (shared.length && values.length > 1) report.roots.unshift({ label: `Every value needs ${shared.join(' and ')}`, description: 'true for all of them; the values differ only in the other conditions', icon: 'filter', tone: 'info' });
    const deepest = Math.max(...counts);
    if (deepest > 1 && report.description && !report.description.includes('condition')) report.description += `, up to ${plural(deepest, 'condition')} each`;
  },

  // Nullability, more: a clear "safe" result, how many ways it can be missing, tests marked, null and undefined, tips.
  nullability: ((base: Polish) => (report: Report) => {
    base(report);
    const uses = root(report, 'Uses');
    markTests(uses?.children);
    const unsafe = (uses?.children ?? []).filter((n) => n.tone === 'warning' || n.tone === 'error');
    if (uses?.children?.length && !unsafe.length && !report.roots.some((r) => r.label === 'Every use is safe')) {
      report.roots.splice(1, 0, { label: 'Every use is safe', description: 'each one is checked first, or reads through ?. or ??', icon: 'pass', tone: 'ok' });
    }
    const paths = root(report, /^Paths that produce/);
    if (paths?.children?.length) append(paths, plural(paths.children.length, 'way'));
    const subject = report.roots[0]?.label ?? '';
    if (/\bnull\b/.test(subject) && /\bundefined\b/.test(subject)) append(report.roots[0], 'null and undefined: != null checks both');
    // The tips: folded when nothing is unsafe; ?. first when an unsafe use reads a property.
    const tips = root(report, 'How to fix');
    if (tips?.children) {
      if (!unsafe.length) tips.expanded = false;
      else if (unsafe.some((u) => /\.\w/.test(u.label))) tips.children.sort((a, b) => Number(/\?\./.test(b.label)) - Number(/\?\./.test(a.label)));
    }
  })(polishers.nullability),

  // Mutations of a variable: what kind of change each write is, "could be const", writers counted, tests marked.
  variableMutations(report: Report) {
    const groups = report.roots.filter((r) => r.children?.length && r.label !== 'Possible race conditions' && !/^How to fix/.test(r.label));
    let writers = 0;
    let async = 0;
    let changes = 0;
    for (const g of groups) {
      if (g.label === 'module scope' && g.children?.every((c) => /initial value/.test(c.description ?? ''))) {
        g.expanded = false;
        continue;
      }
      const writes = (g.children ?? []).filter((c) => !/initial value/.test(c.description ?? ''));
      if (!writes.length) continue;
      writers++;
      if (/\basync\b|runs from/.test(g.description ?? '')) async++;
      for (const w of writes) {
        changes++;
        append(w, writeKind(w.label));
      }
      markTests(writes);
    }
    if (!changes && report.roots[0]) {
      report.roots.splice(1, 0, { label: 'Never changes after it starts', description: 'nothing writes to it: it could be const', icon: 'lightbulb', tone: 'info' });
    }
    if (writers > 1 && report.description && !report.description.includes('async')) report.description += async ? `, ${async} of ${writers} writers async` : `, ${writers} writers`;
  },

  // Race conditions: a clear "none found", x++ as one step, lost updates first, async writers counted, tests marked.
  races(report: Report) {
    const found = root(report, 'Possible race conditions');
    if (!found) {
      report.roots.splice(1, 0, { label: 'No race found', description: 'no await falls between reading and writing it, and at most one async writer', icon: 'pass', tone: 'ok' });
    } else {
      const rank = (n: ReportNode) => (/^Lost update/.test(n.label) ? 0 : 1);
      found.children?.sort((a, b) => rank(a) - rank(b));
    }
    const users = root(report, 'Who uses it, in order');
    for (const fn of users?.children ?? []) {
      for (const use of fn.children ?? []) {
        if (/(\+\+|--)/.test(use.label) && /write/.test(use.description ?? '')) append(use, 'read and write in one step: nothing can run in between');
      }
      markTests(fn.children);
    }
    const asyncWriters = (users?.children ?? []).filter((f) => /\basync\b|runs from/.test(f.description ?? '') && (f.children ?? []).some((c) => /write/.test(c.description ?? ''))).length;
    if (asyncWriters && report.description && !report.description.includes('writer')) report.description += `, ${plural(asyncWriters, 'async writer')}`;
  },

  // React state: state never set or never read, refs read while rendering, unused props, missing dependencies first.
  reactState(report: Report) {
    const group = (label: string) => root(report, new RegExp(`^${label}\\b`));
    const reads = (n: ReportNode) => (n.children ?? []).some((c) => /^(read|triggers|recomputed)/.test(c.label));
    for (const s of group('State')?.children ?? []) {
      if (!(s.children ?? []).some((c) => /^set in/.test(c.label))) append(s, 'never set: a constant or a prop would do');
      if (!reads(s)) {
        append(s, 'set but never read: it may not need to be state');
        s.tone = s.tone ?? 'info';
      }
    }
    for (const r of group('Refs')?.children ?? []) {
      if ((r.children ?? []).some((c) => /^read in rendered/.test(c.label))) {
        append(r, 'read while rendering: changing it does not re-render');
        r.tone = 'warning';
      }
    }
    for (const p of group('Props')?.children ?? []) if (!p.children?.length) append(p, 'not used');
    for (const m of group('Memoized')?.children ?? []) if (!(m.children ?? []).some((c) => /^read/.test(c.label))) append(m, 'never read');
    const effects = group('Effects');
    if (effects?.children) {
      const missing = (e: ReportNode) => (e.children ?? []).filter((c) => /missing from the dependencies/.test(c.label)).length;
      effects.children.sort((a, b) => missing(b) - missing(a));
      const total = effects.children.reduce((n, e) => n + missing(e), 0);
      if (total && report.description && !report.description.includes('missing')) report.description += `, ${plural(total, 'missing dependency', 'missing dependencies')}`;
    }
  },
});

Object.assign(polishers, {
  // Error paths, more: a calm "nothing can throw", same messages, thrown strings, how deep, plain Error only.
  exceptions: ((base: Polish) => (report: Report) => {
    base(report);
    const sources = [...(root(report, 'Thrown here')?.children ?? []), ...(root(report, 'Thrown by called functions')?.children ?? [])].filter((n) => n.tone !== 'ok');
    if (!sources.length) {
      const subject = titleParts(report).subject;
      report.roots.unshift({ label: `No error can leave ${subject || 'it'}`, description: 'nothing it runs throws', icon: 'pass', tone: 'ok' });
      const tips = root(report, 'How to fix');
      if (tips) report.roots.splice(report.roots.indexOf(tips), 1);
      return;
    }
    // The message of each throw: two throws with the same message can't be told apart in a log.
    const message = (n: ReportNode) => /throw new \w+\((['"`])(.*?)\1/.exec(n.label + ' ' + (n.children ?? []).map((c) => c.label).join(' '))?.[2];
    const byMessage = new Map<string, number>();
    for (const s of sources) { const m = message(s); if (m) byMessage.set(m, (byMessage.get(m) ?? 0) + 1); }
    for (const [m, count] of byMessage) if (count > 1) report.warnings.push(`${count} errors have the same message '${m}': in a log you can't tell which one happened.`);
    forEachReportNode(sources, (n) => {
      if (/throw (['"`]|\d)/.test(n.label)) append(n, 'throws a plain value, not an Error: no stack trace');
    });
    for (const s of root(report, 'Thrown by called functions')?.children ?? []) {
      const hops = (s.children ?? []).filter((c) => /^calls /.test(c.label)).length + 1;
      if (hops > 1) append(s, `${hops} calls deep`);
    }
    const types = root(report, 'Error types');
    if (types?.children?.length === 1 && types.children[0].label === 'Error') append(types, 'only plain Error: an error class of your own lets callers catch it by type');
  })(polishers.exceptions),

  // Promise rejections, more: swallowed ones counted, a plain answer for non-async code, causes kept, tips, tests.
  rejections: ((base: Polish) => (report: Report) => {
    base(report);
    const where = root(report, 'Where rejections go');
    const notAsync = report.warnings.find((w) => /is not async and does not return a promise/.test(w));
    if (notAsync && !(where?.children?.length)) {
      report.roots = [{ label: notAsync.replace(/\.$/, ''), description: 'nothing it does can reject; pick an async function or one that returns a promise', icon: 'info', tone: 'info' }];
      report.warnings = report.warnings.filter((w) => w !== notAsync);
      return;
    }
    let swallowed = 0;
    forEachReportNode(where?.children ?? [], (n) => {
      if (/logs the error and continues|ignores the error|empty catch/.test(n.label) && !n.children?.length) swallowed++;
      if (/\{ cause/.test(n.label) && !n.children?.length) append(n, 'keeps the original error as its cause');
    });
    if (swallowed && report.description && !report.description.includes('swallowed')) report.description += `, ${swallowed} swallowed`;
    markTests(where?.children);
    const tips = root(report, 'How to fix');
    const unhandled = root(report, 'Unhandled');
    if (tips?.children && unhandled?.children?.some((n) => /^not awaited/.test(n.label))) tips.children.sort((a, b) => Number(/fire and forget/.test(b.label)) - Number(/fire and forget/.test(a.label)));
  })(polishers.rejections),

  // Side effects: what being pure allows, how to fix each kind, logging only, the worst calls first.
  sideEffects(report: Report) {
    const top = report.roots[0];
    if (report.roots.length === 1 && top?.tone === 'ok') {
      append(top, 'safe to cache, to call in any order and to test with plain inputs');
      return;
    }
    const fixes: Record<string, string> = {
      'Mutates arguments': 'callers see the change: copy first ([...items], { ...obj }) to leave theirs alone',
      'Mutates module state': 'every caller shares it: pass the state in, or return the new value instead',
      Nondeterministic: 'pass the clock or random source in as a parameter, so tests can fix it',
      'Input/output': 'keep it at the edges: do the work in a pure function and the I/O around it',
    };
    for (const group of report.roots) {
      const kind = Object.keys(fixes).find((k) => group.label.startsWith(k));
      if (kind && group.children?.length) group.tooltip = `${group.tooltip ? `${group.tooltip}\n` : ''}How to fix: ${fixes[kind]}.`;
      if (kind && group.children?.length && !group.children.some((c) => c.label.startsWith('How to fix'))) group.children.push({ label: `How to fix: ${fixes[kind]}`, icon: 'lightbulb', tone: 'info' });
    }
    const kinds = report.roots.filter((g) => Object.keys(fixes).some((k) => g.label.startsWith(k)) && g.children?.some((c) => !c.label.startsWith('How to fix')));
    if (kinds.length === 1 && kinds[0].label.startsWith('Input/output') && kinds[0].children!.every((c) => c.label.startsWith('How to fix') || /console/.test(c.label))) {
      append(top, 'it only logs: otherwise pure');
    }
    const byCall = root(report, 'By call');
    const rank = (n: ReportNode) => (n.tone === 'error' ? 0 : n.tone === 'warning' ? 1 : 2);
    byCall?.children?.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  },
});

Object.assign(polishers, {
  // Find usages, more: no empty " · " at the start, repeated rows once, renames, load-time code, outside tests.
  usages: ((base: Polish) => (report: Report) => {
    forEachReportNode(report.roots, (n) => { if (n.description) n.description = n.description.replace(/^\s*·\s*/, '').trim() || undefined; });
    base(report);
    for (const group of report.roots) {
      for (const file of group.children ?? []) {
        // The same line listed twice (an export of two names, say) is one row.
        const seen = new Set<string>();
        file.children = file.children?.filter((u) => { const key = `${u.location?.line}:${u.label}`; if (seen.has(key)) return false; seen.add(key); return true; });
        for (const u of file.children ?? []) {
          const subject = titleParts(report).subject;
          const renamed = subject && new RegExp(`\\b${subject}\\s+as\\s+(\\w+)`).exec(u.label)?.[1];
          if (renamed) append(u, `renamed to ${renamed}`);
          if (group.label === 'Calls' && /^module scope\b/.test(u.description ?? '')) append(u, 'runs when the module loads');
        }
      }
    }
    const outside = new Set<string>();
    for (const group of report.roots) if (!declaring(group)) for (const file of group.children ?? []) if (!isTestPath(file.children?.[0]?.location?.file) && !/(^| · )test( · |$)/.test(file.description ?? '')) outside.add(file.label);
    if (outside.size && report.description && !report.description.includes('outside tests')) report.description += `; used in ${plural(outside.size, 'file')} outside tests`;
  })(polishers.usages),

  // Callers and calls: entry points reached, async calls, callers in tests, "nothing calls it", implementations.
  callGraph(report: Report) {
    const callers = root(report, 'Called by');
    const calls = root(report, 'Calls');
    const entries = new Set<string>();
    forEachReportNode(callers?.children ?? [], (n) => { if (/entry point|top-level code/.test(n.description ?? '')) entries.add(n.label); });
    if (entries.size && report.description && !report.description.includes('entry')) report.description += `, reached from ${plural(entries.size, 'entry point')}`;
    markTests(callers?.children);
    if (callers && !callers.children?.length) callers.children = [{ label: `Nothing calls ${titleParts(report).subject || 'it'}`, description: 'unused, or called only from outside the project (a framework, a test runner)', icon: 'info', tone: 'info' }];
    let async = 0;
    forEachReportNode(calls?.children ?? [], (n) => { if (/(^| · )async( · |$)/.test(n.description ?? '') && !/shown above/.test(n.description ?? '')) async++; });
    if (calls && async) append(calls, `${async} async`);
    const implementations = (calls?.children ?? []).filter((c) => /(^| · )implementation( · |$)/.test(c.description ?? ''));
    if (implementations.length > 1) for (const c of implementations) append(c, `one of ${implementations.length}: which runs depends on the object`);
  },

  // Arguments passed in, more: unused parameters, a union type for a few literals, computed values, how deep.
  argumentFlow: ((base: Polish) => (report: Report) => {
    base(report);
    const goes = root(report, 'Where the value goes');
    if (goes && !goes.children?.length) goes.children = [{ label: 'Not used inside the function', description: 'the parameter could go, or a caller expects it to be used', icon: 'warning', tone: 'warning' }];
    // How many calls deep it is handed on: each "→ name()" step is a call.
    let depth = 0;
    const walk = (nodes: readonly ReportNode[], d: number) => nodes.forEach((n) => { const here = d + (/→ [\w.]+\(\)/.test(n.label) ? 1 : 0); depth = Math.max(depth, here); walk(n.children ?? [], here); });
    walk(goes?.children ?? [], 0);
    if (goes && depth > 1) append(goes, `handed on ${depth} calls deep`);
    const values = root(report, 'Values that can arrive');
    const labels = (values?.children ?? []).map((v) => v.label);
    if (labels.length >= 2 && labels.length <= 6 && labels.every((l) => /^'[^']*'$|^"[^"]*"$/.test(l))) {
      report.roots.push({ label: `Always one of ${labels.join(', ')}`, description: `a union type would say so: ${labels.map((l) => `'${l.slice(1, -1)}'`).join(' | ')}`, icon: 'lightbulb', tone: 'info' });
    }
    for (const from of root(report, 'Where values come from')?.children ?? []) if (!/^(['"`]|-?\d|true|false|null|undefined|\{|\[)/.test(from.label)) append(from, 'computed at the call');
  })(polishers.argumentFlow),

  // Family tree, more: how deep it goes, overrides that call super, members nobody overrides, required members.
  hierarchy: ((base: Polish) => (report: Report) => {
    base(report);
    const subtypes = root(report, 'Subtypes and implementations');
    let depth = 0;
    const walk = (nodes: readonly ReportNode[], d: number) => nodes.forEach((n) => { if (n.label !== 'nothing extends or implements it') depth = Math.max(depth, d); walk(n.children ?? [], d + 1); });
    walk(subtypes?.children ?? [], 1);
    if (depth > 1 && report.description) report.description += `, ${depth} levels deep`;
    let supers = 0;
    const members = root(report, 'Members');
    for (const m of members?.children ?? []) {
      supers += (m.children ?? []).filter((o) => /calls super/.test(o.description ?? '')).length;
      if (!m.children?.length) append(m, 'not overridden');
      if (/from \w+/.test(m.description ?? '') && /(^| · )abstract( · |$)|^interface/.test(`${m.description}`)) append(m, 'required by the supertype');
    }
    if (supers && members) append(members, `${plural(supers, 'override')} call super`);
  })(polishers.hierarchy),

  // Override reach, more: implementations counted, call sites in tests, signature changes, files, no callers.
  overrideImpact: ((base: Polish) => (report: Report) => {
    base(report);
    const overrides = root(report, 'Overrides in subtypes');
    for (const o of overrides?.children ?? []) if (/^implements it/.test(o.description ?? '')) append(o, 'a change to the signature reaches it');
    const sites = root(report, 'Call sites');
    if (sites && !sites.children?.length) sites.children = [{ label: 'Nothing calls it directly', description: 'a change reaches only the overrides', icon: 'info', tone: 'info' }];
    forEachReportNode(sites?.children ?? [], (n) => { if (!n.children?.length && isTestPath(n.location?.file)) append(n, 'test'); });
    const files = filesOf(report.roots).size;
    if (files > 1 && report.description && !report.description.includes('files')) report.description += `, in ${plural(files, 'file')}`;
  })(polishers.overrideImpact),

  // Re-export trail, more: renames named, re-exports nobody imports, type-only hops, a long trail through barrels.
  reexports: ((base: Polish) => (report: Report) => {
    base(report);
    const chain = root(report, 'Resolution from the cursor');
    const declared = /class (\w+)|function (\w+)|(?:const|let|var|interface|type|enum) (\w+)/.exec(chain?.children?.find((s) => /^declared:/.test(s.label))?.label ?? '');
    const original = declared ? declared[1] || declared[2] || declared[3] : undefined;
    let barrels = 0;
    for (const step of chain?.children ?? []) {
      const as = /(?:^| · )as (\w+)(?: · |$)/.exec(step.description ?? '')?.[1];
      if (original && as && as !== original && /\bas\b/.test(step.label)) append(step, `renamed from ${original}`);
      if (/\btype\b/.test(step.label.split('{')[0])) append(step, 'type only');
      if (/(^| · )barrel( · |$)/.test(step.description ?? '')) barrels++;
    }
    for (const m of root(report, 'Exported as')?.children ?? []) if (/re-export · no importers/.test(m.description ?? '')) append(m, 'nobody imports it from here: this re-export could go');
    if (barrels > 1) report.warnings.push(`The trail passes ${barrels} barrel files: each one is a file to open when reading it, and can slow builds and tests.`);
  })(polishers.reexports),
});

Object.assign(polishers, {
  // Who imports this: tests last and counted, barrels named, "nothing imports it", widely used files.
  dependents(report: Report) {
    let tests = 0;
    let importers = 0;
    for (const group of report.roots) {
      for (const m of group.children ?? []) {
        importers++;
        const isTest = m.description === 'test' || isTestPath(m.location?.file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(m.label);
        if (isTest) { tests++; if (m.description !== 'test') append(m, 'test'); }
        if (/^index\.[cm]?[jt]sx?$/.test(m.label)) append(m, 'barrel: everything that imports it reaches this file too');
      }
      const isTestRow = (m: ReportNode) => m.description?.split(' · ').includes('test') || /\.(test|spec)\./.test(m.label);
      group.children?.sort((a, b) => Number(isTestRow(a)) - Number(isTestRow(b)) || a.label.localeCompare(b.label));
    }
    if (!importers) {
      report.roots.unshift({ label: 'Nothing imports it', description: 'an entry point, a script, or a file that could go', icon: 'info', tone: 'info' });
      return;
    }
    if (tests && report.description && !report.description.includes('test')) report.description += `, ${plural(tests, 'test')} among them`;
    const direct = root(report, /^Import it directly/)?.children?.length ?? 0;
    if (direct >= 10) report.roots.unshift({ label: `Widely used: ${direct} modules import it directly`, description: 'a change to its exports ripples far; keep them stable', icon: 'broadcast', tone: 'info' });
  },

  // Import loops: none said plainly, shortest loops first, modules involved, test files, type-only links.
  cycles(report: Report) {
    const none = report.warnings.find((w) => /No modules import each other/.test(w));
    if (none && !report.roots.length) {
      report.warnings = report.warnings.filter((w) => w !== none);
      report.roots.push({ label: 'No import loops', description: 'no modules import each other at run time', icon: 'pass', tone: 'ok' });
      return;
    }
    const loops = report.roots.filter((r) => / ⇄ /.test(r.label));
    loops.sort((a, b) => a.label.split(' ⇄ ').length - b.label.split(' ⇄ ').length);
    const rest = report.roots.filter((r) => !loops.includes(r));
    report.roots = [...loops, ...rest];
    const modules = new Set(loops.flatMap((l) => l.label.split(' ⇄ ')));
    if (modules.size && report.description && !report.description.includes('involved')) report.description += `, ${plural(modules.size, 'module')} involved`;
    for (const l of loops) {
      markTests(l.children);
      if (l.label.split(' ⇄ ').length === 2) append(l, 'two modules: the easiest kind to break');
    }
  },

  // Why this import, more: runtime and type-only paths counted, the line to change to break the runtime path.
  dependencyPath: ((base: Polish) => (report: Report) => {
    base(report);
    const runtime = root(report, /^Longer runtime path|^Shortest paths/)?.children?.filter((p) => /runtime/.test(p.description ?? '') || !/type-only/.test(p.description ?? '')) ?? [];
    const typeOnly = forEachCount(report.roots, (n) => /^Path \d+/.test(n.label) && /type-only/.test(n.description ?? ''));
    if (typeOnly && report.description && !report.description.includes('type-only')) report.description += `, ${typeOnly} type-only`;
    const first = runtime[0]?.children?.[0];
    if (first && /runtime/.test(runtime[0].description ?? '')) append(first, 'remove or move this import to break the runtime dependency');
  })(polishers.dependencyPath),

  // Import changes since…, more: the net change, tests imported by code, type-only imports, cycles removed.
  graphDiff: ((base: Polish) => (report: Report) => {
    base(report);
    const added = root(report, 'Added imports');
    const removed = root(report, 'Removed imports');
    const count = (g?: ReportNode) => forEachCount(g?.children ?? [], (n) => n.label.startsWith('→ '));
    const plus = count(added);
    const minus = count(removed);
    if ((plus || minus) && report.description && !report.description.includes('net')) report.description += `, net ${plus - minus >= 0 ? '+' : '−'}${Math.abs(plus - minus)} imports`;
    for (const from of added?.children ?? []) {
      for (const e of from.children ?? []) {
        if (/^type /.test(e.description ?? '')) append(e, 'type only: no run-time cost');
        if (!isTestPath(from.label) && /(\.|_)(test|spec)\b|__tests__/.test(e.label)) {
          e.tone = 'warning';
          append(e, 'code imports a test file');
        }
      }
    }
    const resolved = root(report, 'Cycles removed');
    if (resolved) append(resolved, 'good news');
  })(polishers.graphDiff),
});

/** Short definitions for the patterns Pattern spotting finds, and which ones are risks rather than designs. */
const patternNotes: Record<string, { what: string; risk?: boolean }> = {
  Factory: { what: 'functions that build and return objects, so callers don’t use new' },
  Singleton: { what: 'one shared instance for the whole program', risk: true },
  Observer: { what: 'listeners that subscribe and get told when something changes' },
  Strategy: { what: 'interchangeable implementations behind one interface' },
  Repository: { what: 'one place that reads and saves a kind of data' },
  Adapter: { what: 'a wrapper that gives one interface the shape of another' },
  Decorator: { what: 'a wrapper that adds behaviour and keeps the same interface' },
  Builder: { what: 'step-by-step construction of an object, often chained' },
  'Barrel module': { what: 'a file that only re-exports others, for shorter imports' },
  'Shared module state': { what: 'module variables its functions change: every caller shares them', risk: true },
  'Layered architecture': { what: 'folders that depend on each other in one direction' },
};

Object.assign(polishers, {
  // Inspect code, more: severities in the summary, the busiest file, quiet rules folded, a clear "no problems".
  inspectCode: ((base: Polish) => (report: Report) => {
    const rules = report.roots.filter((r) => r.children?.length);
    if (!report.roots.length) {
      report.roots.push({ label: 'No problems found', description: 'every inspection passed in the files checked', icon: 'pass', tone: 'ok' });
      return;
    }
    base(report);
    const tally = { error: 0, warning: 0 };
    const perFile = new Map<string, number>();
    for (const rule of rules) {
      for (const file of rule.children ?? []) {
        perFile.set(file.label, (perFile.get(file.label) ?? 0) + (file.children?.length ?? 0));
        for (const f of file.children ?? []) if (f.tone === 'error' || f.tone === 'warning') tally[f.tone]++;
      }
      if (rule.tone === 'info' || (rule.children ?? []).every((file) => (file.children ?? []).every((f) => f.tone === 'info' || !f.tone))) rule.expanded = false;
    }
    const parts = [tally.error ? plural(tally.error, 'error') : '', tally.warning ? plural(tally.warning, 'warning') : ''].filter(Boolean);
    if (parts.length && report.description && !/\berrors?\b|\bwarnings?\b/.test(report.description)) report.description += `; ${parts.join(', ')}`;
    const busiest = [...perFile].sort((a, b) => b[1] - a[1])[0];
    if (busiest && perFile.size > 1 && report.description) report.description += `; busiest file: ${busiest[0]} (${busiest[1]})`;
  })(polishers.inspectCode),

  // Type assertions: where to start, assertions to the same type, what as any does, unnecessary ones safe to delete, tests.
  assertionAudit(report: Report) {
    const groups = report.roots.filter((g) => g.children?.length && g.label !== 'How to fix');
    const first = groups.find((g) => g.tone === 'error')?.children?.[0] ?? groups.find((g) => g.tone === 'warning')?.children?.[0];
    if (first) report.roots.unshift({ label: `Start with: ${first.label}`, description: `the riskiest${first.location ? `, line ${first.location.line + 1}` : ''}`, icon: 'target', tone: 'info', location: first.location });
    const targets = new Map<string, number>();
    for (const g of groups) {
      for (const row of g.children ?? []) {
        const target = /\bas (?:unknown as )?([A-Z]\w*)/.exec(row.label)?.[1];
        if (target && g.label !== 'Unnecessary' && !/^Widening/.test(g.label)) targets.set(target, (targets.get(target) ?? 0) + 1);
        if (/\bas any\b/.test(row.label)) append(row, 'turns off type checking for everything it touches');
        if (/^Unnecessary/.test(g.label)) append(row, 'safe to delete');
      }
      markTests(g.children);
    }
    for (const [type, count] of targets) if (count > 2) report.warnings.push(`${count} assertions to ${type}: one type guard, function is${type}(value): value is ${type}, would check them all.`);
  },

  // Déjà vu, more: lines that could go, what the extracted function needs, small copies, copies across folders.
  duplicates: ((base: Polish) => (report: Report) => {
    base(report);
    let couldGo = 0;
    const groups = report.roots.filter((g) => /^Duplicate \d+/.test(g.label));
    for (const g of groups) {
      const copies = (g.children ?? []).filter((c) => c.location);
      if (!copies.length) continue;
      const lines = copies[0].location!.endLine - copies[0].location!.line + 1;
      couldGo += lines * (copies.length - 1);
      const differs = (g.children ?? []).find((c) => /^differs in /.test(c.label));
      const params = differs ? differs.label.replace(/^differs in /, '').split(', ').length : 0;
      append(g, params ? `extract a function with ${plural(params, 'parameter')}` : 'identical: extract a function with no parameters');
      if (lines <= 3) append(g, 'small: may not be worth extracting');
      const folders = new Set(copies.map((c) => c.location!.file.replace(/[\\/][^\\/]*$/, '')));
      if (folders.size > 1) append(g, 'across folders');
    }
    groups.sort((a, b) => (parseInt(/(\d+) repeated/.exec(b.label)?.[1] ?? '0') - parseInt(/(\d+) repeated/.exec(a.label)?.[1] ?? '0')));
    const rest = report.roots.filter((r) => !groups.includes(r));
    report.roots = [...groups, ...rest];
    if (couldGo && report.description && !report.description.includes('could go')) report.description += `, about ${plural(couldGo, 'line')} could go`;
  })(polishers.duplicates),

  // Ghost exports, more: whole files unused, local-only exports, types, tests as entry points, where to start.
  deadExports: ((base: Polish) => (report: Report) => {
    base(report);
    for (const file of root(report, /^Unreachable modules/)?.children ?? []) append(file, 'the whole file may be unused');
    forEachReportNode(root(report, /^Exported but only used locally/)?.children ?? [], (n) => { if (!n.children?.length) append(n, 'drop the export keyword'); });
    forEachReportNode(root(report, /^Unused exports/)?.children ?? [], (n) => { if (!n.children?.length && /(^| · )type( · |$)/.test(n.description ?? '')) append(n, 'no run-time cost, but still clutter'); });
    const entries = root(report, /^Entry points/);
    if (entries && /including test files/.test(entries.description ?? '')) append(entries, 'anything a test imports counts as used');
    const busiest = root(report, /^Unused exports/)?.children?.[0];
    if (busiest && (busiest.children?.length ?? 0) >= 3) append(busiest, 'start here');
  })(polishers.deadExports),

  // Pattern spotting: what each pattern is, risks marked, files counted, places in tests, a clear "none".
  patterns(report: Report) {
    if (!report.roots.length) {
      report.roots.push({ label: 'No patterns found', description: 'plain functions and modules: nothing here needs a name', icon: 'info', tone: 'info' });
      return;
    }
    for (const group of report.roots) {
      const note = patternNotes[group.label];
      if (note) {
        group.tooltip = `${group.label}: ${note.what}.${group.tooltip ? `\n${group.tooltip}` : ''}`;
        append(group, note.what);
        if (note.risk) group.tone = group.tone ?? 'warning';
      }
      const files = filesOf(group.children ?? []).size;
      if (files > 1) append(group, `in ${plural(files, 'file')}`);
      markTests(group.children);
    }
  },

  // Shared state changes: how far away a change is made, most written first, many writers, an object's own state.
  mutations(report: Report) {
    forEachReportNode(report.roots, (n) => {
      const via = /^via (.*)$/.exec(n.description ?? '')?.[1];
      if (via) append(n, `${plural(via.split(' → ').length, 'call')} away`);
    });
    const shared = root(report, 'Shared state and who changes it');
    if (shared?.children) {
      const writes = (n: ReportNode) => parseInt(/(\d+) writes?/.exec(n.description ?? '')?.[1] ?? '0');
      shared.children.sort((a, b) => writes(b) - writes(a));
      for (const s of shared.children) {
        const writers = new Set((s.children ?? []).map((c) => c.label.split(':')[0])).size;
        if (writers > 3) append(s, `${writers} functions change it: hard to follow`);
        if (/^this\b/.test(s.label)) {
          s.tone = 'info';
          append(s, 'its own object’s state: expected for a class');
        }
      }
      const variables = shared.children.filter((s) => /module state/.test(s.description ?? '')).length;
      if (variables && report.description && !report.description.includes('shared')) report.description += `, ${plural(variables, 'shared variable')}`;
    }
  },
});

/** How many rows, at any depth, match. */
function forEachCount(nodes: readonly ReportNode[], test: (n: ReportNode) => boolean): number {
  let count = 0;
  forEachReportNode(nodes, (n) => { if (test(n)) count++; });
  return count;
}

/** The first row, at any depth, that matches. */
function forEachFind(nodes: readonly ReportNode[], test: (n: ReportNode) => boolean): ReportNode | undefined {
  let found: ReportNode | undefined;
  forEachReportNode(nodes, (n) => { if (!found && test(n)) found = n; });
  return found;
}

/** Applies the finishing touches for the report's kind; a report polished twice is unchanged. */
export function polishReport(report: Report): Report {
  if (report.polished) return report;
  polishers[report.kind]?.(report);
  report.polished = true;
  return report;
}
