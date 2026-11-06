import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConventionalEntry } from '../inspect/deadExports';

test('Dead exports: Next.js pages are entry points', () => {
  assert.equal(isConventionalEntry('/repo/pages/index.tsx'), 'Next.js page');
  assert.equal(isConventionalEntry('/repo/src/pages/api/users.ts'), 'Next.js page');
  assert.equal(isConventionalEntry('/repo/src/pages/components/Card.tsx'), undefined);
  assert.equal(isConventionalEntry('/repo/src/cart.ts'), undefined);
});

test('Dead exports: Next.js app router files and middleware are entry points', () => {
  assert.equal(isConventionalEntry('/repo/app/dashboard/page.tsx'), 'Next.js app route');
  assert.equal(isConventionalEntry('/repo/src/middleware.ts'), 'Next.js app route');
  assert.equal(isConventionalEntry('/repo/app/dashboard/chart.tsx'), undefined);
});
