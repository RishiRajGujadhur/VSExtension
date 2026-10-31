import { Shape, Square, greet, scale, sum } from './math';

export const a = scale(2, 3);
export const b = scale(scale(1, 2), 4, 5);
export const c = greet('Ada');
export const d = new Square(2).area(3);
export const e = sum(1, 2, 3);
export const f = [1, 2].map((x) => scale(x, 2));

export function areas(shapes: Shape[]): number[] {
  return shapes.map((shape) => shape.area(2));
}

export const multiline = scale(
  10,
  20,
);
