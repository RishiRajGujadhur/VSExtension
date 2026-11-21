import { words } from './words';

/**
 * Code X-Ray's code-intent model: what a piece of code is for, told from its names and its patterns, so the Git reel
 * can tell "adds an item to the cart" from "shows the items in the cart". It is a set of rules, each a pattern with a
 * weight: the verbs in a function's name (`addToCart`, `handleRemoveItem`, `CartList`), and what the code itself does
 * (`items.push(item)`, `setItems(prev => [...prev, item])`, `items.filter(i => i.id !== id)`, a list drawn with
 * `.map(item => <li>)`, `fetch(…)`, `INSERT INTO`, a `POST`…). The same code always gets the same answer, offline.
 */

export type IntentKind =
  | 'add'
  | 'remove'
  | 'update'
  | 'show'
  | 'fetch'
  | 'save'
  | 'send'
  | 'validate'
  | 'guard'
  | 'default'
  | 'calculate'
  | 'sort'
  | 'filter'
  | 'clear'
  | 'toggle'
  | 'auth'
  | 'navigate'
  | 'handle-error'
  | 'format'
  | 'configure'
  | 'log'
  | 'test';

export interface Intent {
  kind: IntentKind;
  /** The thing it acts on, in words: "item", "cart items", "the quantity". */
  object?: string;
  /** Where it goes or comes from: "cart", "server". */
  target?: string;
  /** What it does, as a verb phrase: "adds an item to the cart". */
  phrase: string;
  /** How sure the rules are: the sum of the weights of the patterns that matched. */
  score: number;
  /** The patterns that matched, for tests and for the reasons shown in the explainer. */
  evidence: string[];
}

export interface IntentInput {
  /** The function, method or component the code is in. */
  name?: string;
  /** The file it is in (its extension tells JSX and tests apart). */
  file?: string;
  /** Lines added (or the code itself, for new code). */
  added: string[];
  /** Lines removed. */
  removed?: string[];
}

/** Verbs a name starts with (after "handle", "on", "do"…), and the intent each one means. */
const NAME_VERBS: Record<string, IntentKind> = {};
const verbs = (kind: IntentKind, list: string) => list.split(' ').forEach((v) => (NAME_VERBS[v] = kind));
verbs('add', 'add append insert push create register enqueue attach include new');
verbs('remove', 'remove delete del drop discard detach unregister erase pop destroy');
verbs('update', 'update edit change modify patch rename increment decrement adjust set replace move apply');
verbs('show', 'show render display list view draw present open preview reveal');
verbs('fetch', 'fetch load get read query find retrieve pull download request lookup search');
verbs('save', 'save store persist write upload cache');
verbs('send', 'send post emit dispatch notify publish submit broadcast');
verbs('validate', 'validate check verify ensure assert is has can should');
verbs('calculate', 'calculate calc compute sum total count measure estimate convert');
verbs('sort', 'sort order rank');
verbs('filter', 'filter group pick select');
verbs('clear', 'clear reset empty flush purge');
verbs('toggle', 'toggle enable disable hide collapse expand');
verbs('auth', 'login logout signin signout signup authenticate authorize');
verbs('navigate', 'navigate redirect goto route go');
verbs('format', 'format stringify serialize to');
verbs('configure', 'configure setup init initialize');
verbs('log', 'log trace');

/** Words in front of the verb that say nothing about what it does: handleAddToCart, onRemoveClick, doSave. */
const LEADING = new Set(['handle', 'on', 'do', 'try', 'use', 'async', 'internal', 'private', 'with']);
/** Words after the verb that are not the thing acted on. */
const FILLER = new Set(['click', 'clicked', 'press', 'pressed', 'change', 'changed', 'submit', 'handler', 'callback', 'async', 'event', 'action', 'button', 'btn', 'request', 'impl', 'internal', 'all']);
const PREPOSITIONS = new Set(['to', 'from', 'in', 'into', 'on', 'of', 'for', 'by', 'with', 'at']);

interface Rule {
  kind: IntentKind;
  /** What the rule found, for the evidence list. */
  label: string;
  weight: number;
  test: RegExp;
  /** Reads the thing acted on (and where it goes) from the match. */
  read?: (m: RegExpExecArray) => { object?: string; target?: string };
}

const receiver = (expr: string | undefined) => (expr ? phraseOf(expr.replace(/^this\./, '').replace(/\?\./g, '.').split('.').slice(-2).join('.')) : undefined);

/** Patterns in the code: each a sign of an intent, read from one line at a time. */
const RULES: Rule[] = [
  // Adding to a collection.
  { kind: 'add', label: 'adds to a list', weight: 3, test: /\b((?!router\b|history\b|navigation\b)[\w$.?]+)\.(push|unshift|append|add|enqueue)\(\s*([\w$.]*)/, read: (m) => ({ target: receiver(m[1]), object: phraseOf(m[3]) }) },
  { kind: 'add', label: 'spreads a list and adds to it', weight: 3, test: /set(\w+)\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\[\s*\.\.\.\2\s*,\s*([\w$.]*)/, read: (m) => ({ target: phraseOf(m[1]), object: phraseOf(m[3]) }) },
  { kind: 'add', label: 'a new list with one more', weight: 2, test: /\[\s*\.\.\.([\w$.]+)\s*,\s*([\w$.{]+)/, read: (m) => ({ target: receiver(m[1]), object: phraseOf(m[2]) }) },
  { kind: 'add', label: 'inserts a row', weight: 3, test: /\bINSERT\s+INTO\s+\[?([\w.]+)/i, read: (m) => ({ target: phraseOf(m[1].split('.').pop()!) }) },
  { kind: 'add', label: 'posts to the server', weight: 2, test: /method:\s*['"]POST['"]|\.post\(\s*[`'"]([^`'"]*)/i, read: (m) => ({ target: m[1] ? lastPathWord(m[1]) : undefined }) },
  // Removing from one.
  { kind: 'remove', label: 'takes one out of a list', weight: 3, test: /([\w$.]+)\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2(?:\.\w+)?\s*!==?/, read: (m) => ({ target: receiver(m[1]) }) },
  { kind: 'remove', label: 'removes from a list', weight: 3, test: /([\w$.]+)\.(splice|delete|remove|pop|shift)\(/, read: (m) => ({ target: receiver(m[1]) }) },
  { kind: 'remove', label: 'deletes rows', weight: 3, test: /\bDELETE\s+FROM\s+\[?([\w.]+)/i, read: (m) => ({ target: phraseOf(m[1].split('.').pop()!) }) },
  { kind: 'remove', label: 'deletes on the server', weight: 2, test: /method:\s*['"]DELETE['"]|\.delete\(\s*[`'"]/i },
  // Changing one in place.
  { kind: 'update', label: 'changes the matching one', weight: 3, test: /([\w$.]+)\.map\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2(?:\.\w+)?\s*===?.*\?/, read: (m) => ({ target: receiver(m[1]) }) },
  { kind: 'update', label: 'updates rows', weight: 3, test: /\bUPDATE\s+\[?([\w.]+)\]?\s+SET\b/i, read: (m) => ({ target: phraseOf(m[1].split('.').pop()!) }) },
  { kind: 'update', label: 'puts on the server', weight: 2, test: /method:\s*['"](PUT|PATCH)['"]|\.(put|patch)\(\s*[`'"]/i },
  { kind: 'update', label: 'adds to a count', weight: 2, test: /([\w$.]*(?:quantity|qty|count|amount|total|stock))\s*(\+\+|--|[+-]=)/i, read: (m) => ({ object: phraseOf(m[1].split('.').pop()!) }) },
  // Showing.
  { kind: 'show', label: 'draws a list', weight: 4, test: /([\w$.]+)\.map\(\s*\(?\s*\w+[^)]*\)?\s*=>\s*\(?\s*(<\w|$)/, read: (m) => ({ object: receiver(m[1]) }) },
  { kind: 'show', label: 'draws markup', weight: 2, test: /^\s*(return\s*\(?\s*)?<[A-Za-z][\w.]*[\s>/]/ },
  { kind: 'show', label: 'shows a value', weight: 1, test: /\{\s*([\w$.]+)\s*\}\s*<\//, read: (m) => ({ object: receiver(m[1]) }) },
  { kind: 'show', label: 'writes to the page', weight: 2, test: /\.(innerHTML|textContent|innerText)\s*=|\.render\(/ },
  // Loading.
  { kind: 'fetch', label: 'asks the server', weight: 3, test: /\bfetch\(\s*[`'"]?([^`'",)]*)|axios\.get\(\s*[`'"]([^`'"]*)|\.get\(\s*[`'"](\/[^`'"]*)/, read: (m) => ({ object: lastPathWord(m[1] ?? m[2] ?? m[3] ?? '') }) },
  { kind: 'fetch', label: 'a query hook', weight: 3, test: /\buse(Query|SWR|Fetch)\b/ },
  { kind: 'fetch', label: 'reads rows', weight: 3, test: /\bSELECT\b[\s\S]*\bFROM\s+\[?([\w.]+)/i, read: (m) => ({ object: phraseOf(m[1].split('.').pop()!) }) },
  { kind: 'fetch', label: 'reads saved data', weight: 2, test: /localStorage\.getItem\(|sessionStorage\.getItem\(|readFile(Sync)?\(/ },
  // Saving and sending.
  { kind: 'save', label: 'keeps it in the browser', weight: 3, test: /(localStorage|sessionStorage)\.setItem\(\s*['"`]?([\w-]*)/, read: (m) => ({ object: phraseOf(m[2]) }) },
  { kind: 'save', label: 'writes a file', weight: 3, test: /writeFile(Sync)?\(|\.save\(|SaveChanges(Async)?\(/ },
  { kind: 'send', label: 'sends a message', weight: 2, test: /\.(emit|dispatch|publish|send|postMessage)\(/ },
  // Checking.
  { kind: 'validate', label: 'reports a problem', weight: 3, test: /errors?\.push\(|throw new \w*Error\(|\bRAISERROR\b|\bTHROW\s+\d/ },
  { kind: 'validate', label: 'checks a pattern', weight: 2, test: /\/.+\/[gimsuy]*\.test\(|\bisValid\w*\(|\bvalidate\w*\(/ },
  { kind: 'guard', label: 'stops early', weight: 3, test: /^\s*if\s*\(.*\)\s*(return|throw|continue|break)\b|^\s*if\s*\(.*\)\s*\{?\s*return\b/ },
  { kind: 'default', label: 'falls back to a default', weight: 2, test: /\?\?\s*[^?\s]|\|\|\s*(['"`\d[{]|null|false|true|undefined)/ },
  // Working things out.
  { kind: 'calculate', label: 'adds up', weight: 3, test: /\.reduce\(|\bSUM\(|\bCOUNT\(|\bMath\.(round|floor|ceil|max|min)\(/ },
  { kind: 'calculate', label: 'works out a total', weight: 2, test: /\b(total|subtotal|sum|price|cost|tax|discount)\w*\s*=[^=]/i, read: (m) => ({ object: m[1].toLowerCase() }) },
  { kind: 'sort', label: 'sorts', weight: 3, test: /\.sort\(|\bORDER\s+BY\b/i },
  { kind: 'filter', label: 'picks some', weight: 2, test: /\.filter\(|\bWHERE\b/i },
  { kind: 'clear', label: 'empties it', weight: 3, test: /set(\w+)\(\s*(\[\]|\{\}|''|""|0|null)\s*\)|\.clear\(\)|\.length\s*=\s*0/, read: (m) => ({ object: m[1] ? phraseOf(m[1]) : undefined }) },
  { kind: 'toggle', label: 'turns something on or off', weight: 2, test: /set(\w+)\(\s*(!\w+|\(?\s*\w+\s*\)?\s*=>\s*!\w+|true|false)\s*\)/, read: (m) => ({ object: phraseOf(m[1]) }) },
  { kind: 'auth', label: 'signs in or checks access', weight: 2, test: /\b(jwt|password|passwd|accessToken|authToken|refreshToken|bearer|login|logout|logIn|logOut|signIn|signOut|signUp|isAuthenticated|isLoggedIn|authorize\w*|currentUser|permissions?)\b/i },
  { kind: 'navigate', label: 'goes to another page', weight: 3, test: /\bnavigate\(|router\.(push|replace)\(|location\.(href|assign)|\bredirect\(|<Link\b|<Navigate\b/ },
  { kind: 'handle-error', label: 'handles errors', weight: 2, test: /^\s*(\}\s*)?catch\b|\.catch\(|^\s*try\s*\{|BEGIN\s+CATCH/i },
  { kind: 'format', label: 'formats text', weight: 2, test: /\.toFixed\(|toLocale\w*String\(|Intl\.\w+Format|\.padStart\(|\.toUpperCase\(\)|JSON\.stringify\(/ },
  { kind: 'configure', label: 'changes a setting', weight: 1, test: /\b(config|settings|options|env)\.\w+/i },
  { kind: 'log', label: 'logs', weight: 1, test: /\bconsole\.(log|info|warn|error|debug)\(|\blogger\.\w+\(|\bPRINT\b/ },
  { kind: 'test', label: 'a test', weight: 3, test: /\b(it|test|describe)\(\s*['"`]|\bexpect\(|\bassert\.\w+\(/ },
];

const GENERIC = new Set('out output result results res ret list lists arr array acc parts part pieces piece lines line chunks chunk buf buffer buffers waiting pending queue stack seen visited cache memo errors args params keys values entries map set rows cols tmp temp copy next prev all found matches names texts strings tokens nodes children elements els ids todo done'.split(' '));

/** "cartItems" → "cart items"; "x", "" and working variables ("out", "result") → undefined: nothing to say. */
function phraseOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const w = words(name.replace(/[^\w$.]/g, '').split('.').filter(Boolean).slice(-2).join(' '))
    .map((x) => x.toLowerCase())
    .filter((x) => !['this', 'prev', 'state', 'props', 'current', 'value', 'data', 'e', 'event', 'it', 'x', 'i'].includes(x));
  const out = w.join(' ').trim();
  // Working variables say nothing about the feature: "out", "result", "parts", "waiting".
  return out.length >= 2 && !GENERIC.has(out) ? out : undefined;
}

/** "/api/cart/items" → "items"; "" → undefined. */
function lastPathWord(url: string): string | undefined {
  const part = url.split('?')[0].split('/').filter((p) => p && !p.startsWith('$') && !p.startsWith(':') && !/^\d+$/.test(p) && !/^(api|v\d+|https?:)$/.test(p)).pop();
  return part ? phraseOf(part.replace(/[-.]/g, '_')) : undefined;
}

/**
 * What a name says the code does: `addToCart` → add, target "cart"; `handleRemoveItem` → remove, object "item";
 * `CartItemsList` → show, object "cart items" (a component, named for what it shows).
 */
export function nameIntent(name: string, file = ''): { kind: IntentKind; object?: string; target?: string } | undefined {
  const all = words(name).map((w) => w.toLowerCase());
  let i = 0;
  while (i < all.length - 1 && LEADING.has(all[i])) i++;
  const verb = all[i];
  const kind = NAME_VERBS[verb] ?? (verb === 'sign' && /^(in|out|up)$/.test(all[i + 1] ?? '') ? 'auth' : undefined);
  const rest = all.slice(kind === 'auth' && verb === 'sign' ? i + 2 : i + 1).filter((w) => !FILLER.has(w));
  if (!kind) {
    // A component: "CartItemsList", "OrderSummary": it shows what it is named for.
    if (/^[A-Z]/.test(name) && /\.(tsx|jsx)$/i.test(file)) return { kind: 'show', object: all.filter((w) => !/^(list|view|panel|page|component|card|table|grid|section|container|screen|widget)$/.test(w)).join(' ') || undefined };
    return undefined;
  }
  // "to cart" → target; what comes before it, the object.
  const at = rest.findIndex((w) => PREPOSITIONS.has(w));
  const object = (at < 0 ? rest : rest.slice(0, at)).join(' ') || undefined;
  const target = at < 0 ? undefined : rest.slice(at + 1).join(' ') || undefined;
  return { kind, object, target };
}

/**
 * The intents of a piece of code, the likeliest first: every pattern that matches adds its weight, and the name's
 * verb counts most. Lines only removed count for what the code no longer does, at a lower weight.
 */
export function intentsOf(input: IntentInput): Intent[] {
  const found = new Map<IntentKind, { score: number; evidence: string[]; object?: string; target?: string }>();
  const note = (kind: IntentKind, weight: number, label: string, read: { object?: string; target?: string } = {}) => {
    const entry = found.get(kind) ?? { score: 0, evidence: [] };
    entry.score += weight;
    if (!entry.evidence.includes(label)) entry.evidence.push(label);
    entry.object ??= read.object;
    entry.target ??= read.target;
    found.set(kind, entry);
  };
  const named = input.name ? nameIntent(input.name, input.file) : undefined;
  if (named) note(named.kind, 5, `named "${input.name}"`, named);
  if (input.file && /(\.|\/|\\)(test|spec)s?[./\\]|__tests__/i.test(input.file)) note('test', 6, 'a test file');
  const hits = new Map<Rule, number>();
  const scan = (lines: string[], factor: number) => {
    for (const raw of lines) {
      const line = raw.replace(/\/\/.*$|--.*$/, '');
      if (!line.trim()) continue;
      for (const rule of RULES) {
        const m = rule.test.exec(line);
        // A pattern counts at most twice: a long new file repeating it is not more sure of it.
        if (!m || (hits.get(rule) ?? 0) >= 2) continue;
        hits.set(rule, (hits.get(rule) ?? 0) + 1);
        note(rule.kind, rule.weight * factor, rule.label, rule.read?.(m));
      }
    }
  };
  scan(input.added, 1);
  scan(input.removed ?? [], 0.5);
  // Drawing a list beats each value drawn in it; a guard that throws is validation too.
  const out: Intent[] = [...found.entries()].map(([kind, f]) => {
    // The name says best what is acted on: "addToCart" → the cart, even when the code pushes to "items".
    // A name with its own object ("changeQuantity") keeps it alone; one with only a target ("addToCart") takes the
    // object from the code.
    const byName = named?.kind === kind;
    const object = byName ? named.object ?? f.object : f.object;
    const target = byName && (named.object || named.target) ? named.target : f.target;
    // A list drawn item by item, told from the code: "lists the items one by one".
    const phrase = kind === 'show' && !byName && f.evidence.includes('draws a list') ? `lists ${object ? the(object) : 'the items'} one by one` : intentPhrase(kind, object, target);
    return { kind, object, target, phrase, score: Math.round(f.score * 10) / 10, evidence: f.evidence };
  });
  return out.sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** On a tie, the more specific intent first. */
const KIND_ORDER: IntentKind[] = ['add', 'remove', 'update', 'auth', 'navigate', 'show', 'fetch', 'save', 'send', 'clear', 'toggle', 'sort', 'calculate', 'validate', 'guard', 'filter', 'default', 'handle-error', 'format', 'configure', 'test', 'log'];

/** The likeliest intent, when the rules are sure enough (a score of at least `min`). */
export function mainIntent(input: IntentInput, min = 3): Intent | undefined {
  const [first] = intentsOf(input);
  return first && first.score >= min ? first : undefined;
}

const the = (thing: string) => (/^(the|a|an|its|their|your|this|these|each|every|all)\b/.test(thing) ? thing : `the ${thing}`);
const an = (thing: string) => (/^(the|a|an|its|their|your|this|these|each|every|all)\b/.test(thing) || / /.test(thing) && /s$/.test(thing) ? thing : `${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing}`);

/** The intent as a verb phrase: "adds an item to the cart", "shows the cart items", "loads the orders". */
export function intentPhrase(kind: IntentKind, object?: string, target?: string): string {
  const o = object?.trim();
  const t = target?.trim();
  switch (kind) {
    case 'add':
      return `adds ${o ? an(o) : 'an item'}${t ? ` to ${the(t)}` : ''}`;
    case 'remove':
      return `removes ${o ? an(o) : 'an item'}${t ? ` from ${the(t)}` : ''}`;
    case 'update':
      return `updates ${o ? the(o) : 'an item'}${t ? ` in ${the(t)}` : ''}`;
    case 'show':
      return `shows ${o ? the(o) : 'it on screen'}${t ? ` in ${the(t)}` : ''}`;
    case 'fetch':
      return `loads ${o ? the(o) : 'data'}${t ? ` from ${the(t)}` : ''}`;
    case 'save':
      return `saves ${o ? the(o) : 'it'}${t ? ` to ${the(t)}` : ''}`;
    case 'send':
      return `sends ${o ? the(o) : 'a message'}${t ? ` to ${the(t)}` : ''}`;
    case 'validate':
      return `checks ${o ? the(o) : 'the input'} is valid`;
    case 'guard':
      return `stops early when there is nothing to do`;
    case 'default':
      return `falls back to a default value`;
    case 'calculate':
      return `works out ${o ? the(o) : 'a value'}`;
    case 'sort':
      return `sorts ${o ? the(o) : 'the list'}`;
    case 'filter':
      return `picks out ${o ? the(o) : 'some of the items'}`;
    case 'clear':
      return `clears ${o ? the(o) : 'it'}`;
    case 'toggle':
      return `turns ${o ? the(o) : 'it'} on or off`;
    case 'auth':
      return `checks who is signed in`;
    case 'navigate':
      return `takes the user to another page`;
    case 'handle-error':
      return `handles errors`;
    case 'format':
      return `formats ${o ? the(o) : 'the text'}`;
    case 'configure':
      return `sets up ${o ? the(o) : 'the settings'}`;
    case 'log':
      return `logs what happens`;
    case 'test':
      return `tests ${o ? the(o) : 'the code'}`;
  }
}

/** The short label for the reel's callout: "Adds to cart", "Shows cart items". */
export function intentLabel(intent: Intent): string {
  const p = intent.phrase.replace(/\b(an?|the) /g, '').replace(/ on screen$/, '');
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * How much a single line says about what the code does, from the patterns above: a list changed, a request made, a
 * check added count; logging and settings barely do.
 */
export function lineSignal(line: string): { weight: number; kinds: IntentKind[] } {
  const code = line.replace(/\/\/.*$|--.*$/, '');
  let weight = 0;
  const kinds: IntentKind[] = [];
  for (const rule of RULES) {
    if (!rule.test.test(code)) continue;
    const w = rule.kind === 'log' ? -1 : rule.kind === 'configure' || rule.kind === 'auth' ? 0.5 : rule.weight;
    weight += w;
    if (w > 0 && !kinds.includes(rule.kind)) kinds.push(rule.kind);
  }
  return { weight, kinds };
}

/** Intents that are what a feature does for its user, not how the code goes about it (a check, a default, a log). */
const FEATURE_KINDS = new Set<IntentKind>(['add', 'remove', 'update', 'show', 'fetch', 'save', 'send', 'calculate', 'sort', 'filter', 'clear', 'toggle', 'auth', 'navigate']);

/**
 * What a function or file is for, as a feature: "adds an item to the cart", "shows the cart items". Only feature
 * intents count, and only when the rules are sure (a telling name, or several patterns in the code).
 */
export function featureIntent(input: IntentInput, min = 4): Intent | undefined {
  return intentsOf(input).find((i) => {
    if (!FEATURE_KINDS.has(i.kind) || i.score < min) return false;
    // The name agrees: "addToCart", "CartItems.tsx".
    if (i.evidence.some((e) => e.startsWith('named '))) return i.kind !== 'calculate' && i.kind !== 'filter' ? true : !!i.object;
    // The code alone: about something with a name, and for adding, removing and changing, data that is kept (rows,
    // the server, the page's state), not a list the code builds for itself.
    if (!i.object && !i.target) return false;
    if (i.kind === 'add' || i.kind === 'remove' || i.kind === 'update') return i.evidence.some((e) => STRONG.has(e));
    return ['show', 'fetch', 'save', 'send', 'navigate', 'auth'].includes(i.kind);
  });
}
const STRONG = new Set(['inserts a row', 'posts to the server', 'deletes rows', 'deletes on the server', 'updates rows', 'puts on the server', 'spreads a list and adds to it', 'changes the matching one']);

const firstWords = (s: string | undefined, n = 2) => s?.split(' ').slice(0, n).join(' ');

/** The callout on the key lines, a few words: "Key change: adds to cart", "Key change: early exit". */
export function keyLabel(intent: Intent | undefined): string {
  if (!intent) return 'Key change';
  const o = firstWords(intent.object);
  const t = firstWords(intent.target);
  const words: Record<IntentKind, string> = {
    add: `adds to ${t ?? 'a list'}`,
    remove: `removes from ${t ?? 'a list'}`,
    update: `updates ${o ?? t ?? 'an item'}`,
    show: `shows ${o ?? 'it on screen'}`,
    fetch: `loads ${o ?? 'data'}`,
    save: `saves ${o ?? 'data'}`,
    send: 'sends a message',
    validate: 'new check',
    guard: 'early exit',
    default: 'default value',
    calculate: `works out ${o ?? 'a value'}`,
    sort: 'sorting',
    filter: 'filtering',
    clear: `clears ${o ?? 'it'}`,
    toggle: 'on/off switch',
    auth: 'sign-in check',
    navigate: 'navigation',
    'handle-error': 'error handling',
    format: 'formatting',
    configure: 'settings',
    log: 'logging',
    test: 'the test',
  };
  return `Key change: ${words[intent.kind]}`;
}

/** The words of a name that name a thing, not an action: "handleAddToCart" → "cart", "OrderSummary" → "order summary". */
export function nounsOf(name: string): string | undefined {
  const all = words(name).map((w) => w.toLowerCase());
  const kept = all.filter((w) => !LEADING.has(w) && !NAME_VERBS[w] && !FILLER.has(w) && !PREPOSITIONS.has(w) && !/^(list|view|panel|page|component|card|table|grid|section|container|screen|widget)$/.test(w));
  return kept.join(' ') || undefined;
}

/**
 * Plain descriptions of what features do, for the code model to compare code with. "other" ones are there so that
 * code about checks, errors or formatting is not taken for a feature.
 */
export const FEATURE_PROTOTYPES: { kind: IntentKind | 'other'; text: string }[] = [
  { kind: 'add', text: 'add an item to the cart, list or collection, create a new record' },
  { kind: 'remove', text: 'remove or delete an item from the cart or list' },
  { kind: 'update', text: 'update, edit or change an existing item, its quantity or its details' },
  { kind: 'show', text: 'show or display items on the screen, render a list, a page or a view' },
  { kind: 'fetch', text: 'load or fetch data from the server, an api or the database' },
  { kind: 'save', text: 'save or store data to disk, local storage or the database' },
  { kind: 'send', text: 'send a message, an email or a notification' },
  { kind: 'calculate', text: 'calculate a total, price, tax, discount, sum or amount' },
  { kind: 'sort', text: 'sort or order a list' },
  { kind: 'filter', text: 'filter or search a list for matching items' },
  { kind: 'clear', text: 'clear, reset or empty everything' },
  { kind: 'toggle', text: 'turn something on or off, show or hide a panel' },
  { kind: 'auth', text: 'sign in, log in, log out, check the password or permissions' },
  { kind: 'navigate', text: 'go to another page, route or screen' },
  { kind: 'other', text: 'check that the input is valid and report errors' },
  { kind: 'other', text: 'handle errors and exceptions, retry when something fails' },
  { kind: 'other', text: 'format text, convert or parse values, build strings' },
  { kind: 'other', text: 'read settings and configuration, set up options' },
  { kind: 'other', text: 'log messages for debugging' },
  { kind: 'other', text: 'test that the code works, assert and expect results' },
];
