// A differential fuzzer for the two scan engines: random, well-typed ST programs (stFuzzGen.ts) run on the walker and
// the typed engine through the oracle (scanEngineOracle.ts), every variable compared after every scan, a fault held to
// the same fault. The corpus and the targeted cases in scanEngines.test.ts test what someone thought of; this tests
// the combinations nobody wrote down, such as a subscript holding a call that generated code evaluated three times.
//
// CI runs a fixed set of seeds. Locally:
//   PLC_FUZZ_SEEDS=5000 npx vitest run src/plc/fuzz       more seeds (PLC_FUZZ_START=n moves the first one)
//   PLC_FUZZ_SEED=1234 npx vitest run src/plc/fuzz        replay one seed, printing its program
//   PLC_FUZZ_MINIMIZE=1                                    shrink each failing program before reporting it
//   PLC_FUZZ_VERBOSE=1                                     print counts: compiled, faulted and why, values compared
//                                                          (vitest hides a passing test's output: add --silent=false)
//
// The second block holds both engines to values worked out independently (stExprRef.ts), which catches a rule the
// two engines share and both get wrong, which the differential block cannot see: a UDINT product losing its low bits,
// MUL() and `*` disagreeing, MUX with a negative selector.

import { describe, expect, it } from 'vitest'
import { compile, setScanEngine, typedRefusals } from '../interpreter'
import { codegenFallbacks } from '../scanCodegen'
import { compareEngines, randomWrites, seeded, type OracleStep } from '../scanEngineOracle'
import { generateRefProgram } from './stExprRef'
import { generateProgram } from './stFuzzGen'
import { minimizeLines } from './stFuzzMin'

const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env[k] : undefined)
const one = env('PLC_FUZZ_SEED')
const count = Number(env('PLC_FUZZ_SEEDS') ?? 250)
const start = Number(env('PLC_FUZZ_START') ?? 1)
const seeds = one !== undefined ? [Number(one)] : Array.from({ length: count }, (_, i) => start + i)
const minimize = env('PLC_FUZZ_MINIMIZE') === '1'

const SCANS = 8
const steps: OracleStep[] = Array.from({ length: SCANS }, () => ({ dt: 0.05 }))

/** Run one seed's program. Odd seeds also take random writes between scans, through the tag surface, to anything but
 *  the index places (stFuzzGen.ts `ixPlace`), which a write past 0..1 would turn into a subscript fault. */
function run(seed: number, src: string) {
  if (seed % 2 === 0) return compareEngines(src, steps)
  const writes = randomWrites(seeded(seed), 3)
  const between: typeof writes = (i, keys, memory) => writes(i, keys.filter((k) => !k.startsWith('gix')), memory)
  return compareEngines(src, steps, { between })
}

describe('differential fuzzing: random ST programs scan alike on the walker and the typed engine', () => {
  it(`${seeds.length} seeded programs from seed ${seeds[0]}`, () => {
    const failures: string[] = []
    const refused: string[] = []
    const compileErrors = new Map<string, number>()
    const faults = new Map<string, number[]>()
    let compared = 0
    let faulted = 0
    let ran = 0
    for (const seed of seeds) {
      const { src } = generateProgram(seed)
      if (one !== undefined) console.log(src)
      const r = run(seed, src)
      if (r.refused) {
        refused.push(`seed ${seed}: ${r.refused}`)
        continue
      }
      if (r.scans === 0 && r.diffs.length === 0) {
        // the program compiled on neither engine, with the same message: a generator gap, counted below
        const msg = (r.fault ?? '?').replace(/\d+/g, 'n')
        compileErrors.set(msg, (compileErrors.get(msg) ?? 0) + 1)
        continue
      }
      ran++
      compared += r.compared
      if (r.fault) {
        faulted++
        const m = r.fault.replace(/-?\d+/g, 'n')
        faults.set(m, [...(faults.get(m) ?? []), seed])
      }
      if (r.diffs.length) {
        const shown = minimize ? minimizeLines(src, (s) => run(seed, s).diffs.length > 0) : src
        const again = minimize ? run(seed, shown).diffs : r.diffs
        failures.push(`seed ${seed} (replay: PLC_FUZZ_SEED=${seed}):\n${again.join('\n')}\n--- program${minimize ? ' (minimised)' : ''} ---\n${shown}\n`)
      }
    }
    const errors = [...compileErrors].sort((a, b) => b[1] - a[1])
    const errorCount = errors.reduce((n, [, k]) => n + k, 0)
    if (env('PLC_FUZZ_VERBOSE') || failures.length) {
      console.log(`seeds ${seeds.length}, ran ${ran}, faulted ${faulted}, compile errors ${errorCount}, refused ${refused.length}, values compared ${compared}`)
      for (const [m, k] of errors.slice(0, 15)) console.log(`  ${k} x ${m}`)
      for (const x of refused.slice(0, 10)) console.log(`  refused: ${x}`)
      for (const [m, s] of [...faults].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) console.log(`  fault ${s.length} x ${m} (seeds ${s.slice(0, 5).join(', ')})`)
    }
    expect(failures.join('\n')).toBe('')
    // compile() builds a program the typed engine refuses on the walker instead, which would compare the walker with
    // itself: none may be refused
    expect(typedRefusals).toEqual([])
    expect(codegenFallbacks).toEqual([])
    if (one === undefined) {
      // not vacuous: nearly every program compiles, runs on the typed engine and is compared
      expect(errorCount).toBeLessThan(seeds.length * 0.05)
      expect(refused.length).toBeLessThan(seeds.length * 0.02 + 1)
      expect(ran).toBeGreaterThan(seeds.length * 0.9)
      expect(compared).toBeGreaterThan(ran * 100)
    }
  }, 600_000)
})

describe('reference fuzzing: random expressions hold the values IEC arithmetic gives them, on both engines', () => {
  it(`${seeds.length} seeded programs from seed ${seeds[0]}`, () => {
    const failures: string[] = []
    let checked = 0
    for (const seed of seeds) {
      const { src, expect: want } = generateRefProgram(seed)
      if (one !== undefined) console.log(src)
      const got: Record<string, Record<string, unknown>> = {}
      for (const engine of ['walker', 'typed'] as const) {
        const was = setScanEngine(engine)
        try {
          const p = compile(src)
          p.scan(0.1)
          got[engine] = p.memory
        } catch (e) {
          failures.push(`seed ${seed} (replay: PLC_FUZZ_SEED=${seed}): ${engine} ${e instanceof Error ? e.message : String(e)}\n${src}`)
        } finally {
          setScanEngine(was)
        }
      }
      if (!got.walker || !got.typed) continue
      const lines = src.split('\n')
      for (const [k, v] of Object.entries(want)) {
        checked++
        const w = got.walker[k]
        const c = got.typed[k]
        if (Object.is(w, v) && Object.is(c, v)) continue
        const line = lines.find((l) => l.startsWith(`${k} := `)) ?? k
        const used = new Set(line.match(/\bq\d+\b/g) ?? [])
        const decls = lines.filter((l) => used.has(l.trim().split(' ')[0]!))
        failures.push(`seed ${seed} (replay: PLC_FUZZ_SEED=${seed}): ${line}\n  expected ${String(v)}, walker ${String(w)}, typed ${String(c)}\n${decls.join('\n')}`)
      }
    }
    expect(failures.join('\n\n')).toBe('')
    expect(checked).toBeGreaterThan(seeds.length * 10)
  }, 600_000)
})
