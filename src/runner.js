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
  loadSave,
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

  // Load the cache once before any step runs. Collect mutations for an
  // atomic loadSave at the end — this avoids the lost-update race where two
  // concurrent natl runs each load a stale snapshot and the last writer wins.
  let cache
  const pendingRecords = [] // { entry } collected during the run
  try {
    cache = await loadCache(cachePath)
  } catch (err) {
    report.cacheError = describeError(err)
    report.ok = false
    report.error = `failed to load cache: ${describeError(err)}`
    return report
  }

  const steps = testObj.steps
  // `test(name)` without a steps array used to reach `steps.length` outside the
  // try block and throw a bare TypeError past the runner, which the CLI reports
  // as a crash instead of a failing test.
  if (!Array.isArray(steps)) {
    report.ok = false
    report.error = `test "${report.name}" has no steps array — use test(name, [ ... ])`
    return report
  }
  const driverLabel = driverName ?? driver.driverName ?? 'web'

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const start = performance.now()
    const entry = { kind: step.kind }

    try {
      if (step.kind === 'nl') {
        let snap = await driver.snapshot()
        let planResult = null

        if (mode !== 'record') {
          const hit = cacheLookup(cache, step.text, snap.fingerprint)
          if (hit) {
            planResult = { actions: hit.actions, provider: hit.provider, model: hit.model }
            // remap recorded refs to current refs by matching {role, name}
            const refMap = remapRefs(hit.elements, snap.elements)
            let replayedAll = true
            for (const act of planResult.actions) {
              const newRef = refMap.get(act.ref)
              if (newRef === undefined) {
                // element gone — fall through to plan
                planResult = null
                entry.detail = 'replay-miss (changed)'
                replayedAll = false
                break
              }
              try {
                await driver.act({ ...act, ref: newRef })
              } catch (err) {
                // Action threw. Keep the cause: the cache hit and the element
                // resolved, so reporting a bare "no cached plan" sends the user
                // hunting for a cache problem that does not exist.
                planResult = null
                entry.detail = `replay-miss (failed): ${describeError(err).slice(0, 120)}`
                replayedAll = false
                break
              }
            }
            if (replayedAll) report.replayed++
          }
        }

        if (!planResult) {
          if (mode === 'replay') {
            const cause = entry.detail?.startsWith('replay-miss (failed): ')
              ? ` — recorded action failed: ${entry.detail.slice('replay-miss (failed): '.length)}`
              : ''
            throw new NatlError(
              `replay miss for "${step.text}"${cause || ': no cached plan'} (use mode auto or record)`,
            )
          }
          if (!provider) {
            throw new NatlError('no provider configured — cannot execute NL step')
          }
          // A partially-executed replay already mutated the page (e.g. a fill
          // succeeded before the click failed). Planning against the snapshot
          // taken BEFORE that replay would show the model a page that no longer
          // exists, so re-read the live state.
          if (entry.detail?.startsWith('replay-miss')) {
            snap = await driver.snapshot()
            entry.detail += ' — replanned against live page'
          }
          planResult = await (planOverride ?? plan)({
            provider,
            instruction: step.text,
            snapshot: snap,
            driverName: driverLabel,
          })
          report.modelCalls++
          // Run the planned actions FIRST. Recording before execution would
          // persist a plan that was never proven to run, so a failure here
          // would poison every later replay with a known-broken entry.
          const snap2 = await driver.snapshot()
          const refMap = buildRefMap(planResult.actions, snap.elements, snap2.elements)
          for (const act of planResult.actions) {
            const newRef = refMap.get(act.ref)
            if (newRef === undefined) {
              throw new NatlError(`planned ref ${act.ref} not found in snapshot`)
            }
            await driver.act({ ...act, ref: newRef })
          }
          // Defer the cache write: all records are applied atomically at the
          // end of the run via loadSave, so concurrent runs can't clobber
          // each other's entries (lost-update race).
          pendingRecords.push({
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
        // expectUrl carries no selector — dispatch it before the find().
        if (step.fn === 'expectUrl') {
          if (typeof driver.url === 'function') {
            const current = await driver.url()
            if (current !== step.value) {
              throw new NatlError(`expectUrl: expected ${step.value} but got ${current}`)
            }
          } else {
            entry.status = 'skip'
            entry.detail = 'expectUrl skipped (driver has no url())'
          }
          entry.status = entry.status === 'skip' ? 'skip' : 'pass'
        } else {
          const { text, count } = await driver.find(step.sel)
          if (step.fn === 'expectText') {
            if (count === 0) {
              throw new NatlError(`expectText: selector matched 0 elements: ${step.sel}`)
            }
            const actual = text.trim()
            if (step.value instanceof RegExp) {
              // A /g or /y regex advances lastIndex on every test(), so the same
              // assertion object would alternate pass/fail across uses. Match a
              // fresh copy: same source, same flags, lastIndex 0.
              const matcher = new RegExp(step.value.source, step.value.flags)
              if (!matcher.test(actual)) {
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

  // Persist via loadSave: re-read the file, re-apply only this run's new
  // records, and save. If another process touched the file since our first
  // load, its entries are preserved instead of being overwritten.
  if (pendingRecords.length > 0) {
    try {
      await loadSave(cachePath, (c) => {
        for (const entry of pendingRecords) cacheRecord(c, entry)
      })
    } catch (err) {
      report.cacheError = describeError(err)
      // Do not change report.ok — the test ran successfully, caching just failed.
    }
  }

  return report
}

// --- internals ---

/**
 * Build a ref-map from plan-result refs to current snapshot refs by matching
 * {role, name} pairs. Returns a Map<oldRef, newRef>.
 *
 * When several current elements share the same {role,name}, disambiguate by
 * ordinal position within that group. If the group sizes differ, fall back to
 * first-match (with a recorded detail) rather than throwing: losing the
 * ordinal is recoverable, but throwing here would turn every page with two
 * same-named links into a permanent replay failure.
 */
function buildRefMap(actions, prevElements, currentElements) {
  const needed = new Map()
  for (const act of actions) {
    const el = prevElements.find((e) => e.ref === act.ref)
    if (el) needed.set(act.ref, el)
  }
  const refMap = new Map()
  for (const [prevRef, prevEl] of needed) {
    const matches = currentElements.filter(
      (e) => e.role === prevEl.role && e.name === prevEl.name,
    )
    if (matches.length === 0) continue
    if (matches.length === 1) {
      refMap.set(prevRef, matches[0].ref)
      continue
    }
    // Multiple matches: use ordinal position among same-named elements in the
    // recorded snapshot to pick the right one.
    const idxInGroup = prevElements.filter(
      (e) => e.role === prevEl.role && e.name === prevEl.name,
    ).findIndex((e) => e.ref === prevRef)
    refMap.set(prevRef, (matches[idxInGroup] ?? matches[0]).ref)
  }
  return refMap
}

/**
 * Remap recorded refs to current refs for replay.
 * Same ordinal-disambiguation as buildRefMap.
 */
function remapRefs(prevElements, currentElements) {
  const refMap = new Map()
  for (const prevEl of prevElements) {
    const matches = currentElements.filter(
      (e) => e.role === prevEl.role && e.name === prevEl.name,
    )
    if (matches.length === 0) continue
    if (matches.length === 1) {
      refMap.set(prevEl.ref, matches[0].ref)
      continue
    }
    const idxInGroup = prevElements.filter(
      (e) => e.role === prevEl.role && e.name === prevEl.name,
    ).findIndex((e) => e.ref === prevEl.ref)
    refMap.set(prevEl.ref, (matches[idxInGroup] ?? matches[0]).ref)
  }
  return refMap
}

export default { runTest }