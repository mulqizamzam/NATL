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
  const caps = JSON.parse(
    await fs.readFile(path.join(dir, 'examples', 'mobproj', 'capabilities.json'), 'utf8'),
  );
  assert.equal(caps.platformName, 'Android');
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
  assert.match(starterCode, /from '\.\.\/\.\.\/\.\.\/src\/steps\.js'/);
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
