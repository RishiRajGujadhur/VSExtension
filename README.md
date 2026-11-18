# Code X-Ray

See inside your TypeScript, JavaScript and React code. Put the cursor on something and ask where a value comes from, what a function can do, or what breaks if you change it.

Every answer comes from the TypeScript compiler on your machine. It works offline, uses no AI, and nothing leaves your computer.

## Every action at the cursor

![The Analyze or refactor this list, with every analysis and refactoring for the symbol at the cursor](docs/images/actions-at-cursor.gif)

- Put the cursor on a symbol and press `Ctrl+Alt+Shift+T`, or right-click and choose **Analyze or refactor this…**.
- The **Code X-Ray** view in the Activity Bar lists every action with a search box. Pin the ones you use most.
- Press `Ctrl+Alt+S`, then a letter, to run one directly (`D` data flow, `U` usages, `1` flowchart). `Ctrl+Alt+S K` shows them all.
- Not sure which one you need? Run **Ask the rubber duck…** and pick a question.

## Data flow

![Data flow for a parameter: where its values come from and where they go](docs/images/data-flow.gif)

- Put the cursor on a variable or parameter and press `Ctrl+Alt+S D`.
- See every value that flows in, where it goes next, and the functions it reaches.
- Click a row to jump to that line. Open the chart to see the same flow as a diagram.

## Flowchart

![The flowchart of a function, with its paths listed beside it](docs/images/flowchart.gif)

- Put the cursor in a function and press `Ctrl+Alt+S 1`.
- Every decision, loop and return becomes a box. The **Paths** list shows each route through the function.
- Click a path to light it up, Shift+click another to compare them, or click a branch label to keep only the paths through it.
- Save the chart as Mermaid, SVG or PNG.

## Find usages

![Find usages, grouped into definitions, calls, imports and exports](docs/images/semantic-usages.gif)

- Turn on **Find usages** in Settings first (it is off on a new install).
- Press `Alt+F7` on a symbol.
- Usages are grouped by kind (definitions, calls, reads, writes, imports), with tests marked.
- Filter the list, or narrow it to the current file.

## Change parameters

![The Change parameters panel, with the resulting signature](docs/images/change-signature.gif)

- Turn on **Refactorings** in Settings first (it is off on a new install).
- Press `Ctrl+F6` on a function or method.
- Rename it, add, remove or reorder parameters, and change types and defaults.
- The new signature updates as you type. **Preview changes** shows every call that will be updated before you apply it.

## Affected tests

![The tests that cover calculateSubtotal, with the dependency chain to each one](docs/images/test-impact.gif)

- Put the cursor on a function and press `Ctrl+Alt+S T`.
- See every test that reaches this code, and the chain of calls that connects them.
- Run a test from the list, or run **Tests for my changes** before you commit.

## C#

- **Flowchart** (`Ctrl+Alt+S 1`) and **What depends on what** chart any C# method, constructor, property accessor or lambda, with every path listed and impossible ones flagged.
- **Inspections** underline C# slips as you type: empty `catch`, `throw ex`, `async void`, assigning or comparing a value with itself, identical `if`/`else` branches and more.
- These two need nothing else installed: a C# parser ships with Code X-Ray.
- **Find usages**, **Callers and calls** and **Family tree** use the C# language server, so install the **C# extension** (or C# Dev Kit) and let it load the solution first.
- The other features are TypeScript and JavaScript only for now.

## Settings

- Run **Code X-Ray: Settings**, or press the gear in the Actions view's title bar.
- **Features**: switch each part of Code X-Ray on or off. A new install starts with Affected tests and Data flow; **Turn all on** switches on the rest (find usages, refactorings, quick rewrites, inspections, React state and more). With every edit feature off, the Edit tab of the Actions view is hidden.
- **Animations**: turn on the button effects in the Actions view (off by default), or turn off the charts' moving grid and flowing lines.
- Every other setting is there too, grouped and searchable (`Ctrl+F`), with a reset button on anything you changed.

## More

Most of these start off on a new install; switch them on in **Settings › Features**.

- Inspections that underline missing `await`s, unused exports, copied code and more (`Ctrl+Alt+S I`).
- Null checks, side effects, error paths, callers and calls, import loops and bundle weight.
- 70 quick rewrites, **Move to another file**, **Delete safely** and **Search by shape** (`Ctrl+Alt+S S`).
- Works with a keyboard, screen readers and high contrast themes.

All settings are on the **Code X-Ray: Settings** page, and under **Code X-Ray** in VS Code's settings (`tsStructure.*`).

The full guide to every feature is in [docs/GUIDE.md](docs/GUIDE.md).

## Credits

The button animations in the Actions view (Blinky, Glitch, Trail, Stroke-n-fill, Shuffle, Crash-n-blink, Slide-n-blink, Color flash and Build on) are recreated from [the motion language Jerry Liu shared](https://x.com/SloppyJ44/status/1846584501847142705) (@SloppyJ44), and named after his labels. They are written from scratch in CSS for Code X-Ray, after watching his animation; no code, frames or images are taken from it. The animation and its design remain his work.

Other credits (the animated chart grid, the Welcome page) are in the [guide](docs/GUIDE.md#credits), with licence notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
