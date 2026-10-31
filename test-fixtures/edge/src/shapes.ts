export interface Shape {
  area(): number;
}

export class Square implements Shape {
  constructor(private readonly side: number) {}

  area(): number {
    return this.side * this.side;
  }
}

export class Circle implements Shape {
  constructor(private readonly radius: number) {}

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}

export function totalArea(shapes: Shape[]): number {
  return shapes.reduce((sum, shape) => sum + shape.area(), 0);
}
