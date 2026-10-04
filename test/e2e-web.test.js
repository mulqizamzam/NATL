// natl — end-to-end acceptance for record/replay against a REAL browser.
//
// This is the test that proves requirement #3 (replay without the model) and
// requirement #4 (selector-only tests make zero model calls).

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/home/administrator/agent-workspace/project/natl/.browsers'

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../examples/web/server.mjs'
import { createWebDriver } from '../src/drivers/web.js'
import { runTest } from '../src/runner.js'
import { test as testCtor, step, expectText, expectCount } from '../src/steps.js'

const provider = { provider: 'deepseek', model: 'test-model', apiKey: 'not-a-real-key' }

/**
 * Stub planner. Resolve refs from the LIVE snapshot it is handed so the test
 * is not brittle to element ordering.
 * Signature must match plan(): a single options object.
 */
function stubPlanner() {
  return async ({ snapshot }) => {
    const match = (re) => snapshot.elements.find((e) => re.test(`${e.role} ${e.name}`))
    const email = match(/textbox|email/i)
    const button = match(/button/i)
    const actions = []
    if (email) actions.push({ action: 'fill', ref: email.ref, value: 'ada@example.com' })
    if (button) actions.push({ action: 'click', ref: button.ref })
    assert.ok(actions.length > 0, `stub planner found no elements; got ${JSON.stringify(snapshot.elements)}`)
    return { actions, provider: 'deepseek', model: 'test-model' }
  }
}

const loginTest = () =>
  testCtor('login flow', [
    step('type ada@example.com in the email field and click Sign In'),
    expectText('#status', 'Welcome, ada@example.com'),
    expectCount('#items .item', 2),
  ])

async function withHarness(fn) {
  const { server, port } = await startServer({ port: 0 })
  const url = `http://127.0.0.1:${port}`
  const dir = await mkdtemp(join(tmpdir(), 'natl-e2e-'))
  const cachePath = join(dir, 'cache.json')
  const driver = createWebDriver({ url, headless: true })
  await driver.open()
  try {
    await fn({ driver, cachePath, url })
  } finally {
    await driver.close()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('e2e: NL step plans on first run then replays with modelCalls === 0', async () => {
  await withHarness(async ({ driver, cachePath, url }) => {
    const first = await runTest(loginTest(), {
      driver, provider, cachePath, mode: 'record', planOverride: stubPlanner(),
    })

    assert.equal(first.ok, true, `first run should pass, got: ${first.error}`)
    assert.equal(first.modelCalls, 1, 'first run must call the model exactly once')
    assert.equal(first.recorded, 1, 'first run must record the plan')
    assert.equal(first.replayed, 0, 'first run must not replay')

    // Second run against the same cache. The plan must be replayed.
    await driver.goto(url)
    const second = await runTest(loginTest(), {
      driver, provider, cachePath, mode: 'auto', planOverride: stubPlanner(),
    })

    assert.equal(second.ok, true, `second run should pass, got: ${second.error}`)
    assert.equal(second.replayed, 1, 'second run must replay the recorded plan')
    assert.equal(second.modelCalls, 0, 'second run must make ZERO model calls')
    assert.equal(second.recorded, 0, 'second run must not re-record')
  })
})

test('e2e: replay mode after record makes zero model calls', async () => {
  await withHarness(async ({ driver, cachePath, url }) => {
    await runTest(loginTest(), {
      driver, provider, cachePath, mode: 'record', planOverride: stubPlanner(),
    })

    await driver.goto(url)
    const replayRun = await runTest(loginTest(), {
      driver,
      provider,
      cachePath,
      mode: 'replay',
      // A replay-mode run must never reach the planner. Throwing here makes a
      // regression loud instead of silently falling back to a model call.
      planOverride: async () => { throw new Error('planner must not be called in replay mode') },
    })

    assert.equal(replayRun.ok, true, `replay run should pass, got: ${replayRun.error}`)
    assert.equal(replayRun.modelCalls, 0, 'replay mode must make zero model calls')
    assert.equal(replayRun.replayed, 1, 'replay mode must replay the recorded step')
  })
})

test('e2e: a changed page falls back to the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'natl-e2e-changed-'))
  const cachePath = join(dir, 'cache.json')
  const fixturePath = join(import.meta.dirname, '..', 'examples', 'web', 'fixture', 'index.html')
  const { readFile, writeFile } = await import('node:fs/promises')
  const original = await readFile(fixturePath, 'utf8')

  const { server, port } = await startServer({ port: 0 })
  const url = `http://127.0.0.1:${port}`
  const driver = createWebDriver({ url, headless: true })
  await driver.open()
  try {
    // Record against the original fixture.
    await runTest(loginTest(), {
      driver, provider, cachePath, mode: 'record', planOverride: stubPlanner(),
    })

    // Mutate the fixture on disk: remove the email input.
    await writeFile(
      fixturePath,
      original.replace(/<input[^>]*id="email"[^>]*>[^]*?>/i, '<!-- email removed -->'),
    )

    // Re-open the page so the browser sees the mutated fixture.
    await driver.goto(url)

    let planned = 0
    const report = await runTest(loginTest(), {
      driver,
      provider,
      cachePath,
      mode: 'auto',
      planOverride: async (opts) => {
        planned++
        const hasEmail = opts.snapshot.elements.some((e) => /textbox|email/i.test(`${e.role} ${e.name}`))
        assert.equal(hasEmail, false, 'the mutated fixture must omit the email input')
        const btn = opts.snapshot.elements.find((e) => e.role === 'button')
        assert.ok(btn, 'the button must still exist after mutation')
        return { actions: [{ action: 'click', ref: btn.ref }], provider: 'deepseek', model: 'test-model' }
      },
    })

    assert.equal(planned, 1, 'a changed page must trigger exactly one new plan')
    assert.equal(report.modelCalls, 1, 'modelCalls must be 1 after a fingerprint change')
  } finally {
    await driver.close()
    server.close()
    await rm(dir, { recursive: true, force: true })
    // Restore the original fixture so no other test is poisoned.
    await writeFile(fixturePath, original)
  }
})

test('e2e: selector-only test makes zero model calls', async () => {
  await withHarness(async ({ driver, cachePath }) => {
    const selectorOnly = testCtor('no model at all', [
      expectCount('#items .item', 2),
      expectCount('#items .item', 3), // intentionally wrong: proves assertions really run
    ])

    const report = await runTest(selectorOnly, {
      driver,
      provider,
      cachePath,
      mode: 'auto',
      planOverride: async () => { throw new Error('no model call may happen for selector-only tests') },
    })

    assert.equal(report.ok, false, 'the wrong count assertion must fail')
    assert.equal(report.modelCalls, 0, 'selector-only tests must make zero model calls')
    assert.equal(report.steps[0].status, 'pass')
    assert.equal(report.steps[1].status, 'fail')
    assert.ok(report.error, 'the failure must carry an error message')
  })
})