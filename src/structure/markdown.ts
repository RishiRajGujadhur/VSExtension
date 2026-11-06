import * as path from 'path';
import { Report, ReportNode } from './report';

/** Rows whose label or description contains the text, with their ancestors; all rows when the filter is empty. */
export function filterReport(nodes: readonly ReportNode[], filter: string): ReportNode[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) {
    return [...nodes];
  }
  // `-test` drops rows whose text or file contains "test".
  if (needle.startsWith('-') && needle.length > 1) {
    const unwanted = needle.slice(1);
    const drop = (node: ReportNode) => `${node.label} ${node.description ?? ''} ${node.location?.file ?? ''}`.toLowerCase().includes(unwanted);
    const keep = (list: readonly ReportNode[]): ReportNode[] => list.filter((n) => !drop(n)).map((n) => (n.children ? { ...n, children: keep(n.children) } : n));
    return keep(nodes);
  }
  // `is:warning` keeps rows of that tone: error, warning, info or ok.
  const tone = /^is:(error|warning|info|ok)$/.exec(needle)?.[1];
  if (tone) {
    return filterBy(nodes, (node) => node.tone === tone);
  }
  // `file:cart` keeps rows whose file path contains "cart", whatever their text.
  const byFile = needle.startsWith('file:') ? needle.slice('file:'.length).trim().replace(/\\/g, '/') : undefined;
  const result: ReportNode[] = [];
  for (const node of nodes) {
    const own = byFile !== undefined ? !!node.location && node.location.file.toLowerCase().replace(/\\/g, '/').includes(byFile) : `${node.label} ${node.description ?? ''}`.toLowerCase().includes(needle);
    const children = own ? (node.children ?? []) : filterReport(node.children ?? [], filter);
    if (own || children.length > 0) {
      result.push({ ...node, children: children.length ? children : undefined, expanded: true });
    }
  }
  return result;
}

/** The report as a Markdown outline, with each row's location relative to `root`. */
export function reportMarkdown(report: Report, root?: string, nodes: readonly ReportNode[] = report.roots): string {
  const lines = [`## ${report.title}`, ''];
  if (report.description) {
    lines.push(`_${report.description}_`, '');
  }
  for (const warning of report.warnings) {
    lines.push(`> ${warning}`, '');
  }
  const icon = (node: ReportNode) => (node.tone === 'error' ? '❌ ' : node.tone === 'warning' ? '⚠️ ' : node.tone === 'ok' ? '✅ ' : '');
  const visit = (node: ReportNode, depth: number) => {
    const where = node.location ? ` — \`${root ? path.relative(root, node.location.file).replace(/\\/g, '/') : path.basename(node.location.file)}:${node.location.line + 1}\`` : '';
    const description = node.description ? ` (${node.description})` : '';
    lines.push(`${'  '.repeat(depth)}- ${icon(node)}${escape(node.label)}${escape(description)}${where}`);
    node.children?.forEach((child) => visit(child, depth + 1));
  };
  nodes.forEach((node) => visit(node, 0));
  return lines.join('\n') + '\n';
}

function escape(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

/** The rows the test accepts, with the groups that lead to them, expanded. */
function filterBy(nodes: readonly ReportNode[], accept: (node: ReportNode) => boolean): ReportNode[] {
  const result: ReportNode[] = [];
  for (const node of nodes) {
    const children = accept(node) ? (node.children ?? []) : filterBy(node.children ?? [], accept);
    if (accept(node) || children.length > 0) {
      result.push({ ...node, children: children.length ? children : undefined, expanded: true });
    }
  }
  return result;
}

/** The report's rows as CSV: group, row, details, file and line, for a spreadsheet. */
export function reportCsv(nodes: readonly ReportNode[], root?: string): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = ['Group,Row,Details,File,Line'];
  const visit = (list: readonly ReportNode[], group: string) => {
    for (const node of list) {
      if (node.location) {
        const file = root ? path.relative(root, node.location.file).replace(/\\/g, '/') : node.location.file;
        lines.push([group, node.label, node.description ?? '', file, String(node.location.line + 1)].map(cell).join(','));
      }
      visit(node.children ?? [], group || node.label);
    }
  };
  visit(nodes, '');
  return lines.join('\n');
}
