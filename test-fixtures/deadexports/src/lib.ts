export const localOnly = 1;

function internal(): number {
  return localOnly;
}

export function used(): number {
  return internal();
}

export function unused(): void {}
