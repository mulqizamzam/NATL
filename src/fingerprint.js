import { createHash } from 'node:crypto'

export function makeCacheKey(stepText, fingerprint) {
  return createHash('sha256').update(stepText + '\n' + fingerprint, 'utf8').digest('hex')
}

export function makeFingerprint(elements) {
  // Sorted so a page that only reorders its elements keeps the same fingerprint.
  // Replay re-resolves each recorded action by {role, name} identity rather than
  // by position, so a reorder is genuinely not a change to the page.
  const pairs = elements.map((e) => [e.role, e.name])
  pairs.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])))
  return createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex')
}

// Undefined vs missing name must hash consistently, so normalize to ''.
function cmp(a, b) {
  const x = a ?? ''
  const y = b ?? ''
  return x < y ? -1 : x > y ? 1 : 0
}
