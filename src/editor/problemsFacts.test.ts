import { afterEach, describe, expect, it } from 'vitest'
import type { Controller } from '../core/controller'
import { PACKAGE_FORMAT, type PartPackage } from '../core/parts/partPackage'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartInstance } from '../core/types'
import { controllerFor } from '../plc'
import { collectProblems, factsArgsOf, factsAskOf, type ProblemsInput } from './problems'
import { programFactsOf } from './program/programFacts'
import { factsOfAsk } from './program/programWorkerAsk'

// The Problems panel asks a worker what the program says (program/programFacts.ts) and runs its checks on the answer.
// The answer crosses a thread boundary, so it must be plain data, and the report made from it must be the report
// collectProblems makes when it works the facts out itself.

const SENSOR: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.sensor',
  name: 'Sensor',
  commsParam: 'enableComms',
  params: {
    enableComms: { type: 'boolean', default: false },
    tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' },
    speedTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '' },
  },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}

const part = (id: string, params: Record<string, unknown>): PartInstance =>
  ({ id, type: 'part', packageId: 't.sensor', position: [0, 0, 0], rotation: [0, 0, 0], params: { enableComms: true, ...params } }) as unknown as PartInstance

const PLAIN = `VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
VAR
  Speed : REAL;
  Count : INT;
  Hold : TON;
END_VAR
Hold(IN := Eye, PT := T#1s);
Run := NOT Hold.Q;`

const WRAPPED = `PROGRAM Line
VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
VAR
  Speed : REAL;
END_VAR
Run := NOT Eye;
END_PROGRAM`

const FAST = `${WRAPPED}
CONFIGURATION Cell
  RESOURCE Main ON PLC
    TASK Quick(INTERVAL := T#100us, PRIORITY := 1);
    PROGRAM A WITH Quick : Line;
  END_RESOURCE
END_CONFIGURATION`

function input(stProgram: string, parts: PartInstance[], more: Partial<ProblemsInput> = {}): ProblemsInput {
  return { parts, stProgram, runtime: [], buildErrors: {}, stepHz: 60, ...more }
}

afterEach(() => clearPackages())

const CASES: [string, () => ProblemsInput & { raw?: Controller | null }][] = [
  ['a program that compiles, parts wired to its tags, a typo and a type clash', () => input(PLAIN, [part('s1', { tag: 'Eye' }), part('s2', { tag: 'Eyee' }), part('s3', { tag: 'Count' }), part('s4', { speedTag: 'Hold.Q' })])],
  ['a PROGRAM under the default table: bare names reach its instance', () => ({ ...input(WRAPPED, [part('s1', { tag: 'Eye', speedTag: 'Speed' })]), controller: controllerFor(WRAPPED, null, 10), raw: null })],
  ['a program that does not compile', () => input('VAR n : INT; END_VAR\nn := ;', [part('s1', { tag: 'n' })])],
  ['a task faster than the simulator scans', () => input(FAST, [part('s1', { tag: 'A.Eye' })])],
  ['no program at all', () => input('', [part('s1', { tag: 'Eye' })])],
  ['a dialect this build does not read', () => input(PLAIN, [part('s1', { tag: 'Eye' })], { stDialect: 'other' })],
]

describe('the Problems report from facts worked out elsewhere', () => {
  for (const [name, make] of CASES) {
    it(`is the report collectProblems makes itself: ${name}`, () => {
      registerPackage(SENSOR)
      const doc = make()
      const own = collectProblems(doc)
      // as a worker would hand them over
      const facts = structuredClone(programFactsOf(factsArgsOf(doc)))
      expect(collectProblems(doc, facts)).toEqual(own)
      // not vacuous: every case here has something to say
      expect(own.problems.length + own.notes.length).toBeGreaterThan(0)
    })
  }

  it('the worker composes the table from what the store holds, and hands it back', () => {
    registerPackage(SENSOR)
    const parts = [part('s1', { tag: 'Eye', speedTag: 'Speed' })]
    const table = controllerFor(WRAPPED, null, 10)
    const own = collectProblems({ ...input(WRAPPED, parts), controller: table })
    const answer = structuredClone(factsOfAsk(factsAskOf({ ...input(WRAPPED, parts), controller: null, scanMs: 10 })))
    expect(answer.table).toEqual(table)
    expect(collectProblems({ ...input(WRAPPED, parts), controller: answer.table }, answer.facts)).toEqual(own)
  })

  it('a foreign dialect sends no program text and composes no table', () => {
    registerPackage(SENSOR)
    const ask = factsAskOf({ ...input(PLAIN, [part('s1', { tag: 'Eye' })], { stDialect: 'other' }), controller: null, scanMs: 10 })
    expect(ask.source).toBe('')
    expect(ask.compose).toBe(false)
    expect(factsOfAsk(ask).table).toBeNull()
  })
})
