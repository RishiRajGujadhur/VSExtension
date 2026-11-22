---
name: code-x-ray
description: Map of the Code X-Ray VS Code extension (package ts-test-impact) and the rules for changing it. Read before adding or changing an analysis, chart, the Git reel or explain video, Explain this code, the optional models and their downloads, settings, docs or screenshots, or before testing, packaging or releasing.
---

# Code X-Ray: how the extension is built

Code X-Ray is a VS Code extension (package `ts-test-impact`, publisher `RishiGujadhur`, display name **Code X-Ray**). It explains TypeScript, JavaScript, React, C# and T-SQL code with exact analyses from the TypeScript compiler and bundled parsers. Everything runs on the user's computer.

## Non-negotiable rules

- **Offline and deterministic by default.** Analyses never use the network. `src/reel/pinnedDownload.ts` is the **only** module allowed to make a network request, and `src/test/privacy.test.ts` enforces that. Downloads go to Hugging Face hosts only (`allowedHost`), pinned to a commit and checked against a hash.
- **Say how data is used at the download step.** Every model download is confirmed first in a modal whose text comes from `downloadPrivacy()` in `src/reel/downloadPrivacy.ts`. It covers what is sent, what is never sent, how Hugging Face may use the request, where files go, what the model reads and keeps, and how to remove it. If you change the downloader, the headers or what a model keeps on disk, update the notice in the same change. The tests in `explainCode.test.ts` check that the notice matches the downloader.
- **Nothing bundled is downloaded later without asking.** The models (Kitten TTS voices, all-MiniLM-L6-v2) are not shipped. They download only after the user agrees, or when a setting says to download without asking.
- TypeScript is pinned at **6.0.3**. Keep the `tsStructure.*` command and setting IDs, even for renamed features. Deprecate old settings instead of deleting them.
- Plain words in the UI: name what code does, not jargon. Don't use em dashes in error messages. The voice picker must not say "Kitten": use the models' short names (Nano, Micro, Mini).
- Design patterns appear **only** in Pattern spotting (`src/inspect/patterns.ts`), never in Data flow or other analyses.
- Don't commit `sample/.vscode/`. Never put tokens or credentials anywhere. The maintainer publishes with `npx vsce publish` themselves.

## Layout

| Path | What lives there |
|---|---|
| `src/boot.ts` | Entry point: opens the sidebar pages first, then lazy-loads `extension.ts`. |
| `src/extension.ts` | `activate`: builds the services and views, and registers every command (including test-only ones such as `tsStructure.diagram.meaningInfo`). |
| `src/analysis/` | `ProjectService` (TypeScript programs per tsconfig), the reference index, test discovery and running, Affected tests (`impact.ts`). |
| `src/inspect/` | Analyses that return a `Report`: data flow, control flow (`controlFlowChart.ts` builds flowcharts; `standaloneProgram`/`standaloneCharts` parse one file with no project), effects, nullability, exceptions, rejections, races, dead exports, duplicates, patterns, React state, timelines. Live inspections are registered in `registry.ts`. |
| `src/navigate/` | Usages, call graph, hierarchy, module graph and diff, re-exports, argument flow, bundle weight. |
| `src/refactor/`, `src/intentions/`, `src/search/` | Change signature, safe delete, move, introduce parameter; quick rewrites; structural search and custom inspections. |
| `src/csharp/`, `src/tsql/` | Bundled parsers (tree-sitter C# as wasm, a hand-written T-SQL lexer and parser) and their flowcharts, charts, inspections and navigation. |
| `src/structure/` | Shared model and words: `report.ts` (Report/ReportNode/ReportBuilder), `features.ts` (feature switches and their commands), `actionCatalog.ts` (the Actions view entries), `diagram.ts`/`flowLayout.ts` (chart layout), `flowPurpose.ts` (purpose tags and find by meaning for charts), `explanations.ts`, `credits.ts`, `glossary.ts`. |
| `src/ui/` | VS Code surfaces: `structureView.ts` (the Analysis results view; Affected tests results are `src/resultsView.ts`), `actionsView.ts`, `diagramView.ts` (every analysis chart), `controlFlowView.ts` (flowchart), `chartMeaning.ts` (the code-model wand shared by both), `explainCodeView.ts`, `settingsPanel.ts`, `changeSignaturePanel.ts`, `analysisCommands.ts` (command to report). |
| `src/explain/` | Explain this code: `explainCode.ts` (picks a whole function when its name, header or most of it is highlighted, or when a call to it is; otherwise explains the lines), `functionFacts.ts` (Takes / Gives back / Changes outside itself), `explainHtml.ts` (the page), `explainReel.ts` (the video plan). |
| `src/reel/` | Git reel and the models: `plan.ts` (ReelPlan scenes: overview, diff, flow, files, summary), `keyChange.ts`, `intent.ts`, `describe.ts`/`words.ts` (captions), `reelPanel.ts` (player panel, voice and code model prompts, export), `kitten*.ts` (TTS in worker threads with onnxruntime-web; eSpeak runs as a child process), `voiceModels.ts`, `codeModel*.ts` (MiniLM embeddings in a worker), `pinnedDownload.ts`, `downloadPrivacy.ts`. |
| `media/` | Webview front ends in plain JS and CSS: `chartKit.js` (shared viewport, minimap, map dock, icons, menus), `diagram.js`, `controlFlow.js`, `reel.js` (canvas player and recorder), `actions.js`, `settings.js`, `valuePath.js`, `welcome.js`. |
| `scripts/` | `bundle.js` (esbuild to `dist/extension.js`; `typescript` and `vscode` stay external), `integration.js`, `screenshots.js`, `fetch-kitten.js`. |
| `docs/` | `GUIDE.md` (every feature in full), `images/` (README and guide GIFs), `demo/` (the bookshop project the screenshots use). |
| `test-fixtures/` | Projects for unit tests; `voice-model.cjs` finds the test copy of a voice model; `block-network.cjs` blocks the network for the offline tests. |

For how explanations, captions, purpose tags and Find by meaning are worked out (every rule and threshold), read `docs/HOW_EXPLAINING_WORKS.md` before changing them.

## How the pieces connect

- **An analysis** is a function that takes `(program, fileName, offset)` and returns a `Report`. To add one, wire all of these:
  1. the analysis in `src/inspect/` or `src/navigate/`
  2. its command in `src/ui/analysisCommands.ts`
  3. its `commands` and `menus` entries in `package.json`
  4. the feature switch in `features.ts`
  5. an entry in `actionCatalog.ts` (set `graph: true` to offer it as a chart)
  6. explanation text in `explanations.ts`
  7. a test in `src/test/`
- **Charts**: `diagramView.ts` turns any `Report` into a `Diagram` (`structure/diagram.ts`) and `media/diagram.js` draws it. Flowcharts are separate: `controlFlowView.ts` with `media/controlFlow.js`.
  - Both use `chartKit.js` for the viewport, minimap and dock, and `ChartMeaning` for the code-model wand (`tsStructure.charts.codeModel`).
  - Fitted charts leave room for the zoom dock (`DOCK_SPACE`, and `room` in `diagram.js`).
  - Charts of up to 150 boxes keep their text at any zoom (`DETAIL_ALWAYS`). Bigger ones drop it below 45% zoom, to stay fast.
- **Videos**: a `ReelPlan` (`src/reel/plan.ts`) is data. `media/reel.js` draws it on a canvas, narrates it and records it.
  - The Git reel builds its plan from `git diff`.
  - Explain this code builds its plan from `explainReel.ts` (walk flow scenes on the function's flowchart).
  - Both open through `ReelPanel.openPlan`.
- **Models**:
  - The **code model** is `CodeModel`, stored in `globalStorage/.../code-model`. Its settings are `tsStructure.reel.codeModel` (ask, on, off) and `tsStructure.charts.codeModel`.
  - **Voice models** are `VoiceModelStore`, one folder per model under `globalStorage/.../voice-models`. The setting is `tsStructure.reel.voiceModel`; Kitten Nano int8 is the default.
  - Spoken clips are cached as WAV files in `globalStorage/.../reel-voice`.
  - All downloads go through `ReelPanel.confirmDownload` (or the Explain page's own modal), which shows `downloadPrivacy` text first.

## Build, test, release

The portable VS Code used for tests is `F:/Development/VSCode-win32-x64/Code - OSS.exe` (the file is named `Code - OSS.exe`, not `Code.exe`).

- Compile: `npm run compile` (tsc to `out/`). Bundle: `node scripts/bundle.js`.
- Unit tests: `npm test`, which uses `node --test` on `out/test/**/*.test.js`. Keep them all passing. A run takes about 50 seconds.
- Integration tests run in a real VS Code against `sample/`:
  ```
  VSCODE_EXECUTABLE="F:/Development/VSCode-win32-x64/Code - OSS.exe" npm run test:integration
  ```
  They seed the voice and code models into the test user's storage.
- To test the packaged extension: run `npx vsce package`, unzip the `.vsix`, and run the integration tests again with `EXTENSION_PATH=<unzipped>/extension`.
- Screenshots: `npm run screenshots -- <scene names>` re-records `docs/images/<scene>.gif` from `src/test/screenshots/scenes.ts`, with the same `VSCODE_EXECUTABLE`. With no names it records every scene.
  - Scenes drive the window with real key presses through CDP. Focus the target first (for example `tsStructure.gitReel.focus`), or use a test command such as `tsStructure.diagram.typeFind`.
  - To check a recording, extract its frames to PNGs and look at them. Don't trust that a GIF is fine.
- Release:
  1. Bump `version` (`npm version X --no-git-tag-version`).
  2. Run the unit, integration and VSIX tests.
  3. Install with `code --install-extension ts-test-impact-X.vsix --force`.
  4. Commit with `git -c user.name=djcool026 -c user.email=<the maintainer's email> commit`, the message ending in a `Co-Authored-By` line.
  5. Push to `main`. The maintainer runs `npx vsce publish`.
- The README is both the GitHub and the Marketplace page: use relative `docs/images/...` paths. Update `docs/GUIDE.md` with every user-visible change, and the README for headline features.
