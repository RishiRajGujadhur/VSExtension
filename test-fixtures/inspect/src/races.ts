// Shared state changed from async code, for Race Conditions and Mutation Tracking for This Variable.
let total = 0;
let cache: string[] | undefined;
let counter = 0;
const queue: string[] = [];

async function price(id: string): Promise<number> {
  return id.length;
}

async function load(): Promise<string[]> {
  return [];
}

export async function addToTotal(id: string) {
  total += await price(id);
}

export async function addToTotalSafely(id: string) {
  const p = await price(id);
  total += p;
}

export async function getCache() {
  if (!cache) {
    cache = await load();
  }
  return cache;
}

export async function bump() {
  const before = counter;
  await price('x');
  counter = before + 1;
}

export function scheduleBump() {
  setTimeout(() => {
    counter++;
  }, 10);
}

export async function enqueue(item: string) {
  await price(item);
  queue.push(item);
}

export function localOnly() {
  let mine = 0;
  mine++;
  return mine;
}
