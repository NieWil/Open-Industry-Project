// Forward kinematics for a custom-part rig, shared by render (three.js) and sim (Jolt) so a link's
// collision body sits exactly where its visual is drawn. Pure plain-number
// math (no three.js / Jolt), deterministic, headless-testable. Quaternions are (x, y, z, w); the
// formulas match three.js (multiplyQuaternions / applyQuaternion / setFromEuler 'XYZ') so the render
// hierarchy and these world poses agree.

import { clamp, forwardXZ } from '../math'
import type { PartPackageGeometry, RigJoint, RigLegShape, RigLink, RigShape, SizeParamRef, Vec3Tuple } from '../parts/partPackage'
import type { ParamSchema, ParamValue } from '../parts/partApi'
import { resolvePartParams } from '../parts/partScript'
import { showParamShows } from './rigLinkBody'

/** Instance param bag (custom-part params: number/boolean/string), as seen by C-paramgeo size resolution. */
export type RigParams = Record<string, number | boolean | string>

export type Quat = [number, number, number, number]
export type Vec3 = [number, number, number]
export interface LinkPose {
  pos: Vec3
  quat: Quat
}
/** A free-form override of a link's local pose (ctx.setSubPose) - a field omitted = keep rest. `quat` (unit) takes
 *  precedence over the Euler `rotation` when both are given. */
export interface SubPose {
  position?: Vec3
  rotation?: Vec3
  quat?: Quat
  /** a posable array link's instances, by index (`ctx.setSubPose(link, pose, i)`): each in the link's own frame,
   *  a hole or `null` standing at its rest place in the row */
  instances?: (InstancePose | null)[]
}

/** One posable array instance's pose in its link's frame; an omitted field keeps the instance's rest value. */
export interface InstancePose {
  position?: Vec3
  rotation?: Vec3
  quat?: Quat
}

/** Euler XYZ (radians, the setSubPose convention) as a quaternion, written into `out` at `o`. */
export function eulerXYZQuatInto(e: ArrayLike<number>, out: Float64Array | number[], o = 0): void {
  const c1 = Math.cos(e[0]! / 2)
  const c2 = Math.cos(e[1]! / 2)
  const c3 = Math.cos(e[2]! / 2)
  const s1 = Math.sin(e[0]! / 2)
  const s2 = Math.sin(e[1]! / 2)
  const s3 = Math.sin(e[2]! / 2)
  out[o] = s1 * c2 * c3 + c1 * s2 * s3
  out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3
  out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3
  out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3
}

function vecEq(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
const poseEq = (a: InstancePose, b: InstancePose): boolean => vecEq(a.position, b.position) && vecEq(a.rotation, b.rotation) && vecEq(a.quat, b.quat)

/** Two sub-poses command the same thing: position, rotation and every instance pose. */
export function subPoseEq(a: SubPose | undefined, b: SubPose | undefined): boolean {
  if (!a || !b) return !a && !b
  if (!poseEq(a, b)) return false
  const ai = a.instances
  const bi = b.instances
  if (ai === bi) return true
  if (!ai || !bi || ai.length !== bi.length) return false
  for (let i = 0; i < ai.length; i++) {
    const x = ai[i]
    const y = bi[i]
    if (!x || !y) {
      if (!x !== !y) return false
      continue
    }
    if (!poseEq(x, y)) return false
  }
  return true
}

/** An own-value copy of a sub-pose, so a later write to the behavior's output can't change it. */
export function copySubPose(s: SubPose): SubPose {
  const copy = (p: InstancePose): InstancePose => ({
    ...(p.position ? { position: [p.position[0], p.position[1], p.position[2]] as Vec3 } : {}),
    ...(p.rotation ? { rotation: [p.rotation[0], p.rotation[1], p.rotation[2]] as Vec3 } : {}),
    ...(p.quat ? { quat: [p.quat[0], p.quat[1], p.quat[2], p.quat[3]] as Quat } : {}),
  })
  const out: SubPose = copy(s)
  if (s.instances) out.instances = s.instances.map((p) => (p ? copy(p) : null))
  return out
}

/** One posable array instance placed in its link's frame, as position then quaternion into `out` (7 numbers).
 *  `setSubPose(link, pose, i)` places the instance where `setSubPose(link, pose)` would place the link, in the link's
 *  parent frame, so this is that pose relative to where FK stands the link this tick (`values`, `subPoses`, `params`,
 *  `inclineRad` as FK took them). An instance not posed stands at its rest place `rest` (its array delta). The sim and
 *  the view both place instances through this, so a carrier is drawn where it collides. */
export function posedInstanceInto(out: Float64Array, geo: RigGeometry, i: number, values: Record<string, number>, subPoses: Record<string, SubPose> | undefined, params: RigParams, inclineRad: number, pose: InstancePose | null | undefined, rest: readonly number[]): void {
  if (!pose) {
    out[0] = rest[0]!
    out[1] = rest[1]!
    out[2] = rest[2]!
    out[3] = 0
    out[4] = 0
    out[5] = 0
    out[6] = 1
    return
  }
  const link = linkLocalPoseInto(L0, geo, i, values, subPoses?.[geo.links[i]!.name], params, inclineRad)
  const inst = linkLocalPoseInto(LI, geo, i, values, pose, params, inclineRad)
  // inverse(link) * inst: the instance's pose seen from the link's own frame
  const cx = -link[3]!, cy = -link[4]!, cz = -link[5]!, cw = link[6]!
  const dx = inst[0]! - link[0]!, dy = inst[1]! - link[1]!, dz = inst[2]! - link[2]!
  const tx = 2 * (cy * dz - cz * dy), ty = 2 * (cz * dx - cx * dz), tz = 2 * (cx * dy - cy * dx)
  out[0] = dx + cw * tx + (cy * tz - cz * ty)
  out[1] = dy + cw * ty + (cz * tx - cx * tz)
  out[2] = dz + cw * tz + (cx * ty - cy * tx)
  const bx = inst[3]!, by = inst[4]!, bz = inst[5]!, bw = inst[6]!
  out[3] = cw * bx + cx * bw + cy * bz - cz * by
  out[4] = cw * by - cx * bz + cy * bw + cz * bx
  out[5] = cw * bz + cx * by - cy * bx + cz * bw
  out[6] = cw * bw - cx * bx - cy * by - cz * bz
}
const L0 = new Float64Array(7)
const LI = new Float64Array(7)

type RigGeometry = Extract<PartPackageGeometry, { kind: 'rig' }>

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1]

/** Hamilton product a·b (matches three.js Quaternion.multiplyQuaternions). */
export function qMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
    a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
    a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

/** Inverse of a unit quaternion (its conjugate). */
export function qConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]]
}

export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1
  const h = angle / 2
  const s = Math.sin(h) / len
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]
}

/** Euler (x, y, z) in three.js default 'XYZ' order → quaternion (matches buildRig's g.rotation.set). */
export function qFromEulerXYZ(e: Vec3): Quat {
  const c1 = Math.cos(e[0] / 2)
  const c2 = Math.cos(e[1] / 2)
  const c3 = Math.cos(e[2] / 2)
  const s1 = Math.sin(e[0] / 2)
  const s2 = Math.sin(e[1] / 2)
  const s3 = Math.sin(e[2] / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

/**
 * World rotation that aims a link's local +Z (the glTF model-front axis) from `eye` at `target`, with `up`
 * fixing the roll. Returns a copy of `fallback` when the aim is degenerate (eye ≈ target, or `up` parallel
 * to the forward axis). Thin wrapper over the flat `lookAtInto` the FK uses, so there is one implementation.
 */
export function lookAtQuat(eye: Vec3, target: Vec3, up: Vec3, fallback: Quat = IDENTITY_QUAT): Quat {
  lookAtInto(LOOK, 0, eye[0], eye[1], eye[2], target[0], target[1], target[2], up[0], up[1], up[2], fallback[0], fallback[1], fallback[2], fallback[3])
  return [LOOK[0]!, LOOK[1]!, LOOK[2]!, LOOK[3]!]
}

/** Rotate v by quaternion q (matches three.js Vector3.applyQuaternion). */
export function qApply(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q
  const [x, y, z] = v
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)]
}

/**
 * A link's local transform relative to its parent: the rest pose (offset + Euler rotation) with its
 * joint applied - revolute rotates about the axis (in the link's local frame), prismatic slides along
 * it. Matches render/parts/sdkPart.ts's per-joint math exactly.
 */
/** A link's rest rotation: the explicit quaternion if set, else Euler XYZ (with its `rotationParams` resolved
 *  against `params`, when given), else identity. */
export function restQuatOf(link: RigLink, params?: RigParams): Quat {
  if (link.quat) return link.quat
  if (params && link.rotationParams?.length) return qFromEulerXYZ(resolvedOffset(link.rotation ?? [0, 0, 0], link.rotationParams, params))
  return link.rotation ? qFromEulerXYZ(link.rotation) : IDENTITY_QUAT
}

/**
 * A joint's limits for this instance: its static `[min, max]`, narrowed by any `minParam` / `maxParam` resolved
 * against the params (and never widened past the static envelope). Every place a joint is posed clamps through
 * here, so the sim, the rendered FK and `ctx.measured.joints` agree.
 */
export function jointLimits(joint: RigJoint, params?: RigParams): [number, number] {
  let lo = joint.min
  let hi = joint.max
  if (params) {
    const rlo = joint.minParam ? resolvedRef(joint.minParam, params) : null
    const rhi = joint.maxParam ? resolvedRef(joint.maxParam, params) : null
    if (rlo !== null) lo = clamp(rlo, joint.min, joint.max)
    if (rhi !== null) hi = clamp(rhi, joint.min, joint.max)
    if (lo > hi) lo = hi = (lo + hi) / 2 // crossed by the params (a frame shrunk to nothing): pin the middle
  }
  return [lo, hi]
}

/** A leg row's deck → frame-bottom depth for this instance: `frameDepthParam` resolved against the params, else
 *  the static `frameDepth`. */
export function legFrameDepth(shape: Pick<RigLegShape, 'frameDepth' | 'frameDepthParam'>, params: RigParams): number {
  const r = shape.frameDepthParam ? resolvedRef(shape.frameDepthParam, params) : null
  return r ?? shape.frameDepth
}

export function rigLocalPose(link: RigLink, joint: RigJoint | undefined, value: number, params?: RigParams): LinkPose {
  const restQuat = restQuatOf(link, params)
  const restPos = link.offset
  if (!joint) return { pos: restPos, quat: restQuat }
  const [lo, hi] = jointLimits(joint, params)
  const v = clamp(value, lo, hi)
  if (joint.type === 'revolute') {
    return { pos: restPos, quat: qMul(restQuat, qFromAxisAngle(joint.axis, v)) }
  }
  // prismatic: slide along the axis expressed in the rest frame
  const dir = qApply(restQuat, joint.axis)
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1
  return { pos: [restPos[0] + (dir[0] / len) * v, restPos[1] + (dir[1] / len) * v, restPos[2] + (dir[2] / len) * v], quat: restQuat }
}

/** A link's local pose with a setSubPose override taking precedence over its rest+joint transform. */
export function rigLinkLocalPose(link: RigLink, joint: RigJoint | undefined, value: number, subPose: SubPose | undefined, params?: RigParams): LinkPose {
  if (subPose) {
    const quat = subPose.quat ?? (subPose.rotation ? qFromEulerXYZ(subPose.rotation) : restQuatOf(link, params))
    return { pos: subPose.position ?? link.offset, quat }
  }
  return rigLocalPose(link, joint, value, params)
}

/**
 * Per-`geo` lookup tables + shape flags, memoized. `composeTree` runs once (twice for an aim rig) per
 * rig per physics step; a RigGeometry is derivation-memoized and shared-immutable (see partGeometry's
 * memoByParams/memoByPkg), so `linkByName`/`jointByLink` are constant for its whole life and rebuilding
 * them per call would cost the 60-link six-axis robot ~240 Map inserts per step.
 *
 * Keyed on `geo` identity and re-derived if either source array is swapped, so a regenerated geometry
 * never gets a stale table. In-place mutation of `geo.links` would go undetected; the derivation memos
 * rely on the same shared-immutable invariant.
 */
interface RigTables {
  links: RigGeometry['links']
  joints: RigGeometry['joints']
  /** link name → its index in `links`, i.e. its slot (`i * POSE_STRIDE`) in a pose buffer */
  index: Map<string, number>
  /** evaluation order: every link after its parent, so FK is one flat forward loop */
  order: Int32Array
  /** iteration order of the `Map` form (see {@link rigWorldPoses}). Body build order depends on it, so it
   *  must not change. */
  mapOrder: Int32Array
  /** parent link index, −1 for a root (also for an unresolved parent name - validation rejects one) */
  parentIdx: Int32Array
  /** the joint driving each link, if any (on a duplicate, the last one declared) */
  jointOf: (RigGeometry['joints'][number] | undefined)[]
  /** rest rotation per link, 4 floats each: constant per link, so the Euler→quat conversion is paid
   *  once per geometry instead of once per link per step */
  restQuats: Float64Array
  /** aim target's link index per link, −1 when the link has no `aim` (or names a missing target) */
  aimTargetIdx: Int32Array
  /** each aim link's roll reference, `aim.up` defaulted to +Y (so the per-step path allocates none) */
  aimUp: (readonly [number, number, number] | undefined)[]
  hasAim: boolean
  /** `order` restricted to the links whose pose can differ between the rest prepass and the aimed pass:
   *  the aim links themselves plus everything descending from one (an aim rotation carries its
   *  subtree). Empty when the rig has no aim links. */
  aimOrder: Int32Array
  /** 1 per link that is a `leg` (excluded from the incline tilt); null ⇒ the rig has none */
  legs: Uint8Array | null
  /** prepass scratch for the two-pass aim resolve, allocated on first use for an aim rig only */
  aimScratch: Float64Array | null
  /** backing buffer for the `Map` form, so cold callers don't allocate one per call */
  mapScratch: Float64Array | null
  /** each `mimic` joint's leader, by the follower's name; null ⇒ the rig has none */
  leaders: Map<string, RigGeometry['joints'][number]> | null
}
const rigTableCache = new WeakMap<RigGeometry, RigTables>()

/**
 * The value a joint is posed at, before its own limits: its command in `values`, or for a `mimic` joint its leader's
 * value (clamped to the leader's limits, as the leader is posed) × multiplier + offset. Absent is rest (0).
 */
export function jointValue(joint: RigGeometry['joints'][number], values: Record<string, number>, geo: RigGeometry, params?: RigParams): number {
  return valueIn(rigTables(geo), joint, values, params)
}

function valueIn(t: RigTables, joint: RigGeometry['joints'][number], values: Record<string, number>, params: RigParams | undefined): number {
  const leader = joint.mimic ? t.leaders?.get(joint.name) : undefined
  if (!leader) return values[joint.name] ?? 0
  const [lo, hi] = jointLimits(leader, params)
  return clamp(values[leader.name] ?? 0, lo, hi) * (joint.mimic!.multiplier ?? 1) + (joint.mimic!.offset ?? 0)
}
function rigTables(geo: RigGeometry): RigTables {
  const hit = rigTableCache.get(geo)
  if (hit && hit.links === geo.links && hit.joints === geo.joints) return hit
  const links = geo.links
  const n = links.length
  const index = new Map<string, number>()
  for (let i = 0; i < n; i++) index.set(links[i]!.name, i)
  const parentIdx = new Int32Array(n)
  const restQuats = new Float64Array(4 * n)
  const legs = new Uint8Array(n)
  let legCount = 0
  for (let i = 0; i < n; i++) {
    const l = links[i]!
    parentIdx[i] = l.parent !== undefined ? (index.get(l.parent) ?? -1) : -1
    const q = restQuatOf(l)
    restQuats[4 * i] = q[0]
    restQuats[4 * i + 1] = q[1]
    restQuats[4 * i + 2] = q[2]
    restQuats[4 * i + 3] = q[3]
    if (l.shape.kind === 'leg') {
      legs[i] = 1
      legCount++
    }
  }
  const jointOf: (RigGeometry['joints'][number] | undefined)[] = new Array<RigGeometry['joints'][number] | undefined>(n).fill(undefined)
  for (const j of geo.joints) {
    const i = index.get(j.link)
    if (i !== undefined) jointOf[i] = j
  }
  // Topological order via DFS on the parent edge, links visited in declaration order. This sets the `Map`
  // form's iteration order, which body build order depends on. A link whose parent is mid-visit is only reachable through a cycle (validation
  // rejects one); it is emitted where it stands rather than recursing forever.
  const order = new Int32Array(n)
  const state = new Uint8Array(n) // 0 = unseen, 1 = visiting, 2 = emitted
  let w = 0
  const emit = (i: number): void => {
    if (state[i] !== 0) return
    state[i] = 1
    const p = parentIdx[i]!
    if (p >= 0) emit(p)
    state[i] = 2
    order[w++] = i
  }
  for (let i = 0; i < n; i++) emit(i)
  // aim closure: seed with the aim links, then sweep to a fixed point adding any link whose parent
  // is already in. (Link order is not guaranteed topological, hence the sweep rather than one pass.)
  const aimAffected = new Set(links.filter((l) => l.aim).map((l) => l.name))
  if (aimAffected.size > 0) {
    for (let grew = true; grew; ) {
      grew = false
      for (const l of links) {
        if (l.parent && aimAffected.has(l.parent) && !aimAffected.has(l.name)) {
          aimAffected.add(l.name)
          grew = true
        }
      }
    }
  }
  const hasAim = aimAffected.size > 0
  const aimTargetIdx = new Int32Array(n).fill(-1)
  const aimUp: (readonly [number, number, number] | undefined)[] = new Array<readonly [number, number, number] | undefined>(n).fill(undefined)
  for (let i = 0; i < n; i++) {
    const aim = links[i]!.aim
    if (!aim) continue
    aimTargetIdx[i] = index.get(aim.target) ?? -1
    aimUp[i] = aim.up ?? [0, 1, 0]
  }
  const aimOrder = new Int32Array(hasAim ? aimAffected.size : 0)
  const mapOrder = new Int32Array(n)
  if (hasAim) {
    // pass 2 seeded the unaffected poses first (in prepass order), then appended the recomputed ones -
    // mirror that split so the Map form iterates exactly as it always has
    let a = 0
    let m = 0
    for (let k = 0; k < n; k++) if (!aimAffected.has(links[order[k]!]!.name)) mapOrder[m++] = order[k]!
    for (let k = 0; k < n; k++) {
      if (!aimAffected.has(links[order[k]!]!.name)) continue
      aimOrder[a++] = order[k]!
      mapOrder[m++] = order[k]!
    }
  } else {
    mapOrder.set(order)
  }
  const built: RigTables = {
    links,
    joints: geo.joints,
    index,
    order,
    mapOrder,
    parentIdx,
    jointOf,
    restQuats,
    aimTargetIdx,
    aimUp,
    hasAim,
    aimOrder,
    legs: legCount > 0 ? legs : null,
    aimScratch: null,
    mapScratch: null,
    leaders: leadersOf(geo.joints),
  }
  rigTableCache.set(geo, built)
  return built
}

/** Each mimic joint's leader. A leader that is itself a mimic, or missing, is left out (validation refuses both), so
 *  that follower poses from its own command. */
function leadersOf(joints: RigGeometry['joints']): Map<string, RigGeometry['joints'][number]> | null {
  if (!joints.some((j) => j.mimic)) return null
  const byName = new Map(joints.map((j) => [j.name, j]))
  const out = new Map<string, RigGeometry['joints'][number]>()
  for (const j of joints) {
    const leader = j.mimic ? byName.get(j.mimic.joint) : undefined
    if (leader && leader !== j && !leader.mimic) out.set(j.name, leader)
  }
  return out
}

// ─── Flat pose composition ────────────────────────────────────────────────────────────────────────
//
// FK is the single biggest worker cost on a rig-heavy scene (the demo's 60-link Loader robot), and an
// allocating FK spends most of it on GC, not maths: a fresh array out of every qApply/qMul, a {pos, quat}
// object per link, a Map to hold them, and a `{...link}` spread per param-driven offset, ~500 short-lived
// objects per rig per step. The composition below writes into a caller-owned Float64Array instead and
// allocates nothing per step. The arithmetic is the helpers above inlined expression for expression, so
// poses are bit-identical; rigPose.test.ts / rigAim.test.ts check that.
//
// Layout: POSE_STRIDE floats per link - position xyz then quaternion xyzw - with link `i` at `i *
// POSE_STRIDE`, `i` being `rigLinkIndex(geo).get(name)`. Cold callers keep the Map form below.

/** Floats per link in a pose buffer: position xyz + quaternion xyzw. */
export const POSE_STRIDE = 7

/** A pose buffer sized for `geo`. Hold one per rig instance (not per geometry - instances share it). */
export function rigPoseBuffer(geo: RigGeometry): Float64Array {
  return new Float64Array(geo.links.length * POSE_STRIDE)
}

/** Link name → its index in a pose buffer (multiply by {@link POSE_STRIDE}). Memoized per geometry. */
export function rigLinkIndex(geo: RigGeometry): ReadonlyMap<string, number> {
  return rigTables(geo).index
}

// One link's local pose (pos xyz + quat xyzw) and one param-resolved offset. Module-level and reused:
// composition is synchronous and non-reentrant, and neither ever escapes the call that fills it.
const LOCAL = new Float64Array(7)
const OFF = new Float64Array(3)
const EQ = new Float64Array(4)
const LOOK = new Float64Array(4)

/** {@link resolvedOffset} into a scratch triple instead of a fresh array. */
function resolvedOffsetInto(offset: Vec3, offsetParams: readonly SizeParamRef[], params: RigParams, out: Float64Array): void {
  out[0] = offset[0]
  out[1] = offset[1]
  out[2] = offset[2]
  for (const sp of offsetParams) {
    const resolved = foldedRef(out[sp.axis]!, sp, params)
    if (resolved !== null) out[sp.axis] = resolved
  }
}

/** {@link matrixToQuat} into `out[o..o+3]`. Columns must be orthonormal and right-handed. */
function matrixToQuatInto(out: Float64Array, o: number, m00: number, m10: number, m20: number, m01: number, m11: number, m21: number, m02: number, m12: number, m22: number): void {
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    out[o] = (m21 - m12) * s
    out[o + 1] = (m02 - m20) * s
    out[o + 2] = (m10 - m01) * s
    out[o + 3] = 0.25 / s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    out[o] = 0.25 * s
    out[o + 1] = (m01 + m10) / s
    out[o + 2] = (m02 + m20) / s
    out[o + 3] = (m21 - m12) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    out[o] = (m01 + m10) / s
    out[o + 1] = 0.25 * s
    out[o + 2] = (m12 + m21) / s
    out[o + 3] = (m02 - m20) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    out[o] = (m02 + m20) / s
    out[o + 1] = (m12 + m21) / s
    out[o + 2] = 0.25 * s
    out[o + 3] = (m10 - m01) / s
  }
}

/** {@link lookAtQuat} into `out[o..o+3]` from loose scalars - the allocation-free core of both. */
function lookAtInto(out: Float64Array, o: number, ex: number, ey: number, ez: number, tx: number, ty: number, tz: number, ux: number, uy: number, uz: number, fx: number, fy: number, fz: number, fw: number): void {
  const dx = tx - ex
  const dy = ty - ey
  const dz = tz - ez
  const fl = Math.hypot(dx, dy, dz)
  if (fl >= 1e-3) {
    // degenerate when distance² < 1e-6 (≈ 1e-3 m)
    const vzx = dx / fl // +Z (model front) toward the target
    const vzy = dy / fl
    const vzz = dz / fl
    const ax = uy * vzz - uz * vzy // cross(up, vz)
    const ay = uz * vzx - ux * vzz
    const az = ux * vzy - uy * vzx
    const xl = Math.hypot(ax, ay, az)
    if (xl >= 1e-6) {
      // up parallel to forward ⇒ roll undefined ⇒ fall through to the fallback
      const vxx = ax / xl
      const vxy = ay / xl
      const vxz = az / xl
      matrixToQuatInto(out, o, vxx, vxy, vxz, vzy * vxz - vzz * vxy, vzz * vxx - vzx * vxz, vzx * vxy - vzy * vxx, vzx, vzy, vzz) // vy = cross(vz, vx), unit
      return
    }
  }
  out[o] = fx
  out[o + 1] = fy
  out[o + 2] = fz
  out[o + 3] = fw
}

/** Link `i`'s local pose (relative to its parent) into {@link LOCAL} - the flat form of
 *  {@link rigLinkLocalPose}, reading the rest rotation from the memoized table. Same maths. */
function writeLocalPose(t: RigTables, i: number, values: Record<string, number>, subPose: SubPose | undefined, params: RigParams): void {
  const link = t.links[i]!
  const rq = 4 * i
  let qx = t.restQuats[rq]!
  let qy = t.restQuats[rq + 1]!
  let qz = t.restQuats[rq + 2]!
  let qw = t.restQuats[rq + 3]!
  // a param-driven rest rotation (rotationParams; validation keeps it off a quat link) resolves per call
  if (link.rotationParams && !link.quat) {
    resolvedOffsetInto(link.rotation ?? [0, 0, 0], link.rotationParams, params, OFF)
    eulerXYZQuatInto(OFF, EQ)
    qx = EQ[0]!
    qy = EQ[1]!
    qz = EQ[2]!
    qw = EQ[3]!
  }
  // C-paramgeo: resolve a param-driven offset (e.g. a hinge at -length/2) before composing.
  let px: number
  let py: number
  let pz: number
  if (link.offsetParams) {
    resolvedOffsetInto(link.offset, link.offsetParams, params, OFF)
    px = OFF[0]!
    py = OFF[1]!
    pz = OFF[2]!
  } else {
    px = link.offset[0]
    py = link.offset[1]
    pz = link.offset[2]
  }
  if (subPose) {
    // a setSubPose override takes precedence over the rest+joint transform; an omitted field keeps rest
    const q = subPose.quat
    const e = subPose.rotation
    if (q) {
      qx = q[0]
      qy = q[1]
      qz = q[2]
      qw = q[3]
    } else if (e) {
      eulerXYZQuatInto(e, EQ)
      qx = EQ[0]!
      qy = EQ[1]!
      qz = EQ[2]!
      qw = EQ[3]!
    }
    const sp = subPose.position
    if (sp) {
      px = sp[0]
      py = sp[1]
      pz = sp[2]
    }
  } else {
    const joint = t.jointOf[i]
    if (joint) {
      const axis = joint.axis
      const [lo, hi] = jointLimits(joint, params)
      // the per-step FK path: a joint that follows none reads its own value with no call
      const v = clamp(joint.mimic ? valueIn(t, joint, values, params) : (values[joint.name] ?? 0), lo, hi)
      if (joint.type === 'revolute') {
        const len = Math.hypot(axis[0], axis[1], axis[2]) || 1
        const h = v / 2
        const s = Math.sin(h) / len
        const bx = axis[0] * s // qFromAxisAngle(joint.axis, v)
        const by = axis[1] * s
        const bz = axis[2] * s
        const bw = Math.cos(h)
        const nx = qx * bw + qw * bx + qy * bz - qz * by // qMul(restQuat, …)
        const ny = qy * bw + qw * by + qz * bx - qx * bz
        const nz = qz * bw + qw * bz + qx * by - qy * bx
        qw = qw * bw - qx * bx - qy * by - qz * bz
        qx = nx
        qy = ny
        qz = nz
      } else {
        // prismatic: slide along the axis expressed in the rest frame
        const vx = axis[0]
        const vy = axis[1]
        const vz = axis[2]
        const ttx = 2 * (qy * vz - qz * vy) // qApply(restQuat, joint.axis)
        const tty = 2 * (qz * vx - qx * vz)
        const ttz = 2 * (qx * vy - qy * vx)
        const dx = vx + qw * ttx + (qy * ttz - qz * tty)
        const dy = vy + qw * tty + (qz * ttx - qx * ttz)
        const dz = vz + qw * ttz + (qx * tty - qy * ttx)
        const len = Math.hypot(dx, dy, dz) || 1
        px += (dx / len) * v
        py += (dy / len) * v
        pz += (dz / len) * v
      }
    }
  }
  LOCAL[0] = px
  LOCAL[1] = py
  LOCAL[2] = pz
  LOCAL[3] = qx
  LOCAL[4] = qy
  LOCAL[5] = qz
  LOCAL[6] = qw
}

/**
 * One link's local pose (relative to its parent link, or to the rig root for a top-level link) into `out` (7
 * numbers: x y z qx qy qz qw), by the very rule {@link rigWorldPosesInto} composes the tree from: the rest pose,
 * a param-driven offset, the joint, a setSubPose override - and, on a top-level non-leg link, the whole-bed
 * incline (the outer tilt the composition applies to every world pose, which leaves a child's local unchanged).
 * Not aim: an aim link's rotation depends on another link's world position, so compose the tree for that.
 *
 * For a host that re-poses only the links a change can move - a joint tick moves only jointed links' local
 * transforms, and a scene graph carries their children - without composing the whole tree each frame (the
 * renderer's per-frame joint path: a 57-link turntable with one joint). Allocation-free.
 */
export function rigLinkLocalPoseInto(out: Float64Array, geo: RigGeometry, i: number, values: Record<string, number>, subPoses: Record<string, SubPose> | undefined, params: RigParams, inclineRad = 0): Float64Array {
  return linkLocalPoseInto(out, geo, i, values, subPoses?.[geo.links[i]!.name], params, inclineRad)
}

/** {@link rigLinkLocalPoseInto} with the link's sub-pose handed in directly */
function linkLocalPoseInto(out: Float64Array, geo: RigGeometry, i: number, values: Record<string, number>, subPose: SubPose | InstancePose | undefined, params: RigParams, inclineRad: number): Float64Array {
  const t = rigTables(geo)
  writeLocalPose(t, i, values, subPose, params)
  out.set(LOCAL.subarray(0, POSE_STRIDE))
  if (inclineRad !== 0 && t.parentIdx[i]! < 0 && !t.legs?.[i]) {
    const zq = qFromAxisAngle([0, 0, 1], inclineRad)
    const p = qApply(zq, [out[0]!, out[1]!, out[2]!])
    const q = qMul(zq, [out[3]!, out[4]!, out[5]!, out[6]!])
    out[0] = p[0]
    out[1] = p[1]
    out[2] = p[2]
    out[3] = q[0]
    out[4] = q[1]
    out[5] = q[2]
    out[6] = q[3]
  }
  return out
}

/**
 * World pose (relative to the part origin) of every link into `out`, composing the tree from the joint
 * command values (and any setSubPose overrides); an absent joint value is rest (0). One forward pass in
 * the memoized topological order - no recursion, no memo map (validation guarantees acyclic + resolved
 * parents; `rigTables` degrades a bad edge to a root rather than looping).
 *
 * `prepass` non-null ⇒ this is the aim pass: `out` has already been seeded with the prepass poses, so
 * only the aim-affected links are recomputed, and each aim target's position is read from `prepass`
 * (never from the half-updated `out`).
 */
function composeInto(out: Float64Array, t: RigTables, values: Record<string, number>, subPoses: Record<string, SubPose> | undefined, params: RigParams, prepass: Float64Array | null): void {
  const order = prepass ? t.aimOrder : t.order
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!
    writeLocalPose(t, i, values, subPoses ? subPoses[t.links[i]!.name] : undefined, params)
    let ppx = 0
    let ppy = 0
    let ppz = 0
    let pqx = 0
    let pqy = 0
    let pqz = 0
    let pqw = 1
    const p = t.parentIdx[i]!
    if (p >= 0) {
      const po = p * POSE_STRIDE
      ppx = out[po]!
      ppy = out[po + 1]!
      ppz = out[po + 2]!
      pqx = out[po + 3]!
      pqy = out[po + 4]!
      pqz = out[po + 5]!
      pqw = out[po + 6]!
    }
    const lx = LOCAL[0]!
    const ly = LOCAL[1]!
    const lz = LOCAL[2]!
    const tx = 2 * (pqy * lz - pqz * ly) // qApply(parent.quat, local.pos)
    const ty = 2 * (pqz * lx - pqx * lz)
    const tz = 2 * (pqx * ly - pqy * lx)
    const x = ppx + (lx + pqw * tx + (pqy * tz - pqz * ty))
    const y = ppy + (ly + pqw * ty + (pqz * tx - pqx * tz))
    const z = ppz + (lz + pqw * tz + (pqx * ty - pqy * tx))
    const lqx = LOCAL[3]!
    const lqy = LOCAL[4]!
    const lqz = LOCAL[5]!
    const lqw = LOCAL[6]!
    const rx = pqx * lqw + pqw * lqx + pqy * lqz - pqz * lqy // qMul(parent.quat, local.quat)
    const ry = pqy * lqw + pqw * lqy + pqz * lqx - pqx * lqz
    const rz = pqz * lqw + pqw * lqz + pqx * lqy - pqy * lqx
    const rw = pqw * lqw - pqx * lqx - pqy * lqy - pqz * lqz
    const o = i * POSE_STRIDE
    out[o] = x
    out[o + 1] = y
    out[o + 2] = z
    // C-aim: override the rotation to aim local +Z at the target link's (prepass) world position, parent's
    // world +Y as up (default). Falls back to the composed rest.
    const ti = prepass ? t.aimTargetIdx[i]! : -1
    if (ti >= 0) {
      const up = t.aimUp[i]!
      const ux = up[0]
      const uy = up[1]
      const uz = up[2]
      const utx = 2 * (pqy * uz - pqz * uy) // qApply(parent.quat, aim.up)
      const uty = 2 * (pqz * ux - pqx * uz)
      const utz = 2 * (pqx * uy - pqy * ux)
      const to = ti * POSE_STRIDE
      lookAtInto(out, o + 3, x, y, z, prepass![to]!, prepass![to + 1]!, prepass![to + 2]!, ux + pqw * utx + (pqy * utz - pqz * uty), uy + pqw * uty + (pqz * utx - pqx * utz), uz + pqw * utz + (pqx * uty - pqy * utx), rx, ry, rz, rw)
    } else {
      out[o + 3] = rx
      out[o + 4] = ry
      out[o + 5] = rz
      out[o + 6] = rw
    }
  }
}

/**
 * {@link rigWorldPoses} into a caller-owned buffer from {@link rigPoseBuffer} - the allocation-free form
 * for the per-step sim path. Returns `out`.
 */
export function rigWorldPosesInto(out: Float64Array, geo: RigGeometry, values: Record<string, number>, subPoses?: Record<string, SubPose>, scale = 1, params: RigParams = {}, inclineRad = 0): Float64Array {
  const t = rigTables(geo)
  const need = t.links.length * POSE_STRIDE
  if (out.length < need) throw new Error(`rig pose buffer too small: ${out.length} < ${need} (rebuild it with rigPoseBuffer)`)
  if (t.hasAim) {
    // C-aim links (two-point look-at) need their target's world position. Aim changes only a link's own
    // rotation, so a first pass that ignores aim gives the correct target positions (valid as long as no aim
    // link is an ancestor of another aim link's target - the robot's hydraulics are leaves, so it holds). The
    // second pass then resolves each aim link's rotation toward those positions.
    const pre = (t.aimScratch ??= new Float64Array(need))
    composeInto(pre, t, values, subPoses, params, null)
    out.set(pre) // every link an aim rotation can't move is final already; pass 2 rewrites only the rest
    composeInto(out, t, values, subPoses, params, pre)
  } else {
    composeInto(out, t, values, subPoses, params, null)
  }
  // a uniform scale about the rig root (the part origin) - scales every link's position relative to the base.
  // Rotations are unaffected (uniform scale commutes with rotation); collision box sizes are not scaled here
  // (the scale convention targets visual-mesh rigs like the robot), so a scaled rig should use visual links.
  if (scale !== 1) {
    for (let o = 0; o < need; o += POSE_STRIDE) {
      out[o] = out[o]! * scale
      out[o + 1] = out[o + 1]! * scale
      out[o + 2] = out[o + 2]! * scale
    }
  }
  // C-incline: a whole-bed tilt about the rig root, around local +Z (cross-bed), so a conveyor's +X head lifts
  // by run·sin while the origin stays put (the `inclineParam` marker; docs/conveyor-incline.md). Applied as an
  // outer rotation on every link's world pose, so render (sdkPart FK), the kinematic wall/guard bodies
  // (buildRigBodies), and the static deck (attachRigConveyors) all tilt from one source. `leg` links are
  // excluded: the trestle pool builds them with its own tilt math (staying vertical + regrowing to the
  // floor), so tilting their FK pose would double-count. Opt-in (default 0); a non-conveying rig skips it.
  if (inclineRad !== 0) {
    const zq = qFromAxisAngle([0, 0, 1], inclineRad)
    const zx = zq[0]
    const zy = zq[1]
    const zz = zq[2]
    const zw = zq[3]
    const legs = t.legs // memoized; null when the rig has no leg links
    for (let i = 0; i < t.links.length; i++) {
      if (legs?.[i]) continue
      const o = i * POSE_STRIDE
      const x = out[o]!
      const y = out[o + 1]!
      const z = out[o + 2]!
      const tx = 2 * (zy * z - zz * y) // qApply(zq, pose.pos)
      const ty = 2 * (zz * x - zx * z)
      const tz = 2 * (zx * y - zy * x)
      out[o] = x + zw * tx + (zy * tz - zz * ty)
      out[o + 1] = y + zw * ty + (zz * tx - zx * tz)
      out[o + 2] = z + zw * tz + (zx * ty - zy * tx)
      const qx = out[o + 3]!
      const qy = out[o + 4]!
      const qz = out[o + 5]!
      const qw = out[o + 6]!
      out[o + 3] = zx * qw + zw * qx + zy * qz - zz * qy // qMul(zq, pose.quat)
      out[o + 4] = zy * qw + zw * qy + zz * qx - zx * qz
      out[o + 5] = zz * qw + zw * qz + zx * qy - zy * qx
      out[o + 6] = zw * qw - zx * qx - zy * qy - zz * qz
    }
  }
  return out
}

/**
 * World pose (relative to the part origin) of every link, keyed by link name - the convenience form for
 * callers that run once per edit rather than once per step (guard runs, collision shapes, render FK, body
 * build). It materialises a fresh {@link LinkPose} per link on top of {@link rigWorldPosesInto}; the
 * per-step sim path uses the flat buffer directly. Iteration order is the composition order, which body
 * build order depends on - see `mapOrder`.
 */
export function rigWorldPoses(geo: RigGeometry, values: Record<string, number>, subPoses?: Record<string, SubPose>, scale = 1, params: RigParams = {}, inclineRad = 0): Map<string, LinkPose> {
  const t = rigTables(geo)
  const buf = (t.mapScratch ??= new Float64Array(t.links.length * POSE_STRIDE))
  rigWorldPosesInto(buf, geo, values, subPoses, scale, params, inclineRad)
  const world = new Map<string, LinkPose>()
  for (let k = 0; k < t.mapOrder.length; k++) {
    const i = t.mapOrder[k]!
    const o = i * POSE_STRIDE
    world.set(t.links[i]!.name, { pos: [buf[o]!, buf[o + 1]!, buf[o + 2]!], quat: [buf[o + 3]!, buf[o + 4]!, buf[o + 5]!, buf[o + 6]!] })
  }
  return world
}

/**
 * Compose every pose in `buf` (part-local, from {@link rigWorldPosesInto}) with the part's own world
 * placement, in place. This is the flat form of the sim's per-link `composeRigLink`, so the buffer holds world
 * poses ready to drive kinematic bodies.
 */
export function composePartWorldInPlace(buf: Float64Array, partPos: readonly [number, number, number], partQuat: Quat): void {
  const qx = partQuat[0]
  const qy = partQuat[1]
  const qz = partQuat[2]
  const qw = partQuat[3]
  for (let o = 0; o < buf.length; o += POSE_STRIDE) {
    const x = buf[o]!
    const y = buf[o + 1]!
    const z = buf[o + 2]!
    const tx = 2 * (qy * z - qz * y) // qApply(partQuat, lp.pos)
    const ty = 2 * (qz * x - qx * z)
    const tz = 2 * (qx * y - qy * x)
    buf[o] = partPos[0] + (x + qw * tx + (qy * tz - qz * ty))
    buf[o + 1] = partPos[1] + (y + qw * ty + (qz * tx - qx * tz))
    buf[o + 2] = partPos[2] + (z + qw * tz + (qx * ty - qy * tx))
    const lx = buf[o + 3]!
    const ly = buf[o + 4]!
    const lz = buf[o + 5]!
    const lw = buf[o + 6]!
    buf[o + 3] = qx * lw + qw * lx + qy * lz - qz * ly // qMul(partQuat, lp.quat)
    buf[o + 4] = qy * lw + qw * ly + qz * lx - qx * lz
    buf[o + 5] = qz * lw + qw * lz + qx * ly - qy * lx
    buf[o + 6] = qw * lw - qx * lx - qy * ly - qz * lz
  }
}

/** One C-paramgeo entry resolved against the param bag: `param [× mulParam] × scale + add`, clamped to the
 *  ref's optional `[min, max]` - the clamp expresses a floor/ceiling the linear map can't (e.g. the Blade
 *  Stop's cornerZ floor); `mulParam` a param product it can't (the chain transfer's deck width =
 *  `chains` × `distance`). Returns null (the static axis stands) when `param` - or a declared `mulParam` -
 *  is missing/non-numeric. */
export function resolvedRef(sp: Omit<SizeParamRef, 'axis'>, params: RigParams): number | null {
  const v = params[sp.param]
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  let base = v
  if (sp.mulParam !== undefined) {
    const m = params[sp.mulParam]
    if (typeof m !== 'number' || !Number.isFinite(m)) return null
    base *= m
  }
  let out = base * (sp.scale ?? 1) + (sp.add ?? 0)
  if (sp.min !== undefined && out < sp.min) out = sp.min
  if (sp.max !== undefined && out > sp.max) out = sp.max
  return out
}

/** What one entry makes of a field that holds `current` so far: its resolved value, or that added to `current` for a
 *  `plus` entry (entries for one field apply in order). Null when the entry does not resolve (the field stands). */
export function foldedRef(current: number, sp: Omit<SizeParamRef, 'axis'>, params: RigParams): number | null {
  const v = resolvedRef(sp, params)
  return v === null ? null : sp.plus ? current + v : v
}

/**
 * A box's size with any C-paramgeo overrides applied: each `sizeParams` entry replaces one axis with
 * `params[param] * scale + add` (clamped to the entry's `[min, max]`) when that param is a finite number,
 * else the static `size` axis stands. The resolved size stays positive-or-fallback (a non-positive resolved
 * value falls back to the static axis, so a mis-set param can't make a degenerate/inverted box).
 */
export function resolvedBoxSize(size: Vec3, sizeParams: readonly SizeParamRef[] | undefined, params: RigParams): Vec3 {
  if (!sizeParams || sizeParams.length === 0) return size
  const out: Vec3 = [size[0], size[1], size[2]]
  for (const sp of sizeParams) {
    const resolved = foldedRef(out[sp.axis], sp, params)
    if (resolved !== null && resolved > 0) out[sp.axis] = resolved
  }
  return out
}

/** A link's `offset` with C-paramgeo offsetParams applied (a param positioning the sub-part, e.g. a hinge at
 *  ±length/2). Unlike size, an offset can be any sign, so there's no positivity guard. */
export function resolvedOffset(offset: Vec3, offsetParams: readonly SizeParamRef[] | undefined, params: RigParams): Vec3 {
  if (!offsetParams || offsetParams.length === 0) return offset
  const out: Vec3 = [offset[0], offset[1], offset[2]]
  for (const sp of offsetParams) {
    const resolved = foldedRef(out[sp.axis], sp, params)
    if (resolved !== null) out[sp.axis] = resolved
  }
  return out
}

/** The node-scaling factors for a mesh link: each `sizeParams` entry stretches one axis by `params[param] *
 *  scale + add` (a multiplier ~1 at the default param), the rest stay 1. A non-positive/NaN result falls back
 *  to 1 (a mis-set param can't collapse or invert the node). Used by render (node scale) + sim (collider). */
export function resolvedMeshScale(sizeParams: readonly SizeParamRef[] | undefined, params: RigParams): Vec3 {
  const out: Vec3 = [1, 1, 1]
  if (!sizeParams) return out
  for (const sp of sizeParams) {
    const f = foldedRef(out[sp.axis], sp, params)
    if (f !== null && f > 0) out[sp.axis] = f
  }
  return out
}

/** A cylinder's radius/height with C-paramgeo overrides applied: a `sizeParams` entry whose axis is 1 drives the
 *  height (the cylinder's local +Y length), axis 0 or 2 drives the radius. Non-positive resolved values fall back
 *  to the static dim (a mis-set param can't make a degenerate cylinder). */
export function resolvedCylinder(shape: Extract<RigShape, { kind: 'cylinder' }>, params: RigParams): { radius: number; height: number } {
  let radius = shape.radius
  let height = shape.height
  for (const sp of shape.sizeParams ?? []) {
    const resolved = foldedRef(sp.axis === 1 ? height : radius, sp, params)
    if (resolved !== null && resolved > 0) {
      if (sp.axis === 1) height = resolved
      else radius = resolved
    }
  }
  return { radius, height }
}

/** A beam's length (m) at these default-resolved params: its `rangeParam`'s value when that is a number > 0,
 *  else the static `range`. One rule for the sim's sensing ray and the renderer's line, so they can't disagree. */
export function resolvedBeamRange(beam: NonNullable<RigLink['beam']>, params: Readonly<Record<string, unknown>>): number {
  const v = beam.rangeParam !== undefined ? params[beam.rangeParam] : undefined
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : beam.range
}

/** Link half-extents with C-paramgeo size resolution (params known) - use in render + sim where the instance
 *  params are available; `shapeHalfExtents` is the param-less fallback (static size). */
export function linkHalfExtents(link: RigLink, params: RigParams): Vec3 {
  const s = link.shape
  if (s.kind === 'box' && s.sizeParams) {
    const sz = resolvedBoxSize(s.size, s.sizeParams, params)
    return [sz[0] / 2, sz[1] / 2, sz[2] / 2]
  }
  if (s.kind === 'cylinder' && s.sizeParams) {
    const { radius, height } = resolvedCylinder(s, params)
    return [radius, height / 2, radius]
  }
  const box = linkCollisionBox(link)
  if (s.kind === 'mesh' && box && s.sizeParams) {
    // node scaling: the collider stretches with the visual node so the sim body tracks a param-reshaped mesh
    const f = resolvedMeshScale(s.sizeParams, params)
    return [(box[0] / 2) * f[0], (box[1] / 2) * f[1], (box[2] / 2) * f[2]]
  }
  return shapeHalfExtents(s, box)
}

/** A gripper link's grab reach (metres) with C-paramgeo applied: the largest `grip.radiusParams` entry resolved
 *  against the instance params (`params[param] × scale + add`, clamped - the entry's `axis` is ignored for a
 *  spherical reach), else the static `grip.radius`, else the host 0.2 m default. Sized to the param-sized
 *  pickup volumes (the EOAT vacuum box = tool size + skin). */
export function resolvedGrabReach(link: RigLink, params: RigParams): number {
  let reach = link.grip?.radius ?? 0.2
  for (const sp of link.grip?.radiusParams ?? []) {
    const resolved = resolvedRef(sp, params)
    if (resolved !== null && resolved > reach) reach = resolved
  }
  return reach
}

/** C-multigrab: a gripper link's pickup volume in the link's own frame: half-extents with C-paramgeo applied
 *  (`grip.zone.sizeParams`, resolved exactly like a box link's size) plus its link-local centre `offset` (where the
 *  tool actually engages: a fork's load rides on the tines, ahead of the grab frame). Null when the link declares
 *  no zone - the caller then falls back to the {@link resolvedGrabReach} sphere. A box zone is the right shape
 *  for a vacuum plate: a sphere wide enough to span the plate also reaches under and beside it, and a gripper
 *  lifts everything its volume holds, so the volume decides how many bodies the tool can pick. */
export function resolvedGrabZone(link: RigLink, params: RigParams): { half: Vec3; offset: Vec3 } | null {
  const zone = link.grip?.zone
  if (!zone) return null
  const s = resolvedBoxSize(zone.size, zone.sizeParams, params)
  const o = zone.offset
  return { half: [s[0] / 2, s[1] / 2, s[2] / 2], offset: o ? [o[0], o[1], o[2]] : [0, 0, 0] }
}


/**
 * Host-computed cross-part geometry input for a placed part - the SDK-visible half of the seam-resolver
 * model (docs/seam-resolvers.md). Carries the part's world placement (so world-phase array distribution
 * puts rollers on a shared grid) plus any host-resolved seam struct. Optional + deterministic; `core`-only.
 */
export interface SeamContext {
  /** part world position (metres) */
  worldPos: Vec3
  /** part world yaw (radians) */
  worldRotY: number
  /** resolved grid anchor world point the pitch grid passes through; null/omitted = world origin */
  anchor?: readonly [number, number, number] | null
}

/** fposmod (floored modulo): positive remainder (shared with rollerGrid.ts). */
function fposmod(a: number, b: number): number {
  const r = a % b
  return r < 0 ? r + b : r
}

// The general per-link instance ceiling for the lattice (`grid`) and fixed-`count` forms, whose copies can
// be cloned scene nodes (EOAT cup GLBs, chain-transfer lanes) at one draw call each, so a tight budget.
const MAX_INSTANCES = 256
// The 1-D `distribute` form is only ever a bank of instanced primitives (roller beds, fence/guard-rail posts,
// platform support beams, all pooled InstancedMeshes), where each extra copy is ~16 floats sharing one draw
// call. The built-in roller bed has no cap at all.
// So it gets a far higher sanity ceiling, sized so no realistic bed truncates: 8192 copies is ~614 m at the
// 0.075 m roller pitch. The ceiling exists only to bound a pathological rig (a span ÷ a near-zero spacing)
// before it can OOM the tab; a genuine truncation is surfaced to the author (render buildRig's warnIfCapped).
export const MAX_DISTRIBUTE_INSTANCES = 8192
// The `pitch` form counts carriers, each its own kinematic body when posable: 365 moving carriers on a 100 m loop
// sorter measured 0.37 ms of physics a step, so this leaves room for the longest loops without letting a runaway
// span build thousands of bodies.
export const MAX_PITCH_INSTANCES = 1024

/** What to tell the author when this link's `pitch` row wants more copies than it holds at these params, else null:
 *  the copies would otherwise just spread out (a loop sorter's carriers drifting off their pitch). */
export function pitchCapMessage(link: RigLink, params: RigParams): string | null {
  const pitch = link.array?.pitch
  if (!pitch) return null
  const wanted = pitchArrayWanted(pitch, params)
  if (wanted <= MAX_PITCH_INSTANCES) return null
  return `"${link.name}" needs ${wanted} copies at this ${pitch.spanParam}, past the ${MAX_PITCH_INSTANCES} a pitch array holds: it has ${MAX_PITCH_INSTANCES}, so ctx.arrayCount and the row stop there. Shorten the span or widen the pitch.`
}

/** How many copies a `pitch` array wants for these params, round(span / pitch), before the MAX_PITCH_INSTANCES cap. */
export function pitchArrayWanted(pitch: NonNullable<NonNullable<RigLink['array']>['pitch']>, params: RigParams): number {
  const num = (name: string): number => {
    const v = params[name]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  let span = num(pitch.spanParam) * (pitch.spanScale ?? 1) + (pitch.spanAdd ?? 0)
  for (const t of pitch.spanTerms ?? []) span += num(t.param) * (t.scale ?? 1)
  span = Math.max(0, span)
  // +1e-9: a span of exactly n and a half pitches in decimal can land a hair under the half in binary (0.35 / 0.1)
  return pitch.pitch > 0 ? Math.max(1, Math.round(span / pitch.pitch + 1e-9)) : 1
}

/** World-phase distribution: copies are placed where `(W · flow axis)` is a multiple of `pitch` (offset by the
 *  anchor), so two collinear beds share grid lines with no snap-time communication - the SDK port of
 *  rollerStations' `anchor === null` path. Faithful to that function: phase from the part origin to the
 *  anchor, snap an FP-epsilon-short phase back to 0 so a grid-aligned seam keeps its edge copy. Placed along
 *  local +X (the conveyor flow axis); the perpendicular/vertical axes have no world-phase meaning. */
function worldPhaseDeltas(span: number, pitch: number, seam: SeamContext): Vec3[] {
  const f = forwardXZ(seam.worldRotY)
  const sOrigin = seam.worldPos[0] * f.x + seam.worldPos[2] * f.z
  const anchor = seam.anchor ?? null
  const hasAnchor = anchor !== null
  const anchorS = hasAnchor ? anchor[0] * f.x + anchor[2] * f.z : 0
  const toAnchor = anchorS - sOrigin
  let phase = fposmod(toAnchor, pitch)
  if (pitch - phase < 1e-6) phase = 0
  const lo = -span / 2
  const hi = span / 2
  const out: Vec3[] = []
  let x = phase + Math.ceil((lo - phase) / pitch) * pitch
  while (x < hi && out.length < MAX_DISTRIBUTE_INSTANCES) {
    // an anchored butt (a curve seam) owns the copy within half a pitch of the anchor. Drop ours so the seam
    // doesn't double up, exactly like rollerStations' anchored path. Collinear straight butts carry no anchor.
    if (!(hasAnchor && Math.abs(x - toAnchor) < pitch * 0.5)) out.push([x, 0, 0])
    x += pitch
  }
  return out.length ? out : [[0, 0, 0]]
}

/** One axis of a `grid` array resolved to instance coordinates. Two spacing modes:
 *   - default: usable = max(size − 2·margin, 0), count = floor(usable/pitch)+1
 *     clamped 1..64 - the cup bed's "fit as many as pitch allows" (actual spacing ≈ pitch).
 *   - `maxSpacing` (structure grid): ceil/OSHA semantics - count = spans+1 where spans = max(1, ceil(usable/
 *     maxSpacing)), so every gap stays ≤ maxSpacing. This mirrors a 1-D `distribute` and the
 *     built-in platform's supportPositions - an X×Z lattice of support columns at OSHA max column spacing.
 *  Either way the instances spread edge-to-edge across ±usable/2 (single instance → centred at 0). The spec's
 *  static size/pitch/margin stand in when a param doesn't resolve (a pre-schema scene's sparse instance params). */
function gridAxisCoords(axis: { sizeParam: string; pitchParam?: string; marginParam?: string; size?: number; pitch?: number; margin?: number; maxSpacing?: number }, params: RigParams, num: (name: string, fallback: number) => number): number[] {
  const size = num(axis.sizeParam, axis.size ?? 0)
  const margin = axis.marginParam !== undefined || axis.margin !== undefined ? Math.max(num(axis.marginParam ?? '', axis.margin ?? 0), 0) : 0
  const usable = Math.max(size - margin * 2, 0)
  let count: number
  if (axis.maxSpacing !== undefined && axis.maxSpacing > 0) {
    count = Math.min(64, Math.max(1, Math.ceil(usable / axis.maxSpacing)) + 1)
  } else {
    const pitch = Math.max(num(axis.pitchParam ?? '', axis.pitch ?? 0.1), 1e-4)
    // +1e-6 before floor: usable/pitch is FP-lossy (1.9/0.1 = 18.999…, not 19), and truncating that drops a
    // whole row - the epsilon rounds the near-integer up to the count the author means (a cup every `pitch`).
    count = Math.max(1, Math.min(64, Math.floor(usable / pitch + 1e-6) + 1))
  }
  if (count === 1) return [0]
  const start = -usable / 2
  const step = usable / (count - 1)
  return Array.from({ length: count }, (_, i) => start + i * step)
}

/** array-links: the per-instance offset delta (relative to a link's base offset) for each generated copy.
 *  `distribute` spreads N = ceil(span/maxSpacing)+1 copies evenly + centred across the span; with
 *  `worldPhase` (+ a `seam`) the copies instead sit on the world pitch grid so collinear beds align
 *  (docs/seam-resolvers.md). `count`+`step` places `params[count]` copies `step` apart (centred or growing
 *  from the base); `stepParams` (C-paramgeo) makes a `step` axis track an instance param - the chain
 *  transfer's lane spacing following its `distance` param - with the static axis as the fallback. `grid`
 *  crosses two param-driven axes into an X×Z lattice (the EOAT cup bed; see gridAxisCoords). `pitch` fits round(span /
 *  pitch) copies exactly `pitch` apart, centred. `showParam` is the link's switch (RigLink.showParam): false ⇒ zero
 *  deltas (mesh + collision vanish). The lattice and `count` forms are capped at MAX_INSTANCES (256), `pitch` at
 *  MAX_PITCH_INSTANCES (1024), and the always-instanced `distribute` form at the far higher MAX_DISTRIBUTE_INSTANCES. A
 *  non-array link (or one with no resolvable count) yields a single `[0,0,0]` (the link itself). */
export function arrayInstanceDeltas(array: NonNullable<RigLink['array']>, params: RigParams, seam?: SeamContext, showParam?: string): Vec3[] {
  if (!showParamShows(showParam, params)) return []
  const MAX = MAX_INSTANCES
  const num = (name: string, fallback: number): number => {
    const v = params[name]
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }
  // End-omission for the 1-D forms: drop the first/last copy when the named boolean param is true, so two
  // barriers butt together without a doubled post at the junction (the built-in guard rail's omitPostStart/End).
  // "first" = the low end of the axis (−span/2). Never empties the array - a lone instance keeps at least itself.
  const trimEnds = (out: Vec3[]): Vec3[] => {
    const omitFirst = array.omitFirstParam ? params[array.omitFirstParam] === true : false
    const omitLast = array.omitLastParam ? params[array.omitLastParam] === true : false
    if (!omitFirst && !omitLast) return out
    let lo = 0
    let hi = out.length
    if (omitFirst && hi - lo > 1) lo++
    if (omitLast && hi - lo > 1) hi--
    return lo === 0 && hi === out.length ? out : out.slice(lo, hi)
  }
  if (array.grid) {
    const xs = gridAxisCoords(array.grid.x, params, num)
    const zs = gridAxisCoords(array.grid.z, params, num)
    // per-axis counts are already capped at 64; keep the total within the array budget by thinning the
    // larger axis (spacing degrades toward > pitch instead of the lattice silently truncating one corner)
    let cx = xs.length
    let cz = zs.length
    while (cx * cz > MAX) {
      if (cx >= cz) cx--
      else cz--
    }
    const thin = (coords: number[], n: number): number[] =>
      n === coords.length ? coords : n === 1 ? [0] : Array.from({ length: n }, (_, i) => coords[0]! + ((coords[coords.length - 1]! - coords[0]!) * i) / (n - 1))
    const out: Vec3[] = []
    for (const x of thin(xs, cx)) for (const z of thin(zs, cz)) out.push([x, 0, z])
    return out
  }
  if (array.distribute) {
    const { axis, spanParam, spanAdd, maxSpacing, worldPhase } = array.distribute
    const span = Math.max(0, num(spanParam, 0) + (spanAdd ?? 0))
    // world-phase (opt-in): flow-axis grid alignment across parts; needs the placement seam. Falls back to
    // centred distribution when no seam is supplied (e.g. a bare geometry-eval call) so it stays deterministic.
    if (worldPhase && seam && axis === 0 && span > 0 && maxSpacing > 0) {
      return trimEnds(worldPhaseDeltas(span, maxSpacing, seam))
    }
    const numSpans = Math.max(1, Math.min(MAX_DISTRIBUTE_INSTANCES - 1, Math.ceil(span / maxSpacing)))
    const step = span / numSpans
    const out: Vec3[] = []
    for (let i = 0; i <= numSpans; i++) {
      const d: Vec3 = [0, 0, 0]
      d[axis] = -span / 2 + i * step
      out.push(d)
    }
    return trimEnds(out)
  }
  if (array.pitch) {
    const { axis, pitch } = array.pitch
    const n = Math.min(MAX_PITCH_INSTANCES, pitchArrayWanted(array.pitch, params))
    const out: Vec3[] = []
    for (let i = 0; i < n; i++) {
      const d: Vec3 = [0, 0, 0]
      d[axis] = (i - (n - 1) / 2) * pitch
      out.push(d)
    }
    return trimEnds(out)
  }
  const n = Math.max(1, Math.min(MAX, Math.round(num(array.count ?? '', 1))))
  // C-paramgeo: a stepParams entry replaces one static `step` axis with `params[param] × scale + add`
  // (same resolution as a link's offsetParams - sign-free), so e.g. lane spacing follows a live param.
  const step = resolvedOffset(array.step ?? [0, 0, 0], array.stepParams, params)
  const base = array.centered ? -(n - 1) / 2 : 0
  const out: Vec3[] = []
  for (let i = 0; i < n; i++) {
    const k = base + i
    out.push([k * step[0], k * step[1], k * step[2]])
  }
  return trimEnds(out)
}

export { copyGripName, parseCopyGripName } from '../parts/partPackage'

/** A posable array link as a behavior is told about it: what `ctx.arrayCount` resolves from its params. */
export interface PosableArraySpec {
  name: string
  array: NonNullable<RigLink['array']>
  showParam?: string
}

/** The rig's posable array links (`array.posable`), as the JSON a behavior is created with, or undefined when it has
 *  none. The behavior resolves each count with its own params, the ones the sim builds the instance bodies from. */
export function posableArraysJson(geometry: { kind: string; links?: readonly RigLink[] }): string | undefined {
  if (geometry.kind !== 'rig' || !geometry.links) return undefined
  const specs: PosableArraySpec[] = geometry.links
    .filter((l) => l.array?.posable === true)
    .map((l) => ({ name: l.name, array: l.array!, ...(l.showParam ? { showParam: l.showParam } : {}) }))
  return specs.length ? JSON.stringify(specs) : undefined
}

/** A mesh or frame link's declared collision box (its full size), or undefined: `collision: { box }` on the link. */
export function linkCollisionBox(link: { collision?: RigLink['collision'] }): Vec3Tuple | undefined {
  return typeof link.collision === 'object' ? link.collision.box : undefined
}

/** Box half-extents approximating a link shape - the kinematic collision proxy for cargo pushing. A mesh or a
 *  frame uses the link's declared collision `box` (pass it in: {@link linkCollisionBox}), or zero (no body - the
 *  sim skips one for it). */
export function shapeHalfExtents(shape: RigShape, meshBox?: Vec3Tuple): Vec3 {
  switch (shape.kind) {
    case 'box':
      return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2]
    case 'cylinder':
      return [shape.radius, shape.height / 2, shape.radius]
    case 'cone':
      return [0, 0, 0] // render-only schematic cue: no collision body (cargo passes through)
    case 'mesh':
      return meshBox ? [meshBox[0] / 2, meshBox[1] / 2, meshBox[2] / 2] : [0, 0, 0]
    case 'frame':
      // transform-only, unless it declares a collision box (a solid whose look comes from geometry())
      return meshBox ? [meshBox[0] / 2, meshBox[1] / 2, meshBox[2] / 2] : [0, 0, 0]
    case 'label':
      return [0, 0, 0] // render-only text plane: no collision body
    case 'leg':
      return [0, 0, 0] // support-leg trestle row: structural, render-only (cargo never touches it)
  }
}

// ---- who decides a link's fields ---------------------------------------------------------------------------
//
// A link's authored offset, rest rotation, size and visibility are not always what the part shows: a param can
// replace an axis (offsetParams, sizeParams), an aim constraint replaces the rotation, a showParam owns the
// visibility. An editor that offers those fields as editable accepts an edit that the next refresh silently
// overwrites, which shows up as "the node won't move" bugs. So the question "is this field the author's?" has one
// answer, here, beside the resolver whose rules it describes (rigWorldPosesInto / resolvedOffset / resolvedBoxSize
// / resolvedCylinder), and it uses the same param resolution (a param that does not resolve for this instance
// leaves the authored value in force, exactly as those do). editor/linkOwnership.test.ts holds every first-party
// part to it by perturbing each field through the resolver.
//
// The rule the editor follows from it (the "allow real flaws" principle): lock a field only when an edit to it
// would be overwritten. A field whose edit works but has a consequence gets a note, never a lock.

/** Who decides one field of a rig link, when it is not the link's own authored value. */
export type LinkFieldOwner = { by: 'param'; param: string } | { by: 'aim'; target: string }

/** Something true of a link that an author should know, though none of its fields is taken from them. */
export type LinkNote =
  /** a joint moves the link from its authored rest pose (the pose at joint value 0) */
  | { kind: 'joint'; joint: string; type: 'revolute' | 'prismatic' }
  /** the link is repeated into copies; `worldPhase`: they lock to a world-wide pitch along X, so moving the link
   *  along X pulls them off it (butted beds stop lining up) */
  | { kind: 'array'; worldPhase: boolean }
  /** the part's script draws on this link (geometry() names it): the drawing moves with it; its shape is the script's */
  | { kind: 'drawn' }

export interface LinkFieldOwnership {
  /** per position axis (parent-local, as `offset` is stored) */
  offset: [LinkFieldOwner | null, LinkFieldOwner | null, LinkFieldOwner | null]
  /** the rest rotation, as one field */
  rotation: LinkFieldOwner | null
  /** a box's size per axis; null for any other shape */
  boxSize: [LinkFieldOwner | null, LinkFieldOwner | null, LinkFieldOwner | null] | null
  /** a cylinder's radius and height; null for any other shape */
  cylinder: { radius: LinkFieldOwner | null; height: LinkFieldOwner | null } | null
  /** whether the link shows (the Scene tree's eye) */
  visible: LinkFieldOwner | null
  notes: LinkNote[]
}

/** an offset/size param ref takes its field over when it resolves for these params (sizes only when positive) */
function refOwner(sp: SizeParamRef, params: RigParams, positive: boolean): LinkFieldOwner | null {
  const r = resolvedRef(sp, params)
  return r !== null && (!positive || r > 0) ? { by: 'param', param: sp.param } : null
}

/** a script names a link it draws on as a whole string literal (`link: 'roller'`), as setSubPose names do */
function behaviorDrawsOn(behavior: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\blink\\s*:\\s*(['"\`])${esc}\\1`).test(behavior)
}

/**
 * The part-local box a rig fills at rest, measured from its links: each box, cylinder and cone at its rest pose with
 * the instance's params, rotated into the part frame. The footprint of a rig that declares no `bounds`
 * (partGeometry.ts partFootprint), so a part made in the app or written without bounds snaps and selects as the shape
 * it is. Null when core can't measure the rig: a mesh, label or leg link (their size is the model's or the host's),
 * an array, or an incline; the caller keeps its default box then. A frame link draws nothing, and a link its
 * `showParam` turns off is left out.
 */
export function rigRestExtent(geo: RigGeometry, params: RigParams): { min: Vec3; max: Vec3 } | null {
  if (geo.inclineParam !== undefined) return null
  const poses = rigWorldPoses(geo, {}, undefined, 1, params)
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const link of geo.links) {
    const s = link.shape
    if (s.kind === 'frame') continue
    if (s.kind !== 'box' && s.kind !== 'cylinder' && s.kind !== 'cone') return null
    if (link.array) return null
    if (!showParamShows(link.showParam, params)) continue
    const h = s.kind === 'cone' ? ([s.radius, s.height / 2, s.radius] as Vec3) : linkHalfExtents(link, params)
    const pose = poses.get(link.name)
    if (!pose) return null
    // the half extents of a rotated box, on the part's axes: |R| applied to h
    const [x, y, z, w] = pose.quat
    const r = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    for (let i = 0; i < 3; i++) {
      const e = Math.abs(r[i]![0]!) * h[0] + Math.abs(r[i]![1]!) * h[1] + Math.abs(r[i]![2]!) * h[2]
      min[i] = Math.min(min[i]!, pose.pos[i]! - e)
      max[i] = Math.max(max[i]!, pose.pos[i]! + e)
    }
  }
  return min[0] === Infinity ? null : { min, max }
}

/**
 * {@link linkFieldOwnership} for a placed part: its own params resolved against the package's first, as the renderer
 * resolves them. A setting the part never set (one added to the part after it was placed) owns its field at its
 * default, so the panel and the gizmo lock what the setting draws.
 */
export function partLinkOwnership(pkg: { geometry: PartPackageGeometry; params: ParamSchema; behavior: string }, linkName: string, partParams: Record<string, unknown>): LinkFieldOwnership | null {
  if (pkg.geometry.kind !== 'rig') return null
  return linkFieldOwnership(pkg.geometry, linkName, resolvePartParams(pkg.params, partParams as Record<string, ParamValue>) as RigParams, pkg.behavior)
}

/**
 * Who decides each editable field of the link `linkName`, for an instance with these `params`; null when there is
 * no such link. `behavior` (the part's script) lets it note a link the script draws on. A placed part's params go
 * through {@link partLinkOwnership}, which fills in the defaults of the ones it never set.
 */
export function linkFieldOwnership(geo: RigGeometry, linkName: string, params: RigParams, behavior = ''): LinkFieldOwnership | null {
  const link = geo.links.find((l) => l.name === linkName)
  if (!link) return null
  const offset: LinkFieldOwnership['offset'] = [null, null, null]
  // the last resolving ref for an axis owns it, since resolvedOffset applies them in order
  for (const sp of link.offsetParams ?? []) offset[sp.axis] = refOwner(sp, params, false) ?? offset[sp.axis]
  let rotation: LinkFieldOwner | null = link.aim ? { by: 'aim', target: link.aim.target } : null
  if (!rotation && !link.quat) for (const sp of link.rotationParams ?? []) rotation = refOwner(sp, params, false) ?? rotation
  let boxSize: LinkFieldOwnership['boxSize'] = null
  let cylinder: LinkFieldOwnership['cylinder'] = null
  const shape = link.shape
  if (shape.kind === 'box') {
    boxSize = [null, null, null]
    for (const sp of shape.sizeParams ?? []) boxSize[sp.axis] = refOwner(sp, params, true) ?? boxSize[sp.axis]
  } else if (shape.kind === 'cylinder') {
    cylinder = { radius: null, height: null }
    for (const sp of shape.sizeParams ?? []) {
      const o = refOwner(sp, params, true)
      if (!o) continue
      if (sp.axis === 1) cylinder.height = o
      else cylinder.radius = o
    }
  }
  const visible: LinkFieldOwner | null = link.showParam ? { by: 'param', param: link.showParam } : null
  const notes: LinkNote[] = []
  const joint = geo.joints.find((j) => j.link === link.name)
  if (joint) notes.push({ kind: 'joint', joint: joint.name, type: joint.type })
  if (link.array) notes.push({ kind: 'array', worldPhase: link.array.distribute?.worldPhase === true })
  if (behavior && behaviorDrawsOn(behavior, link.name)) notes.push({ kind: 'drawn' })
  return { offset, rotation, boxSize, cylinder, visible, notes }
}
