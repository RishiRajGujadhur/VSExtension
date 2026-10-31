// Jest globals: no import of the test API.
import { Square, totalArea } from '../src/shapes';

declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => { toBe(expected: unknown): void };

describe('shapes', () => {
  test('sums areas', () => {
    expect(totalArea([new Square(2)])).toBe(4);
  });

  test('square area', () => {
    expect(new Square(3).area()).toBe(9);
  });
});
