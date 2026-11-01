export async function fetchUser(id: string): Promise<string> {
  if (!id) {
    throw new Error('missing id');
  }
  return id;
}

export function loadUser(id: string): Promise<string> {
  return fetchUser(id);
}

export function logLater<T>(value: T): void {
  console.log('value', value);
}

export function relay<T>(value: T): void {
  logLater(value);
}

export async function keep<T>(value: T): Promise<T> {
  return await value;
}

export async function main(): Promise<unknown> {
  loadUser('a');
  void loadUser('b');
  await loadUser('c');
  loadUser('d').catch(() => undefined);
  relay(fetchUser('e'));
  await keep(fetchUser('f'));
  if (fetchUser('g')) {
    console.log('always');
  }
  const text = `user ${fetchUser('h')}`;
  ['x'].forEach(async (x) => {
    await fetchUser(x);
  });
  try {
    return loadUser('i');
  } catch {
    return text;
  }
}

export function sync(): void {
  fetchUser('j');
}

export function listen(target: EventTarget): void {
  setTimeout(async () => {
    await fetchUser('k');
  }, 0);
  target.addEventListener('click', async () => {
    try {
      await fetchUser('l');
    } catch {
      // handled inside the callback
    }
  });
}
