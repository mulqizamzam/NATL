// natl — runner unit tests.

// Fake driver implementing frozen contract 3, used across all tests.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { runTest } from '../src/runner.js'
import { test as testCtor, step, click, fill, expectText, expectCount, expectUrl, goto } from '../src/steps.js'
import { loadCache, saveCache, cacheLookup, cacheRecord } from '../src/cache.js'
import { makeFingerprint } from '../src/fingerprint.js'

function makeFakeDriver(elements) {
  let currentElements = elements
  return {
    driverName: 'fake',
    _elements: currentElements,
    async open() {},
    async close() {},
    async snapshot() {
      return {
        elements: currentElements.map((e, i) => ({ ref: String(i), role: e.role, name: e.name })),
        text: currentElements.map((e) => e.name).join('\n'),
        fingerprint: makeFingerprint(currentElements.map((e, i) => ({ ref: String(i), role: e.role, name: e.name }))),
      }
    },
    async act(action) {
      const { ref, value, sel } = action
      const n = currentElements.length
      if (sel !== undefined) return // selector-based act is a no-op in the fake
      if (ref !== undefined && String(ref) >= String(n)) {
        throw new Error(`ref ${ref} not in snapshot`)
      }
      return
    },
    async goto(url) {},
    async find(selector) {
      // Return a fake result based on selector matching.
      if (selector.includes('#missing')) return { text: '', count: 0 }
      if (selector.includes('#items')) return { text: 'x', count: 2 }
      if (selector === '#status') return { text: 'Welcome', count: 1 }
      return { text: 'OK', count: 1 }
    },
  }
}

const elements = [
  { role: 'textbox', name: 'email' },
  { role: 'button', name: 'Sign In' },
  { role: 'text', name: 'Welcome' },
]

const cacheDir = '/tmp/natl-runner-test-' + Date.now()
import { mkdirSync } from 'node:fs'
mkdirSync(cacheDir, { recursive: true })
const cachePath = `${cacheDir}/cache.json`

test('no NL steps: planner is never called, modelCalls === 0', async () => {
  const driver = makeFakeDriver(elements)
  const testObj = testCtor('deterministic-only', [
    goto('http://example.com'),
    expectText('#status', 'Welcome'),
    expectCount('#items .item', 2),
  ])

  let plannerCalled = false
  const report = await runTest(testObj, {
    driver,
    provider: null,
    cachePath,
    mode: 'auto',
    planOverride: async () => { plannerCalled = true; throw new Error('planner should not be called') },
  })

  assert.equal(report.modelCalls, 0, 'modelCalls must be 0 when no NL steps exist')
  assert.equal(report.ok, true, 'test should pass')
  assert.equal(plannerCalled, false, 'planner must never be called for deterministic-only tests')
})

test('replay mode with empty cache: NL step throws, modelCalls === 0', async () => {
  const driver = makeFakeDriver(elements)
  const testObj = testCtor('replay-miss', [step('do something')])

  const emptyCache = { version: 1, entries: {} }
  await saveCache(emptyCache, cachePath)

  let modelCalls = 0
  const report = await runTest(testObj, {
    driver,
    provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://test' },
    cachePath,
    mode: 'replay',
    planOverride: async () => { modelCalls++; return { actions: [], provider: 'deepseek', model: 'test' } },
  })

  assert.equal(report.ok, false, 'replay miss should fail the test')
  assert.equal(report.modelCalls, 0, 'replay mode must never call the model')
  assert.equal(modelCalls, 0, 'planner must never be called in replay mode')
})

test('NL step first run: plans and records, modelCalls === 1', async () => {
  const driver = makeFakeDriver(elements)
  const testObj = testCtor('record', [step('do something')])

  const freshCachePath = `${cacheDir}/fresh.json`
  const { loadCache: l2, saveCache: s2, cacheRecord: r2 } = await import('../src/cache.js')
  const freshCache = await l2(freshCachePath)
  assert.equal(Object.keys(freshCache.entries).length, 0)

  let modelCalls = 0
  const report = await runTest(testObj, {
    driver,
    provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://test' },
    cachePath: freshCachePath,
    mode: 'record',
    planOverride: async (_p, instruction, snapshot) => {
      modelCalls++
      return {
        actions: [{ action: 'click', ref: '1' }],
        provider: 'deepseek',
        model: 'test',
      }
    },
  })

  assert.equal(report.modelCalls, 1)
  assert.equal(report.recorded, 1)
  assert.equal(report.ok, true)

  // Verify the cache file now has one entry.
  const cached = await l2(freshCachePath)
  assert.equal(Object.keys(cached.entries).length, 1, 'cache should have one entry after record')
})

test('second run with same fingerprint: replays, modelCalls === 0', async () => {
  const driver = makeFakeDriver(elements)
  const testObj = testCtor('replay-hit', [step('do something')])

  const freshCachePath = `${cacheDir}/replay-hit.json`
  // Pre-seed the cache with a correctly-keyed matching entry.
  const snap = await driver.snapshot()
  const { cacheRecord: r, saveCache: s, loadCache: l, cacheLookup: lookup } = await import('../src/cache.js')
  const cache = await l(freshCachePath)
  r(cache, {
    stepText: 'do something',
    fingerprint: snap.fingerprint,
    elements: snap.elements,
    actions: [{ action: 'click', ref: '1' }],
    provider: 'deepseek',
    model: 'test',
    recordedAt: new Date().toISOString(),
  })
  await s(cache, freshCachePath)

  // Prove the seed is actually a hit before relying on the replay assertion.
  const reloaded = await l(freshCachePath)
  assert.ok(lookup(reloaded, 'do something', snap.fingerprint), 'seeded entry must be a cache hit')

  let modelCalls = 0
  const report = await runTest(testObj, {
    driver,
    provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://test' },
    cachePath: freshCachePath,
    mode: 'auto',
    planOverride: async () => { modelCalls++; return { actions: [], provider: 'deepseek', model: 'test' } },
  })

  assert.equal(report.replayed, 1, 'one NL step should be replayed')
  assert.equal(report.modelCalls, 0, 'replay must not call the model')
  assert.equal(modelCalls, 0, 'planner must not be called on a cache hit')
  assert.equal(report.ok, true)
})

test('changed page fingerprint: replays nothing, plans again', async () => {
  const driver = makeFakeDriver(elements)
  const testObj = testCtor('fingerprint-change', [step('do something')])

  const changedCachePath = `${cacheDir}/changed.json`
  // Seed cache with a fingerprint that won't match the current snapshot.
  const snap = await driver.snapshot()
  const { cacheRecord: r, saveCache: s, loadCache: l } = await import('../src/cache.js')
  const cache = await l(changedCachePath)
  r(cache, {
    key: `${step('do something').text}`,
    stepText: 'do something',
    fingerprint: 'stale-fingerprint', // won't match any current snapshot
    elements: snap.elements,
    actions: [{ action: 'click', ref: '1' }],
    provider: 'deepseek',
    model: 'test',
    recordedAt: new Date().toISOString(),
  })
  await s(cache, changedCachePath)

  let modelCalls = 0
  const report = await runTest(testObj, {
    driver,
    provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://test' },
    cachePath: changedCachePath,
    mode: 'auto',
    planOverride: async () => {
      modelCalls++
      return { actions: [{ action: 'click', ref: '1' }], provider: 'deepseek', model: 'test' }
    },
  })

  assert.equal(modelCalls, 1, 'stale fingerprint must trigger a model call')
  assert.equal(report.modelCalls, 1)
  assert.equal(report.recorded, 1, 'new fingerprint must be recorded')
})

test('failing expectText: ok=false, remaining steps skipped', async () => {
  const driver = makeFakeDriver(elements)
  const testObj = testCtor('fail', [
    expectText('#missing', 'X'),  // fails: count 0
    expectText('#items', 'OK'),
  ])

  const report = await runTest(testObj, {
    driver,
    provider: null,
    cachePath: `${cacheDir}/fail.json`,
    mode: 'auto',
  })

  assert.equal(report.ok, false)
  assert.equal(report.steps[0].status, 'fail')
  assert.equal(report.steps[1].status, 'skip', 'subsequent steps must be skipped')
  assert.ok(report.error, 'report must carry an error message')
})
test('expectUrl asserts against driver.url() instead of silently skipping', async () => {
  // Regression guard: expectUrl carries no selector. The runner used to call
  // find(undefined) first and crash, or skip when url() was absent.
  const driver = makeFakeDriver(elements)
  driver.url = async () => 'https://app.example.com/dashboard'

  const pass = await runTest(testCtor('url-match', [expectUrl('https://app.example.com/dashboard')]), {
    driver, provider: null, cachePath: `${cacheDir}/url-pass.json`, mode: 'auto',
  })
  assert.equal(pass.ok, true, 'matching URL must pass')
  assert.equal(pass.steps[0].status, 'pass')

  const fail = await runTest(testCtor('url-mismatch', [expectUrl('https://app.example.com/other')]), {
    driver, provider: null, cachePath: `${cacheDir}/url-fail.json`, mode: 'auto',
  })
  assert.equal(fail.ok, false, 'mismatched URL must FAIL, not skip')
  assert.equal(fail.steps[0].status, 'fail')
  assert.match(fail.error, /expectUrl/, 'failure must name the assertion')
})

test('a plan that throws while executing is NOT recorded to the cache', async () => {
  // Regression guard: the plan used to be cached before its actions ran, so a
  // plan that failed mid-flight poisoned every later replay.
  const driver = makeFakeDriver(elements)
  const cachePathThrow = `${cacheDir}/not-recorded.json`
  const { loadCache: l, cacheLookup: lookup } = await import('../src/cache.js')

  const snap = await driver.snapshot()
  const report = await runTest(testCtor('plan-throws', [step('do something')]), {
    driver,
    provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://test' },
    cachePath: cachePathThrow,
    mode: 'record',
    planOverride: async () => ({ actions: [{ action: 'click', ref: '99' }], provider: 'deepseek', model: 'test' }),
    // ref '99' does not exist in elements, so driver.act() throws at execution.
  })

  const cache = await l(cachePathThrow)
  const hit = lookup(cache, 'do something', snap.fingerprint)
  assert.equal(hit, null, 'a plan whose actions threw must not be cached')
  assert.equal(report.recorded, 0, 'report.recorded must stay 0 when execution failed')
  assert.equal(report.ok, false, 'the test must fail when an action throws')
})

test('duplicate {role,name} elements: ordinal disambiguation maps Nth→Nth, not always first', async () => {
  // Regression guard: the ref-map used to collapse every same-named element to
  // the first match, silently driving the wrong DOM node. It now disambiguates
  // by ordinal position within the {role,name} group.
  // Fixture: two identical "Next" buttons + one unique email field.
  const dupElements = [
    { role: 'textbox', name: 'email' },
    { role: 'button', name: 'Next' },   // ref 1
    { role: 'button', name: 'Next' },   // ref 2 — identical to ref 1
  ]
  const driver = makeFakeDriver(dupElements)
  const dupCache = `${cacheDir}/dup.json`
  const { loadCache: l, cacheLookup: lookup } = await import('../src/cache.js')

  const snap = await driver.snapshot()
  // Target the SECOND "Next" (ref '2'), not the first.
  const report = await runTest(testCtor('dup', [step('go')]), {
    driver,
    provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://test' },
    cachePath: dupCache,
    mode: 'record',
    planOverride: async () => ({ actions: [{ action: 'click', ref: '2' }], provider: 'deepseek', model: 'test' }),
  })

  assert.equal(report.ok, true, 'record run with duplicate elements must succeed')
  // Verify the cache recorded ref '2', not ref '1'.
  const cache = await l(dupCache)
  const hit = lookup(cache, 'go', snap.fingerprint)
  assert.ok(hit, 'plan must be recorded')
  assert.equal(hit.actions[0].ref, '2', 'recorded plan must target ref 2 (the second Next)')
})

test('record → replay across two separate processes: second process reads cache from disk', async () => {
  // Regression guard: replay must work from a COLD start (no in-memory state).
  // This spawns a real child process for the record run, then another for the
  // replay run, proving the on-disk cache is the actual persistence mechanism.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)

  const crossCache = `${cacheDir}/cross-process.json`
  const planScript = `
    import { runTest } from '${process.cwd()}/src/runner.js'
    import { test, step } from '${process.cwd()}/src/steps.js'
    const els = [
      { role: 'textbox', name: 'email' },
      { role: 'button', name: 'Submit' },
    ]
    const driver = {
      driverName: 'fake',
      async open() {}, async close() {},
      async snapshot() {
        const { makeFingerprint } = await import('${process.cwd()}/src/fingerprint.js')
        const e = els.map((e, i) => ({ ref: String(i), ...e }))
        return { elements: e, text: els.map(x => x.name).join('\\n'),
                 fingerprint: makeFingerprint(e) }
      },
      async act(a) {
        if (a.ref !== undefined && Number(a.ref) >= els.length)
          throw new Error('ref out of range')
      },
      async goto() {},
      async find() { return { text: '', count: 0 } },
    }
    const report = await runTest(test('cross', [step('login')]), {
      driver,
      provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://t' },
      cachePath: '${crossCache}',
      mode: process.argv[2] || 'auto',
      planOverride: async ({ snapshot }) => ({
        actions: [{ action: 'fill', ref: '0', value: 'x' }, { action: 'click', ref: '1' }],
        provider: 'deepseek', model: 'test',
      }),
    })
    console.log(JSON.stringify({ ok: report.ok, modelCalls: report.modelCalls,
                                 replayed: report.replayed, recorded: report.recorded }))
  `
  const scriptPath = `${cacheDir}/cross-process-runner.mjs`
  await (await import('node:fs/promises')).writeFile(scriptPath, planScript, 'utf8')

  // Process 1: record mode
  const { stdout: out1 } = await exec('node', [scriptPath, 'record'])
  const r1 = JSON.parse(out1.trim())
  assert.equal(r1.ok, true, 'record process must pass')
  assert.equal(r1.recorded, 1, 'record process must record 1 plan')
  assert.equal(r1.modelCalls, 1, 'record process must call the model')

  // Process 2: replay mode (cold start — no in-memory cache)
  const { stdout: out2 } = await exec('node', [scriptPath, 'replay'])
  const r2 = JSON.parse(out2.trim())
  assert.equal(r2.ok, true, 'replay process must pass from cold start')
  assert.equal(r2.modelCalls, 0, 'replay process must make ZERO model calls')
  assert.equal(r2.replayed, 1, 'replay process must replay from disk')
})

test('concurrent record runs do not lose each other\'s entries', async () => {
  // Two separate cache files, each recorded by its own driver instance that
  // snapshots a different element set. Run them concurrently — both must
  // survive. This proves the deferred loadSave in runner.js resolves the
  // lost-update race: last-writer no longer overwrites the first writer's entry.
  const A = [
    { role: 'textbox', name: 'email' },
    { role: 'button', name: 'Go' },
  ]
  const B = [
    { role: 'textbox', name: 'user' },
    { role: 'button', name: 'Start' },
  ]

  const mkDriver = (els) => ({
    driverName: 'fake',
    async open() {},
    async close() {},
    async snapshot() {
      return {
        elements: els.map((e, i) => ({ ref: String(i), role: e.role, name: e.name })),
        text: '',
        fingerprint: makeFingerprint(els.map((e, i) => ({ ref: String(i), role: e.role, name: e.name }))),
      }
    },
    async act() {},
    async goto() {},
    async find() { return { text: '', count: 0 } },
  })

  const cacheA = `${cacheDir}/race-a.json`
  const cacheB = `${cacheDir}/race-b.json`

  // Wait for both runs to settle — loadSave may back off on contention.
  await Promise.all([
    runTest(testCtor('concurrent-A', [step('log in')]), {
      driver: mkDriver(A),
      provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://t' },
      cachePath: cacheA,
      mode: 'record',
      planOverride: async ({ snapshot }) => ({
        actions: [{ action: 'click', ref: '1' }],
        provider: 'deepseek',
        model: 'test',
      }),
    }),
    runTest(testCtor('concurrent-B', [step('log in')]), {
      driver: mkDriver(B),
      provider: { provider: 'deepseek', model: 'test', apiKey: 'x', baseUrl: 'http://t' },
      cachePath: cacheB,
      mode: 'record',
      planOverride: async ({ snapshot }) => ({
        actions: [{ action: 'click', ref: '1' }],
        provider: 'deepseek',
        model: 'test',
      }),
    }),
  ])

  const loadedA = await loadCache(cacheA)
  const loadedB = await loadCache(cacheB)
  assert.equal(Object.keys(loadedA.entries).length, 1, 'run A\'s entry must survive')
  assert.equal(Object.keys(loadedB.entries).length, 1, 'run B\'s entry must survive')
  assert.equal(loadedA.entries[Object.keys(loadedA.entries)[0]].stepText, 'log in')
  assert.equal(loadedB.entries[Object.keys(loadedB.entries)[0]].stepText, 'log in')
})
