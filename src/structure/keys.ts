/** A keybinding as the extension contributes it. */
export interface Keybinding {
  command: string;
  key: string;
  mac?: string;
}

/** The extension's default shortcut for each command, written as VS Code shows them, such as `Ctrl+F6`. */
export function shortcuts(keybindings: readonly Keybinding[], platform = process.platform): Map<string, string> {
  const shown = new Map<string, string>();
  for (const binding of keybindings) {
    const key = platform === 'darwin' ? (binding.mac ?? binding.key) : binding.key;
    if (!shown.has(binding.command)) {
      shown.set(
        binding.command,
        key
          .split(' ')
          .map((chord) => chord.split('+').map((part) => (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))).join('+'))
          .join(' '),
      );
    }
  }
  return shown;
}

/** A keybinding as written in the user's keybindings.json; a command starting with `-` removes a default one. */
export interface UserKeybinding {
  command?: unknown;
  key?: unknown;
}

/**
 * The shortcuts in effect: the extension's defaults, less the ones the user removed (`-command`), plus the user's
 * own, which come first so they are the ones shown. Entries that aren't well formed are ignored.
 */
export function effectiveKeybindings(defaults: readonly Keybinding[], user: readonly UserKeybinding[], platform = process.platform): Keybinding[] {
  const mine: Keybinding[] = [];
  const removed: { command: string; key?: string }[] = [];
  const norm = (key: string) => key.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const entry of user) {
    if (!entry || typeof entry.command !== 'string') continue;
    const key = typeof entry.key === 'string' ? entry.key : undefined;
    if (entry.command.startsWith('-')) removed.push({ command: entry.command.slice(1), key: key && norm(key) });
    else if (key) mine.push({ command: entry.command, key, mac: key });
  }
  // The user's entries are written for their own platform, so they stand for both key and mac.
  const kept = defaults.filter((d) => {
    const own = norm(platform === 'darwin' ? (d.mac ?? d.key) : d.key);
    return !removed.some((r) => r.command === d.command && (!r.key || r.key === own));
  });
  return [...mine.reverse(), ...kept];
}

/** keybindings.json as VS Code writes it: JSON with comments and trailing commas. Not an array gives []. */
export function parseKeybindingsJson(text: string): UserKeybinding[] {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  try {
    const value = JSON.parse(out.replace(/,(\s*[\]}])/g, '$1'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
