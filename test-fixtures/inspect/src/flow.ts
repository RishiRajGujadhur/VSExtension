export function applyTax(amount: number, rate = 0.2): number {
  return amount * (1 + rate);
}

export function checkout(items: number[], coupon?: string): number {
  let total = 0;
  for (const item of items) {
    total += item;
  }
  if (total > 100) {
    total = total * 0.9;
  }
  items.push(total);
  return applyTax(total);
}

export function run(): number {
  return checkout([1, 2], 'SAVE') + applyTax(5, 0.1);
}
