# How Code X-Ray explains code

This document is for developers. It describes how Code X-Ray puts code into words today: where the rules decide, where the optional models help, the exact thresholds, and where each rule lives in the source. It covers **Explain this code**, its video, **Git reel** captions, and the purpose tags and **Find by meaning** in charts.

## The principle: rules write, models only choose

Every sentence a user sees is **written by rules**, from facts the TypeScript compiler (or the bundled C# and T-SQL parsers) works out. No model writes text.

The optional **code model** (all-MiniLM-L6-v2) never generates words. It turns a short bag of words into a list of numbers (an embedding), and Code X-Ray compares those with the embeddings of fixed descriptions. That lets the model do three things:

- **choose a label** from a fixed list (what a function or a chart box is for), only when it is clearly sure;
- **rank** candidates (which change in a file matters most to the commit);
- **match** a search by meaning.

When the model is missing, turned off, or unsure, the rules' answer stands. Every result says who decided: *by Code X-Ray's rules* or *named by the code model*.

The **voice model** (Kitten TTS) only reads the finished captions aloud. It never changes what is said.

```
code ──▶ compiler / parser ──▶ facts (flowchart, types, effects, names)
                                    │
                                    ├──▶ rules ──▶ sentences, labels, steps ──▶ page, video, captions
                                    │                ▲
                                    └──▶ words ──▶ code model ──▶ "which label?" / "which first?"
                                                     (optional, local, only when clearly sure)
```

## Explain this code

Code: `src/explain/explainCode.ts`, `src/explain/functionFacts.ts`, `src/reel/describe.ts`, `src/reel/intent.ts`, `src/reel/words.ts`. Page: `src/explain/explainHtml.ts`. Command: `src/ui/explainCodeView.ts`.

### 1. What is being explained

`explainCode(file, text, start, end, understand?)` decides between a **whole function** and **some lines**:

| The highlight | Explained as |
|---|---|
| A function's or method's name where it is declared (`placeOrder` in `export async function placeOrder`) | The whole function |
| A name where it is called (`priceOf(…)`, `cart.add(…)`), declared in the same file | That whole function, found through the type checker (`namedFunction`) |
| A name called here but declared in another file | That function, found through VS Code's Go to Definition (`ExplainCodeView.definitionOf`) |
| Anything inside the function's header (its first line, a parameter) | The whole function (`inHeader`) |
| At least 60% of the function, or starting at its first character | The whole function |
| Nothing highlighted | The line at the cursor, which explains a function if that line starts one |
| Anything else | Those lines only (`explainLines`) |

**C#** goes through the bundled parser (`src/csharp/explainTarget.ts`): the same rules choose a whole method (its name declared or called, its header, most of it), a name declared in no method of the file is looked up in the workspace's `.cs` files (`csharpDeclarationOf`) or through Go to Definition, and its summary, Takes / Gives back / Changes come from the syntax tree (fields and `this` members written, collections it owns changed by `Add`, `Remove`…, .NET APIs such as `Console`, `File`, `HttpClient`, `SaveChanges`, `Task.Delay`, `DateTime.Now`, and calls made for what they do). C# code is read for words through `asTypeScript` (`src/reel/words.ts`), which turns `0.9m`, `is null`, `nameof(x)` and `var` into what TypeScript's parser reads, and the call and condition rules know .NET's names (`string.IsNullOrWhiteSpace`, `StartsWith`, `Any`, `Contains`, the `Async` suffix). **T-SQL** goes through `tsqlFlowChart`. If a parser cannot chart the code, the lines are explained instead.

TypeScript and JavaScript files are parsed on their own with `standaloneProgram`: no project, no library. So explaining is instant and never waits for the project to load. The one exception is the Go to Definition lookup above.

### 2. The summary sentence (rules)

`signatureSentence` builds one sentence from the declaration:

- the kind: *function*, *method* or *constructor*, and *async* when it is
- the parameter names: *takes the id, the items and the payment*
- the return type, with `Promise<…>` unwrapped and *once it finishes* added for async code; nothing is said for `void`

> *placeOrder is an async function that takes the id, the items, the payment and the coupon and returns a Receipt, once it finishes.*

### 3. What it is for (rules first, then the model, then the name)

`withPurpose` tries these in order and stops at the first that answers:

1. **The intent rules** (`featureIntent`, minimum score 4): only *feature* intents count, meaning what the code does for its user. They are add, remove, update, show, fetch, save, send, calculate, sort, filter, clear, toggle, auth and navigate. Checks, defaults and logging don't count. It is accepted when the name agrees (`addToCart`), or when the code alone shows it strongly: a row inserted, a POST to the server, a list spread with one more item. See [Intent rules](#intent-rules).
   - For some lines with no function name, the best intent of any kind with a score of 3 or more is used.
2. **The code model**, only if it is downloaded and allowed:
   - The function becomes a bag of words (see [What the model reads](#what-the-model-reads)), compared with 20 fixed descriptions in `FEATURE_PROTOTYPES`. 14 describe features (*"add an item to the cart, list or collection, create a new record"*). Six describe things that are not features (checks, errors, formatting, settings, logging, tests), so that such code is not mistaken for a feature.
   - The label is accepted only when the closest description is a feature, its similarity is at least **0.25** (`MODEL_FEATURE_MIN`), and it leads the next one by at least **0.05** (`MODEL_FEATURE_MARGIN`).
   - The phrase is then built by rules (`intentPhrase`) from the intent and the nouns of the name (`nounsOf`): `applyDiscount` + *calculate* gives *Works out discount*.
3. **The name** (`verbPhrase`): `validateSettingsExport` gives *Validates the settings export*, `isEmpty` gives *Checks whether it is empty*, and `toJSON` gives *Converts it to JSON*. Phrases that would say nothing (*does…*, *works…*, *handles…*) are dropped.

### 4. Takes, Gives back, Changes outside itself (rules)

`functionFacts(fn, source, checker)`:

- **Takes:** each parameter as written (a destructured one keeps its pattern, `{ currency }`), its declared type, its default, and whether it can be left out (`?` or a default) or is a rest parameter.
- **Gives back:**
  - the declared return type, with `Promise<…>` unwrapped and *later* set for async code
  - the expressions of its own `return` statements (returns inside nested functions belong to them), up to four, distinct
  - a bare `return;` adds `undefined`
  - *nothing* for constructors, `void` or `never`, or when it has no `return` with a value and no declared type
- **Changes outside itself:** up to 8 entries, from three sources:
  1. **The Side effects analysis** (`EffectAnalyzer`, `src/inspect/effects.ts`): writes to parameters, `this`, module variables, imports, captured variables and globals, plus I/O, timers and nondeterminism. It follows calls into the same file, and says where: *changes this.items (in add())*.
  2. **Changing method calls** on what the function doesn't own (`this`, a parameter, a module variable): `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `set`, `delete`, `add`, `clear`, `append`, `remove`. This is needed because a file parsed on its own has no standard library to say `items` is an array: *changes this.items (push)*.
  3. **Built-ins** the file can't resolve: `console`, `fetch`, `localStorage`, `sessionStorage`, `document`, `window`, `process`, `setTimeout`, `setInterval`, `alert`. For example, *writes to the console*.

  Finally, **calls made only for what they do** (a call statement whose result is unused, awaited or not, into code not followed) are named together: *calls saveOrder() and notifyCustomer() for what they do, which may change things*.

### 5. Step by step (rules)

`explainFunctionWalk(chart)` walks the function's flowchart in the order the code runs. Each box becomes at most one sentence, up to 10 steps:

| Flowchart box | Sentence |
|---|---|
| Decision whose *yes* branch returns or throws | *If {condition in words}, it {returns/throws …}.* (one step for both boxes) |
| Other decision | *It checks whether {condition}.* |
| `switch` | *It chooses what to do based on {value}.* |
| Loop | `loopPhrase`: *It goes through each item.* |
| `return` / `throw` | `exitPhrase`: *It returns the receipt.* / *It throws an OrderError.* |
| `catch` | Not a sentence of its own. The next step starts *If something goes wrong, it…*, and the ones after it *Then it…* |
| `finally` | *It always tidies up at the end.* |
| Plain code | Up to 3 actions from `explainActions`: calls in words (`callPhrase`), declarations, settings and JSX shown. A request with a path becomes *asks the server for the {last path word}*, and `??` or `\|\|` with a literal becomes *falls back to a default when there is none*. |

Filters on every sentence:

- **Readable only** (`readable`): at most 110 characters, more than one word, and no leftover code (operators, brackets, `a.b`). A phrase that would still read as code is dropped rather than shown.
- **Never twice:** a phrase already said is not repeated; its boxes join the earlier step instead.

Conditions are put into words by `conditionWords` (`src/reel/words.ts`):
- comparisons: *the total is at most 0*
- emptiness: *there are no items*
- flags and states: *it is visible*
- type checks, and calls that test something

**Some lines** (not a whole function) get `explainLines`: the same actions, up to 8, each as *It …*.

### 6. The page

`explanationHtml` shows, in this order:

1. the summary
2. the purpose pill, with who decided
3. the Takes / Gives back / Changes outside itself cards (whole functions only)
4. the numbered steps
5. a privacy line

The page runs no scripts. **Generate video** is a command link.

## The explanation video

Code: `src/explain/explainReel.ts`, drawn by `media/reel.js`.

- **Opening card:** the signature, then the summary and the purpose (a purpose of one word is dropped, because it only repeats the name).
- **One scene per step** (`walkSteps`):
  - **Thin steps are dropped** when at least two others remain: *It uses the …* and *It works out the …*.
  - **Steps on the same boxes are joined,** at most two per scene: *It charges the total, and saves the order.*
- **Each scene is labelled** (`stepKind`):
  - *If it fails* (red): after a `catch`, or a step starting *If something goes wrong*
  - *Throws*
  - *Decision*: a decision or switch box, or a step starting *If*
  - *Loop*
  - *Returns*
  - otherwise *Step*
- **Icons on boxes** (`boxIcon`): by box kind first (decision ?, switch, loop, throw ⚠, catch 🛡, finally), then by what the code calls, first match wins:
  - network → cloud
  - storage or a database → database
  - files → file
  - JSON
  - then the rest of the `ICONS` list: notifications (bell), logging, timers (clock), cancelling (⊘), navigation, events, list changes, `new` objects, sign-in and permissions (lock)
  - a return → sign-out
  - an assignment → pencil
  - another call → method
- **The code strip** shows only the lines the boxes don't already show, and never the same line twice.
- **No closing card:** the video ends on its last step.

## Git reel captions

Code: `src/reel/plan.ts`, `src/reel/keyChange.ts`, `src/reel/describe.ts`, `src/reel/intent.ts`.

### The key change in each file (rules, re-ranked by the model)

Each changed line gets a weight from `lineWeight`:

| Line | Weight |
|---|---|
| Blank, only brackets or punctuation, a closing tag | 0 |
| Changed in place, but only in spacing, quotes or punctuation | 0.1 |
| Comment | 0.2 |
| `import` / `using` / `require` / `export {…}` | 0.3 |
| Logging (`console.*`, `logger.*`, `PRINT`) | 0.4 |
| Anything else | starts at 1, then adjusted by the intent signal of its words (up to +½ of it, never below 0.2) |

Then:

| Adjustment | Change |
|---|---|
| The line is control flow (`if`, `return`, `throw`, `try`, loops, `await`…) | +2 |
| A guard: `if (…) return` or `throw` on one line | +1 (instead of the call bonus) |
| It calls something | +1 |
| It assigns a value or declares a variable | +0.5 |
| It is a type or an interface member | at most 0.8 |
| Only a string literal changed | at most 1 |
| A line changed in place (it shows twice, old and new) | × 0.75 |

`keyChange` picks the strongest group of changed lines: at most 6 changed lines (`KEY_CHANGED`) within 10 lines of span (`KEY_SPAN`). That group is shown large with a callout. `keyLabel` names it from the main intent, for example *Key change: adds to cart* or *Key change: early exit*.

**With the code model**, every candidate is moved by how close it is to the commit's title: its weight increases by `max(0, similarity − 0.15) × 25`. So the key change is the part that matters to what the change is about. A function the rules could not place gets a feature label by the same rule and thresholds as Explain (0.25 and a 0.05 lead), and its caption is rebuilt around it (`featureCaption`).

The files with the strongest key changes get a scene each, code first and tests last. The rest are listed on one card. The whole reel is fitted to at most 150 seconds.

### The captions themselves (rules)

- **A changed function** (`describeFunctionChange`): compares its flowchart before and after (`flowCompare`) and says what is new or different in plain words, with no counts. For example: *applyCoupon now returns 0 early when the amount is at most 0.*
- **A new function** (`describeNewFunction`): what it does, from its steps.
- **A file without functions** (`describeFileChange`): JSON keys, CSS selectors, scripts, and test names (`testClaim`), for example *It now checks that the cart total includes tax.*
- **Variety:** consecutive captions don't start the same way (`varyCaptions`).
- **Speech:** `speakable` makes the text sayable, for example *this file* instead of a path.

## Intent rules

Code: `src/reel/intent.ts`. Used by Explain (purpose), the Git reel (feature labels, callouts) and the line weights.

`intentsOf({ name, file, added, removed })` scores 22 kinds of intent. Every signal adds its weight:

| Signal | Weight |
|---|---|
| The name's verb, after dropping words such as *handle*, *on*, *do*: `addToCart`, `handleRemoveClick`. 127 verbs map to intents in `NAME_VERBS`. | 5 |
| The file is a test file | 6 |
| Each of the 41 code patterns in `RULES` that matches a line, such as `.push(` (*adds to a list*), `setItems(prev => [...prev, x])`, `INSERT INTO`, a POST, `.filter(x => x.id !== id)` (*takes one out*), `.map(x => x.id === id ? …)` (*changes the matching one*), `UPDATE … SET`, rendering a list, fetching, storage. Each pattern counts at most twice. | 2 or 3 |
| A pattern on a removed line | half its weight |

- The highest score wins.
- **Ties** go to the more specific kind (`KIND_ORDER`: add, remove and update come before show, fetch and so on).
- **The object and target** come from the name when it names them (`addToCart` → *the cart*), otherwise from the matched code.
- **`intentPhrase`** turns kind + object + target into words: *adds an item to the cart*, *shows the cart items*.

## The code model in charts

Code: `src/structure/flowPurpose.ts`, `src/ui/chartMeaning.ts`, and the pages `media/diagram.js` and `media/controlFlow.js`. It is off until the user turns on the wand (`tsStructure.charts.codeModel`).

### Purpose pills

Each box gets at most one pill:

1. **Rules first** (`rulePurpose`): the first of 14 purposes in `FLOW_PURPOSES` whose code pattern matches the box's text wins (solid pill):

   | Purpose | Matches |
   |---|---|
   | Checks disk | `existsSync`, `stat`… |
   | File | `readFile`, `writeFile`, `mkdir`… |
   | Network | `fetch`, `axios`, HTTP verbs on a path |
   | JSON | `JSON.stringify` / `parse` |
   | Module | `require`, `import()` |
   | Config | `process.env`, `getConfiguration`… |
   | Stored | `localStorage`, `db.`, `INSERT`… |
   | Logged | `console.*`, `logger.*` |
   | Shown | `innerHTML`, `render`, `setState`… |
   | Error | `throw`, `reject`, `new …Error` |
   | Sent | `emit`, `dispatch`, `postMessage`… |
   | Process | `spawn`, `exec`… |
   | Time | `setTimeout`, `Date.now`… |
   | Input | `req.body`, `argv`, `prompt(`… |

   JSON is listed before Module and the rest, so `JSON.stringify(...Date.now())` is tagged JSON.
2. **Then the model** (`modelPurpose`), for boxes the rules can't place (dashed pill):
   - The box's words are compared with each purpose's plain description (*"read, write or save a file on disk"*).
   - It is tagged only when the closest similarity is at least **0.25** (`PURPOSE_MIN`) and leads the next by at least **0.08** (`PURPOSE_MARGIN`).
   - The box must have **at least 3 words** (two words such as *launch browser* is too little to go on).
   - Boxes that only group others get no pill (`isGroup`).
   - The chart's own annotations (*read:*, *write:*, *returned by*, arrows, file names and counts) are stripped first (`stripAnnotations`), so *read: amount* is not taken as reading a file.
   - The model reads the box's label only, not its description, because the description can carry the enclosing function's name. The rules read both.

### Find by meaning

The query and each box (its words plus the description of its purpose, if any) are embedded. A box matches if either:

- its purpose is close to the query (**≥ 0.3**, `FIND_VIA_PURPOSE`) and the box itself is reasonably close (**≥ 0.2**, `FIND_WITH_PURPOSE`); or
- the box is very close on its own (**≥ 0.5**, `FIND_DIRECT`).

At most 12 matches are returned, the closest first. Text matches still come from the plain search, and the count says how many were found *by meaning*. A query that only looks like a word (*chromodynamics* vs *chromium*) doesn't match.

## What the model reads

`codeAsWords(name, lines)` in `src/reel/codeModelText.ts` (kept free of the TypeScript compiler so the worker stays small):

- the words of the name, split on case and separators (`placeOrder` → *place order*)
- then the words of every identifier in the lines (`notifyCustomer` → *notify customer*)
- comments and **string literals are removed**
- keywords and common filler are dropped (`STOP`: `const`, `return`, `this`…)
- each word appears once, lower case, **at most 40 words**

So the model sees something like `place order id items payment coupon total checkout charge receipt save notify customer`. That is never the raw code, and nothing leaves the computer.

The model itself:

- **Files:** all-MiniLM-L6-v2 quantized to int8 (`model_quantized.onnx`, 23 MB) and its WordPiece vocabulary, with a tokenizer written in `codeModelText.ts`.
- **Runtime:** onnxruntime-web in a worker thread (`src/reel/codeModel.ts`, `codeModelWorker.ts`). Embeddings are mean-pooled and normalised, so similarity is a dot product (`cosine`).
- **Download:** only after the user agrees, in the dialog that says exactly how data is used (`src/reel/downloadPrivacy.ts`).

## Known limits

These are the gaps a better model or better rules could close:

- **The summary says what the function *is*, not what it is *for*.** The purpose comes from 14 fixed feature kinds plus the name, so many functions get only a name-based phrase.
- **Steps are literal:** *It uses the checkout total. It charges the total.* They are accurate but stilted, and they use code words rather than domain words.
- **String literals and comments are ignored,** by both the rules and the model, so `` `Thanks! You paid ${total}` `` doesn't become *thanks the customer*. Doc comments aren't shown either.
- **Conditions say *what*, not *why*:** *If the total is at most 0, it throws an OrderError*, rather than *refuses orders with nothing to pay*.
- **Idioms without a rule aren't named:** retry with backoff, debounce, memoization, pagination, LINQ chains.
- **Some lines get shallow line-by-line actions.**
- **The model can only choose from fixed lists,** so it can never say anything the rules or descriptions don't already contain.

## Where to change things

| To change | Edit |
|---|---|
| How a whole function or some lines is chosen | `explainCode`, `namedFunction`, `inHeader` in `src/explain/explainCode.ts`; `definitionOf` in `src/ui/explainCodeView.ts` |
| The summary sentence | `signatureSentence` in `src/explain/explainCode.ts` |
| Takes / Gives back / Changes | `src/explain/functionFacts.ts`; deeper effects in `src/inspect/effects.ts` |
| Step sentences | `explainFunctionWalk`, `explainActions`, `explainLines` in `src/reel/describe.ts`; words in `src/reel/words.ts` |
| Intent kinds, name verbs, code patterns, phrases | `src/reel/intent.ts` (`NAME_VERBS`, `RULES`, `intentPhrase`, `FEATURE_PROTOTYPES`) |
| Model thresholds for Explain and the reel | `MODEL_FEATURE_MIN`, `MODEL_FEATURE_MARGIN` in `src/reel/plan.ts` |
| Chart purposes and Find by meaning | `FLOW_PURPOSES` and the thresholds in `src/structure/flowPurpose.ts` |
| Key change weights | `lineWeight`, `KEY_CHANGED`, `KEY_SPAN` in `src/reel/keyChange.ts` |
| Video scenes, labels, icons | `walkSteps`, `stepKind`, `boxIcon` in `src/explain/explainReel.ts` |
| What the model reads | `codeAsWords` in `src/reel/codeModelText.ts` |

Tests that pin this behaviour are `src/test/explainCode.test.ts`, `flowPurpose.test.ts`, `codeModel.test.ts`, `reelDescribe.test.ts`, `reelIntent.test.ts` and `reelPlan.test.ts`. Change the rules and the tests together.
