import { calculateTotal, type LineItem } from './cart';
import type { Coupon } from './discount';

export interface Receipt {
  total: number;
  itemCount: number;
}

export function checkout(items: LineItem[], coupon?: Coupon): Receipt {
  return {
    total: calculateTotal(items, coupon),
    itemCount: items.reduce((count, item) => count + item.quantity, 0),
  };
}
