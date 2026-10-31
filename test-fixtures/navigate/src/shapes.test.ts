import { test } from 'node:test';
import { Circle } from './models';
import { formatArea } from './utils';

test('formats a circle area', () => {
  formatArea(new Circle(1));
});
