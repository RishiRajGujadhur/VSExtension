import type { Coupon, LineItem } from './models';

const coupons: Coupon[] = [{ code: 'READ10', percentOff: 10 }];

export function calculateSubtotal(items: LineItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.book.price * item.quantity;
  }
  return Math.round(total * 100) / 100;
}

export function findCoupon(code?: string): Coupon | undefined {
  if (!code) {
    return undefined;
  }
  return coupons.find((c) => c.code === code.toUpperCase());
}

export function applyTax(amount: number, rate = 0.2): number {
  return amount * (1 + rate);
}

export function applyCoupon(amount: number, code?: string): number {
  const coupon = findCoupon(code);
  if (!coupon) {
    return amount;
  }
  return amount * (1 - coupon.percentOff / 100);
}
