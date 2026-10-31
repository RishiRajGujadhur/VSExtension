import { isEven } from './strings';

/** Registers tests from outside a test file, so the calling test file has no static cases. */
export function defineParitySuite(register: (title: string, fn: () => void) => void): void {
  register('zero is even', () => {
    if (!isEven(0)) throw new Error('expected even');
  });
}
