# VSExtension: TypeScript Structure

WebStorm-style refactorings and test impact analysis for TypeScript, JavaScript and React in VS Code. Everything is deterministic, offline static analysis using the TypeScript Compiler API and Language Service. No AI and no network access.

All commands are in the Command Palette under **TypeScript Structure**, and in the editor's right-click menu under **TypeScript Structure**.

## Refactorings

### How refactorings are applied

Every refactoring is computed on an in-memory copy of the project, so nothing is written until you confirm:

- **Problems first.** Anything that could make the result wrong is listed before applying: usages that can't be updated automatically, and any type error the change would introduce that wasn't there before.
- **Refactor Preview.** By default changes open in VS Code's Refactor Preview, where you can review and untick individual edits. Set `tsStructure.previewRefactorings` to `false` to apply directly.
- **Stale protection.** If a file changes while a refactoring is being computed, nothing is applied and you're asked to run it again.
- **Undo.** Applied changes are ordinary edits, so a single undo reverts them in each file.

### Change Signature (`Ctrl+F6`)

Place the cursor on a function, method or function-valued variable, at its declaration or any call, and run **Change Signature…** from the lightbulb, the right-click menu or `Ctrl+F6` (`Cmd+F6` on macOS).

The dialog lets you:
- Rename the function and its parameters.
- Add, remove and reorder parameters, with a live preview of the new signature.
- Change parameter types, default values, the optional marker and the return type.
- For each new parameter, give the value inserted at existing call sites.

What gets updated:
- Every call site in the project, including calls nested inside other calls' arguments, multi-line argument lists, method calls and optional chaining.
- Imports and re-exports when the function is renamed, and uses of renamed parameters inside the body.
- Interface declarations, base-class methods and overriding methods of the same member, so calls through an interface stay consistent.
- Rest parameters, which keep collecting the remaining arguments.
- Skipped optional arguments, which become `undefined` when a later argument is added.

Reported as problems instead of guessed at:
- Calls with a spread argument (`fn(...args)`) whose positions would change.
- The function used as a value (passed as a callback, stored, or called through `.call`, `.apply` or `.bind`), and JSX usage.
- A removed parameter that the body still uses.
- A required parameter placed after an optional one.

Overloaded functions and class constructors are not supported yet.

## Test Impact Analysis

### Usage

1. Open a TypeScript or JavaScript file and place the cursor on a symbol.
2. Run **TypeScript Structure: Test Impact Analysis** from the Command Palette or the editor's right-click menu.
3. Choose a scope:
   - **Function or Symbol at Cursor**: tests that depend on the selected symbol.
   - **Active Module**: tests that depend on anything in the current file.
4. A searchable picker lists each affected test, its file and the dependency chain that explains the match. Select one to open its registration. The **Impacted Tests** view in the Testing sidebar keeps the results as a tree, with each step of the chain clickable.

Tests never run automatically. Use the play buttons in the picker or the view, or **Run Impacted Tests**, to run them through Jest, Vitest, Mocha, Playwright or `node --test` with name filtering.

#### Try it

Press F5 to open the `sample` project. In `src/impactSource.ts`, place the cursor on `formatImpactLabel` and choose **Function or Symbol at Cursor**. The two label tests in `impactSource.test.ts` appear, one of them through `displayImpactLabel`, and the unrelated totals test is excluded. **Active Module** includes all three. In `src/discount.ts`, `calculateDiscount` reaches tests through `calculateTotal` and `checkout`.

### How it works

- **Symbol resolution.** The symbol at the cursor is resolved through imports, aliases and re-exports to its declarations. If the cursor is not on a name, the enclosing function, method, class or test is used.
- **Reference index.** Every runtime reference in the project is indexed by the declaration it resolves to. Type-only positions (annotations, interfaces, `implements`) are skipped, while `class X extends Y` counts.
- **Caller tracing.** A breadth-first walk goes from each reference up to the code that contains it, which is a test body, a hook, test-file initialization, or the next declaration whose callers are followed. Visited declarations end cycles, and each test keeps its shortest explanation.
- **Confidence.**
  - *Confirmed* means a resolved chain of references reaches the test body.
  - *Possible* means the chain depends on a conservative assumption: calls through an interface or base class, shared hooks, test-file initialization, or module top-level code.
- **Stale results.** Results record a hash of every file they point into. Navigation is refused, with an offer to re-run the analysis, if a file changed after the analysis ran.
- **Caching.** Parsed files are reused across analyses while their text is unchanged. A project whose files are all unchanged is reused whole, including its reference index. Unsaved editor text is analyzed.

#### Test discovery

- Test files are recognized by `.test.*` or `.spec.*` names, by `test/`, `tests/` or `__tests__/` directories, and by imports of `node:test`, `vitest`, `@jest/globals`, `@playwright/test` or `mocha`.
- Recognized registrations:
  - `test`, `it`, `describe`, `suite`, `context` and Mocha TDD names, including imported aliases (`import { test as check }`) and namespace imports.
  - Modifiers such as `.only`, `.skip`, `.todo` and `.concurrent`, and Playwright's `test.describe` and `base.extend`.
  - `.each(...)` and `.for(...)`. Parameterized registrations are listed once.
- A reference in a shared hook or in test-file initialization conservatively includes every case in that file.
- A test file with no static registrations is listed as a whole-file entry.

## Limitations

- Source and tests must be in the same compiler project. Excluded test projects are not scanned. If the application's `tsconfig` excludes tests, open a test file under a config that includes them and select the imported symbol there.
- Static analysis cannot see dynamic dispatch through untyped values, runtime dependency injection, string-based lookups or module mocks. Mocked modules are still reported as impacts.
- Analysis runs on the extension host thread. Very large projects may pause the editor for the first analysis while the index is built.
- The extension depends on TypeScript 6.0.3, the latest release with the stable JavaScript Compiler API. TypeScript 7 only exposes an unstable API.

## Development

```bash
npm install
npm test                  # compile and run the analyzer tests
VSCODE_EXECUTABLE="/path/to/Code.exe" npm run test:integration   # run inside a real VS Code
```

- `src/analysis/` holds the engine and has no `vscode` dependency.
- `src/extension.ts`, `src/resultsView.ts` and `src/runner.ts` are the VS Code layer.
- `test-fixtures/edge` covers re-exports, interface dispatch, cycles, hooks, `.each`, aliased imports, Jest globals and `node:test`.
