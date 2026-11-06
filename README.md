# TypeScript Structure

Refactorings, inspections and code navigation for TypeScript, JavaScript and React in VS Code, in the style of WebStorm. Everything is offline static analysis with the TypeScript compiler: no AI, no network.

![Analyze or Refactor This: every refactoring and analysis for the cursor in one list, each with its shortcut](docs/images/actions-at-cursor.gif)

## Getting started

1. Open a TypeScript or JavaScript file and put the cursor on a symbol.
2. Right-click: **Find Usages**, **Find Usages in Current File**, **Data Flow** and **Analyze or Refactor This…** are at the top of the menu. Everything else is under **TypeScript Structure**.
3. Results open in the **TypeScript Structure** view in the Activity Bar.

Not sure which analysis answers your question? Run **How Do I…?** (`Ctrl+Alt+S /`) and pick a question such as *Where does this value come from?* The first time the extension starts, a short walkthrough opens; reopen it with **Guide Me** (the **?** in the view).

![The right-click menu with Find Usages, Data Flow and Analyze or Refactor This at the top](docs/images/context-menu.gif)

## Shortcuts

Every analysis has a shortcut: `Ctrl+Alt+S` (`Cmd+Ctrl+S` on macOS), then a letter. **Shortcut Cheat Sheet** (`Ctrl+Alt+S K`) lists them all; change any of them with **Keyboard Shortcuts…**, or the keyboard button next to each entry in **Analyze or Refactor This…**.

| Key | Runs | Key | Runs |
| --- | --- | --- | --- |
| `Space` | Analyze or Refactor This… | `X` | Exception Flow |
| `D` | Data Flow | `A` | Argument Propagation |
| `U` | Find Usages (also `Alt+F7`; in the file `Shift+Alt+F7`) | `H` | Inheritance Hierarchy |
| `N` | Nullability | `O` | Override Impact |
| `E` | Side Effects | `C` | Re-export Chain |
| `M` | Mutation Tracking | `P` | Dependency Path |
| `R` | Promise Rejections | `G` | Dependency Graph Diff |
| `Y` | Design Patterns | `S` | Structural Search |
| `I` | Inspect Code | `F` | Duplicates |
| `T` | Test Impact | `Z` | Dead Exports |
| `V` | Show the results view | `L` | Re-run the last analysis |
| `K` | Shortcut Cheat Sheet | `/` | How Do I…? |

Refactorings: **Change Signature** `Ctrl+F6`, **Safe Delete** `Alt+Delete`, **Introduce Parameter** `Ctrl+Alt+P`.

![The shortcut cheat sheet](docs/images/shortcuts.gif)

## Understand code

### Data Flow Path Explorer

Where a variable, parameter or property comes from, every place it changes, and where it goes. **Design patterns** names the patterns the value passes through, such as a Strategy, Factory or Observer, recognized from the shape of the code; the **?** on a pattern says what it means. Click **Trace This Value** on a row to follow the value into a called function.

![Data flow of payment in placeOrder: the values callers pass, where it goes, and the Strategy pattern of the payment classes](docs/images/data-flow.gif)

### Detect Design Patterns

The design patterns and architecture of a file, folder or the whole project: Singleton, Factory, Builder, Observer, Strategy, Command, Repository, Reducer, Memoization, Pipeline, Dependency injection, shared module state, higher-order functions, React components with hooks, and layered folders.

![Design patterns in the demo project](docs/images/design-patterns.gif)

### Semantic Find Usages

References grouped by what they do: definitions, calls, writes, reads, type references, imports and exports, per file, with test files marked. **Find Usages in Current File** shows only the usages in the file you are in.

![Usages of calculateSubtotal grouped by kind](docs/images/semantic-usages.gif)

### Nullability, side effects, mutations, errors and arguments

| Analysis | Put the cursor on | Shows |
| --- | --- | --- |
| **Nullability Path Explorer** | a variable or call | whether it can be null or undefined there, every path that makes it so, and the uses that need a guard |
| **Side-Effect Analyzer** | a function | what it changes besides its result: arguments, shared state, I/O, timers, randomness |
| **Mutation Tracking** | anywhere in a file | functions that change state they don't own, and who changes each piece of state. The first row explains what a mutation is |
| **Promise Rejection Analyzer** | an async function | where its rejections are caught, handled or lost |
| **Exception Flow Visualizer** | a function | what it can throw, and what each `catch` does with it |
| **Argument Propagation** | a parameter | every value that can arrive, and where it goes |

The **ⓘ** button in the results view explains the analysis on screen and the terms it uses.

![Nullability of coupon](docs/images/nullability.gif)
![Mutations in cart.ts, starting with what a mutation is](docs/images/mutation-tracking.gif)
![Side effects of addToCart with CodeLenses](docs/images/side-effects.gif)

### Types, modules and tests

- **Inheritance Hierarchy** and **Override Impact**: supertypes, subtypes and overrides, and what a change to a member reaches.
- **Re-export Chain**: follow a name through barrel files to its declaration.
- **Dependency Path Finder**: why one module imports another. **Dependency Graph Diff**: how imports changed since a Git revision, including new cycles.
- **Test Impact Analysis**: the tests that depend on a symbol or file, to run only those. The status bar shows how many.

![Tests impacted by calculateSubtotal](docs/images/test-impact.gif)
![Dependency changes since HEAD with a new import cycle](docs/images/graph-diff.gif)

## Refactor

- **Change Signature** (`Ctrl+F6`): rename, add, remove and reorder parameters, updating every call. Problems are flagged as you type; `Ctrl+Enter` previews.
- **Safe Delete** (`Alt+Delete`): deletes after checking every usage, or lists what still uses it.
- **Introduce Parameter** (`Ctrl+Alt+P`): turns the selected expression into a parameter.
- **Move Members to Module**: moves declarations to another file and fixes imports.
- **Intention actions** in the lightbulb (`Ctrl+.`): 19 rewrites, such as flipping an `if` or converting to a template string.

Changes open in VS Code's Refactor Preview first (`tsStructure.previewRefactorings`); `Ctrl+Z` undoes them.

![The Change Signature dialog](docs/images/change-signature.gif)

## Find problems

- **Live inspections** report missing `await`s and risky type assertions in the Problems panel, with quick fixes. Click the status bar count for the file's problems and a menu.
- **Inspect Code…** runs every inspection over a scope you choose; **Apply All Fixes** fixes a whole group.
- **Dead Exports**, **Structural Duplicates** and **Audit Type Assertions** clean up a project or folder.
- **Structural Search and Replace** finds code by shape with `$placeholders$`, and can save a pattern as your own inspection.

![A missing await underlined, explained and listed](docs/images/missing-await.gif)
![Dead exports with Safe Delete and Mark as Public API](docs/images/dead-exports.gif)
![Structural search for $list$.find($callback$)](docs/images/structural-search.gif)

Analyses over many files ask where to look: the whole project, a folder, the open editors, the changed files, the current file, function or selection. In the Explorer, right-click folders to analyze only those.

## Working with results

- **Back and forward** through earlier reports, **re-run** (`F5`, or `Ctrl+Alt+S L` from anywhere; the button turns into a warning when files changed).
- **Filter** rows (`Ctrl+F`; `file:cart` keeps rows in matching files), **Limit Results to Scope…**, **Show Groups…**; `Escape` shows every row again.
- `F4` / `Shift+F4` walk through the results; the selected row follows your cursor.
- `Ctrl+C` copies rows; right-click a row for **Find Usages Here**, **Data Flow Here** and more.
- Copy or export a report as Markdown or JSON, or **Copy All Locations**.

![Usages limited to cart.ts](docs/images/limit-results.gif)

## Settings

Run **TypeScript Structure: Open Settings**. The ones you are most likely to change:

| Setting | Default | |
| --- | --- | --- |
| `tsStructure.features.<name>` | core features on | turn features on or off, also with **Choose Features…** |
| `tsStructure.include` / `exclude` | | files left out of analysis; right-click **Exclude from Analysis** in the Explorer |
| `tsStructure.askForScope` | `true` | ask where to look before project-wide analyses |
| `tsStructure.contextMenu.topLevel` | `true` | the common analyses at the top of the right-click menu |
| `tsStructure.results.progress` | `statusBar` | or `notification` |
| `tsStructure.lightbulbAnalyses` | `true` | analyses in the lightbulb's refactor menu |

![Choose Features](docs/images/choose-features.gif)

## Development

```bash
npm install
npm test                  # compile and run the unit tests
VSCODE_EXECUTABLE="/path/to/Code.exe" npm run test:integration   # run inside a real VS Code
VSCODE_EXECUTABLE="/path/to/Code.exe" npm run screenshots        # record the docs/images GIFs from docs/demo
```

The analysis engine (`src/analysis`, `src/refactor`, `src/intentions`, `src/inspect`, `src/navigate`, `src/search`, `src/structure`) has no `vscode` dependency and is unit-tested directly; `src/ui` is the VS Code layer.
