/** What each report shows and the terms it uses, for the results view's info button. */
export interface Explanation {
  title: string;
  /** A few sentences in plain words. */
  text: string;
  /** The README section with the full guide. */
  anchor: string;
}

export const explanations: Record<string, Explanation> = {
  mutations: {
    title: 'What is a mutation?',
    text:
      'A mutation changes state that outlives the function call: a module variable, an imported object, a global, a field of this, or an object passed in as an argument. ' +
      'Reassigning a local variable is not a mutation. Mutations make code harder to reason about because a call can change what other code sees later. ' +
      'This report lists the functions that mutate state, and, turned around, each piece of shared state with every function that writes it.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  variableMutations: {
    title: 'Mutation Tracking for one variable',
    text:
      'Every function in the project that assigns or changes this variable, in source order. Async functions, callbacks such as setTimeout or event handlers, and changes made after an await are marked, ' +
      'because those can run interleaved with other code. The first row says how widely the variable is shared: module-level and object properties are shared by every caller, a local variable is not.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  explainValue: {
    title: 'How is a value path found?',
    text:
      'Code X-Ray follows every path through the function to the cursor, taking each loop zero or one times, and finds the last assignment of the variable on each. ' +
      'Paths that give the same value are grouped, with the branch conditions each one takes. A path that tests the same unchanged condition both ways cannot happen and is listed apart. ' +
      'Conditions inside expressions (&&, ||, ?:) and changes made by called functions are not followed.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  races: {
    title: 'What is a race condition?',
    text:
      'JavaScript runs one thing at a time, but an await pauses a function and lets other code run before it continues. ' +
      'If a function reads or checks shared state, awaits, and then writes it, another call can change the state during the wait and that change is lost (a lost update), ' +
      'or two calls can both pass the check before either acts (check, then act). Fix it by reading after the await, by keeping one pending promise (for caches), or by queuing the work.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  dataFlow: {
    title: 'Data Flow',
    text: 'Every place the value is defined, changed, checked, passed on and read, grouped by function. Flows in shows what it is computed from, Flows out where it goes, and Design patterns how the code around it is organized.',
    anchor: 'data-flow',
  },
  patterns: {
    title: 'What is a design pattern?',
    text: 'A well-known way of organizing code, such as a Factory that creates objects in one place, an Observer that notifies listeners, or a Strategy of interchangeable classes. They are recognized from the shape of the code, never from names alone; hover a pattern to read what it means.',
    anchor: 'pattern-spotting',
  },
  callGraph: {
    title: 'Call Graph',
    text: 'Who calls a function and what it calls, a few levels each way: callers on the left (their callers further out), callees on the right. Calls are resolved with the type checker, so methods, imported functions and functions passed through variables are followed; calls into libraries are counted. A call made inside a callback, such as setTimeout(() => f()), belongs to the function that set the callback up.',
    anchor: 'callers-and-calls',
  },
  reactState: {
    title: 'React State Graph',
    text: 'The props and context a component or hook receives, and its state, refs, memoized values, callbacks, custom hooks and effects: where each is set, read and rendered, which effects and memos it triggers as a dependency, when each effect runs and what it sets, and values an effect reads but does not list as a dependency.',
    anchor: 'react-state',
  },
  sideEffects: {
    title: 'What is a side effect?',
    text: 'Anything a function does besides returning a value: changing state it does not own, input/output (console, network, storage, files), scheduling timers, or reading the clock or random numbers. A function without any is pure.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  nullability: {
    title: 'Nullability',
    text: 'Whether the value can be null or undefined at the cursor, every path that produces null or undefined, the checks that rule it out, and which uses still need a guard.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  rejections: {
    title: 'What is a promise rejection?',
    text: 'A promise rejects when the async code throws or awaits something that rejects. The rejection travels to whoever awaits or catches the promise; if nobody does, it is unhandled and can crash Node or be silently lost in browsers.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  exceptions: {
    title: 'Exception Flow',
    text: 'The errors a function can throw, directly or through the functions it calls, what each catch block does with them, and which callers they escape to.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  deadExports: {
    title: 'What is a dead export?',
    text: 'An export that nothing reachable from the entry points (package.json, index files, tests) imports. It can be deleted, or made local when only its own module uses it. Mark public API with @public to keep it.',
    anchor: 'find-problems',
  },
  duplicates: {
    title: 'What is a structural duplicate?',
    text: 'Runs of statements with the same structure, even when variables are renamed or literal values differ. The differences between copies are the parameters a shared function would need.',
    anchor: 'find-problems',
  },
  usages: {
    title: 'Semantic Find Usages',
    text: 'Every reference to the symbol, grouped by what it does there: definitions, calls, writes, reads, type references, imports and exports. Usages through aliases and re-exports count.',
    anchor: 'find-usages',
  },
  reexports: {
    title: 'What is a re-export chain?',
    text: 'The path a name takes from an import through barrel files (export … from) to its declaration, every module that exports it, and which paths importers use.',
    anchor: 'types-modules-and-tests',
  },
  structuralSearch: {
    title: 'Structural Search',
    text: 'Matches of a code pattern with $placeholders$, compared by syntax tree rather than text, so formatting and names do not matter.',
    anchor: 'find-problems',
  },
  hierarchy: {
    title: 'Inheritance Hierarchy',
    text: 'What the type extends and implements, every subtype below it, and for each member which subtypes override it and whether they call super.',
    anchor: 'types-modules-and-tests',
  },
  overrideImpact: {
    title: 'Override Impact',
    text: 'What a change to a base member reaches: overrides that call super are affected, overrides that replace it are not, subtypes that inherit it are, and call sites through the base type may run any implementation.',
    anchor: 'types-modules-and-tests',
  },
  dependencyPath: {
    title: 'Dependency Path',
    text: 'Why one module depends on another: the shortest chains of imports between them, with what each import brings in. Type-only imports are erased at runtime.',
    anchor: 'types-modules-and-tests',
  },
  cycles: {
    title: 'What is an import cycle?',
    text: 'Modules that import each other, directly or through others. At run time one of them sees the other half-loaded, which causes undefined imports and order-dependent bugs. Type-only imports are erased and do not count.',
    anchor: 'types-modules-and-tests',
  },
  dependents: {
    title: 'Who imports this file',
    text: 'Every module that imports the file, directly or through other modules, nearest first. These are the files a change to it can affect, and where to look for broken imports after a move or rename.',
    anchor: 'types-modules-and-tests',
  },
  valueTimeline: {
    title: 'Value timeline',
    text: 'Every change to the variable, in the order the code makes them: how it starts, what each pass of a loop does to it and after which check, what one pass hands to the next, and how a counter steps from pass to pass. It reads the code, so it shows each change once with its condition rather than running the loop.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  asyncTimeline: {
    title: 'Async timeline',
    text: 'What an async function does over time, in order: each await (where it stops until a promise settles), calls started together with Promise.all, awaits inside loops that run one after another, promises started early and waited for later, and promises nobody waits for, whose errors are lost.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  bundleWeight: {
    title: 'Bundle weight',
    text: 'What the file pulls in when it runs: its imports followed through the project, each module weighed by its source size. Each import line of the file says how much it brings in and how much only it brings in, which is what cutting that line would save. Type-only imports cost nothing, import() loads later, and packages show the size of the file they load first; a bundler can make the real numbers smaller.',
    anchor: 'types-modules-and-tests',
  },
  graphDiff: {
    title: 'Dependency Graph Diff',
    text: 'How the import graph changed since a Git revision: new and removed import cycles, added, removed and changed imports, and modules whose number of importers changed most.',
    anchor: 'types-modules-and-tests',
  },
  argumentFlow: {
    title: 'Argument Propagation',
    text: 'Where a parameter’s values come from, walking back through every caller to literals and omitted arguments, and where the value goes, walking forward into the functions it is passed to.',
    anchor: 'null-checks-side-effects-changes-errors-and-arguments',
  },
  inspectCode: {
    title: 'Inspect Code',
    text: 'Every inspection run over the files you chose, grouped by inspection and file. Fixable rows have Apply Fix; groups have Apply All Fixes.',
    anchor: 'find-problems',
  },
  assertionAudit: {
    title: 'What is a type assertion?',
    text: 'An `as`, `<T>` or `!` that tells TypeScript to trust you about a type. Unsafe and unchecked ones hide bugs the compiler would catch; unnecessary ones can simply be removed.',
    anchor: 'find-problems',
  },
};

export const guideUrl = 'https://github.com/RishiRajGujadhur/VSExtension#';
