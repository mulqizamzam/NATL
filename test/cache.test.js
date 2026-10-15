import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { loadCache, cacheLookup, cacheRecord, saveCache, loadSave, cacheFileName } from '../src/cache.js'
import { makeCacheKey, makeFingerprint } from '../src/fingerprint.js'

const BASE_DIR = 'test/fixtures'

describe('cache (frozen contract 5)', () => {
  let tmpDir

  before(async () => {
    await mkdir(BASE_DIR, { recursive: true })
    tmpDir = await mkdtemp(join(BASE_DIR, 'cache-'))
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('cacheFileName is unique per resolved path, not per sanitized string', () => {
    // `/` and `_` both collapse to `_`, so a/b.test.js and a_b.test.js used to
    // share one cache file — two unrelated tests writing into one store.
    const a = cacheFileName('a/b.test.js', '/proj')
    const b = cacheFileName('a_b.test.js', '/proj')
    assert.notEqual(a, b, 'two different test files must not share a cache file')
    assert.equal(cacheFileName('a/b.test.js', '/proj'), a, 'and it must be deterministic')
    assert.equal(cacheFileName('a/b.test.js', '/other'), cacheFileName('a/b.test.js', '/other'))
    assert.notEqual(
      cacheFileName('a/b.test.js', '/proj'),
      cacheFileName('a/b.test.js', '/other'),
      'the same relative path in a different project is a different file',
    )
  })

  it('loadCache on a missing file returns an empty cache object', async () => {
    const cache = await loadCache(join(tmpDir, 'missing.json'))
    assert.deepEqual(cache, { version: 1, entries: {} })
  })

  it('record then lookup by the same step+fingerprint returns the entry', async () => {
    const cache = await loadCache(join(tmpDir, 'record.json'))
    const fp = makeFingerprint([{ role: 'button', name: 'Go' }])
    const key = makeCacheKey('log in', fp)
    const entry = {
      key,
      stepText: 'log in',
      fingerprint: fp,
      elements: [{ ref: '0', role: 'button', name: 'Go' }],
      actions: [{ action: 'click', ref: '0' }],
      provider: 'deepseek',
      model: 'max',
      recordedAt: '2026-01-01T00:00:00.000Z',
    }
    const updated = cacheRecord(cache, entry)
    assert.equal(updated, cache, 'cacheRecord returns the same cache object')
    assert.strictEqual(cacheLookup(updated, 'log in', fp), entry)
    assert.strictEqual(cache.entries[key], entry)
  })

  it('a different fingerprint is a MISS', () => {
    const fp = makeFingerprint([{ role: 'button', name: 'Go' }])
    const otherFp = makeFingerprint([{ role: 'button', name: 'Gone' }])
    assert.notEqual(fp, otherFp, 'precondition: fingerprints differ')
    const cache = { version: 1, entries: {} }
    const entry = {
      key: makeCacheKey('x', fp),
      stepText: 'x',
      fingerprint: fp,
      elements: [],
      actions: [],
      recordedAt: 'now',
    }
    cacheRecord(cache, entry)
    assert.strictEqual(cacheLookup(cache, 'x', fp), entry)
    assert.strictEqual(cacheLookup(cache, 'x', otherFp), null)
  })

  it('re-recording a step does not remove another step\'s entry', () => {
    const cache = {
      version: 1,
      entries: {
        k1: {
          key: 'k1',
          stepText: 'a',
          fingerprint: 'f1',
          elements: [],
          actions: [],
          recordedAt: 'now',
        },
      },
    }
    cacheRecord(cache, {
      key: 'k2',
      stepText: 'b',
      fingerprint: 'f2',
      elements: [],
      actions: [],
      recordedAt: 'now',
    })
    assert.ok('k1' in cache.entries)
    assert.ok('k2' in cache.entries)
    assert.equal(cache.entries.k1.stepText, 'a')
    assert.equal(cache.entries.k2.stepText, 'b')
  })

  it('save() to a path whose directory does not exist creates it', async () => {
    const deepPath = join(tmpDir, 'nested', 'deep', 'cache.json')
    const cache = { version: 1, entries: {} }
    await saveCache(cache, deepPath)
    const loaded = await loadCache(deepPath)
    assert.equal(loaded.version, 1)
    assert.deepEqual(loaded.entries, {})
  })

  it('save/load round-trips entries correctly', async () => {
    const fp = makeFingerprint([{ role: 'button', name: 'Save' }])
    const entry = {
      key: makeCacheKey('submit', fp),
      stepText: 'submit',
      fingerprint: fp,
      elements: [{ ref: '0', role: 'button', name: 'Save' }],
      actions: [{ action: 'click', ref: '0' }],
      provider: 'openai',
      model: 'gpt-4o',
      recordedAt: '2026-01-01T00:00:00.000Z',
    }
    const cache = { version: 1, entries: { k1: { key: 'k1', stepText: 'other', fingerprint: 'other-fp', elements: [], actions: [] } } }
    cacheRecord(cache, entry)
    const path = join(tmpDir, 'round.json')
    await saveCache(cache, path)
    const loaded = await loadCache(path)
    assert.equal(loaded.version, 1)
    assert.ok('k1' in loaded.entries)
    const found = cacheLookup(loaded, 'submit', fp)
    assert.ok(found, 'entry survives the save/load round trip')
    assert.deepStrictEqual(found, entry)
    assert.equal(found.key, entry.key)
  })

  it('loadCache throws on a corrupt JSON file', async () => {
    const path = join(tmpDir, 'corrupt.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{not json', 'utf8')
    let threw = false
    let message = ''
    try {
      await loadCache(path)
    } catch (err) {
      threw = true
      message = err.message
    }
    assert.ok(threw, 'loadCache should throw on corrupt JSON')
    assert.match(message, /JSON/)
  })

  it('loadSave does not re-run transform when no other writer touched the file', async () => {
    // The mtime guard must detect *another* writer's save, never the one it made
    // itself. A guard that brackets its own write retries forever: the transform
    // runs 6x and every cache write pays the full backoff.
    const path = join(tmpDir, 'no-self-trigger.json')
    let calls = 0
    const entry = (key) => ({
      key,
      stepText: key,
      fingerprint: `fp-${key}`,
      elements: [],
      actions: [{ action: 'click', ref: '0' }],
      provider: 'p',
      model: 'm',
    })
    await loadSave(path, (c) => { calls += 1; cacheRecord(c, entry('solo')) })
    assert.equal(calls, 1, 'transform must run exactly once for a single uncontended write')

    const started = Date.now()
    await loadSave(path, (c) => { calls += 1; cacheRecord(c, entry('solo-2')) })
    const elapsed = Date.now() - started
    assert.equal(calls, 2)
    assert.ok(elapsed < 200, `uncontended loadSave must not sleep through the backoff (took ${elapsed}ms)`)

    const after = await loadCache(path)
    assert.equal(Object.keys(after.entries).length, 2)
  })

  it('parallel writers using loadSave must not drop entries', async () => {
    // 12 writers, not 3: with the previous compare-and-set this test lost an
    // entry in 2 runs out of 5 even at 3 writers, and the loss is silent — a
    // recorded plan disappears and the next replay run reports a cache miss.
    const racePath = join(tmpDir, 'race-merged.json')
    await Promise.all(
      Array.from({ length: 12 }, (_v, idx) => idx + 1).map(async (i) => {
        await loadSave(racePath, (c) => {
          cacheRecord(c, {
            key: makeCacheKey(`step-${i}`, `fp-${i}`),
            stepText: `step-${i}`,
            fingerprint: `fp-${i}`,
            elements: [],
            actions: [],
            provider: 'p',
            model: 'm',
          })
        })
      }),
    )
    const final = await loadCache(racePath)
    assert.equal(
      Object.keys(final.entries).length,
      12,
      'all 12 concurrently recorded entries must survive',
    )
  })

  it('loadSave preserves existing entries when transform adds one', async () => {
    const path = join(tmpDir, 'loadsave-preserves.json')
    const fp1 = makeFingerprint([{ role: 'button', name: 'A' }])
    await loadSave(path, (c) => {
      cacheRecord(c, {
        key: makeCacheKey('first', fp1),
        stepText: 'first',
        fingerprint: fp1,
        elements: [{ ref: '0', role: 'button', name: 'A' }],
        actions: [],
        provider: 'p',
        model: 'm',
      })
    })
    const fp2 = makeFingerprint([{ role: 'button', name: 'B' }])
    await loadSave(path, (c) => {
      cacheRecord(c, {
        key: makeCacheKey('second', fp2),
        stepText: 'second',
        fingerprint: fp2,
        elements: [],
        actions: [],
        provider: 'p',
        model: 'm',
      })
    })
    const final = await loadCache(path)
    assert.equal(Object.keys(final.entries).length, 2)
    assert.ok(cacheLookup(final, 'first', fp1))
    assert.ok(cacheLookup(final, 'second', fp2))
  })
})
