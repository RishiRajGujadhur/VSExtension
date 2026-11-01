import type { LineItem, PaymentMethod, Receipt } from './models';
import { checkoutTotal } from './cart';
import { notifyCustomer } from './notifications';

export class OrderError extends Error {}

async function persist(order: { id: string; total: number }): Promise<void> {
  console.log('saved', order.id);
}

export async function saveOrder(id: string, total: number): Promise<void> {
  if (total <= 0) {
    throw new OrderError('Order total must be positive');
  }
  await persist({ id, total });
}

export async function placeOrder(id: string, items: LineItem[], payment: PaymentMethod, coupon?: string): Promise<Receipt> {
  const total = checkoutTotal(items, coupon);
  const receipt = await payment.charge(total);
  await saveOrder(id, total);
  notifyCustomer(id, `Thanks! You paid ${total}`);
  return receipt;
}

export async function submitSafely(id: string, items: LineItem[], payment: PaymentMethod): Promise<Receipt | undefined> {
  try {
    return await placeOrder(id, items, payment);
  } catch (error) {
    console.error('order failed', error);
    return undefined;
  }
}

export function quickReorder(id: string, items: LineItem[], payment: PaymentMethod): void {
  placeOrder(id, items, payment);
}

export function onCheckoutClick(id: string, items: LineItem[], payment: PaymentMethod): void {
  setTimeout(() => submitSafely(id, items, payment), 0);
}
