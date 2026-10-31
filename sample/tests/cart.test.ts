import { describe, expect, it } from 'vitest';
import { calculateSubtotal, calculateTotal } from '../src/cart';

const items = [
  { name: 'pen', price: 2, quantity: 5 },
  { name: 'pad', price: 10, quantity: 1 },
];

describe('cart', () => {
  it('adds up line items', () => {
    expect(calculateSubtotal(items)).toBe(20);
  });

  it('applies discounts', () => {
    expect(calculateTotal(items, { code: 'TEN', percent: 10 })).toBe(18);
  });
});
