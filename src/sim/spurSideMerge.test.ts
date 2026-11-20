import type { PackageManifest } from '../core/parts/partPackage'
import { describe, expect, it } from 'vitest'
import type { SdkPart } from '../core/types'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { FRAME_WALL_THICKNESS, SPUR_SIDE_GAP } from '../core/types'
import { createSdkPart } from '../core/scene/scene'
import { registerPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { computeSceneOpenings } from '../core/guards/guardOpenings'
import { computeSceneExtents } from '../core/guards/guardExtents'
import { bedView, conveyorEndsOf, toLocalXZ, toWorldXZ } from '../core/parts/partGeometry'
import { findSnap } from '../core/snap/snapFeatures'

/**
 * The spur side merge, for both shipped spur families.
 *
 * A spur parks `sideGap` off the host's bed edge and its rails/guards then extend back to the host wall.
 * That gap comes out of the same 0.15 budget the opening/extent resolvers gate contact on, so an
 * oversized one is doubly bad: it leaves a visible dead strip between the two beds, and it leaves the merge a
 * nudge away from silently losing the host guard opening and the rail extents together.
 *
 * The roller spur takes the same default flange gap as the belt spur; an oversized one (0.12, for an
 * "end pulley" it does not have) leaves 3 cm of slack, and a lightly nudged spur loses both. These are
 * absolute assertions on the parked distance, not deltas: a uniform drift of every spur would be invisible
 * to a delta test.
 */

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
const BELT_SPUR_PKG = loadPkg('spur-conveyor')
const ROLLER_SPUR_PKG = loadPkg('spur-roller-conveyor')

const HOST_WIDTH = 1.524
const HOST_HW = HOST_WIDTH / 2

function host(): SdkPart {
  const p = createSdkPart(ROLLER_PKG, 'rc_1', [0, 0.75, 0], 0)
  Object.assign(p.params, { length: 6, width: HOST_WIDTH, speed: 0.5, standHeight: 0.75, leftGuard: true, rightGuard: true })
  return p
}
function spurOf(pkg: PartPackage): SdkPart {
  const p = createSdkPart(pkg, 'sp_1', [1.5, 0.75, 1.5], Math.PI / 2)
  Object.assign(p.params, { length: 2, width: HOST_WIDTH, angleFrontDeg: 30, angleBackDeg: 0, speed: 0, standHeight: 0.75 })
  return p
}

/** side-merge the spur onto the host with the real snap engine, then push it `nudge` m further out */
function merged(pkg: PartPackage, nudge = 0): { h: SdkPart; s: SdkPart } {
  const h = host()
  const s = spurOf(pkg)
  const cand = findSnap(s, { position: s.position, rotationY: s.rotationY }, [h])
  if (!cand) throw new Error('snap engine produced no side-merge candidate')
  s.position = [cand.pose.position[0], cand.pose.position[1], cand.pose.position[2] + nudge]
  s.rotationY = cand.pose.rotationY
  return { h, s }
}

/** distance from the host's bed edge to the spur's nearest mated end centre */
function parkedGap(h: SdkPart, s: SdkPart): number {
  return Math.min(...conveyorEndsOf(s).map((e) => Math.abs(toLocalXZ(h, e.x, e.z).z))) - HOST_HW
}

const FAMILIES: [string, PartPackage][] = [
  ['belt spur', BELT_SPUR_PKG],
  ['roller spur', ROLLER_SPUR_PKG],
]

describe('spur side merge onto a straight roller host', () => {
  it.each(FAMILIES)('%s declares no bespoke sideGap - every spur takes the flange clearance', (_name, pkg) => {
    const v = bedView(spurOf(pkg), 'spur')?.spur ?? null
    expect(v).not.toBeNull()
    expect(v!.sideGap).toBeCloseTo(SPUR_SIDE_GAP, 6)
  })

  it.each(FAMILIES)('%s parks exactly the flange gap off the host bed edge', (_name, pkg) => {
    const { h, s } = merged(pkg)
    expect(parkedGap(h, s)).toBeCloseTo(SPUR_SIDE_GAP, 4)
  })

  it.each(FAMILIES)('%s merge holds: host guard opens and rail extents derive', (_name, pkg) => {
    const { h, s } = merged(pkg)
    const opening = computeSceneOpenings([h, s]).get('rc_1')
    const extents = computeSceneExtents([h, s]).get('sp_1')
    expect(opening?.right.length ?? 0).toBeGreaterThan(0)
    expect(extents).toBeDefined()
    // the rails reach outward past the spur's own splayed face, toward the host wall
    expect(extents!.rightFront).toBeGreaterThan(0)
  })

  // The regression guard. With a 0.12 gap this fails at a 4 cm nudge (extents) and 3 cm (opening):
  // both resolvers gate on a 0.15 contact tolerance that the parked gap uses up. A spur nudged half a
  // bed-edge away must still merge, or hand-placing one silently yields an unfused junction.
  it.each(FAMILIES)('%s merge survives a 5 cm nudge away from the host', (_name, pkg) => {
    const { h, s } = merged(pkg, 0.05)
    // resolvers first: these are the symptom the guard exists for, so they should name the failure
    expect(computeSceneOpenings([h, s]).get('rc_1')?.right.length ?? 0).toBeGreaterThan(0)
    expect(computeSceneExtents([h, s]).get('sp_1')).toBeDefined()
    expect(parkedGap(h, s)).toBeCloseTo(SPUR_SIDE_GAP + 0.05, 4)
  })

  // The structural invariant behind all of the above, stated once: the parked gap is spent from the
  // resolvers' contact budget, so it must leave room to spare rather than merely fit.
  it.each(FAMILIES)('%s parked gap leaves most of the 0.15 contact tolerance unspent', (_name, pkg) => {
    const v = bedView(spurOf(pkg), 'spur')!.spur
    expect(v.sideGap).toBeLessThan(0.15 / 2)
  })

  /**
   * The guards fuse: the host's guard must end exactly where the spur's guard begins.
   *
   * Both resolvers read the same junctionMouth corners. Derived independently (the opening from the bed
   * mouth plus a symmetric +/-FRAME_WALL_THICKNESS margin, the guards from the wall-plane intersection) they
   * agree only when the faces are parallel; across a spur's 30-degree splay the guard offset projects
   * asymmetrically, an open hole between the guards at one corner and the host's guard punching into the
   * mouth at the other.
   *
   * The expected corners are derived here independently of junctionMouth (intersect each guard line
   * with the host's wall plane directly), so this cannot pass by agreeing with a broken shared helper.
   */
  it.each(FAMILIES)('%s guards fuse: host opening lands on the spur guard corners', (_name, pkg) => {
    const { h, s } = merged(pkg)
    const opening = computeSceneOpenings([h, s]).get('rc_1')!.right[0]
    expect(opening).toBeDefined()

    const v = bedView(s, 'spur')!.spur
    const wallZ = HOST_HW + FRAME_WALL_THICKNESS // host outer wall plane, host-local
    // two points along this side's guard line (the spur's +X axis at its guard offset), taken into the
    // host's frame, then linearly interpolated to where that line crosses the host's wall plane
    const hostLocal = (localX: number, localZ: number) => {
      const w = toWorldXZ(s, localX, localZ)
      return toLocalXZ(h, w.x, w.z)
    }
    const corners = [-1, 1].map((side) => {
      const zGuard = side * (v.width / 2 + FRAME_WALL_THICKNESS)
      const a = hostLocal(0, zGuard)
      const b = hostLocal(1, zGuard)
      return a.x + ((b.x - a.x) * (wallZ - a.z)) / (b.z - a.z)
    })
    const [lo, hi] = opening!
    // within a guard half-thickness: the two must meet, never leave a hole
    expect(lo).toBeCloseTo(Math.min(...corners), 2)
    expect(hi).toBeCloseTo(Math.max(...corners), 2)
    // and the mouth still clears the bed that transfers through it
    expect(hi - lo).toBeGreaterThan(v.width)
  })
})
