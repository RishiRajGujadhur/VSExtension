import * as path from 'path';
import { Report, ReportNode } from './report';

/** Rows whose label or description contains the text, with their ancestors; all rows when the filter is empty. */
export function filterReport(nodes: readonly ReportNode[], filter: string): ReportNode[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) {
    return [...nodes];
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
