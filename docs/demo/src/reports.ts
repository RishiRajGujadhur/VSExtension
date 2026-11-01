import type { LineItem } from './models';

// Copied from pricing.ts when the sales report was added.
export function revenue(lines: LineItem[]): number {
  let sum = 0;
  for (const line of lines) {
    sum += line.book.price * line.quantity;
  }
  return Math.round(sum * 100) / 100;
}

export function averageOrder(orders: LineItem[][]): number {
  return orders.length ? revenue(orders.flat()) / orders.length : 0;
}
