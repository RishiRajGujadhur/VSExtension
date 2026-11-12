async function fetchPrice(id: string): Promise<number> {
  return id.length;
}

async function save(item: string): Promise<void> {
  console.log(item);
}

function track(name: string): Promise<void> {
  return Promise.resolve(console.log(name));
}

export function cartTotal(items: { price: number; inStock: boolean }[], coupon?: string): number {
  let total = 0;
  for (const item of items) {
    if (item.inStock) {
      total += item.price;
    }
  }
  if (coupon) {
    total = total * 0.9;
  }
  return total;
}

export function countdown(start: number): number[] {
  const seen: number[] = [];
  let n = start;
  while (n > 0) {
    seen.push(n);
    n--;
  }
  return seen;
}

export async function checkout(ids: string[]): Promise<number> {
  const user = await fetchPrice('user');
  const [a, b] = await Promise.all([fetchPrice('a'), fetchPrice('b')]);
  for (const id of ids) {
    await save(id);
  }
  track('checkout');
  void track('silent');
  const later = fetchPrice('later');
  return user + a + b + (await later);
}

export async function quick(): Promise<number> {
  return fetchPrice('only');
}
