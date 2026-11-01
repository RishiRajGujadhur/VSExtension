import { registry } from './state';

let counter = 0;
const cache = new Map<string, number>();

export function addItem(items: string[], item: string): void {
  items.push(item);
}

export function remember(key: string, value: number): void {
  cache.set(key, value);
  counter++;
}

export function register(name: string): void {
  registry.names.push(name);
}

export function collect(name: string): string[] {
  const local: string[] = [];
  addItem(local, name);
  return local;
}

export function track(list: string[], name: string): void {
  addItem(list, name);
  remember(name, Date.now());
  console.log(name, counter);
}

export function pure(a: number, b: number): number {
  let sum = a;
  sum += b;
  return sum;
}

export class Counter {
  count = 0;
  constructor() {
    this.count = 1;
  }
  increment(): void {
    this.count++;
  }
  incrementTwice(): void {
    this.increment();
    this.increment();
  }
}

export function each(list: string[], visit: (item: string) => void): void {
  for (const item of list) {
    visit(item);
  }
}
