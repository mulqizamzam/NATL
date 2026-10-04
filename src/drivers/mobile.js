import { NatlError } from '../errors.js'
import { makeFingerprint } from '../fingerprint.js'

// Appium 3 W3C WebDriver over global fetch. No client library: the endpoint set
// the driver needs is small and stable, and this repo pins no runtime deps.

const DEFAULT_SERVER = 'http://127.0.0.1:4723'
const TEXT_CAP = 4000
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
const WAIT_TIMEOUT_MS = 3000
const WAIT_INTERVAL_MS = 200

async function request(method, url, body) {
  const init = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const resp = await fetch(url, init)
  if (!resp.ok) {
    throw new NatlError(`HTTP ${resp.status} from ${method} ${url}`, {
      status: resp.status,
      method,
      url,
    })
  }
  return resp.json()
}

const statusOf = (err) => (err && err.details ? err.details.status : undefined)

/** Attribute scan for one opening tag. No XML library (plan Task 4). */
function readAttributes(source) {
  const attrs = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(source)) !== null) attrs[m[1]] = m[2] ?? m[3] ?? ''
  return attrs
}

/** `android.widget.Button` -> `Button`; XCUIElementTypeButton -> XCUIElementTypeButton. */
const basename = (tag) => tag.slice(tag.lastIndexOf('.') + 1)

/**
 * Map one parsed node to {role, name, selector} or null to skip it.
 * `selector` is how act() re-finds the node: resource-id/name on Android,
 * the iOS name/label attribute on iOS.
 */
function mapNode(tag, attrs) {
  const name = attrs['name'] ?? ''
  const label = attrs.label ?? ''
  const desc = attrs['content-desc'] ?? ''
  const text = attrs.text ?? ''
  const resourceId = attrs['resource-id'] ?? ''
  const editable = attrs.contenteditable ?? ''
  const className = basename(attrs.class ?? '')

  const isIOS = tag.startsWith('XCUIElementType')
  const androidClass = isIOS ? '' : basename(tag)
  const kind = androidClass || className

  let role = null
  let accessibleName = ''
  let selector = null

  if (!isIOS) {
    // Android: class attribute wins, else the element tag itself.
    if (kind === 'Button') {
      role = 'button'
      accessibleName = desc || text
      selector = resourceId || desc || text
    } else if (kind === 'EditText') {
      role = 'textbox'
      accessibleName = resourceId || desc || text
      selector = resourceId || desc
    } else if (kind === 'CheckBox') {
      role = 'checkbox'
      accessibleName = desc || resourceId
      selector = resourceId || desc
    } else if (kind === 'ImageView' || kind === 'ImageButton') {
      role = 'img'
      accessibleName = desc || resourceId
      selector = resourceId || desc
    } else if (kind === 'TextView' && text) {
      role = 'text'
      accessibleName = text
      selector = resourceId || text
    } else if (kind === 'ViewGroup' || kind === 'FrameLayout' || kind === 'LinearLayout') {
      role = 'group'
      accessibleName = desc || resourceId
      selector = resourceId || desc
    } else if (editable === 'true') {
      // contenteditable is the browser-style fallback for unknown classes.
      role = 'textbox'
      accessibleName = desc || resourceId
      selector = resourceId || desc
    } else if (text || desc || resourceId) {
      role = 'text'
      accessibleName = text || desc || resourceId
      selector = resourceId || desc || text
    }
  } else if (tag === 'XCUIElementTypeButton') {
    role = 'button'
    accessibleName = name || label
    selector = name || label
  } else if (tag === 'XCUIElementTypeTextField' || tag === 'XCUIElementTypeSecureTextField') {
    role = 'textbox'
    accessibleName = name || label || text
    selector = name || label
  } else if (tag === 'XCUIElementTypeStaticText' || tag === 'XCUIElementTypeOther') {
    if (text || name || label) {
      role = 'text'
      accessibleName = text || name || label
      selector = name || label
    }
  }

  if (!role) return null
  // No name and no text: keep only roles whose class alone identifies them.
  if (!accessibleName && role !== 'group') return null
  return { role, name: accessibleName, selector }
}

/** Regex tag scan over the page-source XML, in document order. */
function parseSource(xml) {
  const out = []
  const tagRe = /<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  let m
  while ((m = tagRe.exec(xml)) !== null) {
    const mapped = mapNode(m[1], readAttributes(m[2] ?? ''))
    if (mapped) out.push(mapped)
  }
  return out
}

/** Resolve a locator strategy. Raw selectors may carry an explicit prefix. */
function resolveStrategy(selector) {
  const s = String(selector)
  if (s.startsWith('//')) return { strategy: 'xpath', value: s }
  if (s.startsWith('xpath=')) return { strategy: 'xpath', value: s.slice('xpath='.length) }
  if (s.startsWith('id=')) return { strategy: 'id', value: s.slice('id='.length) }
  if (s.startsWith('accessibility id=')) {
    return { strategy: 'accessibility id', value: s.slice('accessibility id='.length) }
  }
  if (s.startsWith('~')) return { strategy: 'accessibility id', value: s.slice(1) }
  return { strategy: 'accessibility id', value: s }
}

export function createMobileDriver({ server = DEFAULT_SERVER, capabilities = {}, selectors = { mode: 'auto' } } = {}) {
  const driver = {
    _sid: null,
    _elements: null,

    async open() {
      if (this._sid) return this
      const body = { capabilities: { alwaysMatch: { ...capabilities } } }
      const resp = await request('POST', `${server}/session`, body)
      // W3C returns sessionId at the top level; the value-wrapped form appears
      // on older Appium/JSONWP builds, so accept both.
      const sid = resp.sessionId ?? (resp.value && resp.value.sessionId)
      if (!sid) throw new NatlError('no sessionId in /session response')
      this._sid = sid
      this._elements = null
      return this
    },

    async close() {
      // Idempotent and never throws (frozen contract 3).
      const sid = this._sid
      this._sid = null
      this._elements = null
      if (!sid) return this
      try {
        await request('DELETE', `${server}/session/${sid}`, undefined)
      } catch {
        // swallow: teardown failures must not mask the real test result
      }
      return this
    },

    async snapshot() {
      if (!this._sid) throw new NatlError('driver not opened: call open() first')
      const resp = await request('GET', `${server}/session/${this._sid}/source`, undefined)
      const nodes = parseSource(typeof resp.value === 'string' ? resp.value : '')
      const internal = nodes.map((n, i) => ({ ...n, ref: String(i) }))
      this._elements = internal
      const elements = internal.map(({ ref, role, name }) => ({ ref, role, name }))
      const text = internal
        .map((e) => [e.role, e.name].filter(Boolean).join(' '))
        .join('\n')
        .slice(0, TEXT_CAP)
      return { elements, text, fingerprint: makeFingerprint(elements) }
    },

    async act(actionObj) {
      if (!this._sid) throw new NatlError('driver not opened: call open() first')
      const { action, ref, value } = actionObj

      // Re-resolve against the live page: refs are positions, and the page may
      // have moved since the planner read them.
      const snap = await this.snapshot()
      const el = snap.elements.find((e) => e.ref === String(ref))
      if (!el) throw new NatlError(`ref ${ref} not in current snapshot`)
      const node = this._elements.find((e) => e.ref === String(ref))
      const { strategy, value: selValue } = resolveStrategy(node.selector || el.name)

      if (action === 'scroll') {
        await request('POST', `${server}/session/${this._sid}/execute/sync`, {
          script: 'mobile: scroll',
          args: [{ direction: value }],
        })
        return
      }

      const handle = await this._waitForElement(strategy, selValue)
      // The handle is a server-supplied opaque string; percent-encode it so a
      // handle containing '/' or ':' cannot corrupt the request path.
      const base = `${server}/session/${this._sid}/element/${encodeURIComponent(handle)}`
      switch (action) {
        case 'click':
          await request('POST', `${base}/click`, {})
          return
        case 'fill':
          await request('POST', `${base}/value`, { text: value, clear: true })
          return
        case 'clear':
          await request('POST', `${base}/clear`, {})
          return
        case 'press':
          await request('POST', `${base}/press`, { value })
          return
        case 'wait':
          return
        default:
          throw new NatlError(`unknown action: ${action}`)
      }
    },

    async goto() {
      throw new NatlError('goto is not supported for the mobile driver')
    },

    async find(selector) {
      if (!this._sid) throw new NatlError('driver not opened: call open() first')
      const { strategy, value } = resolveStrategy(selector)
      let handle
      try {
        handle = await this._findElement(strategy, value)
      } catch (err) {
        // "not found" is an expected outcome for an expectCount(sel, 0) step.
        if (statusOf(err) === 404) return { text: '', count: 0 }
        throw err
      }
      const resp = await request(
        'GET',
        `${server}/session/${this._sid}/element/${encodeURIComponent(handle)}/text`,
        undefined,
      )
      return { text: typeof resp.value === 'string' ? resp.value : '', count: 1 }
    },

    async _findElement(strategy, value) {
      const resp = await request('POST', `${server}/session/${this._sid}/element`, { using: strategy, value })
      const handle = resp.value && resp.value[ELEMENT_KEY]
      if (!handle) throw new NatlError(`no element handle for ${strategy}=${value}`, { strategy, value })
      return handle
    },

    /** Poll /element until it resolves or the timeout elapses (action: 'wait'). */
    async _waitForElement(strategy, value, timeoutMs = WAIT_TIMEOUT_MS, intervalMs = WAIT_INTERVAL_MS) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        try {
          return await this._findElement(strategy, value)
        } catch (err) {
          const notFound = statusOf(err) === 404 || statusOf(err) === 400
          if (!notFound) throw err
          if (Date.now() >= deadline) {
            throw new NatlError(`wait timed out after ${timeoutMs}ms for ${strategy}=${value}`, { strategy, value })
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs))
        }
      }
    },
  }

  // selectors.mode is accepted for contract parity; 'auto' is the only mode
  // because resolution differs per element, not per run.
  if (selectors && selectors.mode && selectors.mode !== 'auto') {
    throw new NatlError(`unsupported selectors.mode: ${selectors.mode} (mobile driver supports auto only)`)
  }

  return driver
}

export default createMobileDriver