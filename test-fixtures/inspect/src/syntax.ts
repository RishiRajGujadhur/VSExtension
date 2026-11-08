export function chain(start: number): number {
  let m = start;
  [m] = [m + 1];
  ({ m } = { m });
  return m;
}

export interface Order {
  id: string;
}

export function title(order: Order): string {
  const label = `#${order.id}`;
  return label;
}

export const hasImport = (source: string): boolean => /import\(/.test(source);

export function kindOf(value: object): string {
  const constructor = value.constructor;
  return constructor.name;
}

export const nothing = undefined;
