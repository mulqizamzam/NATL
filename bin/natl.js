#!/usr/bin/env node
/**
 * natl — CLI for the natural-language E2E test runner.
 *
 * Usage:
 *   natl run    <file> [--config <p>] [--provider <p>] [--model <m>] [--report <f>] [--headed] [--mode auto|replay|record]
 *   natl replay <file>
 *   natl record <file>
 *   natl init
 *   natl --help
 *   natl --version
 */

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return pkg.version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

// Browser path: THIS REPO pins browsers in .browsers/ (a writable location on
// this host; the default ~/.cache is read-only in the DSH sandbox). Only
// default to it when it exists.
//
// For an installed package `root` is node_modules/natl, so forcing that path
// pointed every consumer at a directory nothing ever creates while
// `npx playwright install` wrote to ~/.cache/ms-playwright — the error's own
// suggested fix could not work. Absent here means Playwright's normal location.
{
  const repoBrowsers = join(root, '.browsers')
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(repoBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = repoBrowsers
  }
}

// die() throws a tagged error so the top-level catch can call process.exit()
// once, after all async handles are released. process.exit() inside a finally
// block can be silently swallowed when a pending socket handle is still open.
class UsageExit extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.isUsageExit = true
  }
}

function die(msg) {
  throw new UsageExit(2, msg)
}

/**
 * Exit 1: the invocation was fine, the test or its environment was not.
 *
 * A broken test file and an environment that cannot start a session are test
 * failures, not usage errors — CI reads the code to tell "you typed the command
 * wrong" apart from "the build is red", and every error raised inside run()
 * used to land in the usage bucket.
 */
function fail(msg) {
  throw new UsageExit(1, msg)
}

function exitWith(code, message) {
  if (message) console.error(`natl: ${message}`)
  process.exit(code)
}

function loadConfig(configPath) {
  if (!configPath && !existsSync(join(process.cwd(), 'natl.config.json'))) {
    die('no natl.config.json found — run `natl init` first')
  }
  const p = configPath ?? join(process.cwd(), 'natl.config.json')
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    die(`failed to parse config at ${p}: ${err.message}`)
  }
}

/**
 * True when a dynamic import failed because a package is not installed.
 */
function isMissingModule(err, name) {
  return err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(`'${name}'`)
}

async function run(file, cfg, mode, providerOverride, modelOverride, reportPath, headed, baseUrlOverride) {
  let driver = null
  try {
    const appType = cfg.appType ?? 'web'

    // Load and validate the test file BEFORE a driver exists. An authoring
    // mistake — a missing file, a module that throws, no test object — used to
    // pay a full browser launch first and surface through the browser's error
    // channel instead of naming the file.
    // resolve(), not join(): join(cwd, '/abs/path') yields cwd + '/abs/path', so the
    // absolute path `natl init` prints in its own next-step hint never loaded.
    const modUrl = file.startsWith('file://') ? file : `file://${resolve(process.cwd(), file)}`
    let mod
    try {
      mod = await import(modUrl)
    } catch (err) {
      // A path that does not exist is the caller's mistake (2). A file that
      // exists but throws on import is a broken test (1) — including when what
      // it cannot find is a package it forgot to install.
      const resolved = resolve(process.cwd(), file)
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(resolved)) {
        die(`test file not found: ${file}`)
      }
      fail(`test file ${file} failed to load: ${err?.message ?? String(err)}`)
    }
    const testObj = mod.default ?? Object.values(mod).find((v) => v?.kind === 'test')
    if (!testObj || testObj.kind !== 'test') {
      fail(`no test object found in ${file} — export test(name, [ ... ])`)
    }

    if (appType === 'mobile') {
      // Mobile driver may not yet exist if this is a fresh checkout.
      const { createMobileDriver } = await import('../src/drivers/mobile.js').catch(() => null)
      if (!createMobileDriver) {
        die('mobile driver not available — ensure src/drivers/mobile.js exists')
      }
      driver = createMobileDriver({
        server: cfg.mobile?.server ?? 'http://127.0.0.1:4723',
        capabilities: cfg.mobile?.capabilities ?? {},
        selectors: cfg.mobile?.selectors ?? { mode: 'auto' },
      })
    } else {
      // Imported here rather than at the top of run(): playwright is a
      // dev/example dependency and stays optional at runtime (spec D5), so a
      // mobile-only project must not need it. Importing it for every app type
      // made `natl run` die with ERR_MODULE_NOT_FOUND before any driver existed.
      const { createWebDriver } = await import('../src/drivers/web.js').catch((err) => {
        if (isMissingModule(err, 'playwright')) {
          die('the web driver needs playwright — install it in this project: npm i -D playwright')
        }
        throw err
      })
      driver = createWebDriver({
        url: cfg.web?.url ?? 'http://127.0.0.1:4173',
        headless: headed ? false : (cfg.web?.headless ?? true),
        device: cfg.web?.device ?? null,
      })
    }

    try {
      await driver.open()
    } catch (err) {
      // No browser binary, no Appium server, a bad capabilities set: the test
      // could not run, which is a failing run (1), not a usage error.
      fail(`could not start the ${appType} session: ${err?.message ?? String(err)}`)
    }

    // Provider config: CLI flag wins, then config file, then env.
    // baseUrl: cfg.baseUrl (from natl.config.json) → NATL_BASE_URL env → undefined.
    const providerName = providerOverride ?? cfg.provider ?? process.env.NATL_PROVIDER
    const model =
      modelOverride ?? cfg.model ?? process.env.NATL_MODEL ?? (providerName === 'ollama' ? 'qwen3' : undefined)
    const apiKey =
      process.env.NATL_API_KEY ??
      process.env[`${String(providerName ?? '').toUpperCase()}_API_KEY`] ??
      process.env.NINE_ROUTER_API_KEY ??
      ''
    const baseUrl = baseUrlOverride ?? cfg.baseUrl ?? process.env.NATL_BASE_URL ?? undefined
    const provider = providerName
      ? { provider: providerName, model, apiKey, baseUrl }
      : null

    const cacheDir = cfg.cacheDir ?? '.natl/cache'
    const { cacheFileName } = await import('../src/cache.js')
    const cachePath = join(process.cwd(), cacheDir, cacheFileName(file))

    const { runTest } = await import('../src/runner.js')
    const report = await runTest(testObj, {
      driver,
      provider,
      cachePath,
      mode,
    })

    const { renderReport, toJson } = await import('../src/report.js')
    console.log(renderReport(report))

    if (reportPath) {
      const { writeFile } = await import('node:fs/promises')
      try {
        await writeFile(reportPath, toJson(report), 'utf8')
      } catch (err) {
        // The test already ran and its result is on stdout. Failing to persist
        // the JSON report must not turn a passing run into a usage error.
        console.error(`natl: could not write report to ${reportPath}: ${err.message}`)
      }
    }

    return report
  } catch (err) {
    if (err.isUsageExit) throw err
    die(err?.message ?? String(err))
  } finally {
    if (driver) {
      try {
        await driver.close()
      } catch {
        // ignore close errors
      }
    }
  }
}

function printUsage() {
  console.log(`natl v${VERSION} — natural-language E2E testing for web and mobile apps

Usage:
  natl run    <file> [--config <p>] [--provider <p>] [--model <m>] [--report <f>] [--headed] [--mode auto|replay|record]
  natl replay <file> [--config <p>] [--report <f>]
  natl record <file> [--config <p>] [--report <f>]
  natl init
  natl --help
  natl --version

Commands:
  run     Execute a test file in the selected mode (default: auto).
  replay  Run with mode=replay (zero model calls).
  record  Run with mode=record (always plan and record).

Options:
  --config  Path to natl.config.json (default: ./natl.config.json).
  --provider Override provider (openai, anthropic, deepseek, ollama).
  --model   Override model name.
  --report  Write JSON report to this path.
  --headed  Run the browser in headed mode (non-headless).`)
}

// --- main ---

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'

try {
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printUsage()
    exitWith(0)
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(`natl v${VERSION}`)
    exitWith(0)
  }

  if (cmd === 'init') {
    const { init, askQuestions } = await import('../src/init.js')
    const answers = await askQuestions(true)
    const { configPath, testPath, backups = [] } = await init({ cwd: process.cwd(), answers })
    for (const bak of backups) {
      console.log(`Previous file kept: ${bak}`)
    }
    console.log(`Config written to: ${configPath}`)
    console.log(`Starter test:     ${testPath}`)
    console.log()
    console.log('Next steps:')
    console.log('  1. Export your API key, e.g. export NATL_API_KEY=...')
    console.log(`  2. Edit the starter test at ${testPath}`)
    console.log('  3. Run:  natl run ' + testPath)
    exitWith(0)
  }

  if (cmd === 'run' || cmd === 'replay' || cmd === 'record') {
    let mode = cmd === 'replay' ? 'replay' : cmd === 'record' ? 'record' : 'auto'
    const file = args[1]
    if (!file) die('missing test file path')

    const flags = {}
    // Accept both --flag=value and --flag value.
    const VALUE_FLAGS = { '--config': 'config', '--provider': 'provider', '--model': 'model', '--report': 'report', '--mode': 'mode', '--base-url': 'baseUrl' }
    for (let i = 2; i < args.length; i++) {
      const a = args[i]
      if (a === '--headed') { flags.headed = true; continue }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=')
        if (eq !== -1) {
          const name = a.slice(0, eq)
          if (VALUE_FLAGS[name]) { flags[VALUE_FLAGS[name]] = a.slice(eq + 1); continue }
          die(`unknown flag: ${name}`)
        }
        if (VALUE_FLAGS[a]) {
          const next = args[i + 1]
          if (next === undefined || next.startsWith('--')) die(`flag ${a} needs a value`)
          flags[VALUE_FLAGS[a]] = next
          i++
          continue
        }
        die(`unknown flag: ${a}`)
      }
      die(`unexpected argument: ${a} (only one test file is supported)`)
    }

    // --mode overrides the mode implied by the subcommand (natl replay/record
    // set it; `natl run --mode replay` is equivalent to `natl replay`).
    const MODE_VALUES = new Set(['auto', 'replay', 'record'])
    if (flags.mode !== undefined) {
      if (!MODE_VALUES.has(flags.mode)) {
        die(`--mode must be one of auto, replay, record (got ${flags.mode})`)
      }
      mode = flags.mode
    }

    const cfg = loadConfig(flags.config)
    const report = await run(file, cfg, mode, flags.provider, flags.model, flags.report, flags.headed, flags.baseUrl)
    exitWith(report.ok ? 0 : 1)
  }

  die(`unknown command: ${cmd}. Run 'natl --help' for usage.`)
} catch (err) {
  if (err.isUsageExit) exitWith(err.code, err.message)
  console.error(`natl: ${err?.message ?? String(err)}`)
  exitWith(1)
}