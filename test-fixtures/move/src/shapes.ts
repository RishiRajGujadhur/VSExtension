const TAU = Math.PI * 2;

export interface Shape {
  area(): number;
}

export function circleArea(radius: number): number {
  return (TAU / 2) * radius * radius;
}

export function squareArea(side: number): number {
  return side * side;
}

export class Square implements Shape {
  constructor(private readonly side: number) {}

  area(): number {
    return squareArea(this.side);
  }
}

export const UNIT = 1, ZERO = 0;
