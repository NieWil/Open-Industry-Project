// The local lint rule eslint-rules/no-unhandled-then.js: a discarded .then / .finally chain needs a rejection handler.
import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

// @ts-expect-error - a plain .js lint rule, untyped
const rule = ((await import('../../eslint-rules/no-unhandled-then.js')) as { default: unknown }).default

const linter = new Linter({ configType: 'flat' })
const lint = (code: string): number =>
  linter.verify(code, {
    plugins: { oip: { rules: { 'no-unhandled-then': rule } } } as never,
    rules: { 'oip/no-unhandled-then': 'error' },
  }).filter((m) => m.ruleId === 'oip/no-unhandled-then').length

describe('no-unhandled-then', () => {
  it('reports a discarded chain that ends in a one-argument then or a finally', () => {
    for (const code of [
      'p.then(f)',
      'void p.then(f)',
      'void p.then()',
      'p?.then(f)',
      'p.finally(f)',
      'void load().then(f).finally(g)',
      'p.catch(e).then(f)',
      'void p.then(f, g).then(h)',
      'p.catch(e).then(f).finally(g)',
      'const run = () => void p.then(f)',
      'function a() { return void p.then(f) }',
    ]) expect(lint(code), code).toBe(1)
  })

  it('accepts a handled, awaited, returned, assigned or passed-on chain', () => {
    for (const code of [
      'p.then(f).catch(e)',
      'void p.then(f).catch(e)',
      'void p.then(f, e)',
      'p.then(f).catch(e).finally(g)',
      'p.then(f).finally(g).catch(e)',
      'async function a() { await p.then(f) }',
      'function a() { return p.then(f) }',
      'const q = p.then(f)',
      'use(p.then(f))',
      'void p',
      'void doThing()',
      'p.catch(e)',
      'thing.then',
    ]) expect(lint(code), code).toBe(0)
  })
})
