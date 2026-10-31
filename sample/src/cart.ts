import { calculateDiscount, type Coupon } from './discount';

export interface LineItem {
  name: string;
  price: number;
  quantity: number;
}

export function calculateSubtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function calculateTotal(items: LineItem[], coupon?: Coupon): number {
  const subtotal = calculateSubtotal(items);
  return subtotal - calculateDiscount(subtotal, coupon);
}
