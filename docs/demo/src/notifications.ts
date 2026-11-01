import { track } from './analytics';
import { formatMessage } from './format';

export async function sendEmail(to: string, body: string): Promise<void> {
  console.log(`email to ${to}: ${body}`);
}

export function notifyCustomer(orderId: string, message: string): void {
  sendEmail(`${orderId}@example.com`, formatMessage(message));
  track('notified', orderId);
}
