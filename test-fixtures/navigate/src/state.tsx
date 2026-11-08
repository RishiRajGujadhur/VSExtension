declare function useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void];

export function Price({ amount, currency }: { amount: number; currency?: string }) {
  return <span>{amount.toFixed(2)} {currency}</span>;
}

export function Counter() {
  const [count, setCount] = useState(0);
  const reset = () => setCount(0);
  const add = (step: number) => setCount((c) => c + step);
  return <Price amount={count} currency="EUR" />;
}

export function Shop() {
  return <Price amount={9.5} />;
}

export function format(options: { amount: number }) {
  return options.amount.toFixed(2);
}

export function totals(): string {
  const label = format({ amount: 3 });
  return label;
}

function find(id: number): string | undefined {
  return id > 0 ? 'found' : undefined;
}

export function lookup(): void {
  const name = find(1);
  const shown = name;
  console.log(shown);
}

export function area({ width, height = 1 }: { width: number; height?: number }): number {
  return width * height;
}

export const square = area({ width: 2 });

export function Resale(props: { amount: number }) {
  return <Price {...props} />;
}

export const wide = (options: { width: number }) => area({ ...options });
