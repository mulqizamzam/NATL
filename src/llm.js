/**
 * natl — LLM provider adapter
 *
 * Provider table (D5): four providers, each with its own request shape and
 * response path. OpenAI / DeepSeek / Ollama share the OpenAI-shaped code path.
 * Anthropic uses its own Messages API path.
 */

import { NatlError } from './errors.js'
import { fetchWithTimeout, llmTimeoutMs } from './http.js'

// Single source of truth for provider base URLs. Exported so init.js does not
// duplicate the table — a second copy would silently drift from this one.
export const PROVIDER_BASE_URLS = Object.freeze(
  Object.fromEntries(
    [
      ['openai', 'https://api.openai.com/v1'],
      ['anthropic', 'https://api.anthropic.com/v1'],
      ['deepseek', 'https://api.deepseek.com/v1'],
      ['ollama', 'http://127.0.0.1:11434/v1'],
    ],
  ),
)
// Re-export for callers that previously imported NatlError from here.
export { NatlError }

const PROVIDERS = Object.freeze({
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    endpoint: '/chat/completions',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    format: 'openai',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    endpoint: '/messages',
    authHeader: 'x-api-key',
    authScheme: null,
    format: 'anthropic',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    endpoint: '/chat/completions',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    format: 'openai',
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    endpoint: '/chat/completions',
    authHeader: null,
    authScheme: null,
    format: 'openai',
  },
})

/**
 * Validate that a string is a parsable URI with http: or https: protocol.
 * Does NOT enforce the absence of a path segment.
 */
function isValidUrlBase(str) {
  try {
    const u = new URL(str)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Build the tool-definition list shared across all providers.
 *
 * Note on `strict: true`: OpenAI applies it recursively across the entire
 * schema tree. Because frozen contract 1 makes `value` optional on action
 * objects, the nested items schema is not strict-compatible. Enabling
 * `strict: true` on the parameters would therefore trigger an HTTP 400
 * from the OpenAI API (or a rejection from DeepSeek/other compat providers)
 * regardless of whether the top-level object is fully required. We omit
 * `strict` and rely on `additionalProperties: false` + `required` to
 * enforce the shape, which is compatible with every provider in the table.
 */
function buildTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'natl_plan',
        description:
          'Plan the next actions to accomplish the user instruction on the given page.',
        parameters: {
          type: 'object',
          properties: {
            actions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['click', 'fill', 'clear', 'press', 'scroll', 'wait'],
                  },
                  ref: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['action', 'ref'],
                additionalProperties: false,
              },
              minItems: 1,
            },
          },
          required: ['actions'],
          additionalProperties: false,
        },
      },
    },
  ]
}

/**
 * Build an Anthropic-format request body.
 */
function buildAnthropicBody(system, userMessage, model) {
  return {
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: userMessage }],
    tools: buildTools().map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    })),
  }
}

/**
 * Build an OpenAI-shaped request body (openai / deepseek / ollama).
 */
function buildOpenAIBody(system, userMessage, model) {
  return {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ],
    tools: buildTools(),
    stream: false,
  }
}

/**
 * Parse an OpenAI-shaped response into { raw, parsed }.
 */
function parseOpenAIResponse(raw, provider) {
  let json
  try {
    json = JSON.parse(raw)
  } catch (e) {
    throw new NatlError(
      `malformed response from ${provider}: ${(raw ?? '').slice(0, 500)}`,
    )
  }

  const tc = json?.choices?.[0]?.message?.tool_calls?.[0]
  if (!tc || !tc.function) {
    throw new NatlError(
      `malformed response from ${provider}: ${raw.slice(0, 500)}`,
    )
  }

  let parsed
  try {
    parsed = JSON.parse(tc.function.arguments)
  } catch (e) {
    throw new NatlError(
      `malformed response from ${provider}: ${(tc.function.arguments ?? '').slice(0, 500)}`,
    )
  }

  return { raw, parsed }
}

/**
 * Parse an Anthropic-shaped response into { raw, parsed }.
 * Anthropic returns already-parsed JSON bodies, so no JSON.parse is needed.
 */
function parseAnthropicResponse(raw, provider) {
  let json
  try {
    json = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {
    throw new NatlError(
      `malformed response from ${provider}: ${raw.slice(0, 500)}`,
    )
  }

  const tu = json?.content?.find((c) => c.type === 'tool_use')
  if (!tu || !tu.input) {
    throw new NatlError(
      `malformed response from ${provider}: ${raw.slice(0, 500)}`,
    )
  }

  return { raw, parsed: tu.input }
}

/**
 * Call an LLM provider and return the raw and parsed JSON response.
 *
 * @param {Object} options
 * @param {string} options.provider - one of 'openai'|'anthropic'|'deepseek'|'ollama'
 * @param {string} options.model - model identifier (e.g. 'gpt-4o', 'claude-3-5-haiku')
 * @param {string} options.apiKey - provider API key (not required for 'ollama')
 * @param {string} [options.baseUrl] - override the default base URL for the provider
 * @param {string} options.system - system prompt string
 * @param {string} options.user - user message string
 * @returns {Promise<{raw: string, parsed: object}>}
 */
export async function callModel({
  provider,
  model,
  apiKey,
  baseUrl,
  system,
  user,
}) {
  const def = PROVIDERS[provider]
  if (!def) throw new NatlError(`unknown provider: ${provider}`)

  const resolvedBaseUrl = (baseUrl ?? def.baseUrl).replace(/\/+$/, '')
  if (!isValidUrlBase(resolvedBaseUrl))
    throw new NatlError(`invalid baseUrl for ${provider}: ${resolvedBaseUrl}`)

  if (provider !== 'ollama' && (!apiKey || apiKey.trim() === '')) {
    throw new NatlError(`missing API key for ${provider}`)
  }

  const url = resolvedBaseUrl + def.endpoint

  if (def.format === 'anthropic') {
    const body = buildAnthropicBody(system, user, model)
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      [def.authHeader]: apiKey,
    }
    const resp = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      { timeoutMs: llmTimeoutMs(), label: `request to ${provider}` },
    )
    if (resp.status >= 400) {
      throw new NatlError(`HTTP ${resp.status} from ${provider} (${resolvedBaseUrl})`)
    }
    const raw = await resp.text()
    return parseAnthropicResponse(raw, provider)
  }

  // OpenAI-shaped path: openai / deepseek / ollama
  const body = buildOpenAIBody(system, user, model)
  const headers = {
    'Content-Type': 'application/json',
  }
  if (def.authHeader) {
    headers[def.authHeader] = def.authScheme
      ? `${def.authScheme} ${apiKey}`
      : apiKey
  }
  const resp = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
    { timeoutMs: llmTimeoutMs(), label: `request to ${provider}` },
  )
  if (resp.status >= 400) {
    throw new NatlError(`HTTP ${resp.status} from ${provider} (${resolvedBaseUrl})`)
  }
  const raw = await resp.text()
  return parseOpenAIResponse(raw, provider)
}

export default callModel
