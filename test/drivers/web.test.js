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

  it("act({action:'click'}) targets the Nth element when accessible names collide", async () => {
    // A page can expose several elements with the same {role,name}. Resolving
    // by role+name alone always hits the first one, so the ref's position
    // inside its own {role,name} group has to survive down to the locator.
    await page.setContent(`
      <html><body>
        <button id="a1" onclick="window.__hit = 'first'">Add</button>
        <button id="a2" onclick="window.__hit = 'second'">Add</button>
        <button id="a3" onclick="window.__hit = 'third'">Add</button>
      </body></html>
    `)
    await driver.snapshot()
    const adds = driver._elements.filter((e) => e.role === 'button' && e.name === 'Add')
    assert.equal(adds.length, 3)
    await driver.act({ action: 'click', ref: adds[1].ref })
    assert.equal(await page.evaluate(() => window.__hit), 'second')
    await driver.act({ action: 'click', ref: adds[2].ref })
    assert.equal(await page.evaluate(() => window.__hit), 'third')
  })

  it("act({action:'fill'}) targets the Nth element when accessible names collide", async () => {
    await page.setContent(`
      <html><body>
        <input aria-label="Qty" />
        <input aria-label="Qty" />
      </body></html>
    `)
    await driver.snapshot()
    const boxes = driver._elements.filter((e) => e.role === 'textbox' && e.name === 'Qty')
    assert.equal(boxes.length, 2)
    await driver.act({ action: 'fill', ref: boxes[1].ref, value: '7' })
    const values = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map((i) => i.value))
    assert.deepEqual(values, ['', '7'])
  })

  it('snapshot() carries page text, and different text means a different fingerprint', async () => {
    // Playwright reports a paragraph as {role:'paragraph', text:'...'} — its text
    // is not an accessible name. Reading `name` alone left the planner blind to
    // page content and gave two different screens the SAME fingerprint, so a
    // plan recorded on one screen replayed on the other.
    await page.setContent(`
      <html><body>
        <p>Order total: 42.00 EUR</p>
        <p>Shipping to Berlin</p>
        <button>Pay</button>
      </body></html>
    `)
    const a = await driver.snapshot()
    assert.ok(a.text.includes('42.00'), `page text missing from snapshot: ${JSON.stringify(a.text)}`)
    assert.ok(a.text.includes('Berlin'), `page text missing from snapshot: ${JSON.stringify(a.text)}`)
    const price = a.elements.find((e) => e.name === 'Order total: 42.00 EUR')
    assert.ok(price, 'a paragraph must be selectable by its text')

    await page.setContent(`
      <html><body>
        <p>Order total: 99.00 EUR</p>
        <p>Shipping to Paris</p>
        <button>Pay</button>
      </body></html>
    `)
    const b = await driver.snapshot()
    assert.notEqual(a.fingerprint, b.fingerprint, 'two screens with different text must not share a cache key')
  })

  it('close() closes every handle even when one close throws', async () => {
    // One try around three closes meant a failing page.close() left the browser
    // process running — and the `finally` nulled the handles, so nothing could
    // ever reach it again.
    const d = createWebDriver({ headless: true })
    await d.open()
    const { _page: pg, _context: ctx, _browser: br } = d
    const closed = []
    const realPageClose = pg.close.bind(pg)
    const realContextClose = ctx.close.bind(ctx)
    const realBrowserClose = br.close.bind(br)
    pg.close = async () => { closed.push('page'); throw new Error('page close failed') }
    ctx.close = async () => { closed.push('context'); return realContextClose() }
    br.close = async () => { closed.push('browser'); return realBrowserClose() }

    await d.close()

    assert.deepEqual(closed, ['page', 'context', 'browser'])
    assert.equal(br.isConnected(), false, 'the browser process must not survive close()')
    assert.equal(d._browser, null)
    // release the page handle the broken stub could not close
    await realPageClose().catch(() => {})
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
