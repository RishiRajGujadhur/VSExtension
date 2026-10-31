export function scale(value: number, factor: number, offset = 0): number {
  return value * factor + offset;
}

export const greet = (name: string, punctuation?: string) => `Hello ${name}${punctuation ?? ''}`;

export interface Shape {
  area(scale: number): number;
}

export class Square implements Shape {
  constructor(private readonly side: number) {}

  area(scale: number): number {
    return this.side * this.side * scale;
  }
}

export function sum(first: number, ...rest: number[]): number {
  return rest.reduce((total, n) => total + n, first);
}
