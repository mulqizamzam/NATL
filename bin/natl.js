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
import { dirname, join } from 'node:path'
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

// Browser path: the natl repo pins browsers in .browsers/ (a writable location
// on this host; the default ~/.cache is read-only in the DSH sandbox). Set
// before any Playwright import so the real module picks it up.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.browsers')

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

async function run(file, cfg, mode, providerOverride, modelOverride, reportPath, headed) {
  const { createWebDriver } = await import('../src/drivers/web.js')
  let driver = null
  try {
    const appType = cfg.appType ?? 'web'

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
      driver = createWebDriver({
        url: cfg.web?.url ?? 'http://127.0.0.1:4173',
        headless: headed ? false : (cfg.web?.headless ?? true),
        device: cfg.web?.device ?? null,
      })
    }

    await driver.open()

    // Load the test file.
    const modUrl = file.startsWith('file://') ? file : `file://${join(process.cwd(), file)}`
    const mod = await import(modUrl)
    const testObj = mod.default ?? Object.values(mod).find((v) => v?.kind === 'test')
    if (!testObj || testObj.kind !== 'test') {
      die(`no test object found in ${file}`)
    }

    // Provider config: CLI flag wins, then config file, then env.
    const providerName = providerOverride ?? cfg.provider ?? process.env.NATL_PROVIDER
    const model =
      modelOverride ?? cfg.model ?? process.env.NATL_MODEL ?? (providerName === 'ollama' ? 'qwen3' : undefined)
    const apiKey =
      process.env.NATL_API_KEY ??
      process.env[`${String(providerName ?? '').toUpperCase()}_API_KEY`] ??
      ''
    const provider = providerName
      ? { provider: providerName, model, apiKey, baseUrl: cfg.baseUrl ?? process.env.NATL_BASE_URL ?? undefined }
      : null

    const cacheDir = cfg.cacheDir ?? '.natl/cache'
    const cachePath = join(process.cwd(), cacheDir, `${file.replace(/[^\w.-]/g, '_')}.json`)

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
      await writeFile(reportPath, toJson(report), 'utf8')
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
    const { configPath, testPath } = await init({ cwd: process.cwd(), answers })
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
    const mode = cmd === 'replay' ? 'replay' : cmd === 'record' ? 'record' : 'auto'
    const file = args[1]
    if (!file) die('missing test file path')

    const flags = {}
    // Accept both --flag=value and --flag value.
    const VALUE_FLAGS = { '--config': 'config', '--provider': 'provider', '--model': 'model', '--report': 'report' }
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
    }

    const cfg = loadConfig(flags.config)
    const report = await run(file, cfg, mode, flags.provider, flags.model, flags.report, flags.headed)
    exitWith(report.ok ? 0 : 1)
  }

  die(`unknown command: ${cmd}. Run 'natl --help' for usage.`)
} catch (err) {
  if (err.isUsageExit) exitWith(err.code, err.message)
  console.error(`natl: ${err?.message ?? String(err)}`)
  exitWith(1)
}