export class ConfigError extends Error {}

export function parseConfig(text: string): Record<string, unknown> {
  if (!text.trim()) {
    throw new ConfigError('Config file is empty');
  }
  return JSON.parse(text);
}

export function loadConfig(text: string): Record<string, unknown> {
  try {
    return parseConfig(text);
  } catch (error) {
    throw new ConfigError(`Invalid config: ${String(error)}`);
  }
}

export function readSetting(text: string, key: string): unknown {
  const config = parseConfig(text);
  return config[key];
}

export function currencyOrDefault(text: string): unknown {
  try {
    return readSetting(text, 'currency');
  } catch {
    // fall back to the default
  }
  return 'EUR';
}
