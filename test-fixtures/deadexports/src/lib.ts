export const localOnly = 1;

function internal(): number {
  return localOnly;
}

export function used(): number {
  return internal();
}

export function unused(): void {}

/** Part of the public API even though nothing here uses it. @public */
export function kept(): void {}
