import { mkdir, readFile, writeFile, rename, unlink, stat, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { makeCacheKey } from './fingerprint.js'
import { NatlError } from './errors.js'

/**
 * File name for one test file's cache.
 *
 * The readable part alone is not unique: `/` and `_` both collapse to `_`, so
 * `a/b.test.js` and `a_b.test.js` produced the SAME cache file and two unrelated
 * tests shared one store. A short digest of the resolved path keeps the name
 * readable and makes it unique per file.
 */
export function cacheFileName(file, cwd = process.cwd()) {
  const readable = String(file).replace(/[^\w.-]/g, '_')
  const digest = createHash('sha256').update(resolve(cwd, String(file))).digest('hex').slice(0, 8)
  return `${readable}.${digest}.json`
}

function emptyCache() {
  return { version: 1, entries: {} }
}

export async function loadCache(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || !('entries' in parsed) || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new Error(`invalid cache at ${path}: missing entries object`)
    }
    return { version: parsed.version ?? 1, entries: parsed.entries }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return emptyCache()
    }
    throw err
  }
}

export function cacheLookup(cache, stepText, fingerprint) {
  const key = makeCacheKey(stepText, fingerprint)
  return cache.entries[key] ?? null
}

export function cacheRecord(cache, entry) {
  const key = entry.key ?? makeCacheKey(entry.stepText, entry.fingerprint)
  cache.entries[key] = entry
  return cache
}

export async function saveCache(cache, path) {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}.json`)
  try {
    await writeFile(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8')
    await rename(tmp, path)
  } catch (err) {
    try {
      await unlink(tmp)
    } catch {
      // best-effort cleanup of temp file
    }
    throw err
  }
}

/**
 * Idempotent load→modify→save, serialized by an exclusive lock file.
 *
 * The obvious implementations do not work, and both were measured here:
 *
 *   - Comparing mtime across this function's own write always reports a
 *     conflict (saveCache renames a fresh temp file in), so every uncontended
 *     record paid six writes and 375ms of backoff.
 *   - Verifying our own entries after writing is a TOCTOU check: two writers
 *     that both read before either writes will each save a snapshot that lacks
 *     the other's entry, and each read-back happens before the other's save.
 *     With three concurrent writers the shared test failed 2 runs in 5, losing
 *     a recorded plan — which is silent data loss, not a slow test.
 *
 * A lock makes the read-modify-write sequence atomic across processes, so each
 * writer loads the newest state. `open(..., 'wx')` is O_EXCL: exactly one
 * process creates the file, everyone else waits.
 */
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 10_000

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      return await open(lockPath, 'wx')
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // A writer that died holding the lock must not wedge the cache forever.
      const age = await stat(lockPath).then((st) => Date.now() - st.mtimeMs).catch(() => 0)
      if (age > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => {})
        continue
      }
      if (Date.now() > deadline) {
        throw new NatlError(`timed out waiting for the cache lock at ${lockPath}`)
      }
      await sleep(5 + Math.random() * 20)
    }
  }
}

export async function loadSave(path, transform) {
  const lockPath = `${path}.lock`
  await mkdir(dirname(path), { recursive: true })
  const handle = await acquireLock(lockPath)
  try {
    const cache = await loadCache(path)
    transform(cache)
    await saveCache(cache, path)
    return cache
  } finally {
    // Release before anything else: a lock left behind costs the next writer up
    // to LOCK_STALE_MS of waiting.
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

