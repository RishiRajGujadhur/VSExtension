import { Finding, Inspection, Severity } from '../inspect/inspection';
import { CompiledPattern, Matcher, PlaceholderConstraint, compilePattern, instantiate, outermost } from './structuralSearch';

/** A saved structural search that runs as a live inspection. Stored in `tsStructure.customInspections`. */
export interface CustomInspectionConfig {
  id: string;
  pattern: string;
  constraints?: PlaceholderConstraint[];
  /** Shown on each match; `$name$` placeholders are filled in from the match. */
  message: string;
  severity?: Severity;
  /** Optional quick fix template. */
  replacement?: string;
  enabled?: boolean;
  /** Regular expression tested against the file path; only matching files are inspected. */
  files?: string;
}

/** Builds inspections from saved configurations, reporting the ones that cannot be compiled. */
export function customInspections(configs: readonly CustomInspectionConfig[]): { inspections: Inspection[]; errors: string[] } {
  const inspections: Inspection[] = [];
  const errors: string[] = [];
  for (const config of configs) {
    if (config.enabled === false || !config.id || !config.pattern) {
      continue;
    }
    let compiled: CompiledPattern;
    let files: RegExp | undefined;
    try {
      compiled = compilePattern({ pattern: config.pattern, constraints: config.constraints });
      files = config.files ? new RegExp(config.files) : undefined;
    } catch (error) {
      errors.push(`Custom inspection '${config.id}': ${(error as Error).message}`);
      continue;
    }
    const id = `custom:${config.id}`;
    inspections.push({
      id,
      title: config.id,
      defaultSeverity: config.severity ?? 'warning',
      run(context) {
        if (files && !files.test(context.sourceFile.fileName.replace(/\\/g, '/'))) {
          return [];
        }
        const matches = outermost(new Matcher(compiled, context.checker).search(context.sourceFile));
        const allFixes = config.replacement
          ? safeEdits(() => matches.map((m) => ({ start: m.start, end: m.end, text: instantiate(config.replacement!, m) })))
          : undefined;
        return matches.map((match): Finding => {
          const message = config.message.replace(/\$([A-Za-z_]\w*)\*?\$/g, (whole, name: string) => {
            const nodes = match.bindings.get(name);
            return nodes ? nodes.map((n) => n.getText()).join(', ') : whole;
          });
          const fixes: Finding['fixes'] = [];
          const single = config.replacement ? safeEdits(() => [{ start: match.start, end: match.end, text: instantiate(config.replacement!, match) }]) : undefined;
          if (single) {
            fixes.push({ title: `Replace with ${single[0].text.replace(/\s+/g, ' ').slice(0, 50)}`, preferred: true, edits: single });
          }
          if (allFixes && matches.length > 1) {
            fixes.push({ title: `Fix all ${matches.length} '${config.id}' problems in this file`, edits: allFixes });
          }
          return { inspection: id, message, start: match.start, end: match.end, severity: config.severity ?? 'warning', fixes };
        });
      },
    });
  }
  return { inspections, errors };
}

function safeEdits<T>(compute: () => T): T | undefined {
  try {
    return compute();
  } catch {
    // A template naming an unknown placeholder offers no fix.
    return undefined;
  }
}

/** A stable id from the message, such as `prefer-for-of` from "Prefer for…of". */
export function inspectionId(message: string, existing: readonly string[]): string {
  const base =
    message
      .toLowerCase()
      .replace(/\$[^$]*\$/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'custom-inspection';
  let id = base;
  for (let i = 2; existing.includes(id); i++) {
    id = `${base}-${i}`;
  }
  return id;
}
