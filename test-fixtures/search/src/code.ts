export async function load(id: string): Promise<string> {
  return id;
}

export function examples(items: string[], count: number, label: string): void {
  items.forEach((item) => console.log(item));
  items.forEach((item, index) => console.log(item, index));
  console.log('count', count);
  console.log(label);
  if (count > 0) {
    console.log('positive');
    console.log('still positive');
  }
  const same = count === count;
  const other = label === items[0];
  void load(label);
  console.log(same, other);
}
