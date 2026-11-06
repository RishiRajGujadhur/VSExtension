import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConventionalEntry } from '../inspect/deadExports';

test('Dead exports: Next.js pages are entry points', () => {
  assert.equal(isConventionalEntry('/repo/pages/index.tsx'), 'Next.js page');
  assert.equal(isConventionalEntry('/repo/src/pages/api/users.ts'), 'Next.js page');
  assert.equal(isConventionalEntry('/repo/src/pages/components/Card.tsx'), undefined);
  assert.equal(isConventionalEntry('/repo/src/cart.ts'), undefined);
});
