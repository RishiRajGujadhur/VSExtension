import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCoupon, calculateSubtotal } from '../src/pricing';
import { checkoutTotal } from '../src/cart';

const book = { isbn: '978-0', title: 'Dune', price: 10, weight: 0.4 };

describe('pricing', () => {
  it('adds up the line items', () => {
    assert.equal(calculateSubtotal([{ book, quantity: 3 }]), 30);
  });

  it('takes a coupon off', () => {
    assert.equal(applyCoupon(100, 'read10'), 90);
  });
});

describe('checkout', () => {
  it('includes tax and shipping', () => {
    assert.ok(checkoutTotal([{ book, quantity: 1 }]) > 10);
  });
});
