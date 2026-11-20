// The demo's program scans the same on both PLC scan engines (plc/scanEngineOracle.ts): the typed engine it runs
// on, and the AST walker kept as the reference. Here, not in plc/, because the demo's program lives in the
// editor layer. Both spellings of it: the shipped one (Palletizer in ladder, calling PalletTruck in ST) and the
// all-ST reference it was translated from. The oracle's own corpus checks are plc/scanEngines.test.ts.

import { describe, expect, it } from 'vitest'
import { controllerFor, runnableSource } from '../../plc/controller'
import { compile } from '../../plc/interpreter'
import { codegenFallbacks } from '../../plc/scanCodegen'
import { compareEngines, randomWrites, seeded, type OracleStep } from '../../plc/scanEngineOracle'
import type { TagValue } from '../../plc/types'
import { DEMO_REFERENCE_PROGRAM, ST_REFERENCE_CONTROLLER } from './demoReference'
import { DEMO_CONTROLLER, DEMO_PROGRAM } from './demoScenes'

/** The cell's inputs driven the way a run drives them: Stop / Guard / every E-stop held closed, everything else toggled. */
function drive(src: string, seed: number): OracleStep[] {
  const inputs = compile(src).inputs
  const held = new Set(['STOP', 'GUARD', 'ESTOP', 'ESTOPDOCK', 'ESTOPGATE', 'ESTOPSUPPLY', 'ESTOPOUTFEED'])
  const rand = seeded(seed)
  return Array.from({ length: 600 }, (_, i) => {
    const write: Record<string, TagValue> = {}
    if (i === 0) for (const k of inputs) if (held.has(k.toUpperCase().replace(/^.*\./, ''))) write[k] = true
    if (i > 0 && i % 5 === 0) for (const k of inputs) if (!held.has(k.toUpperCase().replace(/^.*\./, '')) && rand() < 0.3) write[k] = rand() < 0.5
    return { in: write, dt: 0.01 }
  })
}

describe("the demo's program scans the same on both engines", () => {
  for (const [name, program, controller] of [
    ['shipped (ladder + ST)', DEMO_PROGRAM, DEMO_CONTROLLER],
    ['all-ST reference', DEMO_REFERENCE_PROGRAM, ST_REFERENCE_CONTROLLER],
  ] as const) {
    it(name, () => {
      const src = runnableSource(program, controllerFor(program, controller, 10))
      const plain = compareEngines(src, drive(src, 11))
      expect(plain.refused).toBeUndefined()
      expect(plain.diffs).toEqual([])
      expect(plain.fault).toBeNull()
      expect(plain.compared).toBeGreaterThan(600 * 50)
      const written = compareEngines(src, drive(src, 12), { between: randomWrites(seeded(13), 3) })
      expect(written.refused).toBeUndefined()
      expect(written.diffs).toEqual([])
      expect(codegenFallbacks).toEqual([]) // a body that fell back runs on the walker, and the comparison would be vacuous
    })
  }
})
