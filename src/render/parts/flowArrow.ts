import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'
import type { PartInstance } from '../../core/types'
import { buildBeltPath, sampleBeltPath } from '../../core/conveyor/beltPath'
import type { BeltPath } from '../../core/conveyor/beltPath'
import { conveyorSpeedOf } from '../../core/conveyor/conveyorDirection'
import { registryRevision } from '../../core/parts/partRegistry'
import { flexStations } from '../../core/conveyor/flexPath'
import { bedOf } from '../../core/conveyor/conveyorBeds'
import { DEG, flexPathOf, resolveInclineRad } from '../../core/parts/partGeometry'

/**
 * Flow-direction arrow overlay: a green,
 * unshaded, depth-test-off arrow floating over a conveyor's surface that points
 * the way cargo travels. Globally toggled (RenderView.setFlowArrowsVisible);
 * derived per-conveyor in part-local space. The view renders every arrow through
 * one instanced bank (viewport/flowArrowBank.ts, two draws for the whole scene);
 * `flowArrowInstances` computes the shared geometry, and `buildFlowArrow` is the
 * per-part mesh builder (tests, ad-hoc consumers).
 *
 * The arrow follows the speed sign: a negative-speed conveyor
 * conveys toward local -X, so the arrow flips to match the real flow rather than
 * always pointing along the geometric forward.
 */

export const SHAFT_RADIUS = 0.05
export const HEAD_RADIUS = 0.15
export const HEAD_HEIGHT = 0.25
/** how far above the conveying surface the arrow floats (along the surface normal) */
const ARROW_LIFT = 0.3
/** straight-arrow shaft length as a fraction of the bed length (0.6 × the conveyor length) */
const STRAIGHT_FRACTION = 0.6
/** sample spacing along curved/belt paths, m */
const SAMPLE_STEP = 0.3

// Shared resources: one material + two unit geometries across every arrow (per-part meshes and
// the view's instanced bank). Never disposed by a part visual (module-level, like the conveyor
// common.ts geometries).
export const arrowMaterial = new MeshBasicMaterial({
  color: 0x00e64d,
  transparent: true,
  opacity: 0.9,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
})
/** unit cylinder, axis along +Y; scale (r, length, r) */
export const shaftGeo = new CylinderGeometry(1, 1, 1, 10)
/** unit cone, axis along +Y with the apex at +Y; scale (r, height, r) */
export const headGeo = new ConeGeometry(1, 1, 14)

const UP = new Vector3(0, 1, 0)
const tmpDir = new Vector3()

/** arrows are overlays: never let them steal raycasts (picking, surface rest, ruler) */
export function noRaycast(): void {}

/** one arrow primitive (a shaft span or the head cone) in part-local space */
export interface ArrowTransform {
  readonly position: Vector3
  readonly quaternion: Quaternion
  readonly scale: Vector3
}

/** a conveyor's whole arrow as local transforms - the instanced bank's input */
export interface FlowArrowInstances {
  readonly shafts: readonly ArrowTransform[]
  readonly head: ArrowTransform | null
}

function shaftTransform(a: Vector3, b: Vector3): ArrowTransform | null {
  tmpDir.subVectors(b, a)
  const len = tmpDir.length()
  if (len < 1e-4) return null
  tmpDir.divideScalar(len)
  return {
    position: new Vector3().copy(a).addScaledVector(tmpDir, len / 2),
    quaternion: new Quaternion().setFromUnitVectors(UP, tmpDir),
    scale: new Vector3(SHAFT_RADIUS, len, SHAFT_RADIUS),
  }
}

/** cone sitting on top of the shaft end: tip at `base + dir*HEAD_HEIGHT`, pointing `dir` */
function headTransform(base: Vector3, dir: Vector3): ArrowTransform {
  return {
    position: new Vector3().copy(base).addScaledVector(dir, HEAD_HEIGHT / 2),
    quaternion: new Quaternion().setFromUnitVectors(UP, dir),
    scale: new Vector3(HEAD_RADIUS, HEAD_HEIGHT, HEAD_RADIUS),
  }
}

/** shaft along every span of `points`, head cone beyond the last point along its tangent */
function instancesFromPolyline(points: readonly Vector3[]): FlowArrowInstances | null {
  if (points.length < 2) return null
  const shafts: ArrowTransform[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const t = shaftTransform(points[i]!, points[i + 1]!)
    if (t) shafts.push(t)
  }
  const last = points[points.length - 1]!
  const prev = points[points.length - 2]!
  const dir = new Vector3().subVectors(last, prev)
  const head = dir.lengthSq() < 1e-8 ? null : headTransform(last, dir.normalize())
  if (shafts.length === 0 && head === null) return null
  return { shafts, head }
}

/** shaft centreline points sampled over the middle 60% of a belt path's top surface (built-in + SDK belts) */
function beltArrowPoints(path: BeltPath): Vector3[] | null {
  const total = path.topLength
  if (total < 0.3) return null
  const s0 = total * 0.2
  const s1 = total * 0.8
  const n = Math.max(2, Math.ceil((s1 - s0) / SAMPLE_STEP))
  const pts: Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const pose = sampleBeltPath(path, s0 + ((s1 - s0) * i) / n)
    // lift along the in-plane surface normal so the arrow floats over inclines too
    const nx = -Math.sin(pose.angle)
    const ny = Math.cos(pose.angle)
    pts.push(new Vector3(pose.x + nx * ARROW_LIFT, pose.y + ny * ARROW_LIFT, 0))
  }
  return pts
}

/**
 * A flex conveyor's arrow (the `flexPath` handle): along the hinges its sections are fitted through (core flexStations,
 * what the bed is drawn on), over the middle 60% of the bed like a belt's, so it follows every bend the bed is pulled
 * into. The origin is the infeed at roller-top height, so the lift is straight up.
 */
function flexArrowPoints(part: PartInstance): Vector3[] | null {
  const g = flexPathOf(part)
  if (!g || g.points.length === 0) return null
  const st = flexStations(g.points, g.sections).stations
  const cum = [0]
  for (let i = 1; i < st.length; i++) cum.push(cum[i - 1]! + Math.hypot(st[i]![0] - st[i - 1]![0], st[i]![1] - st[i - 1]![1]))
  const total = cum[cum.length - 1]!
  if (total < 0.3) return null
  const at = (s: number): Vector3 => {
    let i = 1
    while (i < cum.length - 1 && cum[i]! < s) i++
    const t = (s - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1)
    return new Vector3(st[i - 1]![0] + (st[i]![0] - st[i - 1]![0]) * t, ARROW_LIFT, st[i - 1]![1] + (st[i]![1] - st[i - 1]![1]) * t)
  }
  const s0 = total * 0.2
  const s1 = total * 0.8
  const n = Math.max(2, Math.ceil((s1 - s0) / SAMPLE_STEP))
  return Array.from({ length: n + 1 }, (_, i) => at(s0 + ((s1 - s0) * i) / n))
}

/**
 * A centred straight span (deck centre at the local origin) along local X - SDK straight/turntable arrows.
 * `inclineRad` is the whole-bed tilt (resolveInclineRad): the bed pivots about its centre by Rz(θ), so the
 * span runs along (cos, sin) and lifts along the tilted normal (−sin, cos), like the belt path's arrow.
 */
function straightArrowPoints(fullLength: number, inclineRad = 0): Vector3[] {
  const half = (fullLength * STRAIGHT_FRACTION) / 2
  const c = Math.cos(inclineRad)
  const s = Math.sin(inclineRad)
  const at = (x: number): Vector3 => new Vector3(x * c - ARROW_LIFT * s, x * s + ARROW_LIFT * c, 0)
  return [at(-half), at(half)]
}

/**
 * Shaft points for a conveyor part, by its bed kind (core/conveyor/conveyorBeds.ts). Null for a part that doesn't convey.
 * The switch covers every kind, so a new kind fails to compile here until it has an arrow.
 */
function customArrowPoints(part: PartInstance): Vector3[] | null {
  // flex conveyor (`flexPath` handle, no declared bed): along its fitted hinges, whatever shape it is pulled into
  if (flexPathOf(part)) return flexArrowPoints(part)
  const bed = bedOf(part)
  if (!bed) return null
  switch (bed.kind) {
    // belt: sample its resolved segment chain
    case 'path':
      return beltArrowPoints(buildBeltPath(bed.view.segments, bed.view.height))
    // straight and spur: centre-origin bed, arrow along local X centred on the origin
    case 'straight':
      return straightArrowPoints(bed.view.length, resolveInclineRad(part))
    case 'spur':
      return straightArrowPoints(bed.view.straight.length, resolveInclineRad(part))
    // curve: SDK arc convention P(t) = (rc·cos t, 0, −rc·sin t), entry at t=0
    case 'arc': {
      const curved = bed.view
      const sweep = curved.sweepDeg * DEG
      if (Math.abs(sweep) < 0.05) return null
      const rc = curved.innerRadius + curved.width / 2
      const t0 = sweep * 0.1
      const t1 = sweep * 0.9
      const n = Math.max(2, Math.ceil((Math.abs(curved.sweepDeg) * 0.8) / 10))
      const pts: Vector3[] = []
      for (let i = 0; i <= n; i++) {
        const t = t0 + ((t1 - t0) * i) / n
        pts.push(new Vector3(rc * Math.cos(t), ARROW_LIFT, -rc * Math.sin(t)))
      }
      return pts
    }
    // turntable: the deck is home-oriented at rest (its slew is run state, not a param), so the arrow points
    // along local +X across the plate
    case 'turntable':
      return straightArrowPoints(bed.view.radius * 2)
  }
}

/** part-local shaft centreline points (start -> end, before any speed-sign reversal) */
function arrowPoints(part: PartInstance): Vector3[] | null {
  return part.type === 'part' ? customArrowPoints(part) : null
}

/**
 * A conveyor's flow arrow as part-local instance transforms (speed-sign reversal applied), or
 * null for parts that don't convey. The view's instanced bank composes these with the part's
 * world pose - the whole scene's arrows render as two instanced draws.
 */
export function flowArrowInstances(part: PartInstance): FlowArrowInstances | null {
  const points = arrowPoints(part)
  if (!points || points.length < 2) return null
  // the folded direction (authored speed × the snap's hidden `reverse` flag) - a snapped-reversed curve has a
  // positive speed and must still point back down its own sweep.
  if (conveyorSpeedOf(part) < 0) points.reverse()
  return instancesFromPolyline(points)
}

function makeArrowMesh(geo: CylinderGeometry | ConeGeometry, t: ArrowTransform): Mesh {
  const mesh = new Mesh(geo, arrowMaterial)
  mesh.raycast = noRaycast
  mesh.renderOrder = 10
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.position.copy(t.position)
  mesh.quaternion.copy(t.quaternion)
  mesh.scale.copy(t.scale)
  return mesh
}

/**
 * Build the flow arrow for a conveyor part in its local frame as real meshes, or null for parts
 * that don't convey. The live viewport renders arrows through the instanced bank instead; this
 * per-part builder remains for tests and ad-hoc consumers (shafts first, head cone last -
 * mirrored 1:1 from flowArrowInstances).
 */
export function buildFlowArrow(part: PartInstance): Object3D | null {
  const inst = flowArrowInstances(part)
  if (!inst) return null
  const group = new Group()
  group.renderOrder = 10
  for (const s of inst.shafts) group.add(makeArrowMesh(shaftGeo, s))
  if (inst.head) group.add(makeArrowMesh(headGeo, inst.head))
  return group
}

/**
 * Geometry signature: the params (plus speed sign) that change the arrow's shape.
 * Empty string for non-conveyors. Lets the view skip a rebuild when a part only
 * moved/rotated (the arrow is local, so its geometry is pose-independent).
 */
export function flowArrowSignature(part: PartInstance): string {
  // the sync asks this of every part on every scene change, and each answer runs the conveyor recognizers: cached per
  // part object (parts are immutable snapshots) and package registry revision, its only inputs
  const rev = registryRevision()
  const hit = flowSigCache.get(part)
  if (hit && hit.rev === rev) return hit.sig
  const sig = flowArrowSignatureUncached(part)
  flowSigCache.set(part, { rev, sig })
  return sig
}
const flowSigCache = new WeakMap<PartInstance, { rev: number; sig: string }>()

function flowArrowSignatureUncached(part: PartInstance): string {
  if (part.type !== 'part') return ''
  // SDK conveyors: key on the recognizer's live geometry + the folded speed sign (so toggling `reverse`
  // re-keys and the arrow re-derives), mirroring flowArrowInstances' routing.
  const speed = conveyorSpeedOf(part)
  const flex = flexPathOf(part)
  if (flex) return `Cf|${JSON.stringify(flex.points)}|${speed}`
  const bed = bedOf(part)
  if (!bed) return ''
  switch (bed.kind) {
    case 'path':
      return `Cb|${bed.view.segments.map((s) => `${s.length},${s.tiltDeg}`).join(';')}|${bed.view.height}|${speed}`
    case 'straight':
      return `Cs|${bed.view.length}|${resolveInclineRad(part)}|${speed}`
    case 'spur':
      return `Cs|${bed.view.straight.length}|${resolveInclineRad(part)}|${speed}`
    case 'arc':
      return `Cc|${bed.view.innerRadius}|${bed.view.width}|${bed.view.sweepDeg}|${speed}`
    case 'turntable':
      return `Ct|${bed.view.radius}|${speed}`
  }
}
