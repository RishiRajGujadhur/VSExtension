import { PlaceholderConstraint } from './structuralSearch';

/** A saved search: the pattern with its constraints, replacement and inspection message. */
export interface SearchPreset {
  title?: string;
  pattern: string;
  constraints?: PlaceholderConstraint[];
  replacement?: string;
  message?: string;
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
];
