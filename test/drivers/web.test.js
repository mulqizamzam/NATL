import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebDriver } from '../../src/drivers/web.js'
import { makeFingerprint } from '../../src/fingerprint.js'

// Global Constraint 8: browsers live in <repo>/.browsers on this host.
// playwright lazily reads PLAYWRIGHT_BROWSERS_PATH at launch time, not at
// import time, so the env var only needs to be set before chromium.launch()
// fires (inside before()), not before the static import of src/drivers/web.js.
process.env.PLAYWRIGHT_BROWSERS_PATH = '/home/administrator/agent-workspace/project/natl/.browsers'

const PAGE = `
<html>
  <body>
    <main>
      <h1>NatL Fixture</h1>
      <label for="user">Username</label>
      <input id="user" type="text" />
      <button id="signin">Sign In</button>
    </main>
  </body>
</html>
`

let driver
let page

before(async () => {
  // url: undefined -> open() skips goto(), so no server is needed.
  driver = createWebDriver({ headless: true })
  await driver.open()
  page = driver._page
  await page.setContent(PAGE)
})

after(async () => {
  if (driver) await driver.close()
})

describe('web driver (frozen contract 3)', () => {
  it("snapshot() contains {role:'button', name:'Sign In'}", async () => {
    const snap = await driver.snapshot()
    assert.ok(Array.isArray(snap.elements))
    const btn = snap.elements.find((e) => e.role === 'button' && e.name === 'Sign In')
    assert.ok(btn, `expected a Sign In button, got ${JSON.stringify(snap.elements)}`)
    assert.equal(typeof btn.ref, 'string')
    assert.equal(btn.ref, String(snap.elements.indexOf(btn)))
    // frozen contract 2 shape
    assert.deepStrictEqual(Object.keys(snap).sort(), ['elements', 'fingerprint', 'text'])
    assert.match(snap.fingerprint, /^[0-9a-f]{64}$/)
    assert.ok(snap.text.includes('Sign In'))
  })

  it('fingerprint is stable across order and changes on rename', () => {
    // Order must not matter: sha256 over role+name pairs only (rule 4).
    const a = [
      { ref: '0', role: 'button', name: 'Sign In' },
      { ref: '1', role: 'textbox', name: 'Username' },
    ]
    const swapped = [
      { ref: '0', role: 'textbox', name: 'Username' },
      { ref: '1', role: 'button', name: 'Sign In' },
    ]
    assert.equal(makeFingerprint(a), makeFingerprint(swapped))
    // A renamed element must invalidate the fingerprint.
    const renamed = [
      { ref: '0', role: 'button', name: 'Log In' },
      { ref: '1', role: 'textbox', name: 'Username' },
    ]
    assert.notEqual(makeFingerprint(a), makeFingerprint(renamed))
  })

  it("act({action:'click'}) fires the click handler", async () => {
    await page.setContent(`
      <html><body>
        <button id="signin" onclick="window.__clicked = true">Sign In</button>
      </body></html>
    `)
    await driver.snapshot()
    const btnRef = driver._elements.find((e) => e.name === 'Sign In').ref
    await driver.act({ action: 'click', ref: btnRef })
    assert.equal(await page.evaluate(() => window.__clicked === true), true)
  })

  it("act({action:'fill', value}) sets the input value", async () => {
    await page.setContent(`
      <html><body>
        <label for="user">Username</label>
        <input id="user" type="text" />
      </body></html>
    `)
    await driver.snapshot()
    const inputRef = driver._elements.find((e) => e.role === 'textbox').ref
    await driver.act({ action: 'fill', ref: inputRef, value: 'x' })
    assert.equal(await page.locator('#user').inputValue(), 'x')
  })

  it("find('#missing') returns count 0 without throwing", async () => {
    await page.setContent(PAGE)
    const res = await driver.find('#missing')
    assert.deepStrictEqual(res, { text: '', count: 0 })
  })

  it("find('#signin') returns the button's text", async () => {
    await page.setContent(PAGE)
    const res = await driver.find('#signin')
    assert.deepStrictEqual(res, { text: 'Sign In', count: 1 })
  })
})
