/**
 * Options a graph can be redrawn with, such as how many levels deep it goes or which direction it follows. A report
 * lists the controls it supports (`Report.controls`); the chart and the results view show them, and changing one
 * stores the value here and runs the analysis again, which reads it back.
 */
export interface ReportControl {
  /** Stored as `<report kind>.<id>`. */
  id: string;
  label: string;
  /** What changing it does, for its tooltip. */
  description: string;
  kind: 'levels' | 'choice';
  value: number | string;
  min?: number;
  max?: number;
  choices?: { id: string; label: string }[];
}

const values = new Map<string, number | string>();

/** The value chosen for a graph's option, or the fallback (usually the setting) when none was chosen. */
export function graphOption<T extends number | string>(kind: string, id: string, fallback: T): T {
  const value = values.get(`${kind}.${id}`);
  return (value === undefined || typeof value !== typeof fallback ? fallback : value) as T;
}

/** Stores a chosen value, kept within the control's bounds; false when the value isn't valid for it. */
export function setGraphOption(kind: string, control: ReportControl, value: unknown): boolean {
  if (control.kind === 'levels') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    values.set(`${kind}.${control.id}`, Math.max(control.min ?? 1, Math.min(control.max ?? 9, Math.round(value))));
    return true;
  }
  if (typeof value !== 'string' || !control.choices?.some((c) => c.id === value)) return false;
  values.set(`${kind}.${control.id}`, value);
  return true;
}

/** For tests: forget every chosen value. */
export function resetGraphOptions(): void {
  values.clear();
}
