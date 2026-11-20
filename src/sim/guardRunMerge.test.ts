import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { ARC_END_EXT, CURVED_ROLLER_END_EXT, FRAME_WALL_THICKNESS, GUARD_COLLISION_THICKNESS, GUARD_HEIGHT, GUARD_THICKNESS, SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON, SdkPart } from '../core/types'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { registerPackage } from '../core/parts/partRegistry'
import { computeGuardRuns } from '../core/guards/guardRuns'
import { beltGuardWalls } from '../core/guards/beltGuards'
import { curvedGuardWalls } from '../core/guards/curvedGuards'
import { functionStaticWalls } from '../core/guards/functionGuards'
import { linkHalfExtents } from '../core/rig/rigPose'
import { guardColliderCrossSection } from '../core/geometry/collisionShapes'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

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
/** the same committed part, re-registered under a new id with its manifest mutated - for authoring shapes no
 *  example part uses (a visual-only guard, a guard toggled off by default) */
function loadVariant(
  dir: string,
  id: string,
  mutate: (geo: Extract<PartPackageGeometry, { kind: 'rig' }>) => void,
  patchBehavior?: (src: string) => string,
): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const m = JSON.parse(JSON.stringify(manifest)) as { name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
  mutate(m.geometry as Extract<PartPackageGeometry, { kind: 'rig' }>)
  const src = behavior.replace(/\r\n/g, '\n')
  const pkg = buildPackage({ id, name: m.name, geometry: m.geometry, ...(m.materials ? { materials: m.materials } : {}), ...((m as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (m as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) }, patchBehavior ? patchBehavior(src) : src)
  registerPackage(pkg)
  return pkg
}

const ROLLER_PKG = loadPkg('roller-conveyor')
const BELT_PKG = loadPkg('belt-conveyor')
const SPUR_PKG = loadPkg('spur-conveyor')
const CURVE_PKG = loadPkg('curved-conveyor')
const CURVED_ROLLER_PKG = loadPkg('curved-roller')
loadPkg('box')

/** SDK Roller Conveyor (rig, centre origin), guards on, with an explicit skew. */
function roller(id: string, x: number, z: number, length: number, skew: number, width = 0.6): SdkPart {
  const p = createSdkPart(ROLLER_PKG, id, [x, 0.75, z], 0)
  Object.assign(p.params, { length, width, speed: 1, leftGuard: true, rightGuard: true, skew })
  return p
}

function scene(...parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts } as SceneJSON
}

/**
 * Carry a box along the +Z guard and report how far it is pushed off that guard around x = 0.
 * `skewUp`/`skewDown` drive the box into the guard (negative skew squares cargo toward +Z).
 */
function guardRideBump(parts: SdkPart[]): number {
  const world = new SimWorld(Jolt, scene(...parts))
  world.spawnBoxAt(-2.7, 0.95, 0, 0.15, 0.2, 0.15)
  const trace: { x: number; z: number }[] = []
  for (let i = 0; i < 400; i++) {
    world.step()
    const f = world.frame()
    trace.push({ x: f.positions[0]!, z: f.positions[2]! })
  }
  world.dispose()
  // steady-state ride z on the upstream bed, vs the furthest the box gets pushed off the wall past it. The window
  // past it ends 0.5 m before the beds do (x = 3): a box riding at full roller speed reaches the end within the 400
  // steps and drops off it, which moves it off the wall too.
  const ride = trace.filter((p) => p.x > -1.0 && p.x < -0.3).map((p) => p.z)
  const rideZ = ride.reduce((a, b) => a + b, 0) / Math.max(1, ride.length)
  let minAfter = Infinity
  for (const p of trace) if (p.x > -0.2 && p.x < 2.5) minAfter = Math.min(minAfter, p.z)
  return rideZ - minAfter
}

describe('butted side guards merge into one collider (guardRuns)', () => {
  // Two separate guard bodies meeting at a butt seam: Jolt's enhanced internal edge removal does not span
  // separate bodies, so a box squared against the wall by roller skew rides the upstream guard and then rams the
  // downstream guard's leading edge, kicked off the wall. A skewed -> skewed seam re-presses it and hides this;
  // a skewed -> straight seam leaves the box permanently off the guard. guardRuns.ts merges the collinear spans
  // into one owner-emitted box, so there is no seam to ram.
  it('a box riding the guard crosses a butt seam as if the guard were continuous', { timeout: 60000 }, () => {
    // seam at x = 0; skew is identical on both beds, so nothing about the drive changes at the crossing -
    // any push-off is the seam alone.
    const seam = guardRideBump([roller('up', -1.5, 0, 3, -30), roller('down', 1.5, 0, 3, -30)])
    // the same 6 m of guard as one bed - a single collider, the ideal the merge has to reproduce
    const continuous = guardRideBump([roller('only', 0, 0, 6, -30)])
    expect(continuous).toBeLessThan(0.001) // baseline: a continuous guard never pushes the box off
    expect(seam).toBeLessThan(0.001) // merged: indistinguishable from continuous (was 0.035)
  })

  it('the reported skewed -> straight transition leaves the box on the guard', { timeout: 60000 }, () => {
    // No lateral drive downstream, so a seam ram here can never recover; this is the case users would see.
    // What remains is the genuine skew-release relaxation (the box unloads its guard contact), which is what
    // an entirely guard-free downstream bed also shows, so bound it by that rather than by zero.
    const bump = guardRideBump([roller('up', -1.5, 0, 3, -30), roller('down', 1.5, 0, 3, 0)])
    expect(bump).toBeLessThan(0.001) // was 0.038
  })
})

describe('a belt guard is one body per straight line, not one per chord', () => {
  // beltGuardChords emits the run and each pulley-wrap stub (extendEnds) as separate chords, all on the same
  // straight line for a flat belt. With one body per chord, cargo riding the guard rams the next chord's
  // leading edge and is kicked ~35 mm off the wall. Unlike the roller case a belt has no lateral drive
  // to re-press it, so it never recovers. That would happen on every belt, butted or not: the first ram is at
  // the belt's own run -> stub boundary. mergeCollinearChords collapses them; bends genuinely turn and stay split.
  it('a box riding a lone belt guard is not pushed off at the run/stub boundary', { timeout: 60000 }, () => {
    const b = createSdkPart(BELT_PKG, 'b', [-3.25, 0.75, 0], 0)
    Object.assign(b.params, { segments: [[6.5, 0]], width: 0.6, height: 0.5, speed: 1, leftGuard: true, rightGuard: true, legs: false })
    const world = new SimWorld(Jolt, scene(b))
    world.spawnBoxAt(-2.2, 0.95, 0.17, 0.15, 0.2, 0.15) // 0.17 overlaps the guard; it settles onto the face
    const zs: number[] = []
    for (let i = 0; i < 500; i++) {
      world.step()
      const f = world.frame()
      if (f.positions[0]! > -1.5 && f.positions[0]! < 2.5) zs.push(f.positions[2]!)
    }
    world.dispose()
    // across the belt's whole middle the box must hold the guard face; pre-merge it was kicked 0.035 off
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.002)
  })
})

describe('butted belt guards merge across the seam', () => {
  // The intra-part chord merge alone leaves the genuine inter-part seam for a butted pair to ram. guardRuns
  // merges belt walls the same way it merges
  // rig ones (belts just contribute one wall per guard chord instead of one per side).
  it('a box riding the guard crosses a belt-to-belt butt without being pushed off', { timeout: 60000 }, () => {
    const PULLEY = 0.5 / 2
    const mk = (id: string, centreX: number, length: number): SdkPart => {
      const p = createSdkPart(BELT_PKG, id, [centreX - length / 2, 0.75, 0], 0)
      Object.assign(p.params, { segments: [[length, 0]], width: 0.6, height: 0.5, speed: 1, leftGuard: true, rightGuard: true, legs: false })
      return p
    }
    const world = new SimWorld(Jolt, scene(mk('b1', -(1.5 + PULLEY), 3), mk('b2', 1.5 + PULLEY, 3)))
    world.spawnBoxAt(-2.2, 0.95, 0.17, 0.15, 0.2, 0.15) // 0.17 overlaps the guard; it settles onto the face
    const zs: number[] = []
    for (let i = 0; i < 500; i++) {
      world.step()
      const f = world.frame()
      if (f.positions[0]! > -1.5 && f.positions[0]! < 1.5) zs.push(f.positions[2]!) // spans the seam at x = 0
    }
    world.dispose()
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.002) // was ~0.040 across the seam
  })
})

describe('a run that dissolves gives every member its guard back (live edit)', () => {
  // The merged body lives in the owner's PartGroup, and non-owner members emit nothing. So the dangerous
  // direction is dissolution: if a member's suppression outlives the run, that part is left with no guard at
  // all and cargo walks off the bed. simResolvedKey folds guardRunsKey in so any membership change rebuilds
  // every member. These test it end-to-end through updateScene rather than trusting the signature wiring.
  //
  // Assertion is physical and matches the existing neighbour-opening spec: strong skew drives the box at the
  // +Z guard, so a present guard holds it on the bed (y stays near spawn) and a missing one lets it fall.
  // 10 m beds and a spawn 4 m back: the box is conveyed forward at 1 m/s while the skew squares it sideways,
  // so the bed has to be long enough that 250 steps can't run it off the end (which would look exactly like a
  // missing guard). Falling off the side is what this measures.
  function heldOnBed(world: SimWorld, x: number): number {
    world.spawnBoxAt(x - 4, 0.95, 0, 0.15, 0.2, 0.15)
    for (let i = 0; i < 250; i++) world.step()
    const y = world.frame().positions[1]!
    world.dispose()
    return y
  }

  it('control: a lone bed built from scratch holds the box (pins the harness)', { timeout: 60000 }, () => {
    expect(heldOnBed(new SimWorld(Jolt, scene(roller('solo', -30, 0, 10, -55))), -30)).toBeGreaterThan(0.6)
  })

  it('moving a member out of the run restores its own guard', { timeout: 60000 }, () => {
    const world = new SimWorld(Jolt, scene(roller('up', -5, 0, 10, -55), roller('down', 5, 0, 10, -55)))
    // 'down' owns the merged guard and 'up' emits none - now drag 'up' far away, dissolving the run
    world.updateScene(scene(roller('up', -30, 0, 10, -55), roller('down', 5, 0, 10, -55)))
    expect(heldOnBed(world, -30)).toBeGreaterThan(0.6) // guard rebuilt: skew-driven box still on the bed
  })

  it('deleting the run owner restores the surviving member’s guard', { timeout: 60000 }, () => {
    const world = new SimWorld(Jolt, scene(roller('up', -5, 0, 10, -55), roller('down', 5, 0, 10, -55)))
    // owner = 'down' (lowest id). Deleting it destroys the group holding the merged body, so 'up' - which was
    // emitting nothing - must notice the run is gone and build its own guard.
    world.updateScene(scene(roller('up', -5, 0, 10, -55)))
    expect(heldOnBed(world, -5)).toBeGreaterThan(0.6)
  })

  it('a guard is not doubled when a run forms live (owner covers it once)', { timeout: 60000 }, () => {
    // the benign direction, but assert it too: bringing two beds together must leave exactly one wall, not an
    // owner-merged box overlapping a member's leftover one (which would wedge cargo instead of sliding it)
    const world = new SimWorld(Jolt, scene(roller('up', -30, 0, 10, -30), roller('down', 5, 0, 10, -30)))
    world.updateScene(scene(roller('up', -5, 0, 10, -30), roller('down', 5, 0, 10, -30)))
    world.spawnBoxAt(-9, 0.95, 0, 0.15, 0.2, 0.15)
    const zs: number[] = []
    for (let i = 0; i < 900; i++) {
      world.step()
      const f = world.frame()
      if (f.positions[0]! > -1.5 && f.positions[0]! < 1.5) zs.push(f.positions[2]!) // spans the seam at x = 0
    }
    world.dispose()
    expect(zs.length).toBeGreaterThan(10) // the box actually reached the seam
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.002) // one continuous wall across the seam
  })
})

describe('a spur guard merges with a collinear neighbour', () => {
  // A spur's guards are coarse `collision:'box'` AABB boxes (addFunctionStaticBoxes), not rig links or
  // belt chords - a third wall source. Its cross-section happens to match the rig roller's guard exactly
  // (0.305 tall centred at 0.1475, 0.005 thick), so a square-ended spur butted collinear with a roller forms
  // a genuine mergeable wall. Measured without the merge: a skew-driven box riding the guard is rammed 14.6 mm
  // off it at the seam, against 0.00 mm for roller->roller (already merged) and 0.00 mm for the roller alone.
  it('a box riding the guard crosses a roller -> spur butt without being pushed off', { timeout: 60000 }, () => {
    const W = 1.524
    const up = createSdkPart(ROLLER_PKG, 'a', [-3, 0.75, 0], 0)
    Object.assign(up.params, { length: 6, width: W, speed: 1, leftGuard: true, rightGuard: true, skew: -30 })
    const down = createSdkPart(SPUR_PKG, 'b', [1.5, 0.75, 0], 0)
    // square ends so it butts the roller cleanly (a spur's splay is its normal use, but the guard seam is
    // what is under test here, and the merge must handle the collinear case wherever it arises)
    Object.assign(down.params, { length: 3, width: W, speed: 1, leftGuard: true, rightGuard: true, angleFrontDeg: 0, angleBackDeg: 0 })
    const world = new SimWorld(Jolt, scene(up, down))
    world.spawnBoxAt(-4.2, 0.95, 0, 0.15, 0.2, 0.15)
    const zs: number[] = []
    for (let i = 0; i < 700; i++) {
      world.step()
      const f = world.frame()
      if (f.positions[1]! < 0.4) break
      if (f.positions[0]! > -1.2 && f.positions[0]! < 1.2) zs.push(f.positions[2]!) // spans the seam at x = 0
    }
    world.dispose()
    expect(zs.length).toBeGreaterThan(10) // the box actually reached the seam
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.002) // was 0.0146
  })
})

describe('heterogeneous butts merge (guard collider thickness is normalized)', () => {
  // Families author their guards at different thicknesses: rig roller and spur carry the 0.005 visual
  // sheet thickness, belts and curves build at GUARD_COLLISION_THICKNESS (0.05). All four put the inner face
  // at width/2 + FRAME_WALL_THICKNESS, so cargo rides one plane. Taken as authored, the collider boxes differ
  // 10x in thickness and 22.5 mm in centre, guardRuns matches none of them, and a roller->belt butt rams a
  // skew-driven box 33 mm off the wall. guardColliderCrossSection normalizes the collider outward from the
  // inner face (visual untouched), putting rollers/spurs on the belts' envelope.
  const PULLEY = 0.25 // belt height 0.5 / 2 - the extendEnds guard stub
  function rollerToBelt(): SdkPart[] {
    const W = 1.524
    const a = createSdkPart(ROLLER_PKG, 'a', [-3, 0.75, 0], 0) // bed -6..0, guard -6..0
    Object.assign(a.params, { length: 6, width: W, speed: 1, leftGuard: true, rightGuard: true, skew: -30 })
    const b = createSdkPart(BELT_PKG, 'b', [PULLEY, 0.75, 0], 0) // TAIL origin: guard stub reaches back to 0
    Object.assign(b.params, { segments: [[3, 0]], width: W, height: 0.5, speed: 1, leftGuard: true, rightGuard: true, legs: false })
    return [a, b]
  }

  it('a roller and a belt butted end-to-end form one guard run', () => {
    const runs = computeGuardRuns(rollerToBelt())
    expect(runs.size).toBeGreaterThan(0) // was 0 - the pair was never matched
  })

  it('a box riding the guard crosses a roller -> belt butt without being pushed off', { timeout: 60000 }, () => {
    const world = new SimWorld(Jolt, scene(...rollerToBelt()))
    world.spawnBoxAt(-5.2, 0.95, 0, 0.15, 0.2, 0.15)
    const zs: number[] = []
    for (let i = 0; i < 900; i++) {
      world.step()
      const f = world.frame()
      if (f.positions[1]! < 0.4) break
      if (f.positions[0]! > -1.5 && f.positions[0]! < 1.5) zs.push(f.positions[2]!) // spans the seam at x = 0
    }
    world.dispose()
    expect(zs.length).toBeGreaterThan(10)
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.002) // was 0.0331
  })

  it('normalization grows the collider outward only - the inner face cargo rides is unmoved', () => {
    // the contract that makes this safe: thickening must not narrow the bed by a millimetre
    const thin = guardColliderCrossSection(0.0025) // rig roller / spur authored half-thickness
    const thick = guardColliderCrossSection(0.025) // belt / curve, already at the collision thickness
    expect(thin.hz).toBeCloseTo(0.025, 6)
    expect(thin.outwardShift).toBeCloseTo(0.0225, 6) // centre moves out by exactly the growth
    expect(thin.hz - thin.outwardShift).toBeCloseTo(0.0025, 6) // ...so the inner face stays put
    expect(thick.hz).toBeCloseTo(0.025, 6)
    expect(thick.outwardShift).toBe(0) // never shrinks or shifts an already-normal guard
  })
})

describe('a curve confines cargo no more tightly than a straight (guard face radius)', () => {
  // A domain requirement, not engine parity: a guide rail keeps product on the belt, so its face sits just
  // outside the belt edge, and on a curve the outer rail matters more, since product is pushed outward.
  // There is no reason a curve's usable width should be narrower than a straight's of the same width.
  //
  // Placing the guard box's centre on the face radius leans both rails a half-thickness into the bed, and chord
  // inscription loses more on the outer rail, putting the face inside the bed edge where a straight's sits
  // outside it. The part's visual guard is drawn at the straight convention (hw + 0.01), so collision must match.
  //
  // Asserted as a comparison between the two families rather than an absolute: the box rests a small solver
  // separation off any wall, and comparing cancels it.
  const HB = 0.12
  /** rest clearance of a box pressed outward against `part`'s outer guard, relative to the bed edge */
  function clearance(part: SdkPart, bedEdge: number, spawn: (w: SimWorld) => void, measure: (w: SimWorld) => number): number {
    const world = new SimWorld(Jolt, scene(part))
    spawn(world)
    let v = NaN
    for (let i = 0; i < 300; i++) { world.step(); v = measure(world) }
    world.dispose()
    return v + HB - bedEdge
  }

  it('the curve outer guard face lands where a straight of the same width puts it', { timeout: 60000 }, () => {
    const ir = 0.5, w = 1.524
    const curve = createSdkPart(CURVE_PKG, 'c', [0, 0.75, 0], 0)
    Object.assign(curve.params, { innerRadius: ir, width: w, sweepDeg: 90, speed: 0, innerGuard: true, outerGuard: true })
    // The probe box is shorter than the guard (0.12 vs 0.15): a taller one leans over the top and reads the lean,
    // not the face. Sit at a chord midpoint and yaw the box to the chord's own tangent, so it meets the wall face-to-face.
    // Corner-first contact against a tilted chord would hold the box's centre up to (√2−1)·HB ≈ 50 mm further
    // in and read as a tight guard that isn't one. The straight case below is already face-parallel.
    const dt = (10 * Math.PI) / 180 // MAX_SEGMENT_DEG
    const tMid = 1.5 * dt // middle of the second chord - clear of the end stubs
    const yaw = tMid + Math.PI / 2 // the yaw addCustomCurvedGuards gives that chord
    const curveClear = clearance(
      curve,
      ir + w,
      (world) => world.spawnBoxAt((ir + w) * Math.cos(tMid), 0.82, -(ir + w) * Math.sin(tMid), HB, 0.06, HB, yaw),
      (world) => Math.hypot(world.frame().positions[0]!, world.frame().positions[2]!),
    )
    const belt = createSdkPart(BELT_PKG, 'b', [-3, 0.75, 0], 0)
    Object.assign(belt.params, { segments: [[6, 0]], width: w, height: 0.5, speed: 0, leftGuard: true, rightGuard: true, legs: false })
    const beltClear = clearance(
      belt,
      w / 2,
      (world) => world.spawnBoxAt(0, 0.82, w / 2, HB, 0.06, HB),
      (world) => world.frame().positions[2]!,
    )
    // both must hold cargo outside the bed edge (a rail that leans inboard steals usable width)
    expect(beltClear).toBeGreaterThan(0)
    expect(curveClear).toBeGreaterThan(0)
    // ...and agree with each other; pre-fix the curve was ~40 mm tighter
    expect(Math.abs(curveClear - beltClear)).toBeLessThan(0.005)
  })
})

describe('a straight -> curve butt merges (curves are a wall source)', () => {
  // A curve contributes its arc chord walls and its straight tangent stubs. Only the stubs can be collinear
  // with a butted neighbour (the chords turn, and sameWall's parallel test drops them), so the stub is what
  // a feeding straight's guard meets. Measured with curves not counted as a wall source: 32.9 mm inward ram at
  // the butt; 0.00 mm for the same feeder with no curve attached.
  //
  // Lateral position must switch metric at the arc: `x` while the wall is straight, radius once on it -
  // measuring `x` throughout reads the 90° turn itself as a metres-wide "bump" and is meaningless.
  it('a box riding the guard crosses the feeder -> curve stub butt without being pushed off', { timeout: 60000 }, () => {
    const IR = 0.5, W = 1.524, HB = 0.15, LEN = 6
    const RC = IR + W / 2 // centreline radius - the feeder's centreline must sit here to be collinear
    const feed = createSdkPart(ROLLER_PKG, 'f', [RC, 0.75, ARC_END_EXT + LEN / 2], Math.PI / 2) // forward = −Z
    Object.assign(feed.params, { length: LEN, width: W, speed: 1, leftGuard: true, rightGuard: true, skew: -30 })
    const curve = createSdkPart(CURVE_PKG, 'c', [0, 0.75, 0], 0)
    Object.assign(curve.params, { innerRadius: IR, width: W, sweepDeg: 90, speed: 1, innerGuard: true, outerGuard: true })
    const world = new SimWorld(Jolt, scene(feed, curve))
    world.spawnBoxAt(RC, 0.95, ARC_END_EXT + LEN - 0.8, HB, 0.2, HB)
    const lats: number[] = []
    let pressed = false
    for (let i = 0; i < 900; i++) {
      world.step()
      const f = world.frame()
      const x = f.positions[0]!, y = f.positions[1]!, z = f.positions[2]!
      if (y < 0.4) break
      const lat = z > 0 ? x : Math.hypot(x, z)
      // upstream of the butt, confirm the box really is on the guard - otherwise this measures nothing
      if (z > ARC_END_EXT + 1.0 && z < ARC_END_EXT + 2.5 && Math.abs(lat - (IR + W + FRAME_WALL_THICKNESS - HB)) < 0.004) pressed = true
      // window spans the butt at z = ARC_END_EXT, stopping before the arc's chord-polygon transition
      if (z > 0.15 && z < 0.8) lats.push(lat)
    }
    world.dispose()
    expect(pressed).toBe(true) // the probe is only meaningful if the box is squared against the wall
    expect(lats.length).toBeGreaterThan(10)
    expect(Math.max(...lats) - Math.min(...lats)).toBeLessThan(0.002) // was 0.033 at the butt
  })
})

describe('guard collider normalization never narrows the bed', () => {
  // Every other spec here measures the change in lateral position across a seam, so a uniform inward shift of
  // every guard is invisible to them. That shift has shipped once: the collider was thickened, but RigDriver.drive
  // re-posed the body to its FK link origin each step, undoing the spawn-time outward shift. The guard sat centred
  // on the authored plane and took 22.5 mm of bed per side. So this asserts the absolute face, not a delta.
  it('a lone roller holds cargo just outside the bed edge, not inside it', { timeout: 60000 }, () => {
    const W = 1.524
    const HB = 0.15
    const p = createSdkPart(ROLLER_PKG, 'r', [0, 0.75, 0], 0)
    Object.assign(p.params, { length: 10, width: W, speed: 1, leftGuard: true, rightGuard: true, skew: -30 })
    const world = new SimWorld(Jolt, scene(p))
    world.spawnBoxAt(-4, 0.95, 0, HB, 0.2, HB) // skew squares it against the +Z guard
    let z = NaN
    for (let i = 0; i < 300; i++) { world.step(); z = world.frame().positions[2]! }
    world.dispose()
    const face = z + HB // the guard face the box is resting on
    const bedEdge = W / 2
    expect(face).toBeGreaterThan(bedEdge) // Outside the bed - a rail that leans inboard steals usable width
    expect(face - bedEdge).toBeCloseTo(FRAME_WALL_THICKNESS, 3) // exactly the frame wall, as authored
  })
})

describe('guardRuns merge conditions', () => {
  it('butted collinear guards merge: the owner carries the union, the other member emits nothing', () => {
    const up = roller('up', -1.5, 0, 3, -30)
    const down = roller('down', 1.5, 0, 3, -30)
    const runs = computeGuardRuns([up, down])
    // owner = lowest part id ('down' < 'up'), deterministic and order-independent like DeckCluster.ownerId
    const owner = runs.get('down')
    const member = runs.get('up')
    // walls are keyed by the builder's own enumeration - `rig:<linkName>` for a rig guard link
    expect(owner?.walls['rig:guardR']).toHaveLength(1)
    // the union spans the full 6 m of both beds, expressed in the owner wall's local X
    const [lo, hi] = owner!.walls['rig:guardR']![0]!
    expect(hi - lo).toBeCloseTo(6, 3)
    expect(member?.walls['rig:guardR']).toEqual([]) // suppressed - the owner's box already covers it
  })

  it('a gap between the beds does not merge (the wall really is discontinuous there)', () => {
    // 0.5 m apart: two genuinely separate walls, so each part keeps building its own guard unchanged
    const runs = computeGuardRuns([roller('up', -1.75, 0, 3, -30), roller('down', 1.75, 0, 3, -30)])
    expect(runs.size).toBe(0)
  })

  it('beds of different width do not merge (their guards are different wall planes)', () => {
    // collinear and touching end-to-end, but the guards sit at different |z| - merging would move one wall
    const runs = computeGuardRuns([roller('up', -1.5, 0, 3, -30, 0.6), roller('down', 1.5, 0, 3, -30, 1.2)])
    expect(runs.size).toBe(0)
  })

  it('a side-by-side pair does not merge (parallel walls, not collinear)', () => {
    // same orientation and same length, offset across the bed - the perpendicular-distance test rejects these
    const runs = computeGuardRuns([roller('a', 0, 0, 3, -30), roller('b', 0, 2, 3, -30)])
    expect(runs.size).toBe(0)
  })

  it('every wall family invalidates the memo (participates() covers wallSpansOf)', () => {
    // computeGuardRuns is memoizeByParticipants-memoized. A family wallSpansOf reads but participates() omits
    // would not invalidate on a move, so the merge would go stale - the run would survive after the parts
    // separated. Reusing the same roller object across both calls is what exposes it: if the spur is not
    // a participant, the second call sees identical participants and returns the first call's cached runs.
    // (A wall source added without a participates() entry fails here.)
    const W = 1.524
    const host = createSdkPart(ROLLER_PKG, 'a', [-3, 0.75, 0], 0)
    Object.assign(host.params, { length: 6, width: W, speed: 1, leftGuard: true, rightGuard: true, skew: 0 })
    const mkSpur = (x: number): SdkPart => {
      const s = createSdkPart(SPUR_PKG, 'b', [x, 0.75, 0], 0)
      Object.assign(s.params, { length: 3, width: W, speed: 1, leftGuard: true, rightGuard: true, angleFrontDeg: 0, angleBackDeg: 0 })
      return s
    }
    expect(computeGuardRuns([host, mkSpur(1.5)]).size).toBeGreaterThan(0) // butted: merged
    expect(computeGuardRuns([host, mkSpur(50)]).size).toBe(0) // moved away: run must dissolve, not persist
  })

  it('a lone conveyor is untouched (no override, builder path unchanged)', () => {
    expect(computeGuardRuns([roller('only', 0, 0, 6, -30)]).get('only')).toBeUndefined()
  })

  // A wall the resolver counts but buildRigBodies never emits is not a harmless extra: it forms a run, and a
  // run suppresses every non-owner member. So a phantom wall deletes the real guard butted against it (owner =
  // the phantom) or extends it as an invisible wall across the neighbour's bed (owner = the real one), and cargo
  // walks off a bed the author never touched. The two sides share one rule for which links exist
  // (core/rig/rigGuards.ts rigLinkEmitsBody), which is what these pin; each fails without it.
  it('a visual-only guard link (collision: none) is not a wall - it must not suppress a real neighbour', () => {
    const ghost = loadVariant('roller-conveyor', 'test-guard-nocollision', (geo) => {
      for (const l of geo.links) if (l.sideGuard) l.collision = 'none'
    })
    const a = createSdkPart(ghost, 'a', [-1.5, 0.75, 0], 0) // 'a' < 'b', so the phantom would own the run
    Object.assign(a.params, { length: 3, width: 0.6, speed: 1, leftGuard: true, rightGuard: true, skew: -30 })
    const runs = computeGuardRuns([a, roller('b', 1.5, 0, 3, -30)])
    expect(runs.size).toBe(0) // was: 'a' owned [-1.5, 4.5] and 'b' was suppressed to []
  })

  it('a guard whose showParam defaults off is not a wall (the builder resolves defaults; so must the resolver)', () => {
    // A part saved before its package gained the toggle carries no value for it, so both sides must fall back
    // to the package default - false here. Reading the raw instance param instead (undefined !== false) would count
    // a guard the builder omits entirely.
    const off = loadVariant('roller-conveyor', 'test-guard-default-off', () => {}, (src) =>
      src
        .replace("leftGuard: { type: 'boolean', default: true", "leftGuard: { type: 'boolean', default: false")
        .replace("rightGuard: { type: 'boolean', default: true", "rightGuard: { type: 'boolean', default: false"),
    )
    const a = createSdkPart(off, 'a', [-1.5, 0.75, 0], 0)
    Object.assign(a.params, { length: 3, width: 0.6, speed: 1, skew: -30 })
    for (const k of ['leftGuard', 'rightGuard']) delete (a.params as Record<string, unknown>)[k] // unset: the default decides
    expect(computeGuardRuns([a, roller('b', 1.5, 0, 3, -30)]).size).toBe(0)
  })

  it('a guard-less rig cannot change any run, so moving one re-resolves nothing', () => {
    // participates() admits a rig only when it can contribute a wall (or is an opener - a conveyor with its
    // guards off still opens a host's). If every rig qualified, dragging a platform/robot/gantry would re-run
    // the whole resolver over the whole scene: measured 1.8 ms/frame at 400 conveyors for an edit whose correct
    // answer is "nothing changed". Asserted by identity: memoizeByParticipants hands back the same Map object
    // on a cache hit. The fence is a non-conveying 1-link rig, i.e. neither a wall source nor an opener.
    const rig = createSdkPart(loadPkg('fence'), 'z', [0, 0, 20], 0)
    const scene: PartInstance[] = [roller('up', -1.5, 0, 3, -30), roller('down', 1.5, 0, 3, -30), rig]
    const first = computeGuardRuns(scene)
    const moved = scene.map((p) => (p.id === 'z' ? ({ ...p, position: [5, 0, 20] } as PartInstance) : p))
    expect(computeGuardRuns(moved)).toBe(first) // same object: the memo was never invalidated
    expect(first.get('down')?.walls['rig:guardR']).toHaveLength(1) // ...and the real merge still happened
  })

  it('butted belts merge their collinear guard chords across the seam', () => {
    // drum edges touch, so centres sit length + 2*pulley apart and the guard stubs abut exactly at x = 0
    const PULLEY = 0.5 / 2
    const mk = (id: string, centreX: number): SdkPart => {
      const p = createSdkPart(BELT_PKG, id, [centreX - 1.5, 0.75, 0], 0)
      Object.assign(p.params, { segments: [[3, 0]], width: 0.6, height: 0.5, speed: 1, leftGuard: true, rightGuard: true, legs: false })
      return p
    }
    const runs = computeGuardRuns([mk('b1', -(1.5 + PULLEY)), mk('b2', 1.5 + PULLEY)])
    const owner = runs.get('b1')
    const member = runs.get('b2')
    // each flat belt collapses to one chord per side (run + both stubs), so both sides merge: keys :0 and :1
    expect(owner?.walls['belt:1:0']).toHaveLength(1)
    const [lo, hi] = owner!.walls['belt:1:0']![0]!
    expect(hi - lo).toBeCloseTo(3 + 2 * PULLEY + 3 + 2 * PULLEY, 3) // both belts incl. all four stubs
    expect(member?.walls['belt:1:0']).toEqual([])
  })
})

describe('every guard family presents one collider profile (the merge precondition)', () => {
  // A heterogeneous butt merges only while all four wall families agree on the guard's collider
  // cross-section: sameWall rejects a pair whose half-height or half-thickness differs by more than
  // SECTION_TOL (2 mm), or whose centrelines are more than PLANE_TOL (2 mm) apart. That agreement is not
  // enforced by construction: belts and curves compute theirs from GUARD_HEIGHT/GUARD_THICKNESS, the roller
  // rig carries hard-coded 0.305/0.1475 literals in its rig.json, and the spur's come from an authored mesh's
  // AABB. Change GUARD_HEIGHT, or author a guard a centimetre taller, and every cross-family merge silently
  // stops, with no error and no wrong pixel; the 33 mm seam ram returns. Without these specs only a
  // 60-second Jolt ride would notice, and its failure ("the box moved 33 mm") names no cause.
  //
  // So: assert each family against the constants rather than against each other. A mismatch then points at
  // the family that drifted, in milliseconds.
  const W = 1.524
  const HY = (GUARD_HEIGHT + GUARD_THICKNESS) / 2 // collider spans half a sheet past each edge of the rail
  const CY = (GUARD_HEIGHT - GUARD_THICKNESS) / 2 // ...so its centre sits half a sheet below the top
  const HZ = GUARD_COLLISION_THICKNESS / 2 // normalized: every family collides at the belt/curve envelope
  const PY = 0.75 // the part height these fixtures sit at

  /** what a wall must look like: half-height, centre height above the part origin, half-thickness, and how far
   *  its inner face stands outside the bed edge (the usable-width contract: a rail that leans inboard takes
   *  bed width) */
  function profile(hy: number, centreY: number, hz: number, centreLateral: number, bedEdge: number): number[] {
    // rounded to the micron: the four families reach these numbers by different arithmetic, so they differ in
    // the last float bit. A micron is ~2000x tighter than the SECTION_TOL/PLANE_TOL that decide a merge, so
    // nothing a merge cares about can hide inside the rounding.
    return [hy, centreY, hz, centreLateral - hz - bedEdge].map((v) => Math.round(v * 1e6) / 1e6)
  }
  const EXPECTED = [HY, CY, HZ, FRAME_WALL_THICKNESS]

  it('belt: guard collider matches the shared profile', () => {
    const b = createSdkPart(BELT_PKG, 'b', [0, PY, 0], 0)
    Object.assign(b.params, { segments: [[6, 0]], width: W, height: 0.5, speed: 0, leftGuard: true, rightGuard: true, legs: false })
    const wall = beltGuardWalls(b, BELT_PKG)!.find((w) => w.side === 1)!
    expect(profile(wall.hy, wall.pos[1] - PY, wall.hz, wall.pos[2], W / 2)).toEqual(EXPECTED)
  })

  it('curve: guard collider matches the shared profile', () => {
    const IR = 0.5
    const c = createSdkPart(CURVE_PKG, 'c', [0, PY, 0], 0)
    Object.assign(c.params, { innerRadius: IR, width: W, sweepDeg: 90, speed: 0, innerGuard: true, outerGuard: true })
    // the outer rail's straight tangent stub - the wall a butted straight actually meets (the arc chords turn).
    // Its placement radius is the lateral distance from the arc centre, i.e. this family's "centre lateral".
    const stub = curvedGuardWalls(c).filter((w) => w.side === 1).at(-2)!
    expect(profile(stub.hy, stub.pos[1] - PY, stub.hz, Math.hypot(stub.pos[0], stub.pos[2] - ARC_END_EXT / 2), IR + W)).toEqual(EXPECTED)
  })

  it('spur: guard collider matches the shared profile', () => {
    const s = createSdkPart(SPUR_PKG, 's', [0, PY, 0], 0)
    Object.assign(s.params, { length: 3, width: W, speed: 0, leftGuard: true, rightGuard: true, angleFrontDeg: 0, angleBackDeg: 0 })
    const wall = functionStaticWalls(s, SPUR_PKG).find((w) => w.sideGuard === 'right')!
    expect(profile(wall.hy, wall.localCy, wall.hz, wall.localCz, W / 2)).toEqual(EXPECTED)
  })

  it('rig roller: its authored guard link normalizes to the shared profile', () => {
    // the one family whose numbers are literals in a rig.json rather than derived from the constants, so this
    // is the assertion most likely to catch a drift - and the SDK part an author is most likely to copy.
    const geo = ROLLER_PKG.geometry as Extract<PartPackageGeometry, { kind: 'rig' }>
    const link = geo.links.find((l) => l.sideGuard === 'right')!
    const he = linkHalfExtents(link, { width: W } as never)
    const gx = guardColliderCrossSection(he[2])
    // authored Z offset + the outward growth = the collider centre; the growth must leave the inner face put
    const centreLateral = W / 2 + FRAME_WALL_THICKNESS + he[2] + gx.outwardShift
    expect(profile(he[1], link.offset[1], gx.hz, centreLateral, W / 2)).toEqual(EXPECTED)
    expect(he[2]).toBeCloseTo(GUARD_THICKNESS / 2, 9) // authored at the sheet thickness, thickened only for collision
  })

  it('every ordered pair of families merges when butted collinear', () => {
    // The profile specs above say the four agree; this says the agreement actually produces a merge, for every
    // combination - one cheap resolver call each, where the physical rides only cover roller->belt, roller->spur
    // and roller->curve. A pair that stops merging is a seam ram waiting to be reported.
    const PULLEY = 0.25 // belt height 0.5 / 2 - its guard stub reaches this far past the path end
    const mk = {
      // each builds a bed whose guard runs along z = +(W/2 + FRAME_WALL_THICKNESS) and ends at x = `end`
      roller: (id: string, end: number, dir: 1 | -1): SdkPart => {
        const p = createSdkPart(ROLLER_PKG, id, [end + dir * 1.5, PY, 0], 0)
        Object.assign(p.params, { length: 3, width: W, speed: 0, leftGuard: true, rightGuard: true, skew: 0 })
        return p
      },
      belt: (id: string, end: number, dir: 1 | -1): SdkPart => {
        const p = createSdkPart(BELT_PKG, id, [dir > 0 ? end + PULLEY : end - 3 - PULLEY, PY, 0], 0)
        Object.assign(p.params, { segments: [[3, 0]], width: W, height: 0.5, speed: 0, leftGuard: true, rightGuard: true, legs: false })
        return p
      },
      spur: (id: string, end: number, dir: 1 | -1): SdkPart => {
        const p = createSdkPart(SPUR_PKG, id, [end + dir * 1.5, PY, 0], 0)
        Object.assign(p.params, { length: 3, width: W, speed: 0, leftGuard: true, rightGuard: true, angleFrontDeg: 0, angleBackDeg: 0 })
        return p
      },
      // a curve rotated so its outer rail's tangent stub runs along the same line, reaching back to `end`: the
      // bed is centred on z = 0 (the arc centre W/2 + IR off it), so the outer rail lands on the +Z guard line
      curve: (id: string, end: number, dir: 1 | -1): SdkPart => {
        const IR = 0.5
        const p = createSdkPart(CURVE_PKG, id, [end + dir * ARC_END_EXT, PY, dir > 0 ? -IR - W / 2 : IR + W / 2], dir > 0 ? -Math.PI / 2 : Math.PI / 2)
        Object.assign(p.params, { innerRadius: IR, width: W, sweepDeg: 90, speed: 0, innerGuard: true, outerGuard: true })
        return p
      },
    }
    const families = ['roller', 'belt', 'spur', 'curve'] as const
    for (const up of families) {
      for (const down of families) {
        const runs = computeGuardRuns([mk[up]('a', 0, -1), mk[down]('b', 0, 1)])
        expect(runs.size, `${up} -> ${down} butt must form a guard run`).toBeGreaterThan(0)
      }
    }
  })

  it('a curved roller guard stubs stop at its flush snap end, and still merge with a butted straight', () => {
    // Stubs running ARC_END_EXT (0.25) past the arc would lie on a butted neighbour's own guard - a collider
    // that puts the wall back over that neighbour's openings or switched-off side. A curved
    // roller snaps near-flush, so its stubs must stop there; the seam still has to merge (no ram).
    // yawed -90 deg the inlet flows +X with the arc centre on -Z, so centring the bed on z = 0 puts the outer
    // rail on the straight's +Z guard line
    const IR = 0.5
    const c = createSdkPart(CURVED_ROLLER_PKG, 'c', [CURVED_ROLLER_END_EXT, PY, -IR - W / 2], -Math.PI / 2)
    Object.assign(c.params, { innerRadius: IR, width: W, sweepDeg: 90, speed: 0, innerGuard: true, outerGuard: true })
    const walls = curvedGuardWalls(c)
    const stubs = walls.filter((w) => w.halfLen < 0.01)
    expect(stubs).toHaveLength(4) // back + front on each rail
    for (const w of stubs) expect(w.halfLen).toBeCloseTo(CURVED_ROLLER_END_EXT / 2, 9)
    // a curved belt keeps its half-pulley stub
    const belt = createSdkPart(CURVE_PKG, 'cb', [0, PY, 0], 0)
    Object.assign(belt.params, { innerRadius: IR, width: W, sweepDeg: 90, speed: 0, innerGuard: true, outerGuard: true })
    expect(Math.max(...curvedGuardWalls(belt).map((w) => w.halfLen))).toBeGreaterThanOrEqual(ARC_END_EXT / 2 - 1e-9)
    // straight roller whose +Z guard ends at x = 0, butted to the curve's outer-rail back stub
    const r = createSdkPart(ROLLER_PKG, 'a', [-1.5, PY, 0], 0)
    Object.assign(r.params, { length: 3, width: W, speed: 0, leftGuard: true, rightGuard: true, skew: 0 })
    expect(computeGuardRuns([r, c]).size, 'roller -> curved roller butt must form a guard run').toBeGreaterThan(0)
  })
})
