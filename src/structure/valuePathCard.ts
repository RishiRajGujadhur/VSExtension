import { Report, ReportLocation, plural, titleParts } from './report';

/**
 * The Value Path card in the sidebar: the latest "Why this value" result as a short timeline of the values the
 * variable can have, each with how many ways lead to it and what has to be true, ending in a step to go on.
 */
export interface ValuePathCard {
  subject: string;
  summary: string;
  timing?: string;
  /** A condition every value needs, from the polished report. */
  needs?: string;
  values: { title: string; ways: string; when: string; always: boolean; icon: string; location?: ReportLocation }[];
  impossible?: string;
  warnings: string[];
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The card for a Value Path report, or undefined for any other report. */
export function valuePathCard(report: Report): ValuePathCard | undefined {
  if (report.kind !== 'explainValue') return undefined;
  const subject = titleParts(report).subject || report.title.replace(/^Value path of /, '');
  const timing = report.durationMs === undefined ? undefined : report.durationMs < 1000 ? `${report.durationMs} ms` : `${(report.durationMs / 1000).toFixed(1)} s`;
  const values = report.roots
    .filter((r) => /^= /.test(r.label) || r.icon === 'symbol-variable')
    .map((r) => {
      const ways = r.children ?? [];
      const first = ways[0];
      const always = !first || first.label === 'always' || !first.children?.length && /no branch|no condition/.test(`${first.description ?? ''} ${r.description ?? ''}`);
      const when = always ? 'Always — no branch decides it' : `When ${first.label}${ways.length > 1 ? `, or ${plural(ways.length - 1, 'other way')}` : ''}`;
      const title = /^= /.test(r.label) ? r.label.slice(2) : capital(r.label);
      return { title, ways: plural(ways.length || 1, 'way'), when, always, icon: /^= /.test(r.label) ? 'symbol-constant' : 'symbol-variable', location: r.location ?? first?.location };
    });
  const needs = report.roots.find((r) => /^Every value needs /.test(r.label))?.label;
  const impossible = report.roots.find((r) => r.label === 'Impossible paths')?.description;
  return {
    subject,
    summary: `${report.description ?? ''}${timing && !report.description?.includes(timing) ? ` (${timing})` : ''}`.trim(),
    timing,
    needs,
    values,
    impossible,
    warnings: report.warnings,
  };
}
