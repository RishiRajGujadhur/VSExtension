import { describe, expect, it } from 'vitest';
import { checkout } from '../src/checkout';

const items = [{ name: 'book', price: 20, quantity: 2 }];

describe('checkout', () => {
  it('calculates total', () => {
    expect(checkout(items).total).toBe(40);
  });

  it('handles coupons', () => {
    expect(checkout(items, { code: 'HALF', percent: 50 }).total).toBe(20);
  });

  it('counts items', () => {
    expect(checkout(items).itemCount).toBe(2);
  });
});
