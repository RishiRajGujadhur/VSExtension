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
