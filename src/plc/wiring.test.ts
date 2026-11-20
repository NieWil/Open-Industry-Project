import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import { LocalPlcLink } from './link/plcLink'
import { unhandledProgramTags } from './bindings'
import { checkWiring, type WiringPart, wiredBindings } from './wiring'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

// The wiring check reads the declared signal on each tag param (dir + stType) - so unlike the
// direction-blind walk in bindings.ts it can tell a driver from a reader, and catch the plumbing
// mistakes that are otherwise silent until you run the scene and watch nothing move.

/** A package whose tag params carry declared signals, as every built-in part's do. */
function pkg(id: string, params: PartPackage['params']): PartPackage {
  return { format: PACKAGE_FORMAT, id, name: id, ...('enableComms' in params ? { commsParam: 'enableComms' } : {}), params, behavior: 'definePart({step(){}})', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } } }
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
const COUNTER = pkg('t.counter', {
  enableComms: { type: 'boolean', default: false },
  countTag: { type: 'tag', dir: 'out', stType: 'INT', default: '' },
})

function scene(...parts: WiringPart[]): WiringPart[] {
  return parts
}
function part(id: string, packageId: string, params: Record<string, unknown>): WiringPart {
  return { id, type: 'part', packageId, params: { enableComms: true, ...params } }
}

afterEach(() => {
  clearPackages()
})

describe('checkWiring', () => {
  it('passes a scene whose every tag has exactly one driver and a reader', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const link = new LocalPlcLink(`VAR_INPUT
  PE : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
Motor := PE;`)
    const report = checkWiring(
      scene(part('c1', 't.conveyor', { runTag: 'Motor', runningTag: '' }), part('s1', 't.sensor', { tag: 'PE' })),
      link,
    )
    expect(report.problems).toEqual([])
    expect(report.tags.find((t) => t.name === 'Motor')).toMatchObject({ readers: ['c1'], programWrites: true, type: 'BOOL' })
  })

  it('flags two parts driving one tag as an error (last writer wins, by part order)', () => {
    registerPackage(SENSOR)
    const report = checkWiring(scene(part('s1', 't.sensor', { tag: 'PE' }), part('s2', 't.sensor', { tag: 'PE' })))
    const contested = report.problems.filter((p) => p.kind === 'contested')
    expect(contested).toHaveLength(1)
    expect(contested[0]).toMatchObject({ severity: 'error', tag: 'PE', parts: ['s1', 's2'] })
  })

  it('counts the ST program as a driver, so program + part on one tag is contested too', () => {
    registerPackage(SENSOR)
    const link = new LocalPlcLink(`VAR_OUTPUT
  PE : BOOL;
END_VAR
PE := TRUE;`)
    const report = checkWiring(scene(part('s1', 't.sensor', { tag: 'PE' })), link)
    expect(report.problems.map((p) => p.kind)).toContain('contested')
  })

  it("reads the program's value table once, however many tags are wired", () => {
    registerPackage(SENSOR)
    const program = new LocalPlcLink(`VAR
  A : BOOL;
  B : BOOL;
  C : INT;
END_VAR`)
    // a link builds its whole table on each read
    let reads = 0
    const link = {
      inputs: program.inputs,
      outputs: program.outputs,
      aliases: program.aliases,
      get watch() {
        reads++
        return program.watch
      },
    }
    const report = checkWiring(scene(part('s1', 't.sensor', { tag: 'A' }), part('s2', 't.sensor', { tag: 'B' }), part('s3', 't.sensor', { tag: 'C' })), link)
    expect(reads).toBe(1)
    // and the type check it feeds still runs: a BOOL sensor on an INT variable
    expect(report.problems.some((p) => p.tag === 'C')).toBe(true)
  })

  it('flags one tag declared as two different ST types', () => {
    registerPackage(SENSOR)
    registerPackage(COUNTER)
    const report = checkWiring(scene(part('s1', 't.sensor', { tag: 'Shared' }), part('k1', 't.counter', { countTag: 'Shared' })))
    const clash = report.problems.find((p) => p.kind === 'type-clash')
    expect(clash).toMatchObject({ severity: 'error', tag: 'Shared' })
    expect(clash?.message).toMatch(/BOOL and INT|INT and BOOL/)
    expect(report.tags.find((t) => t.name === 'Shared')?.type).toBeNull()
  })

  it("flags a part's BOOL against a numeric program var (the mismatch `watch` can prove)", () => {
    registerPackage(SENSOR)
    const link = new LocalPlcLink(`VAR_INPUT
  Level : INT;
END_VAR
VAR_OUTPUT
  Q : BOOL;
END_VAR
Q := Level > 3;`)
    const report = checkWiring(scene(part('s1', 't.sensor', { tag: 'Level' })), link)
    const mismatch = report.problems.find((p) => p.kind === 'program-type')
    expect(mismatch).toMatchObject({ severity: 'error', tag: 'Level' })
  })

  it('warns (never errors) on a tag nothing drives - a forward reference is legal', () => {
    registerPackage(CONVEYOR)
    const report = checkWiring(scene(part('c1', 't.conveyor', { runTag: 'NotYetWritten' })))
    const undriven = report.problems.find((p) => p.kind === 'undriven')
    expect(undriven).toMatchObject({ severity: 'warning', tag: 'NotYetWritten' })
    expect(report.problems.every((p) => p.severity === 'warning')).toBe(true)
  })

  it('says what an undriven setpoint costs: the part runs on 0 in place of the param it replaces', () => {
    registerPackage(pkg('t.drive', {
      speed: { type: 'number', default: 1, label: 'Speed (m/s, − reverses)' },
      speedTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '' },
      runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '' },
      stopTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
    }))
    const report = checkWiring(scene(part('d1', 't.drive', { speedTag: 'Rate', runTag: 'Go', stopTag: 'Halt' })))
    const msg = (tag: string) => report.problems.find((p) => p.kind === 'undriven' && p.tag === tag)?.message
    expect(msg('Rate')).toContain('so d1 uses 0 in place of its Speed (m/s)')
    // a gate read only while driven: undriven, the part runs on its own setting, so it does not read 0
    expect(msg('Go')).toContain('d1 ignores it and runs on its own setting')
    expect(msg('Go')).not.toContain('zero value')
    // one read whenever it names a tag does read 0, and replaces no param
    expect(msg('Halt')).toContain('it stays at its zero value')
    expect(msg('Halt')).not.toContain('in place of')
  })

  it('warns on a published tag nobody reads, and stays quiet once the program reads it', () => {
    registerPackage(SENSOR)
    expect(checkWiring(scene(part('s1', 't.sensor', { tag: 'PE' }))).problems.map((p) => p.kind)).toContain('unread')
    const link = new LocalPlcLink(`VAR_INPUT
  PE : BOOL;
END_VAR
VAR_OUTPUT
  M : BOOL;
END_VAR
M := PE;`)
    expect(checkWiring(scene(part('s1', 't.sensor', { tag: 'PE' })), link).problems).toEqual([])
  })

  it('ignores comms-disabled parts and empty tag values', () => {
    registerPackage(SENSOR)
    const report = checkWiring(
      scene(
        { id: 'off', type: 'part', packageId: 't.sensor', params: { enableComms: false, tag: 'PE' } },
        part('blank', 't.sensor', { tag: '   ' }),
      ),
    )
    expect(report.problems).toEqual([])
    expect(report.tags).toEqual([])
  })

  it('reports a bound tag param with no declared direction instead of skipping it', () => {
    // only a stored package can carry one (an authored part is refused without dir); the check cannot wire it
    registerPackage(pkg('t.legacy', { tag: { type: 'tag', default: '' } }))
    const report = checkWiring(scene(part('legacy', 't.legacy', { tag: 'PE' }), part('unbound', 't.legacy', { tag: '' })))
    expect(report.problems).toEqual([
      expect.objectContaining({ severity: 'warning', kind: 'undeclared', tag: 'PE', parts: ['legacy'] }),
    ])
    expect(report.tags).toEqual([])
  })

  it('sorts errors ahead of warnings', () => {
    registerPackage(SENSOR)
    registerPackage(COUNTER)
    const report = checkWiring(scene(part('s1', 't.sensor', { tag: 'Shared' }), part('k1', 't.counter', { countTag: 'Shared' })))
    expect(report.problems.length).toBeGreaterThan(1)
    expect(report.problems[0]?.severity).toBe('error')
  })
})

describe('checkWiring: a part wired to a direct address', () => {
  const SPEED = pkg('t.speed', {
    enableComms: { type: 'boolean', default: false },
    speedTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '' },
  })

  it('connects a sensor at %I and a motor at %Q to the located variables of the program', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const link = new LocalPlcLink('VAR\n  Eye AT %IX100.0 : BOOL;\n  Run AT %QX100.0 : BOOL;\nEND_VAR\nRun := NOT Eye;')
    const report = checkWiring(scene(part('c1', 't.conveyor', { runTag: '%QX100.0' }), part('s1', 't.sensor', { tag: '%ix100.0' })), link)
    expect(report.problems).toEqual([])
    expect(report.tags.find((t) => t.name === '%IX100.0')).toMatchObject({ writers: ['s1'], programReads: true })
    expect(report.tags.find((t) => t.name === '%QX100.0')).toMatchObject({ readers: ['c1'], programWrites: true })
  })

  it('refuses an address the wrong way round, naming the one that fits', () => {
    registerPackage(CONVEYOR)
    registerPackage(SENSOR)
    const report = checkWiring(scene(part('c1', 't.conveyor', { runTag: '%IX0.1' }), part('s1', 't.sensor', { tag: '%QX0.0' })))
    expect(report.problems.map((p) => [p.kind, p.parts, p.message])).toEqual([
      ['address', ['c1'], "c1 (runTag): this part is driven by the value, so it is the PLC's output: a %Q address (%QX0.1), not %IX0.1"],
      ['address', ['s1'], "s1 (tag): this part publishes the value, so it is the PLC's input: an %I address (%IX0.0), not %QX0.0"],
    ])
  })

  it('refuses a value that does not travel in the address size, memory, and a malformed address', () => {
    registerPackage(SENSOR)
    registerPackage(COUNTER)
    registerPackage(SPEED)
    const report = checkWiring(
      scene(
        part('s1', 't.sensor', { tag: '%IW0' }),
        part('n1', 't.counter', { countTag: '%IX0.0' }),
        part('v1', 't.speed', { speedTag: '%QW0' }),
        part('m1', 't.sensor', { tag: '%MX0.0' }),
        part('x1', 't.sensor', { tag: '%IX7' }),
      ),
    )
    const byPart = Object.fromEntries(report.problems.map((p) => [p.parts[0], p.message]))
    expect(byPart.s1).toMatch(/the value is BOOL, which does not travel in the word address %IW0 \(a bit, like %IX0.0\)/)
    expect(byPart.n1).toMatch(/the value is INT, which does not travel in the bit address %IX0.0/)
    expect(byPart.v1).toMatch(/the value is REAL, which does not travel in the word address %QW0 \(a double word, like %ID0\)/)
    expect(byPart.m1).toMatch(/%MX0.0 is a memory address/)
    expect(byPart.x1).toMatch(/a bit address is byte.bit/)
    expect(report.problems.every((p) => p.severity === 'error' && p.kind === 'address')).toBe(true)
  })

  it('warns when the program declares no variable at an address a part reads', () => {
    registerPackage(CONVEYOR)
    const link = new LocalPlcLink('VAR Run AT %QX0.0 : BOOL; END_VAR\nRun := TRUE;')
    const report = checkWiring(scene(part('c1', 't.conveyor', { runTag: '%QX0.1' })), link)
    expect(report.problems).toMatchObject([{ kind: 'undriven', tag: '%QX0.1', severity: 'warning' }])
  })
})

// ---- binding by wiring ----
// A program's own tags (a plain VAR, a global, a controller tag, `Instance.Name`) carry no direction. A part wired to one by name connects it, and the parts say
// which way it goes. Before this, only VAR_INPUT / VAR_OUTPUT crossed: a plain-VAR program ran, the
// Problems dock called every tag unwired, and the belt never heard the eye.

const PLAIN = `VAR
  Eye : BOOL;
  Run : BOOL;
  Spare : BOOL;
END_VAR
Run := NOT Eye;`

describe('wiredBindings: a program tag a part is wired to binds, in the direction the parts give it', () => {
  it('makes a tag a part publishes an input, and one the parts only read an output', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    const link = new LocalPlcLink(PLAIN)
    expect([link.inputs, link.outputs]).toEqual([[], []])
    const parts = scene(part('eye', 't.sensor', { tag: 'Eye' }), part('belt', 't.conveyor', { runTag: 'Run' }))
    expect(wiredBindings(parts, link)).toEqual({ inputs: ['Eye'], outputs: ['Run'] })
  })

  it('runs the program on them: the input written before each scan, the output handed back', () => {
    const bound = new LocalPlcLink(PLAIN).withBindings({ inputs: ['Eye'], outputs: ['Run'] })
    expect([bound.inputs, bound.outputs]).toEqual([['Eye'], ['Run']])
    expect(bound.step({ Eye: false }, 0.01)).toEqual({ Run: true })
    expect(bound.step({ Eye: true }, 0.01)).toEqual({ Run: false })
    // a tag nothing bound stays internal: not written, not returned
    expect(bound.step({ Eye: true, Spare: true }, 0.01)).toEqual({ Run: false })
    expect(bound.watch.Spare).toBe(false)
  })

  it('binds a tag that parts both publish and read as an input: a part drives it, so the program must not', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    const parts = scene(part('eye', 't.sensor', { tag: 'Eye' }), part('belt', 't.conveyor', { runTag: 'Eye' }))
    expect(wiredBindings(parts, new LocalPlcLink(PLAIN))).toEqual({ inputs: ['Eye'], outputs: [] })
  })

  it('connects them for the wiring checks, so the Problems dock stops calling them unwired', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    const parts = scene(part('eye', 't.sensor', { tag: 'Eye' }), part('belt', 't.conveyor', { runTag: 'Run' }))
    const plain = new LocalPlcLink(PLAIN)
    const bound = plain.withBindings(wiredBindings(parts, plain))
    // unbound: nothing drives the belt's Run, nothing reads the eye, and neither tag is the program's
    expect(checkWiring(parts, plain).problems.map((p) => `${p.kind}:${p.tag}`).sort()).toEqual(['undriven:Run', 'unread:Eye'])
    expect(unhandledProgramTags(parts, plain).unwired.sort()).toEqual(['Eye', 'Run'])
    expect(checkWiring(parts, bound).problems).toEqual([])
    expect(unhandledProgramTags(parts, bound)).toEqual({ unbound: [], unwired: [] })
  })

  it('leaves declared I/O, located variables, constants and text alone, and a name the program lacks unwired', () => {
    registerPackage(SENSOR)
    const src = `VAR_INPUT Start : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
VAR Lamp AT %QX0.0 : BOOL; END_VAR
VAR CONSTANT Limit : BOOL := TRUE; END_VAR
VAR Label : STRING; END_VAR
Motor := Start AND Limit;
Lamp := Motor;`
    const link = new LocalPlcLink(src)
    expect(link.bindable).toEqual([])
    const parts = scene(...['Start', 'Motor', 'Lamp', 'Limit', 'Label', 'Ghost'].map((t) => part(`s-${t}`, 't.sensor', { tag: t })))
    expect(wiredBindings(parts, link)).toEqual({ inputs: [], outputs: [] })
    expect(unhandledProgramTags(parts, link).unwired).toContain('Ghost')
  })

  it('takes a binding list the link cannot honour without complaint: a scene may be ahead of its program', () => {
    const src = `VAR_INPUT Start : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
VAR Eye : BOOL; Run : BOOL; END_VAR
Motor := Start;
Run := NOT Eye;`
    const bound = new LocalPlcLink(src, { inputs: ['Start', 'Ghost', 'Eye', 'Eye'], outputs: ['Eye', 'Motor', 'Run'] })
    expect(bound.inputs).toEqual(['Start', 'Eye'])
    expect(bound.outputs).toEqual(['Motor', 'Run'])
  })

  it("binds a CONFIGURATION's controller tags by their bare names and an instance's own variables qualified", () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    // the POUs first, then the controller tags, then the table: the shape a controller table generates
    const src = `PROGRAM Belt
VAR_EXTERNAL Eye : BOOL; END_VAR
VAR Run : BOOL; END_VAR
Run := NOT Eye;
END_PROGRAM
VAR
  Eye : BOOL;
END_VAR
CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line WITH Fast : Belt;
  END_RESOURCE
END_CONFIGURATION`
    const link = new LocalPlcLink(src)
    // one instance, so its variables answer to their bare names as well (plcLink.ts soleInstanceAliases); `Eye` is
    // the controller's own tag, which no alias shadows
    expect(link.bindable).toEqual(['Eye', 'Line.Run', 'Run'])
    const parts = scene(part('eye', 't.sensor', { tag: 'Eye' }), part('belt', 't.conveyor', { runTag: 'Line.Run' }))
    const bound = link.withBindings(wiredBindings(parts, link))
    expect([bound.inputs, bound.outputs]).toEqual([['Eye'], ['Line.Run']])
    expect(bound.step({ Eye: true }, 0.01)).toEqual({ 'Line.Run': false })
    expect(bound.step({ Eye: false }, 0.01)).toEqual({ 'Line.Run': true })
  })
})

describe('a word inside a double word', () => {
  // one memory on a real PLC and on every link, two separate names in the sim, so only this check says so
  const overlaps = (r: ReturnType<typeof checkWiring>) => r.problems.filter((p) => p.kind === 'overlap')

  it('is an error naming the word, the double word it sits in, and every part on either', () => {
    registerPackage(COUNTER)
    const r = checkWiring(scene(part('a', 't.counter', { countTag: '%ID100' }), part('b', 't.counter', { countTag: '%IW201' })))
    const rows = overlaps(r)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ severity: 'error', tag: '%IW201', parts: ['b', 'a'] })
    expect(rows[0]!.message).toMatch(/is half of %ID100 \(the two words %IW200 and %IW201\)/)
  })

  it('leaves alone what is not the same memory everywhere: other areas, other words, a bit in a word', () => {
    registerPackage(COUNTER)
    registerPackage(SENSOR)
    const r = checkWiring(
      scene(
        part('a', 't.counter', { countTag: '%ID100' }),
        part('b', 't.counter', { countTag: '%QW200' }),
        part('c', 't.counter', { countTag: '%IW202' }),
        part('d', 't.sensor', { tag: '%IX404.0' }),
      ),
    )
    expect(overlaps(r)).toEqual([])
  })
})

describe('a tag on another controller', () => {
  // `Cell2::%IX0.0` (core/io/controllerTag.ts): its address and its writers are checked, but not against the program
  // here, which does not run it
  const PROGRAM = new LocalPlcLink(`VAR_INPUT
  PE : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR
Motor := PE;`)

  it('checks the address behind the name, and keys it canonically', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    const r = checkWiring(scene(part('s', 't.sensor', { tag: 'Cell2::%i0.0' }), part('c', 't.conveyor', { runTag: 'Cell2::%IX0.1' })))
    // a tag with an address error is left out of the tags, as on the default controller
    expect(r.tags.map((t) => t.name)).toEqual(['Cell2::%IX0.0'])
    expect(r.problems).toEqual([expect.objectContaining({ kind: 'address', tag: 'Cell2::%IX0.1' })])
    expect(r.problems[0]!.message).toMatch(/a %Q address \(%QX0\.1\)/)
  })

  it('is not undriven or unread by the program, and the program does not miss it', () => {
    registerPackage(SENSOR)
    registerPackage(CONVEYOR)
    const parts = scene(part('s', 't.sensor', { tag: 'PE' }), part('c', 't.conveyor', { runTag: 'Motor' }), part('s2', 't.sensor', { tag: 'Cell2::PE' }), part('c2', 't.conveyor', { runTag: 'Cell2::Motor' }))
    expect(checkWiring(parts, PROGRAM).problems).toEqual([])
    expect(unhandledProgramTags(parts, PROGRAM)).toEqual({ unbound: [], unwired: [] })
    // the program's own PE and Motor bind; Cell2's do not
    expect(wiredBindings(parts, { inputs: [], outputs: [], bindable: ['PE', 'Motor'] })).toEqual({ inputs: ['PE'], outputs: ['Motor'] })
  })

  it('lets two controllers use the same address, and still catches two writers on one', () => {
    registerPackage(SENSOR)
    const r = checkWiring(scene(part('a', 't.sensor', { tag: '%IX0.0' }), part('b', 't.sensor', { tag: 'Cell2::%IX0.0' }), part('c', 't.sensor', { tag: 'Cell3::%IX0.0' }), part('d', 't.sensor', { tag: 'Cell3::%IX0.0' })))
    const contested = r.problems.filter((p) => p.kind === 'contested')
    expect(contested.map((p) => p.tag)).toEqual(['Cell3::%IX0.0'])
  })

  it('finds a word inside a double word within one controller, not across two', () => {
    registerPackage(COUNTER)
    const across = checkWiring(scene(part('a', 't.counter', { countTag: '%ID100' }), part('b', 't.counter', { countTag: 'Cell2::%IW201' })))
    expect(across.problems.filter((p) => p.kind === 'overlap')).toEqual([])
    const within = checkWiring(scene(part('a', 't.counter', { countTag: 'Cell2::%ID100' }), part('b', 't.counter', { countTag: 'Cell2::%IW201' })))
    expect(within.problems.filter((p) => p.kind === 'overlap').map((p) => p.tag)).toEqual(['Cell2::%IW201'])
  })

  it('refuses a prefix that is not a controller name', () => {
    registerPackage(SENSOR)
    const r = checkWiring(scene(part('s', 't.sensor', { tag: '2nd::Eye' })))
    expect(r.problems).toEqual([expect.objectContaining({ severity: 'error', kind: 'controller', tag: '2nd::Eye' })])
    expect(r.tags).toEqual([])
  })

  it('reports one controller spelled two ways, since the sim matches tags exactly', () => {
    registerPackage(SENSOR)
    const r = checkWiring(scene(part('a', 't.sensor', { tag: 'Cell2::%IX0.0' }), part('b', 't.sensor', { tag: 'cell2::%IX0.1' })))
    expect(r.problems).toEqual([expect.objectContaining({ severity: 'error', kind: 'controller', tag: 'cell2', parts: ['b'] })])
  })
})
