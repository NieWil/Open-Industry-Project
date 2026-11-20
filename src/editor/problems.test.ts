import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import type { SdkPart } from '../core/types'
import type { RuntimePartDiagnostic } from '../core/parts/partDiagnostics'
import { DEFAULT_SIM_HZ, MAX_SIM_HZ } from '../core/types'
import { collectProblems, type ProblemsInput } from './problems'
import { controllerFor } from '../plc'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import { partFingerprint } from '../core/parts/partOrigin'
import { PART_SDK_LEVEL } from '../core/parts/partSdk'

// Synthetic packages, like plc/wiring.test.ts: what the aggregator needs from a package is its
// declared tag signals, and building real ones here would only test the build.
function pkg(id: string, params: PartPackage['params']): PartPackage {
  return { format: PACKAGE_FORMAT, id, name: id, params, behavior: 'definePart({step(){}})', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }
}

const CONVEYOR = pkg('t.conveyor', {
  enableComms: { type: 'boolean', default: false },
  runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
  runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' },
})
const SENSOR = pkg('t.sensor', {
  enableComms: { type: 'boolean', default: false },
  tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' },
})

function part(id: string, packageId: string, params: Record<string, unknown>, extra: Partial<SdkPart> = {}): SdkPart {
  return { id, type: 'part', packageId, params: { enableComms: true, ...params }, position: [0, 0, 0], rotationY: 0, ...extra } as SdkPart
}

function input(over: Partial<ProblemsInput> = {}): ProblemsInput {
  return { parts: [], stProgram: '', runtime: [], buildErrors: {}, stepHz: DEFAULT_SIM_HZ, ...over }
}

const GOOD_PROGRAM = `VAR_INPUT
  PE : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
Motor := PE;`

afterEach(() => {
  clearPackages()
})

describe('collectProblems - a clean document', () => {
  it('reports nothing for an empty scene with no program', () => {
    const r = collectProblems(input())
    expect(r.problems).toEqual([])
    expect(r.errors).toBe(0)
    expect(r.warnings).toBe(0)
    expect(r.notes).toEqual([])
  })

  it('reports nothing for a scene whose every tag has one driver and a reader', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const r = collectProblems(
      input({
        stProgram: GOOD_PROGRAM,
        parts: [part('c1', 't.conveyor', { runTag: 'Motor', runningTag: '' }), part('s1', 't.sensor', { tag: 'PE' })],
      }),
    )
    expect(r.problems).toEqual([])
    expect(r.notes).toEqual([])
  })

  it('reports nothing for a program whose own tags the parts are wired to, as Play binds them', () => {
    // plain VARs carry no direction; the eye publishes PE and the belt reads Motor, so Play binds them
    // that way, and a tag Play connects is not one to warn about
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const r = collectProblems(
      input({
        stProgram: 'VAR PE : BOOL; Motor : BOOL; END_VAR\nMotor := PE;',
        parts: [part('c1', 't.conveyor', { runTag: 'Motor', runningTag: '' }), part('s1', 't.sensor', { tag: 'PE' })],
      }),
    )
    expect(r.problems).toEqual([])
  })

  it('reports nothing for a sole PROGRAM instance whose plain VARs the parts name bare, as Play binds them', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const stProgram = 'PROGRAM Main\nVAR PE : BOOL; Motor : BOOL; END_VAR\nMotor := PE;\nEND_PROGRAM'
    const r = collectProblems(
      input({
        stProgram,
        // the default table, as the Problems panel passes it: it runs Main as the controller's one instance
        controller: controllerFor(stProgram, null, 10),
        parts: [part('c1', 't.conveyor', { runTag: 'Motor', runningTag: '' }), part('s1', 't.sensor', { tag: 'PE' })],
      }),
    )
    expect(r.problems).toEqual([])
  })
})

describe('collectProblems - the ST program', () => {
  it("points a controller table's problem at the Controller dock, since it has no line to jump to", () => {
    const r = collectProblems(
      input({
        stProgram: GOOD_PROGRAM,
        controller: { tasks: [{ name: 'T', intervalMs: 10, priority: 1 }], programs: [{ name: 'Main', task: 'T' }, { name: 'Ghost', type: 'Ghost', task: 'T' }] },
      }),
    )
    const rows = r.problems.filter((p) => p.subject === 'Controller')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.panel).toBe('tasks')
      expect(row.offset).toBeUndefined()
    }
    // a program row still jumps to its line, and opens no dock of its own
    const bad = collectProblems(input({ stProgram: 'VAR_OUTPUT\n  Motor : BOOL;\nEND_VAR\nMotor := ;' })).problems.filter((p) => p.group === 'Program')
    expect(bad.every((p) => p.panel === undefined)).toBe(true)
  })

  it('reports a syntax error with its line, and the offset the editor jumps to', () => {
    const r = collectProblems(input({ stProgram: 'VAR_OUTPUT\n  Motor : BOOL;\nEND_VAR\nMotor := ;' }))
    const rows = r.problems.filter((p) => p.group === 'Program')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.severity).toBe('error')
    expect(rows[0]!.line).toBe(4)
    expect(rows[0]!.subject).toBe('Line 4')
    expect(typeof rows[0]!.offset).toBe('number')
  })

  it('reports a function block that holds itself as an error at its line, not "0 errors" and a note', () => {
    const src = 'FUNCTION_BLOCK Loop\nVAR inner : Loop; END_VAR\nEND_FUNCTION_BLOCK\nVAR l : Loop; END_VAR\nVAR_OUTPUT q : BOOL; END_VAR\nq := TRUE;'
    const r = collectProblems(input({ stProgram: src }))
    expect(r.errors).toBe(1)
    expect(r.problems[0]).toMatchObject({ severity: 'error', group: 'Program', line: 2 })
    expect(r.problems[0]!.message).toMatch(/recursive function block 'Loop'/)
  })

  it('says so when the program cannot compile, rather than reading clean', () => {
    const r = collectProblems(input({ stProgram: 'Motor := ;' }))
    expect(r.notes.join(' ')).toMatch(/does not compile/)
  })

  it('leaves no note when the program compiles', () => {
    const r = collectProblems(input({ stProgram: GOOD_PROGRAM }))
    expect(r.notes.join(' ')).not.toMatch(/does not compile/)
  })

  it('does not turn one syntax error into an undriven/unread warning per tag', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const parts = [part('c1', 't.conveyor', { runTag: 'Motor', runningTag: '' }), part('s1', 't.sensor', { tag: 'PE' })]
    // the same scene reads clean while the program compiles...
    expect(collectProblems(input({ stProgram: GOOD_PROGRAM, parts })).problems).toEqual([])
    // ...and must not sprout wiring warnings the moment a semicolon breaks it: those kinds count the
    // program as a writer/reader, so with no link they report the blind spot, not the scene
    const broken = collectProblems(input({ stProgram: `${GOOD_PROGRAM}\nMotor := ;`, parts }))
    expect(broken.problems.filter((p) => p.group === 'Wiring')).toEqual([])
    expect(broken.errors).toBe(1)
    expect(broken.notes.join(' ')).toMatch(/does not compile/)
  })

  it('still reports part-vs-part wiring errors while the program is broken', () => {
    registerPackage(SENSOR)
    const r = collectProblems(
      input({ stProgram: 'Motor := ;', parts: [part('s1', 't.sensor', { tag: 'PE' }), part('s2', 't.sensor', { tag: 'PE' })] }),
    )
    expect(r.problems.some((p) => p.key === 'wiring:contested:PE')).toBe(true)
  })

  it('an empty program is not a problem and not a note', () => {
    const r = collectProblems(input({ stProgram: '   \n  ' }))
    expect(r.problems).toEqual([])
    expect(r.notes).toEqual([])
  })
})

describe('collectProblems - wiring', () => {
  it('carries a contested tag through as an error naming its parts', () => {
    registerPackage(SENSOR)
    const r = collectProblems(input({ parts: [part('s1', 't.sensor', { tag: 'PE' }), part('s2', 't.sensor', { tag: 'PE' })] }))
    const row = r.problems.find((p) => p.key.startsWith('wiring:contested'))
    expect(row).toMatchObject({ severity: 'error', group: 'Wiring', subject: 'PE', parts: ['s1', 's2'] })
    expect(r.errors).toBe(1)
  })

  it('keeps undriven a warning - the engine owns severity, this module only sorts', () => {
    registerPackage(CONVEYOR)
    const r = collectProblems(input({ parts: [part('c1', 't.conveyor', { runTag: 'Motor' })] }))
    const row = r.problems.find((p) => p.key.startsWith('wiring:undriven'))
    expect(row?.severity).toBe('warning')
    expect(r.errors).toBe(0)
    expect(r.warnings).toBeGreaterThan(0)
  })

  it('drops an unread or undriven warning a kept test answers, as check-wiring does', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    // the belt's runningTag Done is read by nothing in the scene, and its runTag Go is driven by nothing
    const parts = [part('c1', 't.conveyor', { runTag: 'Go', runningTag: 'Done' })]
    const keys = (r: ReturnType<typeof collectProblems>) => r.problems.map((p) => p.key)
    expect(keys(collectProblems(input({ parts })))).toEqual(expect.arrayContaining(['wiring:undriven:Go', 'wiring:unread:Done']))
    const tests = [{ name: 'runs', duration: 1, inputs: [{ at: 0, tag: 'Go', value: true }], checks: [{ at: 1, tag: 'Done', equals: true }] }]
    const covered = keys(collectProblems(input({ parts, tests })))
    expect(covered).not.toContain('wiring:undriven:Go')
    expect(covered).not.toContain('wiring:unread:Done')
  })

  it('keeps a warning a test does not answer: a test that drives a tag does not read it', () => {
    registerPackage(CONVEYOR)
    const parts = [part('c1', 't.conveyor', { runningTag: 'Done' })]
    const tests = [{ name: 'drives', duration: 1, inputs: [{ at: 0, tag: 'Done', value: true }], checks: [] }]
    expect(collectProblems(input({ parts, tests })).problems.map((p) => p.key)).toContain('wiring:unread:Done')
  })

  it('reports an unloaded package as unknown tags rather than as a clean part', () => {
    const r = collectProblems(input({ parts: [part('x1', 't.missing', { tag: 'PE' })] }))
    expect(r.notes.join(' ')).toMatch(/t\.missing/)
  })
})

describe('collectProblems - the program/scene name bridge', () => {
  it('flags a program tag no part handles', () => {
    registerPackage(SENSOR)
    const r = collectProblems(input({ stProgram: GOOD_PROGRAM, parts: [part('s1', 't.sensor', { tag: 'PE' })] }))
    const row = r.problems.find((p) => p.key === 'unbound:Motor')
    expect(row).toMatchObject({ severity: 'warning', group: 'Wiring', subject: 'Motor' })
  })

  it('says on the wiring row when the program does not declare the tag, rather than in a second row', () => {
    registerPackage(SENSOR)
    // Spare is written by two sensors (contested) and the program never declares it
    const r = collectProblems(
      input({
        stProgram: GOOD_PROGRAM,
        parts: [part('s1', 't.sensor', { tag: 'Spare' }), part('s2', 't.sensor', { tag: 'Spare' })],
      }),
    )
    // contested and unread are two different mistakes on one tag
    expect(r.problems.filter((p) => p.subject === 'Spare').map((p) => p.key)).toEqual(['wiring:contested:Spare', 'wiring:unread:Spare'])
    expect(r.problems.find((p) => p.key === 'wiring:unread:Spare')?.message).toMatch(/does not declare it, which is usually a typo$/)
    expect(r.problems.find((p) => p.key === 'wiring:contested:Spare')?.message).not.toMatch(/typo/)
  })

  it('reports a tag parts both write and read, which the program never declares: a part write reaches no part', () => {
    registerPackage(CONVEYOR)
    const r = collectProblems(
      input({
        stProgram: GOOD_PROGRAM,
        parts: [part('c1', 't.conveyor', { runTag: 'Spare', runningTag: 'Spare' })],
      }),
    )
    expect(r.problems.filter((p) => p.subject === 'Spare').map((p) => p.key)).toEqual(['wiring:undriven:Spare', 'wiring:unread:Spare'])
    expect(r.problems.find((p) => p.key === 'wiring:undriven:Spare')).toMatchObject({ severity: 'warning', parts: ['c1'] })
  })
})

describe('collectProblems - parts', () => {
  it('reports a build failure and selects every placed instance of that package', () => {
    registerPackage(SENSOR)
    const r = collectProblems(
      input({
        parts: [part('s1', 't.sensor', { tag: 'PE' }), part('s2', 't.sensor', { tag: 'Other' })],
        buildErrors: { 't.sensor': 'Unexpected token }' },
        packageNames: { 't.sensor': 'Photo Eye' },
      }),
    )
    const row = r.problems.find((p) => p.key === 'build:t.sensor')
    expect(row).toMatchObject({ severity: 'error', group: 'Parts', subject: 'Photo Eye', parts: ['s1', 's2'] })
    expect(row?.message).toMatch(/Unexpected token/)
  })

  it('reports a runtime failure against the part instance, with its repeat count', () => {
    registerPackage(SENSOR)
    const diag: RuntimePartDiagnostic = {
      source: 'step',
      partId: 's1',
      packageId: 't.sensor',
      message: 'Cannot read properties of undefined',
      count: 431,
    }
    const r = collectProblems(input({ parts: [part('s1', 't.sensor', { tag: 'PE' }, { name: 'Entry eye' })], runtime: [diag] }))
    const row = r.problems.find((p) => p.key.startsWith('runtime:step'))
    expect(row).toMatchObject({ severity: 'error', group: 'Parts', subject: 'Entry eye', parts: ['s1'], count: 431 })
  })

  it('warns once per package made under a newer Part SDK, selecting every placed instance', () => {
    const newer = { ...SENSOR, sdk: { level: PART_SDK_LEVEL + 1, of: partFingerprint(SENSOR) } }
    registerPackage(newer)
    registerPackage(CONVEYOR)
    const r = collectProblems(input({ parts: [part('s1', 't.sensor', { tag: 'PE' }), part('s2', 't.sensor', { tag: 'PE2' }), part('c1', 't.conveyor', {})] }))
    const rows = r.problems.filter((p) => p.key.startsWith('sdk:'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'sdk:t.sensor', severity: 'warning', group: 'Parts', parts: ['s1', 's2'] })
    expect(rows[0]!.message).toContain(`level ${PART_SDK_LEVEL + 1}`)
  })

  it('does not warn about a newer stamp once the part has changed since', () => {
    registerPackage({ ...SENSOR, sdk: { level: PART_SDK_LEVEL + 1, of: 'v2:stale' } })
    const r = collectProblems(input({ parts: [part('s1', 't.sensor', { tag: 'PE' })] }))
    expect(r.problems.filter((p) => p.key.startsWith('sdk:'))).toEqual([])
  })

  it('omits the count when a runtime diagnostic happened once', () => {
    const diag: RuntimePartDiagnostic = { source: 'geometry', partId: '', packageId: 't.sensor', message: 'over budget', count: 1 }
    const r = collectProblems(input({ runtime: [diag] }))
    expect(r.problems[0]!.count).toBeUndefined()
    expect(r.problems[0]!.parts).toEqual([])
  })
})

describe('collectProblems - ordering and identity', () => {
  it('puts every error before every warning', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const r = collectProblems(
      input({
        stProgram: GOOD_PROGRAM,
        parts: [part('c1', 't.conveyor', { runTag: 'Undriven' }), part('s1', 't.sensor', { tag: 'PE' }), part('s2', 't.sensor', { tag: 'PE' })],
        buildErrors: { 't.sensor': 'boom' },
      }),
    )
    const firstWarning = r.problems.findIndex((p) => p.severity === 'warning')
    const lastError = r.problems.map((p) => p.severity).lastIndexOf('error')
    expect(firstWarning).toBeGreaterThan(lastError)
    expect(r.errors + r.warnings).toBe(r.problems.length)
  })

  it('is deterministic: the same input twice gives the same keys in the same order', () => {
    registerPackage(SENSOR)
    const arg = input({ stProgram: GOOD_PROGRAM, parts: [part('s1', 't.sensor', { tag: 'PE' }), part('s2', 't.sensor', { tag: 'PE' })] })
    expect(collectProblems(arg).problems.map((p) => p.key)).toEqual(collectProblems(arg).problems.map((p) => p.key))
  })

  it('gives every row a unique key, so React can key the list', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const r = collectProblems(
      input({
        stProgram: GOOD_PROGRAM,
        parts: [part('c1', 't.conveyor', { runTag: 'A', runningTag: 'B' }), part('s1', 't.sensor', { tag: 'C' })],
        buildErrors: { 't.sensor': 'boom' },
        runtime: [{ source: 'step', partId: 'c1', packageId: 't.conveyor', message: 'threw', count: 2 }],
      }),
    )
    expect(new Set(r.problems.map((p) => p.key)).size).toBe(r.problems.length)
  })
})

describe('a controller table in Problems', () => {
  const CODE = 'PROGRAM Sorter\nVAR_OUTPUT Divert : BOOL; END_VAR\nDivert := TRUE;\nEND_PROGRAM\n\nVAR_OUTPUT Motor : BOOL; END_VAR\nMotor := TRUE;'
  const unrun = (report: ReturnType<typeof collectProblems>) => report.problems.filter((p) => /no PROGRAM instance runs that code/.test(p.message))

  it("lists code no instance runs once, as the Controller dock's row, not again as a line of the program", () => {
    const report = collectProblems(
      input({ stProgram: CODE, controller: { tasks: [{ name: 'MainTask', intervalMs: 10, priority: 10 }], programs: [{ name: 'Main', type: 'Sorter', task: 'MainTask' }] } }),
    )
    expect(unrun(report)).toHaveLength(1)
    expect(unrun(report)[0]!.panel).toBe('tasks')
  })

  it("keeps it a line of the program when the program's own CONFIGURATION is what lacks the instance", () => {
    const own = `${CODE}\n\nCONFIGURATION C\n  TASK T(INTERVAL := T#10ms, PRIORITY := 0);\n  PROGRAM S WITH T : Sorter;\nEND_CONFIGURATION\n`
    const rows = unrun(collectProblems(input({ stProgram: own })))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.panel).toBeUndefined()
    expect(rows[0]!.line).toBe(7)
  })
})

describe('a task the simulator cannot scan on time', () => {
  const configured = (interval: string): string =>
    `PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM
CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := ${interval}, PRIORITY := 1);
    PROGRAM A WITH Fast : Counter;
  END_RESOURCE
END_CONFIGURATION
`
  const rate = (report: ReturnType<typeof collectProblems>) => report.problems.filter((p) => p.key.startsWith('task-rate:'))

  it('warns on the INTERVAL line, with the interval that holds and the step rate that would', () => {
    const src = configured('T#0.1ms')
    const rows = rate(collectProblems(input({ stProgram: src, stepHz: 60 })))
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.severity).toBe('warning')
    expect(row.line).toBe(7)
    // the jump goes to the value, not the TASK keyword
    expect(src.slice(row.offset)).toMatch(/^T#0\.1ms/)
    // 60 Hz / 64 scans per step: 260.4 us, offered rounded up so the value it names holds; 0.1 ms needs 157 Hz
    expect(row.message).toContain('T#0.261ms or longer')
    expect(row.message).toContain('157 Hz or more')
  })

  it('does not offer a step rate a project cannot choose', () => {
    const row = rate(collectProblems(input({ stProgram: configured('T#0.001ms'), stepHz: MAX_SIM_HZ })))[0]!
    expect(row.message).toContain('T#0.016ms or longer')
    expect(row.message).not.toMatch(/Hz or more/)
  })

  it('is quiet at the limit, and lifts when the step rate rises to hold the interval', () => {
    expect(rate(collectProblems(input({ stProgram: configured('T#0.261ms'), stepHz: 60 })))).toEqual([])
    expect(rate(collectProblems(input({ stProgram: configured('T#1ms'), stepHz: 60 })))).toEqual([])
    expect(rate(collectProblems(input({ stProgram: configured('T#0.1ms'), stepHz: 157 })))).toEqual([])
    expect(rate(collectProblems(input({ stProgram: configured('T#0.1ms'), stepHz: 156 })))).toHaveLength(1)
  })

  it("never flags a controller table's tasks, which are whole milliseconds", () => {
    const code = 'PROGRAM Counter\nVAR_OUTPUT n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\n'
    const controller = { tasks: [{ name: 'Fast', intervalMs: 1, priority: 1 }], programs: [{ name: 'A', type: 'Counter', task: 'Fast' }] }
    expect(rate(collectProblems(input({ stProgram: code, controller, stepHz: 60 })))).toEqual([])
  })
})

describe('layout: parts that should sit on something', () => {
  // a guest declares it mounts onto a host; a deck is somewhere to mount it
  const GUEST: PartPackage = { ...pkg('t.eye', {}), snap: { mounts: [{ accepts: 'rail' } as never] } }
  const DECK = pkg('t.deck', {})

  it('is an error naming the part, which a click selects', () => {
    registerPackage(GUEST)
    registerPackage(DECK)
    const r = collectProblems(input({ parts: [part('e1', 't.eye', {}, { name: 'Exit eye' }), part('d1', 't.deck', {}, { position: [40, 0, 0] })] }))
    const rows = r.problems.filter((p) => p.group === 'Layout')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ severity: 'error', subject: 'Exit eye', parts: ['e1'] })
    expect(rows[0]!.message).toMatch(/mounts onto a host surface, but nothing is within reach/)
  })

  it('is quiet once the part sits on its host', () => {
    registerPackage(GUEST)
    registerPackage(DECK)
    const r = collectProblems(input({ parts: [part('e1', 't.eye', {}), part('d1', 't.deck', {})] }))
    expect(r.problems.filter((p) => p.group === 'Layout')).toEqual([])
  })
})

describe('part references to parts that are gone', () => {
  const SPAWNER = pkg('t.spawner', { feeder: { type: 'partRef', label: 'Pause when this conveyor stops', default: '' } })
  const refs = (r: ReturnType<typeof collectProblems>) => r.problems.filter((p) => p.key.startsWith('partref:'))

  it('is an error on the referring part, naming the param and the missing id', () => {
    registerPackage(SPAWNER)
    const row = refs(collectProblems(input({ parts: [part('s1', 't.spawner', { feeder: 'conv-7' }, { name: 'Spawner' })] })))[0]
    expect(row).toMatchObject({ severity: 'error', group: 'Parts', subject: 'Spawner', parts: ['s1'] })
    expect(row!.message).toMatch(/"Pause when this conveyor stops" points at conv-7, which is not in this scene/)
  })

  it('is quiet when the reference is unset or names a part that is there', () => {
    registerPackage(SPAWNER)
    registerPackage(CONVEYOR)
    expect(refs(collectProblems(input({ parts: [part('s1', 't.spawner', { feeder: 'c1' }), part('c1', 't.conveyor', { runTag: '' })] })))).toEqual([])
    expect(refs(collectProblems(input({ parts: [part('s1', 't.spawner', { feeder: '' })] })))).toEqual([])
  })
})

describe('@bind pragmas, retired with tag scope', () => {
  it('warns at each one, since it is a comment that binds nothing, and the program still runs', () => {
    registerPackage(SENSOR)
    const src = `(* @bind Motor = Cell1/Motor *)\n${GOOD_PROGRAM}`
    const r = collectProblems(input({ stProgram: src, parts: [part('s1', 't.sensor', { tag: 'PE' })] }))
    const rows = r.problems.filter((p) => p.key.startsWith('bind:'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ severity: 'warning', group: 'Wiring', line: 1, offset: 0 })
    expect(rows[0]!.message).toMatch(/@bind was retired/)
    // its variable is an ordinary one, reported like any other no part handles
    expect(r.problems.some((p) => p.key === 'unbound:Motor')).toBe(true)
  })
})

describe('coverage notes for what the panel cannot see', () => {
  it('names each blind spot it is told about, and none it is not', () => {
    expect(collectProblems(input()).notes).toEqual([])
    const r = collectProblems(input({ runtimeOverflowed: true, heldCode: 1, externalPlc: true }))
    expect(r.notes).toEqual([
      'Part runtime problems stopped being recorded after the first 200, so some may be missing here.',
      '1 part type in this shared project is blocked from running its own code, so its runtime problems come from the stand-in that runs instead.',
      'An external PLC runs the logic when you press Play, so the program checks above are about the program in this app, which does not run.',
    ])
  })
})

describe('a runtime fault of the program', () => {
  const SRC = 'VAR_INPUT d : INT; END_VAR\nVAR_OUTPUT q : INT; END_VAR\nq := 10 / d;'

  it('is an error at the line and column it names, which a click jumps to', () => {
    const r = collectProblems(input({ stProgram: SRC, plcFault: { message: 'division by zero', line: 3, col: 6 } }))
    const row = r.problems.find((p) => p.key.startsWith('plcfault:'))
    expect(row).toMatchObject({ severity: 'error', group: 'Program', subject: 'Line 3', line: 3 })
    expect(SRC.slice(row!.offset)).toMatch(/^10 \/ d/)
    expect(row!.message).toBe('division by zero: the scan faulted, so the program stopped and every device went to hand control')
  })

  it('still says so when the fault names no line, or a line past the program', () => {
    for (const f of [{ message: 'loop cap' }, { message: 'odd', line: 99, col: 1 }]) {
      const row = collectProblems(input({ stProgram: SRC, plcFault: f })).problems.find((p) => p.key.startsWith('plcfault:'))
      expect(row).toMatchObject({ severity: 'error', subject: 'Program' })
      expect(row!.offset).toBeUndefined()
    }
  })

  it('is absent without one', () => {
    expect(collectProblems(input({ stProgram: SRC, plcFault: null })).problems.filter((p) => p.key.startsWith('plcfault:'))).toEqual([])
  })
})

describe('a controller the tags name', () => {
  // `Cell2::%IX0.0` (core/io/controllerTag.ts): Play connects Cell2 only when the project lists it and it is on
  const parts = () => [part('s1', 't.sensor', { tag: 'Cell2::%IX0.0' }), part('c1', 't.conveyor', { runTag: 'Cell2::%QX0.0' }), part('s2', 't.sensor', { tag: 'PE' })]
  const rows = (namedPlcs: ProblemsInput['namedPlcs']) => collectProblems(input({ parts: parts(), stProgram: GOOD_PROGRAM, namedPlcs })).problems.filter((p) => p.key.startsWith('controller:'))

  it('is a warning naming its parts when the project does not list it', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    expect(rows([])).toEqual([expect.objectContaining({ severity: 'warning', subject: 'Cell2', parts: ['s1', 'c1'] })])
    expect(rows([])[0]!.message).toMatch(/project has no controller by that name/)
  })

  it('says a tag naming the default controller carries a name its tags never do', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    const found = collectProblems(input({ parts: parts(), stProgram: GOOD_PROGRAM, namedPlcs: [], mainPlcName: 'cell2' })).problems.filter((p) => p.key.startsWith('controller:'))
    expect(found).toEqual([expect.objectContaining({ subject: 'Cell2', parts: ['s1', 'c1'] })])
    expect(found[0]!.message).toMatch(/default controller/)
  })

  it('says so when it is set up but switched off, and nothing when Play connects it', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    expect(rows([{ name: 'Cell2', enabled: false }])[0]!.message).toMatch(/switched off/)
    expect(rows([{ name: 'Cell2', enabled: true }])).toEqual([])
  })

  it('is not asked without a list, and never blames the program for its tags', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    expect(rows(undefined)).toEqual([])
    const all = collectProblems(input({ parts: parts(), stProgram: GOOD_PROGRAM })).problems
    expect(all.filter((p) => p.subject.startsWith('Cell2::'))).toEqual([])
  })
})

describe('program instances on other controllers', () => {
  const LINE = `PROGRAM Line
VAR_INPUT
  PE : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
Motor := PE;
END_PROGRAM
`
  const table = {
    tasks: [
      { name: 'T', intervalMs: 10, priority: 1 },
      { name: 'T2', intervalMs: 10, priority: 1, plc: 'Cell2' },
    ],
    programs: [
      { name: 'LineA', type: 'Line', task: 'T' },
      { name: 'LineB', type: 'Line', task: 'T2' },
    ],
  }
  const parts = () => [
    part('s1', 't.sensor', { tag: 'LineA.PE' }),
    part('c1', 't.conveyor', { runTag: 'LineA.Motor' }),
    part('s2', 't.sensor', { tag: 'Cell2::LineB.PE' }),
    part('c2', 't.conveyor', { runTag: 'Cell2::LineB.Motor' }),
  ]
  const rows = (runsOn: 'app' | 'plc', enabled = true) =>
    collectProblems(input({ parts: parts(), stProgram: LINE, controller: table, namedPlcs: [{ name: 'Cell2', enabled, runsOn }], mainPlcName: 'PLC1' })).problems

  it("checks an instance on a simulated controller against that controller's tags, not the default one's", () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    expect(rows('app').map((p) => p.key)).toEqual([])
  })

  it('says an instance on a PLC outside the app does not run here, and a simulated controller that runs nothing', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    const onPlc = rows('plc').filter((p) => p.key.startsWith('instance-plc:'))
    expect(onPlc).toEqual([expect.objectContaining({ subject: 'LineB', severity: 'warning' })])
    expect(onPlc[0]!.message).toMatch(/a PLC outside the app/)
    const idle = collectProblems(input({ parts: parts(), stProgram: LINE, controller: { ...table, programs: table.programs.slice(0, 1) }, namedPlcs: [{ name: 'Cell2', enabled: true, runsOn: 'app' }] })).problems
    expect(idle.filter((p) => p.key.startsWith('controller-idle:')).map((p) => p.subject)).toEqual(['Cell2'])
  })
})
