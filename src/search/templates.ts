import { PlaceholderConstraint } from './structuralSearch';

/** A saved search: the pattern with its constraints, replacement and inspection message. */
export interface SearchPreset {
  title?: string;
  pattern: string;
  constraints?: PlaceholderConstraint[];
  replacement?: string;
  message?: string;
  /** For saved inspections: only files matching this glob. */
  include?: string;
  /** Where to search; the builder's current choice when absent. */
  scope?: 'project' | 'file' | 'selection' | 'folder' | 'open' | 'changed';
  /** With scope `folder`: the folder's workspace-relative name, shown in the scope list. */
  folderLabel?: string;
}

/** Starting points offered in the builder. */
export const searchTemplates: SearchPreset[] = [
  { title: 'Async callback passed to forEach', pattern: '$list$.forEach(async ($params*$) => { $body*$ })', message: 'forEach does not wait for async callbacks; use for…of with await' },
  { title: 'Deep clone through JSON', pattern: 'JSON.parse(JSON.stringify($value$))', replacement: 'structuredClone($value$)', message: 'Use structuredClone($value$)' },
  { title: 'Loose comparison with null', pattern: '$x$ == null', replacement: '$x$ === null || $x$ === undefined', message: 'Compare with null and undefined explicitly' },
  { title: 'Comparison with true', pattern: '$x$ === true', constraints: [{ name: 'x', type: '^boolean$' }], replacement: '$x$', message: '$x$ is already a boolean' },
  { title: 'Promise used as a condition', pattern: 'if ($p$) { $body*$ }', constraints: [{ name: 'p', type: '^Promise<' }], message: '$p$ is a promise and always truthy' },
  { title: 'Index loop over an array', pattern: 'for (let $i$ = 0; $i$ < $list$.length; $i$++) { $body*$ }', message: 'Consider for…of over $list$' },
  { title: 'Nested ternary', pattern: '$a$ ? $b$ : $c$ ? $d$ : $e$', message: 'Nested conditional expressions are hard to read' },
  { title: 'Object.assign into a new object', pattern: 'Object.assign({}, $a$, $b$)', replacement: '({ ...$a$, ...$b$ })', message: 'Use object spread' },
  { title: 'React effect without dependencies', pattern: 'useEffect($effect$)', message: 'This effect runs after every render; add a dependency array' },
  { title: 'console.log calls', pattern: 'console.log($args*$)', message: 'Remove console.log before committing' },
  { title: 'Double negation', pattern: '!!$x$', replacement: 'Boolean($x$)', message: 'Boolean($x$) says what !! means' },
  { title: 'Math.pow', pattern: 'Math.pow($a$, $b$)', replacement: '$a$ ** $b$', message: 'Use the ** operator' },
  { title: 'Object.keys().forEach', pattern: 'Object.keys($o$).forEach(($k$) => { $body*$ })', replacement: 'for (const $k$ of Object.keys($o$)) { $body*$ }', message: 'A for…of loop can break, continue and await' },
  { title: 'parseInt without a radix', pattern: 'parseInt($s$)', replacement: 'parseInt($s$, 10)', message: 'Pass the radix: parseInt($s$, 10)' },
  { title: 'Array copy with slice(0)', pattern: '$list$.slice(0)', replacement: '[...$list$]', message: 'Copy with spread: [...$list$]' },
  { title: "'indexOf' check instead of 'includes'", pattern: '$list$.indexOf($x$) !== -1', replacement: '$list$.includes($x$)', message: 'Use $list$.includes($x$)' },
];
