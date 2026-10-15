// Setup wizard: writes natl.config.json, a starter test, .env.example, and
// (mobile only) a capabilities file. `init` is a pure function of its
// `answers` argument plus the filesystem: it never touches readline when
// `answers` is provided, so it is testable without a TTY.
import fs from 'node:fs/promises';
import path from 'node:path';
import { NatlError } from './errors.js';
import { PROVIDER_BASE_URLS } from './llm.js';

/** Base URLs used when `answers.baseUrl` is null. Ollama needs no key. */
export const PROVIDERS = PROVIDER_BASE_URLS;

function fail(message) {
  throw new NatlError(message);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`answers.${field} must be a non-empty string (got ${String(value)}).`);
  }
  return value;
}

/**
 * Validate `answers` against the init contract. Throws NatlError on the first
 * problem with a clear message. Returns the normalized answers.
 */
export function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    fail('answers must be an object with a non-empty projectName.');
  }
  const out = { ...answers };

  out.projectName = requireString(answers.projectName, 'projectName');
  if (!/^[\w.-]+$/.test(out.projectName)) {
    fail(`answers.projectName '${out.projectName}' must be a safe file name (letters, digits, dot, dash, underscore only).`);
  }
  if (out.appType !== 'web' && out.appType !== 'mobile') {
    fail(`answers.appType must be 'web' or 'mobile' (got ${String(out.appType)}).`);
  }
  if (!Object.hasOwn(PROVIDERS, out.provider)) {
    fail(`answers.provider must be one of ${Object.keys(PROVIDERS).join(', ')} (got ${String(out.provider)}).`);
  }
  out.model = requireString(answers.model, 'model');

  if (out.appType === 'mobile') {
    const m = out.mobile;
    if (!m || typeof m !== 'object') {
      fail("answers.mobile is required when appType is 'mobile' (needs {server, appPath, deviceName, platformVersion, selectors}).");
    }
    if (typeof m.server !== 'string' || m.server.length === 0) {
      fail('answers.mobile.server is required when appType is "mobile" (e.g. "http://127.0.0.1:4723").');
    }
    out.mobile = {
      server: m.server,
      appPath: typeof m.appPath === 'string' ? m.appPath : '',
      deviceName: typeof m.deviceName === 'string' ? m.deviceName : '',
      platformVersion: typeof m.platformVersion === 'string' ? m.platformVersion : '',
      selectors: {
        mode: m.selectors && typeof m.selectors.mode === 'string' ? m.selectors.mode : 'auto',
      },
    };
  }

  if (out.appType === 'web') {
    const w = out.web;
    if (!w || typeof w !== 'object') {
      fail("answers.web is required when appType is 'web' (needs {url}).");
    }
    if (typeof w.url !== 'string' || !/^(https?:\/\/)/.test(w.url)) {
      fail('answers.web.url is required when appType is "web" and must start with http:// or https:// (got ' + JSON.stringify(w.url ?? null) + ').');
    }
    out.web = {
      url: w.url,
      headless: w.headless !== false, // default true; only an explicit false opts out
      device: typeof w.device === 'string' ? w.device : null,
    };
  }

  // Never leak a key into answers-based config: the key travels only via env.
  out.apiKey = null;
  return out;
}

/** W3C-shaped capabilities for a mobile answers object. */
export function buildCapabilities(mobile, platform) {
  const isIos = platform === 'ios';
  return {
    platformName: isIos ? 'iOS' : 'Android',
    'appium:automationName': isIos ? 'XCUITest' : 'UiAutomator2',
    'appium:deviceName': mobile.deviceName,
    'appium:platformVersion': mobile.platformVersion,
    'appium:app': mobile.appPath,
  };
}

function starterTest({ projectName, appType }) {
  if (appType === 'mobile') {
    // No goto/click on mobile: fill via an accessibility-id plus one NL step.
    return `import { test, step, fill, expectText, expectCount } from 'natl/src/steps.js';

const t = test('${projectName}: mobile login', [
  step('Open the app'),
  fill('accessibility id=login_email', 'tester@example.com'),
  fill('accessibility id=login_password', 'hunter2'),
  step('Tap the sign in button'),
  expectText('accessibility id=welcome_banner', 'Welcome back'),
  expectCount('accessibility id=items', 0),
]);

console.log('Run: natl run examples/${projectName}/${projectName}.test.js');
console.log(t.name);
`;
  }
  return `import { test, step, goto, click, fill, expectText, expectCount } from 'natl/src/steps.js';

const t = test('${projectName}: web smoke', [
  goto('/'),
  click('#submit-button'),
  fill('#search-input', 'hello'),
  step('Log in as a new user'),
  expectText('#status', 'OK'),
  expectCount('#items .item', 1),
]);

console.log('Run: natl run examples/${projectName}/${projectName}.test.js');
console.log(t.name);
`;
}

function envExample({ provider, model, apiKeyGiven }) {
  let text = `NATL_API_KEY=\nNATL_PROVIDER=${provider}\nNATL_MODEL=${model}\n`;
  if (apiKeyGiven) {
    text += `# Paste your ${provider} API key into NATL_API_KEY above, or export it in your shell.\n`;
  }
  return text;
}

/**
 * @param {{cwd: string, answers: object, interactive?: boolean}} opts
 * @returns {Promise<{configPath: string, testPath: string, starterCode: string}>}
 */
export async function init({ cwd, answers, interactive = false }) {
  if (!cwd || typeof cwd !== 'string') {
    fail('init requires a cwd (a directory to write into).');
  }
  if (answers === undefined) {
    if (!interactive) {
      fail('init: answers is required (or pass interactive: true and a TTY to ask questions).');
    }
    answers = await askQuestions(interactive);
  }
  const a = validateAnswers(answers);
  const root = path.resolve(cwd);

  const config = {
    appType: a.appType,
    provider: a.provider,
    model: a.model,
    baseUrl: a.baseUrl ?? PROVIDERS[a.provider],
    cacheDir: '.natl/cache',
  };
  if (a.appType === 'web') {
    config.web = { url: a.web.url, headless: a.web.headless, device: a.web.device };
  } else {
    config.mobile = {
      server: a.mobile.server,
      capabilities: buildCapabilities(a.mobile, a.platform),
      selectors: { mode: a.mobile.selectors.mode },
    };
  }

  const configPath = path.join(root, 'natl.config.json');
  const testDir = path.join(root, 'examples', a.projectName);
  const testPath = path.join(testDir, `${a.projectName}.test.js`);

  await fs.mkdir(testDir, { recursive: true });
  const starterCode = starterTest({ projectName: a.projectName, appType: a.appType });
  const envContent = envExample({
    provider: a.provider,
    model: a.model,
    apiKeyGiven: typeof answers.apiKey === 'string' && answers.apiKey.length > 0,
  });

  const written = [
    [configPath, JSON.stringify(config, null, 2) + '\n'],
    [testPath, starterCode],
    [path.join(root, '.env.example'), envContent],
  ];
  if (a.appType === 'mobile') {
    written.push([path.join(root, 'examples', a.projectName, 'capabilities.json'), JSON.stringify(config.mobile.capabilities, null, 2) + '\n']);
  }
  // Re-running `natl init` to add a test used to overwrite the user's config,
  // starter test and .env.example with generated content — losing a hand-tuned
  // baseUrl, the real app URL, and hours of test source. Keep the previous
  // file next to the new one instead of destroying it.
  const backups = [];
  for (const [p, text] of written) {
    try {
      await fs.access(p);
      const bak = `${p}.bak`;
      await fs.copyFile(p, bak);
      backups.push(bak);
    } catch {
      // No existing file: nothing to preserve.
    }
    await fs.writeFile(p, text, 'utf8');
  }

  return { configPath, testPath, starterCode, backups };
}

/**
 * Interactive wrapper around node:readline/promises. Only called when
 * `answers` is omitted AND `interactive: true` (i.e. a TTY is available);
 * without a TTY it throws rather than block on stdin. Prompts, in order:
 * projectName, appType, (platform if mobile), then the mobile/web fields,
 * provider, model, baseUrl, and finally the key.
 * Returns an `answers` object matching the shape documented above.
 */
export async function askQuestions(interactive = false) {
  if (!interactive) {
    fail('askQuestions needs interactive: true (no TTY is available to prompt on).');
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt, fallback) => {
    const v = (await rl.question(prompt)).trim();
    return v.length > 0 ? v : fallback;
  };
  try {
    const projectName = await ask('Project/test name: ');
    const appType = await ask("App type (web|mobile): ", 'web');
    let platform;
    let mobile;
    let web;
    if (appType === 'mobile') {
      platform = await ask('Platform (android|ios): ', 'android');
      mobile = {
        server: await ask('Appium server URL: ', 'http://127.0.0.1:4723'),
        appPath: await ask('App path (.apk / .app): ', ''),
        deviceName: await ask('Device name: ', ''),
        platformVersion: await ask('Platform version: ', ''),
        selectors: { mode: await ask('Selector mode (auto|xpath|accessibility-id|css): ', 'auto') },
      };
    } else {
      web = {
        url: await ask('Starting URL (http(s)://...): '),
        headless: (await ask('Headless? (y|n): ', 'y')).toLowerCase() !== 'n',
        device: await ask('Emulated device (e.g. "iPhone 13"), leave blank for none: ', ''),
      };
      web.device = web.device === '' ? null : web.device;
    }
    const provider = await ask('Provider (openai|anthropic|deepseek|ollama): ', 'openai');
    const model = await ask('Model name: ', provider === 'openai' ? 'gpt-4o-mini' : provider === 'anthropic' ? 'claude-sonnet-4-5' : provider === 'deepseek' ? 'deepseek-chat' : 'llama3.1');
    const baseUrl = await ask(`Base URL (blank for ${PROVIDERS[provider] ?? provider} default): `, PROVIDERS[provider] ?? '');
    const answers = {
      projectName,
      appType,
      platform,
      provider,
      model,
      baseUrl,
      web,
      mobile,
      apiKey: null,
    };
    if (provider !== 'ollama') {
      const key = await ask('API key (leave blank; export it into env instead): ');
      answers.apiKey = key.length > 0 ? key : null;
    }
    return answers;
  } finally {
    rl.close();
  }
}
