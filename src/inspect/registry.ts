import { Inspection } from './inspection';
import { missingAwait } from './missingAwait';
import { typeAssertions } from './typeAssertions';
import { qualityInspections } from './quality';

/** Inspections that run live on open files and report to the Problems panel. */
export const builtInInspections: readonly Inspection[] = [missingAwait, typeAssertions, ...qualityInspections];
