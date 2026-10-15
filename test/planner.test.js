/**
 * natl — planner tests (Task 2)
 *
 * callModel is injected via the `callModelOverride` param so no network is
 * touched. Covers: a valid 1-action plan; first call invalid -> second valid;
 * both calls invalid -> throw; a ref not present in the snapshot -> throw.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plan } from '../src/planner.js'
import { NatlError } from '../src/llm.js'

const SNAPSHOT = {
  elements: [
    { ref: '0', role: 'textbox', name: 'Email' },
    { ref: '1', role: 'textbox', name: 'Password' },
    { ref: '2', role: 'button', name: 'Sign In' },
  ],
  text: 'Email Password Sign In',
  fingerprint: 'deadbeef',
}

const PROVIDER = {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-test',
}

/** A valid plan matching SNAPSHOT. */
const VALID_PLAN = { actions: [{ action: 'click', ref: '2' }] }

/**
 * Build a callModelOverride that returns `responses` one per call and
 * records the options it was invoked with.
 */
function stubCallModel(responses) {
  const calls = []
  let i = 0
  const fn = async (opts) => {
    calls.push(opts)
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    if (typeof r === 'function') return r(opts)
    return { raw: JSON.stringify(r), parsed: r }
  }
  return { fn, calls }
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('planner — a valid 1-action plan returns that action', async () => {
  const { fn, calls } = stubCallModel([VALID_PLAN])

  const result = await plan({
    provider: PROVIDER,
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    driverName: 'web',
    callModelOverride: fn,
  })

  assert.equal(calls.length, 1, 'exactly one model call on the happy path')
  assert.deepEqual(result.actions, [{ action: 'click', ref: '2' }])
  assert.equal(result.provider, 'openai')
  assert.equal(result.model, 'gpt-4o')
})

test('planner — passes the instruction and snapshot context to callModel', async () => {
  const { fn, calls } = stubCallModel([VALID_PLAN])

  await plan({
    provider: PROVIDER,
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    driverName: 'web',
    callModelOverride: fn,
  })

  const opts = calls[0]
  assert.equal(opts.provider, 'openai')
  assert.equal(opts.model, 'gpt-4o')
  assert.ok(typeof opts.system === 'string' && opts.system.length > 0, 'system prompt present')
  assert.ok(opts.user.includes('click the sign in button'), 'user message carries the instruction')
  assert.ok(opts.user.includes('web'), 'user message carries the driver name')
  assert.ok(opts.user.includes('Sign In'), 'user message carries element names')
  assert.ok(opts.user.includes('Email Password Sign In'), 'user message carries page text')
})

// ---------------------------------------------------------------------------
// repair retry
// ---------------------------------------------------------------------------

test('planner — first response invalid, second valid -> succeeds with exactly 2 calls', async () => {
  const { fn, calls } = stubCallModel([{ notAnArray: true }, VALID_PLAN])

  const result = await plan({
    provider: PROVIDER,
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    driverName: 'web',
    callModelOverride: fn,
  })

  assert.equal(calls.length, 2, 'exactly one repair retry')
  assert.deepEqual(result.actions, [{ action: 'click', ref: '2' }])
})

test('planner — the repair retry actually changes the system prompt', async () => {
  const { fn, calls } = stubCallModel([{ notAnArray: true }, VALID_PLAN])

  await plan({
    provider: PROVIDER,
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    driverName: 'web',
    callModelOverride: fn,
  })

  assert.ok(
    calls[1].system.length > calls[0].system.length,
    'repair call must append to the system prompt',
  )
  assert.ok(
    calls[1].system.includes(calls[0].system),
    'repair system prompt must contain the original system prompt',
  )
})

test('planner — non-object parsed values are treated as invalid', async () => {
  for (const bad of [null, 'a string', 42, ['actions'], { actions: 'not-an-array' }, {}]) {
    const { fn, calls } = stubCallModel([bad, VALID_PLAN])
    const result = await plan({
      provider: PROVIDER,
      instruction: 'click the sign in button',
      snapshot: SNAPSHOT,
      driverName: 'web',
      callModelOverride: fn,
    })
    assert.equal(calls.length, 2, `bad payload ${JSON.stringify(bad)} must trigger one retry`)
    assert.deepEqual(result.actions, [{ action: 'click', ref: '2' }])
  }
})

// ---------------------------------------------------------------------------
// both calls fail
// ---------------------------------------------------------------------------

test('planner — both calls invalid -> throws after 2 attempts', async () => {
  const { fn, calls } = stubCallModel([{ notAnArray: true }, { stillNotAnArray: true }])

  await assert.rejects(
    () =>
      plan({
        provider: PROVIDER,
        instruction: 'click the sign in button',
        snapshot: SNAPSHOT,
        driverName: 'web',
        callModelOverride: fn,
      }),
    (e) => e instanceof NatlError && e.message === 'planner failed after 2 attempts',
  )

  assert.equal(calls.length, 2, 'must not attempt a third call')
})

// ---------------------------------------------------------------------------
// validation against the snapshot
// ---------------------------------------------------------------------------

test('planner — an action with a ref not in the snapshot throws', async () => {
  const { fn } = stubCallModel([{ actions: [{ action: 'click', ref: '99' }] }])

  await assert.rejects(
    () =>
      plan({
        provider: PROVIDER,
        instruction: 'click the sign in button',
        snapshot: SNAPSHOT,
        driverName: 'web',
        callModelOverride: fn,
      }),
    (e) => e instanceof NatlError && e.message === 'invalid ref in plan',
  )
})

test('planner — an unknown action name throws', async () => {
  const { fn } = stubCallModel([{ actions: [{ action: 'teleport', ref: '2' }] }])

  await assert.rejects(
    () =>
      plan({
        provider: PROVIDER,
        instruction: 'click the sign in button',
        snapshot: SNAPSHOT,
        driverName: 'web',
        callModelOverride: fn,
      }),
    (e) => e instanceof NatlError && /invalid action/.test(e.message),
  )
})

test('planner — every valid action name is accepted', async () => {
  for (const action of ['click', 'fill', 'clear', 'press', 'scroll', 'wait']) {
    const { fn } = stubCallModel([{ actions: [{ action, ref: '0', value: 'v' }] }])
    const result = await plan({
      provider: PROVIDER,
      instruction: 'do it',
      snapshot: SNAPSHOT,
      driverName: 'web',
      callModelOverride: fn,
    })
    assert.equal(result.actions[0].action, action)
  }
})

test('planner — an invalid ref does not trigger a repair retry', async () => {
  const { fn, calls } = stubCallModel([{ actions: [{ action: 'click', ref: '99' }] }])

  await assert.rejects(
    () =>
      plan({
        provider: PROVIDER,
        instruction: 'click the sign in button',
        snapshot: SNAPSHOT,
        driverName: 'web',
        callModelOverride: fn,
      }),
    (e) => e instanceof NatlError && e.message === 'invalid ref in plan',
  )

  assert.equal(calls.length, 1, 'a well-formed plan with a bad ref is a validation error, not a shape error')
})

// ---------------------------------------------------------------------------
// provider config passthrough
// ---------------------------------------------------------------------------

test('planner — accepts the frozen contract 6 `drivers` param (string or object)', async () => {
  // string form
  let { fn, calls } = stubCallModel([VALID_PLAN])
  await plan({
    provider: PROVIDER,
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    drivers: 'mobile',
    callModelOverride: fn,
  })
  assert.ok(calls[0].user.includes('mobile'), 'string drivers param feeds the prompt')

  // object form
  ;({ fn, calls } = stubCallModel([VALID_PLAN]))
  await plan({
    provider: PROVIDER,
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    drivers: { name: 'android' },
    callModelOverride: fn,
  })
  assert.ok(calls[0].user.includes('android'), 'object drivers param feeds the prompt')
})

test('planner — reports provider and model from the provider config', async () => {
  const { fn } = stubCallModel([VALID_PLAN])

  const result = await plan({
    provider: { provider: 'anthropic', model: 'claude-3-5-haiku', apiKey: 'sk-ant', baseUrl: undefined },
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    driverName: 'mobile',
    callModelOverride: fn,
  })

  assert.equal(result.provider, 'anthropic')
  assert.equal(result.model, 'claude-3-5-haiku')
})

// ---------------------------------------------------------------------------
// vacuous plans
// ---------------------------------------------------------------------------

test('planner - an empty actions array is not a valid plan: repair retry, then throw', async () => {
  // `{"actions":[]}` satisfies `Array.isArray`, so it used to pass validation,
  // execute zero actions, and be cached forever as a green step. The tool
  // schema already declares minItems:1, so the client must enforce it too.
  const { fn, calls } = stubCallModel([{ actions: [] }])

  await assert.rejects(
    plan({
      provider: PROVIDER,
      instruction: 'click the sign in button',
      snapshot: SNAPSHOT,
      callModelOverride: fn,
    }),
    (err) => err instanceof NatlError && /2 attempts/.test(err.message),
  )
  assert.equal(calls.length, 2, 'the empty plan must consume the one repair retry')
})

test('planner - a non-empty plan still wins after an empty first answer', async () => {
  const { fn, calls } = stubCallModel([{ actions: [] }, VALID_PLAN])

  const result = await plan({
    provider: PROVIDER,
    instruction: 'click the sign in button',
    snapshot: SNAPSHOT,
    callModelOverride: fn,
  })
  assert.deepEqual(result.actions, VALID_PLAN.actions)
  assert.equal(calls.length, 2)
})
