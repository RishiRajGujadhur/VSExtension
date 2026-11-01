/** Converts a glob such as `**\/generated/**`, `src/legacy/*.ts` or `src/{app,lib}/**` to a regular expression on `/` paths. */
export function globToRegExp(glob: string, ignoreCase = process.platform === 'win32'): RegExp {
  return new RegExp(`^${globPattern(glob)}$`, ignoreCase ? 'i' : '');
}

function globPattern(glob: string): string {
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
    } else if (c === '{' && closingBrace(glob, i) > 0) {
      // Each alternative is a glob of its own, so `{src/*,lib/**}` and nested braces work.
      const close = closingBrace(glob, i);
      pattern += `(?:${splitAlternatives(glob.slice(i + 1, close)).map(globPattern).join('|')})`;
      i = close;
    } else {
      pattern += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  return pattern;
}

/** The index of the `}` closing the brace at `open`, or -1 when it is never closed and is taken literally. */
function closingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') {
      depth++;
    } else if (glob[i] === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      depth++;
    } else if (body[i] === '}') {
      depth--;
    } else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * Whether a workspace-relative `/` path matches any of the globs. A glob also matches everything
 * below a folder it names, so `src/legacy` and `src/legacy/` work like `src/legacy/**`.
 */
export function pathMatcher(globs: readonly string[], ignoreCase = process.platform === 'win32'): (relativePath: string) => boolean {
  const patterns = globs
    .map((g) => g.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map((g) => new RegExp(`^${globPattern(g)}(?:/.*)?$`, ignoreCase ? 'i' : ''));
  return (relativePath) => patterns.some((p) => p.test(relativePath));
}
