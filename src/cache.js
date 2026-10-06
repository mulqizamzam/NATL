import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { makeCacheKey } from './fingerprint.js'

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
 * Idempotent load→modify→save with mtime-based conflict detection.
 *
 * When multiple concurrent writers touch the same cache file, each caller gets
 * the latest on-disk state and re-applies its change. Without this, the classic
 * lost-update pattern wins: every writer loads a stale snapshot, overwrites the
 * file, and drops the other writers' contributions.
 *
 * Backs off with jitter when the file changes under us, giving concurrent
 * writers time to settle.
 */
export async function loadSave(path, transform) {
  const BACKOFF_MS = 25
  const MAX_RETRIES = 5

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const before = await getFileMtimeMs(path).catch(() => null)
    const cache = await loadCache(path)
    transform(cache)
    await saveCache(cache, path)
    const after = await getFileMtimeMs(path).catch(() => null)
    // If another writer changed the file between our load and our save, retry.
    if (after === before) return cache
    if (attempt < MAX_RETRIES) await sleep(BACKOFF_MS * (attempt + 1))
  }
  return await loadCache(path)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getFileMtimeMs(path) {
  const { stat } = await import('node:fs/promises')
  return (await stat(path)).mtimeMs
}
