// Where the Playwright browser cache lives for this checkout.
//
// IMPORT THIS MODULE FIRST — before anything that imports playwright.
//
// Measured on playwright 1.63.0: PLAYWRIGHT_BROWSERS_PATH is read when the
// playwright module is EVALUATED, not when launch() runs. Setting it from a
// function called in the test file's body is always too late, because a module
// body runs after all of its imports; Playwright then falls back to
// ~/.cache/ms-playwright and the launch fails with "Executable doesn't exist".
// ESM evaluates imports in source order, so a side effect during this module's
// own evaluation lands before playwright is imported — provided this import is
// listed first.
//
// The suite used to hardcode an absolute path from the machine it was written
// on, so a clone anywhere else pointed Playwright at a directory that does not
// exist.

import { fileURLToPath } from 'node:url'

/** test/helpers/ -> the repository root. */
const REPO_ROOT = new URL('../../', import.meta.url)

// An empty string counts as unset: a shell that exports it empty would
// otherwise silence the fallback and send Playwright to its global cache.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL('.browsers/', REPO_ROOT))
}

/** The path in effect, so a test can assert what it is actually using. */
export function useRepoBrowsers() {
  return process.env.PLAYWRIGHT_BROWSERS_PATH
}

export default useRepoBrowsers
