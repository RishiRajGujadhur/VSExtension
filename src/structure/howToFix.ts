import { ReportNode } from './report';

/** A collapsed group of concrete advice, added at the end of a report that found problems. */
export function howToFix(tips: readonly string[]): ReportNode {
  return {
    label: 'How to fix',
    description: tips.length === 1 ? '1 tip' : `${tips.length} tips`,
    icon: 'lightbulb',
    children: tips.map((tip) => ({ label: tip, tooltip: tip, icon: 'arrow-small-right' })),
  };
}
