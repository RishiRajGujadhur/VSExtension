/** Where to read more about each design pattern: refactoring.guru for the classic patterns, patterns.dev and react.dev for React, Martin Fowler's catalog for enterprise patterns. */
const guru = (slug: string) => `https://refactoring.guru/design-patterns/${slug}`;
const fowler = (page: string) => `https://martinfowler.com/${page}`;
const react = (page: string) => `https://react.dev/${page}`;
const ts = (page: string) => `https://www.typescriptlang.org/docs/handbook/${page}`;

export const patternLinks: Record<string, string> = {
  // Creating objects
  Singleton: guru('singleton'),
  'Module-level singleton': 'https://www.patterns.dev/vanilla/singleton-pattern',
  Factory: guru('factory-method'),
  'Abstract factory': guru('abstract-factory'),
  Builder: guru('builder'),
  Prototype: guru('prototype'),
  'Object pool': 'https://en.wikipedia.org/wiki/Object_pool_pattern',
  'Lazy initialization': fowler('eaaCatalog/lazyLoad.html'),
  'Dependency injection': fowler('articles/injection.html'),
  'Service locator': 'https://en.wikipedia.org/wiki/Service_locator_pattern',
  // Structure
  Adapter: guru('adapter'),
  Bridge: guru('bridge'),
  Composite: guru('composite'),
  Decorator: guru('decorator'),
  Facade: guru('facade'),
  Flyweight: guru('flyweight'),
  Proxy: guru('proxy'),
  'Barrel module': 'https://basarat.gitbook.io/typescript/main-1/barrel',
  'Module pattern': 'https://www.patterns.dev/vanilla/module-pattern',
  Mixin: 'https://www.patterns.dev/vanilla/mixin-pattern',
  'Value object': fowler('bliki/ValueObject.html'),
  'Null object': fowler('eaaCatalog/specialCase.html'),
  'Fluent interface': fowler('bliki/FluentInterface.html'),
  'Layered architecture': fowler('bliki/PresentationDomainDataLayering.html'),
  // Behavior
  Observer: guru('observer'),
  'Event bus': 'https://en.wikipedia.org/wiki/Publish%E2%80%93subscribe_pattern',
  Strategy: guru('strategy'),
  'Strategy map': guru('strategy'),
  Command: guru('command'),
  State: guru('state'),
  'State machine': 'https://en.wikipedia.org/wiki/Finite-state_machine',
  'Template method': guru('template-method'),
  'Chain of responsibility': guru('chain-of-responsibility'),
  Mediator: guru('mediator'),
  Memento: guru('memento'),
  Visitor: guru('visitor'),
  Iterator: guru('iterator'),
  Specification: fowler('apsupp/spec.pdf'),
  'Plugin registry': fowler('eaaCatalog/plugin.html'),
  Middleware: 'https://expressjs.com/en/guide/using-middleware.html',
  // Data and async
  Repository: fowler('eaaCatalog/repository.html'),
  'Unit of work': fowler('eaaCatalog/unitOfWork.html'),
  'API client': fowler('eaaCatalog/gateway.html'),
  Reducer: react('learn/extracting-state-logic-into-a-reducer'),
  Store: 'https://redux.js.org/tutorials/fundamentals/part-1-overview',
  'Result type': 'https://en.wikipedia.org/wiki/Result_type',
  Memoization: 'https://en.wikipedia.org/wiki/Memoization',
  Pipeline: fowler('articles/collection-pipeline/'),
  'Promise chain': 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises',
  Retry: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/retry',
  'Debounce or throttle': 'https://developer.mozilla.org/en-US/docs/Glossary/Debounce',
  'Circuit breaker': fowler('bliki/CircuitBreaker.html'),
  'Shared module state': 'https://en.wikipedia.org/wiki/Global_variable',
  'Higher-order function': 'https://en.wikipedia.org/wiki/Higher-order_function',
  // TypeScript
  'Discriminated union': ts('2/narrowing.html#discriminated-unions'),
  'Type guard': ts('2/narrowing.html#using-type-predicates'),
  'Assertion function': ts('release-notes/typescript-3-7.html#assertion-functions'),
  'Branded type': ts('2/objects.html#intersection-types'),
  'Constant object as enum': ts('enums.html#objects-vs-enums'),
  'Exhaustive check': ts('2/narrowing.html#exhaustiveness-checking'),
  // React
  'React component with hooks': react('reference/react/hooks'),
  'Custom hook': react('learn/reusing-logic-with-custom-hooks'),
  'Context provider': react('learn/passing-data-deeply-with-context'),
  'Higher-order component': 'https://www.patterns.dev/react/hoc-pattern',
  'Render props': 'https://www.patterns.dev/react/render-props-pattern',
  'Compound components': 'https://www.patterns.dev/react/compound-pattern',
  'Container and presentational components': 'https://www.patterns.dev/react/presentational-container-pattern',
  'Error boundary': react('reference/react/Component#catching-rendering-errors-with-an-error-boundary'),
  'Controlled component': react('reference/react-dom/components/input#controlling-an-input-with-a-state-variable'),
  'Memoized component': react('reference/react/memo'),
  'Lazy-loaded component': react('reference/react/lazy'),
  Portal: react('reference/react-dom/createPortal'),
  'Forwarded ref': react('reference/react/forwardRef'),
  'Polymorphic component': 'https://styled-components.com/docs/api#as-polymorphic-prop',
  'Reducer with context': react('learn/scaling-up-with-reducer-and-context'),
};

/** The page that explains a pattern, if there is one. */
export function patternLink(name: string): string | undefined {
  return patternLinks[name];
}

/** A Markdown "Learn more" line for tooltips. */
export function learnMore(name: string): string {
  const url = patternLink(name);
  return url ? `\n\n[Learn more about ${name}](${url})` : '';
}
