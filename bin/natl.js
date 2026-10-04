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

function die(msg) {
  console.error(`natl: ${msg}`)
  process.exit(2)
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
      // Mobile is not available here — the driver file may not yet exist.
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

    process.exit(report.ok ? 0 : 1)
  } catch (err) {
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

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  printUsage()
  process.exit(0)
}
if (cmd === '--version' || cmd === '-v') {
  console.log(`natl v${VERSION}`)
  process.exit(0)
}

if (cmd === 'init') {
  const { init, askQuestions } = await import('../src/init.js')
  try {
    const answers = await askQuestions(true)
    const { configPath, testPath } = await init({ cwd: process.cwd(), answers })
    console.log(`Config written to: ${configPath}`)
    console.log(`Starter test:     ${testPath}`)
    console.log()
    console.log('Next steps:')
    console.log(`  1. Export your API key, e.g. export NATL_API_KEY=...`)
    console.log(`  2. Edit the starter test at ${testPath}`)
    console.log(`  3. Run:  natl run ${testPath}`)
  } catch (err) {
    if (err.message?.includes('EISDIR') || err.message?.includes('not a tty')) {
      die('interactive mode requires a TTY; pass --answers=<json> instead')
    }
    throw err
  }
  process.exit(0)
}

if (cmd === 'run' || cmd === 'replay' || cmd === 'record') {
  const mode = cmd === 'replay' ? 'replay' : cmd === 'record' ? 'record' : 'auto'
  const file = args[1]
  if (!file) die('missing test file path')

  const flags = {}
  for (let i = 2; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--config=')) flags.config = a.slice(9)
    else if (a.startsWith('--provider=')) flags.provider = a.slice(11)
    else if (a.startsWith('--model=')) flags.model = a.slice(8)
    else if (a.startsWith('--report=')) flags.report = a.slice(9)
    else if (a === '--headed') flags.headed = true
    else if (a.startsWith('--')) die(`unknown flag: ${a}`)
  }

  const cfg = loadConfig(flags.config)
  await run(file, cfg, mode, flags.provider, flags.model, flags.report, flags.headed)
  process.exit(0)
}

die(`unknown command: ${cmd}. Run 'natl --help' for usage.`)