/**
 * natl — minimal static-file server for the web example.
 *
 * Usage:
 *   node examples/web/server.mjs           # 127.0.0.1:4173
 *   node examples/web/server.mjs --port 0  # ephemeral; prints the resolved port
 *
 * Exports startServer({ port }) -> Promise<{ server, port }> for in-process
 * use by tests. When this file is run directly it auto-listens and prints
 * the listening address.
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_PORT = 4173

/**
 * Extension -> Content-Type. Anything not listed falls back to
 * application/octet-stream.
 */
const EXT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
})

/**
 * Start a static file server rooted at examples/web/fixture/.
 *
 * @param {object} options
 * @param {number} [options.port] - listen port; 0 = ephemeral
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
export function startServer({ port = DEFAULT_PORT } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), 'fixture')

  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Method Not Allowed')
      return
    }

    let localPath = (req.url ?? '/').split('?')[0]
    if (localPath === '/' || localPath === '') localPath = '/index.html'

    // Resolve and verify the path stays inside the fixture root.
    const target = resolve(root, localPath.replace(/^\//, ''))
    if (!target.startsWith(root + '/') && target !== root) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }

    let stats
    try {
      stats = statSync(target)
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not Found')
        return
      }
      throw err
    }

    if (stats.isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }

    const ext = localPath.slice(localPath.lastIndexOf('.'))
    const ct = EXT_TYPES[ext] || 'application/octet-stream'
    const buf = readFileSync(target)
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': buf.length })
    res.end(buf)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const actualPort = server.address().port
      resolve({ server, port: actualPort })
    })
  })
}

// --- direct-run bootstrap --------------------------------------------------
// process.argv[1] is undefined under `node -e` and some embedders, so guard
// before handing it to pathToFileURL — otherwise merely importing this module
// would throw.
const entry = process.argv[1]
const isDirectRun = Boolean(entry) && import.meta.url === pathToFileURL(entry).href
if (isDirectRun) {
  const args = process.argv.slice(2)
  let port = DEFAULT_PORT
  const portIdx = args.indexOf('--port')
  if (portIdx !== -1 && args[portIdx + 1] !== undefined) {
    port = parseInt(args[portIdx + 1], 10)
  }
  if (process.env.PORT !== undefined) port = parseInt(process.env.PORT, 10)

  startServer({ port })
    .then(({ server, port: p }) => {
      console.log(`natl example server listening on http://127.0.0.1:${p}`)
    })
    .catch((err) => {
      console.error('natl example server failed to start:', err.message)
      process.exit(1)
    })
}
