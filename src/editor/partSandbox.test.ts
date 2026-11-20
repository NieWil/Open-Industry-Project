import { describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../core/geometry/geometryEval'
import { partSandboxActive } from '../core/parts/partSandbox'
import { instantiatePartScript, resolvePartParams } from '../core/parts/partScript'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledPartById } from './parts/bundledExamples'

// The part sandbox (docs/part-sandbox.md): this project runs locked down (core/lockdown.testSetup.ts), as the page and
// the sim worker do, so every script below compiles inside an SES Compartment through the one seam all hosts use.
//
// The probes spell banned names the way an attacker would (`globalThis`, `Math['ran' + 'dom']`): the lexical
// determinism scan (core/determinism.ts) catches the plain spelling before anything compiles, and what is under test
// here is what holds once that scan has been walked around.

/** the escape the room-code gate's tests use (editor/roomCodeTrust.test.ts): host globalThis via a constructor */
const ESCAPE = "(() => {}).constructor('return this')().__oipSandboxPwned = true\ndefinePart({ step() {} })\n"
const pwned = (): boolean => (globalThis as { __oipSandboxPwned?: boolean }).__oipSandboxPwned === true

/** compile `body` as a part's top level and return what its `report` field says (or the compile error) */
function probe(expr: string): unknown {
  const { def, error } = instantiatePartScript(`definePart({ report: (() => { try { return ${expr} } catch (e) { return 'throws' } })() })`)
  return def ? (def as unknown as { report: unknown }).report : `error: ${error}`
}

describe('part code runs sandboxed once the realm is locked down', () => {
  it('the sandbox is on in this project', () => {
    expect(partSandboxActive()).toBe(true)
  })

  it('the escape that works without the sandbox does not escape', () => {
    const { error } = instantiatePartScript(ESCAPE)
    expect(error).not.toBe('')
    expect(pwned()).toBe(false)
  })

  it("sees none of the host's globals", () => {
    for (const name of ['process', 'require', 'window', 'document', 'self', 'localStorage', 'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket', 'postMessage', 'importScripts']) {
      expect(probe(`typeof globalTh\\u0069s.${name}`), name).toBe('undefined')
    }
  })

  it('cannot reach the host through any function it is handed or can make', () => {
    expect(probe("(function () {}).constructor('return 1')()")).toBe('throws')
    expect(probe("definePart.constructor('return 1')()")).toBe('throws')
    expect(probe("Math.sin.constructor('return 1')()")).toBe('throws')
    expect(probe("(async () => {}).constructor('return 1')")).toBe('throws')
    expect(probe("(function* () {}).constructor('return 1')")).toBe('throws')
  })

  it('cannot change what the app or the next part relies on', () => {
    expect(probe('(Array.prototype.push = null, "assigned")')).toBe('throws')
    expect(probe('(Object.prototype.polluted = 1, "assigned")')).toBe('throws')
    expect(probe('(Math.sin = null, "assigned")')).toBe('throws')
    expect(probe('(JSON.parse = null, "assigned")')).toBe('throws')
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('keeps writes to its own globals to itself', () => {
    expect(instantiatePartScript('globalTh\\u0069s.__oipLeak = 1\ndefinePart({ step() {} })').error).toBe('')
    expect((globalThis as { __oipLeak?: unknown }).__oipLeak).toBeUndefined()
    expect(probe('typeof globalTh\\u0069s.__oipLeak')).toBe('undefined') // nor does the next script see it
  })

  it('keeps the determinism guards and the loop budget', () => {
    expect(probe("Math['ran' + 'dom']()")).toBe('throws')
    expect(probe("D\\u0061te['n' + 'ow']()")).toBe('throws')
    const { def } = instantiatePartScript('definePart({ step() { for (;;) {} } })')
    expect(() => def!.step!({} as never)).toThrow(/iterations in one call/)
  })

  it('still runs real parts: every built-in part with geometry() produces a mesh', () => {
    let withGeometry = 0
    for (const id of bundledBehaviors().keys()) {
      const data = bundledPartById(id)!
      const pkg = buildPackage(data.manifest, data.behavior)
      const def = instantiatePartScript(pkg.behavior)
      expect(def.error, pkg.id).toBe('')
      if (!def.def?.geometry) continue
      withGeometry++
      expect(evalPartGeometry(pkg.behavior, resolvePartParams(pkg.params, {})), pkg.id).not.toBeNull()
    }
    expect(withGeometry).toBeGreaterThan(10)
  })
})
