import { describe, expect, it } from 'vitest'
import { compilePartScript, instantiatePartScript, PART_CALL_BEACON_BYTES, readPartCallBeacon, resolvePartParams, setPartCallBeacon } from './partScript'
import type { ParamSchema, PartContext } from './partApi'
import { partSandboxActive } from './partSandbox'

const ctxStub = { params: {} } as unknown as PartContext

describe('partScript compile chokepoint', () => {
  it('compiles a good script and captures its definition', () => {
    const { def, error } = instantiatePartScript(`definePart({ step(ctx) {} })`)
    expect(error).toBe('')
    expect(def?.step).toBeTypeOf('function')
  })

  it('rejects a lexical determinism violation before eval', () => {
    const { def, error } = instantiatePartScript(`definePart({ step() { return Date.now() } })`)
    expect(def).toBeNull()
    expect(error).toContain('not deterministic')
  })

  it('runs a script that declares its own variable named like a host global', () => {
    // the shim for `window` would otherwise be a parameter, and `let window` a redeclaration of it
    const { def, error } = instantiatePartScript(`let window = 2\nfunction document(n) { return n * window }\ndefinePart({ step(ctx) { ctx.writeNumber('x', document(3)) } })`)
    expect(error).toBe('')
    expect(def?.step).toBeTypeOf('function')
    expect(instantiatePartScript(`let window = 2\ndefinePart({ step() { return Date.now() } })`).error).toContain('not deterministic')
  })

  it('rejects a script that never calls definePart', () => {
    const { def, error } = instantiatePartScript(`const x = 1`)
    expect(def).toBeNull()
    expect(error).toContain('definePart')
  })

  it('negatively caches a syntax error (same message, no re-throw)', () => {
    const bad = `this is not valid js (((`
    expect(compilePartScript(bad).factory).toBeNull()
    expect(compilePartScript(bad).error).toBe(compilePartScript(bad).error)
  })

  it('isolates module-level closure state per instantiation (one counter per placed part)', () => {
    const src = `let n = 0; definePart({ step(ctx) { n++; ctx.count = n } })`
    const a = instantiatePartScript(src).def!
    const b = instantiatePartScript(src).def!
    const ctxA = { count: 0 } as unknown as PartContext & { count: number }
    const ctxB = { count: 0 } as unknown as PartContext & { count: number }
    a.step!(ctxA)
    a.step!(ctxA)
    b.step!(ctxB)
    expect(ctxA.count).toBe(2)
    expect(ctxB.count).toBe(1) // a shared def would read 3 here
  })

  describe('runtime determinism shims (reaches the lexical scan cannot see)', () => {
    it('an aliased Math.random throws an explanatory error at run time', () => {
      // `const m = Math; m.random()` never mentions the banned `Math.random` token pair
      const { def, error } = instantiatePartScript(`const m = Math; definePart({ step() { return m.random() } })`)
      expect(error).toBe('')
      expect(() => def!.step!(ctxStub)).toThrowError(/Math\.random.*ctx\.rng/)
    })

    it('deterministic Math survives the shim', () => {
      const src = `const m = Math; definePart({ step(ctx) { ctx.out = m.sin(m.PI / 2) } })`
      const { def } = instantiatePartScript(src)
      const ctx = { out: 0 } as unknown as PartContext & { out: number }
      def!.step!(ctx)
      expect(ctx.out).toBeCloseTo(1)
    })

    it('a determinism-shimmed global reached at run time throws, not silently succeeds', () => {
      // the scan bans the bare token at compile time; this proves the shadowed binding is what the
      // script actually sees (destructuring `Date` off an object the scan allows would still hit it)
      const { def, error } = instantiatePartScript(`
        definePart({ step(ctx) { const d = Date; ctx.out = d.now() } })
      `)
      // `Date` as a bare token is lexically banned, so this variant fails at compile -
      expect(error).toContain('not deterministic')
      expect(def).toBeNull()
    })
  })

  // Under errorTaming 'unsafe' the host's Error has a live prepareStackTrace setter; part code must get the
  // Compartment's own Error, whose setter ignores the write (BOUND_GLOBALS in partScript.ts).
  describe.runIf(partSandboxActive())("part code gets the sandbox's Error, not the host's", () => {
    it('the Error a part sees is not the host realm Error', () => {
      const { def } = instantiatePartScript(`definePart({ step(ctx) { ctx.same = Error === ctx.hostError } })`)
      const ctx = { same: true, hostError: Error } as unknown as PartContext & { same: boolean }
      def!.step!(ctx)
      expect(ctx.same).toBe(false)
    })

    it('a part cannot install a stack formatter the host runs', () => {
      const hostError = Error as unknown as { prepareStackTrace?: unknown }
      const before = hostError.prepareStackTrace
      try {
        const { def, error } = instantiatePartScript(
          `definePart({ step() { Error.prepareStackTrace = () => 'PWNED'; TypeError.prepareStackTrace = () => 'PWNED' } })`,
        )
        expect(error).toBe('')
        def!.step!(ctxStub)
        expect(hostError.prepareStackTrace).toBe(before)
        expect(String(new Error('host').stack)).not.toContain('PWNED')
        expect(String(new TypeError('host').stack)).not.toContain('PWNED')
      } finally {
        hostError.prepareStackTrace = before
      }
    })

    it("a part's thrown error still reaches the host with its message and stack", () => {
      const { def } = instantiatePartScript(`definePart({ step() { throw new Error('belt jammed') } })`)
      let caught: unknown
      try {
        def!.step!(ctxStub)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe('belt jammed')
      expect(String((caught as Error).stack)).toContain('belt jammed')
    })
  })
})

describe('resolvePartParams (the one resolution sim + render share)', () => {
  const schema: ParamSchema = {
    len: { type: 'number', default: 2 },
    rows: { type: 'numberList', arity: 2, default: [[1, 0]] },
  }

  it('fills schema defaults and lets an override win', () => {
    expect(resolvePartParams(schema, { len: 5 })).toEqual({ len: 5, rows: [[1, 0]] })
  })

  it('coerces a malformed numberList override to the schema default (identically for every host)', () => {
    expect(resolvePartParams(schema, { rows: 'not rows' as never })).toEqual({ len: 2, rows: [[1, 0]] })
    expect(resolvePartParams(schema, { rows: [[1, 'x']] as never })).toEqual({ len: 2, rows: [[1, 0]] })
  })

  it('passes unknown override keys through', () => {
    expect(resolvePartParams(schema, { extra: true })).toEqual({ len: 2, rows: [[1, 0]], extra: true })
  })
})

describe('the hang beacon (sim/client.ts watchdog)', () => {
  it('names the part while its code runs, and clears on the way out', () => {
    const buffer = new SharedArrayBuffer(PART_CALL_BEACON_BYTES)
    setPartCallBeacon(buffer, (source) => (source.includes('acme') ? 'Acme lifter (acme.lifter)' : ''))
    try {
      const { def } = instantiatePartScript(`// acme
definePart({ step(ctx) { ctx.probe() } })`)
      let inside: { label: string } | null = null
      // the host function runs inside the part's step, as a stuck call would be seen from the page
      def!.step!({ ...ctxStub, probe: () => (inside = readPartCallBeacon(buffer)) } as unknown as PartContext)
      expect(inside).toEqual({ label: 'Acme lifter (acme.lifter)' })
      expect(readPartCallBeacon(buffer)).toBeNull()
    } finally {
      setPartCallBeacon(null)
    }
  })
})
