import type { Shape } from './models';

export let counter = 0;

export function bump(): number {
  counter += 1;
  return counter;
}

export function formatArea(shape: Shape, digits = 2): string {
  return shape.area().toFixed(digits);
}
