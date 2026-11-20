import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SdkPart } from '../../core/types'
import type { TestSpec } from '../../core/project/projectTest'
import type { BoxFrame } from '../../core/frame'
import { cargoRows } from '../../core/project/projectProbe'
import { buildPackage } from '../../sim/buildPackage'
import { resolveFaults, runProjectTest } from './projectTestRunner'

// End-to-end proof of the runner: a real SimWorld + a real ST program wired through the tag bus.
// The program echoes a test-input button (Start) to an actuator tag (Cmd); an "echo" part reflects
// Cmd back out as the observable tag (Echoed). So a passing run exercises every seam the harness
// depends on: scheduled input → PLC scan → setBehaviorInputTags → part behavior → frame().tags →
// the evaluator. Deterministic, no cargo/physics timing - pure comms.

const Jolt = await initJolt()

// reads one tag, writes it straight back out (names come from params) + a joint so it's a valid rig
const ECHO = `
definePart({
  joints: ['j1'],
  params: { inTag: { type: 'string', default: 'Cmd' }, outTag: { type: 'string', default: 'Echoed' } },
  step(ctx) { ctx.writeTag(ctx.params.outTag, ctx.readTag(ctx.params.inTag)) },
})
`

// Start (test input, BOOL) → Cmd (actuator output). Cmd is written every scan, so it reads false
// from t=0 (before Start), keeping Echoed present-and-false until the button is pressed.
const PROGRAM = 'VAR_INPUT Start : BOOL; END_VAR\nVAR_OUTPUT Cmd : BOOL; END_VAR\nCmd := Start;'

function echoPart(): SdkPart {
  return { id: 'e', type: 'part', packageId: 'test.echo', position: [0, 0, 0], rotationY: 0, params: { inTag: 'Cmd', outTag: 'Echoed' } } as SdkPart
}

function project(): ProjectJSON {
  const pkg = buildPackage(
    {
      id: 'test.echo',
      name: 'Echo',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
        ],
        joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
      },
    },
    ECHO,
  )
  return {
    version: PROJECT_VERSION,
    name: 'Runner Test',
    packages: [pkg],
    scene: { version: SCENE_VERSION, parts: [echoPart()] },
    stProgram: PROGRAM,
  }
}

describe('runProjectTest', () => {
  afterEach(() => unregisterPackage('test.echo'))

  it('drives an ST program through the tag bus and passes when the checks hold', () => {
    const spec: TestSpec = {
      duration: 1,
      inputs: [{ at: 0.5, tag: 'Start', value: true }],
      checks: [
        { at: 0.2, tag: 'Echoed', equals: false }, // before the button, the belt command is off
        { eventually: true, within: 1, tag: 'Echoed', equals: true }, // the press propagates through
      ],
    }
    const result = runProjectTest(Jolt, project(), spec)
    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => c.ok)).toEqual([true, true])
  })

  it('reports a failing check with the observed value, not a silent pass', () => {
    const spec: TestSpec = { duration: 1, inputs: [{ at: 0.5, tag: 'Start', value: true }], checks: [{ at: 0.2, tag: 'Echoed', equals: true }] }
    const result = runProjectTest(Jolt, project(), spec)
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.detail).toContain('was false at t=0.2s')
  })

  it('flags a typo\'d tag instead of passing vacuously', () => {
    const spec: TestSpec = { duration: 0.3, checks: [{ always: true, tag: 'Ehcoed', equals: false }] }
    const result = runProjectTest(Jolt, project(), spec)
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.detail).toContain('never appeared')
  })

  it('is deterministic: the same project + spec yields identical results', () => {
    const spec: TestSpec = { duration: 0.8, inputs: [{ at: 0.3, tag: 'Start', value: true }], checks: [{ eventually: true, tag: 'Echoed', equals: true }] }
    const a = runProjectTest(Jolt, project(), spec)
    unregisterPackage('test.echo')
    const b = runProjectTest(Jolt, project(), spec)
    expect(a).toEqual(b)
  })

  it("runs a program from its scene's controller table, where parts and tests address its tags as Instance.Name", () => {
    const p = project()
    const entry = p
    entry.stProgram = 'PROGRAM Echo\nVAR_INPUT Start : BOOL; END_VAR\nVAR_OUTPUT Cmd : BOOL; END_VAR\nCmd := Start;\nEND_PROGRAM\n'
    entry.controller = { tasks: [{ name: 'Fast', intervalMs: 10, priority: 0 }], programs: [{ name: 'Line', type: 'Echo', task: 'Fast' }] }
    ;(entry.scene.parts[0] as SdkPart).params = { inTag: 'Line.Cmd', outTag: 'Echoed' }
    const spec: TestSpec = {
      duration: 1,
      inputs: [{ at: 0.5, tag: 'Line.Start', value: true }],
      checks: [
        { at: 0.2, tag: 'Echoed', equals: false },
        { eventually: true, within: 1, tag: 'Echoed', equals: true },
      ],
    }
    const result = runProjectTest(Jolt, p, spec)
    expect(result.checks.map((c) => (c.ok ? 'ok' : c.detail))).toEqual(['ok', 'ok'])
  })
})

// --- output ownership ----------------------------------------------------------------------------
// Attaching a program is two things, and this pins the second. Shipping tag values is only the app's
// `setTags`. A controller also declares which tags it drives (controller.ts
// setDrivenTags → world.setBehaviorDrivenTags), and that is what ctx.tagDriven reads.
//
// Every `autoWhenDriven` tag param is gated on it (12 of the bundled parts read tagDriven, including
// every conveyor), so without it they all sit in hand mode here while behaving correctly in the app.
// The failure is silent: the tags are all present and correct, so nothing a spec asserts about values
// can see it. Without it, the demo cell's chain transfer is commanded through its whole 2 s push with
// `raised` stuck false, its deck spinning below the roller line, moving nothing.
const OWNED = `
definePart({
  joints: ['j1'],
  params: { inTag: { type: 'string', default: 'Cmd' }, outTag: { type: 'string', default: 'Owned' } },
  step(ctx) { ctx.writeTag(ctx.params.outTag, ctx.tagDriven(ctx.params.inTag)) },
})
`

function ownedProject(): ProjectJSON {
  const pkg = buildPackage(
    {
      id: 'test.owned',
      name: 'Owned',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
        ],
        joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
      },
    },
    OWNED,
  )
  const part = { id: 'o', type: 'part', packageId: 'test.owned', position: [0, 0, 0], rotationY: 0, params: { inTag: 'Cmd', outTag: 'Owned' } } as SdkPart
  return {
    version: PROJECT_VERSION,
    name: 'Ownership',
    packages: [pkg],
    scene: { version: SCENE_VERSION, parts: [part] },
    stProgram: PROGRAM,
  }
}

describe('runProjectTest - output ownership', () => {
  afterEach(() => unregisterPackage('test.owned'))

  it('hands the program its driven tags, so a part gated on ctx.tagDriven runs in AUTO', () => {
    const result = runProjectTest(Jolt, ownedProject(), {
      duration: 0.5,
      checks: [{ eventually: true, within: 0.5, tag: 'Owned', equals: true }],
    })
    expect(result.checks[0]!.ok).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('claims ownership of the program outputs only - an input it merely reads is not driven', () => {
    // Start is a VAR_INPUT the test stimulates; the controller does not drive it, so a part asking
    // about it must read false. Without this the fix could be "call everything driven" and still pass.
    const proj = ownedProject()
    ;(proj.scene.parts[0]! as SdkPart).params.inTag = 'Start'
    const result = runProjectTest(Jolt, proj, {
      duration: 0.5,
      inputs: [{ at: 0.1, tag: 'Start', value: true }],
      checks: [{ always: true, tag: 'Owned', equals: false }],
    })
    expect(result.ok).toBe(true)
  })
})

// --- world probes, against real physics ----------------------------------------------------------
// The tag half above proves the comms seam; this proves the other source: a check reading where a
// body actually is. One cargo box, dropped - nothing in this scene writes a tag at all, so a probe
// is the only thing that could possibly observe it.

const CARGO_BEHAVIOR = 'definePart({ step() {} })'

function cargoProject(): ProjectJSON {
  const pkg = buildPackage(
    { id: 'test.crate', name: 'Crate', geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.4, width: 0.4, height: 0.4 } } },
    CARGO_BEHAVIOR,
  )
  const crate: SdkPart = { id: 'c1', type: 'part', packageId: 'test.crate', position: [0, 3, 0], rotationY: 0, params: {} } as SdkPart
  return {
    version: PROJECT_VERSION,
    name: 'Probe Test',
    packages: [pkg],
    scene: { version: SCENE_VERSION, parts: [crate] },
    stProgram: '',
  }
}

describe('runProjectTest - world probes', () => {
  afterEach(() => unregisterPackage('test.crate'))

  it('reads a body position out of the running sim: the crate falls', () => {
    const spec: TestSpec = {
      duration: 1,
      checks: [
        { probe: { pose: { part: 'c1', axis: 'y' } }, at: 0.05, min: 2.9 }, // still up top
        { probe: { pose: { part: 'c1', axis: 'y' } }, eventually: true, max: 2.5 }, // gravity happened
        { probe: { count: { part: 'c1' } }, always: true, equals: 1 }, // never vanished
      ],
    }
    const result = runProjectTest(Jolt, cargoProject(), spec)
    expect(result.checks.map((c) => c.detail)).toBeDefined()
    expect(result.ok).toBe(true)
  })

  it('counts cargo entering and leaving a zone', () => {
    const spec: TestSpec = {
      duration: 1,
      checks: [
        // a zone around the drop point: occupied at the start, empty once the crate falls out
        { probe: { count: { zone: { min: [-1, 2.5, -1], max: [1, 3.5, 1] } } }, at: 0.02, equals: 1 },
        { probe: { count: { zone: { min: [-1, 2.5, -1], max: [1, 3.5, 1] } } }, eventually: true, equals: 0 },
      ],
    }
    expect(runProjectTest(Jolt, cargoProject(), spec).ok).toBe(true)
  })

  it('flags a probe naming a part that is not in the scene, instead of reading 0', () => {
    const spec: TestSpec = { duration: 0.3, checks: [{ probe: { pose: { part: 'c9', axis: 'y' } }, at: 0.1, min: 0 }] }
    const result = runProjectTest(Jolt, cargoProject(), spec)
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.detail).toContain('never appeared')
  })

  it('a failing probe reports the observed number, not a bare false', () => {
    const spec: TestSpec = { duration: 0.3, checks: [{ probe: { pose: { part: 'c1', axis: 'y' } }, at: 0.1, min: 99 }] }
    const result = runProjectTest(Jolt, cargoProject(), spec)
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.detail).toMatch(/pose\(c1\.y\) was [\d.]+ at t=0\.1s, expected ≥ 99/)
  })

  it('is deterministic across runs, like the tag path', () => {
    const spec: TestSpec = { duration: 0.5, checks: [{ probe: { pose: { part: 'c1', axis: 'y' } }, at: 0.4, min: 0 }] }
    const a = runProjectTest(Jolt, cargoProject(), spec)
    unregisterPackage('test.crate')
    const b = runProjectTest(Jolt, cargoProject(), spec)
    expect(a).toEqual(b)
  })
})

describe('runProjectTest - jam', () => {
  afterEach(() => unregisterPackage('test.crate'))

  // the crate falls from y=3; the jam's zone sits across its path, so it is caught on the way down, held, and let go
  const zone = { min: [-1, 1.5, -1] as [number, number, number], max: [1, 2.5, 1] as [number, number, number] }

  it('stops the first body that enters the zone where it stands, and lets it go at until', () => {
    const result = runProjectTest(Jolt, cargoProject(), {
      duration: 1.8,
      faults: [{ at: 0, until: 0.9, kind: 'jam', zone }],
      checks: [
        // free fall would have it at y≈1.2 by 0.6 s and on its way to the floor by 0.85 s: it is held in the zone
        { probe: { pose: { part: 'c1', axis: 'y' } }, at: 0.6, min: 1.5 },
        { probe: { pose: { part: 'c1', axis: 'y' } }, at: 0.85, min: 1.5 },
        // released, it falls on
        { probe: { pose: { part: 'c1', axis: 'y' } }, eventually: true, max: 1 },
      ],
    })
    expect(result.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([])
  })

  it('without the jam the same checks fail, so they are testing the jam', () => {
    const result = runProjectTest(Jolt, cargoProject(), {
      duration: 1.8,
      checks: [{ probe: { pose: { part: 'c1', axis: 'y' } }, at: 0.6, min: 1.5 }],
    })
    expect(result.ok).toBe(false)
  })

  it('refuses a jam that never caught anything, rather than passing on a line that never jammed', () => {
    const away = { min: [10, 0, 10] as [number, number, number], max: [11, 1, 11] as [number, number, number] }
    expect(() =>
      runProjectTest(Jolt, cargoProject(), { duration: 0.5, faults: [{ at: 0, kind: 'jam', zone: away }], checks: [{ probe: { count: {} }, at: 0.1, min: 0 }] }),
    ).toThrow(/jammed nothing/)
  })
})

// --- step rate -----------------------------------------------------------------------------------
// The runner steps at the project's physics rate (ProjectJSON.simHz), the one the editor's Play uses.
// Stepping every scene at a constant is invisible to a spec until the editor runs the same scene at
// another rate, and then the timing a test signed off on is not the timing that runs. A part that
// reports its ctx.dt makes the rate observable from a spec, with no physics in the way.

const DT_BEHAVIOR = `definePart({ joints: ['j1'], step(ctx) { ctx.writeNumber('Dt', ctx.dt) } })`

function rateProject(simHz?: 120 | 240): ProjectJSON {
  const pkg = buildPackage(
    {
      id: 'test.dt',
      name: 'Dt',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
        ],
        joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
      },
    },
    DT_BEHAVIOR,
  )
  const part = { id: 'd', type: 'part', packageId: 'test.dt', position: [0, 0, 0], rotationY: 0, params: {} } as SdkPart
  return {
    version: PROJECT_VERSION,
    name: 'Rate',
    packages: [pkg],
    scene: { version: SCENE_VERSION, parts: [part] },
    ...(simHz !== undefined ? { simHz } : {}),
  }
}

describe('runProjectTest - step rate', () => {
  afterEach(() => unregisterPackage('test.dt'))

  it("steps at the scene's rate, and a scene that names none at 60 Hz", () => {
    for (const [simHz, hz] of [[undefined, 60], [120, 120], [240, 240]] as const) {
      const result = runProjectTest(Jolt, rateProject(simHz), { duration: 0.2, checks: [{ at: 0.1, tag: 'Dt', near: 1 / hz, tolerance: 1e-9 }] })
      expect(result.checks.map((c) => c.detail)).toHaveLength(1)
      expect(result.ok, `${hz} Hz: ${result.checks[0]!.detail}`).toBe(true)
    }
  })
})

// --- scan time ----------------------------------------------------------------------------------------
// A test scans the program as Play does: at the project's scan time, else the editor's 10 ms default. A test that
// scanned once per 16.7 ms step instead passed a one-scan pulse that Play, scanning twice a step, never showed a part.
describe('runProjectTest - scan time', () => {
  afterEach(() => unregisterPackage('test.echo'))
  const counting = (stScanMs?: number): ProjectJSON => ({
    ...project(),
    stProgram: 'VAR_OUTPUT Scans : INT; END_VAR\nScans := Scans + 1;',
    ...(stScanMs !== undefined ? { stScanMs } : {}),
  })
  // whether the program scanned `scans` times (±3) in the first second
  const scanned = (p: ProjectJSON, scans: number, scanMs?: number): boolean =>
    runProjectTest(Jolt, p, { duration: 1, ...(scanMs !== undefined ? { scanMs } : {}), checks: [{ at: 1, tag: 'Scans', near: scans, tolerance: 3 }] }).ok

  it("scans at the project's scan time, the editor's default when it saved none, and a spec's scanMs over both", () => {
    expect(scanned(counting(), 100)).toBe(true) // 10 ms
    expect(scanned(counting(), 60)).toBe(false) // not one scan per 16.7 ms step
    expect(scanned(counting(50), 20)).toBe(true)
    expect(scanned(counting(50), 40, 25)).toBe(true)
  })
})

// --- binding by wiring -----------------------------------------------------------------------------
// A program written with controller tags that carry no direction on any of them. The parts
// give it: an eye publishes Eye, so Eye is the program's input; a belt only reads Run, so Run is its
// output, and it owns it (ctx.tagDriven). Unless the runner binds it as Play does, neither crosses.
const RELAY = `
definePart({
  joints: ['j1'],
  params: {
    enableComms: { type: 'boolean', default: true },
    inTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
    outTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' },
  },
  step(ctx) {
    const { inTag, outTag } = ctx.params
    if (!outTag) return
    ctx.writeTag(outTag, inTag ? ctx.readTag(inTag) === true : false)
    if (inTag) ctx.writeTag(outTag + 'Driven', ctx.tagDriven(inTag))
  },
})
`

function wiredProject(): ProjectJSON {
  const pkg = buildPackage(
    {
      id: 'test.relay',
      name: 'Relay',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
        ],
        joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
      },
    },
    RELAY,
  )
  const relay = (id: string, params: Record<string, unknown>): SdkPart =>
    ({ id, type: 'part', packageId: 'test.relay', position: [0, 0, 0], rotationY: 0, params: { enableComms: true, ...params } }) as SdkPart
  return {
    version: PROJECT_VERSION,
    name: 'Wired',
    packages: [pkg],
    // the eye publishes Eye (false: the test's input stands in for a box arriving); the belt reads Run
    scene: { version: SCENE_VERSION, parts: [relay('eye', { outTag: 'Eye' }), relay('belt', { inTag: 'Run', outTag: 'Belt' })] },
    stProgram: 'VAR Eye : BOOL; Run : BOOL; END_VAR\nRun := NOT Eye;',
  }
}

describe('runProjectTest - a program bound by wiring', () => {
  afterEach(() => unregisterPackage('test.relay'))

  it('binds plain VARs the parts are wired to, in the direction the parts give them, and owns the outputs', () => {
    const result = runProjectTest(Jolt, wiredProject(), {
      duration: 1,
      inputs: [{ at: 0.5, tag: 'Eye', value: true }],
      checks: [
        { at: 0.2, tag: 'Belt', equals: true }, // Run := NOT Eye reaches the belt
        { at: 0.2, tag: 'BeltDriven', equals: true }, // and the program owns it
        { eventually: true, within: 1, tag: 'Belt', equals: false }, // the eye gets in
      ],
    })
    expect(result.checks.map((c) => (c.ok ? 'ok' : c.detail))).toEqual(['ok', 'ok', 'ok'])
  })
})

// --- device faults ---------------------------------------------------------------------------------
// A fault names a device, and the runner finds its tags through the tag params the package declares with a
// direction. This part has both kinds: Cmd in (the program commands it), Echoed out (it reports back), plus a
// REAL input to show a dead actuator's numbers read 0 rather than false. IoFault is a program input a comms loss
// can name as its status bit.

const FAULTY = `
definePart({
  joints: ['j1'],
  params: {
    cmdTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'Cmd' },
    echoTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: 'Echoed' },
    speedTag: { type: 'tag', dir: 'in', stType: 'REAL', default: 'Speed' },
  },
  // Raw is a fixed name, not a declared param: no fault can reach it, so it says what the device really received
  step(ctx) {
    const cmd = ctx.readTag(ctx.params.cmdTag) === true
    ctx.writeTag(ctx.params.echoTag, cmd)
    ctx.writeTag('Raw', cmd)
  },
})
`

// Start drives the device; what the device reports comes back as Seen, so a check can tell what the PLC reads
const FAULT_PROGRAM = 'VAR_INPUT Start : BOOL; Echoed : BOOL; IoFault : BOOL; END_VAR\nVAR_OUTPUT Cmd : BOOL; Seen : BOOL; END_VAR\nCmd := Start;\nSeen := Echoed;'

function faultyPackage() {
  return buildPackage(
    {
      id: 'test.faulty',
      name: 'Faulty',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
        ],
        joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
      },
    },
    FAULTY,
  )
}

// params left empty: the tag names are the package defaults, which the fault must resolve as the sim does
function faultyPart(extra: Partial<SdkPart> = {}): SdkPart {
  return { id: 'd1', type: 'part', packageId: 'test.faulty', position: [0, 0, 0], rotationY: 0, params: {}, ...extra } as SdkPart
}

function faultyProject(parts: SdkPart[] = [faultyPart()]): ProjectJSON {
  return {
    version: PROJECT_VERSION,
    name: 'Faults',
    packages: [faultyPackage()],
    scene: { version: SCENE_VERSION, parts },
    stProgram: FAULT_PROGRAM,
  }
}

describe('runProjectTest - device faults', () => {
  afterEach(() => {
    unregisterPackage('test.faulty')
    unregisterPackage('test.echo')
  })

  it('actuatorDead: the device stops receiving the command while the PLC still sends it, and recovers after until', () => {
    const result = runProjectTest(Jolt, faultyProject(), {
      duration: 1,
      inputs: [{ at: 0.1, tag: 'Start', value: true }],
      faults: [{ at: 0.4, until: 0.7, part: 'd1', kind: 'actuatorDead' }],
      checks: [
        { at: 0.3, tag: 'Echoed', equals: true },
        { at: 0.5, tag: 'Seen', equals: false }, // the device never got Cmd, so it reports off
        { at: 0.5, tag: 'Cmd', equals: true }, // ...while the program still commands it
        { at: 0.9, tag: 'Seen', equals: true }, // cleared: the real command reaches it again
      ],
    })
    expect(result.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([])
  })

  it('sensorStuck: the PLC reads the stuck value though the device senses otherwise', () => {
    const result = runProjectTest(Jolt, faultyProject(), {
      duration: 0.6,
      faults: [{ at: 0.2, part: 'd1', kind: 'sensorStuck', value: true }],
      checks: [
        { at: 0.1, tag: 'Seen', equals: false },
        { at: 0.4, tag: 'Seen', equals: true }, // Start was never pressed: only the stuck wire says true
        { at: 0.4, tag: 'Echoed', equals: true }, // and a check on the device's tag reads the wire, as the PLC does
        { always: true, tag: 'Cmd', equals: false },
      ],
    })
    expect(result.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([])
  })

  it('resolves a device to its tag keys, from the package defaults, numbers to 0', () => {
    registerPackage(faultyPackage(), true)
    const parts = [faultyPart()] as PartInstance[]
    const [dead] = resolveFaults(parts, [{ at: 0, part: 'd1', kind: 'actuatorDead' }])
    expect(dead!.side).toBe('toPart')
    expect(dead!.forced).toEqual({ Cmd: false, Speed: 0 })
    const [stuck] = resolveFaults(parts, [{ at: 0, part: 'd1', kind: 'sensorStuck', value: false }])
    expect(stuck!.side).toBe('toPlc')
    expect(stuck!.forced).toEqual({ Echoed: false })
  })

  it('refuses a fault that would act on nothing, rather than letting every check after it pass', () => {
    const spec = (part: string): TestSpec => ({ duration: 0.2, faults: [{ at: 0, part, kind: 'actuatorDead' }], checks: [{ at: 0.1, tag: 'Cmd', equals: false }] })
    expect(() => runProjectTest(Jolt, faultyProject(), spec('nope'))).toThrow(/no part "nope" in the scene/)
    // the echo part speaks tags through plain string params: no declared direction, so nothing a fault can find
    const proj = project()
    expect(() => runProjectTest(Jolt, proj, spec('e'))).toThrow(/wires no tag the actuatorDead fault can act on/)
    // a tag param left blank is not wired
    expect(() => runProjectTest(Jolt, faultyProject([faultyPart({ params: { cmdTag: '', speedTag: '' } } as Partial<SdkPart>)]), spec('d1'))).toThrow(/wires no tag/)
  })
})

describe('runProjectTest - comms loss', () => {
  afterEach(() => unregisterPackage('test.faulty'))

  const failures = (r: ReturnType<typeof runProjectTest>): string[] => r.checks.filter((c) => !c.ok).map((c) => c.detail)

  it('off/off on the whole network: the device gets off, the PLC reads off, the status bit tracks the loss', () => {
    const result = runProjectTest(Jolt, faultyProject(), {
      duration: 1,
      inputs: [{ at: 0.1, tag: 'Start', value: true }],
      faults: [{ at: 0.4, until: 0.7, kind: 'commsLoss', statusTag: 'IoFault' }],
      checks: [
        { at: 0.3, tag: 'Raw', equals: true },
        { at: 0.3, tag: 'IoFault', equals: false },
        { at: 0.5, tag: 'Raw', equals: false }, // the device lost its command
        { at: 0.5, tag: 'Seen', equals: false }, // and the program lost the device's answer
        { at: 0.5, tag: 'Cmd', equals: true }, // while still commanding it
        { at: 0.5, tag: 'IoFault', equals: true },
        { at: 0.9, tag: 'IoFault', equals: false },
        { at: 0.9, tag: 'Seen', equals: true }, // restored
      ],
    })
    expect(failures(result)).toEqual([])
  })

  it('hold/hold: the device keeps its last command and the program its last reading, until the link returns', () => {
    const result = runProjectTest(Jolt, faultyProject(), {
      duration: 1,
      inputs: [
        { at: 0.1, tag: 'Start', value: true },
        { at: 0.5, tag: 'Start', value: false }, // the stop is sent while nothing can hear it
      ],
      faults: [{ at: 0.4, until: 0.7, kind: 'commsLoss', inputs: 'hold', outputs: 'hold' }],
      checks: [
        { at: 0.6, tag: 'Cmd', equals: false },
        { at: 0.6, tag: 'Raw', equals: true }, // the device never heard it
        { at: 0.6, tag: 'Seen', equals: true }, // and the program still reads it running
        { at: 0.9, tag: 'Raw', equals: false },
        { at: 0.9, tag: 'Seen', equals: false },
      ],
    })
    expect(failures(result)).toEqual([])
  })

  it('a device loss touches that device only', () => {
    registerPackage(faultyPackage(), true)
    const parts = [faultyPart(), faultyPart({ id: 'd2', params: { cmdTag: 'Cmd2', echoTag: 'Echoed2', speedTag: 'Speed2' } } as Partial<SdkPart>)] as PartInstance[]
    const resolved = resolveFaults(parts, [{ at: 0, kind: 'commsLoss', part: 'd2' }])
    expect(resolved.map((r) => [r.side, r.forced])).toEqual([
      ['toPlc', { Echoed2: false }],
      ['toPart', { Cmd2: false, Speed2: 0 }],
    ])
    const network = resolveFaults(parts, [{ at: 0, kind: 'commsLoss' }])
    expect(network.map((r) => Object.keys(r.forced).sort())).toEqual([
      ['Echoed', 'Echoed2'],
      ['Cmd', 'Cmd2', 'Speed', 'Speed2'],
    ])
  })

  it('refuses a status bit the program never reads, and a network loss in a scene with no devices', () => {
    expect(() =>
      runProjectTest(Jolt, faultyProject(), { duration: 0.2, faults: [{ at: 0, kind: 'commsLoss', statusTag: 'IoFualt' }], checks: [{ at: 0.1, tag: 'Cmd', equals: false }] }),
    ).toThrow(/statusTag "IoFualt" is not an input of the program/)
    expect(() => resolveFaults([], [{ at: 0, kind: 'commsLoss' }])).toThrow(/no device in the scene wires a tag the commsLoss fault can act on/)
  })
})

// --- the forms written for robust line tests: windows, a tag on the right, passed + colour ---------------------------

describe('runProjectTest - windows, notEquals and a tag on the right-hand side', () => {
  const inputs = [{ at: 0.3, tag: 'Start', value: true }]

  it('holds Echoed to Start from 0.5 s on, and to false before the press', () => {
    const result = runProjectTest(Jolt, project(), {
      duration: 1,
      inputs,
      checks: [
        { always: true, from: 0.5, tag: 'Echoed', equals: { tag: 'Start' } },
        { always: true, until: 0.25, tag: 'Echoed', equals: false },
        { eventually: true, from: 0.3, until: 0.6, tag: 'Echoed', notEquals: false },
        { at: 0.6, tag: 'Echoed', equals: { tag: 'Cmd' } },
      ],
    })
    expect(result.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([])
  })

  it('negative controls: a window that reaches past the press, a notEquals that is equal, a missing right-hand tag', () => {
    const result = runProjectTest(Jolt, project(), {
      duration: 1,
      inputs,
      checks: [
        { always: true, until: 0.5, tag: 'Echoed', equals: false },
        { at: 0.6, tag: 'Echoed', notEquals: { tag: 'Cmd' } },
        { always: true, tag: 'Echoed', equals: { tag: 'Cmdd' } },
      ],
    })
    expect(result.checks.map((c) => c.ok)).toEqual([false, false, false])
    expect(result.checks[0]!.detail).toMatch(/^Echoed became true at t=0\.3\d+s \(must always be = false between t=0s and t=0\.5s\)$/)
    expect(result.checks[1]!.detail).toBe('Echoed was true at t=0.6s, expected ≠ Cmd (true)')
    expect(result.checks[2]!.detail).toMatch(/^tag "Cmdd" \(the right-hand side\) never appeared \(the run did publish: Cmd, Echoed, Start\)/)
  })
})

describe('runProjectTest - passed and colour, against real physics', () => {
  afterEach(() => unregisterPackage('test.crate'))

  // the crate (red) falls from y=3; a 1 cm slab at y=1 is far thinner than one step of its fall (~10 cm at 60 Hz),
  // so only the swept test can see it go through
  const slab = { min: [-1, 1, -1] as [number, number, number], max: [1, 1.01, 1] as [number, number, number] }
  const red = (): ProjectJSON => {
    const p = cargoProject()
    ;(p.scene.parts[0] as SdkPart).params.color = '#e01010'
    return p
  }

  it('counts the crate through a slab it never stood in, by colour, and holds the count after', () => {
    const result = runProjectTest(Jolt, red(), {
      duration: 1.2,
      checks: [
        { eventually: true, probe: { passed: { zone: slab, color: 'red' } }, equals: 1 },
        { at: 1.2, probe: { passed: { zone: slab } }, equals: 1 },
        { always: true, probe: { passed: { zone: slab, color: 'red' } }, max: 1 },
        { always: true, probe: { count: { color: '#e01010' } }, equals: 1 },
        { at: 0.1, probe: { count: { color: 'red', zone: { min: [-1, 2, -1], max: [1, 4, 1] } } }, equals: 1 },
      ],
    })
    expect(result.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([])
  })

  it('never-appeared: a colour no cargo has, and a slab off the path, fail instead of passing max 0', () => {
    const away = { min: [5, 0, 5] as [number, number, number], max: [6, 4, 6] as [number, number, number] }
    const result = runProjectTest(Jolt, red(), {
      duration: 1.2,
      checks: [
        { always: true, probe: { count: { color: 'blue' } }, max: 0 },
        { always: true, probe: { passed: { zone: away, color: 'red' } }, max: 0 },
        { always: true, probe: { passed: { zone: slab, color: 'green' } }, max: 0 },
      ],
    })
    expect(result.checks.map((c) => c.ok)).toEqual([false, false, false])
    expect(result.checks[0]!.detail).toContain('no blue cargo existed')
    expect(result.checks[1]!.detail).toContain('no cargo at all entered its zone')
  })

  it('a check on the colour that did pass fails when it should (negative control)', () => {
    const result = runProjectTest(Jolt, red(), { duration: 1.2, checks: [{ always: true, probe: { passed: { zone: slab, color: 'red' } }, max: 0 }] })
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.detail).toMatch(/^passed\(red, zone .*\) became 1 at t=0\.\d+s \(must always be ≤ 0\)$/)
  })

  it('hands every step to onFrame, after the checks sampled it: where the cargo is, headless', () => {
    const frames: number[] = []
    let last: Readonly<BoxFrame> | null = null
    runProjectTest(Jolt, red(), { duration: 0.5, checks: [{ probe: { count: {} }, at: 0.1, min: 0 }] }, { onFrame: (f) => (frames.push(f.simTime), (last = f)) })
    expect(frames.length).toBe(30) // 0.5 s at 60 Hz
    const rows = cargoRows(last!)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ part: 'c1', kind: 'box', color: '#e01010', colorName: 'red' })
    expect(rows[0]!.pos[1]).toBeLessThan(3)
  })
})
