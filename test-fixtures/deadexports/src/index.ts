import * as ns from './ns';
import { helper } from './util';

export { used } from './lib';
export * from './star';

export const api = helper();
export const fromNamespace = ns.viaNamespace();
