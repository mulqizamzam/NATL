// natl — report rendering.
//
// renderReport is the only thing a user sees and toJson is what --report writes,
// yet neither had a test of its own: the CLI test asserted /FAIL/ through them.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { renderReport, toJson } from '../src/report.js'

const base = {
  name: 'login flow',
  ok: true,
  modelCalls: 1,
  replayed: 0,
  recorded: 1,
  steps: [{ kind: 'nl', status: 'pass', detail: 'planned', ms: 5 }],
  error: null,
  cacheError: null,
}

test('renderReport says PASS for an ok report and FAIL with the reason otherwise', () => {
  assert.match(renderReport(base), /PASS login flow/)
  const failed = {
    ...base,
    ok: false,
    error: 'expectText: expected "x" but found ""',
    steps: [{ kind: 'nl', status: 'pass' }, { kind: 'expect', status: 'fail', detail: 'boom' }, { kind: 'expect', status: 'skip' }],
  }
  const out = renderReport(failed)
  assert.match(out, /FAIL login flow/)
  assert.match(out, /expectText: expected/)
  assert.match(out, /⊘ expect/, 'steps after the failure are shown as skipped')
  assert.doesNotMatch(out, /^PASS/m)
})

test('renderReport surfaces a cache error without calling the run failed', () => {
  const out = renderReport({ ...base, cacheError: 'EACCES: permission denied' })
  assert.match(out, /PASS login flow/)
  assert.match(out, /cacheError=EACCES/)
})

test('toJson round-trips the report, failure reason included', () => {
  const failed = { ...base, ok: false, error: 'boom', steps: [{ kind: 'nl', status: 'fail' }] }
  const parsed = JSON.parse(toJson(failed))
  assert.deepEqual(parsed, failed)
  assert.equal(parsed.error, 'boom')
})
