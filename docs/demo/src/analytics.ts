const events: { name: string; detail: string }[] = [];

export function track(name: string, detail: string): void {
  events.push({ name, detail });
  console.log(`[analytics] ${name}: ${detail}`);
}

export function eventCount(): number {
  return events.length;
}
