/** Converts a glob such as `**\/generated/**` or `src/legacy/*.ts` to a regular expression on `/` paths. */
export function globToRegExp(glob: string, ignoreCase = process.platform === 'win32'): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of directories, including none.
        pattern += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (c === '?') {
      pattern += '[^/]';
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      pattern += `(?:${glob.slice(i + 1, close).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = close;
    } else {
      pattern += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`, ignoreCase ? 'i' : '');
}
