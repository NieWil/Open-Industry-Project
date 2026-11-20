import type { PackageManifest } from '../core/parts/partPackage'
// The physics step rate as a project setting: what must hold at every rate a project may choose (whole Hz from
// MIN_SIM_HZ to MAX_SIM_HZ), so that picking a rate changes the I/O latency and the sampling resolution and
// nothing else. The range is continuous, so these run at a spread across it (both ends, rates that do not
// divide a second evenly, and the common ones), with the demo cell's acceptance ladder
// (editor/demo/demoAcceptance.ts) and the live gate (e2e/verify-sim-rate.mjs) covering the rest. Why the
// floor is 60 is a measured failure, not a guess: docs/sim-clock.md.
//
// The world tests assert rate-invariance rather than pinning absolute numbers (world.test.ts and
// physicsFidelity.test.ts already pin those at the default rate), so the question here is only whether a
// different step breaks something. The discriminating failure is a half-plumbed rate: a Jolt step, a ctx.dt
// or a simTime still on a hard-coded constant makes cargo travel several times too far per sim-second, far outside
// any tolerance below.

import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { registerPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import { DEFAULT_SIM_HZ, MAX_SIM_HZ, MIN_SIM_HZ, SCENE_VERSION, toSimRate } from '../core/types'
import type { PartInstance, SceneJSON, SdkPart, SimRate } from '../core/types'
import { buildPackage } from './buildPackage'
import { catchUpSteps } from './catchUp'
import { PlcHost } from './plcHost'
import type { PlcWorldPort } from './plcHost'
import { SimWorld } from './world'

const Jolt = await initJolt()
const SLOW = { timeout: 60000 }

/** a spread across the range: both ends, rates that do not divide a second evenly, and the common ones */
const RATES: SimRate[] = [MIN_SIM_HZ, 75, 97, 144, 240, 500, MAX_SIM_HZ]

// the committed conveyor sources, registered exactly as world.test.ts does (the app builds them the same way)
const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage(
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...((manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}
const ROLLER_PKG = loadPkg('roller-conveyor')
const BELT_PKG = loadPkg('belt-conveyor')

// SDK Roller Conveyor: centre origin, so the position is the bed centre
function roller(id: string, length: number, speed: number): SdkPart {
  const p = createSdkPart(ROLLER_PKG, id, [0, 0.75, 0], 0)
  Object.assign(p.params, { length, width: 0.6, speed, leftGuard: false, rightGuard: false })
  return p
}

// SDK Belt Conveyor: tail origin, so a bed centred on x=0 starts at -length/2
function belt(id: string, length: number, speed: number): SdkPart {
  const p = createSdkPart(BELT_PKG, id, [-length / 2, 0.75, 0], 0)
  Object.assign(p.params, { segments: [[length, 0]], width: 0.6, height: 0.5, speed, leftGuard: false, rightGuard: false, legs: false })
  return p
}

function scene(...parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts }
}

/** drop one box on a 3 m bed running at 0.5 m/s, run 3 sim-seconds at `hz`, and report where it went */
function carry(hz: SimRate, bed: 'belt' | 'roller'): { x: number; vx: number; bottom: number } {
  const world = new SimWorld(Jolt, scene(bed === 'belt' ? belt('c1', 3, 0.5) : roller('c1', 3, 0.5)), { hz })
  world.spawnBoxAt(-1.3, 0.97, 0, 0.15, 0.2, 0.15)
  const xs: number[] = []
  let y = 0
  for (let i = 0; i < hz * 3; i++) {
    world.step()
    const f = world.frame()
    expect(f.count).toBe(1)
    xs.push(f.positions[0]!)
    y = f.positions[1]!
  }
  world.dispose()
  const n = xs.length
  // speed over the last ~half second, by position: a step-rate bug shows up here as a multiple of 0.5
  const k = Math.round(hz / 2)
  return { x: xs[n - 1]!, vx: (xs[n - 1]! - xs[n - 1 - k]!) / (k / hz), bottom: y - 0.2 }
}

describe('toSimRate', () => {
  it('passes any whole rate in range', () => {
    for (const hz of [MIN_SIM_HZ, 61, 97, 144, 999, MAX_SIM_HZ]) expect(toSimRate(hz)).toBe(hz)
  })

  it('rounds to whole Hz and clamps into range', () => {
    expect(toSimRate(144.4)).toBe(144)
    expect(toSimRate(144.6)).toBe(145)
    expect(toSimRate(30)).toBe(MIN_SIM_HZ) // inside the band where heavy loads sink (docs/sim-clock.md)
    expect(toSimRate(-60)).toBe(MIN_SIM_HZ)
    expect(toSimRate(5000)).toBe(MAX_SIM_HZ)
  })

  it('reads anything that is not a finite number as the default', () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '120', {}]) expect(toSimRate(bad)).toBe(DEFAULT_SIM_HZ)
  })
})

describe('catchUpSteps (the worker loop cap)', () => {
  it('is the cap the loop always had at the default rate: 3 steps at 1x, 3N at Nx', () => {
    expect(catchUpSteps(1, DEFAULT_SIM_HZ)).toBe(3)
    expect(catchUpSteps(8, DEFAULT_SIM_HZ)).toBe(24)
  })

  it('gives every rate at least the same REAL-time headroom, and never a whole step more', () => {
    for (const hz of RATES) {
      for (const scale of [1, 2, 4, 8]) {
        const steps = catchUpSteps(scale, hz)
        const headroom = (3 * scale) / DEFAULT_SIM_HZ // seconds: 50 ms at 1x
        expect(steps / hz).toBeGreaterThanOrEqual(headroom - 1e-9)
        expect((steps - 1) / hz).toBeLessThan(headroom)
      }
    }
  })

  it('covers a late tick at a fast rate, which a flat cap of 3 would shed as lost real time', () => {
    // one 20 ms gap between 8 ms ticks (a GC pause, a heavy step) needs ceil(20 / step ms) steps
    for (const hz of [240, MAX_SIM_HZ]) expect(catchUpSteps(1, hz)).toBeGreaterThanOrEqual(Math.ceil(20 / (1000 / hz)))
    expect(3).toBeLessThan(Math.ceil(20 / (1000 / 240))) // ...and a flat cap of 3 could not
  })

  it('never drops below 3, so slow motion keeps the original headroom', () => {
    for (const hz of RATES) expect(catchUpSteps(0.5, hz)).toBeGreaterThanOrEqual(3)
  })
})

// a rig part whose only job is to report the ctx.dt it was handed
const DT_PROBE = buildPackage(
  {
    id: 'test.dt-probe',
    name: 'Dt probe',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
        { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
      ],
      joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
    },
  },
  `definePart({ joints: ['j1'], step(ctx) { ctx.writeNumber('Dt', ctx.dt) } })`,
)
registerPackage(DT_PROBE)

describe.each(RATES)('a world stepping at %i Hz', (hz) => {
  it('reports its rate and keeps exact sim time: two seconds is exactly 2 * hz steps', () => {
    const world = new SimWorld(Jolt, scene(), { hz })
    expect(world.hz).toBe(hz)
    for (let i = 0; i < hz * 2; i++) world.step()
    expect(world.frame().simTime).toBe(2)
    world.dispose()
  })

  it('hands every behavior a ctx.dt of exactly one step', () => {
    const probe = { id: 'p', type: 'part', packageId: DT_PROBE.id, position: [0, 0, 0], rotationY: 0, params: {} } as SdkPart
    const world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [probe], packages: [DT_PROBE] }, { hz })
    world.step()
    const dt = Object.values(world.frame().tags ?? {}).find((t) => 'Dt' in t)?.Dt
    expect(dt).toBeCloseTo(1 / hz, 12)
    world.dispose()
  })

  it('carries cargo on a belt at the commanded speed, resting on the deck', SLOW, () => {
    const r = carry(hz, 'belt')
    expect(r.vx).toBeGreaterThan(0.45)
    expect(r.vx).toBeLessThan(0.55)
    expect(r.bottom).toBeGreaterThan(0.75 - 0.06)
    expect(r.bottom).toBeLessThan(0.75 + 0.06)
  })

  it('carries cargo on rollers at the commanded speed', SLOW, () => {
    const r = carry(hz, 'roller')
    expect(r.vx).toBeGreaterThan(0.4)
    expect(r.vx).toBeLessThan(0.6)
  })
})

describe('a different step changes resolution, not behaviour', () => {
  // The same drop, measured at every rate against the default. Pickup is traction-limited and the
  // contact solve differs slightly per step size, so this allows a few centimetres; a rate that is not
  // really reaching the solver (or a stale dt) moves the box metres, not millimetres. Measured:
  // within 0.4 cm from 20 to 1000 Hz. The 60 Hz floor comes from heavy stacks, not light cargo.
  for (const bed of ['belt', 'roller'] as const) {
    it(`cargo on a ${bed} ends up in the same place at every rate`, SLOW, () => {
      const ref = carry(DEFAULT_SIM_HZ, bed)
      for (const hz of RATES) expect(Math.abs(carry(hz, bed).x - ref.x)).toBeLessThan(0.03)
    })
  }
})

/** a stub SimWorld for PlcHost, as plcHost.test.ts drives it: behaviors "wrote" what the test staged */
class StubPort implements PlcWorldPort {
  writes: Record<string, number | boolean> = {}
  pushes: Record<string, number | boolean>[] = []
  // a world whose parts have stepped, so every interleave scans (the hold before the first step has its own test)
  stepCount = 1
  behaviorTagWrites(): Record<string, number | boolean> {
    return { ...this.writes }
  }
  setBehaviorInputTags(tags: Record<string, number | boolean>): void {
    this.pushes.push(tags)
  }
  get held(): Record<string, number | boolean> | undefined {
    return this.pushes[this.pushes.length - 1]
  }
}

const ECHO = 'VAR_INPUT Go : BOOL; END_VAR\nVAR_OUTPUT Run : BOOL; END_VAR\nRun := Go;\n'

describe.each(RATES)('the embedded PLC at %i Hz', (hz) => {
  it('scans at its own period in sim time, whatever the step', () => {
    const host = new PlcHost(ECHO, 0.01)
    const port = new StubPort()
    for (let i = 0; i < hz * 2; i++) host.interleave(port, 1 / hz)
    expect(Math.abs(host.snapshot().scansRun - 200)).toBeLessThanOrEqual(1)
    expect(host.snapshot().overruns).toBe(0)
  })

  it('reacts in exactly one step, so the I/O latency floor is 1 / hz', () => {
    // the point of a faster rate: the scan is already fast (1 ms), and the step is what the output waits on
    const host = new PlcHost(ECHO, 0.001)
    const port = new StubPort()
    host.interleave(port, 1 / hz) // before step 0: Go=false
    expect(port.held!.Run).toBe(false)
    port.writes = { Go: true } // a sensor edge written during step 0
    host.interleave(port, 1 / hz) // before step 1
    expect(port.held!.Run).toBe(true)
  })
})
