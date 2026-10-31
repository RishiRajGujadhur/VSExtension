export interface User {
  name: string;
  nickname?: string;
}

export function findUser(users: User[], name: string): User | undefined {
  return users.find((u) => u.name === name);
}

export function lookup(id?: string): string | null {
  if (!id) {
    return null;
  }
  return id.trim();
}

let current: User | undefined;

export function login(user: User): void {
  current = user;
}

export function logout(): void {
  current = undefined;
}

export function greet(users: User[]): string {
  const user = findUser(users, 'ann');
  const label = lookup();
  if (!user) {
    return 'nobody';
  }
  return `${user.name} ${label} ${user.nickname} ${current?.name}`;
}

export function show(name?: string): string {
  return name ?? 'anon';
}

export function caller(): void {
  show();
  show(undefined);
  show('x');
}
