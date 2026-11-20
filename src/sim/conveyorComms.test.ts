import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartMaterial, PartPackageGeometry } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import type { SdkPart, PartInstance, SceneJSON } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// Conveyor comms across the five SDK conveyor parts (the belt reads the speed tag and writes the running
// tag from `speed != 0`; roller/curved/spur variants share the pattern). Precedence, per the behaviors' step():
//   1. speedTag (REAL, PLC → part): with the tag set, its value replaces the `speed` param
//      as the commanded speed each step;
//   2. runTag (BOOL, web-only back-compat): the commanded speed is then gated to 0 while false;
//   3. runningTag (BOOL, part → PLC): feedback written every step = effective speed ≠ 0.
// These tests run the real committed behaviors (examples/parts/*) end-to-end through the world, asserting on
// the recorded effective speed (conveyorSpeeds - the same value the spawner interlock and the frame's
// render-scroll seam read) and on the frame's tag writes.

const Jolt = await initJolt()

// The committed first-party sources: the same data the app loads. examples/ is not a source layer, so
// globbing it crosses no import boundary (render/parts/examplePart.ts is the render-side twin; sim tests
// can't import it across the layer wall).
const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

/** build + register the committed part in examples/parts/<dir>; returns its package id */
function registerExample(dir: string): string {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  registerPackage(
    buildPackage(
      { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...((manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) },
      behavior.replace(/\r\n/g, '\n'),
    ),
  )
  return manifest.id
}

/** an instant drive (no accel / decel ramp) unless the params name one: these tests are about what the comms
 *  command, so the effective speed must equal the command on the step it arrives. The ramp has its own block. */
function part(id: string, packageId: string, params: Record<string, unknown>): SdkPart {
  return { id, type: 'part', packageId, position: [0, 2, 0], rotationY: 0, params: { accelTime: 0, decelTime: 0, ...params } } as unknown as SdkPart
}
const scene = (...parts: PartInstance[]): SceneJSON => ({ version: SCENE_VERSION, parts })

/** the effective (behavior-commanded) speed the world recorded: linear m/s, or arc omega rad/s for a curve */
const effectiveSpeed = (w: SimWorld, id: string): number =>
  (w as unknown as { conveyorSpeeds: Map<string, number> }).conveyorSpeeds.get(id) ?? NaN

describe('SDK conveyor comms (speedTag / runTag / runningTag)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('with no tags named the speed param drives the surface velocity', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speed: 1.5 })))
    world.step()
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(1.5, 6)
    expect(world.frame().tags?.b).toBeUndefined() // no runningTag named → no tag write
  })

  it('a speedTag value replaces the speed param as the effective speed (analog setpoint)', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speed: 1.5, speedTag: 'sp' })))
    world.setBehaviorInputTags({ sp: 0.7 })
    world.step()
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(0.7, 6) // not the 1.5 param
    world.setBehaviorInputTags({ sp: -2 })
    world.step()
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(-2, 6) // negative setpoint reverses
    world.setBehaviorInputTags({ sp: 0 })
    world.step()
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(0, 6) // PLC-stopped
  })

  it('runTag still gates (while driven): effective = (speedTag ?? speed) gated by runTag', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(
      Jolt,
      scene(
        part('both', id, { segments: [[4, 0]], speed: 1.5, speedTag: 'sp', runTag: 'run' }),
        part('gateOnly', id, { segments: [[4, 0]], speed: 1.5, runTag: 'run' }),
      ),
    )
    world.setBehaviorDrivenTags(['run']) // a controller owns the gate (output ownership)
    world.setBehaviorInputTags({ sp: 0.7, run: false })
    world.step()
    expect(effectiveSpeed(world, 'both')).toBeCloseTo(0, 6) // run gate overrides the setpoint
    expect(effectiveSpeed(world, 'gateOnly')).toBeCloseTo(0, 6) // shipped-scene behavior unchanged
    world.setBehaviorInputTags({ sp: 0.7, run: true })
    world.step()
    expect(effectiveSpeed(world, 'both')).toBeCloseTo(0.7, 6) // gated setpoint passes through
    expect(effectiveSpeed(world, 'gateOnly')).toBeCloseTo(1.5, 6) // no speedTag → the param, gated
  })

  it('an undriven runTag does not gate - output ownership, so the authored speed still runs the belt', () => {
    // The tag only commands the belt while a controller drives it (ctx.tagDriven), the rule every other comms
    // device follows. Keyed off the tag name, typing a runTag would dead-stop the conveyor until a program
    // attached, with the Inspector still showing a speed that silently does nothing.
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speed: 1.5, runTag: 'run' })))
    world.setBehaviorInputTags({ run: false }) // present in the value table, but nobody drives it
    world.step()
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(1.5, 6) // authored speed applies
    world.setBehaviorDrivenTags(['run']) // a program attaches and owns the gate → it takes over the belt
    world.step()
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(0, 6)
    world.setBehaviorDrivenTags([]) // …and detaches → back to the authored speed
    world.step()
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(1.5, 6)
  })

  it('runningTag is written every step with effective speed ≠ 0 (feedback to the PLC)', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(
      Jolt,
      scene(part('b', id, { segments: [[4, 0]], speed: 1.5, speedTag: 'sp', runTag: 'run', runningTag: 'st' })),
    )
    world.setBehaviorDrivenTags(['run'])
    world.setBehaviorInputTags({ sp: 0.7, run: true })
    world.step()
    expect(world.frame().tags?.b?.st).toBe(true)
    world.setBehaviorInputTags({ sp: 0, run: true })
    world.step()
    expect(world.frame().tags?.b?.st).toBe(false) // zero setpoint → not running
    world.setBehaviorInputTags({ sp: 0.7, run: false })
    world.step()
    expect(world.frame().tags?.b?.st).toBe(false) // run gate stops it → not running
  })

  it('curved conveyor: the speedTag drives the arc omega (setpoint / centreline radius) + feedback', () => {
    const id = registerExample('curved-conveyor')
    const params = { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2, speedTag: 'sp', runningTag: 'st' }
    world = new SimWorld(Jolt, scene(part('c', id, params)))
    const rc = 0.5 + 1.524 / 2
    world.setBehaviorInputTags({ sp: 1 })
    world.step()
    expect(effectiveSpeed(world, 'c')).toBeCloseTo(1 / rc, 6) // omega, not the speed-2 param's 2/rc
    expect(world.frame().tags?.c?.st).toBe(true)
    world.setBehaviorInputTags({ sp: 0 })
    world.step()
    expect(effectiveSpeed(world, 'c')).toBeCloseTo(0, 6)
    expect(world.frame().tags?.c?.st).toBe(false)
  })

  it('curved roller + spur: the same trio holds on the other two function conveyors', () => {
    const cr = registerExample('curved-roller')
    const sp = registerExample('spur-conveyor')
    world = new SimWorld(
      Jolt,
      scene(
        part('cr', cr, { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 1, speedTag: 'v', runningTag: 'st' }),
        { ...part('sp', sp, { length: 2, width: 1.524, speed: 2, speedTag: 'v', runTag: 'run', runningTag: 'st2' }), position: [10, 2, 0] } as SdkPart,
      ),
    )
    const rc = 0.5 + 1.524 / 2
    world.setBehaviorDrivenTags(['run'])
    world.setBehaviorInputTags({ v: 0.5, run: true })
    world.step()
    expect(effectiveSpeed(world, 'cr')).toBeCloseTo(0.5 / rc, 6)
    expect(effectiveSpeed(world, 'sp')).toBeCloseTo(0.5, 6)
    expect(world.frame().tags?.cr?.st).toBe(true)
    expect(world.frame().tags?.sp?.st2).toBe(true)
    world.setBehaviorInputTags({ v: 0.5, run: false })
    world.step()
    expect(effectiveSpeed(world, 'sp')).toBeCloseTo(0, 6) // spur's run gate
    expect(world.frame().tags?.sp?.st2).toBe(false)
  })

  it('roller conveyor (rig geometry): the trio works through the rig deck path', () => {
    const id = registerExample('roller-conveyor')
    world = new SimWorld(
      Jolt,
      scene(part('r', id, { length: 4, width: 1.524, speed: 1, speedTag: 'sp', runTag: 'run', runningTag: 'st' })),
    )
    world.setBehaviorDrivenTags(['run'])
    world.setBehaviorInputTags({ sp: 0.5, run: true })
    world.step()
    expect(effectiveSpeed(world, 'r')).toBeCloseTo(0.5, 6)
    expect(world.frame().tags?.r?.st).toBe(true)
    world.setBehaviorInputTags({ sp: 0.5, run: false })
    world.step()
    expect(effectiveSpeed(world, 'r')).toBeCloseTo(0, 6)
    expect(world.frame().tags?.r?.st).toBe(false)
  })

  it('the frame carries the effective speed (render scroll seam): a tag-stopped belt reports 0', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speed: 1.5, speedTag: 'sp' })))
    world.setBehaviorInputTags({ sp: 0.7 })
    world.step()
    expect(world.frame().conveyorSpeeds?.b).toBeCloseTo(0.7, 6) // the PLC setpoint, not the 1.5 param
    world.setBehaviorInputTags({ sp: 0 })
    world.step()
    expect(world.frame().conveyorSpeeds?.b).toBeCloseTo(0, 6) // the fabric scroll must stop with it
  })
})

// The drive a plant program talks to (examples/parts/_shared/conveyorUnits.js, conveyorDrive.js): a speed reference in feet per minute (a REAL),
// the drive's output read back as a frequency, and an encoder to count. All six conveyors carry it.
describe('SDK conveyor drive comms (FPM units / velocity / pulse)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })
  const FPM = 0.00508

  it('a part whose params never heard of the switch stays in m/s; a part that carries it on is in feet per minute', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(
      Jolt,
      scene(
        part('old', id, { segments: [[4, 0]], speed: 1.5, speedTag: 'sp' }), // saved before the switch existed
        part('fpm', id, { segments: [[4, 0]], fpmUnits: true, speed: 1.5, speedFpm: 200 }),
        part('cmd', id, { segments: [[4, 0]], fpmUnits: true, speedFpm: 200, speedFpmTag: 'ref', speedTag: 'sp' }),
      ),
    )
    world.setBehaviorInputTags({ sp: 0.7, ref: 300 })
    world.step()
    expect(effectiveSpeed(world, 'old')).toBeCloseTo(0.7, 6) // its REAL m/s tag, exactly as before
    expect(effectiveSpeed(world, 'fpm')).toBeCloseTo(200 * FPM, 6) // the FPM field, not the m/s one beside it
    expect(effectiveSpeed(world, 'cmd')).toBeCloseTo(300 * FPM, 6) // the FPM reference; the m/s tag is not its tag
  })

  it('velocity is the effective speed as a share of the speed at 30 revolutions, times 30 - in either unit', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(
      Jolt,
      scene(
        part('ms', id, { segments: [[4, 0]], fpmUnits: false, speed: 2, speedAt30: 2, velocityTag: 'v' }),
        part('half', id, { segments: [[4, 0]], fpmUnits: true, speedFpm: 100, speedAt30Fpm: 200, velocityTag: 'v', runTag: 'run' }),
      ),
    )
    world.step()
    expect(world.frame().tags?.ms?.v).toBeCloseTo(30, 6) // commanded 2 m/s, 2 m/s at 30: it reads 30
    expect(world.frame().tags?.half?.v).toBeCloseTo(15, 6)
    world.setBehaviorDrivenTags(['run'])
    world.setBehaviorInputTags({ run: false })
    world.step()
    expect(world.frame().tags?.half?.v).toBe(0) // held still by its run tag: the drive is not turning
  })

  it('the pulse is TRUE for one step each time the surface has travelled the inches asked for', () => {
    const id = registerExample('belt-conveyor')
    // 240 steps a second, 100 FPM = 20 in/s: a twelfth of an inch a step, so an inch is every 12th step
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], fpmUnits: true, speedFpm: 100, pulseTag: 'p' }), part('two', id, { segments: [[4, 0]], fpmUnits: true, speedFpm: -100, inchesPerPulse: 2, pulseTag: 'p' })), { hz: 240 })
    const seen: boolean[] = []
    let two = 0
    for (let k = 0; k < 240; k++) {
      world.step()
      seen.push(world.frame().tags?.b?.p === true)
      if (world.frame().tags?.two?.p === true) two++
    }
    expect(seen.filter(Boolean).length).toBe(20) // a second at 20 in/s
    expect(seen.some((p, k) => p && seen[k + 1] === true)).toBe(false) // one step high, never two running
    expect(two).toBe(10) // every two inches; running backwards still counts travel
  })

  it('every conveyor carries the same drive comms', () => {
    for (const dir of ['belt-conveyor', 'roller-conveyor', 'curved-conveyor', 'curved-roller', 'spur-conveyor', 'spur-roller-conveyor']) {
      const id = registerExample(dir)
      world = new SimWorld(Jolt, scene(part('c', id, { fpmUnits: true, speedFpm: 200, speedAt30Fpm: 400, velocityTag: 'v', pulseTag: 'p' })), { hz: 240 })
      let pulses = 0
      for (let k = 0; k < 240; k++) {
        world.step()
        if (world.frame().tags?.c?.p === true) pulses++
      }
      expect(world.frame().tags?.c?.v, dir).toBeCloseTo(15, 6)
      expect(pulses, dir).toBe(40) // 200 FPM is 40 in/s
      world.dispose()
      world = null
      clearPackages()
    }
  })
})

// The drive's ramp (examples/parts/_shared/conveyorDrive.js rampedSpeed): a conveyor on a VFD reaches its command at a rate,
// rated speed (the speed that reads 30) over the accel / decel time, and everything that reads the surface reads the
// ramped speed. 60 steps a second throughout, so a 0.5 s ramp to a 2 m/s rated speed is 1/15 m/s a step. A ramp from
// rest needs a program to start the conveyor (here a speed tag): one on its authored speed is running from step one.
describe('SDK conveyor drive ramp (accelTime / decelTime)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })
  const steps = (w: SimWorld, n: number): void => {
    for (let k = 0; k < n; k++) w.step()
  }

  it('accelerates from stopped to the command in the accel time, and runs on it after', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speedAt30: 2, accelTime: 0.5, decelTime: 0.5, speedTag: 'sp' })))
    world.setBehaviorInputTags({ sp: 2 })
    steps(world, 15) // a quarter second: half way
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(1, 6)
    steps(world, 15)
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(2, 6)
    steps(world, 5)
    expect(effectiveSpeed(world, 'b')).toBe(2) // snapped onto it exactly, no overshoot
  })

  it('the rate is fixed by the rated speed, so a smaller command gets there sooner', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speedAt30: 2, accelTime: 0.5, decelTime: 0.5, speedTag: 'sp' })))
    world.setBehaviorInputTags({ sp: 1 })
    steps(world, 15) // 0.25 s at 4 m/s^2 is 1 m/s: there already
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(1, 6)
  })

  it('a run tag stop decelerates over the decel time, and the running tag stays TRUE until it has stopped', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speed: 2, speedAt30: 2, accelTime: 0, decelTime: 1, runTag: 'run', runningTag: 'on' })))
    world.step()
    expect(effectiveSpeed(world, 'b')).toBe(2) // nothing drives the gate yet: running at its authored speed
    world.setBehaviorDrivenTags(['run'])
    world.setBehaviorInputTags({ run: false })
    steps(world, 30)
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(1, 6) // half a second of a one-second ramp down
    expect(world.frame().tags?.b?.on).toBe(true) // still moving: the drive has not stopped yet
    steps(world, 30)
    expect(effectiveSpeed(world, 'b')).toBe(0)
    expect(world.frame().tags?.b?.on).toBe(false)
  })

  it('a reversal runs down to 0 at the decel rate, then up the other way at the accel rate', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speed: 2, speedAt30: 2, accelTime: 0.5, decelTime: 0.25, speedTag: 'sp' })))
    world.setBehaviorInputTags({ sp: 2 })
    steps(world, 30)
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(2, 6)
    world.setBehaviorInputTags({ sp: -2 })
    steps(world, 15) // 0.25 s down at 8 m/s^2
    expect(effectiveSpeed(world, 'b')).toBeCloseTo(0, 6)
    steps(world, 15) // 0.25 s up the other way at 4 m/s^2 (give or take the step the crossing falls on)
    expect(effectiveSpeed(world, 'b')).toBeLessThan(-1 + 0.07)
    expect(effectiveSpeed(world, 'b')).toBeGreaterThanOrEqual(-1)
  })

  it('the encoder counts the ramped travel, not the command', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speedAt30: 2, accelTime: 0.5, decelTime: 0.5, speedTag: 'sp', encoderTag: 'enc' })))
    world.setBehaviorInputTags({ sp: 2 })
    steps(world, 30)
    // a linear ramp to 2 m/s over 0.5 s covers 0.5 m (to within a step's worth of the sum's rectangles)
    expect(world.frame().tags?.b?.enc as number).toBeGreaterThan(0.5)
    expect(world.frame().tags?.b?.enc as number).toBeLessThan(0.5 + 2 / 60)
  })

  it('0 is an instant drive, as before the ramp', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(Jolt, scene(part('b', id, { segments: [[4, 0]], speedTag: 'sp' })))
    world.setBehaviorInputTags({ sp: -1.5 })
    world.step()
    expect(effectiveSpeed(world, 'b')).toBe(-1.5)
  })

  it('at Play, a conveyor on its authored speed is already running: nothing started it', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(
      Jolt,
      scene(
        part('plain', id, { segments: [[4, 0]], speed: 2, accelTime: 0.5, decelTime: 0.5 }),
        // a run tag typed in but driven by nobody does not own the conveyor, so this one is running too
        part('typed', id, { segments: [[4, 0]], speed: 2, accelTime: 0.5, decelTime: 0.5, runTag: 'run' }),
      ),
    )
    world.step()
    expect(effectiveSpeed(world, 'plain')).toBe(2)
    expect(effectiveSpeed(world, 'typed')).toBe(2)
  })

  it('at Play, a conveyor a program owns starts from rest: the program is starting the line', () => {
    const id = registerExample('belt-conveyor')
    world = new SimWorld(
      Jolt,
      scene(
        part('gated', id, { segments: [[4, 0]], speed: 2, speedAt30: 2, accelTime: 0.5, decelTime: 0.5, runTag: 'run' }),
        part('commanded', id, { segments: [[4, 0]], speedAt30: 2, accelTime: 0.5, decelTime: 0.5, speedTag: 'sp' }),
      ),
    )
    world.setBehaviorDrivenTags(['run', 'sp'])
    world.setBehaviorInputTags({ run: true, sp: 2 })
    world.step()
    expect(effectiveSpeed(world, 'gated')).toBeCloseTo(2 / 30, 6) // one step of a 0.5 s ramp
    expect(effectiveSpeed(world, 'commanded')).toBeCloseTo(2 / 30, 6)
  })

  it('every conveyor ramps, belts at 0.5 s and rollers at 0.2 s by default', () => {
    const cases: [string, number][] = [
      ['belt-conveyor', 0.5],
      ['curved-conveyor', 0.5],
      ['spur-conveyor', 0.5],
      ['roller-conveyor', 0.2],
      ['curved-roller', 0.2],
      ['spur-roller-conveyor', 0.2],
    ]
    for (const [dir, t] of cases) {
      const id = registerExample(dir)
      // the bare params: only the speeds, so the ramp is each part's default
      world = new SimWorld(Jolt, scene({ id: 'c', type: 'part', packageId: id, position: [0, 2, 0], rotationY: 0, params: { fpmUnits: false, speedAt30: 1, speedTag: 'sp', velocityTag: 'v' } } as unknown as SdkPart))
      world.setBehaviorInputTags({ sp: 1 })
      steps(world, Math.round((t * 60) / 2)) // half the ramp: half the rated speed, which reads 15
      expect(world.frame().tags?.c?.v as number, dir).toBeCloseTo(15, 4)
      steps(world, Math.round((t * 60) / 2) + 1)
      expect(world.frame().tags?.c?.v as number, dir).toBeCloseTo(30, 6)
      world.dispose()
      world = null
      clearPackages()
    }
  })
})
