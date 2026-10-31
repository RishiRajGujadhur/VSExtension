export const RATE = 0.2;

export function price(base: number, qty: number): number {
  const subtotal = base * qty * (1 + 0.2);
  return subtotal + base * qty * (1 + 0.2);
}

export function tax(amount: number): number {
  const local = 3;
  return amount * RATE + local;
}

export class Cart {
  items = 2;

  total(unit: number): number {
    return unit * this.items;
  }
}

export function label(name: string): string {
  return `Item: ${name.toUpperCase()}`;
}
