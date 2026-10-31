export function Title({ text }: { text: string }) {
  return <h1>{text.toUpperCase()}</h1>;
}

export function Header({ title }: { title: string }) {
  return <Title text={title} />;
}

export function log(message: string): string {
  console.log(message);
  return message;
}

export function format(value: string, suffix: string): string {
  return log(value) + suffix;
}

export function page(name: string): string {
  const label = name.trim();
  return format(label, '!');
}

export function main(): void {
  page('home');
  const user = { name: 'ann' };
  page(user.name);
}

export function render(): unknown {
  return <Header title="Welcome" />;
}
