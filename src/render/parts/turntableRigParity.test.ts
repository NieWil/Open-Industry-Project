import { describe, expect, it } from 'vitest'
import { resolvedBoxSize, resolvedCylinder, resolvedOffset } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { instantiatePartScript, resolvePartParams } from '../../core/parts/partScript'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import type { ParamValue } from '../../core/parts/partApi'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: TURNTABLE_RIG, behavior: TURNTABLE_BEHAVIOR } = examplePart<RigGeo>('oip.turntable-conveyor')

// The Turntable, authored as a custom part (examples/parts/turntable-conveyor), is the 3rd converged conveyor:
// rotate → align → convey. This pins the rig - a width-parametric deck
// disc on a continuous revolute Y 'rotate' joint, a hidden `conveys` lane box on top (the cargo surface),
// decorative drum + rollers that rotate with the deck, static legs - and the committed behavior's slew/convey
// logic: shortest-path ±180° wrap, convey-only-when-settled along the deck's current yaw, the angle/speed/
// done tags, and the one-shot angle-tag seed write.

const geo = TURNTABLE_RIG
const link = (name: string) => geo.links.find((l) => l.name === name)!
const D2R = Math.PI / 180
// the round roller bed geometry() draws on the deck's 'roller' frame (examples/parts/_shared/rollerBed.js + the turntable's
// own frames and bolt ring), at a lane width
const bed = (width = 1.524): MeshPart[] => {
  const parts = evalPartGeometry(TURNTABLE_BEHAVIOR, { width } as never)
  if (!parts) throw new Error('turntable geometry() returned no parts')
  return parts
}
const ROLLER_TEMPLATE_BODY = 2 * 0.9371 // the kit's tube, rim to rim, in its native units

describe('Turntable custom-part rig - rotating kinematic deck + conveying lane', () => {
  it('is a structurally valid package (rig + the slew behavior)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.turntable-conveyor', name: 'Turntable', params: {}, behavior: "definePart({ joints:['rotate'], step(ctx){ ctx.joints.rotate = 0 } })", geometry: geo })).toEqual([])
  })

  it('the deck is a width-parametric disc on a single continuous revolute Y rotate joint', () => {
    expect(geo.joints).toHaveLength(1)
    expect(geo.joints[0]!.name).toBe('rotate')
    expect(geo.joints[0]!.type).toBe('revolute')
    expect(geo.joints[0]!.axis).toEqual([0, 1, 0])
    // continuous revolute: the behavior keeps the command wrapped in (−180°, 180°], so the joint limits must
    // span the full wrap range
    expect(geo.joints[0]!.min).toBeLessThanOrEqual(-Math.PI + 1e-9)
    expect(geo.joints[0]!.max).toBeGreaterThanOrEqual(Math.PI - 1e-9)
    const deck = link('deck')
    expect(deck.shape.kind).toBe('cylinder')
    expect(deck.collision).not.toBe('none') // a REAL kinematic body - cargo off the lane is friction-carried on it
    if (deck.shape.kind !== 'cylinder') throw new Error('deck is not a cylinder')
    // disc radius tracks width (× PLATE_FACTOR/2 = 0.75): width 1 → r 0.75, width 2 → r 1.5
    expect(resolvedCylinder(deck.shape, { width: 1 }).radius).toBeCloseTo(0.75, 6)
    expect(resolvedCylinder(deck.shape, { width: 2 }).radius).toBeCloseTo(1.5, 6)
  })

  it('a hidden `conveys` cross is the cargo surface: rim to rim on both axes, top at the part origin', () => {
    const lane = link('lane')
    expect(lane.conveys).toBe(true) // the sim builds it as a static conveyor body the behavior steers
    expect(lane.hidden).toBe(true) // physics-only - the visible bed is the deck disc + roller GLBs
    expect(lane.parent).toBeUndefined() // root-level: a conveys body never rotates with the deck joint
    expect(lane.shape.kind).toBe('box')
    if (lane.shape.kind !== 'box') throw new Error('lane is not a box')
    // the lane arm spans the plate diameter along the travel axis and the lane width across it
    expect(lane.shape.sizeParams).toEqual(expect.arrayContaining([expect.objectContaining({ axis: 0, param: 'width', scale: 1.5 }), expect.objectContaining({ axis: 2, param: 'width' })]))
    // top face at y = 0: the SDK conveyor cargo datum (offset −thickness/2)
    expect(lane.offset[1] + lane.shape.size[1] / 2).toBeCloseTo(0, 6)
    // ...and the two cross-arm pieces carry the same datum, so a turned route is supported like a straight one
    for (const cap of [link('laneCapLeft'), link('laneCapRight')]) {
      expect(cap.conveys).toBe(true)
      expect(cap.hidden).toBe(true)
      expect(cap.parent).toBeUndefined()
      if (cap.shape.kind !== 'box') throw new Error('lane cap is not a box')
      expect(cap.offset[1] + cap.shape.size[1] / 2).toBeCloseTo(0, 6)
    }
  })

  // The main regression this file guards. A neighbour butts the plate rim (conveyorLocalEnds returns ±radius
  // for a rotating deck), the roller fan is drawn to the rim, and conveyingSurfaceAt reports a flat surface
  // over the whole platter, so the conveying bodies have to reach the rim too. A width×width square lane
  // would not: a 0.25·width band inside the rim would have no collider at the datum, with the deck plate
  // 72 mm below as the next thing down. A 0.4 m case would drop into it, tilt 17° and jam there; a pallet
  // long enough to bridge it would hop over the lane's 60 mm lip. Walk the datum out from the
  // pivot along both axes (the deck turns, so the outfeed seam is as real as the infeed one) and require
  // unbroken cover to the rim.
  it('the conveying surface reaches the plate rim on both axes with no gap at the cargo datum', () => {
    for (const width of [0.6, 1.524, 2.4]) {
      const radius = (width * 1.5) / 2
      // every conveying box as a part-local XZ rect, resolved at this width
      const rects = geo.links.filter((l) => l.conveys && l.shape.kind === 'box').map((l) => {
        if (l.shape.kind !== 'box') throw new Error('unreachable')
        const size = resolvedBoxSize(l.shape.size, l.shape.sizeParams, { width })
        const off = resolvedOffset(l.offset, l.offsetParams, { width })
        return { x0: off[0] - size[0] / 2, x1: off[0] + size[0] / 2, z0: off[2] - size[2] / 2, z1: off[2] + size[2] / 2, top: off[1] + size[1] / 2 }
      })
      expect(rects.every((r) => Math.abs(r.top) < 1e-9)).toBe(true) // one datum plane, or cargo steps between them
      const covered = (x: number, z: number) => rects.some((r) => x >= r.x0 - 1e-9 && x <= r.x1 + 1e-9 && z >= r.z0 - 1e-9 && z <= r.z1 + 1e-9)
      for (let i = 0; i <= 200; i++) {
        const d = (radius * i) / 200
        expect(covered(d, 0)).toBe(true)   // out to the +x rim (the home infeed/outfeed seam)
        expect(covered(-d, 0)).toBe(true)  // and the −x one
        expect(covered(0, d)).toBe(true)   // the cross axis, where a 90° index hands the load over
        expect(covered(0, -d)).toBe(true)
      }
      // and it stops ON the rim: past it is the neighbour's own deck, and two coplanar conveyor bodies
      // fighting one contact is the bug this shape avoids.
      expect(covered(radius + 0.01, 0)).toBe(false)
      expect(covered(0, radius + 0.01)).toBe(false)
    }
  })

  it('the deck disc top sits below the lane surface (the static lane owns the cargo contact)', () => {
    const deck = link('deck')
    if (deck.shape.kind !== 'cylinder') throw new Error('deck is not a cylinder')
    // coplanar tops would fight for the contact (sim/rigBuild.ts buildRigBodies note); built-in plate-below-datum parity
    expect(deck.offset[1] + deck.shape.height / 2).toBeLessThan(-1e-3)
  })

  it('the drum + round roller bed ride the deck (rotate with it) and are decorative', () => {
    expect(link('drum').parent).toBe('deck') // a child of the deck → rotates with it
    expect(link('drum').collision).toBe('none') // decorative; the lane is the surface
    const roller = link('roller')
    expect(roller.parent).toBe('deck') // rides the deck
    expect(roller.shape.kind).toBe('frame') // transform-only: no sim body, no drawing of its own
    expect(roller.array).toBeUndefined()
    // a round roller deck (circular-clip parity), drawn by geometry() on that frame: the rollers fan the full plate
    // at the heavy duty class (radius 0.04, pitch 0.13), each chord-clipped to the plate circle - long across the
    // lane, tapering to the rim - not a straight linear lane
    const parts = bed()
    for (const p of parts) expect(p.link).toBe('roller') // every piece rides the deck
    const tubes = parts.find((p) => p.finish === 'roller' && p.instances)!
    expect(tubes.spin).toEqual({ axis: [0, 0, -1], radius: 0.04, speed: 'rollerSpeed' })
    const xs = tubes.instances!.map((i) => i.position[0])
    const lens = tubes.instances!.map((i) => i.scale![2] * ROLLER_TEMPLATE_BODY)
    const width = 1.524, rBed = (width * 1.5) / 2 - 0.06
    for (let i = 0; i < xs.length; i++) {
      expect(Math.round(xs[i]! / 0.13) * 0.13).toBeCloseTo(xs[i]!, 9) // on the pitch
      expect(lens[i]! / 2).toBeCloseTo(Math.min(width / 2, Math.sqrt(rBed * rBed - xs[i]! * xs[i]!)), 9) // chord-clipped
    }
    expect(Math.max(...lens)).toBeCloseTo(width, 9) // the middle rollers span the lane
    expect(Math.min(...lens)).toBeLessThan(width / 2) // the rim rollers taper
    // the deck plate top sits at −1.8·radius so the heavy rollers (top at the y=0 datum) sit proud, not sunken -
    // the roller group is offset back up to the datum (cancelling the deck's own drop) so its bed sits there.
    const deck = link('deck')
    if (deck.shape.kind !== 'cylinder') throw new Error('deck is not a cylinder')
    expect(deck.offset[1] + deck.shape.height / 2).toBeCloseTo(-1.8 * 0.04, 6) // plate top = _plate_top_y(heavy)
    expect(roller.offset[1]).toBeCloseTo(-deck.offset[1], 6) // roller group returns to the y=0 cargo datum
  })

  it('the legs are static root-level poles that auto-extend to the floor (standHeight) with a decorative foot plate', () => {
    for (const n of ['leg0', 'leg1', 'leg2', 'leg3']) {
      const l = link(n)
      expect(l.parent).toBeUndefined() // root link, not parented to the spinning deck
      expect(l.collision).not.toBe('none') // a real static collision body
      if (l.shape.kind !== 'box') throw new Error('leg is not a box')
      // the pole length + centre track standHeight so raising the deck regrows the leg down to the surface
      expect(l.shape.sizeParams).toEqual(expect.arrayContaining([expect.objectContaining({ axis: 1, param: 'standHeight' })]))
      expect(l.offsetParams).toEqual(expect.arrayContaining([expect.objectContaining({ axis: 1, param: 'standHeight' })]))
    }
    for (const n of ['foot0', 'foot1', 'foot2', 'foot3']) {
      const f = link(n)
      expect(f.parent).toBeUndefined() // static, like its pole
      expect(f.collision).toBe('none') // the pole owns the collision; the plate is decorative
      expect(f.offsetParams).toEqual(expect.arrayContaining([expect.objectContaining({ axis: 1, param: 'standHeight' })])) // foot rides the floor
    }
  })

  it('declares a standHeight param (rest: surfaceBelow) so the host regrows the legs to the floor when raised', () => {
    const { def } = instantiatePartScript(TURNTABLE_BEHAVIOR)
    if (!def?.params) throw new Error('behavior failed to instantiate')
    expect(def.params.standHeight).toMatchObject({ type: 'number', rest: 'surfaceBelow' })
  })

  it('the round-bed side frames + gearmotor ride the deck (built-in parity) and are decorative', () => {
    // the side-frame rails + tapered-roller end brackets are drawn with the roller bed by geometry(), so they stay
    // aligned with the chord-clipped fan at every width - there are no standalone rail links
    expect(link('railL')).toBeUndefined()
    expect(link('railR')).toBeUndefined()
    for (const width of [0.6, 1.524, 2.4]) {
      const parts = bed(width)
      const frames = parts.find((p) => p.finish === 'frame')!
      const tubes = parts.find((p) => p.finish === 'roller' && p.instances)!
      const tapered = tubes.instances!.filter((i) => i.scale![2] * ROLLER_TEMPLATE_BODY < width - 0.02).length
      expect(frames.instances!.length).toBe(2 + 2 * tapered) // two side rails + a bracket at each end of a tapered roller
      expect(parts.find((p) => p.finish === 'bolt')!.instances!.length).toBeGreaterThanOrEqual(8) // the rim bolt ring
    }
    // the motor block: a transform-only pivot on the deck (tracks the lane edge) parenting the gearmotor pieces
    const pivot = link('motorPivot')
    expect(pivot.parent).toBe('deck')
    expect(pivot.shape.kind).toBe('frame') // no geometry/body - a grouping pivot
    expect(pivot.offsetParams).toEqual(expect.arrayContaining([expect.objectContaining({ axis: 2, param: 'width' })])) // z = width/2 + edge
    for (const n of ['mPocket', 'mGearbox', 'mHousing', 'mShaft', 'mAdapter', 'mBody', 'mEndBell', 'mCowl', 'mTerminal']) expect(link(n).parent).toBe('motorPivot')
    const pieces = geo.links.filter((l) => l.parent === 'motorPivot')
    expect(pieces.some((l) => l.name.startsWith('mFin'))).toBe(true)
    for (const piece of pieces) {
      expect(piece.name.startsWith('m')).toBe(true) // rides the pivot → rides the deck
      expect(piece.collision).toBe('none') // cosmetic
      // every piece scales with the lane width, so a narrow turntable's motor stays on its plate
      expect(piece.offsetParams?.some((p) => p.param === 'width')).toBe(true)
    }
  })

  it('the slew drive: a ring gear that turns with the deck, and a fixed base + gearmotor that do not', () => {
    for (const n of ['slewRing', 'slewRingWeb']) expect(link(n).parent).toBe('deck')
    for (const n of ['baseBeamA', 'baseBeamB', 'slewArm', 'slewPinion', 'slewGearbox', 'slewMotor', 'slewCowl', 'slewGrille']) {
      expect(link(n).parent).toBeUndefined() // root-level: the fixed base does not rotate
      expect(link(n).collision).toBe('none')
      // hangs from the drum bottom and rides up on a low stand instead of reaching the floor
      expect(link(n).offsetParams).toEqual(expect.arrayContaining([expect.objectContaining({ axis: 1, param: 'standHeight' })]))
    }
  })
})

// ---- behavior logic, driven from the real committed source ------------------------------------------------
// A minimal PartContext mock over core/parts/partScript (the one compile chokepoint): enough surface for the
// turntable behavior - params, dt, the joints bag, tag reads/writes, and the two surface-velocity commands.

interface Tick {
  joint: number | undefined
  sv: { x: number; y: number; z: number } | null
  arc: { center: { x: number; z: number }; omega: number } | null
  tags: Record<string, number | boolean>
  /** the deck gripper's commanded state this tick - the platter holding its load through a turn */
  gripped: boolean
}

function turntable(overrides: Record<string, ParamValue>, tags: Record<string, number | boolean>) {
  const { def, error } = instantiatePartScript(TURNTABLE_BEHAVIOR)
  if (!def) throw new Error(error)
  const params = resolvePartParams(def.params, overrides)
  const joints: Record<string, number> = {}
  // the deck gripper: the platter holds its load for the duration of a turn, so it arrives at exactly the
  // deck angle instead of at whatever the friction drive delivered (see the behavior's carry note)
  const grips: Record<string, boolean> = {}
  let sv: Tick['sv'] = null
  let arc: Tick['arc'] = null
  let out: Tick['tags'] = {}
  const ctx = {
    dt: 1 / 60,
    simTime: 0,
    params,
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 1, y: 0, z: 0 }, // part yaw 0: forward = world +X
    joints,
    grips,
    measured: { joints: {}, grips: {} },
    readTag: (n: string) => { const v = tags[n]; return typeof v === 'number' ? v !== 0 : v === true },
    // a tag the test sets stands for a program driving it (an enable tag counts only while driven)
    tagDriven: (n: string) => n in tags,
    readNumber: (n: string) => { const v = tags[n]; return typeof v === 'number' ? v : v === true ? 1 : 0 },
    writeTag: (n: string, v: boolean) => { out[n] = v === true },
    writeNumber: (n: string, v: number) => { out[n] = v },
    // ctx.report publishes the effective param values for the Inspector readout; it drives no motion, so
    // this harness only has to accept it (the reported numbers are asserted in setpoints.test.ts).
    report: () => {},
    setSurfaceVelocity: (v: { x: number; y: number; z: number }) => { sv = v },
    setArcSurfaceVelocity: (a: { center: { x: number; z: number }; omega: number }) => { arc = a },
  }
  const step = (): Tick => {
    sv = null
    arc = null
    out = {}
    def.step!(ctx as never)
    ctx.simTime += ctx.dt
    return { joint: joints.rotate, sv, arc, tags: out, gripped: grips.deck === true }
  }
  return { step }
}

describe('Turntable behavior - slew + convey (the committed behavior source)', () => {
  it('wraps the slew delta to ±180°: commanded 350° from 0 takes the −10° path (shortest-path wrap)', () => {
    const t = turntable({ angleTag: 'tt.angle', doneTag: 'tt.done' }, { 'tt.angle': 350 })
    t.step() // seed tick: target = current angle (0) → settled, tag seeded
    const arm = t.step() // first PLC-commanded tick: the deck grips its load and holds still for one tick
    expect(arm.gripped).toBe(true)
    expect(arm.joint!).toBe(0) // …so the host captures the load at the angle the deck is actually at
    let tick = t.step() // motion starts here
    expect(tick.joint!).toBeLessThan(0) // slews negative - the −10° road, not +350
    let lo = tick.joint!
    let hi = tick.joint!
    for (let i = 0; i < 60 && tick.tags['tt.done'] !== true; i++) {
      tick = t.step()
      lo = Math.min(lo, tick.joint!)
      hi = Math.max(hi, tick.joint!)
    }
    expect(tick.tags['tt.done']).toBe(true) // settled well inside the 1 s cap (10° at 45°/s)
    expect(tick.joint!).toBeCloseTo(-10 * D2R, 6) // parked at −10° ≡ 350°
    expect(lo).toBeGreaterThan(-10.001 * D2R) // never overshot …
    expect(hi).toBeLessThan(1e-9) // … and never tried the +350° way
  })

  it('conveys only when settled: the slew holds linear velocity at 0 and spins the platter (arc) instead', () => {
    const t = turntable({ angleTag: 'a', doneTag: 'd' }, { a: 90 })
    const seedTick = t.step() // settled at 0 (target seeds from the current angle) → conveying along +X
    expect(seedTick.arc).toBeNull()
    expect(seedTick.sv!.x).toBeCloseTo(1, 6) // default speed 1 m/s along the deck forward (= part +X at 0°)
    expect(seedTick.sv!.z).toBeCloseTo(0, 6)
    // slewing to 90°: no linear convey. The arc field describes what the plate is doing, and is the fallback
    // for anything the deck grip did not take (cargo that landed mid-turn) - so on the arming tick, with the
    // grip closing and the deck still standing still, it is zero.
    let tick = t.step()
    expect(tick.sv).toBeNull() // linear velocity held at 0 (gd hold-until-aligned)
    expect(tick.arc).not.toBeNull()
    expect(tick.arc!.omega).toBe(0) // arming: gripped, but the deck has not moved yet
    expect(tick.arc!.center).toEqual({ x: 0, z: 0 }) // about the part origin (the pivot)
    // …and then the drive ramps, the way a VFD given an acceleration time does. No real deck reaches full
    // speed in one tick, and an instant start tears the load loose before the deck grips it
    const ramp = [t.step().arc!.omega, t.step().arc!.omega, t.step().arc!.omega]
    expect(ramp[0]!).toBeGreaterThan(0)
    expect(ramp[1]!).toBeGreaterThan(ramp[0]!)
    expect(ramp[2]!).toBeGreaterThan(ramp[1]!)
    expect(ramp[2]!).toBeLessThan(20 * D2R) // still climbing toward the 20°/s top rate, not there yet
    for (let i = 0; i < 600 && tick.tags.d !== true; i++) tick = t.step()
    expect(tick.tags.d).toBe(true)
    // settled at 90°: linear convey resumes, along the deck's current forward (+X rotated 90° → −Z)
    expect(tick.arc).toBeNull()
    expect(tick.joint!).toBeCloseTo(90 * D2R, 6)
    expect(tick.sv!.x).toBeCloseTo(0, 6)
    expect(tick.sv!.z).toBeCloseTo(-1, 6)
  })

  it('speedTag (REAL) overrides the speed param for the conveyed velocity (gd speed tag)', () => {
    const tags: Record<string, number | boolean> = { a: 0, s: 2.5 }
    const t = turntable({ angleTag: 'a', speedTag: 's', speed: 1 }, tags)
    const first = t.step() // settled at 0 from the start → conveying
    expect(first.sv!.x).toBeCloseTo(2.5, 6) // the tag, not the 1 m/s param
    tags.s = -1.5 // PLC reverses the rollers
    expect(t.step().sv!.x).toBeCloseTo(-1.5, 6)
  })

  it('seeds the angle tag once at sim start with the current target (gd tag-group init), then read-only', () => {
    const t = turntable({ angleTag: 'a', doneTag: 'd' }, { a: 0 })
    const first = t.step()
    expect(first.tags.a).toBe(0) // the one-shot seed write (a REAL, the current target angle)
    const second = t.step()
    expect('a' in second.tags).toBe(false) // never written again - only the done tag from here on
    expect(second.tags.d).toBe(true)
  })

  it('default (no tags named): slews to the manual deckAngleDeg and holds there (built-in parity)', () => {
    const t = turntable({ deckAngleDeg: 45, rotationSpeedDeg: 90 }, {})
    let tick = t.step()
    for (let i = 0; i < 120; i++) tick = t.step() // 90°/s reaches 45° in 0.5 s, well inside 2 s
    expect(tick.joint!).toBeCloseTo(45 * D2R, 6) // parked at the authored angle, not an auto-cycled stop
    // parked = conveying along the rotated deck forward (+X rotated 45°), not the arc-slew field
    expect(tick.arc).toBeNull()
    expect(tick.sv!.x).toBeCloseTo(Math.cos(45 * D2R), 6)
    expect(tick.sv!.z).toBeCloseTo(-Math.sin(45 * D2R), 6)
    // and it holds - a second on it is still 45°, never advancing to a second stop (no self-run)
    for (let i = 0; i < 60; i++) tick = t.step()
    expect(tick.joint!).toBeCloseTo(45 * D2R, 6)
  })

  it('a placed turntable at the defaults sits still (deckAngleDeg 0): no auto-rotation, and never grips', () => {
    const t = turntable({ rotationSpeedDeg: 90 }, {}) // all defaults
    let hi = 0
    let everGripped = false
    for (let i = 0; i < 120; i++) {
      const tick = t.step()
      hi = Math.max(hi, Math.abs(tick.joint ?? 0))
      everGripped = everGripped || tick.gripped
    }
    expect(hi).toBeCloseTo(0, 6) // never turns - a straight cross-feed until commanded, like the built-in
    // a parked plate must not seize what is riding across it: the grip exists only for the turn
    expect(everGripped).toBe(false)
  })

  // The carry. A real turntable holds its load in static contact and hands it over at exactly the deck
  // angle; dragging cargo with a surface-velocity field commands a rate, so slip integrates into the final
  // angle and is never corrected (measured: the same pallet 0.7° out one cycle, 4° the next, and on a bare
  // plate it sometimes stopped tracking entirely). Both ends of the turn are pinned here because getting
  // either wrong adds a step of skew: closing the grip a tick late bakes in one step of rotation, and
  // releasing a tick early drops the load before the final pose is driven onto it.
  it('carries its load: grips one tick before the first move, stays held through the landing tick, then lets go', () => {
    const t = turntable({ deckAngleDeg: 90, rotationSpeedDeg: 45 }, {})
    const arm = t.step()
    expect(arm.gripped).toBe(true) // the grip closes…
    expect(arm.joint!).toBe(0) //     …while the deck is still at its start angle
    const first = t.step()
    expect(first.gripped).toBe(true)
    expect(first.joint!).toBeGreaterThan(0) // only now does it turn, with the load already captured

    let tick = first
    for (let i = 0; i < 900 && tick.joint! < 90 * D2R - 1e-9; i++) tick = t.step()
    expect(tick.joint!).toBeCloseTo(90 * D2R, 9) // landed on the commanded angle
    expect(tick.gripped).toBe(true) // still held on the landing tick, so that pose reaches the load
    expect(tick.tags).toEqual({}) // (no tags named in this instance)

    // it lets go once the deck has arrived - within a tick or two, since a slew that accumulates exactly
    // onto the target takes one extra tick to register the landing
    let released = t.step()
    for (let i = 0; i < 4 && released.gripped; i++) released = t.step()
    expect(released.gripped).toBe(false)
    expect(released.joint!).toBeCloseTo(90 * D2R, 9) // …and it does not creep on release
    expect(t.step().gripped).toBe(false) // and stays let go while parked
  })
})
