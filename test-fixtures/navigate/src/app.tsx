import { Box } from './public';
import { formatArea } from './index';
import type { Shape } from './models';

export function Label({ text }: { text: string }) {
  return <span>{text}</span>;
}

export function render(shapes: Shape[]): string[] {
  return shapes.map((s) => formatArea(s, 1));
}

export function App() {
  const box = new Box(2);
  const label = formatArea(box);
  return <Label text={label} />;
}
