export function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function isEven(n: number): boolean {
  return n === 0 ? true : isOdd(n - 1);
}

export function isOdd(n: number): boolean {
  return n === 0 ? false : isEven(n - 1);
}

export function unusedHelper(): string {
  return 'nobody calls me';
}
