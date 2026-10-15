import { chromium } from 'playwright'
import { NatlError } from '../errors.js'
import { makeFingerprint } from '../fingerprint.js'

// Playwright 1.63.0: page.accessibility does not exist; ariaSnapshotJSON() is
// the supported element source. Global Constraint 8: this module never touches
// PLAYWRIGHT_BROWSERS_PATH — the caller (test / CI) sets it before import.

const TEXT_CAP = 4000

function flattenAria(nodes) {
  // Depth-first in visit order. Skip nodes with neither role nor name.
  //
  // `name` is the ACCESSIBLE name, so it is absent on anything whose text is
  // not its label: Playwright reports `<p>Order total: 42.00 EUR</p>` as
  // {role:'paragraph', text:'Order total: 42.00 EUR'}. Reading `name` alone
  // dropped every paragraph from the page, which blinded the planner to page
  // content and gave two pages with different text the SAME fingerprint — so a
  // plan recorded on one screen replayed on another.
  const out = []
  const walk = (arr) => {
    for (const node of arr) {
      const name = node.name ?? node.text ?? ''
      if (node.role || name) out.push({ role: node.role || '', name })
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

function ariaText(nodes) {
  // Flattened human-readable content: role + name pairs joined by newline,
  // capped at 4000 chars.
  const lines = []
  const walk = (arr) => {
    for (const node of arr) {
      const name = node.name ?? node.text ?? ''
      if (node.role || name) {
        const pair = [node.role, name].filter(Boolean).join(' ')
        lines.push(pair)
      }
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return lines.join('\n').slice(0, TEXT_CAP)
}

/**
 * Position of `el` among the elements of the same snapshot that share its
 * {role, name} — 0 for the first one.
 *
 * A page routinely exposes several elements with the same accessible name (a
 * table of "Edit" links, three "Add to cart" buttons). {role, name} alone then
 * matches all of them, and resolving with `.first()` silently acts on the wrong
 * one. The runner already computes the ordinal when it remaps a recorded ref
 * (buildRefMap/remapRefs); the ordinal has to survive down to the locator or
 * that disambiguation is thrown away at the last step.
 */
function ordinalInGroup(elements, el) {
  const i = elements
    .filter((e) => e.role === el.role && e.name === el.name)
    .findIndex((e) => e.ref === el.ref)
  return i < 0 ? 0 : i
}

function refLocator(page, el) {
  // Primary locator for a recorded element: getByRole(role, {name, exact:true}).
  // When the element has no accessible name, getByRole({name:''}) matches
  // nothing, so fall back to a bare [role="..."] selector.
  //
  // Returns the UN-narrowed locator: its count() is how callers learn how many
  // elements share this {role,name}, which they need before they can narrow.
  if (el.name) return page.getByRole(el.role, { name: el.name, exact: true })
  return page.locator(`[role="${el.role}"]`)
}

/**
 * Narrow a locator to the ordinal-th match. Applied AFTER counting: `count()`
 * on an already-narrowed locator always returns 1, which would make every
 * "does this locator still have my element?" check pass vacuously.
 */
function nth(loc, ordinal) {
  return ordinal === 0 ? loc : loc.nth(ordinal)
}

function fallbackLocators(page, el) {
  // Fallback chain in order: getByRole, getByLabel, getByPlaceholder, getByText,
  // getByTestId. Chain only makes sense when there is a name to match on.
  const chain = [refLocator(page, el)]
  if (el.name) {
    chain.push(page.getByLabel(el.name))
    chain.push(page.getByPlaceholder(el.name))
    chain.push(page.getByText(el.name, { exact: true }))
    chain.push(page.getByTestId(el.name))
  }
  return chain
}

export function createWebDriver({
  url,
  headless = true,
  device = null,
  selectorMode = 'css',
} = {}) {
  if (selectorMode !== 'css') {
    throw new NatlError(`unsupported selectorMode: ${selectorMode} (web driver supports css only)`)
  }

  const driver = {
    _url: url,
    _headless: headless,
    _device: device,
    _browser: null,
    _context: null,
    _page: null,
    _elements: null,

    async open() {
      if (this._page) return this // idempotent
      this._browser = await chromium.launch({ headless: this._headless })
      this._context = this._device
        ? await this._browser.newContext({ ...this._device })
        : await this._browser.newContext()
      this._page = await this._context.newPage()
      if (this._url) {
        await this._page.goto(this._url, { waitUntil: 'domcontentloaded' })
      }
      this._elements = null // force a fresh snapshot() before act()
      return this
    },

    async close() {
      // Idempotent and never re-throws (frozen contract 3).
      try {
        if (this._page) await this._page.close()
        if (this._context) await this._context.close()
        if (this._browser) await this._browser.close()
      } catch {
        // swallow: close() must never throw
      } finally {
        this._page = null
        this._context = null
        this._browser = null
        this._elements = null
      }
      return this
    },

    async snapshot() {
      const page = this._page
      const nodes = await page.ariaSnapshotJSON()
      const elements = flattenAria(nodes).map((el, i) => ({ ...el, ref: String(i) }))
      this._elements = elements
      return {
        elements,
        text: ariaText(nodes),
        fingerprint: makeFingerprint(elements, this._page ? this._page.url() : ''),
      }
    },

    /**
     * Execute one action.
     *
     * Targets the element by `ref` (a recorded/planned snapshot position) or,
     * for deterministic test steps, directly by `sel` (a CSS selector). The
     * selector form is exact and skips the ref/fingerprint machinery entirely.
     */
    async act(actionObj) {
      const { action, ref, value, sel } = actionObj
      if (!this._page) throw new NatlError('driver not opened: call open() first')

      if (sel !== undefined) return actOnSelector(this._page, action, sel, value)

      if (!this._elements || this._elements.length === 0) {
        await this.snapshot()
      }
      const el = this._elements.find((e) => e.ref === String(ref))
      if (!el) throw new NatlError(`ref ${ref} not in last snapshot`)
      const ordinal = ordinalInGroup(this._elements, el)

      switch (action) {
        case 'click':
          await clickViaChain(this._page, el, ordinal)
          return
        case 'fill':
          await nth(refLocator(this._page, el), ordinal).fill(value)
          return
        case 'clear': {
          const loc = nth(refLocator(this._page, el), ordinal)
          if (typeof loc.clear === 'function') await loc.clear()
          else await loc.fill('')
          return
        }
        case 'press':
          await nth(refLocator(this._page, el), ordinal).press(value)
          return
        case 'scroll':
          // page.evaluate on the element to scroll
          await this._page.evaluate((dir) => {
            const amount = dir === 'top'
              ? -document.documentElement.scrollHeight
              : dir === 'bottom'
                ? document.documentElement.scrollHeight
                : dir === 'up'
                  ? -400
                  : 400
            window.scrollBy(0, amount)
          }, value)
          return
        case 'wait':
          await nth(refLocator(this._page, el), ordinal).waitFor({ state: 'attached' })
          return
        default:
          throw new NatlError(`unknown action: ${action}`)
      }
    },

    async goto(url) {
      if (!this._page) throw new NatlError('driver not opened: call open() first')
      await this._page.goto(url, { waitUntil: 'domcontentloaded' })
      this._elements = null // invalidate cached snapshot
    },

    async url() {
      return this._page ? this._page.url() : null
    },

    async find(selector) {
      const loc = this._page.locator(selector)
      const n = await loc.count()
      const text = n > 0 ? await loc.first().innerText() : ''
      return { text, count: n }
    },
  }

  return driver
}

async function clickViaChain(page, el, ordinal = 0) {
  // Try the fallbacks in order. The first locator holding this element's
  // ordinal wins; if no locator has that many matches, throw rather than click
  // a different element.
  const chain = fallbackLocators(page, el)
  let anyMatch = false
  let maxSeen = 0
  for (const loc of chain) {
    let n = 0
    try {
      n = await loc.count()
    } catch {
      continue
    }
    if (n > 0) anyMatch = true
    if (n > maxSeen) maxSeen = n
    if (n > ordinal) {
      await nth(loc, ordinal).click()
      return
    }
  }
  if (!anyMatch) {
    throw new NatlError(`no element found matching role=${el.role} name=${el.name}`)
  }
  throw new NatlError(
    `element ${ordinal + 1} of only ${maxSeen} matching role=${el.role} name=${el.name} — page changed since the snapshot`,
  )
}

/**
 * Deterministic selector-based action: exact CSS match, no ref resolution.
 * Throws NatlError if the selector matches 0 elements (the deterministic step
 * contract: a missing element is a test failure, not a silent skip).
 */
async function actOnSelector(page, action, sel, value) {
  const loc = page.locator(sel)
  const n = await loc.count()
  if (n === 0) throw new NatlError(`selector matched 0 elements: ${sel}`)
  switch (action) {
    case 'click':
      await loc.first().click()
      return
    case 'fill':
      await loc.first().fill(value)
      return
    case 'clear':
      if (typeof loc.first().clear === 'function') await loc.first().clear()
      else await loc.first().fill('')
      return
    case 'press':
      await loc.first().press(value)
      return
    case 'scroll':
      await loc.first().scrollIntoViewIfNeeded()
      return
    case 'wait':
      await loc.first().waitFor({ state: 'attached' })
      return
    default:
      throw new NatlError(`unknown action: ${action}`)
  }
}

export default createWebDriver
