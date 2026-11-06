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

test('Dead exports: Storybook stories are entry points', () => {
  assert.equal(isConventionalEntry('/repo/src/Button.stories.tsx'), 'Storybook story');
});

test('Dead exports: tool config files are entry points', () => {
  assert.equal(isConventionalEntry('/repo/vite.config.ts'), 'tool config file');
  assert.equal(isConventionalEntry('/repo/tailwind.config.mjs'), 'tool config file');
  assert.equal(isConventionalEntry('/repo/src/config.ts'), undefined);
});

test('Dead exports: Remix and React Router routes are entry points', () => {
  assert.equal(isConventionalEntry('/repo/app/routes/_index.tsx'), 'route module');
  assert.equal(isConventionalEntry('/repo/app/root.tsx'), 'route module');
});

test('Dead exports: SvelteKit, Nuxt and Astro conventions are entry points', () => {
  assert.equal(isConventionalEntry('/repo/src/routes/+page.server.ts'), 'framework route');
  assert.equal(isConventionalEntry('/repo/server/api/users.get.ts'), 'framework route');
});

test('Dead exports: test setup files are entry points', () => {
  assert.equal(isConventionalEntry('/repo/src/setupTests.ts'), 'test setup file');
  assert.equal(isConventionalEntry('/repo/vitest.setup.ts'), 'test setup file');
});

test('Dead exports: workers and scripts are entry points', () => {
  assert.equal(isConventionalEntry('/repo/src/image.worker.ts'), 'worker or script');
  assert.equal(isConventionalEntry('/repo/scripts/release.ts'), 'worker or script');
});
