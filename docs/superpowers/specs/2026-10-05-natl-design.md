# natl — Natural-language E2E testing for web and mobile

**Status:** design approved by operator directive ("kerjakan sampai selesai", goal `goal-d934ea5a`).
**Date:** 2026-10-05

## Problem

Writing end-to-end tests is expensive because selectors rot. A human must open the
app, find elements, and encode brittle CSS/XPath. The requirement is to let a user
write the *intent* in plain English and let a model figure out the elements, while
still allowing exact selectors and assertions when the user wants precision.

Two costs make this unusable as a pure model loop:

1. **Cost/latency.** Every NL step is a model round-trip, on every run.
2. **Non-determinism.** A model may pick a different element on the next run, so a
   passing test can fail randomly.

So the model must run **once**, then be **removed** from the hot path.

## Existing mechanism

None. `natl` is a new project; there is no prior code to preserve.

## Proposed change

A Node CLI + library with four decoupled parts:

| Part | Responsibility | Depends on |
|---|---|---|
| `src/steps.js` | Step DSL: NL steps and deterministic steps in one array | nothing |
| `src/drivers/*.js` | Driver contract + `web` (Playwright) and `mobile` (Appium W3C HTTP) | Playwright / Node fetch |
| `src/planner.js` | NL step → JSON action list, via a provider HTTP call | `fetch` |
| `src/cache.js` | Record/replay of action lists, keyed by step text + page fingerprint | nothing |
| `src/runner.js` | Executes a step array, enforces zero-model-calls when no NL steps exist | steps, drivers, planner, cache |

The dependency count is deliberately **two**: `playwright` (dev/example dependency,
optional at runtime) and nothing else. The mobile driver speaks WebDriver over
plain `fetch` so no `webdriverio`/`selenium-webdriver` is required. The planner
speaks provider chat-completions over `fetch`, so no vendor SDK is required.

## Key design decisions

### D1. The driver contract is element-source-based, not selector-based

The planner chooses an element from a **page snapshot** (an accessibility-ish
list of `{role, name, id, text, attrs}`), not a CSS selector. So the contract is:

```
snapshot()          -> Array<Element>     // what the model chooses from
act(action, el)     -> any                // click / fill / clear / tap / pressKey
```

Web implements `snapshot()` with Playwright locators evaluated per-role.
Mobile implements it with Appium `GET /session/:id/source` (XML) parsed into the
same shape. One shape, two drivers, and the model's prompt is driver-agnostic.

Rationale: a CSS selector cannot be produced by a model reliably from a screen,
and an accessibility-style snapshot can. It also makes replay store *intent*
(`click element with name "Sign in"`) instead of a locator string that breaks on
any DOM change.

### D2. Replay validity is a two-key check, not a single hash

A recorded action list is replayed only when **both** hold:

1. **Page fingerprint matches.** SHA-256 over `url + sorted [role,name] pairs`.
   The URL prevents replaying a plan from one page against another with the same
   element multiset; sorting prevents false negatives from element reordering.
2. **Replay executes without throwing.** If the recorded action raises (element
   gone, not clickable), the step falls back to the model.

If multiple current elements share the same `{role, name}` pair, the ref-map
disambiguates by **ordinal position within the group** (the Nth occurrence of
`{role,name}` in the recorded snapshot maps to the Nth occurrence on the live
page). A group-size mismatch falls back to first-match rather than throwing,
because a page that adds or removes one duplicate is not a semantic change.

Rationale: fingerprint equality does not prove the replay will succeed (an
element can exist but be disabled), and a throwing replay does not prove the app
changed (a transient timeout). Requiring both, then falling back, gives a single
rule that is correct in both failure directions. Fallback is always allowed and
always re-records.

### D3. Zero model calls is a structural property, not a runtime flag

A test whose steps contain **no** NL step never constructs a planner and never
touches the network. This is enforced by construction in `runner.js`: the planner
is created lazily, on first NL step. `runner.js` also returns
`modelCalls: 0` in its report, and a test asserts it.

Rationale: this is the user's explicit requirement #4 and it must hold even when
no API key is configured. A flag (`--no-model`) would be a weaker promise.

### D4. Three step kinds, one array

```js
test('checkout', [
  step('log in as ada@example.com'),          // NL  -> model (cached)
  click('#submit'),                            // deterministic
  expectText('#total', 'Total: $42.00'),      // deterministic
])
```

`step()` marks NL. `click/fill/expectText/expectCount/expectUrl` are
deterministic and take a CSS selector (web) or an XPath/automation-id (mobile).
The runner dispatches on the function, so mixing costs nothing.

### D5. Provider adapters are a table, not a class hierarchy

Four providers (openai, anthropic, deepseek, ollama) differ only in URL, auth
header, model name, and the JSON shape of the request/response. One function
`callModel(provider, messages)` with a `PROVIDERS` table covers all four in
~60 lines. Adding a fifth is a table row.

### D6. Mobile driver is raw WebDriver HTTP

Appium's W3C endpoints over `fetch`. No `webdriverio`. This keeps the dependency
count at one and works against a local Appium server, any device cloud, or a
real device, because they all speak the same protocol.

## Failure behavior

| Failure | Behavior |
|---|---|
| No API key, NL step present | Fail fast at planner creation, with a message naming the missing env var. Deterministic steps still run. |
| Model returns invalid JSON | One repair retry, then fail the step with the raw response (capped) for diagnosis. |
| Element not found during planning | Fail the step naming the snapshot that was offered. |
| Fingerprint mismatch | Re-plan with the model, re-record. Log `replay-miss (changed)`. |
| Replay throws | Re-plan with the model, re-record. Log `replay-miss (failed)`. |
| Model unreachable | Fail the step. A cached step must not silently pass. |
| Assertion fails | Fail the test, keep the remaining assertions from running (they would cascade), and write the failure to the report. |

## Compatibility and scope

- **In scope:** the CLI, DSL, both drivers, planner, cache, wizard, tests, docs,
  one working web example, one mobile example.
- **Out of scope:** parallel test execution, a visual/trace viewer, a hosted
  service, CI provider integrations, iOS on Linux (documented as impossible, not
  stubbed), non-English test authoring (the prompt is English-only).

## Data and state invariants

- The cache file is **append-only per step key**: a re-record replaces that
  step's entry, and never touches another step's entry. A partially written cache
  must not lose older entries, so writes go to a temp file then rename.
- The cache key is `sha256(stepText + '\n' + fingerprint)`, so an unchanged page
  reuses its plan and a changed page naturally gets a new key rather than an
  overwritten one. This means the cache is effectively append-only and old
  entries for changed pages remain for diagnosis.

## Alternatives rejected

- **Playwright MCP / browser-use as the agent loop.** Both hand the action loop
  to a third-party framework. That breaks the record/replay requirement, because
  we cannot intercept and persist their decisions without forking them, and it
  adds a large dependency. Rejected: our planner is ~100 lines.
- **Screenshot + vision instead of a DOM snapshot.** For web it is strictly worse
  (no text, slower, non-deterministic). For mobile it is the only fallback when
  the page source is empty (canvas/Flutter/Unity apps). Not implemented now;
  recorded as the documented extension point.
- **Storing CSS selectors in the cache.** Rejected: it is exactly the brittleness
  this tool exists to remove. See D1.
- **A test-runner dependency (`@playwright/test`, `vitest`).** Rejected: we need a
  custom runner for the zero-model-call guarantee and the replay path. Playwright
  is used as a library, not as a runner.

## Verification plan

1. Unit tests (`node --test`, no framework dependency) for: cache keying, replay
   hit/miss decision, zero-model-calls when no NL step, DSL dispatch, provider
   request shape per provider (with a stub `fetch`).
2. A real end-to-end web run against a local static HTML server, in three modes:
   first run (2 model calls, records), second run (`modelCalls: 0`, replays), and
   third run after mutating the HTML (fingerprint mismatch → falls back, then
   re-records).
3. The mobile example is run as far as this host allows. This host has no Java,
   no `adb`, and no Appium, and Linux cannot run XCUITest, so the mobile driver
   cannot be executed end-to-end here. What will be verified instead: the mobile
   driver is exercised against a **fake WebDriver HTTP server** implementing the
   W3C endpoints we use, which proves request shape, element-source parsing, and
   action dispatch. The real-device run is documented as a user step, not claimed
   as verified.

## Risks

- **Model picks a semantically wrong element** on first run and the test passes
  for the wrong reason. Mitigation: the assertion steps after an NL step are
  deterministic, so a wrong-but-passing path is still caught by them in practice;
  documented as a known limitation.
- **Fingerprint false-negative churn** if a page includes timestamps, random ids,
  or rotating banners in its element names. Mitigation: normalize volatile
  attributes (`id`, volatile text) is deliberately NOT done — instead the user
  is told to keep NL steps off pages with rotating content, and replay-miss is
  cheap (one extra model call), so churn costs money, not correctness.