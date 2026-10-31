import { scale } from './math';

// Stored as a value: callers of `transform` are not rewritten.
export const transform: (value: number, factor: number) => number = scale;
