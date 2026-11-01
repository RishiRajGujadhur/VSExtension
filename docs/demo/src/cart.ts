import type { Book, LineItem } from './models';
import { applyCoupon, applyTax, calculateSubtotal } from './pricing';
import { shippingCost } from './shipping';
import { track } from './analytics';

const carts = new Map<string, LineItem[]>();
let lastUpdated = 0;

export function cartFor(userId: string): LineItem[] {
  let items = carts.get(userId);
  if (!items) {
    items = [];
    carts.set(userId, items);
  }
  return items;
}

export function addToCart(items: LineItem[], book: Book, quantity = 1): void {
  const existing = items.find((item) => item.book.isbn === book.isbn);
  if (existing) {
    existing.quantity += quantity;
  } else {
    items.push({ book, quantity });
  }
  lastUpdated = Date.now();
  track('add-to-cart', book.isbn);
}

export function clearCart(userId: string): void {
  carts.delete(userId);
  lastUpdated = Date.now();
}

export function checkoutTotal(items: LineItem[], couponCode?: string): number {
  let total = calculateSubtotal(items);
  if (items.length > 5) {
    total = total * 0.95;
  }
  total = applyCoupon(total, couponCode);
  const shipping = shippingCost(items);
  return applyTax(total + shipping);
}

export function cartSummary(userId: string): string {
  const items = cartFor(userId);
  return `${items.length} books, total ${checkoutTotal(items)} (updated ${lastUpdated})`;
}
