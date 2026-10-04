# natl Implementation Plan

> **For agentic workers:** execute task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A CLI + library that runs E2E tests for web and mobile apps where steps may be plain English (executed by an LLM agent) or deterministic selectors/assertions, mixed freely in one test, with record/replay so reruns make zero model calls.

**Architecture:** One step model, one driver contract implemented twice (Playwright / Appium W3C HTTP), one LLM planner with an on-disk action cache.

**Tech Stack:** Node >= 20 (ESM), `playwright` (only runtime dep, optional import), built-in `node:test`, built-in `fetch`. No other dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-natl-design.md`

## Global Constraints

These bind every task. Violating them causes integration failure.

1. **ESM only.** `"type": "module"` in package.json. Every source file uses `import`/`export`. No `require`.
2. **No new dependencies.** `playwright` is the only entry in `devDependencies`. Do not add webdriverio, selenium, xml parsers, prompt frameworks, or test frameworks. XML parsing uses `node:util` / regex-level tag scanning only.
3. **Shared contracts below are frozen.** Signatures, field names, and action names are exact. Do not rename.
4. **Element identity is `{role, name}`** — never a CSS selector in recorded plans.
5. **Deterministic steps never touch the model.** `src/runner.js` constructs the planner lazily on the first NL step only.
6. **Zero silent passes.** A failure anywhere throws; the runner never swallows an error to keep going.
7. **No secrets in source.** API keys come from env or config, never hardcoded, never logged.
8. **`PLAYWRIGHT_BROWSERS_PATH`** — browsers live in `<repo>/.browsers` on this host; `src/drivers/web.js` must read `process.env.PLAYWRIGHT_BROWSERS_PATH` as-is and not set it.
9. **Write-set is disjoint.** Each task owns only its listed files. Do not edit files outside your list; do not edit `package.json`.
10. **Tests use `node --test`**, run from the repo root, no runner dependency.

### Frozen contract 1: action object

```js
// The ONLY action shapes the planner may emit and drivers must accept.
{ action: 'click',  ref: string }                  // click / tap
{ action: 'fill',   ref: string, value: string }  // set text (clears first)
{ action: 'clear',  ref: string }
{ action: 'press',  ref: string, value: string }  // key or button name (mobile: "back"/"enter")
{ action: 'scroll', ref: string, value: 'up'|'down'|'top'|'bottom' }
{ action: 'wait',   ref: string }                  // wait until element appears
```

### Frozen contract 2: snapshot

```js
// driver.snapshot() resolves to exactly this shape
{
  elements: Array<{ ref: string, role: string, name: string }>,
  text: string,        // flattened human-readable page text, capped at 4000 chars
  fingerprint: string  // sha256 hex over role+name pairs ONLY (see rule 4)
}
```
`ref` is the opaque index as a string (`"0"`, `"1"`, ...). The planner sees only
`elements` and `text` and may only reference a `ref` present in that list.

Fingerprint rule: `sha256(JSON.stringify(elements.map(e => [e.role, e.name]).sort()))`.
Position/`ref` excluded **and pairs sorted**, so reordering alone does not invalidate
a plan, but any added, removed, or renamed element does. Sorting is required: replay
re-resolves recorded actions by `{role, name}` identity rather than by position, so a
reorder is genuinely not a page change. An unsorted `JSON.stringify` of the mapped
pairs would contradict that intent — it would be order-sensitive.

### Frozen contract 3: driver

```js
// Every driver implements exactly these six members.
class Driver {
  async open()                 // launch or attach; idempotent
  async close()                // teardown; idempotent; never throws
  async snapshot()             // -> Frozen contract 2
  async act(actionObj)         // -> any; throws on failure
  async goto(url)
  async find(selector)         // -> {text, count}; deterministic-step helper
}
```

### Frozen contract 4: step DSL (`src/steps.js`)

```js
export const step  = (text) => ({ kind: 'nl', text })
export const goto  = (url)  => ({ kind: 'act', fn: 'goto', url })
export const click = (sel)  => ({ kind: 'act', fn: 'click', sel })
export const fill  = (sel, v) => ({ kind: 'act', fn: 'fill', sel, value: v })
export const expectText  = (sel, v) => ({ kind: 'expect', fn: 'expectText',  sel, value: v })
export const expectCount = (sel, n) => ({ kind: 'expect', fn: 'expectCount', sel, value: n })
export const expectUrl   = (v)    => ({ kind: 'expect', fn: 'expectUrl',   value: v })
export const test = (name, steps) => ({ kind: 'test', name, steps })
```
Any extra field on an `act`/`expect` step is passed through to `driver.act`.

### Frozen contract 5: cache entry (`src/cache.js`)

```js
// one JSON file: <cacheDir>/<testFileHash>.json
{
  version: 1,
  entries: { [key: string]: {
    key, stepText, fingerprint,
    elements: [{ref, role, name}],
    actions: [Action],
    provider, model, recordedAt
  }}
}
// key = sha256(stepText + '\n' + fingerprint)
```
`load()` / `save()` are async. `save()` writes to a temp file then `rename()`.

### Frozen contract 6: planner (`src/planner.js`)

```js
export async function plan({ provider, instruction, snapshot, drivers })
// -> { actions: Action[], provider, model }
// provider: { provider, model, apiKey, baseUrl }  (see src/llm.js)
// throws on: no api key (unless provider is 'ollama'), HTTP error, unparseable output
```
Never caches; caching is the runner's job.

---

## File map

| File | Owner | Responsibility |
|---|---|---|
| `src/steps.js` | T1 | Step DSL constructors only. Pure. |
| `src/cache.js` | T1 | Load/save/lookup/record. Atomic writes. |
| `src/fingerprint.js` | T1 | sha256 helpers for key + fingerprint. |
| `src/llm.js` | T2 | Provider table, `callModel`. Pure HTTP. |
| `src/prompt.js` | T2 | System prompt + user message builder. |
| `src/planner.js` | T2 | Snapshot+instruction -> actions. One repair retry. |
| `src/drivers/web.js` | T3 | Playwright driver. |
| `src/drivers/mobile.js` | T4 | Appium W3C-over-fetch driver. |
| `src/runner.js` | T5 | Executes a test object. Lazy planner. |
| `src/report.js` | T5 | Terminal result rendering + JSON report. |
| `bin/natl.js` | T5 | CLI: `run`, `replay`, `record`. |
| `src/init.js` | T6 | Setup wizard, config + starter test generation. |
| `examples/web/**` | T7 | Working web example + fixture server. |
| `examples/mobile/**` | T7 | Mobile example + capabilities template. |
| `README.md` | T7 | Setup + usage docs. |

---

### Task 1: step DSL, fingerprint, cache

**Files:** `src/steps.js`, `src/fingerprint.js`, `src/cache.js`, `test/steps.test.js`, `test/cache.test.js`

**Produces:** the exact exports in Frozen contract 4 and 5.

- [ ] `test/cache.test.js`: record then lookup by the same step+fingerprint returns the entry.
- [ ] `test/cache.test.js`: a different fingerprint is a MISS.
- [ ] `test/cache.test.js`: re-recording a step does not remove another step's entry.
- [ ] `test/cache.test.js`: `save()` to a path whose directory does not exist creates it.
- [ ] `test/steps.test.js`: `step('x')` deep-equals `{kind:'nl',text:'x'}`; `click('#a')` deep-equals the frozen shape.
- [ ] Run `node --test test/steps.test.js test/cache.test.js` — expect PASS.
- [ ] Commit.

### Task 2: provider table + planner

**Files:** `src/llm.js`, `src/prompt.js`, `src/planner.js`, `test/llm.test.js`, `test/planner.test.js`

**Produces:** `callModel({provider, model, apiKey, baseUrl, system, user})` -> `{raw, parsed}`.
`parsed` is the decoded JSON object. Never throws on JSON failure — it throws a
labelled `NatlError` instead, with the raw response truncated to 500 chars.

Provider table (exact values, verified against vendor docs 2026-10):

| provider | url | auth | tool-call path | args are |
|---|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | `Authorization: Bearer` | `choices[0].message.tool_calls[0].function.arguments` | JSON string |
| `anthropic` | `https://api.anthropic.com/v1` | `x-api-key` + `anthropic-version: 2023-06-01` | `content[].type === 'tool_use'` -> `.input` | parsed object |
| `deepseek` | `https://api.deepseek.com/v1` | `Authorization: Bearer` | same as openai | JSON string |
| `ollama` | `http://127.0.0.1:11434/v1` | none | `choices[0].message.tool_calls[0].function.arguments` | JSON string |

OpenAI/DeepSeek/Ollama share one OpenAI-shaped code path. Anthropic gets its own.
Ollama needs no api key — do not throw when `apiKey` is empty for it.

- [ ] `test/llm.test.js`: with `globalThis.fetch` stubbed, assert the exact request URL, the presence of the auth header, and that the parsed object is returned for each of the 4 providers.
- [ ] `test/planner.test.js`: a stub `callModel` returning `{"actions":[{"action":"click","ref":"2"}]}` yields those actions.
- [ ] `test/planner.test.js`: a first response that is not JSON triggers exactly one retry, and a second failure throws.
- [ ] `test/planner.test.js`: an action whose `ref` is not in the snapshot throws.
- [ ] Run `node --test test/llm.test.js test/planner.test.js` — expect PASS.
- [ ] Commit.

### Task 3: web driver

**Files:** `src/drivers/web.js`, `test/drivers/web.test.js`

**Produces:** `createWebDriver({url, headless, device})` -> Driver (frozen contract 3).

Facts verified empirically on Playwright 1.63.0 — use these, do not use
`page.accessibility` (it does not exist in 1.63):

- `await page.ariaSnapshotJSON()` -> `[{role, name, level?, placeholder?, url?, children?}]`
- `page.getByRole(role, {name, exact:true})` resolves a recorded element.
- `page.getByLabel(name)` / `getByPlaceholder(name)` / `getByText(name)` are fallbacks.
- `page.locator(sel)` takes a CSS selector.

`selectorMode` is `css` only. `snapshot()` flattens `ariaSnapshotJSON()` depth-first,
skips nodes with no `role` and no `name`, and assigns `ref` in visit order.
`find(sel)` returns `{text, count}` from `locator(sel)`.

- [ ] `test/drivers/web.test.js` against a `setContent` page: snapshot contains `{role:'button', name:'Sign In'}`.
- [ ] fingerprint changes when a button label changes; does NOT change when two elements swap order.
- [ ] `act({action:'fill', ref, value})` sets the input value; `act({action:'click',ref})` fires the handler.
- [ ] `find('#missing')` returns `count:0` rather than throwing.
- [ ] Run `node --test test/drivers/web.test.js` — expect PASS (needs `PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers`).
- [ ] Commit.

### Task 4: mobile driver

**Files:** `src/drivers/mobile.js`, `test/drivers/mobile.test.js`, `test/helpers/fake-webdriver.js`

**Produces:** `createMobileDriver({server, capabilities, selectors})` -> Driver.

WebDriver endpoints used (W3C, base path `""` — Appium 3 default):
`POST /session`, `DELETE /session/:id`, `GET /session/:id/source`,
`POST /session/:id/element`, `POST /session/:id/elements`,
`POST /session/:id/element/:elId/click`, `POST /session/:id/element/:elId/value`,
`GET /session/:id/element/:elId/text`, `GET /session/:id/element/:elId/attribute/:name`.

Element ref key: `element-6066-11e4-a52e-4f735466cecf`.

Selector rules (`selectors.mode`, default `auto`):
- starts with `//` -> xpath
- starts with `xpath=` -> xpath
- starts with `id=` -> id
- starts with `accessibility id=` or `~` -> accessibility id
- otherwise -> accessibility id

`fingerprint` uses `GET /source` XML parsed with a regex tag scanner that extracts
`content-desc`, `text`, `resource-id`, `class`, and `contenteditable`. No XML library.

Because this host has no Java, no `adb`, no Appium, and cannot run XCUITest at all,
the test MUST run against `test/helpers/fake-webdriver.js`: a real `node:http`
server implementing the nine endpoints above over a fixed Android page-source XML.

- [ ] `test/drivers/mobile.test.js`: `open()` posts the exact capabilities and stores the session id.
- [ ] `snapshot()` parses the fake XML into elements with role `button`/`textbox` and the right names.
- [ ] `act({action:'click', ref})` issues `POST /element/:elId/click` with the id the snapshot recorded.
- [ ] `act({action:'fill', ref, value})` posts `{"text":...,"clear":true}`.
- [ ] a `500` from the fake server makes `act` throw with the status code in the message.
- [ ] `close()` calls `DELETE /session/:id` and a second `close()` does not throw.
- [ ] Run `node --test test/drivers/mobile.test.js` — expect PASS.
- [ ] Commit.

### Task 5: runner, report, CLI  (integrator — do not run in parallel with 1-4)

**Files:** `src/runner.js`, `src/report.js`, `bin/natl.js`, `test/runner.test.js`, `test/e2e-web.test.js`

`runTest(testObj, {driver, provider, cache, mode})` where `mode` is
`'auto' | 'replay' | 'record'`:

- `'auto'` (default): replay if fingerprint matches, else plan and record.
- `'replay'`: replay only. A miss fails the step. Zero model calls by construction.
- `'record'`: always plan, always record, never replay.

Per NL step:
1. `snap = await driver.snapshot()`
2. `entry = cache.lookup(step.text, snap.fingerprint)`; skip if `mode==='record'`.
3. If found: rebuild `ref -> element` from `entry.elements`, run each action with `ref` remapped to the *current* snapshot position of the same `{role,name}`; if any element is missing or an action throws, log `replay-miss (failed)` and go to 4.
4. `actions = await plan(...)`; run them; `cache.record(...)`.

On a fingerprint mismatch log `replay-miss (changed)` and go to 4.

The returned report object:
```js
{ name, ok, modelCalls, replayed, recorded, steps: [{index, kind, status, ms, detail}], error }
```
`modelCalls` increments ONLY when `plan()` is actually invoked.

`test/e2e-web.test.js` is the acceptance test: build a real Web driver against a
`data:`/local HTML fixture containing a form; run a test with one NL step and one
deterministic assertion; assert `modelCalls >= 1` on the first run with a stub
planner, then `modelCalls === 0` on the second run against the same cache file.

CLI: `natl run <file>`, `natl replay <file>`, `natl record <file>`, `natl init` (T6),
plus `--config <path>`, `--provider`, `--model`, `--report <file.json>`, `--headed`.

- [ ] `test/runner.test.js`: a test of only deterministic steps never constructs a planner — prove it by passing a `provider` getter that throws.
- [ ] `test/runner.test.js`: `mode:'replay'` with an empty cache fails the NL step and `modelCalls === 0`.
- [ ] `test/runner.test.js`: a changed page fingerprint triggers a plan and re-records.
- [ ] `test/runner.test.js`: a replay whose action throws falls back to the model.
- [ ] `test/e2e-web.test.js`: the three-run acceptance described above.
- [ ] Run `node --test test/runner.test.js` and `node --test test/e2e-web.test.js` — expect PASS.
- [ ] Commit.

### Task 6: setup wizard

**Files:** `src/init.js`, `test/init.test.js`

`init({cwd, answers})` -> `{configPath, testPath}`. Pure over injected `answers`
(defaults come from an interactive `readline` wrapper only when `answers` is absent),
so it is testable without a TTY.

Prompts, in order: project/test name, app type (`web` | `mobile`), platform
(`android` | `ios`, mobile only), provider (`openai` | `anthropic` | `deepseek` | `ollama`),
model name, base URL (default per provider), starting URL / capabilities path.

Writes:
- `natl.config.json` — `{appType, provider, model, baseUrl, cacheDir, web:{url,headless,device}, mobile:{server,capabilities,selectors:{mode}}}`
- `examples/<name>/<name>.test.js` — a starter test importing from `../../src/index.js`
- `.env.example` listing `NATL_API_KEY` and `OPENAI_API_KEY`-style provider keys

Never writes a real key. If `answers` omits `apiKey`, it writes a comment saying to
export it.

- [ ] `test/init.test.js`: web answers produce a config with `appType:"web"` and no `mobile` key.
- [ ] `test/init.test.js`: mobile answers produce `mobile.server` and `mobile.capabilities`.
- [ ] `test/init.test.js`: no file written contains a non-empty api key.
- [ ] Run `node --test test/init.test.js` — expect PASS.
- [ ] Commit.

### Task 7: examples and docs  (last — depends on all)

**Files:** `README.md`, `examples/web/server.mjs`, `examples/web/login.test.js`,
`examples/web/fixture/index.html`, `examples/mobile/login.test.js`,
`examples/mobile/capabilities.json`

`examples/web` must actually run:
`node examples/web/server.mjs` serves the fixture on 127.0.0.1:4173.
`login.test.js` mixes an NL login step with `expectText('#status', ...)` and
`expectCount('#items .item', 2)`.

`examples/mobile` is runnable but cannot be executed here; it documents the exact
`appium server` + driver install commands and the capabilities file.

`README.md`: what it is, 3-minute quick start (install, `natl init`, `natl run`),
how the record/replay and zero-model-call guarantees work, the provider table,
the full DSL reference, web setup, mobile setup (Android on Linux, iOS needs macOS
— state it plainly), and how to debug a plan (`--report`).

- [ ] Run `node examples/web/server.mjs &` then `node bin/natl.js run examples/web/login.test.js` — expect the NL step to plan or replay and both assertions to pass.
- [ ] Run it a second time — expect `modelCalls: 0`.
- [ ] Run `node --test test/` — expect all green.
- [ ] Commit.

---

## Global Constraints (restated for reviewers)

Same list as the top of this document; the four that reviewers most often catch
violations of are: ESM only, no new dependencies, frozen contracts unchanged,
write-set disjoint.