import http from 'node:http'

/**
 * Fake Appium W3C WebDriver server for testing the mobile driver.
 *
 * startFakeDriver({ fixture, calls, errors }) -> { server, port }
 *
 * - `fixture`: page-source XML served by GET /session/:id/source.
 * - `calls`: array the fake pushes {method, path, body, status} onto.
 *   `path` is the *decoded* pathname for human-readable assertion; the driver's
 *   URLs still contain percent-encoding for the element handle.
 * - `errors`: optional map of path (or path prefix) -> status code, used to
 *   force HTTP error responses for specific paths.
 *
 * When POST /element is given a plain accessibility-id / id selector, the fake
 * returns 404 if that value does not appear in the fixture — this lets tests
 * assert the driver's not-found path without a real Appium.
 */
export function startFakeDriver({ fixture = '', calls: callsArr = [], errors = {} } = {}) {
  // Route on the raw (encoded) pathname so an element handle that contains
  // '/' or ':' stays a single path segment. The decoded form is used for the
  // forced-error map and for recording in `calls`.
  const rawPath = (url) => new URL(url, 'http://127.0.0.1').pathname
  const decoded = (url) => decodeURIComponent(rawPath(url))

  const sessionRe = /^\/session\/([^/]+)(\/.*)?$/
  // Capture one path segment per hop so elId — even if it contains '/' after
  // percent-decoding — stays one segment.
  const elementRe = /^\/session\/([^/]+)\/element\/([^/]+)(\/([^/]+))?$/

  const contains = (needle) => (needle ? fixture.includes(needle) : false)

  function write(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', (chunk) => {
      rawBody += chunk
    })
    req.on('end', () => {
      const method = req.method
      const path = decoded(req.url)
      const raw = rawPath(req.url)

      // Forced errors match on the decoded path.
      for (const [errPath, status] of Object.entries(errors)) {
        if (path === errPath || path.startsWith(errPath)) {
          write(res, status, { value: { error: 'unknown', message: 'forced' } })
          callsArr.push({ method, path, body: rawBody, status })
          return
        }
      }

      let m
      if (method === 'POST' && path === '/session') {
        write(res, 200, { sessionId: 'fake-sess-1', capabilities: {} })
        callsArr.push({ method, path, body: rawBody, status: 200 })
        return
      }
      if (method === 'DELETE' && sessionRe.test(raw)) {
        write(res, 200, { value: null })
        callsArr.push({ method, path, body: rawBody, status: 200 })
        return
      }
      if (method === 'GET' && /^\/session\/[^/]+\/source$/.test(raw)) {
        write(res, 200, { value: fixture })
        callsArr.push({ method, path, body: rawBody, status: 200 })
        return
      }

      if (method === 'POST' && /^\/session\/[^/]+\/element$/.test(raw)) {
        let reqBody = {}
        try {
          reqBody = JSON.parse(rawBody || '{}')
        } catch {
          /* keep {} */
        }
        const using = reqBody.using ?? 'accessibility id'
        const value = reqBody.value ?? ''
        // XPath and unknown strategies always "find" something in the fake;
        // plain accessibility-id / id values are checked against the fixture.
        const found = using === 'xpath' || contains(value)
        if (!found) {
          write(res, 404, {
            value: { error: 'no such element', message: `no element found for ${using}=${value}` },
          })
          callsArr.push({ method, path, body: rawBody, status: 404 })
          return
        }
        const elId = `el-${value}`
        write(res, 200, { value: { 'element-6066-11e4-a52e-4f735466cecf': elId } })
        callsArr.push({ method, path, body: rawBody, status: 200 })
        return
      }

      if ((method === 'POST' || method === 'GET') && (m = raw.match(elementRe))) {
        const sub = m[4] ?? ''
        if (
          ['click', 'value', 'clear', 'press', 'text', 'attribute'].includes(sub) ||
          sub.startsWith('attribute/')
        ) {
          const payload =
            sub === 'text' ? { value: 'Sign In' } : sub.startsWith('attribute/') ? { value: 'true' } : { value: null }
          write(res, 200, payload)
          callsArr.push({ method, path, body: rawBody, status: 200 })
          return
        }
      }

      if (method === 'POST' && /^\/session\/[^/]+\/execute\/sync$/.test(raw)) {
        write(res, 200, { value: null })
        callsArr.push({ method, path, body: rawBody, status: 200 })
        return
      }

      write(res, 500, { value: { error: 'unknown error', message: 'boom' } })
      callsArr.push({ method, path, body: rawBody, status: 500 })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

export default startFakeDriver
