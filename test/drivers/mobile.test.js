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

const UIAUTOMATOR2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <node class="android.widget.TextView" text="Welcome" resource-id="com.example:id/title"/>
  <node class="android.widget.EditText" text="" resource-id="com.example:id/email" content-desc=""/>
  <node class="android.widget.Button" text="Sign In" content-desc="Sign In" resource-id="com.example:id/signin"/>
  <node class="android.widget.CheckBox" text="" content-desc="Remember me" resource-id="com.example:id/remember"/>
</hierarchy>`

test('a dead session throws instead of reporting an empty page', async () => {
  // Appium answers a gone session with HTTP 404 {error:"invalid session id"}.
  // Treating that as "element not found" turned expectCount(sel, 0) into a
  // silently passing assertion on a corpse.
  const http = await import('node:http')
  let dead = false
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && pathname === '/session') return send(200, { value: { sessionId: 's1' }, sessionId: 's1' })
    if (dead) return send(404, { value: { error: 'invalid session id', message: 'Session is gone' } })
    if (req.method === 'GET' && pathname.endsWith('/source')) return send(200, { value: '<hierarchy/>' })
    if (req.method === 'POST' && pathname.endsWith('/element')) return send(404, { value: { error: 'no such element', message: 'not found' } })
    return send(404, { value: { error: 'no such element' } })
  })
  await new Promise((resolve) => server.listen(0, resolve))
  try {
    const driver = createMobileDriver({ server: `http://127.0.0.1:${server.address().port}` })
    await driver.open()

    // Healthy session, element genuinely absent: the documented 0.
    assert.deepEqual(await driver.find('nope'), { text: '', count: 0 })

    // Session dies: every endpoint now answers 404 invalid session id.
    dead = true
    await assert.rejects(
      () => driver.find('nope'),
      (err) => err.details?.error === 'invalid session id',
      'a dead session must throw, never read as an empty page',
    )
    await assert.rejects(() => driver.act({ action: 'click', ref: '0' }))
  } finally {
    server.close()
  }
})

test('roles come from the class attribute of a real UiAutomator2 source', async () => {
  // UiAutomator2 emits every node as <node class="android.widget.X"/>. Matching
  // on the TAG made the kind the constant string 'node', so the whole role
  // taxonomy was unreachable and the planner was told a Button is a text node.
  await withFake({ fixture: UIAUTOMATOR2_XML }, async ({ driver }) => {
    const snap = await driver.snapshot()
    const byName = (n) => snap.elements.find((e) => e.name === n)
    assert.equal(byName('Welcome')?.role, 'text')
    assert.equal(byName('com.example:id/email')?.role, 'textbox')
    assert.equal(byName('Sign In')?.role, 'button')
    assert.equal(byName('Remember me')?.role, 'checkbox')
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

test('act(fill) sends codepoints, not UTF-16 units, for non-BMP characters', async () => {
  // W3C Element Send Keys wants an array of Unicode CODE POINTS. `split('')`
  // returns UTF-16 code units, so an emoji was sent as two lone surrogates and
  // the device received two replacement characters instead of one glyph.
  await withFake({}, async ({ driver, calls }) => {
    const snap = await driver.snapshot()
    const ref = snap.elements.find((e) => e.role === 'textbox').ref
    await driver.act({ action: 'fill', ref, value: 'a\u{1F600}b' })
    const value = calls.find((c) => c.path.endsWith('/value'))
    const body = JSON.parse(value.body)
    assert.equal(body.text, 'a\u{1F600}b')
    assert.deepEqual(body.value, ['a', '\u{1F600}', 'b'])
    assert.equal(body.value.length, 3, 'three codepoints, not four UTF-16 units')
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

// ---------------------------------------------------------------------------
// regression: refs are identities inside the planned snapshot, not live indexes
// ---------------------------------------------------------------------------

const SHIFTING_PAGE_BEFORE = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.EditText resource-id="com.example:id/email" text=""/>
  <android.widget.Button content-desc="Sign In" text=""/>
</hierarchy>`

const SHIFTING_PAGE_AFTER = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.TextView content-desc="Row just added" text=""/>
  <android.widget.EditText resource-id="com.example:id/email" text=""/>
  <android.widget.Button content-desc="Sign In" text=""/>
</hierarchy>`

/**
 * A fake device whose page source changes after the first read — what a real
 * app does once the first action mutates the screen.
 */
async function withShiftingFake(fn) {
  const http = await import('node:http')
  let sourceReads = 0
  const lookups = []
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost')
    const json = (o) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    if (req.method === 'POST' && pathname === '/session') {
      return json({ value: { sessionId: 's1' }, sessionId: 's1' })
    }
    if (req.method === 'GET' && pathname.endsWith('/source')) {
      sourceReads += 1
      return json({ value: sourceReads <= 1 ? SHIFTING_PAGE_BEFORE : SHIFTING_PAGE_AFTER })
    }
    if (req.method === 'POST' && pathname.endsWith('/element')) {
      let body = ''
      req.on('data', (c) => { body += c })
      return req.on('end', () => {
        const { using, value } = JSON.parse(body)
        lookups.push(`${using}=${value}`)
        // The W3C key exactly as a spec-compliant server sends it.
        json({ value: { 'element-6066-11e4-a52e-4f735466cef': `el-${lookups.length}` } })
      })
    }
    return json({ value: null })
  })
  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()
  try {
    const driver = createMobileDriver({ server: `http://127.0.0.1:${port}` })
    await driver.open()
    return await fn({ driver, lookups, sourceReads: () => sourceReads })
  } finally {
    server.close()
  }
}

test('act() targets the element the plan named even when the page shifted under it', async () => {
  // Recorded plan: fill ref 0 (the email field), then click ref 1 (Sign In).
  // act() used to re-read the page source per action and re-index the refs, so
  // both actions landed on whatever slid into the old index.
  await withShiftingFake(async ({ driver, lookups, sourceReads }) => {
    const snap = await driver.snapshot()
    const emailRef = snap.elements.find((e) => e.name === 'com.example:id/email').ref
    const signInRef = snap.elements.find((e) => e.name === 'Sign In').ref

    await driver.act({ action: 'fill', ref: emailRef, value: 'ada@example.com' })
    await driver.act({ action: 'click', ref: signInRef })

    assert.deepEqual(lookups, [
      // A resource-id resolves with the `id` strategy; `accessibility id` maps to
      // content-desc on Android and never matches a resource-id.
      'id=com.example:id/email',
      // A content description is a real accessibility id.
      'accessibility id=Sign In',
    ], 'each action must target the element its ref named')
    assert.equal(sourceReads(), 1, 'act() must not re-snapshot between actions of one plan')
  })
})

test('a wedged Appium server is a timeout error, not a hang', async () => {
  // The server accepts the connection and never answers — an Appium that is
  // alive enough to hold the socket but not enough to reply.
  const http = await import('node:http')
  const server = http.createServer(() => { /* never respond */ })
  await new Promise((resolve) => server.listen(0, resolve))

  const prevTimeout = process.env.NATL_WD_TIMEOUT_MS
  process.env.NATL_WD_TIMEOUT_MS = '80'
  try {
    const driver = createMobileDriver({ server: `http://127.0.0.1:${server.address().port}` })
    const started = Date.now()
    await assert.rejects(
      () => driver.open(),
      (err) => err.name === 'NatlError' && /timed out after 80ms/.test(err.message),
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `expected an ~80ms deadline, waited ${elapsed}ms`)
  } finally {
    if (prevTimeout === undefined) delete process.env.NATL_WD_TIMEOUT_MS
    else process.env.NATL_WD_TIMEOUT_MS = prevTimeout
    server.close()
  }
})
