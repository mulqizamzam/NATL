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
