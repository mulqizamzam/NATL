import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { init, validateAnswers } from '../src/init.js';

const webAnswers = {
  projectName: 'webproj',
  appType: 'web',
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: null,
  web: { url: 'http://127.0.0.1:4173', headless: true, device: 'iPhone 13' },
  apiKey: null,
};

const mobileAnswers = {
  projectName: 'mobproj',
  appType: 'mobile',
  platform: 'android',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  baseUrl: null,
  mobile: {
    server: 'http://127.0.0.1:4723',
    appPath: '/tmp/app.apk',
    deviceName: 'emulator-5554',
    platformVersion: '14',
    selectors: { mode: 'auto' },
  },
  apiKey: null,
};

async function tmpDir() {
  return await fs.mkdtemp(os.tmpdir() + '/natl-init-');
}

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test('web: config has appType web and no mobile key', async () => {
  const dir = await tmpDir();
  const { configPath, testPath } = await init({ cwd: dir, answers: webAnswers });
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(cfg.appType, 'web');
  assert.equal(cfg.mobile, undefined);
  assert.equal(cfg.web.url, 'http://127.0.0.1:4173');
  assert.equal(cfg.baseUrl, 'https://api.openai.com/v1'); // null -> provider default
  assert.ok(!(await exists(path.join(dir, 'examples', 'webproj', 'capabilities.json'))));
  assert.ok(testPath.endsWith('examples/webproj/webproj.test.js'));
});

test('mobile: config has mobile.server and mobile.capabilities', async () => {
  const dir = await tmpDir();
  const { configPath } = await init({ cwd: dir, answers: mobileAnswers });
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(cfg.appType, 'mobile');
  assert.equal(cfg.mobile.server, 'http://127.0.0.1:4723');
  assert.deepEqual(cfg.mobile.capabilities, {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': 'emulator-5554',
    'appium:platformVersion': '14',
    'appium:app': '/tmp/app.apk',
  });
  assert.deepEqual(cfg.mobile.selectors, { mode: 'auto' });
  assert.equal(cfg.web, undefined);
  // Capabilities live in the config, and nowhere else: init used to also write
  // examples/<proj>/capabilities.json, which the CLI never read.
  assert.equal(cfg.mobile.capabilities.platformName, 'Android');
  await assert.rejects(
    () => fs.readFile(path.join(dir, 'examples', 'mobproj', 'capabilities.json'), 'utf8'),
    (err) => err.code === 'ENOENT',
    'no stray capabilities file may be written',
  );
});

test('ios: capabilities use XCUITest and iOS', async () => {
  const dir = await tmpDir();
  const iosAnswers = {
    ...mobileAnswers,
    platform: 'ios',
    mobile: { ...mobileAnswers.mobile, deviceName: 'iPhone 13', platformVersion: '17.0' },
  };
  const { configPath } = await init({ cwd: dir, answers: iosAnswers });
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(cfg.mobile.capabilities.platformName, 'iOS');
  assert.equal(cfg.mobile.capabilities['appium:automationName'], 'XCUITest');
});

test('a non-empty apiKey never lands in any written file', async () => {
  const dir = await tmpDir();
  await init({ cwd: dir, answers: { ...webAnswers, apiKey: 'sk-secret' } });
  const files = await walk(dir);
  for (const f of files) {
    const text = await fs.readFile(f, 'utf8');
    assert.ok(!text.includes('sk-secret'), `leaked key into ${f}`);
  }
  const env = await fs.readFile(path.join(dir, '.env.example'), 'utf8');
  assert.ok(env.startsWith('NATL_API_KEY=')); // key value left empty
  assert.match(env, /paste/i); // comment telling the user to paste it manually
});

test('invalid appType throws', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => init({ cwd: dir, answers: { ...webAnswers, appType: 'desktop' } }),
    (err) => {
      assert.equal(err.name, 'NatlError');
      assert.match(err.message, /appType/);
      return true;
    },
  );
});

test('web without web.url throws', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => init({ cwd: dir, answers: { ...webAnswers, web: { url: '' } } }),
    (err) => {
      assert.equal(err.name, 'NatlError');
      assert.match(err.message, /web\.url/);
      return true;
    },
  );
  await assert.rejects(
    () => init({ cwd: dir, answers: { ...webAnswers, web: {} } }),
    (err) => err.name === 'NatlError',
  );
});

test('bad provider and empty model throw', async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => init({ cwd: dir, answers: { ...webAnswers, provider: 'mistral' } }),
    (err) => err.name === 'NatlError' && /provider/.test(err.message),
  );
  await assert.rejects(
    () => init({ cwd: dir, answers: { ...webAnswers, model: '' } }),
    (err) => err.name === 'NatlError' && /model/.test(err.message),
  );
});

test('mobile without server throws', async () => {
  const dir = await tmpDir();
  const noServer = { ...mobileAnswers, mobile: { ...mobileAnswers.mobile, server: '' } };
  await assert.rejects(
    () => init({ cwd: dir, answers: noServer }),
    (err) => err.name === 'NatlError' && /mobile\.server/.test(err.message),
  );
});

test('starter test is returned and contains a step( call', async () => {
  const dir = await tmpDir();
  const { starterCode } = await init({ cwd: dir, answers: webAnswers });
  assert.equal(typeof starterCode, 'string');
  assert.match(starterCode, /step\(/);
  // The generated file must not reach outside the project it lives in: the old
  // '../../../src/steps.js' resolved to the PARENT of the project root, so
  // every generated starter test died with ERR_MODULE_NOT_FOUND.
  assert.match(starterCode, /from 'natl\/src\/steps\.js'/)
  assert.doesNotMatch(starterCode, /\.\.\/\.\.\/\.\.\//, 'no path may climb out of the project')
  const written = await fs.readFile(path.join(dir, 'examples', 'webproj', 'webproj.test.js'), 'utf8');
  assert.equal(written, starterCode);
});

test('mobile starter uses accessibility-id and omits goto/click', async () => {
  const dir = await tmpDir();
  const { starterCode } = await init({ cwd: dir, answers: mobileAnswers });
  assert.match(starterCode, /step\(/);
  assert.match(starterCode, /accessibility id=/);
  assert.ok(!/goto\(/.test(starterCode));
  assert.ok(!/click\(/.test(starterCode));
});

test('validateAnswers normalizes and strips apiKey', () => {
  const a = validateAnswers({ ...webAnswers, apiKey: 'sk-x' });
  assert.equal(a.apiKey, null);
  assert.equal(a.web.headless, true);
  assert.equal(a.web.device, 'iPhone 13');
});

test('re-running init keeps the previous config instead of destroying it', async () => {
  // `natl init` is re-run to add a test. It used to overwrite natl.config.json,
  // the starter test and .env.example outright, taking a hand-tuned baseUrl,
  // the real app URL and the test source with it.
  const dir = await tmpDir();
  await init({ cwd: dir, answers: webAnswers })
  const configPath = path.join(dir, 'natl.config.json')
  const testPath = path.join(dir, 'examples', 'webproj', 'webproj.test.js')
  const envPath = path.join(dir, '.env.example')

  const tuned = { ...JSON.parse(await fs.readFile(configPath, 'utf8')), baseUrl: 'https://internal.corp/v1' }
  await fs.writeFile(configPath, JSON.stringify(tuned, null, 2) + '\n', 'utf8')
  await fs.writeFile(testPath, '// MY HOURS OF WORK\n', 'utf8')
  await fs.writeFile(envPath, 'NATL_API_KEY=sk-real\n', 'utf8')

  const { backups } = await init({ cwd: dir, answers: webAnswers })

  assert.equal(backups.length, 3, 'every overwritten file must be preserved')
  assert.ok(backups.includes(configPath + '.bak'))
  assert.ok(backups.includes(testPath + '.bak'))
  assert.ok(backups.includes(envPath + '.bak'))
  assert.equal(JSON.parse(await fs.readFile(configPath + '.bak', 'utf8')).baseUrl, 'https://internal.corp/v1')
  assert.match(await fs.readFile(testPath + '.bak', 'utf8'), /MY HOURS OF WORK/)
  assert.match(await fs.readFile(envPath + '.bak', 'utf8'), /sk-real/)
  // and the new content still landed
  assert.match(await fs.readFile(testPath, 'utf8'), /step\(/)
})

test('init rejects a selector mode the mobile driver cannot honour', async () => {
  // The interactive prompt offered auto|xpath|accessibility-id|css, but
  // createMobileDriver accepts only 'auto': init happily wrote a config that
  // `natl run` then refused to load.
  const dir = await tmpDir()
  const bogus = { ...mobileAnswers, mobile: { ...mobileAnswers.mobile, selectors: { mode: 'xpath' } } }
  await assert.rejects(
    () => init({ cwd: dir, answers: bogus }),
    (err) => err.name === 'NatlError' && /selectors\.mode/.test(err.message) && /auto/.test(err.message),
  )
})

test('init accepts selectors.mode auto', async () => {
  const dir = await tmpDir()
  const ok = { ...mobileAnswers, mobile: { ...mobileAnswers.mobile, selectors: { mode: 'auto' } } }
  const res = await init({ cwd: dir, answers: ok })
  assert.match(res.configPath, /natl\.config\.json$/)
})
