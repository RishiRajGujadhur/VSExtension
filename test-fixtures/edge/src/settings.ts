import { normalizeName } from './index';

export const settings = {
  greet: (name: string) => `Hello, ${normalizeName(name)}`,
  version: 2,
};
