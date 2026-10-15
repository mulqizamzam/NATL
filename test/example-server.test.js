// natl — the example static server.
//
// It is the file server the README tells users to run and the one the example
// test starts in-process, so a request that kills it takes a test run with it.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../examples/web/server.mjs'

async function withServer(fn, { withSymlink = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'natl-srv-'))
  await writeFile(join(root, 'index.html'), '<h1>ok</h1>', 'utf8')
  if (withSymlink) await symlink('/etc/passwd', join(root, 'escape.txt'))
  const { server, port } = await startServer({ port: 0, root })
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

test('a stat failure returns 404 and the server survives it', async () => {
  // ENOTDIR (a file used as a directory) used to propagate out of the request
  // handler and abort the process on a single GET.
  await withServer(async (base) => {
    const bad = await fetch(`${base}/index.html/x`)
    assert.equal(bad.status, 404, 'a path through a file must be a 404, not a crash')
    await bad.arrayBuffer()

    const long = await fetch(`${base}/${'a'.repeat(300)}`)
    assert.equal(long.status, 404)
    await long.arrayBuffer()

    // the process is still serving after both
    const ok = await fetch(`${base}/index.html`)
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /ok/)
  })
})

test('a symlink inside the root cannot serve a file outside it', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/escape.txt`)
    assert.equal(res.status, 404, 'a symlink must not escape the served root')
    const body = await res.text()
    assert.doesNotMatch(body, /root:x:/)
  }, { withSymlink: true })
})

test('ordinary traversal is still refused', async () => {
  await withServer(async (base) => {
    for (const p of ['/../package.json', '/%2e%2e%2fpackage.json', '/etc/passwd']) {
      const res = await fetch(`${base}${p}`)
      assert.equal(res.status, 404, `${p} must not be served`)
      await res.arrayBuffer()
    }
  })
})
