// FIRST import on purpose: it sets PLAYWRIGHT_BROWSERS_PATH during its own
// evaluation, which is the only moment playwright reads it.
import './helpers/browsers-path.js'
// Browser path comes from the helper imported above (see its header).
// Set it before anything imports playwright (src/drivers/web.js).


import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { startServer } from '../examples/web/server.mjs'
import { createWebDriver } from '../src/drivers/web.js'
import { runTest } from '../src/runner.js'
import { exampleTest } from '../examples/web/login.test.js'

// This test proves the natl example works end-to-end without any model call:
// a stub planner stands in for the LLM, so both the record and replay paths are
// exercised deterministically.
//
// The critical assertion is the second run: replaying against the same cache
// file must produce modelCalls === 0 and replayed === 1.

const FIXTURES_DIR = 'test/fixtures'
const CACHE_FILE = 'cache.json'

// Stands in for plan(): resolves refs from the live snapshot instead of asking
// a model. Returns the exact {actions: [...]} shape src/planner.js returns.
const planOverride = async ({ snapshot }) => {
  const email = snapshot.elements.find((e) => /email/i.test(e.name))
  const btn = snapshot.elements.find((e) => e.role === 'button')
  return {
    actions: [
      { action: 'fill', ref: email.ref, value: 'ada@example.com' },
      { action: 'click', ref: btn.ref },
    ],
    provider: 'stub',
    model: 'stub',
  }
}

let server
let port
let baseUrl
let driver
let tmpDir
let cachePath

before(async () => {
  await mkdir(FIXTURES_DIR, { recursive: true })
  tmpDir = await mkdtemp(join(FIXTURES_DIR, 'example-'))
  cachePath = join(tmpDir, CACHE_FILE)

  const started = await startServer({ port: 0 })
  server = started.server
  port = started.port

  baseUrl = `http://127.0.0.1:${port}`
  driver = createWebDriver({ url: baseUrl, headless: true })
  await driver.open()
})

after(async () => {
  if (driver) await driver.close()
  if (server) await new Promise((resolve) => server.close(resolve))
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

describe('example web (login.test.js) proves record-then-replay', () => {
  it('first run records the NL step and passes both assertions', async () => {
    // Each run starts where `natl run` starts: a fresh load of the base URL.
    // Run 1 signs in, which changes the screen; without this reset run 2 would
    // begin on the post-login page and never be a candidate for replay.
    await driver.goto(baseUrl)
    const report = await runTest(exampleTest, {
      driver,
      provider: { provider: 'stub', model: 'stub', apiKey: '' },
      cachePath,
      mode: 'auto',
      planOverride,
    })

    assert.equal(report.ok, true, `first run failed: ${JSON.stringify(report.error)}`)
    assert.ok(report.modelCalls >= 1, `expected modelCalls >= 1, got ${report.modelCalls}`)
  })

  it('second run replays from cache with zero model calls', async () => {
    await driver.goto(baseUrl)
    const report = await runTest(exampleTest, {
      driver,
      provider: { provider: 'stub', model: 'stub', apiKey: '' },
      cachePath,
      mode: 'auto',
      planOverride,
    })

    assert.equal(report.ok, true, `second run failed: ${JSON.stringify(report.error)}`)
    assert.equal(report.modelCalls, 0, `expected zero model calls on replay, got ${report.modelCalls}`)
    assert.equal(report.replayed, 1, `expected 1 replayed step, got ${report.replayed}`)
  })
})