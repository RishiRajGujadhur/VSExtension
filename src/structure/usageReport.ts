import * as path from 'path';
import { Report, ReportLocation, ReportNode, plural } from './report';

/**
 * A Find usages report from a list of usages, for languages read without TypeScript (C#, T-SQL): grouped into
 * Definitions, Calls, Writes and Reads, then by file, each row with its code line, where it is and the place at the
 * cursor marked. The same shape as the TypeScript report, so the results view, card and polish apply.
 */

export type UsageKind = 'definition' | 'call' | 'write' | 'read';

export interface Usage {
  kind: UsageKind;
  location: ReportLocation;
  /** The code line, trimmed. */
  line: string;
  /** The routine, method or type it is in. */
  where?: string;
  atCursor?: boolean;
}

const groups: { kind: UsageKind; label: string; icon: string }[] = [
  { kind: 'definition', label: 'Definitions', icon: 'symbol-class' },
  { kind: 'call', label: 'Calls', icon: 'symbol-method' },
  { kind: 'write', label: 'Writes', icon: 'edit' },
  { kind: 'read', label: 'Reads', icon: 'eye' },
];

export const isTestPath = (file: string): boolean => /([\\/](tests?|specs?)[\\/])|(\.Tests?[\\/])|(Tests?\.(cs|sql)$)/i.test(file);

/**
 * @param name What the usages are of, for the title.
 * @param folderOf The folder a file is in, as the report shows it (relative to the workspace).
 * @param fileHashes Content hash of every file a row points into.
 */
export function usageReport(name: string, usages: Usage[], folderOf: (file: string) => string, fileHashes: Record<string, string>): Report {
  const roots: ReportNode[] = [];
  const shorten = (text: string) => (text.length > 90 ? `${text.slice(0, 89)}…` : text);
  for (const group of groups) {
    const list = usages.filter((u) => u.kind === group.kind);
    if (!list.length) continue;
    const byFile = new Map<string, Usage[]>();
    for (const u of list) byFile.set(u.location.file, [...(byFile.get(u.location.file) ?? []), u]);
    const files: ReportNode[] = [...byFile].map(([file, rows]) => {
      rows.sort((a, b) => a.location.line - b.location.line || a.location.character - b.location.character);
      return {
        label: path.basename(file),
        description: [folderOf(file), isTestPath(file) ? 'test' : '', String(rows.length)].filter(Boolean).join(' · '),
        icon: 'file-code',
        expanded: true,
        children: rows.map((u) => ({
          label: shorten(u.line),
          description: `${u.where ? `${u.where} · ` : ''}line ${u.location.line + 1}${u.atCursor ? ' · at cursor' : ''}`,
          icon: group.icon,
          location: u.location,
          role: group.kind === 'definition' ? 'definition' : group.kind === 'write' ? 'write' : 'read',
          focus: u.atCursor || undefined,
        })),
      };
    });
    const inTests = list.filter((u) => isTestPath(u.location.file)).length;
    roots.push({ label: group.label, description: `${list.length}${inTests ? ` (${inTests} in tests)` : ''}`, icon: group.icon, expanded: true, children: files });
  }
  const fileCount = new Set(usages.map((u) => u.location.file)).size;
  const tests = usages.filter((u) => isTestPath(u.location.file)).length;
  const parts = groups
    .map((g) => ({ g, count: usages.filter((u) => u.kind === g.kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ g, count }) => `${count} ${count === 1 ? g.label.toLowerCase().replace(/s$/, '') : g.label.toLowerCase()}`);
  return {
    kind: 'usages',
    title: `Usages of ${name}`,
    description: `${plural(usages.length, 'usage')} in ${plural(fileCount, 'file')}: ${parts.join(', ')}${tests ? `; ${tests} in tests` : ''}`,
    roots,
    warnings: [],
    fileHashes,
  };
}
