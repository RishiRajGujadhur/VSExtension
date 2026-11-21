import ts = require('typescript');

/**
 * Code into plain English, by rules, for the Git reel's captions: names into words ("validateSettingsExport" →
 * "validates the settings export"), conditions into clauses ("!items.length" → "there are no items"), calls into what
 * they do ("fs.writeFileSync(f, d)" → "writes a file"). Deterministic and offline: the same code always reads the same.
 */

const ACRONYMS = new Set(['api', 'url', 'uri', 'id', 'ids', 'json', 'html', 'css', 'xml', 'sql', 'http', 'https', 'ui', 'io', 'db', 'pdf', 'csv', 'svg', 'png', 'jwt', 'ast', 'cfg', 'dom', 'cpu', 'gpu', 'os', 'ip', 'tcp', 'udp', 'cli', 'sdk', 'vs']);

/** "validateSettingsExport" → ["validate", "settings", "export"]; "parseURLQuery" → ["parse", "URL", "query"]. */
export function words(name: string): string[] {
  return name
    .replace(/^[_$@#]+|[_$]+$/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.$]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase().replace(/^IDS$/, 'IDs') : /^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()));
}

/** A name as a noun phrase: "settingsValidation" → "the settings validation"; "items" → "the items". */
const NO_ARTICLE = new Set(['all', 'each', 'every', 'this', 'these', 'those', 'it', 'them', 'everything', 'nothing', 'something', 'anything', 'others', 'rest']);
export function noun(name: string, article = true): string {
  const w = words(name.replace(/^this\./, ''));
  if (!w.length) return 'it';
  // "x", "id", "all": no "the".
  const bare = w.length === 1 && (w[0].length <= 2 || NO_ARTICLE.has(w[0]));
  return `${article && !bare ? 'the ' : ''}${w.join(' ')}`;
}

const IRREGULAR: Record<string, string> = { do: 'does', go: 'goes', have: 'has', be: 'is', undo: 'undoes', redo: 'redoes' };
/** "validate" → "validates", "fetch" → "fetches", "apply" → "applies". */
export function third(verb: string): string {
  const v = verb.toLowerCase();
  if (IRREGULAR[v]) return IRREGULAR[v];
  if (/(s|sh|ch|x|z|o)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}

/** Leading words that are verbs, and how a name starting with them reads. */
const VERBS = new Set(
  'audit approve archive assign authenticate authorize backup bump calibrate capture cleanup clone compile compress confirm crop debounce decrypt deploy deselect disconnect dismiss drop edit encrypt escape estimate evaluate fix flush fold freeze grant hydrate increment decrement indent index inject inspect interpolate invalidate layout lint migrate minify monitor optimize order paste persist plan poll populate predict preload probe profile prune queue rank rate reconcile redirect redraw reduce refetch reindex relaunch remind repair repeat reorder replay rerun respond restart resume revert review rewind roll score serve settle share shuffle sign simulate snooze solve suspend tally throttle tokenize truncate tune undo unfold unload unsubscribe upgrade get set load save read write create make build add remove delete update validate check parse format render handle fetch send open close start stop init initialize reset compute calculate find search sort filter map convert apply register track log emit notify show hide toggle select pick copy move rename merge split clear run execute process normalize resolve ensure wait schedule watch listen subscribe export import record play pause draw paint measure compare diff describe explain wrap unwrap encode decode serialize deserialize download upload refresh sync retry cache collect count group list mark merge print publish push pull query request reply report restore scan scroll seek setup store submit summarize test throw transform trim try verify view visit walk warn accept allow attach bind block build call cancel charge choose clean click commit configure connect delete detect disable dispose enable enter exit expand extract fail fill fit focus generate guard hash highlight hook ignore insert install invoke join keep launch lock match merge mount mutate navigate observe offer pack pad patch pin place post prepare preview prompt read rebuild receive refactor reject release reload replace resize retry return reveal rotate route sample sanitize scale schedule shift skip slice snap sort spawn speak stage stream strip style swap tag tick trace translate trigger unlock unpin unwatch use wake zoom'.split(' '),
);

/**
 * What a function named so does, as a verb phrase: "validateSettingsExport" → "validates the settings export",
 * "isEmpty" → "checks whether it is empty", "onClick" → "handles the click", "toJSON" → "converts it to JSON".
 */
export function verbPhrase(name: string, asCall = false): string {
  const w = words(name);
  if (!w.length) return 'does its work';
  const [first, ...rest] = w;
  const object = rest.join(' ');
  if (rest.length && rest.every((x) => /^(of|for|from|by|to|at|in|on)$/.test(x)) && first !== 'on' && first !== 'to') return asCall ? `uses the ${first}` : `works out the ${first}`;
  if (['is', 'has', 'can', 'should', 'will', 'was', 'needs', 'contains', 'includes', 'supports'].includes(first)) return `checks whether it ${first === 'needs' ? 'needs' : first} ${object}`.trim();
  if (first === 'on' && rest.length) return `handles the ${object}`;
  if (first === 'to' && rest.length) return `converts it to ${object}`;
  if (first === 'use' && rest.length) return `uses the ${object}`;
  if (first === 'with' && rest.length) return `adds the ${object}`;
  if (VERBS.has(first)) return `${third(first)}${object ? ` the ${object}` : ''}`;
  const thing = w.join(' ').replace(/ (of|for|from|by|to|in)$/, '');
  if (asCall) return `uses the ${thing}`;
  return `works out the ${thing}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Expressions

function parseExpression(code: string): ts.Expression | undefined {
  const source = ts.createSourceFile('x.ts', `(${code.trim().replace(/;$/, '')});`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return undefined;
  // A parse error means this is not an expression TypeScript can read (SQL, say).
  if ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return undefined;
  let e = statement.expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** A value or expression as words: "user.role" → "the user's role", "items.length" → "the number of items". */
export function valueWords(code: string): string {
  const e = parseExpression(code);
  return e ? exprWords(e) : looseWords(code);
}

function exprWords(e: ts.Expression): string {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text === 'undefined' ? 'nothing' : noun(e.text);
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (e.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (e.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (e.kind === ts.SyntaxKind.NullKeyword) return 'nothing';
  if (ts.isNumericLiteral(e)) return e.text;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text.length <= 30 ? `"${e.text}"` : 'a text';
  if (ts.isTemplateExpression(e)) return 'a text';
  if (ts.isArrayLiteralExpression(e)) return e.elements.length === 1 && ts.isSpreadElement(e.elements[0]) ? exprWords(e.elements[0].expression) : e.elements.length ? 'a list' : 'an empty list';
  if (ts.isObjectLiteralExpression(e)) return e.properties.length ? 'an object' : 'an empty object';
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return 'a function';
  if (ts.isPropertyAccessExpression(e)) {
    const owner = e.expression;
    const prop = e.name.text;
    if (prop === 'length') return `the number of ${exprWords(owner).replace(/^the /, '')}`;
    if (owner.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(owner) && owner.text.length <= 2)) return noun(prop);
    const ownerWords = exprWords(owner);
    return `${ownerWords.startsWith('the ') ? ownerWords : `the ${ownerWords}`}'s ${words(prop).join(' ')}`.replace(/s's /, "s' ");
  }
  if (ts.isElementAccessExpression(e)) return `an entry of ${exprWords(e.expression)}`;
  if (ts.isCallExpression(e)) {
    const name = calleeName(e);
    const method = name?.split('.').pop() ?? '';
    if (/^(sort|filter|map|slice|concat|reverse|flat|flatMap|toSorted|from|values|keys|entries)$/.test(method) && ts.isPropertyAccessExpression(e.expression)) return exprWords(e.expression.expression);
    if (/^(abs|max|min|round|floor|ceil|sqrt|pow)$/.test(method)) return 'a calculated value';
    return name ? noun(method.replace(/^(get|load|read|fetch|find|compute|calculate|make|build|create)(?=[A-Z])/, '')) : 'a result';
  }
  if (ts.isNewExpression(e)) return `a new ${ts.isIdentifier(e.expression) ? words(e.expression.text).join(' ') : 'object'}`;
  if (ts.isBinaryExpression(e)) {
    const op = { [ts.SyntaxKind.PlusToken]: 'plus', [ts.SyntaxKind.MinusToken]: 'minus', [ts.SyntaxKind.AsteriskToken]: 'times', [ts.SyntaxKind.SlashToken]: 'divided by' }[e.operatorToken.kind as number];
    if (op) return simple(e.left) && simple(e.right) ? `${exprWords(e.left)} ${op} ${exprWords(e.right)}` : 'a calculated value';
    if (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken) return `${exprWords(e.left)}, or else ${exprWords(e.right)}`;
  }
  if (ts.isConditionalExpression(e)) return `${exprWords(e.whenTrue)} or ${exprWords(e.whenFalse)}, depending on whether ${conditionOf(e.condition) ?? 'a check passes'}`;
  if (ts.isBinaryExpression(e) || ts.isPrefixUnaryExpression(e)) return conditionOf(e) ?? looseWords(e.getText());
  return looseWords(e.getText());
}

const simple = (e: ts.Expression) => ts.isIdentifier(e) || ts.isNumericLiteral(e) || ts.isStringLiteral(e) || (ts.isPropertyAccessExpression(e) && (ts.isIdentifier(e.expression) || e.expression.kind === ts.SyntaxKind.ThisKeyword));

/** Code read word by word, as a last resort: names split, operators said. */
function looseWords(code: string): string {
  return code
    .replace(/[@#]/g, '')
    .replace(/[A-Za-z_$][\w$]*/g, (m) => words(m).join(' '))
    .replace(/===?/g, ' is ')
    .replace(/!==?/g, ' is not ')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/\?\?/g, ' or else ')
    .replace(/[{}[\]();`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TYPEOF_WORDS: Record<string, string> = { string: 'text', number: 'a number', boolean: 'true or false', function: 'a function', object: 'an object', undefined: 'missing', bigint: 'a number' };

/** A condition as a clause: "!items.length" → "there are no items", "a >= 3" → "the a is at least 3". */
export function conditionWords(code: string): string {
  // T-SQL @variables read as names.
  code = code.replace(/@(\w+)/g, '$1').replace(/\bIS\s+NOT\s+NULL\b/gi, '!== null').replace(/\bIS\s+NULL\b/gi, '=== null').replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||').replace(/<>/g, '!==').replace(/(?<![<>!=])=(?!=)/g, '===');
  const e = parseExpression(code);
  return (e && conditionOf(e)) ?? looseWords(code.replace(/^@/, ''));
}

function conditionOf(e: ts.Expression): string | undefined {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = e.operand;
    if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'length') return emptiness(inner.expression, true);
    if (ts.isCallExpression(inner)) return negate(callCondition(inner));
    const flag = flagWords(inner);
    if (flag) return `it is not ${flag}`;
    return `${exprWords(inner)} is not set`;
  }
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'length') return emptiness(e.expression, false);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const flag = flagWords(e);
    return flag ? `it is ${flag}` : `${exprWords(e)} is set`;
  }
  if (ts.isCallExpression(e)) return callCondition(e);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return `${conditionOf(e.left) ?? exprWords(e.left)} and ${conditionOf(e.right) ?? exprWords(e.right)}`;
    if (op === ts.SyntaxKind.BarBarToken) return `${conditionOf(e.left) ?? exprWords(e.left)} or ${conditionOf(e.right) ?? exprWords(e.right)}`;
    if (op === ts.SyntaxKind.InstanceOfKeyword) return `${exprWords(e.left)} is a ${ts.isIdentifier(e.right) ? words(e.right.text).join(' ') : 'kind of object'}`;
    if (op === ts.SyntaxKind.InKeyword) return `${exprWords(e.right)} has ${ts.isStringLiteral(e.left) ? words(e.left.text).join(' ') : exprWords(e.left)}`;
    const left = e.left;
    const right = e.right;
    // typeof x === 'string'
    if (ts.isTypeOfExpression(left) && ts.isStringLiteral(right)) {
      const kind = TYPEOF_WORDS[right.text] ?? right.text;
      const positive = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
      return `${exprWords(left.expression)} is ${positive ? '' : 'not '}${kind}`;
    }
    const missing = (x: ts.Expression) => x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
    if (missing(right) || missing(left)) {
      const subject = exprWords(missing(right) ? left : right);
      const equal = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
      return `${subject} is ${equal ? 'missing' : 'given'}`;
    }
    const l = exprWords(left);
    const r = exprWords(right);
    if (ts.isPropertyAccessExpression(left) && left.name.text === 'length' && ts.isNumericLiteral(right) && right.text === '0') {
      const things = exprWords(left.expression).replace(/^the /, '');
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) return `there are no ${things}`;
      if (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return `there are ${things}`;
    }
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        return `${l} is ${r}`;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return `${l} is not ${r}`;
      case ts.SyntaxKind.GreaterThanToken:
        return `${l} is more than ${r}`;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return `${l} is at least ${r}`;
      case ts.SyntaxKind.LessThanToken:
        return `${l} is less than ${r}`;
      case ts.SyntaxKind.LessThanEqualsToken:
        return `${l} is at most ${r}`;
    }
  }
  return undefined;
}

const STATES = new Set(['visible', 'hidden', 'empty', 'open', 'closed', 'active', 'enabled', 'disabled', 'ready', 'valid', 'dirty', 'busy', 'done', 'fitted', 'pinned', 'primary', 'selected', 'focused', 'expanded', 'collapsed', 'loading', 'playing', 'recording', 'paused', 'running', 'cancelled', 'dragging', 'editing', 'checked', 'online', 'offline', 'mounted', 'connected', 'available', 'required', 'optional', 'readonly', 'locked', 'muted', 'new', 'tall', 'wide', 'compact', 'full', 'touched', 'same', 'changed', 'leaving', 'moving']);
/** A flag's state in words: "isOpen" → "open", "playing" → "playing", "this.ready" → "ready"; else undefined. */
function flagWords(e: ts.Expression): string | undefined {
  const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
  const w = words(name);
  if (!w.length) return undefined;
  if (/^(is|has|can|should|was)$/.test(w[0]) && w.length > 1) return `${w[0] === 'has' ? 'has ' : w[0] === 'can' ? 'able to ' : ''}${w.slice(1).join(' ')}`;
  const last = w[w.length - 1];
  return w.length <= 2 && STATES.has(last) ? w.join(' ') : undefined;
}

/** "there are no items" for a plural name, "the kept list is empty" otherwise. */
function emptiness(owner: ts.Expression, empty: boolean): string {
  const things = exprWords(owner);
  const plural = /s$/.test(things) && !/ss$/.test(things);
  if (plural) return empty ? `there are no ${things.replace(/^the /, '')}` : `there are ${things.replace(/^the /, '')}`;
  return `${things} is ${empty ? '' : 'not '}empty`;
}

const negate = (clause: string) =>
  clause
    .replace(/^(.*?) (is|has|contains|starts with|ends with|matches|exists)\b ?/, (_, s, v) => `${s} ${v === 'is' ? 'is not' : v === 'has' ? 'does not have' : v === 'exists' ? 'does not exist' : `does not ${v.replace(/s( with)?$/, '$1').replace(/es$/, '')}`} `)
    .replace(/^it can /, 'it cannot ')
    .trim();

function callCondition(call: ts.CallExpression): string {
  const name = calleeName(call) ?? '';
  const method = name.split('.').pop() ?? '';
  const owner = ts.isPropertyAccessExpression(call.expression) ? exprWords(call.expression.expression) : 'it';
  const arg = call.arguments[0] ? exprWords(call.arguments[0]) : '';
  switch (method) {
    case 'isNaN':
      return `${arg} is not a number`;
    case 'includes':
    case 'has':
      return `${owner} ${method === 'has' ? 'has' : 'contains'} ${arg}`;
    case 'startsWith':
      return `${owner} starts with ${arg}`;
    case 'endsWith':
      return `${owner} ends with ${arg}`;
    case 'test':
      return `${arg} matches the pattern`;
    case 'isArray':
      return `${arg} is a list`;
    case 'some':
      return `some of ${owner} match`;
    case 'every':
      return `all of ${owner} match`;
    case 'existsSync':
      return `${arg} exists`;
  }
  const phrase = verbPhrase(method);
  if (phrase.startsWith('checks whether it ')) return phrase.replace('checks whether it ', `${owner === 'it' ? (arg || 'it') : owner} `);
  // A noun used as a test, such as object(x): "x is an object".
  const w = words(method);
  if (arg && !VERBS.has(w[0])) return `${arg} is ${/^[aeiou]/i.test(w.join(' ')) ? 'an' : 'a'} ${w.join(' ')}`;
  return `${noun(method)} passes`;
}

/** "this.panel.webview.postMessage" for a call. */
export function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const owner = ts.isIdentifier(e.expression) ? `${e.expression.text}.` : ts.isPropertyAccessExpression(e.expression) ? `${calleeName({ expression: e.expression } as unknown as ts.CallExpression) ?? ''}.` : e.expression.kind === ts.SyntaxKind.ThisKeyword ? 'this.' : '';
    return `${owner}${e.name.text}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Calls: what they do

/** Well-known calls, by how they end, and what they do. */
const KNOWN: [RegExp, string | ((args: string[]) => string)][] = [
  [/^(fs\.)?(promises\.)?(readFile|readFileSync)$/, 'reads a file'],
  [/^(fs\.)?(promises\.)?(writeFile|writeFileSync|appendFile|appendFileSync)$/, 'writes a file'],
  [/^(fs\.)?(promises\.)?(mkdir|mkdirSync)$/, 'creates a folder'],
  [/^(fs\.)?(promises\.)?(rm|rmSync|unlink|unlinkSync)$/, 'deletes a file'],
  [/^(fs\.)?(existsSync|stat|statSync)$/, 'checks the file'],
  [/^fetch$|\.(get|post|put|patch|delete)$/, (a) => `makes a request${a[0] ? ` to ${a[0]}` : ''}`],
  [/^JSON\.parse$/, 'reads the JSON'],
  [/^JSON\.stringify$/, 'turns it into JSON'],
  [/^console\.(log|info|debug)$/, 'logs a message'],
  [/^console\.(warn|error)$/, 'logs a problem'],
  [/setTimeout$/, 'waits a moment'],
  [/setInterval$/, 'repeats on a timer'],
  [/addEventListener$/, (a) => `listens for ${a[0] ? `${a[0].replace(/"/g, '')} events` : 'events'}`],
  [/removeEventListener$/, (a) => `stops listening for ${a[0] ? `${a[0].replace(/"/g, '')} events` : 'events'}`],
  [/postMessage$/, 'sends a message'],
  [/localStorage\.setItem$|sessionStorage\.setItem$/, 'saves it in the browser'],
  [/localStorage\.getItem$|sessionStorage\.getItem$/, 'reads it from the browser'],
  [/^(Promise\.all|Promise\.allSettled)$/, 'runs them together'],
  [/^(useState)$/, 'keeps some state'],
  [/^(useEffect|useLayoutEffect)$/, 'runs an effect when its inputs change'],
  [/^(useMemo|useCallback)$/, 'remembers a value between renders'],
  [/^(useRef)$/, 'keeps a reference'],
  [/execFile(Sync)?$|spawn(Sync)?$|exec(Sync)?$/, (a) => `runs ${a[0] ? a[0].replace(/"/g, '') : 'a program'}`],
  [/registerCommand$/, 'registers a command'],
  [/show(Information|Warning|Error)Message$/, 'shows a message'],
  [/showQuickPick$/, 'asks the user to pick'],
  [/showInputBox$/, 'asks the user for a value'],
  [/require$/, 'loads a module'],
  [/^(Math\.(max|min))$/, 'keeps it within limits'],
  [/^(Math\.round|Math\.floor|Math\.ceil)$/, 'rounds the number'],
  [/^Object\.(keys|values|entries)$/, 'goes through the object'],
  [/^(assert|expect)$|\.(equal|deepEqual|toBe|toEqual|ok|match)$/, 'checks the result'],
  [/(?:^|\.)(push|unshift|add|set)$/, (a) => 'adds to the list'],
  [/(?:^|\.)(splice|delete|pop|shift)$/, 'removes from the list'],
  [/(?:^|\.)(sort)$/, 'sorts them'],
  [/(?:^|\.)(filter)$/, 'keeps only some of them'],
  [/(?:^|\.)(map)$/, 'turns each one into something else'],
  [/(?:^|\.)(reduce)$/, 'adds them up'],
  [/(?:^|\.)(forEach)$/, 'goes through each one'],
  [/(?:^|\.)(find|findIndex)$/, 'looks for one'],
  [/(?:^|\.)(join)$/, 'joins them together'],
  [/(?:^|\.)(split)$/, 'splits it up'],
  [/(?:^|\.)(replace|replaceAll)$/, 'replaces part of it'],
  [/(?:^|\.)(trim|toLowerCase|toUpperCase)$/, 'tidies the text'],
  [/(?:^|\.)(then)$/, 'waits for it'],
  [/(?:^|\.)(catch)$/, 'handles a failure'],
  [/(?:^|\.)(emit|fire|dispatchEvent)$/, 'sends an event'],
  [/(?:^|\.)(dispose|close|destroy)$/, 'cleans up'],
  [/(?:^|\.)(focus)$/, 'moves the focus'],
  [/(?:^|\.)(scrollIntoView|scrollTo)$/, 'scrolls to it'],
  [/(?:^|\.)(querySelector|querySelectorAll|getElementById)$/, 'finds part of the page'],
  [/(?:^|\.)(append|appendChild|prepend|insertBefore)$/, 'adds it to the page'],
  [/(?:^|\.)(remove|removeChild)$/, 'takes it off the page'],
  [/(?:^|\.)(classList\.toggle|classList\.add|classList\.remove|setAttribute)$/, 'changes how it looks'],
];

/** What a call does, as a verb phrase: "this.save(user)" → "saves the user", "fs.writeFileSync(f)" → "writes a file". */
export function callPhrase(code: string): string | undefined {
  const e = parseExpression(code);
  let call: ts.CallExpression | ts.NewExpression | undefined;
  const find = (n: ts.Node): void => {
    if (call) return;
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) call = n;
    else ts.forEachChild(n, find);
  };
  if (e) find(e);
  if (!call) return undefined;
  if (ts.isNewExpression(call)) return `creates a new ${ts.isIdentifier(call.expression) ? words(call.expression.text).join(' ') : 'object'}`;
  const name = calleeName(call);
  if (!name) return undefined;
  const args = call.arguments.map((a) => exprWords(a));
  for (const [pattern, phrase] of KNOWN) if (pattern.test(name)) return typeof phrase === 'string' ? phrase : phrase(args);
  const method = name.split('.').pop()!;
  const phrase = verbPhrase(method, true);
  // "saves the user": the first argument as the object, when the name has none.
  if (words(method).length === 1 && args[0] && !phrase.includes(' the ')) return `${phrase} ${args[0]}`;
  return phrase;
}

/** "for (const p of all)" → "goes through each p in all"; "while (queue.length)" → "repeats while there are queue". */
export function loopPhrase(code: string): string {
  const forOf = /^for\s*\(\s*(?:const|let|var)\s+(?:\[([^\]]+)\]|\{([^}]+)\}|(\w+))\s+(of|in)\s+(.+?)\)\s*$/.exec(code.trim().replace(/\{$/, '').trim());
  if (forOf) {
    const item = forOf[3] ?? (forOf[1] ?? forOf[2] ?? 'item').split(',')[0].trim();
    const things = valueWords(forOf[5]);
    const itemWords = words(item).join(' ');
    return `goes through each ${itemWords.length > 2 ? itemWords : 'one'} in ${things}`;
  }
  const whileLoop = /^while\s*\((.+)\)\s*$/.exec(code.trim());
  if (whileLoop) return `repeats while ${conditionWords(whileLoop[1])}`;
  const foreach = /^foreach\s*\(\s*\w+\s+(\w+)\s+in\s+(.+)\)\s*$/i.exec(code.trim());
  if (foreach) return `goes through each ${words(foreach[1]).join(' ')} in ${valueWords(foreach[2])}`;
  return 'repeats a step';
}

/** "Returns 0" / "stops" / "fails with "empty"": what a return or throw box does. */
export function exitPhrase(code: string, kind: string): string {
  const body = code.trim().replace(/;$/, '');
  if (kind === 'throw') {
    const message = /["'`]([^"'`]{1,60})["'`]/.exec(body)?.[1];
    return message ? `fails with "${message}"` : 'fails with an error';
  }
  const value = body.replace(/^return\b\s*/, '');
  if (!value) return 'stops';
  return `returns ${valueWords(value)}`;
}

/** First letter up. */
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a, b and c". */
export const listWords = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
