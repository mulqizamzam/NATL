/**
 * natl — provider table tests (Task 2)
 *
 * Each provider subtest stubs globalThis.fetch before the call, asserts
 * (a) the correct request URL, (b) the auth header, and (c) the parsed
 * response shape. For OpenAI / DeepSeek we also assert the nested
 * tools[0].function shape; for Anthropic, tools[0].input_schema; and
 * for Ollama that NO Authorization header is sent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callModel, NatlError } from '../src/llm.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lastFetchCalls() {
  return globalThis.__natlFetchCalls
}

async function stubFetch(handler) {
  globalThis.__natlFetchCalls = []
  globalThis.fetch = async (url, opts) => {
    globalThis.__natlFetchCalls.push({ url: String(url), opts })
    return handler
  }
}

function okResponse(payloadObj) {
  const body = JSON.stringify(payloadObj)
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function errorResponse(status, body = 'error') {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
}

// ---------------------------------------------------------------------------
// OPENAI
// ---------------------------------------------------------------------------

test('openai — auth header, request shape, parsed tool_call JSON', async () => {
  const plan = { actions: [{ action: 'click', ref: '0' }] }
  const resp = okResponse({
    choices: [{ message: { tool_calls: [{ function: { name: 'natl_plan', arguments: JSON.stringify(plan) } }] } }],
  })
  await stubFetch(resp)

  const { parsed, raw } = await callModel({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    system: 'sys',
    user: 'usr',
  })

  const call = lastFetchCalls()[0]

  // (a) URL
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions')

  // (b) Authorization header
  assert.equal(call.opts.headers['Authorization'], 'Bearer sk-test')

  // (c) parsed object
  assert.deepEqual(parsed, plan)
  assert.equal(typeof raw, 'string')

  // nested tools[0].function
  const body = JSON.parse(call.opts.body)
  assert.ok(Array.isArray(body.tools), 'body.tools should be an array')
  assert.equal(body.tools[0].function.name, 'natl_plan')
  assert.ok(body.tools[0].function.parameters, 'tools[0].function.parameters should exist')
  assert.equal(body.tools[0].function.parameters.type, 'object')
})

test('openai — throws NatlError with no API key', async () => {
  await stubFetch(okResponse({}))
  await assert.rejects(
    () => callModel({ provider: 'openai', model: 'gpt-4o', apiKey: '', system: 's', user: 'u' }),
    (e) => e instanceof NatlError && /missing API key/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
// DEEPSEEK
// ---------------------------------------------------------------------------

test('deepseek — auth header, request shape, parsed tool_call JSON', async () => {
  const plan = { actions: [{ action: 'fill', ref: '1', value: 'hello' }] }
  const resp = okResponse({
    choices: [{ message: { tool_calls: [{ function: { name: 'natl_plan', arguments: JSON.stringify(plan) } }] } }],
  })
  await stubFetch(resp)

  const { parsed } = await callModel({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: 'sk-deepseek-test',
    system: 'sys',
    user: 'usr',
  })

  const call = lastFetchCalls()[0]

  assert.equal(call.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(call.opts.headers['Authorization'], 'Bearer sk-deepseek-test')
  assert.deepEqual(parsed, plan)

  const body = JSON.parse(call.opts.body)
  assert.equal(body.tools[0].function.name, 'natl_plan')
})

test('deepseek — throws NatlError with no API key', async () => {
  await stubFetch(okResponse({}))
  await assert.rejects(
    () => callModel({ provider: 'deepseek', model: 'm', apiKey: '', system: 's', user: 'u' }),
    (e) => e instanceof NatlError && /missing API key/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
// ANTHROPIC
// ---------------------------------------------------------------------------

test('anthropic — x-api-key header, input_schema in tools, parsed tool_use input', async () => {
  const plan = { actions: [{ action: 'click', ref: '0' }] }
  const resp = okResponse({
    content: [{ type: 'text', text: '' }, { type: 'tool_use', id: 'tc_1', name: 'natl_plan', input: plan }],
  })
  await stubFetch(resp)

  const { parsed } = await callModel({
    provider: 'anthropic',
    model: 'claude-3-5-haiku',
    apiKey: 'sk-ant-test',
    system: 'sys',
    user: 'usr',
  })

  const call = lastFetchCalls()[0]

  // (a) URL
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages')

  // (b) x-api-key header
  assert.equal(call.opts.headers['x-api-key'], 'sk-ant-test')
  assert.equal(call.opts.headers['anthropic-version'], '2023-06-01')

  // (c) parsed object (already a JS object — no JSON.parse needed)
  assert.deepEqual(parsed, plan)

  // tools[0].input_schema (Anthropic uses input_schema, not function.parameters)
  const body = JSON.parse(call.opts.body)
  assert.ok(Array.isArray(body.tools), 'body.tools should be an array')
  assert.equal(body.tools[0].name, 'natl_plan')
  assert.ok(body.tools[0].input_schema, 'tools[0].input_schema should exist')
  assert.equal(body.tools[0].input_schema.type, 'object')
})

test('anthropic — throws NatlError with no API key', async () => {
  await stubFetch(okResponse({}))
  await assert.rejects(
    () => callModel({ provider: 'anthropic', model: 'm', apiKey: '', system: 's', user: 'u' }),
    (e) => e instanceof NatlError && /missing API key/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
// OLLAMA
// ---------------------------------------------------------------------------

test('ollama — no auth header required, parsed tool_call JSON', async () => {
  const plan = { actions: [{ action: 'scroll', ref: '0', value: 'down' }] }
  const resp = okResponse({
    choices: [{ message: { tool_calls: [{ function: { name: 'natl_plan', arguments: JSON.stringify(plan) } }] } }],
  })
  await stubFetch(resp)

  const { parsed } = await callModel({
    provider: 'ollama',
    model: 'llama3',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    system: 'sys',
    user: 'usr',
  })

  const call = lastFetchCalls()[0]

  // (a) URL
  assert.equal(call.url, 'http://127.0.0.1:11434/v1/chat/completions')

  // (b) NO Authorization header
  assert.equal(call.opts.headers['Authorization'], undefined)

  // (c) parsed object
  assert.deepEqual(parsed, plan)
})

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

test('callModel — HTTP error throws NatlError', async () => {
  await stubFetch(errorResponse(401))
  await assert.rejects(
    () => callModel({ provider: 'openai', model: 'm', apiKey: 'bad', system: 's', user: 'u' }),
    (e) => e instanceof NatlError && /HTTP 401 from openai/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
// Malformed JSON (no tool_calls)
// ---------------------------------------------------------------------------

test('callModel — malformed response (no tool_calls) throws NatlError', async () => {
  await stubFetch(okResponse({ choices: [{ message: { content: 'not a tool call' } }] }))
  await assert.rejects(
    () => callModel({ provider: 'openai', model: 'm', apiKey: 'k', system: 's', user: 'u' }),
    (e) => e instanceof NatlError && /malformed response/.test(e.message),
  )
})

test('callModel — malformed response (bad arguments JSON) throws NatlError', async () => {
  await stubFetch(
    okResponse({
      choices: [{ message: { tool_calls: [{ function: { name: 'natl_plan', arguments: 'not json' } }] } }],
    }),
  )
  await assert.rejects(
    () => callModel({ provider: 'openai', model: 'm', apiKey: 'k', system: 's', user: 'u' }),
    (e) => e instanceof NatlError && /malformed response/.test(e.message),
  )
})

// ---------------------------------------------------------------------------
// a stalled provider must not hang the CLI
// ---------------------------------------------------------------------------

test('a provider that never responds is a timeout error, not a hang', async () => {
  const prevTimeout = process.env.NATL_HTTP_TIMEOUT_MS
  const prevFetch = globalThis.fetch
  process.env.NATL_HTTP_TIMEOUT_MS = '80'
  try {
    // Respect the abort signal the way a real fetch does, and never resolve
    // otherwise: this is a provider that accepted the connection and stalled.
    globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
    })

    const started = Date.now()
    await assert.rejects(
      () => callModel({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
        system: 's',
        user: 'u',
      }),
      (err) => err.name === 'NatlError' && /timed out after 80ms/.test(err.message),
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `expected an ~80ms deadline, waited ${elapsed}ms`)
  } finally {
    if (prevTimeout === undefined) delete process.env.NATL_HTTP_TIMEOUT_MS
    else process.env.NATL_HTTP_TIMEOUT_MS = prevTimeout
    globalThis.fetch = prevFetch
  }
})
