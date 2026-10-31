export const registry = new Map<string, string>();

export function registerDefaults(): void {
  registry.set('default', 'on');
}

registerDefaults();
