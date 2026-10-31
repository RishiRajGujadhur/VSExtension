import { Box, type Options, format, unused, usedOnce } from './lib';
import { helperValue } from './helper';

export const total = usedOnce() + new Box().usedMethod() + helperValue;
export const options: Options = { verbose: true };
export const label = format('x', true, '> ');
