import { createHash } from 'node:crypto'

export function makeCacheKey(stepText, fingerprint) {
  return createHash('sha256').update(stepText + '\n' + fingerprint, 'utf8').digest('hex')
}

export function makeFingerprint(elements, url = '') {
  // Normalize role/name to strings BEFORE hashing, not only when sorting.
  // Hashing raw `undefined` produced a different digest than `''`, so a page
  // whose driver reports an absent role/name would miss its own cache entry.
  const pairs = elements.map((e) => [str(e.role), str(e.name)])
  // Sorted so a page that only reorders its elements keeps the same fingerprint.
  // Replay re-resolves each recorded action by {role, name} identity rather than
  // by position, so a reorder is genuinely not a change to the page.
  pairs.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])))
  // The URL is part of the input: two pages can expose the same {role,name}
  // multiset and still be different screens, and replaying a plan from one
  // against the other is wrong.
  return createHash('sha256').update(`${url}\n${JSON.stringify(pairs)}`, 'utf8').digest('hex')
}

const str = (v) => (v === undefined || v === null ? '' : String(v))

// Undefined vs missing name must compare consistently, so normalize to ''.
function cmp(a, b) {
  const x = a ?? ''
  const y = b ?? ''
  return x < y ? -1 : x > y ? 1 : 0
}
