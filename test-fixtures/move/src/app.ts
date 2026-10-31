import { Square, circleArea, squareArea } from './shapes';
import { perimeter } from './geometry';

export const total = new Square(2).area() + circleArea(1) + squareArea(3) + perimeter(1);
