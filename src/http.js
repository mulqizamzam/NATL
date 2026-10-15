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
