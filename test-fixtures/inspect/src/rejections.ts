async function write(data: string): Promise<void> {
  console.log(data);
}

export async function save(data: string): Promise<void> {
  if (!data) {
    throw new Error('empty');
  }
  await write(data);
}

export async function safeSave(data: string): Promise<void> {
  try {
    await save(data);
  } catch (error) {
    console.error(error);
  }
}

export async function strictSave(data: string): Promise<void> {
  try {
    await save(data);
  } catch (error) {
    throw new Error('save failed', { cause: error });
  }
}

export function fireAndForget(data: string): void {
  save(data);
}

export function chained(data: string): Promise<number> {
  return save(data)
    .then(() => 1)
    .catch(() => 0);
}

export async function relaySave(data: string): Promise<void> {
  await save(data);
}

export function onClick(): void {
  setTimeout(() => relaySave('clicked'), 0);
}

export async function saveAll(items: string[]): Promise<void> {
  await Promise.allSettled([save(items[0])]);
}
