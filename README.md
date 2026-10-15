# natl — Natural-language E2E testing

Write tests in plain English. The agent drives the app. Record once, replay
without a model call. Zero model calls when the test contains only selectors
and assertions.

## Installation

```bash
cd <your-project>
npx natl init
```

`natl init` asks for the app type, model provider, and model name, then writes:

- `natl.config.json` — provider, base URL, cache directory, web or mobile config
- `examples/<project>/<project>.test.js` — starter test
- `.env.example` — env vars to export (no real keys are ever written)

## Quick start

```bash
# 1. Export your provider key (pick one)
export NATL_API_KEY=sk-...
# or
export DEEPSEEK_API_KEY=sk-...
# or
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-...

# 2. Run the starter test (first run: plans and records)
node bin/natl.js run examples/<project>/<project>.test.js

# 3. Run again (replay: zero model calls)
node bin/natl.js run examples/<project>/<project>.test.js
```

The second run prints `modelCalls=0` and `replayed=1` if the page has not
changed. If the page has changed, the runner falls back to the model
automatically and re-records.

## The DSL

A test file is a plain ESM module that exports a test object:

```js
import { test, step, goto, click, fill, expectText, expectCount } from 'natl/src/steps.js'

export default test('checkout', [
  step('log in as ada@example.com'),           // NL → planner (cached)
  goto('https://shop.example.com/cart'),        // deterministic goto
  fill('#card', '4242 4242 4242 4242'),          // deterministic fill
  click('#pay-button'),                          // deterministic click
  expectText('#total', 'Total: $42.00'),        // deterministic assertion
  expectCount('#items .item', 3),               // deterministic assertion
])
```

### Step kinds

| Constructor | Kind | How it runs |
|---|---|---|
| `step(text)` | `nl` | Plan with the model (or replay from cache) |
| `goto(url)` | `act` | `driver.goto(url)` |
| `click(sel)` | `act` | `driver.act({ action: 'click', sel })` |
| `fill(sel, value)` | `act` | `driver.act({ action: 'fill', sel, value })` |
| `expectText(sel, value)` | `expect` | `driver.find(sel)`, compare text |
| `expectCount(sel, n)` | `expect` | `driver.find(sel).count`, compare |
| `expectUrl(url)` | `expect` | `driver.url()` if the driver exposes it |

The runner dispatches on `step.kind`. `nl` steps go through the planner; the
rest go directly to the driver. A test that contains **no** `step()` calls
never constructs the planner and never touches the network — proven by the
unit tests.

## Record / replay

On every `nl` step the runner computes a fingerprint of the current page
snapshot (a SHA-256 of the sorted `{role, name}` pairs). A cached plan is
replayed only when **both** of these hold:

1. The fingerprint matches the recorded one (page has not changed).
2. Every recorded action executes without throwing on the re-resolved refs.

If either condition fails, the runner falls back to the model and re-records.
The cache file is atomic: writes go to a temp file then `rename()`.

## CLI

```
natl run    <file> [--config <p>] [--provider <p>] [--model <m>] [--report <f>] [--headed] [--mode auto|replay|record]
natl replay <file>
natl record <file>
natl init
natl --help
natl --version
```

Options:
- `--config` — path to `natl.config.json` (default: `./natl.config.json`)
- `--provider` — override provider from the config (`openai`, `anthropic`,
  `deepseek`, `ollama`)
- `--model` — override model name
- `--report` — write the JSON report to this path
- `--headed` — run the browser in headed mode (non-headless)

Modes:
- `auto` (default) — replay if the cache has a matching fingerprint, else plan
- `replay` — replay only; a miss fails the step (zero model calls guaranteed)
- `record` — always plan and record (never replay)

Exit codes:
- `0` — all tests passed
- `1` — one or more tests failed
- `2` — usage error (missing config, bad flag, missing test file)

## Provider table

| Provider | Env var | Base URL | Key required |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` | yes |
| `anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` | yes |
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | yes |
| `ollama` | (none) | `http://127.0.0.1:11434/v1` | no |

The CLI also reads `NATL_API_KEY`, `NATL_PROVIDER`, `NATL_MODEL`, and
`NATL_BASE_URL` as environment overrides.

## Web example

`examples/web/` contains a working example against a local static server:

```bash
node examples/web/server.mjs &
node bin/natl.js run examples/web/login.test.js
```

The fixture at `examples/web/fixture/index.html` is a self-contained login
page. The test mixes one `step()` with two deterministic assertions. Run it
twice — the second run prints `modelCalls=0`.

Run the acceptance test suite to verify the record/replay path:

```bash
PLAYWRIGHT_BROWSERS_PATH=$(pwd)/.browsers node --test test/e2e-web.test.js
```

## Mobile example

`examples/mobile/` contains the mobile test and a `README.md` with the exact
Appium setup commands.

This host is Linux with no Java, no `adb`, and no `/dev/kvm`. iOS (XCUITest)
requires macOS + Xcode — a hard blocker that cannot be worked around here.
Android can run on this host but requires the Android SDK, `adb`, and KVM.
The mobile driver is exercised against a fake WebDriver server in
`test/drivers/mobile.test.js` (13 tests, all passing), which proves the
request shapes, XML parsing, and action dispatch. A real-device run must be
executed on a host that has those tools.

## Architecture

```
bin/natl.js       — CLI (entry point)
src/runner.js     — test execution with record/replay
src/report.js     — terminal output + JSON serialization
src/steps.js      — step DSL constructors
src/planner.js    — NL step → action list via LLM tool-calling
src/prompt.js     — system + user prompt builder
src/llm.js        — provider table + HTTP callModel
src/http.js       — fetch with a deadline (no request may hang the CLI)
src/cache.js      — on-disk plan cache (lock file + atomic rename)
src/fingerprint.js — sha256 helpers for key + fingerprint
src/errors.js     — NatlError + utils
src/init.js       — setup wizard (`natl init`)
src/drivers/web.js   — Playwright driver (ariaSnapshotJSON, >= 1.63.0)
src/drivers/mobile.js — Appium W3C driver (raw HTTP over fetch)
examples/web/server.mjs   — static file server for the web example
examples/web/fixture/index.html — login fixture
examples/mobile/README.md   — mobile setup docs
```

There is no runtime dependency: the mobile driver speaks WebDriver over plain
`fetch`, and the planner speaks provider chat-completions over `fetch`, so no
vendor SDK is needed. `playwright` is an optional peer, required only for web
tests (install it in your project: `npm i -D playwright`); it needs >= 1.63.0
because the driver builds its element list from `page.ariaSnapshotJSON()`.

## Debugging

- `--report <path>` writes the full JSON report (including per-step `detail`
  messages) for post-hoc inspection.
- `natl record` forces a fresh plan on every step — useful when the cache is
  stale and you want to understand what the model is choosing.
- `NATL_FORCE=replay` is not a real flag; use `natl replay` instead. The
  runner never falls back to the model in replay mode, so a failure there
  proves the cache entry is wrong.

## Known limitations

- **English-only.** The prompt is written in English; non-English test authors
  should write their `step()` texts in English.
- **No parallel execution.** Tests run sequentially. Adding a test runner
  (e.g. `node --test --parallel`) is a future extension.
- **No visual/trace viewer.** The runner writes a JSON report (`--report`) but
  no screenshots or trace files. Adding Playwright Trace Viewer support is a
  low-effort extension — the web driver already has `page.screenshot()`
  available.
- **No CI integrations.** The runner exits with a standard exit code; wire it
  into CI however your pipeline works.
- **iOS on Linux impossible.** Documented above. Use a device cloud or macOS
  host for iOS tests.
