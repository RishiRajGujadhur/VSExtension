export type Role = 'admin' | 'member' | 'guest';

export function getPermission(user: { active: boolean; role: Role }, sensitive: boolean) {
  if (!user.active) {
    return 'blocked';
  }

  let permission = 'read';

  switch (user.role) {
    case 'admin':
      permission = 'write';
      break;

    case 'member':
      if (sensitive) {
        permission = 'limited';
      }
      break;

    default:
      permission = 'none';
  }

  return permission;
}

export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    if (item < 0) {
      continue;
    }
    sum += item;
  }
  return sum;
}

export function grade(score: number): string {
  let letter = 'F';
  switch (true) {
    case score >= 90:
    case score >= 80:
      letter = 'A or B';
    case score >= 50:
      letter += '!';
      break;
  }
  return letter;
}

export function find(rows: string[][], wanted: string): number {
  let found = -1;
  outer: for (let i = 0; i < rows.length; i++) {
    for (const cell of rows[i]) {
      if (cell === wanted) {
        found = i;
        break outer;
      }
    }
  }
  return found;
}

export function parse(text: string): number {
  let value = 0;
  try {
    value = JSON.parse(text);
    if (typeof value !== 'number') {
      throw new Error('not a number');
    }
  } catch (error) {
    value = -1;
  } finally {
    console.log('parsed');
  }
  return value;
}

export function dead(flag: boolean): string {
  return flag ? 'yes' : 'no';
  console.log('never');
}

export const double = (n: number) => n * 2;

export function retry(): number {
  let attempts = 0;
  do {
    attempts++;
  } while (attempts < 3);
  return attempts;
}

export function twice(flag: boolean): string {
  let label = 'none';
  if (flag) {
    label = 'first';
  }
  if (flag) {
    label += ' again';
  }
  return label;
}
