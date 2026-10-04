import { strict as assert } from 'node:assert'
import test from 'node:test'

import { createMobileDriver } from '../../src/drivers/mobile.js'
import { NatlError } from '../../src/errors.js'
import { startFakeDriver } from '../helpers/fake-webdriver.js'

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.FrameLayout resource-id="root">
    <android.widget.LinearLayout>
      <android.widget.TextView text="Welcome" content-desc=""/>
      <android.widget.EditText resource-id="com.example:id/email" text=""/>
      <android.widget.Button content-desc="Sign In" text=""/>
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

const IOS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAEL>
  <XCUIElementTypeApplication name="Example">
    <XCUIElementTypeButton name="Sign In" label="Sign In" enabled="true"/>
    <XCUIElementTypeStaticText name="Welcome" label="Welcome" value="Welcome"/>
  </XCUIElementTypeApplication>
</AppiumAEL>`

async function withFake(opts, fn) {
  const calls = []
  const { server, port } = await startFakeDriver({ fixture: FIXTURE_XML, calls, ...opts })
  try {
    const driver = createMobileDriver({
      server: `http://127.0.0.1:${port}`,
      capabilities: { platformName: 'Android', 'appium:automationName': 'UiAutomator2' },
    })
    await driver.open()
    return await fn({ driver, calls, port })
  } finally {
    server.close()
  }
}

test('open() POSTs {"capabilities":{"alwaysMatch":caps}} and stores the session id', async () => {
  await withFake({}, async ({ calls }) => {
    const session = calls.find((c) => c.method === 'POST' && c.path === '/session')
    assert.ok(session, 'expected a POST /session call')
    assert.deepEqual(JSON.parse(session.body), {
      capabilities: { alwaysMatch: { platformName: 'Android', 'appium:automationName': 'UiAutomator2' } },
    })
  })
})

test('snapshot() parses the Android XML into role/name elements', async () => {
  await withFake({}, async ({ driver }) => {
    const snap = await driver.snapshot()
    assert.ok(snap.elements.some((e) => e.role === 'button' && e.name === 'Sign In'), 'expected a Sign In button')
    assert.ok(
      snap.elements.some((e) => e.role === 'textbox' && e.name === 'com.example:id/email'),
      'expected the email textbox keyed by resource-id',
    )
    assert.ok(snap.elements.some((e) => e.role === 'text' && e.name === 'Welcome'), 'expected the Welcome text')
    assert.deepEqual(
      snap.elements.map((e) => e.ref),
      snap.elements.map((_e, i) => String(i)),
      'refs are stringified indices in document order',
    )
    assert.match(snap.fingerprint, /^[0-9a-f]{64}$/)
    assert.ok(snap.text.length <= 4000)
  })
})

test('act(click) POSTs to /element/el-Sign In/click', async () => {
  await withFake({}, async ({ driver, calls }) => {
    const snap = await driver.snapshot()
    const ref = snap.elements.find((e) => e.role === 'button').ref
    await driver.act({ action: 'click', ref })
    const click = calls.find((c) => c.path.endsWith('/click'))
    assert.ok(click, 'expected a click call')
    assert.ok(click.path.endsWith('/click'), 'expected a click path')
    assert.ok(click.path.includes('el-Sign In'), `click path should include element id, got: ${click.path}`)
    assert.equal(click.method, 'POST')
  })
})

test('act(fill) posts {"text":value,"value":[...codepoints]} to the edit field', async () => {
  await withFake({}, async ({ driver, calls }) => {
    const snap = await driver.snapshot()
    const ref = snap.elements.find((e) => e.role === 'textbox').ref
    await driver.act({ action: 'fill', ref, value: 'ada@example.com' })
    const value = calls.find((c) => c.path.endsWith('/value'))
    assert.ok(value, 'expected a /value call')
    assert.equal(value.path, '/session/fake-sess-1/element/el-com.example:id/email/value')
    // W3C Element Send Keys requires both 'text' and 'value' (codepoint array).
    const body = JSON.parse(value.body)
    assert.equal(body.text, 'ada@example.com')
    assert.deepEqual(body.value, 'ada@example.com'.split(''))
  })
})

test('a 500 from the server makes act() throw with the status in the message', async () => {
  await withFake(
    { errors: { '/session/fake-sess-1/element/el-Sign In/click': 500 } },
    async ({ driver }) => {
      const snap = await driver.snapshot()
      const ref = snap.elements.find((e) => e.role === 'button').ref
      await assert.rejects(
        () => driver.act({ action: 'click', ref }),
        (err) => {
          assert.ok(err instanceof NatlError)
          assert.match(err.message, /500/)
          assert.match(err.message, /POST/)
          assert.match(err.message, /\/session\/fake-sess-1\/element\/el-Sign(%20| )In\/click$/)
          return true
        },
      )
    },
  )
})

test('close() issues DELETE and a second close() does not throw', async () => {
  const calls = []
  const { server, port } = await startFakeDriver({ fixture: FIXTURE_XML, calls })
  try {
    const driver = createMobileDriver({ server: `http://127.0.0.1:${port}` })
    await driver.open()
    await driver.close()
    const del = calls.find((c) => c.method === 'DELETE')
    assert.ok(del, 'expected a DELETE call')
    assert.equal(del.path, '/session/fake-sess-1')
    await driver.close() // idempotent
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1, 'second close must not re-DELETE')
  } finally {
    server.close()
  }
})

test('find() on a missing selector returns {count:0, text:""}', async () => {
  await withFake({}, async ({ driver }) => {
    assert.deepEqual(await driver.find('nonexistent-id'), { text: '', count: 0 })
  })
})

test('find() on an xpath returns {count:1, text:"Sign In"}', async () => {
  await withFake({}, async ({ driver, calls }) => {
    const result = await driver.find('//button[@text="Sign In"]')
    assert.deepEqual(result, { count: 1, text: 'Sign In' })
    const lookup = calls.find((c) => c.path === '/session/fake-sess-1/element')
    assert.equal(JSON.parse(lookup.body).using, 'xpath')
  })
})

test('find() strips explicit selector prefixes', async () => {
  await withFake({}, async ({ driver, calls }) => {
    await driver.find('id=com.example:id/email')
    await driver.find('xpath=//android.widget.Button')
    const lookups = calls.filter((c) => c.path === '/session/fake-sess-1/element')
    assert.deepEqual(JSON.parse(lookups[0].body), { using: 'id', value: 'com.example:id/email' })
    assert.deepEqual(JSON.parse(lookups[1].body), { using: 'xpath', value: '//android.widget.Button' })
  })
})

test('act() on an unknown ref throws', async () => {
  await withFake({}, async ({ driver }) => {
    await assert.rejects(
      () => driver.act({ action: 'click', ref: '99' }),
      (err) => err instanceof NatlError && /ref 99 not in current snapshot/.test(err.message),
    )
  })
})

test('snapshot() parses iOS XCUIElementType tags', async () => {
  const calls = []
  const { server, port } = await startFakeDriver({ fixture: IOS_XML, calls })
  try {
    const driver = createMobileDriver({ server: `http://127.0.0.1:${port}` })
    await driver.open()
    const snap = await driver.snapshot()
    assert.ok(snap.elements.some((e) => e.role === 'button' && e.name === 'Sign In'))
    assert.ok(snap.elements.some((e) => e.role === 'text' && e.name === 'Welcome'))
    assert.ok(!snap.elements.some((e) => e.name === 'Example'), 'container app node is not a control')
  } finally {
    server.close()
  }
})

test('act(scroll) posts mobile: scroll without resolving an element', async () => {
  await withFake({}, async ({ driver, calls }) => {
    await driver.act({ action: 'scroll', ref: '0', value: 'down' })
    const exec = calls.find((c) => c.path === '/session/fake-sess-1/execute/sync')
    assert.ok(exec)
    assert.deepEqual(JSON.parse(exec.body), { script: 'mobile: scroll', args: [{ direction: 'down' }] })
  })
})

test('goto() is not supported by the mobile driver', async () => {
  await withFake({}, async ({ driver }) => {
    await assert.rejects(
      () => driver.goto('https://example.com'),
      (err) => err instanceof NatlError && err.message === 'goto is not supported for the mobile driver',
    )
  })
})