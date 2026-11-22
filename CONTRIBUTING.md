# Contributing to Code X-Ray

Thanks for helping. This guide is for developers. It covers how to set up the repository, how the code is organised, which technologies it uses, how to test your change, and how to send it in. The user guide is [docs/GUIDE.md](docs/GUIDE.md); the product overview is the [README](README.md). How code is put into words (the rules, the thresholds, and where the optional models help) is in [docs/HOW_EXPLAINING_WORKS.md](docs/HOW_EXPLAINING_WORKS.md).

## Contents

- [Principles](#principles)
- [Getting set up](#getting-set-up)
- [Technology](#technology)
- [Architecture](#architecture)
- [Folder structure](#folder-structure)
- [Common tasks](#common-tasks)
- [Testing](#testing)
- [Code style](#code-style)
- [Sending a change](#sending-a-change)
- [Releasing](#releasing-maintainers)

## Principles

Every change must keep these true:

1. **Local and private.** Analyses run on the user's computer from the code alone. The extension makes no network request of its own. The one exception is downloading an optional model the user agreed to. All downloads go through `src/reel/pinnedDownload.ts`, which is the only module allowed to use the network; `src/test/privacy.test.ts` fails if anything the extension ships calls the network (`http`, `https`, `net`, WebSockets, beacons) outside it.
2. **Exact, not guessed.** Answers come from the TypeScript compiler's syntax trees and type checker, and from the bundled C# and T-SQL parsers. The optional code model only adds labels and search by meaning on top of exact results. Nothing depends on it.
3. **Tell people how their data is used before it happens.** Any download is confirmed first in a dialog whose text comes from `downloadPrivacy()` in `src/reel/downloadPrivacy.ts`. It says what is sent, what never is, how the host may use the request, where files go, what the model reads and keeps, and how to remove it. If you change what is sent or kept, change that text in the same commit.
4. **Plain words.** The UI says what code does ("Where values come from"), not jargon. Error messages say what happened and what to do, with no em dashes.
5. **Stable IDs.** Command and setting IDs (`tsStructure.*`, `tsImpact.*`) never change, even when a feature is renamed. Deprecate an old setting with `deprecationMessage`; don't delete it.
6. **Fast at any size.** Big charts are virtualised and drop detail when zoomed out. Analyses reuse the cached programs in `ProjectService`. Nothing heavy runs on the UI thread of a webview.

## Getting set up

You need:

- **Node.js** 20 or newer (the bundle targets Node 20; development uses Node 24).
- **VS Code** 1.90 or newer.
- **Git**.

Then:

```
git clone https://github.com/RishiRajGujadhur/VSExtension.git
cd VSExtension
npm install
npm run compile
node scripts/bundle.js
```

**Run it:** open the folder in VS Code and press `F5`. **Run Extension (sample project)** (in `.vscode/launch.json`) compiles the code and opens a new VS Code window on `sample/` with the extension loaded. Edit, run **Developer: Reload Window** in that window, and try again. `npm run watch` keeps `out/` compiled as you type. VS Code loads `dist/extension.js`, so run `node scripts/bundle.js` after changes, or before you reload.

**Optional test copies of the models.** These are only needed for the tests that use them; the others skip without them.

- **Voice model:** `node scripts/fetch-kitten.js` puts a pinned, hash-checked copy of Kitten TTS Nano into `assets/kitten/`.
- **Code model:** put `model_quantized.onnx` and `vocab.txt` from [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (the revision pinned in `CODE_MODEL`, `src/reel/codeModelText.ts`) into `assets/code-model/`. You can also turn the model on once in the running extension and copy its two files from the extension's global storage.

Both `assets/` folders are git-ignored and never packaged.

## Technology

| What | Used for |
|---|---|
| **TypeScript 6.0.3**, strict mode, CommonJS, ES2022 | All extension code (`src/`). The compiler is also the analysis engine: syntax trees, the type checker and the language service. It is the extension's one runtime dependency, pinned exactly. |
| **VS Code extension API** (`@types/vscode` 1.90) | Commands, tree views (Actions, Analysis results, Affected tests), webview panels and views, CodeLens, diagnostics, code actions, the testing API. |
| **Plain JavaScript, HTML and CSS** in webviews | Every page and chart (`media/*.js`, `media/*.css`): no framework, so pages load at once. Charts are SVG; the Git reel and explain videos are drawn on a canvas and recorded with `MediaRecorder` (WebM, and MP4 where the engine supports it). |
| **@vscode/codicons** | Icons in pages and charts, the same icons VS Code uses. |
| **esbuild** | Bundles about 170 modules into one `dist/extension.js` (`scripts/bundle.js`). `typescript` and `vscode` stay external. |
| **web-tree-sitter** and **tree-sitter-c-sharp** | The C# parser, as WebAssembly, copied to `dist/parsers/`. |
| A hand-written lexer and parser | T-SQL (`src/tsql/`). |
| **onnxruntime-web** (WebAssembly) | Runs the optional models in worker threads: Kitten TTS for the voice-over, all-MiniLM-L6-v2 for code embeddings. |
| **phonemizer.js** (eSpeak NG) | Turns captions into phonemes for the voice-over. It runs as a separate program because eSpeak NG is GPL-3.0. |
| **node:test** | Unit tests. There is no other test framework. |
| **@vscode/vsce** | Packaging and publishing. |

## Architecture

```
                          VS Code
   ┌───────────────────────────────────────────────────────────┐
   │  Commands · Actions view · Results views · Webview panels  │
   └──────────────┬──────────────────────────────┬─────────────┘
                  │ src/ui/*                     │ postMessage
   ┌──────────────▼───────────────┐    ┌─────────▼─────────────┐
   │ Analyses (pure functions)    │    │ media/*.js (webviews) │
   │ program, file, offset ─▶     │    │ charts, flowchart,    │
   │ Report                       │    │ player, settings      │
   │ src/inspect, navigate,       │    └───────────────────────┘
   │ refactor, search, csharp,    │
   │ tsql, explain, reel          │
   └──────────────┬───────────────┘
                  │
   ┌──────────────▼────────────────────────────┐   ┌───────────────────────────┐
   │ src/analysis/ProjectService               │   │ Optional models (workers) │
   │ cached TypeScript programs per tsconfig   │   │ kitten*, codeModel*       │
   └───────────────────────────────────────────┘   │ downloads only via        │
                                                   │ pinnedDownload.ts         │
                                                   └───────────────────────────┘
```

### Startup

`src/boot.ts` is the entry point (`package.json` `main` is the bundle built from it). It opens the sidebar pages at once, then lazy-loads `src/extension.ts`. That builds the services and views and registers every command. Startup stays quick because TypeScript loads after the first paint.

### The Report model

Almost every analysis is a **pure function**: `(program, fileName, offset)` in, a `Report` out (`src/structure/report.ts`).

- A `Report` has a `kind`, a `title`, `roots: ReportNode[]`, `warnings`, and the content hashes of the files it points into, so stale rows can't send you to the wrong line.
- A `ReportNode` is a row: label, description, icon, tone, location, children, and an optional `role` (read, write or definition) that drives editor highlights.
- `ReportBuilder` collects locations while a report is built.

Because a report is plain data, the same analysis can show up in different places without its own UI code:

- the Analysis results tree (`src/ui/structureView.ts`)
- a chart (`src/ui/diagramView.ts` turns the report into a `Diagram` laid out by `src/structure/diagram.ts`)
- Markdown, a hover card, or a test assertion

### Programs and caching

`ProjectService` (`src/analysis/project.ts`) finds the tsconfig or jsconfig for a file, builds its TypeScript program and caches it. Parsed files are reused while their text is unchanged, and a program whose files are all unchanged is reused whole, with its reference index. Analyses that only need one file use `standaloneProgram(fileName, text)` (`src/inspect/controlFlowChart.ts`): a program over that file alone, with no library or project. Explain this code and the flowchart of an older version use it.

### Webviews

Each panel (`src/ui/*View.ts`, `*Panel.ts`) builds its page with `webviewPage()` (`src/ui/webviewPage.ts`), which sets a strict content security policy with nonces. The page script in `media/` talks to the extension only through `postMessage`, with typed message objects such as `{ type: 'meaning', ... }`.

- `media/chartKit.js` holds what every chart shares: viewport, panning and zoom, minimap, the map and zoom dock, icons, menus and the animated grid.
- `media/diagram.js` draws analysis charts.
- `media/controlFlow.js` draws flowcharts.
- `media/reel.js` is the video player and recorder.

### Videos

A `ReelPlan` (`src/reel/plan.ts`) is data: a list of scenes (overview, diff, flow, files, summary), each with its caption and length.

- The **Git reel** builds its plan from `git diff`, using `keyChange.ts`, `intent.ts`, `describe.ts` and `words.ts`.
- **Explain this code** builds its plan from `src/explain/explainReel.ts`.

`ReelPanel` (`src/reel/reelPanel.ts`) sends the plan to `media/reel.js`, which draws, narrates and records it.

### Optional models

Both models run in worker threads on onnxruntime-web:

- **Voice-over:** `kitten.ts`, `kittenWorker.ts` and `voiceModels.ts`. Spoken clips are cached in global storage.
- **Code model:** `codeModel.ts` and `codeModelWorker.ts`.

Neither model ships with the extension. `ReelPanel.confirmDownload` shows the `downloadPrivacy()` notice, then `pinnedDownload.ts` fetches each file, pinned to a commit and checked against its hash, from Hugging Face's hosts only. `src/ui/chartMeaning.ts` connects the code model to every chart (the wand button), and `src/structure/flowPurpose.ts` turns embeddings into purpose tags and search by meaning.

### Features and the Actions view

- `src/structure/features.ts` groups commands into features that users switch on or off. A switched-off command is hidden from menus and refused.
- `src/structure/actionCatalog.ts` lists every entry of the Actions view: label, one-line detail, tab, category and search keywords.
- `src/structure/explanations.ts` holds the longer "what this tells you" text.

## Folder structure

```
.
├── src/
│   ├── boot.ts               entry point: sidebar pages first, then extension.ts
│   ├── extension.ts          activate(): services, views, every command
│   ├── resultsView.ts        the Affected tests results tree
│   ├── analysis/             ProjectService, reference index, test discovery and runs, Affected tests
│   ├── inspect/              analyses that return a Report: data flow, flowcharts, effects, nullability,
│   │                         exceptions, rejections, races, dead exports, duplicates, patterns, React state,
│   │                         timelines; live inspections (registry.ts)
│   ├── navigate/             usages, call graph, hierarchy, module graph and diff, re-exports, bundle weight
│   ├── refactor/             change signature, safe delete, move, introduce parameter (edits via a virtual project)
│   ├── intentions/           quick rewrites (the light bulb)
│   ├── search/               search by shape, custom inspections, templates
│   ├── csharp/               C# parser (tree-sitter), flowcharts, charts, inspections, language-server bridge
│   ├── tsql/                 T-SQL lexer and parser, flowcharts, inspections, navigation
│   ├── explain/              Explain this code: the explanation, facts (takes, gives back, changes), page, video
│   ├── reel/                 Git reel, the voice-over, the code model, pinned downloads, the privacy notice
│   ├── structure/            shared model and words: Report, Diagram and layout, features, action catalog,
│   │                         explanations, glossary, icons, credits, purpose tags
│   ├── ui/                   every VS Code surface: views, panels, commands, CodeLens, diagnostics, code actions
│   └── test/                 unit tests (*.test.ts), integration/ (runs in VS Code), screenshots/ (GIF recorder)
├── media/                    webview scripts and styles, icons, walkthrough pictures, eSpeak licence and notice
├── scripts/                  bundle.js, integration.js, screenshots.js, fetch-kitten.js, icon.js
├── test-fixtures/            small projects the unit tests analyse; helpers to block the network and find test models
├── sample/                   the project the F5 launch and the integration tests open
├── docs/
│   ├── GUIDE.md              the user guide, every feature in full (shipped with the extension)
│   ├── images/               README and guide GIFs, recorded by npm run screenshots
│   └── demo/                 the bookshop project the recordings use (TypeScript and C#)
├── .claude/skills/           a map of the code for Claude Code (not shipped)
├── package.json              manifest: commands, menus, keybindings, views, settings, walkthrough
├── THIRD_PARTY_NOTICES.md    licences of bundled code
└── .vscodeignore             what is left out of the .vsix
```

Generated and ignored folders:

- `out/`: compiled by `tsc`, used by the tests.
- `dist/`: the bundle, parsers and voice engine; this is what ships.
- `assets/`: test copies of the models.
- `node_modules/`.

## Common tasks

### Add an analysis

1. Write it as a pure function in `src/inspect/` (or `navigate/`), taking `(program, fileName, offset)` and returning a `Report` built with `ReportBuilder`.
2. Add a unit test in `src/test/` that runs it on a fixture under `test-fixtures/`, or on inline code.
3. Register the command in `src/ui/analysisCommands.ts`.
4. In `package.json`, add it to `contributes.commands`, plus menus and a keybinding if wanted. Keep the `tsStructure.` prefix.
5. Add it to a feature in `src/structure/features.ts`, and to the Actions view in `src/structure/actionCatalog.ts`. Set `graph: true` if it should be offered as a chart.
6. Explain it in `src/structure/explanations.ts` and `docs/GUIDE.md`. If it's a headline feature, add it to the README.

### Add a chart feature

Data goes from the extension to the page as a message, and user actions come back as messages. Handle the new message in `src/ui/diagramView.ts` or `controlFlowView.ts` and in `media/diagram.js` or `controlFlow.js`. Put code that both charts need in `media/chartKit.js`.

Check it at a small and a large size:

- Fitted charts must not sit under the zoom dock.
- Charts of up to 150 boxes keep their text at every zoom.

### Add or change a setting

1. Add it under `contributes.configuration` in `package.json`, with a `markdownDescription` in plain words.
2. Give it a category so it lands in the right group of the Settings page (`src/ui/settingsPanel.ts`).
3. Read it with `vscode.workspace.getConfiguration('tsStructure')`.

### Anything that downloads

Don't add new network code. Use `downloadPinned()` with a pinned revision and a hash for each file, confirm through `ReelPanel.confirmDownload` with a `downloadPrivacy()` text, add the model to `src/structure/credits.ts` and the README's privacy table, and extend the privacy tests.

## Testing

Run all three before you send a change.

| Command | What it runs | Time |
|---|---|---|
| `npm test` | Compiles, then about 720 unit tests with `node --test` over `out/test/**/*.test.js`. Pure analyses and text, no VS Code. | about 1 min |
| `VSCODE_EXECUTABLE=/path/to/Code npm run test:integration` | `src/test/integration/` inside a real VS Code on `sample/`: commands, views, charts, Explain, Git reel, exports. Point it at any VS Code build (a portable one is easiest). | a few min |
| `npm run screenshots -- <scene>` (same `VSCODE_EXECUTABLE`) | Re-records `docs/images/<scene>.gif` from `src/test/screenshots/scenes.ts` over `docs/demo`. With no scene names it records every scene. | 1 to 10 min |

Tips:

- **Unit tests** go beside their area: `src/test/<topic>.test.ts`. Prefer inline code or a small fixture over a big project. Tests that need a model `skip` with a reason when it isn't there.
- **Integration test helpers:** `src/test/integration/index.ts` has small helpers such as `tabLabelled`, which waits for a tab. Test-only commands (for example `tsStructure.diagram.meaningInfo`) expose state to tests. They are registered in `extension.ts` and left out of the command palette.
- **Offline checks:** `test-fixtures/block-network.cjs` blocks every network route, and the voice-over test runs under it.
- **Test the package itself:** run `npx vsce package`, unzip the `.vsix`, and run the integration tests with `EXTENSION_PATH=<unzipped>/extension`. That run is how you catch files missing from `.vscodeignore` or the bundle.
- **Recordings:** scenes press real keys through the Chrome DevTools Protocol. Make sure the target has focus first, or use a test command. Check a recording by looking at its frames, not only its file size.

## Code style

- **TypeScript strict.** No `any` where a type is known. Use `import ts = require('typescript')`, as the rest of the code does.
- **Small pure functions** for analysis; side effects (VS Code API, file system, workers) live in `src/ui/` and the panel classes.
- **Comments say why and what for**, in plain sentences, on exported functions and on anything surprising. Name things for what they mean (`changesOutside`, not `res2`).
- **User-facing text is plain English:** sentences, sentence case, and no em dashes in error messages. Put words shared across features in `structure/glossary.ts` or `explanations.ts`.
- **Webview code** is plain ES2020 in `media/`, with no build step. Keep it dependency-free, use VS Code's CSS variables (`--vscode-*`) so every theme works, and support the keyboard, screen readers and reduced motion (see `structure/accessibility.ts` and the existing pages).
- **Accessibility and themes:** every control has a label, charts can be driven from the keyboard, and colours come from the theme. High-contrast themes must still read.
- **Performance:** reuse `ProjectService` programs. Draw only what is on screen in charts. Move heavy model work to a worker.

## Sending a change

1. Open an issue first for anything large, so we can agree on the approach.
2. Branch from `main`, keep the change focused, and add tests.
3. Run `npm test` and the integration tests, and re-record any GIF whose screen changed.
4. Update `docs/GUIDE.md` for anything a user can see, and the README if it's a headline feature.
5. Open a pull request saying what changed, why, and how you tested it, with a screenshot or GIF for UI changes.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).

## Releasing (maintainers)

1. Bump the version: `npm version X.Y.Z --no-git-tag-version`.
2. Run `npm test`, the integration tests, then `npx vsce package` and the integration tests again against the unzipped `.vsix`.
3. Install it locally: `code --install-extension ts-test-impact-X.Y.Z.vsix --force`, and try it.
4. Commit, push to `main`, then publish with `npx vsce publish` (the maintainer's Marketplace token, never committed).
