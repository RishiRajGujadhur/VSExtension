export function formatPrice(amount: number, currency = 'EUR'): string {
  return `${amount.toFixed(2)} ${currency}`;
}

export function formatMessage(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function formatTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}
