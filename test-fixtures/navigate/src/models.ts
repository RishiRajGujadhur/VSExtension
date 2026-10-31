export interface Shape {
  name: string;
  area(): number;
}

export abstract class Base implements Shape {
  name = 'base';
  abstract area(): number;
  describe(): string {
    return `${this.name}: ${this.area()}`;
  }
}

export class Square extends Base {
  constructor(private side: number) {
    super();
  }
  area(): number {
    return this.side ** 2;
  }
}

export class Circle extends Base {
  constructor(private radius: number) {
    super();
  }
  area(): number {
    return Math.PI * this.radius ** 2;
  }
  describe(): string {
    return `circle ${super.describe()}`;
  }
}

export class Tiny extends Square {
  area(): number {
    return super.area() / 10;
  }
}
