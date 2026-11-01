import type { Book, LineItem } from './models';

export interface BookResponse {
  isbn: string;
}

export function parseBook(body: string): Book {
  return JSON.parse(body) as Book;
}

export function firstItem(items: LineItem[]): LineItem {
  const found = items.find((item) => item.quantity > 0);
  return found!;
}

export function bookFromResponse(response: BookResponse): Book {
  return response as Book;
}

export function legacyPayload(data: unknown): string {
  return (data as any).payload;
}

export function isbnOf(book: Book): string {
  return (book as Book).isbn;
}
