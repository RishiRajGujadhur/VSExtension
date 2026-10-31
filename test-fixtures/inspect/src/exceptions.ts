export class ConfigError extends Error {}

export function parseConfig(text: string): Record<string, unknown> {
  if (!text) {
    throw new ConfigError('empty config');
  }
  return JSON.parse(text);
}

export function loadConfig(text: string): Record<string, unknown> {
  try {
    return parseConfig(text);
  } catch (error) {
    throw new ConfigError(`invalid: ${String(error)}`);
  }
}

export function readSetting(text: string, key: string): unknown {
  const config = parseConfig(text);
  return config[key];
}

export function quietly(text: string): unknown {
  try {
    return readSetting(text, 'a');
  } catch {
    // ignored
  }
  return undefined;
}

export function main(text: string): void {
  console.log(readSetting(text, 'b'));
}
