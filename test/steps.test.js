import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  step,
  goto,
  click,
  fill,
  expectText,
  expectCount,
  expectUrl,
  test as testBlock,
} from '../src/steps.js'
import { makeCacheKey, makeFingerprint } from '../src/fingerprint.js'

describe('step DSL (frozen contract 4)', () => {
  it("step('x') deep-equals {kind:'nl',text:'x'}", () => {
    assert.deepStrictEqual(step('x'), { kind: 'nl', text: 'x' })
  })

  it("goto('http://example.com') deep-equals the frozen shape", () => {
    assert.deepStrictEqual(goto('http://example.com'), {
      kind: 'act',
      fn: 'goto',
      url: 'http://example.com',
    })
  })

  it("click('#a') deep-equals the frozen shape", () => {
    assert.deepStrictEqual(click('#a'), { kind: 'act', fn: 'click', sel: '#a' })
  })

  it("fill('#a','v') deep-equals the frozen shape", () => {
    assert.deepStrictEqual(fill('#a', 'v'), {
      kind: 'act',
      fn: 'fill',
      sel: '#a',
      value: 'v',
    })
  })

  it("expectText('#a','x') deep-equals the frozen shape", () => {
    assert.deepStrictEqual(expectText('#a', 'x'), {
      kind: 'expect',
      fn: 'expectText',
      sel: '#a',
      value: 'x',
    })
  })

  it("expectCount('.i', 2) deep-equals the frozen shape", () => {
    assert.deepStrictEqual(expectCount('.i', 2), {
      kind: 'expect',
      fn: 'expectCount',
      sel: '.i',
      value: 2,
    })
  })

  it("expectUrl('/x') deep-equals the frozen shape", () => {
    assert.deepStrictEqual(expectUrl('/x'), { kind: 'expect', fn: 'expectUrl', value: '/x' })
  })

  it("test('name', [step('x')]) deep-equals the frozen shape", () => {
    const steps = [step('x')]
    assert.deepStrictEqual(testBlock('name', steps), {
      kind: 'test',
      name: 'name',
      steps,
    })
  })
})

describe('fingerprint helpers', () => {
  it('makeCacheKey is deterministic', () => {
    const a = makeCacheKey('step', 'fp')
    const b = makeCacheKey('step', 'fp')
    assert.equal(a, b)
    assert.match(a, /^[0-9a-f]{64}$/)
  })

  it('makeCacheKey hashes exactly stepText + newline + fingerprint', () => {
    const expected = createHash('sha256').update('a\nb', 'utf8').digest('hex')
    assert.equal(makeCacheKey('a', 'b'), expected)
    // the newline delimiter must be part of the digest input
    assert.notEqual(makeCacheKey('a', 'b'), makeCacheKey('ab', ''))
    assert.match(makeCacheKey('x', 'fp'), /^[0-9a-f]{64}$/)
  })

  it('makeCacheKey yields different keys for different step text or fingerprint', () => {
    assert.notEqual(makeCacheKey('x', 'fp'), makeCacheKey('y', 'fp'))
    assert.notEqual(makeCacheKey('x', 'fp-a'), makeCacheKey('x', 'fp-b'))
  })

  it('makeFingerprint is deterministic', () => {
    const elems = [{ role: 'button', name: 'Go' }]
    assert.equal(makeFingerprint(elems), makeFingerprint(elems))
    assert.match(makeFingerprint(elems), /^[0-9a-f]{64}$/)
  })

  it('makeFingerprint detects added or renamed element', () => {
    const base = [{ role: 'button', name: 'Go' }]
    assert.notEqual(makeFingerprint(base), makeFingerprint([...base, { role: 'link', name: 'Skip' }]))
    assert.notEqual(makeFingerprint(base), makeFingerprint([{ role: 'button', name: 'Gone' }]))
  })
})
