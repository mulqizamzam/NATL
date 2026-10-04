// natl — runner: step-by-step test execution with record/replay.
//
// Reads a test object from src/steps.js, runs its steps against a driver,
// and records or replays NL step plans via the planner.

import { NatlError, isNatlError, describeError } from './errors.js'
import { plan } from './planner.js'
import {
  loadCache,
  cacheLookup,
  cacheRecord,
  saveCache,
} from './cache.js'
import { makeCacheKey } from './fingerprint.js'

const DEFAULTS = { mode: 'auto', planOverride: null, driverName: null }

/**
 * Run one test object and return a report.
 *
 * @param {object} testObj - {kind:'test', name, steps}
 * @param {object}  opts.driver        - Driver instance (frozen contract 3)
 * @param {object}  opts.provider      - {provider, model, apiKey, baseUrl} or null (no model calls)
 * @param {string}  opts.cachePath     - Path to the on-disk cache JSON
 * @param {string}  [opts.mode]        - 'auto' | 'replay' | 'record'
 * @param {Function} [opts.planOverride] - Optional stub that returns {actions}
 * @param {string}  [opts.driverName]   - Label passed to the planner
 * @returns {object} report
 */
export async function runTest(testObj, opts) {
  const { driver, provider, cachePath, mode, planOverride, driverName } = {
    ...DEFAULTS,
    ...opts,
  }

  const report = {
    name: testObj.name,
    ok: true,
    modelCalls: 0,
    replayed: 0,
    recorded: 0,
    steps: [],
    error: null,
    cacheError: null,
  }

  // Load the cache once before any step runs.
  let cache
  try {
    cache = await loadCache(cachePath)
  } catch (err) {
    report.cacheError = describeError(err)
    report.ok = false
    report.error = `failed to load cache: ${describeError(err)}`
    return report
  }

  const steps = testObj.steps
  const driverLabel = driverName ?? driver.driverName ?? 'web'

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const start = performance.now()
    const entry = { kind: step.kind }

    try {
      if (step.kind === 'nl') {
        const snap = await driver.snapshot()
        let planResult = null

        if (mode !== 'record') {
          const hit = cacheLookup(cache, step.text, snap.fingerprint)
          if (hit) {
            planResult = { actions: hit.actions, provider: hit.provider, model: hit.model }
            // remap recorded refs to current refs by matching {role, name}
            const refMap = remapRefs(hit.elements, snap.elements)
            for (const act of planResult.actions) {
              const newRef = refMap.get(act.ref)
              if (newRef === undefined) {
                // element gone — fall through to plan
                planResult = null
                entry.detail = 'replay-miss (changed)'
                break
              }
              try {
                await driver.act({ ...act, ref: newRef })
              } catch (err) {
                // action threw — fall through to plan
                planResult = null
                entry.detail = 'replay-miss (failed)'
                break
              }
            }
            if (planResult !== null) {
              report.replayed++
            }
          }
        }

        if (!planResult) {
          if (mode === 'replay') {
            throw new NatlError(
              `replay miss: no cached plan for "${step.text}" (use mode auto or record)`,
            )
          }
          if (!provider) {
            throw new NatlError('no provider configured — cannot execute NL step')
          }
          planResult = await (planOverride ?? plan)({
            provider,
            instruction: step.text,
            snapshot: snap,
            driverName: driverLabel,
          })
          report.modelCalls++
          cacheRecord(cache, {
            key: makeCacheKey(step.text, snap.fingerprint),
            stepText: step.text,
            fingerprint: snap.fingerprint,
            elements: snap.elements,
            actions: planResult.actions,
            provider: planResult.provider,
            model: planResult.model,
            recordedAt: new Date().toISOString(),
          })
          report.recorded++
          // Run the planned actions (remap refs to current snapshot if page changed).
          const snap2 = await driver.snapshot()
          const refMap = buildRefMap(planResult.actions, snap.elements, snap2.elements)
          for (const act of planResult.actions) {
            const newRef = refMap.get(act.ref)
            if (newRef === undefined) {
              throw new NatlError(`planned ref ${act.ref} not found in snapshot`)
            }
            await driver.act({ ...act, ref: newRef })
          }
          entry.detail = 'planned'
        } else {
          entry.detail = entry.detail ?? 'replayed'
        }
        entry.status = 'pass'
      } else if (step.kind === 'act') {
        if (step.fn === 'goto') {
          await driver.goto(step.url)
          entry.status = 'pass'
        } else {
          // Deterministic action step: pass the selector directly via `sel`.
          // Both drivers handle this path without the ref/fingerprint machinery.
          await driver.act({ action: step.fn, sel: step.sel, value: step.value })
          entry.status = 'pass'
        }
      } else if (step.kind === 'expect') {
        const { text, count } = await driver.find(step.sel)
        if (step.fn === 'expectText') {
          if (count === 0) {
            throw new NatlError(`expectText: selector matched 0 elements: ${step.sel}`)
          }
          const actual = text.trim()
          if (step.value instanceof RegExp) {
            if (!step.value.test(actual)) {
              throw new NatlError(`expectText: ${step.value} did not match "${actual}" for ${step.sel}`)
            }
          } else if (actual !== String(step.value)) {
            throw new NatlError(
              `expectText: expected "${step.value}" but found "${actual}" for ${step.sel}`,
            )
          }
          entry.status = 'pass'
        } else if (step.fn === 'expectCount') {
          if (count !== Number(step.value)) {
            throw new NatlError(
              `expectCount: expected ${step.value} but found ${count} for ${step.sel}`,
            )
          }
          entry.status = 'pass'
        } else if (step.fn === 'expectUrl') {
          if (typeof driver.url === 'function') {
            const current = await driver.url()
            if (current !== step.value) {
              throw new NatlError(`expectUrl: expected ${step.value} but got ${current}`)
            }
          } else {
            entry.status = 'skip'
            entry.detail = 'expectUrl skipped (driver has no url())'
          }
        }
      }
    } catch (err) {
      entry.status = 'fail'
      entry.detail = describeError(err).slice(0, 200)
      report.steps.push(entry)
      report.ok = false
      report.error = entry.detail
      // Mark remaining steps as skipped.
      for (let j = i + 1; j < steps.length; j++) {
        report.steps.push({ kind: steps[j].kind, status: 'skip' })
      }
      break
    }

    entry.ms = Math.round(performance.now() - start)
    report.steps.push(entry)
  }

  // Always attempt to persist the cache; a write failure is surfaced in
  // report.cacheError but must not mask a test failure.
  try {
    await saveCache(cache, cachePath)
  } catch (err) {
    report.cacheError = describeError(err)
    // Do not change report.ok — the test ran successfully, caching just failed.
  }

  return report
}

// --- internals ---

/**
 * Build a ref-map from plan-result refs to current snapshot refs by matching
 * {role, name} pairs. Returns a Map<oldRef, newRef>.
 */
function buildRefMap(actions, prevElements, currentElements) {
  // Collect the {role, name} of every action's ref from the plan's snapshot.
  const needed = new Map()
  for (const act of actions) {
    const el = prevElements.find((e) => e.ref === act.ref)
    if (el) needed.set(act.ref, el)
  }
  const refMap = new Map()
  for (const [prevRef, prevEl] of needed) {
    const currentEl = currentElements.find(
      (e) => e.role === prevEl.role && e.name === prevEl.name,
    )
    if (currentEl) refMap.set(prevRef, currentEl.ref)
  }
  return refMap
}

/**
 * Remap recorded refs to current refs for replay. Returns Map<oldRef, newRef>.
 */
function remapRefs(prevElements, currentElements) {
  const refMap = new Map()
  for (const prevEl of prevElements) {
    const cur = currentElements.find(
      (e) => e.role === prevEl.role && e.name === prevEl.name,
    )
    if (cur) refMap.set(prevEl.ref, cur.ref)
  }
  return refMap
}

export default { runTest }