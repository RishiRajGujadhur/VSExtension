export function formatImpactLabel(count: number): string {
  return count === 1 ? '1 impacted test' : `${count} impacted tests`;
}

export function displayImpactLabel(count: number): string {
  return `Impact: ${formatImpactLabel(count)}`;
}

export function sumTotals(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
