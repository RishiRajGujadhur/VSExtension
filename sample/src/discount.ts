export interface Coupon {
  code: string;
  percent: number;
}

export function calculateDiscount(subtotal: number, coupon?: Coupon): number {
  if (!coupon) {
    return 0;
  }
  return Math.round(subtotal * coupon.percent) / 100;
}
