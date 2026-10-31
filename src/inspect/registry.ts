import { Inspection } from './inspection';
import { missingAwait } from './missingAwait';

/** Inspections that run live on open files and report to the Problems panel. */
export const builtInInspections: readonly Inspection[] = [missingAwait];
