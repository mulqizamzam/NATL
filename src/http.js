// natl — outbound HTTP with a deadline.
//
// fetch() has no timeout of its own. A provider or Appium server that accepts
// the connection and then stalls hangs `natl run` forever, with the browser
// still open and no output — so every outbound request in natl goes through
// here and the ceiling is one documented knob instead of a per-call
// afterthought.
//
// Both knobs are read per call, not at import time, so a test (or a shell
// export) can set them before the request it cares about.

import { NatlError } from './errors.js'

/** A model may legitimately think for minutes; a WebDriver command may not. */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000
export const DEFAULT_WEBDRIVER_TIMEOUT_MS = 30_000

function envTimeout(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export const llmTimeoutMs = () => envTimeout('NATL_HTTP_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS)
export const webdriverTimeoutMs = () => envTimeout('NATL_WD_TIMEOUT_MS', DEFAULT_WEBDRIVER_TIMEOUT_MS)

// AbortSignal.timeout() rejects with a TimeoutError DOMException; a caller that
// aborts its own signal throws AbortError. Both are deadlines, not wire faults.
const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError'

/** Attempts in total, not retries: 10 means the first try plus 9 retries. */
export const DEFAULT_LLM_ATTEMPTS = 10

const envNumber = (name, fallback, min) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= min ? n : fallback
}

export const llmAttempts = () => Math.floor(envNumber('NATL_LLM_ATTEMPTS', DEFAULT_LLM_ATTEMPTS, 1))
const retryBaseMs = () => envNumber('NATL_LLM_RETRY_BASE_MS', 500, 0)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A rate-limited provider is a "come back later", not a failed test — but only
 * for a bounded number of tries, and never for any other 4xx (a 401 or a 400
 * will answer the same way forever).
 *
 * `Retry-After` is honoured when the provider sends it, otherwise the wait
 * doubles per attempt and is capped, with jitter so parallel runs do not all
 * come back at the same instant.
 */
export async function fetchWithRetry(url, init, { timeoutMs, label, attempts }) {
  const max = attempts ?? llmAttempts()
  for (let attempt = 1; ; attempt++) {
    const resp = await fetchWithTimeout(url, init, { timeoutMs, label })
    if (resp.status !== 429 || attempt >= max) return resp
    const wait = retryAfterMs(resp.headers) ?? backoffMs(attempt)
    // Release the socket before waiting, or a retry storm leaks connections.
    await resp.body?.cancel().catch(() => {})
    process.stderr.write(
      `natl: ${label} rate-limited (429) — attempt ${attempt}/${max}, retrying in ${Math.round(wait)}ms\n`,
    )
    await sleep(wait)
  }
}

function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const when = Date.parse(raw)
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 60_000))
  return null
}

function backoffMs(attempt) {
  const capped = Math.min(retryBaseMs() * 2 ** (attempt - 1), 30_000)
  return capped + Math.random() * 250
}

/**
 * fetch() that fails loudly instead of hanging.
 *
 * The raw DOMException ("The operation was aborted") names neither the call nor
 * the budget, so a deadline becomes a NatlError carrying both.
 */
export async function fetchWithTimeout(url, init, { timeoutMs, label }) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (isTimeout(err)) {
      throw new NatlError(
        `${label} timed out after ${timeoutMs}ms (${url}) — set NATL_HTTP_TIMEOUT_MS / NATL_WD_TIMEOUT_MS to raise it`,
        { url, timeoutMs },
      )
    }
    throw err
  }
}

export default fetchWithTimeout
