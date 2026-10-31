export interface Shape {
  kind: string;
}

export interface Circle extends Shape {
  radius: number;
}

export function examples(shape: Shape, value: string | number, raw: unknown, maybe: string | undefined, json: string): void {
  const a = shape as Circle;
  const b = value as string;
  const c = json as string;
  const d = raw as unknown as Circle;
  const e = shape as any;
  const f = JSON.parse(json) as Circle;
  const g = { kind: 'circle', radius: 1 } as Shape;
  const h = maybe!.length;
  const i = json!.length;
  const j = [1, 2] as const;
  console.log(a, b, c, d, e, f, g, h, i, j);
}
