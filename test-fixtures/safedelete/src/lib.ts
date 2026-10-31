export const first = 1, second = 2;

/**
 * Nobody calls this.
 */
export function unused(): string {
  return 'unused';
}

export function usedOnce(): number {
  return first;
}

export function countdown(n: number): number {
  return n > 0 ? countdown(n - 1) : 0;
}

export interface Options {
  verbose: boolean;
}

export class Box {
  // Not called anywhere.
  unusedMethod(): void {}

  usedMethod(): number {
    return 1;
  }
}

export function format(value: string, unusedFlag: boolean, prefix: string): string {
  return prefix + value;
}
