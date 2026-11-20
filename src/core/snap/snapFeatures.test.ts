import { afterEach, describe, expect, it } from 'vitest'
import { ARC_END_EXT, CHAIN_FIT_WIDTH_FACTOR, CURVED_ROLLER_END_EXT, ROLLER_CLASSES, SNAP_FENCE_VISIBLE_THRESHOLD, SNAP_VISIBLE_THRESHOLD, SPUR_SIDE_GAP, STAIRS_STANDARD_RISE, STAIRS_STANDARD_TREAD } from '../types'
import type { SdkPart } from '../types'
import { findSnap, findSnapToTarget } from './snapFeatures'
import { surfaceAlignPose, surfaceRestPose } from './snapSurfacePose'
import type { SnapPose } from './snapFeatures'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import { conveyorEndsOf, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { angleDiff, forwardXZ } from '../math'
import { PACKAGE_FORMAT } from '../parts/partPackage'

const pose = (x: number, y: number, z: number, rot: number): SnapPose => ({
  position: [x, y, z],
  rotationY: rot,
})

// an SDK straight roller bed: a custom rig whose deck conveys + whose rollers sit on a world-phase distribute
// grid (maxSpacing = the light-class pitch), with length/width `face` handles. It is therefore both a
// straight-bed conveyor (centre-origin, ends at ±length/2 - unlike a tail-origin bed) and a world-phase
// roller bed (a blade/chain track host).
function customRollerPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.roller',
    name: 'Acme Roller', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    category: 'Equipment',
    params: {
      length: { type: 'number', default: 3, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'deck', shape: { kind: 'box', size: [3, 0.04, 0.6] }, offset: [0, -0.02, 0], conveys: true },
        // the world-phase roller grid that marks this as an SDK roller bed (light-class pitch)
        { name: 'rollerGrid', shape: { kind: 'frame' }, offset: [0, -0.024, 0], array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: 0.075, worldPhase: true } } },
      ],
      joints: [],
      bounds: { length: 3, width: 0.7, top: 1.2 },
    },
  } as unknown as PartPackage
}
function customRoller(id: string, x: number, z: number, rot = 0, length = 3): SdkPart {
  return { id, type: 'part', packageId: 'acme.roller', position: [x, 0.75, z], rotationY: rot, params: { length, width: 0.6, speed: 0.5 } } as unknown as SdkPart
}

// an SDK spur (the length face handle declares angleFrontParam/angleBackParam): a centre-origin splayed bed
// with angled snap ends + the declared side-merge clearance (`sideGap`), mirroring the built-in spurs.
function customSpurPkg(sideGap?: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.spur',
    name: 'Acme Spur', conveyor: { bed: 'spur', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg', ...(sideGap !== undefined ? { sideGap } : {}) } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      angleFrontDeg: { type: 'number', default: 30 },
      angleBackDeg: { type: 'number', default: 0 },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2, width: 0.6, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}
function customSpur(id: string, x: number, z: number, rot = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.spur', position: [x, 0.75, z], rotationY: rot, params: { length: 2, width: 0.6, angleFrontDeg: 30, angleBackDeg: 0, speed: 1 } } as unknown as SdkPart
}

describe('SDK spur snapping (spur-view custom part)', () => {
  afterEach(() => clearPackages())

  it('exposes angled ends: outward = the splayed face normal, faceWidth = the sheared width', () => {
    registerPackage(customSpurPkg())
    const sp = customSpur('sp', 0, 0)
    const ends = conveyorEndsOf(sp)
    const front = ends.find((e) => e.end === 'front')!
    const back = ends.find((e) => e.end === 'back')!
    const fa = Math.PI / 6
    expect(front.x).toBeCloseTo(1, 9) // centre-origin: front face at +length/2
    expect(front.outX).toBeCloseTo(Math.cos(fa), 9)
    expect(front.outZ).toBeCloseTo(-Math.sin(fa), 9)
    expect(front.faceWidth).toBeCloseTo(0.6 / Math.cos(fa), 9)
    expect(back.x).toBeCloseTo(-1, 9)
    expect(back.outX).toBeCloseTo(-1, 9) // square back (0°)
    expect(back.faceWidth).toBeCloseTo(0.6, 9)
  })

  it('end-mates the angled face flush against a straight face, like the built-in spur', () => {
    registerPackage(customSpurPkg())
    registerPackage(customRollerPkg())
    const target = customRoller('rc_t', 0, 0) // centre-origin SDK roller: front end at (1.5, 0)
    const moving = customSpur('sp', 99, 99)
    const snap = findSnap(moving, pose(2.2, 0.75, 0.45, (5 * Math.PI) / 6 + 0.08), [target])
    expect(snap).not.toBeNull()
    // 30° splay: the angled face lies flush when the part yaws 180° − 30° = 150°
    expect(snap!.pose.rotationY).toBeCloseTo((5 * Math.PI) / 6, 9)
    const snapped = { ...moving, position: snap!.pose.position, rotationY: snap!.pose.rotationY }
    const front = conveyorEndsOf(snapped).find((e) => e.end === 'front')!
    expect(front.x).toBeCloseTo(1.5, 6) // mates the SDK roller's centre-origin front end
    expect(front.z).toBeCloseTo(0, 6)
    expect(front.outX).toBeCloseTo(-1, 9)
    expect(front.outZ).toBeCloseTo(0, 9)
  })

  it('side-merges with the default flange gap when the handle declares none', () => {
    registerPackage(customSpurPkg())
    registerPackage(customRollerPkg())
    const host = customRoller('rc_t', 0, 0) // left edge at host-local z = -0.3
    const moving = customSpur('sp', 99, 99)
    const snap = findSnap(moving, pose(0.5, 0.75, -1.0, -Math.PI / 2), [host])
    expect(snap).not.toBeNull()
    const snapped = { ...moving, position: snap!.pose.position, rotationY: snap!.pose.rotationY }
    const minAbsZ = Math.min(...conveyorEndsOf(snapped).map((e) => Math.abs(toLocalXZ(host, e.x, e.z).z)))
    expect(minAbsZ).toBeCloseTo(0.3 + SPUR_SIDE_GAP, 6)
  })

  // A spur side-merges on its splayed face, so flush at a 30° splay puts its body 60° off the host. Held 30° off
  // the host beside mid-flank, its body axis reads "parallel", which an axis-based mode test would send to the
  // host's end 2 m away. Its angled face is what squares up to the flank, and that is what picks the side merge.
  it('side-merges from mid-flank when held at a merge angle, rather than jumping to an end', () => {
    registerPackage(customSpurPkg())
    registerPackage(customRollerPkg())
    const host = customRoller('rc_t', 0, 0, 0, 4) // x -2..2, flanks at z = ±0.3
    const moving = customSpur('sp', 99, 99)
    const snap = findSnap(moving, pose(0, 0.75, 1.1, Math.PI / 6), [host])
    expect(snap).not.toBeNull()
    const j = toLocalXZ(host, snap!.junction.x, snap!.junction.z)
    expect(Math.abs(j.z)).toBeCloseTo(0.3, 6) // on the flank ...
    expect(Math.abs(j.x)).toBeLessThan(1) // ... beside the mover, not at an end (x = ±2)
  })

  // An explicit literal, not the default: a part that wants a wider junction (extra
  // hardware at its mated end) must be able to say so, and the assertion has to fail if the
  // declaration is ignored and the default silently applies.
  it('side-merges with the handle-declared sideGap, overriding the default', () => {
    const declared = 0.09
    expect(declared).not.toBeCloseTo(SPUR_SIDE_GAP, 6)
    registerPackage(customSpurPkg(declared))
    registerPackage(customRollerPkg())
    const host = customRoller('rc_t', 0, 0)
    const moving = customSpur('sp', 99, 99)
    const snap = findSnap(moving, pose(0.5, 0.75, -1.0, -Math.PI / 2), [host])
    expect(snap).not.toBeNull()
    const snapped = { ...moving, position: snap!.pose.position, rotationY: snap!.pose.rotationY }
    const minAbsZ = Math.min(...conveyorEndsOf(snapped).map((e) => Math.abs(toLocalXZ(host, e.x, e.z).z)))
    expect(minAbsZ).toBeCloseTo(0.3 + declared, 6)
  })
})

// a belt-like custom part (declares a `path` handle) snaps like a built-in belt
function customBeltPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.belt',
    name: 'Acme Belt', conveyor: { bed: 'path', surface: 'belt' },
    params: {
      segments: { type: 'numberList', arity: 2, default: [[3, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
      width: { type: 'number', default: 0.6 },
      height: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 3, width: 0.6, top: 0.5 }, conveys: true },
  } as PartPackage
}
function customBelt(id: string, x: number, z: number, rot = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.belt', position: [x, 0.75, z], rotationY: rot, params: { segments: [[3, 0]], width: 0.6, height: 0.5, leftGuard: true, rightGuard: true } } as unknown as SdkPart
}

// Conveyor to conveyor: every join is solved and the cheapest that engages is chosen, engaging on how far the mover's
// mating end moves (snapFeatures.ts snapConveyor). Host: an SDK roller at the origin, x -1.5..1.5, flanks at z ±0.3,
// ends at (±1.5, 0). A centre-origin mover of length 3 has its ends 1.5 from its origin; at yaw π/2 its front end
// is at origin + (0, -1.5).
describe('conveyor joins (every join solved, engage on the mating end)', () => {
  afterEach(() => clearPackages())
  const setup = (): { host: SdkPart; mover: SdkPart } => {
    registerPackage(customRollerPkg())
    return { host: customRoller('h', 0, 0), mover: customRoller('m', 99, 99) }
  }

  it('a conveyor dropped on another is not carried to its far end (a 2.2 m jump)', () => {
    const { host, mover } = setup()
    expect(findSnap(mover, pose(0.8, 0.75, 0, 0), [host])).toBeNull()
    expect(findSnap(mover, pose(1.2, 0.75, 0.1, 0.05), [host])).toBeNull()
  })

  it('an end that starts deep in the bed is not carried along it to the end', () => {
    const { host, mover } = setup()
    // aligned, back end at x = 0.5: a metre from the host's front end, only 0.35 from the flank edge
    expect(findSnap(mover, pose(2.0, 0.75, 0, 0), [host])).toBeNull()
  })

  it('engages on the mating end: within the engage distance of an end, and not past it', () => {
    const { host, mover } = setup()
    const near = findSnap(mover, pose(3.2, 0.75, 0, 0), [host]) // back end 0.2 m off the host's front end
    expect(near?.join).toBe('back -> end:front')
    expect(near!.pose.position[0]).toBeCloseTo(3.0, 9)
    expect(findSnap(mover, pose(3.45, 0.75, 0, 0), [host])).toBeNull() // 0.45 m off
  })

  it('a held join stays engaged out to the release distance, and only that join', () => {
    const { host, mover } = setup()
    const hold = { via: 'conveyor', join: 'back -> end:front' }
    expect(findSnapToTarget(mover, pose(3.45, 0.75, 0, 0), host, undefined, { hold })?.join).toBe('back -> end:front')
    expect(findSnapToTarget(mover, pose(3.75, 0.75, 0, 0), host, undefined, { hold })).toBeNull() // 0.75 m: released
    expect(findSnapToTarget(mover, pose(3.2, 0.75, 0, 0), host, undefined, { hold: { via: 'conveyor', join: 'front -> end:back' } })).toBeNull()
  })

  it('a perpendicular end dropped into the bed is pushed out through the nearest flank, where it is', () => {
    const { host, mover } = setup()
    const c = findSnap(mover, pose(0.3, 0.75, 1.5, Math.PI / 2), [host]) // front end on the bed centreline
    expect(c?.join).toBe('front -> flank:right')
    expect(c!.junction.x).toBeCloseTo(0.3, 9)
    expect(c!.junction.z).toBeCloseTo(0.3, 9)
  })

  it('a conveyor laid parallel beside a flank is never swung into a T', () => {
    const { host, mover } = setup()
    ;(mover.params as Record<string, unknown>).width = 0.2 // narrow: its tip comes within 0.15 m of the flank
    expect(findSnap(mover, pose(0, 0.75, 0.45, 0), [host])).toBeNull()
    // held square to the same flank instead, it merges
    expect(findSnap(mover, pose(0, 0.75, 0.45 + 1.5, Math.PI / 2), [host])?.join).toBe('front -> flank:right')
  })

  it('an end a little past the run lands on the corner', () => {
    const { host, mover } = setup()
    const c = findSnap(mover, pose(1.6, 0.75, 0.4 + 1.5, Math.PI / 2), [host]) // front end at (1.6, 0.4)
    expect(c?.join).toBe('front -> flank:right')
    expect(c!.junction.x).toBeCloseTo(1.5, 9)
  })

  it('never flips end for end: the end that already faces the join is the one that mates', () => {
    const { host, mover } = setup()
    // facing away from the host (yaw π): its front end is the one 0.2 m off the host's front end
    const c = findSnap(mover, pose(3.2, 0.75, 0, Math.PI), [host])
    expect(c?.join).toBe('front -> end:front')
    expect(Math.abs(angleDiff(c!.pose.rotationY, Math.PI))).toBeLessThan(1e-9)
  })
})

describe('belt-like custom/SDK conveyor snapping', () => {
  afterEach(() => clearPackages())

  it('a custom belt snaps end-to-end onto another SDK belt', () => {
    registerPackage(customBeltPkg())
    const target = customBelt('b', 0, 0) // SDK belt, bed x 0..3, front end ~3.25
    const moving = customBelt('cm', 99, 99)
    expect(findSnapToTarget(moving, pose(3.5, 0.75, 0.05, 0.04), target)).not.toBeNull()
  })

  it('an SDK roller snaps end-to-end onto a custom belt target', () => {
    registerPackage(customBeltPkg())
    registerPackage(customRollerPkg())
    const target = customBelt('ct', 0, 0) // belt front end at (3.25, 0)
    const moving = customRoller('rm', 99, 99) // centre-origin: back end mates the belt front near origin 4.75
    expect(findSnapToTarget(moving, pose(4.75, 0.75, 0.05, 0.04), target)).not.toBeNull()
  })
})

// a curved SDK conveyor (declares an `arc` handle on its sweep param) snaps like a built-in curved belt.
// Its arc uses the SDK convention: rc = innerRadius + width/2, entry at local (rc, 0) sweeping toward −Z.
function customCurvedPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.curve',
    name: 'Acme Curve', conveyor: { bed: 'arc', surface: 'roller', speedParam: 'speed', reverseParam: 'reverse' },
    params: {
      innerRadius: { type: 'number', default: 0.5 },
      width: { type: 'number', default: 1.524 },
      sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } },
      speed: { type: 'number', default: 2 },
      reverse: { type: 'boolean', default: false, hidden: true }, // the snap-owned flag (conveyor.reverseParam)
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2.274, width: 2.274, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}
function customCurved(id: string, x: number, z: number, rot = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.curve', position: [x, 0.75, z], rotationY: rot, params: { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 } } as unknown as SdkPart
}

// a curved SDK roller: the arc handle declares `endGap` = CURVED_ROLLER_END_EXT, so its ends butt nearly flush
// like the built-in curved roller (not the belt's 0.25 half-pulley). Guards the reported "SDK roller ↔ curved" gap.
function customCurvedRollerPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.curve-roller',
    name: 'Acme Curve Roller', conveyor: { bed: 'arc', surface: 'roller', speedParam: 'speed' },
    params: {
      innerRadius: { type: 'number', default: 0.5 },
      width: { type: 'number', default: 1.524 },
      sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width', endGap: CURVED_ROLLER_END_EXT } },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2.274, width: 2.274, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}
function customCurvedRoller(id: string, x: number, z: number, rot = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.curve-roller', position: [x, 0.75, z], rotationY: rot, params: { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 1 } } as unknown as SdkPart
}

describe('curved SDK conveyor snapping (arc handle)', () => {
  afterEach(() => clearPackages())

  it('an SDK curved bed is conveyor-like and exposes its two tangent-stub arc ends', () => {
    registerPackage(customCurvedPkg())
    const cv = customCurved('cv', 0, 0)
    const ends = conveyorEndsOf(cv)
    expect(ends.length).toBe(2)
    const rc = 0.5 + 1.524 / 2 // 1.262
    const back = ends.find((e) => e.end === 'back')!
    const front = ends.find((e) => e.end === 'front')!
    // entry (back): (rc, +stub), outward +Z; exit (front) at 90°: (−stub, −rc), outward −X
    expect(back.x).toBeCloseTo(rc, 6)
    expect(back.z).toBeCloseTo(ARC_END_EXT, 6) // the belt curve's half-pulley gap
    expect(back.outZ).toBeCloseTo(1, 6)
    expect(front.x).toBeCloseTo(-ARC_END_EXT, 6)
    expect(front.z).toBeCloseTo(-rc, 6)
    expect(front.outX).toBeCloseTo(-1, 6)
  })

  it('an SDK belt snaps onto an SDK curved bed', () => {
    registerPackage(customCurvedPkg())
    registerPackage(customBeltPkg())
    const target = customCurved('cv', 0, 0) // exit end at (−0.25, −1.262), outward −X
    // belt origin (−3.5, −1.262) yaw 0 puts its front end (x+3.25) exactly on the curve's exit; drop near it
    const snap = findSnapToTarget(customBelt('cm', 99, 99), pose(-3.45, 0.75, -1.2, 0.03), target)
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('cv')
  })

  it('an SDK curved bed snaps onto an SDK belt (both directions work)', () => {
    registerPackage(customCurvedPkg())
    registerPackage(customBeltPkg())
    const target = customBelt('bt', 0, 0) // built-like belt, front end at (3.25, 0), outward +X
    // curved origin (3.5, −1.262) yaw −π/2 puts its entry end on the belt front; drop near it
    const snap = findSnapToTarget(customCurved('cm', 99, 99), pose(3.45, 0.75, -1.2, -Math.PI / 2 + 0.03), target)
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('bt')
  })

  // Flow-incompatible mate (both ends discharge into the junction). A curve can't be spun 180° to turn its
  // flow around - that would swap inner/outer radius - so the snap flips a hidden `reverse` flag
  // (engine-owned storage) and must not negate the authored speed, or
  // snapping silently rewrites the number the user typed in the Inspector.
  it("mating two output ends toggles the curve's hidden reverse flag - never its authored speed", () => {
    registerPackage(customCurvedPkg())
    registerPackage(customBeltPkg())
    const target = customBelt('bt', 0, 0) // front (output) end at (3.25, 0), outward +X
    // the curve's exit (front) end sits at local (−0.25, −rc) facing −X, so yaw 0 near (3.5, 1.262) butts the
    // two outputs together
    const snap = findSnapToTarget(customCurved('cm', 99, 99), pose(3.45, 0.75, 1.3, 0.03), target)
    expect(snap).not.toBeNull()
    expect(snap!.paramOverrides?.reverse).toBe(true)
    expect(snap!.paramOverrides?.speed).toBeUndefined() // the authored speed is left alone
  })

  it('...and it toggles: re-snapping an already-reversed curve the same way restores its forward flow', () => {
    registerPackage(customCurvedPkg())
    registerPackage(customBeltPkg())
    const target = customBelt('bt', 0, 0)
    const moving = customCurved('cm', 99, 99)
    // a reversed curve discharges at its entry, so the same drop mates entry-to-output - still
    // flow-incompatible, and the flag has to come back off rather than latch on
    moving.params = { ...moving.params, reverse: true } as typeof moving.params
    const snap = findSnapToTarget(moving, pose(3.45, 0.75, -1.2, -Math.PI / 2 + 0.03), target)
    expect(snap).not.toBeNull()
    expect(snap!.paramOverrides?.reverse).toBe(false)
  })

  it('an SDK curved roller (endGap) exposes near-flush ends, not the belt half-pulley', () => {
    registerPackage(customCurvedRollerPkg())
    const ends = conveyorEndsOf(customCurvedRoller('cv', 0, 0))
    const rc = 0.5 + 1.524 / 2 // 1.262
    const back = ends.find((e) => e.end === 'back')!
    const front = ends.find((e) => e.end === 'front')!
    // roller curve butts flush: the stub is CURVED_ROLLER_END_EXT (0.002), not ARC_END_EXT (0.25)
    expect(back.z).toBeCloseTo(CURVED_ROLLER_END_EXT, 6)
    expect(front.x).toBeCloseTo(-CURVED_ROLLER_END_EXT, 6)
    expect(front.z).toBeCloseTo(-rc, 6)
  })

  it('a straight roller snaps flush onto an SDK curved roller (not 0.25 out)', () => {
    registerPackage(customCurvedRollerPkg())
    registerPackage(customRollerPkg())
    // curve exit (front) end at (−0.002, −1.262), outward −X. A centre-origin SDK roller (front end x=length/2,
    // out +X) mates front-to-front at yaw 0 with its origin near (−1.502, −1.262); drop close to it.
    const snap = findSnapToTarget(customRoller('rm', 99, 99), pose(-1.5, 0.75, -1.25, 0.02), customCurvedRoller('cv', 0, 0))
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('cv')
    // the junction sits on the near-flush arc exit, not 0.25 m out as the belt half-pulley would place it
    expect(snap!.junction.x).toBeCloseTo(-CURVED_ROLLER_END_EXT, 6)
    expect(Math.abs(snap!.junction.x + ARC_END_EXT)).toBeGreaterThan(ARC_END_EXT / 2)
  })
})

// a custom device that declares a snap mount (an SDK sensor) mounts on a conveyor side guard
function customSensorPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.sensor',
    name: 'Acme Sensor',
    params: { range: { type: 'number', default: 1 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.1, width: 0.1, top: 0.1 } },
    snap: { mounts: [{ at: [0, 0, 0.05], accepts: 'conveyorGuard', face: 'in', fitRangeParam: 'range' }] },
  } as unknown as PartPackage
}
function customSensor(id: string, x: number, z: number, rot = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.sensor', position: [x, 0.75, z], rotationY: rot, params: {} } as unknown as SdkPart
}

describe('custom device snapping (declarative snap mount)', () => {
  afterEach(() => clearPackages())

  it('a custom sensor with a declared mount lands on an SDK belt side guard + auto-fits its range param', () => {
    registerPackage(customSensorPkg())
    registerPackage(customBeltPkg())
    const target = customBelt('b', 0, 0) // bed x 0..3, side guards at z = ±0.3
    const moving = customSensor('s', 99, 99)
    const snap = findSnapToTarget(moving, pose(1.5, 0.75, 0.5, 0), target)
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('b')
    expect(snap!.pose.position[2]).toBeGreaterThan(0.3) // mounted on the +z guard, body pushed outward
    expect(snap!.pose.position[0]).toBeCloseTo(1.5, 1) // slides along the rail to the cursor x
    // auto-fit writes the declared range param (a custom sensor names its own; not the built-in `maxRange`)
    const range = (snap!.paramOverrides as { range?: number } | undefined)?.range
    expect(typeof range).toBe('number')
    expect(range!).toBeGreaterThan(0.5) // spans the belt width + offsets
  })

  // Regression: the implicit 'conveyorGuard' rail must follow the host's origin convention. Every other mount
  // test here uses the SDK belt (tail-origin, bed x 0..len) or a declared centre-origin rail, where a hardcoded
  // tail-origin rail range passes. On a centre-origin bed (the SDK roller, a spur) that range puts the
  // mountable band at x 0..len: the whole rear half of the bed refuses a device, and a bed's length of empty
  // air past the discharge end accepts one.
  it('a custom sensor mounts along the whole length of a centre-origin roller bed, and not past its ends', () => {
    registerPackage(customSensorPkg())
    registerPackage(customRollerPkg())
    const target = customRoller('rc_t', 0, 0) // centre-origin SDK roller: bed x −1.5..+1.5, guards z = ±0.3
    // the rear half of the bed (local x < 0) must mount, sliding to the cursor
    const rear = findSnapToTarget(customSensor('s', 99, 99), pose(-1.2, 0.75, 0.5, 0), target)
    expect(rear, 'the rear half of a centre-origin bed must take a device').not.toBeNull()
    expect(rear!.pose.position[0]).toBeCloseTo(-1.2, 9)
    expect(rear!.pose.position[2]).toBeGreaterThan(0.3) // on the +z guard, body pushed outward
    expect(toLocalXZ(target, rear!.junction.x, rear!.junction.z).x).toBeCloseTo(-1.2, 9)
    // …and so must the front half
    const front = findSnapToTarget(customSensor('s', 99, 99), pose(1.2, 0.75, 0.5, 0), target)
    expect(front).not.toBeNull()
    expect(front!.pose.position[0]).toBeCloseTo(1.2, 9)
    // the rail ends with the bed: a drop a metre past the front end is out of reach of the guard, not on it
    expect(findSnapToTarget(customSensor('s', 99, 99), pose(2.5, 0.75, 0.5, 0), target)).toBeNull()
  })

  it('a custom part without a snap mount does not snap to a conveyor at all (no declaration, no snap)', () => {
    registerPackage({ ...customSensorPkg(), snap: undefined } as unknown as PartPackage)
    registerPackage(customBeltPkg())
    const target = customBelt('b', 0, 0)
    expect(findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), target)).toBeNull()
  })

  it('a custom sensor also mounts on a custom (SDK) belt target - the host surface is generalized', () => {
    registerPackage(customSensorPkg())
    registerPackage(customBeltPkg())
    const target = customBelt('cb', 0, 0) // an SDK belt, bed x 0..3, side guards at z = ±(0.3)
    const snap = findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), target)
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('cb')
    expect(snap!.pose.position[2]).toBeGreaterThan(0.3) // mounted on the SDK belt's +z guard
  })

  // Every declared mount is tried, not just mounts[0]. `accepts` is one surface kind per mount, so "seats on a
  // conveyor guard or on a plain bracket face" can only be said as two mounts. Indexing [0] would make the second
  // silently dead data, while validateSnap checks it and isGuardPusher/guardPusherContacts both loop the whole
  // array. The pair below is the unknown-kind mount first, the real one second.
  const twoMountPkg = (): PartPackage =>
    ({
      ...customSensorPkg(),
      snap: {
        mounts: [
          { at: [0, 0, 0.05], accepts: 'noSuchSurfaceKind', face: 'in' }, // matches nothing anywhere
          { at: [0, 0, 0.05], accepts: 'conveyorGuard', face: 'in', fitRangeParam: 'range' }, // == the single-mount pkg
        ],
      },
    }) as unknown as PartPackage

  it('tries every declared mount, not just the first', () => {
    registerPackage(twoMountPkg())
    registerPackage(customBeltPkg())
    const snap = findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), customBelt('b', 0, 0))
    expect(snap, 'the SECOND mount must be reachable - with mounts[0] indexing this was null').not.toBeNull()
    expect(snap!.pose.position[2]).toBeGreaterThan(0.3) // seated on the +z guard via the second mount
    expect((snap!.paramOverrides as { range?: number }).range).toBeGreaterThan(0.5)
  })

  it('…and a one-mount device is untouched: the extra mount only adds a possibility', () => {
    // the additive claim, asserted directly - the second mount is byte-identical to the single-mount package's
    // one, so the two must resolve to the very same pose. If the loop moved a one-mount part at all, this fails.
    registerPackage(customSensorPkg())
    registerPackage(customBeltPkg())
    const one = findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), customBelt('b', 0, 0))
    expect(one).not.toBeNull()
    clearPackages()
    registerPackage(twoMountPkg())
    registerPackage(customBeltPkg())
    const two = findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), customBelt('b', 0, 0))
    expect(two!.pose).toEqual(one!.pose)
    expect(two!.paramOverrides).toEqual(one!.paramOverrides)
  })

  it('picks the best mount, not the first viable one (declaration order must not decide)', () => {
    // two viable 'conveyorGuard' mounts whose contacts sit at different local depths: the seat they imply is
    // different, so one costs less from the same drop. Reversing the declaration order must not change which.
    const mounts = [
      { at: [0, 0, 0.05], accepts: 'conveyorGuard', face: 'in', fitRangeParam: 'range' },
      { at: [0, 0, 0.6], accepts: 'conveyorGuard', face: 'in', fitRangeParam: 'range' },
    ]
    registerPackage({ ...customSensorPkg(), snap: { mounts } } as unknown as PartPackage)
    registerPackage(customBeltPkg())
    const forward = findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), customBelt('b', 0, 0))
    clearPackages()
    registerPackage({ ...customSensorPkg(), snap: { mounts: [...mounts].reverse() } } as unknown as PartPackage)
    registerPackage(customBeltPkg())
    const reversed = findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), customBelt('b', 0, 0))
    expect(forward).not.toBeNull()
    expect(reversed!.pose, 'the winner must be chosen by cost, not by position in the array').toEqual(forward!.pose)
  })

  it('the SDK sensor mount block (laser/color/diffuse examples) lands at the built-in sensor offsets', () => {
    // the exact block the example sensors declare: lens face at SENSOR_HALF_Z, guard standoff 0.02,
    // auto-fit maxRange - must reproduce the built-in laser numbers (origin 0.357 out, range 0.64)
    registerPackage({
      ...customSensorPkg(),
      id: 'acme.laser',
      snap: { mounts: [{ at: [0, 0, 0.037], accepts: 'conveyorGuard', face: 'in', outwardOffset: 0.02, fitRangeParam: 'maxRange' }] },
    } as unknown as PartPackage)
    registerPackage(customBeltPkg())
    const target = customBelt('rc_t', 0, 0) // bed x 0..3, guards at z = ±0.3, surface y 0.75
    const moving: SdkPart = { id: 's', type: 'part', packageId: 'acme.laser', position: [0, 0.75, 0.35], rotationY: 0, params: {} } as unknown as SdkPart
    const snap = findSnap(moving, pose(0, 0.75, 0.35, 0), [target])
    expect(snap).not.toBeNull()
    // origin = edge 0.3 + lens half-depth 0.037 + guard offset 0.02; base seats on the belt surface;
    // beam (+Z) faces inward (yaw π) - identical to the built-in laser mount test
    expect(snap!.pose.position[0]).toBeCloseTo(0, 9)
    expect(snap!.pose.position[2]).toBeCloseTo(0.357, 9)
    expect(snap!.pose.position[1]).toBeCloseTo(0.75, 9)
    expect(Math.abs(angleDiff(snap!.pose.rotationY, Math.PI))).toBeCloseTo(0, 9)
    // range auto-fit: maxRange = belt width + 2·guard offset = 0.6 + 0.04
    expect(snap!.paramOverrides).toEqual({ maxRange: 0.64 })
  })
})

// a custom host that advertises a mountable surface (the host half of declarative snapping - definePart({ snap:
// { surfaces } })). A plain rail, not a conveyor, so it exercises the accepts→surface dispatch rather than the
// hardcoded conveyor path: an existing, unmodified SDK sensor mounts on it purely because its `accepts` matches
// the advertised surface `kind`. Centre-origin (rails at x −length/2..+length/2, z = ±width/2).
function customRailPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.rail',
    name: 'Acme Rail',
    params: { length: { type: 'number', default: 2 }, width: { type: 'number', default: 0.8 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 2, width: 0.8, top: 0.1 } },
    snap: { surfaces: [{ kind: 'conveyorGuard', lengthParam: 'length', widthParam: 'width' }] },
  } as unknown as PartPackage
}
function customRail(id: string, x: number, z: number, rot = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.rail', position: [x, 0.75, z], rotationY: rot, params: { length: 2, width: 0.8 } } as unknown as SdkPart
}

describe('custom host surface (declarative snap surface - the host half)', () => {
  afterEach(() => clearPackages())

  it('an existing SDK sensor mounts on a non-conveyor host that advertises a conveyorGuard surface', () => {
    registerPackage(customSensorPkg()) // the same sensor package that mounts on a belt - byte-identical, unchanged
    registerPackage(customRailPkg())
    const target = customRail('r', 0, 0) // rails at x −1..+1, z = ±0.4
    const snap = findSnapToTarget(customSensor('s', 99, 99), pose(0.5, 0.75, 0.5, 0), target)
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('r')
    expect(snap!.pose.position[2]).toBeGreaterThan(0.4) // mounted on the +z rail, body pushed outward
    expect(snap!.pose.position[0]).toBeCloseTo(0.5, 1) // slides along the rail to the cursor x
    // auto-fit spans the declared rail width (0.8) + 2·outwardOffset (0) into the sensor's own range param
    expect((snap!.paramOverrides as { range?: number }).range).toBeCloseTo(0.8, 6)
  })

  it('a host that declares no surface offers nothing to mount onto', () => {
    registerPackage(customSensorPkg())
    registerPackage({ ...customRailPkg(), snap: undefined } as unknown as PartPackage)
    expect(findSnapToTarget(customSensor('s', 99, 99), pose(0.5, 0.75, 0.5, 0), customRail('r', 0, 0))).toBeNull()
  })

  it('accepts is a live dispatch key: a device seeking an unknown kind snaps to nothing - even over a conveyor', () => {
    registerPackage({
      ...customSensorPkg(),
      snap: { mounts: [{ at: [0, 0, 0.05], accepts: 'unknownKind', face: 'in', fitRangeParam: 'range' }] },
    } as unknown as PartPackage)
    registerPackage(customRailPkg())
    registerPackage(customBeltPkg())
    expect(findSnapToTarget(customSensor('s', 99, 99), pose(0.5, 0.75, 0.5, 0), customRail('r', 0, 0))).toBeNull()
    expect(findSnapToTarget(customSensor('s', 99, 99), pose(1.5, 0.75, 0.5, 0), customBelt('b', 0, 0))).toBeNull()
  })
})

// an SDK diverter: a custom device whose mount declares the built-in diverter's push-side seat - face 'out'
// (local +Z away from the belt, so −Z pushes across it), dropped DIVERTER_SNAP_Y_OFFSET below the surface and
// stood off DIVERTER_SNAP_SIDE_OFFSET from the guard (the diverter's push-side point feature).
function customDiverterPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.diverter',
    name: 'Acme Diverter',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.73, width: 2.36, top: 0.82 } },
    snap: { mounts: [{ at: [0, 0, -1.0635], accepts: 'conveyorGuard', face: 'out', yOffset: 0.2, outwardOffset: 0.05, opens: true }] },
  } as unknown as PartPackage
}
function customDiverter(id: string, x: number, z: number, rot = 0, y = 0.55): SdkPart {
  return { id, type: 'part', packageId: 'acme.diverter', position: [x, y, z], rotationY: rot, params: {} } as unknown as SdkPart
}

describe('custom diverter snapping (out-facing mount with y/side offsets)', () => {
  afterEach(() => clearPackages())
  const target = customBelt('rc_t', 0, 0) // bed x 0..3, guards at z = ±0.3, surface y 0.75

  it('lands at the diverter push-side seat pose (push side on the guard, body outward)', () => {
    registerPackage(customDiverterPkg())
    registerPackage(customBeltPkg())
    const p = pose(0, 0.75, 1.0, 0)
    const sdk = findSnap(customDiverter('dv_s', 0, 1.0), p, [target])
    expect(sdk).not.toBeNull()
    // origin = right edge (0.3) + push-half (1.0635) + side offset (0.05); dropped 0.2 below the surface.
    // These match the built-in diverter's push-side offsets.
    expect(sdk!.pose.position[0]).toBeCloseTo(0, 9)
    expect(sdk!.pose.position[2]).toBeCloseTo(1.4135, 6)
    expect(sdk!.pose.position[1]).toBeCloseTo(0.55, 9)
    expect(sdk!.pose.rotationY).toBeCloseTo(0, 9)
    expect(sdk!.junction.z).toBeCloseTo(0.3, 9)
    expect(sdk!.override).toBe(true)
  })

  it('does not snap clear of the bed beyond the interface gap', () => {
    registerPackage(customDiverterPkg())
    registerPackage(customBeltPkg())
    expect(findSnap(customDiverter('dv_s', 0, 3.0), pose(0, 0.75, 3.0, 0), [target])).toBeNull()
  })

  it('never snaps a device to a non-straight conveyor target', () => {
    registerPackage(customDiverterPkg())
    registerPackage(customCurvedRollerPkg())
    expect(findSnap(customDiverter('dv_s', 0, 0.35), pose(0, 0.55, 0.35, 0), [customCurvedRoller('crc_t', 0, 0)])).toBeNull()
  })
})

// an SDK blade stop: a custom part with a declarative `track` block - it seats onto a roller bed anchored to
// the rendered roller grid (the blade rises in the gap between two rollers) and auto-fits its own width param
// to the usable bed width, like the built-in blade_stop.
function customBladePkg(over: Partial<{ track: { fitWidthParam?: string; targetLocalY?: number } }> = {}): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.blade',
    name: 'Acme Blade Stop',
    params: { width: { type: 'number', default: 1.524, min: 0.1, max: 2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 0.2, width: 2, top: 0.5 } },
    snap: { track: over.track ?? { fitWidthParam: 'width' } },
  } as unknown as PartPackage
}
function customBlade(id: string, x = 0, z = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.blade', position: [x, 0.75, z], rotationY: 0, params: { width: 1.524 } } as unknown as SdkPart
}

describe('custom track snapping (declarative snap.track - SDK blade stop)', () => {
  afterEach(() => clearPackages())
  const host = customRoller('rc_h', 1.5375, 0)

  it('anchors at a gap station like the built-in blade stop and auto-fits its width param', () => {
    registerPackage(customBladePkg())
    registerPackage(customRollerPkg())
    const moving = customBlade('bst_s')
    const snap = findSnap(moving, pose(1.6, 0.8, 0.04, 0.04), [host])
    expect(snap).not.toBeNull()
    // the world-anchored gap station at world x 1.6 is unchanged from the built-in host (same world position):
    // gap-station anchor, host-aligned yaw, bed-surface y
    expect(snap!.pose.rotationY).toBeCloseTo(0, 9)
    expect(snap!.pose.position[0]).toBeCloseTo(1.6125, 9)
    expect(snap!.pose.position[1]).toBeCloseTo(0.75, 10)
    expect(snap!.pose.position[2]).toBeCloseTo(0, 9)
    // usable width = host width − 2·FRAME_WALL_THICKNESS − 0.01, written to the declared param
    expect(snap!.paramOverrides).toEqual({ width: 0.57 })
    const phase = snap!.pose.position[0] / ROLLER_CLASSES.light.pitch
    expect(Math.abs(phase - Math.round(phase))).toBeCloseTo(0.5, 6)
  })

  it('clamps the fitted width to the declared param range', () => {
    registerPackage(customBladePkg())
    registerPackage(customRollerPkg())
    const wide = customRoller('rc_w', 1.5375, 0)
    wide.params = { ...wide.params, width: 2.4 } // usable 2.37 > the param max 2
    const snap = findSnap(customBlade('bst_s'), pose(1.6, 0.75, 0.04, 0.04), [wide])
    expect(snap).not.toBeNull()
    expect(snap!.paramOverrides).toEqual({ width: 2 })
  })

  it('seats targetLocalY above the bed surface', () => {
    registerPackage(customBladePkg({ track: { fitWidthParam: 'width', targetLocalY: 0.1 } }))
    registerPackage(customRollerPkg())
    const snap = findSnap(customBlade('bst_s'), pose(1.6, 0.85, 0.04, 0.04), [host])
    expect(snap).not.toBeNull()
    expect(snap!.pose.position[1]).toBeCloseTo(0.85, 10)
    expect(snap!.junction.y).toBeCloseTo(0.85, 10)
  })

  it('a track without fitWidthParam still snaps but adopts no size', () => {
    registerPackage(customBladePkg({ track: {} }))
    registerPackage(customRollerPkg())
    const snap = findSnap(customBlade('bst_s'), pose(1.6, 0.75, 0.04, 0.04), [host])
    expect(snap).not.toBeNull()
    expect(snap!.paramOverrides).toBeUndefined()
  })

  it('never anchors to a belt conveyor (no roller track), like the built-in', () => {
    registerPackage(customBladePkg())
    registerPackage(customBeltPkg())
    expect(findSnap(customBlade('bst_s'), pose(1.6, 0.75, 0, 0), [customBelt('bc_h', 1.5375, 0)])).toBeNull()
  })

  it('grabs an on-top drop (loose vertical tolerance) but not one far above the bed', () => {
    registerPackage(customBladePkg())
    registerPackage(customRollerPkg())
    // dropped resting on the rollers, its origin sits well above the seat (host y 0.75); it still snaps and is
    // pulled down to the bed surface (the loose 2.0 m on-top gate, not the tight 0.35).
    const onTop = findSnap(customBlade('bst_s'), pose(1.6, 1.2, 0, 0), [host])
    expect(onTop).not.toBeNull()
    expect(onTop!.pose.position[1]).toBeCloseTo(0.75, 10)
    // far above the bed (Δy = 2.5 > the 2 m tolerance) does not snap
    expect(findSnap(customBlade('bst_s'), pose(1.6, 3.25, 0, 0), [host])).toBeNull()
  })
})

// an SDK chain transfer: a custom part whose track declares lane-parity anchoring (snap.track.lanes) - N chain
// lanes stepped one host pitch apart along the track, odd counts centring a lane in a roller gap, even counts
// on a station. The host pitch is adopted into its `distance`
// param and the lane length auto-fits to the host bed width × fitWidthScale
// - the declarative twin of the built-in chain transfer's track snap.
function customChainPkg(targetLocalY?: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.chain',
    name: 'Acme Chain Transfer',
    params: {
      chains: { type: 'number', default: 5, min: 1, max: 10 },
      distance: { type: 'number', default: 0.33, min: 0.03, max: 5 },
      laneLength: { type: 'number', default: 2, min: 0.5, max: 3 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 2, width: 1.65, top: 0.2 } },
    snap: {
      track: {
        lanes: { countParam: 'chains', pitchParam: 'distance' },
        fitWidthParam: 'laneLength',
        fitWidthScale: CHAIN_FIT_WIDTH_FACTOR,
        ...(targetLocalY === undefined ? {} : { targetLocalY }),
      },
    },
  } as unknown as PartPackage
}
function customChain(id: string, chains: number): SdkPart {
  return { id, type: 'part', packageId: 'acme.chain', position: [0, 0.75, 0], rotationY: 0, params: { chains, distance: 0.33, laneLength: 2 } } as unknown as SdkPart
}

describe('custom lane-track snapping (declarative snap.track.lanes - SDK chain transfer)', () => {
  afterEach(() => clearPackages())
  const host = customRoller('rc_h', 1.5375, 0)

  const PITCH = ROLLER_CLASSES.light.pitch
  /**
   * The invariant the lane-parity snap exists for: every lane of the seated bank sits in a roller gap, never on
   * a roller. Lanes are `centered`, so lane i stands (i - (n-1)/2)·spacing from the part origin; a gap is a
   * half-pitch offset from the world station grid. Returns the worst lane's distance from its gap, in pitches
   * (0 = dead centre of a gap, 0.5 = right on a roller).
   */
  function worstLaneOffGap(originX: number, chains: number, spacing: number): number {
    let worst = 0
    for (let i = 0; i < chains; i++) {
      const x = originX + (i - (chains - 1) / 2) * spacing
      const phase = x / PITCH - 0.5 // gaps sit at half-pitch offsets from the station grid
      worst = Math.max(worst, Math.abs(phase - Math.round(phase)))
    }
    return worst
  }

  // Regression: the adopted spacing must stay inside the param's declared range. A range narrower than one host
  // pitch holds no whole multiple at all (min 0.10 / max 0.11 against a 0.075 pitch: the neighbours are 0.075
  // and 0.150). Preferring the minimum (`Math.max(kMin, …)`) would write 0.15 into a param declared max 0.11,
  // out of range in the Inspector and liable to be silently re-clamped later. The whole-multiple invariant still
  // takes precedence (it keeps lanes in the gaps), but it misses downward: a tighter bank, which the on-bed clamp
  // already handles, rather than a wider one that can hang off the bed.
  it('never adopts a spacing above the param’s declared max, even when no whole multiple fits', () => {
    const narrow = {
      ...customChainPkg(),
      params: {
        chains: { type: 'number', default: 3, min: 1, max: 10 },
        distance: { type: 'number', default: 0.105, min: 0.1, max: 0.11 }, // narrower than one 0.075 pitch
        laneLength: { type: 'number', default: 2, min: 0.5, max: 3 },
      },
    } as unknown as PartPackage
    registerPackage(narrow)
    registerPackage(customRollerPkg())
    const part = { id: 'ct_n', type: 'part', packageId: 'acme.chain', position: [0, 0.75, 0], rotationY: 0, params: { chains: 3, distance: 0.105, laneLength: 2 } } as unknown as SdkPart
    const snap = findSnap(part, pose(1.6, 0.78, 0.05, 0.05), [host])
    expect(snap).not.toBeNull()
    const adopted = (snap!.paramOverrides as { distance: number }).distance
    expect(adopted, 'the adopted spacing must not exceed the declared max').toBeLessThanOrEqual(0.11)
    expect(adopted, 'and must still be a whole multiple of the host pitch').toBeCloseTo(PITCH, 12)
    expect(Math.abs(adopted / PITCH - Math.round(adopted / PITCH))).toBeLessThan(1e-9)
  })

  it('anchors by lane parity (odd chains) and adopts the authored spacing + lane length', () => {
    registerPackage(customChainPkg())
    registerPackage(customRollerPkg())
    const snap = findSnap(customChain('ct_s', 3), pose(1.6, 0.78, 0.05, 0.05), [host])
    expect(snap).not.toBeNull()
    // the authored 0.33 m spacing rounded to whole host pitches (0.33 / 0.075 = 4.4 → 4 pitches = 0.3), not
    // overwritten with the bare 0.075 pitch; host width 0.6 × ~0.755 = 0.453, clamped to 0.5
    expect(snap!.paramOverrides).toEqual({ distance: 4 * PITCH, laneLength: 0.5 })
    // Aligned with the host flow: the lane bank spreads along local X, so the part seats at the host's own yaw
    // (its through-axis carrying along the main line, its lanes reaching across the bed). Proposal ~0 → 0.
    expect(snap!.pose.rotationY).toBeCloseTo(0, 9)
    expect(snap!.pose.position[1]).toBeCloseTo(0.75, 10)
    // odd count → the origin itself sits in a gap (a lane sits on it)
    const phase = snap!.pose.position[0] / PITCH
    expect(Math.abs(phase - Math.round(phase))).toBeCloseTo(0.5, 6)
    expect(worstLaneOffGap(snap!.pose.position[0], 3, 4 * PITCH)).toBeCloseTo(0, 6)
  })

  it('even chains anchor so the lanes straddle the grid - every lane still in a gap', () => {
    registerPackage(customChainPkg())
    registerPackage(customRollerPkg())
    const snap = findSnap(customChain('ct_s', 4), pose(1.6, 0.78, 0.05, 0.05), [host])
    expect(snap).not.toBeNull()
    // spacing 0.3 = 4 pitches (even), so the half-integer lane offsets are whole pitches and the origin has to
    // sit in a gap for the lanes to. (With an odd multiple it flips to a station - covered below.)
    expect(worstLaneOffGap(snap!.pose.position[0], 4, 4 * PITCH)).toBeCloseTo(0, 6)
  })

  // Origin parity depends on the spacing multiple, not just the lane count: with an even lane count and an odd
  // multiple, the half-integer lane offsets are half-pitches, so the origin must sit on a station to drop the
  // lanes into the gaps either side. A one-pitch step is always this case (the anchor-on case), and it has to
  // keep working for any multiple.
  it('an even count at an odd pitch multiple anchors on a station, and the lanes still land in gaps', () => {
    registerPackage(customChainPkg())
    registerPackage(customRollerPkg())
    const ct = customChain('ct_s', 4)
    ct.params = { ...ct.params, distance: 3 * PITCH } // authored exactly 3 pitches - an odd multiple, kept as-is
    const snap = findSnap(ct, pose(1.6, 0.78, 0.05, 0.05), [host])
    expect(snap).not.toBeNull()
    expect(snap!.paramOverrides!['distance']).toBeCloseTo(3 * PITCH, 10) // an exact multiple survives untouched
    const phase = snap!.pose.position[0] / PITCH
    expect(Math.abs(phase - Math.round(phase))).toBeCloseTo(0, 6) // origin on a station
    expect(worstLaneOffGap(snap!.pose.position[0], 4, 3 * PITCH)).toBeCloseTo(0, 6)
  })

  it('clamps the adopted spacing to the declared param range, still in whole pitches', () => {
    registerPackage(customChainPkg())
    registerPackage(customRollerPkg())
    const ct = customChain('ct_s', 3)
    ct.params = { ...ct.params, distance: 9 } // past the param's 5 m ceiling
    const snap = findSnap(ct, pose(1.6, 0.78, 0.05, 0.05), [host])
    expect(snap).not.toBeNull()
    const adopted = Number(snap!.paramOverrides!['distance'])
    expect(adopted).toBeLessThanOrEqual(5) // the declared max
    expect(adopted / PITCH).toBeCloseTo(Math.round(adopted / PITCH), 6) // …and still a whole multiple
  })

  it('fits the lane length to a wide host bed × fitWidthScale, clamped to the declared range', () => {
    registerPackage(customChainPkg())
    registerPackage(customRollerPkg())
    const wide = customRoller('rc_w', 1.5375, 0)
    wide.params = { ...wide.params, width: 1.5 }
    const snap = findSnap(customChain('ct_s', 3), pose(1.6, 0.75, 0.05, 0.05), [wide])
    expect(snap).not.toBeNull()
    expect(Number(snap!.paramOverrides!['laneLength'])).toBeCloseTo(1.5 * CHAIN_FIT_WIDTH_FACTOR, 9)
    // a very wide host clamps to the declared 3 m ceiling
    const huge = customRoller('rc_g', 1.5375, 0)
    huge.params = { ...huge.params, width: 4.2 }
    const snapH = findSnap(customChain('ct_s2', 3), pose(1.6, 0.75, 0.05, 0.05), [huge])
    expect(snapH).not.toBeNull()
    expect(Number(snapH!.paramOverrides!['laneLength'])).toBeCloseTo(3, 9)
  })

  it('picks the nearer of the two aligned yaws (0/180° flip parity)', () => {
    registerPackage(customChainPkg())
    registerPackage(customRollerPkg())
    // both valid poses are aligned with the host (0 or 180°); the drop's facing picks which. A proposal near 0
    // stays at 0.
    const fwd = findSnap(customChain('ct_s', 3), pose(1.6, 0.75, 0.05, 0.04), [host])
    expect(fwd).not.toBeNull()
    expect(Math.abs(angleDiff(fwd!.pose.rotationY, 0))).toBeCloseTo(0, 9)
    // a proposal near 180° flips to 180° (cargo enters from the other end)
    const rev = findSnap(customChain('ct_s2', 3), pose(1.6, 0.75, 0.05, Math.PI - 0.04), [host])
    expect(rev).not.toBeNull()
    expect(Math.abs(angleDiff(rev!.pose.rotationY, Math.PI))).toBeCloseTo(0, 9)
  })

  it('never anchors to a belt conveyor (no roller track), like the built-in', () => {
    registerPackage(customChainPkg())
    registerPackage(customBeltPkg())
    expect(findSnap(customChain('ct_s', 3), pose(1.6, 0.75, 0, 0), [customBelt('bc_h', 1.5375, 0)])).toBeNull()
  })

  // A negative targetLocalY recesses the part below the host bed surface - the seat a pop-up transfer needs. Its
  // conveying deck is on a lift joint, so seating it flush would put two powered surfaces on one plane: cargo
  // touches both and whichever is idle brakes it (a surface velocity of zero is a stopped belt, not neutral).
  // The committed oip.chain-transfer declares -0.03 for exactly this; guarded end-to-end through the live bake
  // path in editor/parts/bundledPackageData.test.ts, and against the demo cell in editor/demo/demoScenes.test.ts.
  it('a negative targetLocalY recesses the seat below the roller line (the pop-up rest position)', () => {
    registerPackage(customChainPkg(-0.03))
    registerPackage(customRollerPkg())
    const snap = findSnap(customChain('ct_s', 3), pose(1.6, 0.75, 0.05, 0.05), [host])
    expect(snap).not.toBeNull()
    expect(snap!.pose.position[1]).toBeCloseTo(host.position[1] - 0.03, 10)
    expect(snap!.pose.position[1]).toBeLessThan(host.position[1]) // never coplanar with the bed it sits in
    expect(snap!.junction.y).toBeCloseTo(host.position[1] - 0.03, 10)
    // the recess does not disturb the lane-parity anchor: still a gap station for an odd chain count
    expect(snap!.pose.position[0]).toBeCloseTo(1.6125, 9)
  })
})

// an SDK turntable (a rotating-deck custom part: a revolute joint drives a width-parametric cylinder deck).
// Its turntable bed surfaces the plate rim, so it snaps exactly like the built-in turntable - home-fixed straight
// ±X rim ends + left/right side-guard segments on the rim - even though it's a custom part.
function customTurntablePkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.turntable',
    name: 'Acme Turntable', conveyor: { bed: 'turntable', surface: 'roller', speedParam: 'speed' },
    params: {
      width: { type: 'number', default: 0.8 },
      deckAngleDeg: { type: 'number', default: 0 },
      speed: { type: 'number', default: 1 },
    },
    behavior: 'definePart({ joints:["rotate"], step(){} })',
    geometry: {
      kind: 'rig',
      links: [{ name: 'deck', shape: { kind: 'cylinder', radius: 0.6, height: 0.1, sizeParams: [{ axis: 0, param: 'width', scale: 0.75 }] }, offset: [0, -0.122, 0], finish: 'frame' }],
      joints: [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI }],
      bounds: { length: 1.2, width: 1.2, top: 0.6 },
    },
  } as unknown as PartPackage
}
function customTurntable(id: string, x: number, z: number, rot = 0, width = 0.8, deckAngleDeg = 0): SdkPart {
  return { id, type: 'part', packageId: 'acme.turntable', position: [x, 0.75, z], rotationY: rot, params: { width, deckAngleDeg, speed: 1 } } as unknown as SdkPart
}

describe('SDK turntable snapping (rotating-deck custom part)', () => {
  afterEach(() => clearPackages())

  // width 0.8 -> plate radius 0.6, matching the built-in turntable case: straight ±0.6 rim ends + side guards
  // on the rim (z = ±0.6) spanning the lane (x ∈ [−0.4, 0.4]), all home-fixed regardless of the previewed deck.
  it('mates a roller end to the home rim, ignoring the previewed deck angle', () => {
    registerPackage(customTurntablePkg())
    registerPackage(customRollerPkg())
    const tt = customTurntable('tt', 0, 0, 0, 0.8, 90) // deck previewed at 90°; the snap rim stays home-fixed
    const moving = customRoller('rc_m', 99, 99)
    const snap = findSnap(moving, pose(2.1, 0.75, 0.02, 0.03), [tt])
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('tt')
    expect(snap!.pose.rotationY).toBeCloseTo(0, 9)
    // the mating (near) end is on the home front rim at world x=0.6; the centre-origin roller's origin sits a
    // half-length (1.5) past it (a tail-origin roller's origin would sit on the rim)
    expect(snap!.pose.position[0]).toBeCloseTo(2.1, 9)
    expect(snap!.pose.position[2]).toBeCloseTo(0, 9)
    expect(snap!.junction.x).toBeCloseTo(0.6, 9)
    expect(snap!.junction.z).toBeCloseTo(0, 9)
  })

  it('the home rim is unaffected by the deck angle (same snap with the deck at 0)', () => {
    registerPackage(customTurntablePkg())
    registerPackage(customRollerPkg())
    const flat = customTurntable('tt', 0, 0, 0, 0.8, 0)
    const angled = customTurntable('tt', 0, 0, 0, 0.8, 135)
    const moving = customRoller('rc_m', 99, 99)
    const p = pose(2.1, 0.75, 0.02, 0.03)
    expect(findSnap(moving, p, [angled])).toEqual(findSnap(moving, p, [flat]))
  })

  it('side-merges a perpendicular roller onto the rim, body extending outward', () => {
    registerPackage(customTurntablePkg())
    registerPackage(customRollerPkg())
    const tt = customTurntable('tt', 0, 0, 0, 0.8, 0)
    const moving = customRoller('rc_m', 99, 99)
    const snap = findSnap(moving, pose(0.3, 0.75, 2.0, Math.PI / 2 - 0.1), [tt])
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('tt')
    // its front end starts 0.1 m inside the rim: pushed out through that nearest edge onto the rim, a side merge
    expect(snap!.join).toMatch(/^front -> flank:/)
    expect(snap!.pose.rotationY).toBeCloseTo(Math.PI / 2, 9)
    // held 0.1 rad off square, it squares up about its mating end, which stays where it was along the rim (the
    // origin, 1.5 m back, is what swings), not about its origin (which would slide the end along the rim)
    const heldEnd = 0.3 + 1.5 * forwardXZ(Math.PI / 2 - 0.1).x
    expect(snap!.junction.x).toBeCloseTo(heldEnd, 9)
    expect(snap!.junction.z).toBeCloseTo(0.6, 9) // the mating end is on the rim (z = +0.6)
    expect(snap!.pose.position[2]).toBeCloseTo(2.1, 9)
    const f = forwardXZ(snap!.pose.rotationY)
    // centre-origin roller: its front end is a half-length (1.5) from the origin, on the rim (z=0.6)
    expect(snap!.pose.position[2] + 1.5 * f.z).toBeCloseTo(0.6, 9)
  })
})

// a custom floor marking built on the SDK edge-to-edge kind (definePart({ snap: { tile } })). The poses below are
// pinned to 9 decimals, so any change to the solver shows as a diff. The rectangle is read from the named length/width params, so a resized instance matches; `cornerFlush` reproduces
// the overhang-a-smaller-target corner alignment.
function customMarkingPkg(id: string, length: number, width: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Marking',
    params: { length: { type: 'number', default: length }, width: { type: 'number', default: width } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length, width, top: 0.01 } },
    snap: { tile: { group: 'floorMarking', lengthParam: 'length', widthParam: 'width', cornerFlush: true } },
  } as unknown as PartPackage
}
function customMarking(id: string, packageId: string, x: number, z: number, rot: number, length: number, width: number): SdkPart {
  return { id, type: 'part', packageId, position: [x, 0, z], rotationY: rot, params: { length, width } } as unknown as SdkPart
}

describe('custom edge-to-edge snapping (declarative snap edges - floor-marking parity)', () => {
  afterEach(() => clearPackages())

  // the SDK marking snaps edge-to-edge via its declarative `edges` kind (the concrete poses below are the ones
  // the built-in floor marking produced)
  function parity(tl: number, tw: number, tx: number, tz: number, trot: number, ml: number, mw: number, p: SnapPose) {
    registerPackage(customMarkingPkg('acme.mk.t', tl, tw))
    registerPackage(customMarkingPkg('acme.mk.m', ml, mw))
    const sdk = findSnap(customMarking('m', 'acme.mk.m', 99, 99, 0, ml, mw), p, [customMarking('t', 'acme.mk.t', tx, tz, trot, tl, tw)])
    expect(sdk).not.toBeNull()
    return sdk!
  }

  it('matches the built-in edge slide', () => {
    const sdk = parity(2, 1, 0, 0, 0, 2, 1, pose(0.3, 0, 1.05, 0.08))
    expect(sdk.pose.position[2]).toBeCloseTo(1, 9) // sanity: same result the built-in slide test asserts
  })

  it('matches the built-in corner-flush placement (overhanging a smaller target)', () => {
    const sdk = parity(1, 1, 0, 0, 0, 4, 1, pose(1.9, 0, 1.06, 0))
    expect(sdk.pose.position[0]).toBeCloseTo(1.5, 9)
  })

  // Regression: the move gate is applied per candidate, not to the best-ranked one after ranking. `cost` blends
  // move with rotation, so a rotation-free candidate past the threshold can out-rank a nearer one that needs a
  // turn. Gating after ranking would then return nothing even though an in-range candidate exists.
  // These are the shipped floor marking's own dimensions (2 x 8); the drop below is 2.795 m from a valid
  // edge-flush pose, comfortably inside the 3 m gate, while the min-cost candidate is 3.29 m out.
  it('engages out to the full threshold, not to whichever candidate happened to rank first', () => {
    registerPackage(customMarkingPkg('acme.mk', 2, 8))
    const target = customMarking('t', 'acme.mk', 0, 0, 0, 2, 8)
    const drop = pose(-4.25, 0, -7.5, 0)
    const sdk = findSnap(customMarking('m', 'acme.mk', 99, 99, 0, 2, 8), drop, [target])
    expect(sdk, 'an in-range candidate must not be lost to an out-of-range one that ranked better').not.toBeNull()
    const move = Math.hypot(sdk!.pose.position[0] - drop.position[0], sdk!.pose.position[2] - drop.position[2])
    expect(move).toBeLessThanOrEqual(SNAP_VISIBLE_THRESHOLD)
    expect(move).toBeCloseTo(2.795084971874737, 9)
    // …and a drop genuinely past the gate still refuses, so the fix widened nothing
    expect(findSnap(customMarking('m', 'acme.mk', 99, 99, 0, 2, 8), pose(-4.25, 0, -9.5, 0), [target])).toBeNull()
  })

  it('only snaps within its own group - a different-group tile part is inert', () => {
    registerPackage(customMarkingPkg('acme.mk.m', 2, 1))
    registerPackage({ ...customMarkingPkg('acme.other', 2, 1), snap: { tile: { group: 'deck', lengthParam: 'length', widthParam: 'width' } } } as unknown as PartPackage)
    const moving = customMarking('m', 'acme.mk.m', 99, 99, 0, 2, 1)
    const target = customMarking('t', 'acme.other', 0, 0, 0, 2, 1)
    expect(findSnapToTarget(moving, pose(0.3, 0, 1.05, 0), target)).toBeNull()
  })
})

// a custom platform deck on the same edge-to-edge kind, cornerFlush omitted - the deck snap is the marking snap
// without the corner spots, so one kind covers both families. Decks end up coplanar (y := target y).
function customDeckPkg(id: string, length: number, width: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Deck',
    params: { length: { type: 'number', default: length }, width: { type: 'number', default: width } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length, width, top: 2 } },
    snap: { tile: { group: 'platformDeck', lengthParam: 'length', widthParam: 'width' } }, // no cornerFlush
  } as unknown as PartPackage
}
function customDeck(id: string, packageId: string, x: number, z: number, rot: number, length: number, width: number, y = 2): SdkPart {
  return { id, type: 'part', packageId, position: [x, y, z], rotationY: rot, params: { length, width } } as unknown as SdkPart
}

describe('custom deck edge-to-edge (platform-to-platform parity, cornerFlush off)', () => {
  afterEach(() => clearPackages())

  function parity(size: number, tx: number, tz: number, trot: number, drop: SnapPose) {
    registerPackage(customDeckPkg('acme.deck', size, size))
    const sdk = findSnap(customDeck('m', 'acme.deck', 99, 99, 0, size, size), drop, [customDeck('t', 'acme.deck', tx, tz, trot, size, size)])
    expect(sdk).not.toBeNull()
    return sdk!
  }

  it('matches the built-in deck edge slide, landing coplanar', () => {
    const sdk = parity(4, 0, 0, 0, pose(4.1, 2, 0.2, 0.05))
    expect(sdk.pose.position[0]).toBeCloseTo(4, 9) // flush against the +X edge
    expect(sdk.pose.position[1]).toBeCloseTo(2, 9) // deck coplanar at the target Y
  })
})

// a custom barrier on the SDK chain kind (definePart({ snap: { chain } })) - a linear part that extends
// collinearly or forms an L-corner, sharing one post at the corner via the omit-post handshake. It must snap
// byte-identically to the built-in guard rail, including the paramOverrides / targetParamOverrides. `group`
// carries the family rule (guard rails vs the fence family); `reach` the engage distance.
function customBarrierPkg(id: string, length: number, reach: number, group = 'guardRail'): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Barrier',
    params: {
      length: { type: 'number', default: length },
      omitPostStart: { type: 'boolean', default: false },
      omitPostEnd: { type: 'boolean', default: false },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length, width: 0.1, top: 1 } },
    snap: { chain: { group, lengthParam: 'length', reach, omitStartParam: 'omitPostStart', omitEndParam: 'omitPostEnd' } },
  } as unknown as PartPackage
}
function customBarrier(id: string, packageId: string, x: number, z: number, rot: number, length: number, y = 0): SdkPart {
  return { id, type: 'part', packageId, position: [x, y, z], rotationY: rot, params: { length, omitPostStart: false, omitPostEnd: false } } as unknown as SdkPart
}

describe('custom chain snapping (barrier end-to-end + L-corner parity)', () => {
  afterEach(() => clearPackages())

  // the SDK barrier chains end-to-end + L-corner via its declarative `chain` block (the concrete poses below
  // are the ones the built-in guard rail produced)
  function parityRail(drop: SnapPose, len = 2) {
    registerPackage(customBarrierPkg('acme.barrier', len, SNAP_VISIBLE_THRESHOLD))
    const sdk = findSnap(customBarrier('m', 'acme.barrier', 99, 99, 0, len), drop, [customBarrier('t', 'acme.barrier', 0, 0, 0, len)])
    expect(sdk).not.toBeNull()
    return sdk!
  }

  it('matches the built-in collinear extension + reset omit flags', () => {
    const sdk = parityRail(pose(2.3, 0, 0.1, 0.05))
    expect(sdk.pose.position[0]).toBeCloseTo(2, 9)
    expect(sdk.paramOverrides).toEqual({ omitPostStart: false, omitPostEnd: false })
    expect(sdk.targetParamOverrides).toBeUndefined()
  })

  it('matches the built-in L-corner (omit the mating post, target un-omits its shared end)', () => {
    const sdk = parityRail(pose(1.2, 0, 1.1, Math.PI / 2 - 0.1))
    expect(sdk.pose.rotationY).toBeCloseTo(Math.PI / 2, 9)
    expect(sdk.paramOverrides).toEqual({ omitPostStart: false, omitPostEnd: true })
    expect(sdk.targetParamOverrides).toEqual({ omitPostEnd: false })
  })

  it('matches the built-in L-corner at the other target end (omits the start post instead)', () => {
    const sdk = parityRail(pose(-1.1, 0, -1.2, Math.PI / 2 + 0.1))
    expect(sdk.paramOverrides).toEqual({ omitPostStart: true, omitPostEnd: false })
    expect(sdk.targetParamOverrides).toEqual({ omitPostStart: false })
  })

  it('honours the declared reach - a fence-tight reach refuses a drop a guard-rail reach would take', () => {
    registerPackage(customBarrierPkg('acme.fence', 2, SNAP_FENCE_VISIBLE_THRESHOLD, 'barrierFence'))
    registerPackage(customBarrierPkg('acme.rail', 2, SNAP_VISIBLE_THRESHOLD))
    const drop = pose(3.5, 0, 0, 0)
    expect(findSnapToTarget(customBarrier('m', 'acme.fence', 99, 99, 0, 2), drop, customBarrier('t', 'acme.fence', 0, 0, 0, 2))).toBeNull()
    expect(findSnapToTarget(customBarrier('m', 'acme.rail', 99, 99, 0, 2), drop, customBarrier('t', 'acme.rail', 0, 0, 0, 2))).not.toBeNull()
  })

  it('never chains across groups (a guard rail and a fence do not join)', () => {
    registerPackage(customBarrierPkg('acme.rail', 2, SNAP_VISIBLE_THRESHOLD))
    registerPackage(customBarrierPkg('acme.fence', 2, SNAP_VISIBLE_THRESHOLD, 'barrierFence'))
    const moving = customBarrier('m', 'acme.rail', 99, 99, 0, 2)
    expect(findSnapToTarget(moving, pose(2.3, 0, 0, 0), customBarrier('t', 'acme.fence', 0, 0, 0, 2))).toBeNull()
  })
})

// a custom barrier seating along a host deck edge (definePart({ snap: { edgeMount } })), and a custom platform
// advertising the deck as a `surfaces` entry of kind 'deck' (the host half). Together they must reproduce the
// built-in barrier-to-platform snap: flush on the nearest edge, +X along it, guard rails nudged out a half-post.
function customEdgeMountPkg(id: string, length: number, reach: number, outwardOffset?: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Edge Mount',
    params: { length: { type: 'number', default: length } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length, width: 0.1, top: 1 } },
    snap: { edgeMount: { accepts: 'deck', alongParam: 'length', reach, ...(outwardOffset !== undefined ? { outwardOffset } : {}) } },
  } as unknown as PartPackage
}
function customEdgeMount(id: string, packageId: string, x: number, z: number, rot: number, length: number): SdkPart {
  return { id, type: 'part', packageId, position: [x, 0, z], rotationY: rot, params: { length } } as unknown as SdkPart
}
function customDeckHostPkg(id: string, length: number, width: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Deck Host',
    params: { length: { type: 'number', default: length }, width: { type: 'number', default: width } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length, width, top: 2 } },
    snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width' }] },
  } as unknown as PartPackage
}
function customDeckHost(id: string, packageId: string, x: number, z: number, rot: number, length: number, width: number, y = 2): SdkPart {
  return { id, type: 'part', packageId, position: [x, y, z], rotationY: rot, params: { length, width } } as unknown as SdkPart
}

// the oip.guard-rail post size - the half-post outward nudge a rail-style mount models
const GUARD_RAIL_POST_SIZE = 0.04

describe('custom edge-mount (barrier-to-deck-edge parity)', () => {
  afterEach(() => clearPackages())

  it('a guard-rail-style mount lands flush on the deck edge nudged out a half-post', () => {
    registerPackage(customEdgeMountPkg('acme.railmount', 4, SNAP_VISIBLE_THRESHOLD, GUARD_RAIL_POST_SIZE / 2))
    registerPackage(customDeckHostPkg('acme.deck', 4, 4))
    const drop = pose(2.1, 2, 0, Math.PI / 2)
    const sdk = findSnap(customEdgeMount('m', 'acme.railmount', 99, 99, 0, 4), drop, [customDeckHost('t', 'acme.deck', 0, 0, 0, 4, 4)])
    expect(sdk).not.toBeNull()
    expect(sdk!.pose.position[0]).toBeCloseTo(2 + GUARD_RAIL_POST_SIZE / 2, 9) // flush on the edge, nudged out the half-post
    expect(sdk!.pose.position[1]).toBeCloseTo(2, 9)
    expect(sdk!.pose.position[2]).toBeCloseTo(0, 9)
    expect(Math.abs(angleDiff(sdk!.pose.rotationY, Math.PI / 2))).toBeCloseTo(0, 9)
  })

  it('a fence-style mount seats flush with no nudge and slides along the edge', () => {
    registerPackage(customEdgeMountPkg('acme.fencemount', 2, SNAP_FENCE_VISIBLE_THRESHOLD)) // no outwardOffset
    registerPackage(customDeckHostPkg('acme.deck', 4, 4))
    const drop = pose(2.05, 2, 0.5, Math.PI / 2)
    const sdk = findSnap(customEdgeMount('m', 'acme.fencemount', 99, 99, 0, 2), drop, [customDeckHost('t', 'acme.deck', 0, 0, 0, 4, 4)])
    expect(sdk).not.toBeNull()
    expect(sdk!.pose.position[0]).toBeCloseTo(2, 9) // flush on the edge, no nudge
    expect(sdk!.pose.position[2]).toBeCloseTo(0.5, 9) // slid along to the cursor
    expect(sdk!.paramOverrides).toBeUndefined()
  })

  // Regression: a mover too wide for the edge has an empty slide range. Clamping to its half-extent would pin its
  // centre on the far corner and hang the whole part off that end; it centres on the edge instead.
  it('a mover wider than the deck edge centres on it instead of hanging off one end', () => {
    registerPackage(customEdgeMountPkg('acme.longrail', 6, SNAP_VISIBLE_THRESHOLD)) // no outwardOffset
    registerPackage(customDeckHostPkg('acme.smalldeck', 2, 2))
    const drop = pose(0, 2, 1.05, 0)
    const sdk = findSnap(customEdgeMount('m', 'acme.longrail', 99, 99, 0, 6), drop, [customDeckHost('t', 'acme.smalldeck', 0, 0, 0, 2, 2)])
    expect(sdk).not.toBeNull()
    expect(sdk!.pose.position[0], 'centred on the 2 m edge, not pinned at its far corner (x=2)').toBeCloseTo(0, 9)
    expect(sdk!.pose.position[2]).toBeCloseTo(1, 9)
    expect(sdk!.junction.x).toBeCloseTo(0, 9)
  })

  it('an edge-mount is inert against a host with no matching deck surface', () => {
    registerPackage(customEdgeMountPkg('acme.railmount', 4, SNAP_VISIBLE_THRESHOLD, GUARD_RAIL_POST_SIZE / 2))
    registerPackage({ ...customDeckHostPkg('acme.notdeck', 4, 4), snap: { surfaces: [{ kind: 'somethingElse', lengthParam: 'length', widthParam: 'width' }] } } as unknown as PartPackage)
    expect(findSnapToTarget(customEdgeMount('m', 'acme.railmount', 99, 99, 0, 4), pose(2.1, 2, 0, Math.PI / 2), customDeckHost('t', 'acme.notdeck', 0, 0, 0, 4, 4))).toBeNull()
  })
})

// a custom staircase seating its top against a host deck edge (an edgeMount facing into the deck), sized to
// the deck height - the SDK twin of the built-in stairs-to-platform snap. The host is
// customDeckHostPkg with a heightParam (below). The flight's origin is its foot and it rises along local +X, so
// the snap seats the foot `numSteps*tread` outward from the edge, the top on the edge at the deck height.
function customStairPkg(id: string): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Stairs',
    params: {
      numSteps: { type: 'number', default: 11, min: 2, max: 40, step: 1 },
      width: { type: 'number', default: 1.2, min: 0.4, max: 4 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 3.18, width: 1.4, top: 3 } },
    snap: { edgeMount: { accepts: 'deck', alongParam: 'width', reach: 3, facing: 'into', at: [0, 0, 0], atParams: [{ axis: 0, param: 'numSteps', scale: 0.28 }, { axis: 1, param: 'numSteps', scale: 0.178 }], fromFloor: { param: 'numSteps' }, opens: true, notch: true, lift: true } },
  } as unknown as PartPackage
}
function customStair(id: string, packageId: string, x: number, z: number, rot: number, numSteps: number, width = 1.2, y = 0): SdkPart {
  return { id, type: 'part', packageId, position: [x, y, z], rotationY: rot, params: { numSteps, width } } as unknown as SdkPart
}
// a deck host that advertises its height (the platform half of the stairs snap)
function customDeckHostWithHeightPkg(id: string, length: number, width: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Acme Deck Host (with height)',
    params: { length: { type: 'number', default: length }, width: { type: 'number', default: width }, height: { type: 'number', default: 2 } },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length, width, top: 2 } },
    snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width', heightParam: 'height' }] },
  } as unknown as PartPackage
}
function customDeckHostH(id: string, packageId: string, x: number, z: number, rot: number, length: number, width: number, height: number): SdkPart {
  // the platform origin sits at its deck top (world y = height when resting on the floor)
  return { id, type: 'part', packageId, position: [x, height, z], rotationY: rot, params: { length, width, height } } as unknown as SdkPart
}

describe('custom stair-mount (stairs-to-platform parity)', () => {
  afterEach(() => clearPackages())
  const RISE = STAIRS_STANDARD_RISE
  const TREAD = STAIRS_STANDARD_TREAD

  it('seats the flight top on the nearest deck edge, foot on the floor, sized to the deck', () => {
    registerPackage(customStairPkg('acme.stairs'))
    registerPackage(customDeckHostWithHeightPkg('acme.deck', 4, 4))
    // 4×4 deck, height 2 → floor at y=0, deck top at y=2. Steps = round(2/0.178) = 11; run = 11*0.28 = 3.08.
    const steps = Math.round(2 / RISE) // 11
    const run = steps * TREAD
    const stair = customStair('m', 'acme.stairs', 99, 99, 0, 5) // start at 5 steps so the override fires
    const sdk = findSnap(stair, pose(4.8, 0, 0, 0), [customDeckHostH('t', 'acme.deck', 0, 0, 0, 4, 4, 2)])
    expect(sdk).not.toBeNull()
    // foot sits `run` outward from the +X edge (x=2), the top on the edge
    expect(sdk!.pose.position[0]).toBeCloseTo(2 + run, 9)
    expect(sdk!.pose.position[1]).toBeCloseTo(0, 9) // foot on the deck's floor
    expect(sdk!.pose.position[2]).toBeCloseTo(0, 9)
    // local +X points into the deck (−X world) → yaw = π
    expect(Math.abs(angleDiff(sdk!.pose.rotationY, Math.PI))).toBeCloseTo(0, 9)
    expect(forwardXZ(sdk!.pose.rotationY).x).toBeCloseTo(-1, 9)
    // sized to the deck: numSteps overridden to 11
    expect(sdk!.paramOverrides).toEqual({ numSteps: steps })
    // the snap cue sits on the deck edge at the deck top
    expect(sdk!.junction.y).toBeCloseTo(2, 9)
  })

  it('slides the flight along the edge and clamps within it by half the width', () => {
    registerPackage(customStairPkg('acme.stairs'))
    registerPackage(customDeckHostWithHeightPkg('acme.deck', 4, 4))
    const host = customDeckHostH('t', 'acme.deck', 0, 0, 0, 4, 4, 2)
    // drop offset along +Z: seats mid-edge at that z
    const mid = findSnap(customStair('m', 'acme.stairs', 99, 99, 0, 11), pose(4.8, 0, 1.0, 0), [host])
    expect(mid!.pose.position[2]).toBeCloseTo(1.0, 9)
    // drop past the edge end: clamped to (edge half − width/2) = 2 − 0.6 = 1.4
    const clamped = findSnap(customStair('m', 'acme.stairs', 99, 99, 0, 11), pose(4.8, 0, 1.9, 0), [host])
    expect(clamped!.pose.position[2]).toBeCloseTo(2 - 1.2 / 2, 9)
  })

  it('sizes the flight to a shorter deck (fewer steps)', () => {
    registerPackage(customStairPkg('acme.stairs'))
    registerPackage(customDeckHostWithHeightPkg('acme.deck1', 4, 4))
    const steps = Math.round(1 / RISE) // 6
    const sdk = findSnap(customStair('m', 'acme.stairs', 99, 99, 0, 11), pose(4, 0, 0, 0), [customDeckHostH('t', 'acme.deck1', 0, 0, 0, 4, 4, 1)])
    expect(sdk!.paramOverrides).toEqual({ numSteps: steps })
    expect(sdk!.pose.position[0]).toBeCloseTo(2 + steps * TREAD, 9)
    expect(sdk!.pose.position[1]).toBeCloseTo(0, 9) // foot still on the deck's floor (deckTop 1 − height 1)
  })

  // The same empty-slide-range case as the edge-mount above, through the stair seat: a flight wider than the
  // edge it seats on must not seat flush to the edge's far corner with the whole flight past it.
  it('centres a flight wider than the deck edge it lands on', () => {
    registerPackage(customStairPkg('acme.stairs'))
    registerPackage(customDeckHostWithHeightPkg('acme.narrowdeck', 4, 1))
    const steps = Math.round(2 / RISE) // 11
    // a 4×1 deck: its +X edge runs just 1 m along Z, narrower than the 2 m flight
    const host = customDeckHostH('t', 'acme.narrowdeck', 0, 0, 0, 4, 1, 2)
    const sdk = findSnap(customStair('m', 'acme.stairs', 99, 99, 0, steps, 2), pose(4.8, 0, 0, 0), [host])
    expect(sdk).not.toBeNull()
    expect(sdk!.pose.position[0]).toBeCloseTo(2 + steps * TREAD, 9)
    expect(sdk!.pose.position[2], 'centred on the 1 m edge, not flush to its corner (z=0.5)').toBeCloseTo(0, 9)
    expect(sdk!.junction.z).toBeCloseTo(0, 9)
  })

  it('is inert against a deck that advertises no height, and out of reach', () => {
    registerPackage(customStairPkg('acme.stairs'))
    // a deck host without a heightParam can't size a flight → no snap
    registerPackage({ ...customDeckHostWithHeightPkg('acme.noheight', 4, 4), snap: { surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width' }] } } as unknown as PartPackage)
    expect(findSnapToTarget(customStair('m', 'acme.stairs', 99, 99, 0, 11), pose(4.8, 0, 0, 0), customDeckHostH('t', 'acme.noheight', 0, 0, 0, 4, 4, 2))).toBeNull()
    // a valid deck but the drop is well beyond `reach` of the resolved foot
    registerPackage(customDeckHostWithHeightPkg('acme.deck', 4, 4))
    expect(findSnapToTarget(customStair('m', 'acme.stairs', 99, 99, 0, 11), pose(9.5, 0, 0, 0), customDeckHostH('t', 'acme.deck', 0, 0, 0, 4, 4, 2))).toBeNull()
  })
})

// cargo (box / pallet) is an SDK custom part whose package declares geometry.kind:'cargo'. Cargo carries no
// snap block, so it must never snap to a conveyor.
function cargoPkg(id: string, cargoKind: 'box' | 'pallet', size: { length: number; width: number; height: number }): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: cargoKind === 'box' ? 'Box' : 'Pallet',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'cargo', cargoKind, size },
  } as unknown as PartPackage
}

describe('non-snapping parts', () => {
  afterEach(() => clearPackages())
  it('cargo (box / pallet) never snaps to a conveyor', () => {
    registerPackage(customBeltPkg())
    registerPackage(cargoPkg('oip.box', 'box', { length: 0.6, width: 0.4, height: 0.4 }))
    registerPackage(cargoPkg('oip.pallet', 'pallet', { length: 1.22, width: 1.02, height: 0.135 }))
    const conveyor = customBelt('rc_t', 1.5375, 0)
    const box: SdkPart = { id: 'bx_m', type: 'part', packageId: 'oip.box', position: [0, 0.2, 0], rotationY: 0, params: {} } as unknown as SdkPart
    expect(findSnap(box, pose(3.05, 0.75, 0, 0), [conveyor])).toBeNull()
    const pallet: SdkPart = { id: 'pl_m', type: 'part', packageId: 'oip.pallet', position: [0, 0.072, 0], rotationY: 0, params: {} } as unknown as SdkPart
    expect(findSnap(pallet, pose(3.05, 0.75, 0, 0), [conveyor])).toBeNull()
  })
})

// --- the face engine: implicit footprint faces ------------------------------------------------------------

// a box-shaped part; `flush` declares ambient face-flush (snap: { flush: true } - the tiling declaration).
// Without it the part never flushes ambiently - ambient snapping is declared intent, never inferred.
function cratePkg(id: string, length: number, width: number, height: number, flush = false): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Crate',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length, width, top: height } },
    ...(flush ? { snap: { flush: true } } : {}),
  } as unknown as PartPackage
}
function crate(id: string, pkg: string, x: number, y: number, z: number, rot = 0): SdkPart {
  return { id, type: 'part', packageId: pkg, position: [x, y, z], rotationY: rot, params: {} } as unknown as SdkPart
}

describe('ambient face-flush (declared: snap.flush - the tiling snap)', () => {
  afterEach(() => clearPackages())

  it('lands a crate flush against a neighbour face, sliding along it, Y kept, yaw 90°-stepped', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    const target = crate('t', 'acme.crate', 0, 0, 0)
    const snap = findSnap(crate('m', 'acme.crate', 99, 0, 99), pose(1.1, 0, 0.2, 0.1), [target])
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('t')
    expect(snap!.pose.position[0]).toBeCloseTo(1.0, 6) // faces butt: 0.5 + 0.5
    expect(snap!.pose.position[1]).toBeCloseTo(0, 9) // Y kept - the floor/leg resolvers own height
    expect(snap!.pose.position[2]).toBeCloseTo(0.2, 6) // slides along the face with the drop
    expect(snap!.pose.rotationY).toBeCloseTo(0, 9) // nearest 90° step of the target yaw
    expect(snap!.junction.x).toBeCloseTo(0.5, 6) // cue on the shared face plane
    expect(snap!.attach).toBeUndefined() // flush is a sibling arrangement, never an attachment
  })

  it('keeps the drop facing: a mover near 90° snaps to the 90° step, and a rotated target sets the grid', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    const t0 = crate('t', 'acme.crate', 0, 0, 0)
    const s0 = findSnap(crate('m', 'acme.crate', 99, 0, 99), pose(1.1, 0, 0.0, Math.PI / 2 + 0.1), [t0])
    expect(s0).not.toBeNull()
    expect(Math.abs(angleDiff(s0!.pose.rotationY, Math.PI / 2))).toBeLessThan(1e-9)
    const t1 = crate('t1', 'acme.crate', 0, 0, 0, 0.4)
    const s1 = findSnap(crate('m', 'acme.crate', 99, 0, 99), pose(1.1, 0, 0.3, 0.35), [t1])
    expect(s1).not.toBeNull()
    expect(Math.abs(angleDiff(s1!.pose.rotationY, 0.4))).toBeLessThan(1e-9)
  })

  it('offers corner-flush: a wider mover overhanging the target aligns the shared corner', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    registerPackage(cratePkg('acme.wide', 1, 2, 1, true))
    const target = crate('t', 'acme.crate', 0, 0, 0)
    const snap = findSnap(crate('m', 'acme.wide', 99, 0, 99), pose(1.1, 0, 0.9, 0), [target])
    expect(snap).not.toBeNull()
    expect(snap!.pose.position[0]).toBeCloseTo(1.0, 6)
    // mover half-width 1 vs target face half 0.5: centred at z=0.5 the mover spans −0.5..1.5, sharing the
    // target's z=−0.5 corner
    expect(snap!.pose.position[2]).toBeCloseTo(0.5, 6)
  })

  it('requires vertical overlap: a box on another storey that only lines up in plan never engages', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    const target = crate('t', 'acme.crate', 0, 0, 0)
    expect(findSnap(crate('m', 'acme.crate', 99, 5, 99), pose(1.1, 5, 0.2, 0), [target])).toBeNull()
  })

  it('uses the tight face gate, not the 3 m structural gate: a distant box never leaps', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    const target = crate('t', 'acme.crate', 0, 0, 0)
    expect(findSnap(crate('m', 'acme.crate', 99, 0, 99), pose(2.6, 0, 0, 0), [target])).toBeNull()
  })

  it('flushes against a conveyor flank only while clear of the bed (spawners hovering over it never grab)', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    registerPackage(customRollerPkg())
    const target = customRoller('rc_t', 0, 0) // centre-origin bed x ±1.5, z ±0.3; faces span world y 0.35..0.8
    // beside the bed: the crate butts the flank face like any other part (z = 0.3 + 0.5)
    const beside = findSnap(crate('m', 'acme.crate', 99, 0.4, 99), pose(0, 0.4, 0.9, 0), [target])
    expect(beside).not.toBeNull()
    expect(beside!.pose.position[2]).toBeCloseTo(0.8, 6)
    expect(beside!.pose.position[1]).toBeCloseTo(0.4, 9) // Y kept - the crate stays on the floor
    // Over the bed (overlapping in plan): never pulled to the flank; the hover/drop-on-belt flows apply
    expect(findSnap(crate('m', 'acme.crate', 99, 0.75, 99), pose(0, 0.75, 0.1, 0), [target])).toBeNull()
  })

  it('an inclined bed grows its faces with the tilt, so a low box flushes where a flat bed is out of reach', () => {
    registerPackage(cratePkg('acme.lowbox', 1, 1, 0.3, true))
    registerPackage(customRollerPkg())
    const base = customRollerPkg() as unknown as { geometry: object }
    registerPackage({
      ...base,
      id: 'acme.roller-inc',
      geometry: { ...base.geometry, inclineParam: 'tiltDeg' },
    } as unknown as PartPackage)
    const flat = customRoller('flat', 0, 0) // frame bottom at world y 0.35
    const inc: SdkPart = { id: 'inc', type: 'part', packageId: 'acme.roller-inc', position: [0, 0.75, 0], rotationY: 0, params: { length: 3, width: 0.6, speed: 0.5, tiltDeg: 15 } } as unknown as SdkPart
    const mover = crate('m', 'acme.lowbox', 99, 0, 99) // a 0.3 m box on the floor
    // flat bed: the frame face floats above the low box - no vertical overlap, no flush
    expect(findSnap(mover, pose(0, 0, 0.9, 0), [flat])).toBeNull()
    // 15° incline: the footprint's Y extent grows by hx·sin(tilt) both ways, reaching the floor - it flushes
    const snap = findSnap(mover, pose(0, 0, 0.9, 0), [inc])
    expect(snap).not.toBeNull()
    expect(snap!.pose.position[2]).toBeCloseTo(0.8, 6) // flank face 0.3 + box half-width 0.5
    expect(snap!.pose.position[1]).toBeCloseTo(0, 9) // the box stays on the floor
  })

  it('the caller can switch the fallback off (opts.faceFlush) without touching declared mounts', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    registerPackage(buttonPkg())
    const target = crate('t', 'acme.crate', 0, 0, 0)
    const mover = crate('m', 'acme.crate', 99, 0, 99)
    expect(findSnap(mover, pose(1.1, 0, 0.2, 0), [target], { faceFlush: false })).toBeNull()
    expect(findSnap(mover, pose(1.1, 0, 0.2, 0), [target], { faceFlush: true })).not.toBeNull()
    // a 'face' mount is a declared snap - the flush toggle does not gate it
    expect(findSnap(button('b'), pose(0.9, 0.5, 0.1, 0), [target], { faceFlush: false })).not.toBeNull()
  })

  it('an undeclared mover never flushes - ambient snapping is declared intent, silence is not consent', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1, true))
    registerPackage(cratePkg('acme.plain', 1, 1, 1)) // byte-identical geometry, no snap.flush
    const target = crate('t', 'acme.crate', 0, 0, 0)
    // the exact drop that flushes a declared crate does nothing for an undeclared one (its author never
    // opted in; the explicit hold-B Face mode is the path for it instead)
    expect(findSnap(crate('m', 'acme.plain', 99, 0, 99), pose(1.1, 0, 0.2, 0), [target])).toBeNull()
    expect(findSnap(crate('m', 'acme.crate', 99, 0, 99), pose(1.1, 0, 0.2, 0), [target])).not.toBeNull()
  })
})

// an SDK button: a 'face' mount - back plate at −Z, front (+Z) looks out, attaches to its host
function buttonPkg(id = 'acme.button', attach = true): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Button',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 0.18, width: 0.12, top: 0.18 } },
    snap: { mounts: [{ at: [0, 0.09, -0.06], accepts: 'face', face: 'out', ...(attach ? { attach: true } : {}) }] },
  } as unknown as PartPackage
}
function button(id: string, pkg = 'acme.button'): SdkPart {
  return { id, type: 'part', packageId: pkg, position: [99, 0, 99], rotationY: 0, params: {} } as unknown as SdkPart
}

describe("'face' mounts (a button onto any part's implicit footprint faces)", () => {
  afterEach(() => clearPackages())

  it('seats the back plate on the nearest face, facing out, at the drag height, and attaches', () => {
    registerPackage(cratePkg('acme.cabinet', 1, 1, 2))
    registerPackage(buttonPkg())
    const cab = crate('cab', 'acme.cabinet', 0, 0, 0) // faces span y 0..2
    const snap = findSnap(button('b'), pose(0.9, 1.2, 0.1, 0), [cab])
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('cab')
    expect(snap!.attach).toBe(true) // the commit soft-parents the button under the cabinet
    // +X face: back plate (local z −0.06) on the plane x=0.5, mount point at the drag height 1.2+0.09
    expect(snap!.pose.rotationY).toBeCloseTo(Math.PI / 2, 9) // local +Z = the face outward (+X)
    expect(snap!.pose.position[0]).toBeCloseTo(0.56, 6)
    expect(snap!.pose.position[1]).toBeCloseTo(1.2, 6)
    expect(snap!.pose.position[2]).toBeCloseTo(0.1 - 0.06, 6) // the seat steered by the mount point
    expect(snap!.junction.x).toBeCloseTo(0.5, 6)
    expect(snap!.junction.y).toBeCloseTo(1.29, 6)
    // the seated back plate lies exactly on the face plane
    const seated = { ...button('b'), position: snap!.pose.position, rotationY: snap!.pose.rotationY } as SdkPart
    const plate = toWorldXZ(seated, 0, -0.06)
    expect(toLocalXZ(cab, plate.x, plate.z).x).toBeCloseTo(0.5, 6)
  })

  it('clamps the seat height to the face rect (a drag above the cabinet pins to its top edge)', () => {
    registerPackage(cratePkg('acme.cabinet', 1, 1, 2))
    registerPackage(buttonPkg())
    const cab = crate('cab', 'acme.cabinet', 0, 0, 0)
    expect(findSnap(button('b'), pose(0.9, 5, 0.1, 0), [cab])).toBeNull() // 3-D gate: y 5 is out of reach of a face topping out at 2
    const nearTop = findSnap(button('b'), pose(0.9, 2.3, 0.1, 0), [cab])
    expect(nearTop).not.toBeNull()
    expect(nearTop!.pose.position[1]).toBeCloseTo(2 - 0.09, 6) // mount point clamped to the top edge
    const low = findSnap(button('b'), pose(0.9, -0.4, 0.1, 0), [cab])
    expect(low).not.toBeNull()
    expect(low!.pose.position[1]).toBeCloseTo(-0.09, 6) // clamped to the bottom edge
  })

  it('slides along the face with the drag', () => {
    registerPackage(cratePkg('acme.cabinet', 1, 1, 2))
    registerPackage(buttonPkg())
    const cab = crate('cab', 'acme.cabinet', 0, 0, 0)
    const snap = findSnap(button('b'), pose(0.9, 1, 0.3, 0), [cab])
    expect(snap).not.toBeNull()
    expect(snap!.pose.position[2]).toBeCloseTo(0.3 - 0.06, 6)
  })

  it('also mounts on a conveyor face (an e-stop on the frame), and stays pose-only without `attach`', () => {
    registerPackage(customRollerPkg())
    registerPackage(buttonPkg('acme.button2', false))
    const host = customRoller('rc_t', 0, 0) // faces span world y 0.35..0.8
    const snap = findSnap(button('b', 'acme.button2'), pose(0, 0.5, 0.7, 0), [host])
    expect(snap).not.toBeNull()
    expect(snap!.targetId).toBe('rc_t')
    expect(snap!.attach).toBeUndefined()
  })
})

/** apply a YXZ euler (the scene's rotation order) to a vector - for asserting where an aligned axis went */
function applyYXZ(e: { x: number; y: number; z: number }, v: [number, number, number]): [number, number, number] {
  // Rz, then Rx, then Ry
  let [x, y, z] = v
  let c = Math.cos(e.z)
  let s = Math.sin(e.z)
  ;[x, y] = [x * c - y * s, x * s + y * c]
  c = Math.cos(e.x)
  s = Math.sin(e.x)
  ;[y, z] = [y * c - z * s, y * s + z * c]
  c = Math.cos(e.y)
  s = Math.sin(e.y)
  ;[x, z] = [x * c + z * s, -x * s + z * c]
  return [x, y, z]
}

describe('surfaceAlignPose (the Shift+G + Alt face snap, collision-reposition alignment)', () => {
  afterEach(() => clearPackages())

  it('an inclined bed tilts the part flat onto it - the local +Y turns onto the normal (rotationZ = tilt)', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1))
    const mover = crate('m', 'acme.crate', 5, 0, 5)
    const n: [number, number, number] = [-Math.sin(Math.PI / 12), Math.cos(Math.PI / 12), 0] // 15° bed top
    const p = surfaceAlignPose(mover, [0.5, 0.9, 5], n, 1, 0)
    expect(p.rotationZ).toBeCloseTo(Math.PI / 12, 6) // the box pitches 15° to lie flat on the rollers
    expect(p.rotationX).toBeCloseTo(0, 9)
    expect(p.rotationY).toBeCloseTo(0, 9)
    // flat contact: the bottom face lies on the plane, so the bottom-origin box sits exactly at the pick
    expect(p.position[0]).toBeCloseTo(0.5, 6)
    expect(p.position[1]).toBeCloseTo(0.9, 6)
    expect(p.position[2]).toBeCloseTo(5, 6)
    // and the aligned local +Y really points along the surface normal
    const up = applyYXZ({ x: p.rotationX!, y: p.rotationY, z: p.rotationZ! }, [0, 1, 0])
    expect(up[0]).toBeCloseTo(n[0], 6)
    expect(up[1]).toBeCloseTo(n[1], 6)
    expect(up[2]).toBeCloseTo(n[2], 6)
  })

  it('default +Y axis on a wall lies the part onto the wall (its up = the wall normal), at the pick', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1))
    const mover = crate('m', 'acme.crate', 5, 0, 5)
    const p = surfaceAlignPose(mover, [0.5, 1.2, 0.1], [1, 0, 0], 1, 0)
    const up = applyYXZ({ x: p.rotationX!, y: p.rotationY, z: p.rotationZ! }, [0, 1, 0])
    expect(up[0]).toBeCloseTo(1, 6)
    expect(up[1]).toBeCloseTo(0, 6)
    expect(up[2]).toBeCloseTo(0, 6)
    // the bottom-origin box's bottom face is on the wall plane → origin at the pick
    expect(p.position[0]).toBeCloseTo(0.5, 6)
    expect(p.position[1]).toBeCloseTo(1.2, 6)
    expect(p.position[2]).toBeCloseTo(0.1, 6)
  })

  it('±Z axes stand the part upright against a wall, facing along ±normal (the button orientation)', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1))
    const mover = crate('m', 'acme.crate', 5, 0, 5)
    // axis 2 (+Z): front into the normal direction → upright, yaw +90°, no tilt, backed off by half-depth
    const plusZ = surfaceAlignPose(mover, [0.5, 1, 0], [1, 0, 0], 2, 0)
    expect(plusZ.rotationY).toBeCloseTo(Math.PI / 2, 9)
    expect(plusZ.rotationX).toBeCloseTo(0, 9)
    expect(plusZ.rotationZ).toBeCloseTo(0, 9)
    expect(plusZ.position[0]).toBeCloseTo(1.0, 6) // 0.5 + half-depth 0.5
    // axis 5 (−Z): the part's back into the normal - mirrored yaw
    const minusZ = surfaceAlignPose(mover, [0.5, 1, 0], [1, 0, 0], 5, 0)
    expect(minusZ.rotationY).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('surfaceRestPose seats the current orientation: flush on a flat plane, corner-first on a tilt', () => {
    registerPackage(cargoPkg('oip.box2', 'box', { length: 0.6, width: 0.4, height: 0.4 })) // centre-origin ±0.2 Y
    const box: SdkPart = { id: 'b', type: 'part', packageId: 'oip.box2', position: [9, 9, 9], rotationY: 0, params: {} } as unknown as SdkPart
    // flat plane: the underside sits exactly flush (origin half-height above the plane point)
    const flat = surfaceRestPose(box, [1, 0.75, 2], [0, 1, 0])
    expect(flat[0]).toBeCloseTo(1, 9)
    expect(flat[1]).toBeCloseTo(0.95, 9)
    expect(flat[2]).toBeCloseTo(2, 9)
    // 15° plane, level box: the lowest corner touches, nothing penetrates - support over the 8 corners
    const th = Math.PI / 12
    const n: [number, number, number] = [-Math.sin(th), Math.cos(th), 0]
    const p = surfaceRestPose(box, [0, 0.9, 5], n)
    let minContact = Infinity
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const cx = p[0] + sx * 0.3
      const cy = p[1] + sy * 0.2
      const cz = p[2] + sz * 0.2
      minContact = Math.min(minContact, (cx - 0) * n[0] + (cy - 0.9) * n[1] + (cz - 5) * n[2])
    }
    expect(minContact).toBeCloseTo(0, 9) // touching the plane…
    expect(minContact).toBeGreaterThanOrEqual(-1e-9) // …never inside it
    // a box already tilted to the plane (rotationZ = 15°) seats its bottom face flush: support = half-height
    const tilted = { ...box, rotationZ: th } as SdkPart
    const pt = surfaceRestPose(tilted, [0, 0.9, 5], n)
    expect(pt[0]).toBeCloseTo(0 + n[0] * 0.2, 6)
    expect(pt[1]).toBeCloseTo(0.9 + n[1] * 0.2, 6)
  })

  it('is canonical: a flat floor resets orientation; scroll yaw composes on top', () => {
    registerPackage(cratePkg('acme.crate', 1, 1, 1))
    const mover = crate('m', 'acme.crate', 5, 0, 5, 0.3) // the part's own yaw is discarded while aligned
    const p = surfaceAlignPose(mover, [1, 0.8, 2], [0, 1, 0], 1, 0)
    expect(p.rotationY).toBeCloseTo(0, 9)
    expect(p.rotationX).toBeCloseTo(0, 9)
    expect(p.rotationZ).toBeCloseTo(0, 9)
    expect(p.position[0]).toBeCloseTo(1, 9) // bottom face on the plane → origin at the pick
    expect(p.position[1]).toBeCloseTo(0.8, 9)
    expect(p.position[2]).toBeCloseTo(2, 9)
    const spun = surfaceAlignPose(mover, [0.5, 1, 0], [1, 0, 0], 2, 0.3)
    expect(spun.rotationY).toBeCloseTo(Math.PI / 2 + 0.3, 9)
  })
})
