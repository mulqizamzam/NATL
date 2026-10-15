// natl — CLI-level tests.
//
// The suite tests modules directly everywhere else; nothing exercised
// bin/natl.js, which is where a packaging mistake is invisible: the CLI used to
// import the web driver unconditionally, so a mobile-only project crashed with
// ERR_MODULE_NOT_FOUND for playwright before any driver existed.

// FIRST import: sets PLAYWRIGHT_BROWSERS_PATH during its own evaluation, which
// is the only moment playwright reads it (see the helper).
import './helpers/browsers-path.js'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startServer } from '../examples/web/server.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(cwd, 'bin', 'natl.js'), ...args], {
      cwd,
      // stdin closed: a command that waits for input must fail fast here, not
      // hang the suite.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Hand the child the browser directory resolved for THIS checkout, so the
      // test behaves the same whether or not the caller exported one.
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, out, err, all: out + err }))
  })
}

/**
 * A throwaway project holding natl's bin/ and src/ but NO node_modules — the
 * shape of a real consumer install, where devDependencies are absent.
 */
async function throwawayProject() {
  const dir = await mkdtemp(join(tmpdir(), 'natl-cli-'))
  await cp(join(REPO, 'bin'), join(dir, 'bin'), { recursive: true })
  await cp(join(REPO, 'src'), join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'smoke.test.js'), "export default { kind: 'test', name: 'smoke', steps: [] }\n", 'utf8')
  return dir
}

test('natl --help works from a checkout with no node_modules', async () => {
  const dir = await throwawayProject()
  try {
    const { code, out } = await runCli(['--help'], dir)
    assert.equal(code, 0)
    assert.match(out, /natl run\s+<file>/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a mobile-only project runs without playwright installed', async () => {
  // playwright is a dev/example dependency and optional at runtime (spec D5).
  // A project that only drives Appium must not need it.
  const dir = await throwawayProject()
  try {
    const server = 'http://127.0.0.1:9'
    await writeFile(
      join(dir, 'natl.config.json'),
      JSON.stringify({
        appType: 'mobile',
        provider: 'openai',
        model: 'gpt-4o',
        cacheDir: '.natl/cache',
        mobile: { server, capabilities: { platformName: 'Android' } },
      }, null, 2),
      'utf8',
    )

    const { all } = await runCli(['run', 'smoke.test.js'], dir)

    assert.doesNotMatch(all, /playwright/, 'a mobile run must not need playwright')
    assert.doesNotMatch(all, /ERR_MODULE_NOT_FOUND/)
    // It got all the way to the mobile driver and failed on the connection,
    // which is the only thing this test claims.
    assert.match(all, /Appium|appium/, `expected an Appium-level failure, got: ${all}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A throwaway project that can actually run a web test: natl's bin/ and src/,
 * node_modules symlinked to this repo's (so playwright resolves), a config
 * pointing at `webUrl`, and one deterministic test file.
 */
async function runnableProject({ steps, webUrl }) {
  const dir = await throwawayProject()
  await symlink(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir')
  await writeFile(
    join(dir, 'natl.config.json'),
    JSON.stringify({
      appType: 'web',
      provider: 'openai',
      model: 'gpt-4o',
      cacheDir: '.natl/cache',
      web: { url: webUrl, headless: true },
    }, null, 2),
    'utf8',
  )
  await writeFile(
    join(dir, 'sample.test.js'),
    `import { test, goto, expectCount } from './src/steps.js'\n\n`
      + `export default test('sample', [\n  goto(${JSON.stringify(webUrl)}),\n${steps}\n])\n`,
    'utf8',
  )
  return dir
}

test('exit code contract: 0 on pass, 1 on a failing assertion', async () => {
  const { server, port } = await startServer({ port: 0 })
  const webUrl = `http://127.0.0.1:${port}`
  try {
    const passing = await runnableProject({ steps: "  expectCount('h1', 1),", webUrl })
    try {
      const r = await runCli(['run', 'sample.test.js'], passing)
      assert.equal(r.code, 0, `a passing test must exit 0, got ${r.code}: ${r.all}`)
      assert.match(r.all, /PASS/)
    } finally {
      await rm(passing, { recursive: true, force: true })
    }

    const failing = await runnableProject({ steps: "  expectCount('h1', 99),\n  expectCount('h1', 1),", webUrl })
    try {
      const r = await runCli(['run', 'sample.test.js'], failing)
      assert.equal(r.code, 1, `a failing assertion must exit 1, got ${r.code}: ${r.all}`)
      assert.match(r.all, /FAIL/)
      assert.match(r.all, /⊘/, 'steps after the failure must be reported as skipped')
    } finally {
      await rm(failing, { recursive: true, force: true })
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('exit code contract: 2 on a usage error', async () => {
  const dir = await throwawayProject()
  try {
    const badMode = await runCli(['run', 'smoke.test.js', '--mode', 'bogus'], dir)
    assert.equal(badMode.code, 2, `bad --mode must exit 2: ${badMode.all}`)
    assert.match(badMode.all, /--mode must be one of/)

    const badCommand = await runCli(['bogus'], dir)
    assert.equal(badCommand.code, 2, `an unknown command must exit 2: ${badCommand.all}`)
    assert.match(badCommand.all, /unknown command/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('exit code contract: a broken test file is a failure (1), not usage (2)', async () => {
  // CI reads the code to tell "you typed the command wrong" from "the build is
  // red". Every error inside run() used to land in the usage bucket.
  const dir = await throwawayProject()
  try {
    await writeFile(
      join(dir, 'natl.config.json'),
      JSON.stringify({ appType: 'mobile', provider: 'openai', model: 'gpt-4o', mobile: { server: 'http://127.0.0.1:9' } }),
      'utf8',
    )

    await writeFile(join(dir, 'throws.test.js'), "throw new Error('boom at import time')\n", 'utf8')
    const thrown = await runCli(['run', 'throws.test.js'], dir)
    assert.equal(thrown.code, 1, `a test file that throws must exit 1: ${thrown.all}`)
    assert.match(thrown.all, /failed to load/)

    // A path that does not exist is still the caller's mistake.
    const missing = await runCli(['run', 'nope.test.js'], dir)
    assert.equal(missing.code, 2, `a missing test file must exit 2: ${missing.all}`)
    assert.match(missing.all, /test file not found/)

    await writeFile(join(dir, 'notatest.test.js'), "export const nothing = 1\n", 'utf8')
    const noTest = await runCli(['run', 'notatest.test.js'], dir)
    assert.equal(noTest.code, 1, `a file with no test object must exit 1: ${noTest.all}`)
    assert.match(noTest.all, /no test object/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('natl init without a terminal fails clearly instead of exiting 13', async () => {
  // The CLI called askQuestions(true) unconditionally, so with no TTY readline
  // got EOF, the pending question never settled, and node exited 13 with
  // "Detected unsettled top-level await" — a Node internal, not a user message.
  const dir = await throwawayProject()
  try {
    const r = await runCli(['init'], dir)
    assert.equal(r.code, 2, `expected a usage error, got ${r.code}: ${r.all}`)
    assert.match(r.all, /terminal|TTY/, 'the message must say what is missing')
    assert.doesNotMatch(r.all, /unsettled top-level await/, 'no Node internal may leak')
    assert.doesNotMatch(r.all, /askQuestions/, 'no internal function name in user output')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
