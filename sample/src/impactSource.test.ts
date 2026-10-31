import { describe, expect, it } from 'vitest';
import { displayImpactLabel, formatImpactLabel, sumTotals } from './impactSource';

describe('impact labels', () => {
  it('formats a single impacted test', () => {
    expect(formatImpactLabel(1)).toBe('1 impacted test');
  });

  it('prefixes the display label', () => {
    expect(displayImpactLabel(3)).toBe('Impact: 3 impacted tests');
  });
});

it('sums totals', () => {
  expect(sumTotals([1, 2, 3])).toBe(6);
});
