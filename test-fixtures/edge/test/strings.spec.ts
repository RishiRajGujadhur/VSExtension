import { beforeEach, describe as group, expect, test as check } from 'vitest';
import { normalizeName } from '../src';
import { isOdd } from '../src/strings';
import { settings } from '../src/settings';
import { registry } from '../src/registry';

group('strings', () => {
  check.each(['  A ', 'a'])('normalizes %s', (input) => {
    expect(normalizeName(input)).toBe('a');
  });

  check.skip('detects odd numbers', () => {
    expect(isOdd(3)).toBe(true);
  });

  group('settings', () => {
    check('greets by normalized name', () => {
      expect(settings.greet(' Ada ')).toBe('Hello, ada');
    });
  });
});

group('registry', () => {
  let size = 0;
  beforeEach(() => {
    size = registry.size;
  });

  check('has defaults', () => {
    expect(size).toBe(1);
  });
});
