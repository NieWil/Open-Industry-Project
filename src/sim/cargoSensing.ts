// Cargo sensing for SimWorld: sink zones (ctx.zone), sensor beams (ctx.sense) and the grippers' grab volumes,
// read from the step's batched pose rows (index-aligned with CargoRegistry.boxes) when the build provides them.
import type Jolt from 'jolt-physics'
import { rayCapsuleY, rayObb } from '../core/beamCast'
import type { FrameBeamHit } from '../core/frame'
import type { ParamValue } from '../core/parts/partApi'
import type { PartPackage } from '../core/parts/partPackage'
import { qApply, qConjugate, qFromAxisAngle, resolvedBeamRange, resolvedBoxSize, rigWorldPoses } from '../core/rig/rigPose'
import type { Quat, RigParams, Vec3 } from '../core/rig/rigPose'
import type { SdkPart } from '../core/types'
import { marksOf } from './worldTypes'
import type { BodyHolder, LiveBox } from './worldTypes'

/** a sink part's world-space detection/removal zone: a box axis-aligned in the part's yaw frame (`cos`/`sin` of the yaw) */
export interface ZoneBox {
  name: string
  cx: number
  cy: number
  cz: number
  hx: number
  hy: number
  hz: number
  cos: number
  sin: number
}

/** a sensor part's world-space beam ray, with the link-local `axis` it is re-aimed from when its link moves */
export interface BeamEmitter {
  name: string
  origin: Vec3
  dir: Vec3
  range: number
  axis: Vec3
}

// Pilot push body: a kinematic capsule tracking the walking pilot (the pilot
// capsule - radius 0.3, total height 1.8 measured up from the
// feet). Driven by MoveKinematic each step like a diverter pusher, it imparts
// real velocity to a box the player walks into instead of just blocking it. The
// pilot-vs-world collision still lives render-side (raycast); this body only ever
// touches dynamic cargo, so the push is one-way (the box yields, the pilot doesn't).
export const PILOT_BODY_RADIUS = 0.3
export const PILOT_BODY_HEIGHT = 1.8
/** the tint a sensor beam reads off the pilot's body: a mid grey, which a colour sensor calls "no colour" rather
 *  than mistaking a person for a red box */
export const PILOT_BEAM_COLOR: [number, number, number] = [0.35, 0.35, 0.35]

// C-despawn: precompute the world-space detection/removal zone box for each `zone` link of a sink part (sinks are
// static). Each tick countZone() feeds ctx.zone() and fulfillDespawns() removes cargo on ctx.despawn().
export function rigZones(part: SdkPart, geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, scale: number): ZoneBox[] {
  const zoned = geo.links.filter((l) => l.zone)
  if (zoned.length === 0) return []
  const partQuat = qFromAxisAngle([0, 1, 0], part.rotationY)
  const rest = rigWorldPoses(geo, {}, undefined, scale, part.params as RigParams)
  const cos = Math.cos(part.rotationY)
  const sin = Math.sin(part.rotationY)
  const zones: { name: string; cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; cos: number; sin: number }[] = []
  for (const link of zoned) {
    const lp = rest.get(link.name)
    if (!lp || !link.zone) continue
    const wp = qApply(partQuat, lp.pos)
    // C-paramgeo: resolve the zone box against the instance params so a resizable despawner's trigger
    // volume tracks its length/height/width sliders (falls back to the static size when unparameterized).
    const s = resolvedBoxSize(link.zone.size, link.zone.sizeParams, part.params as RigParams)
    zones.push({ name: link.name, cx: part.position[0] + wp[0], cy: part.position[1] + wp[1], cz: part.position[2] + wp[2], hx: s[0] / 2, hy: s[1] / 2, hz: s[2] / 2, cos, sin })
  }
  return zones
}

// Is a world point inside a zone box (axis-aligned in the part's yaw frame)?
export function pointInZone(z: { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; cos: number; sin: number }, x: number, y: number, zc: number): boolean {
  if (y < z.cy - z.hy || y > z.cy + z.hy) return false
  const dx = x - z.cx
  const dz = zc - z.cz
  const lx = dx * z.cos - dz * z.sin
  const lz = dx * z.sin + dz * z.cos
  return Math.abs(lx) <= z.hx && Math.abs(lz) <= z.hz
}

// C-sensing: the world-space ray (origin + unit dir) for each beam link of a sensor rig, at its rest pose. A static
// sensor keeps it for the part's lifetime; a beam on a moving link is re-aimed by RigDriver.drive.
export function rigBeams(part: SdkPart, geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, scale: number, resolvedParams: Record<string, ParamValue>): BeamEmitter[] {
  const emitters = geo.links.filter((l) => l.beam)
  if (emitters.length === 0) return []
  const partQuat = qFromAxisAngle([0, 1, 0], part.rotationY)
  const rest = rigWorldPoses(geo, {}, undefined, scale, part.params as RigParams)
  const beams: { name: string; origin: Vec3; dir: Vec3; range: number; axis: Vec3 }[] = []
  for (const link of emitters) {
    const lp = rest.get(link.name)
    if (!lp || !link.beam) continue
    const wp = qApply(partQuat, lp.pos)
    const origin: Vec3 = [part.position[0] + wp[0], part.position[1] + wp[1], part.position[2] + wp[2]]
    const axis: Vec3 = [...(link.beam.axis ?? [0, 0, 1])]
    const ld = qApply(lp.quat, axis) // link-local beam axis → part frame
    const wd = qApply(partQuat, ld) // → world
    const len = Math.hypot(wd[0], wd[1], wd[2]) || 1
    // `rangeParam` (default-resolved) sets the sensing reach; else the static range (rigPose.resolvedBeamRange)
    beams.push({ name: link.name, origin, dir: [wd[0] / len, wd[1] / len, wd[2] / len], range: resolvedBeamRange(link.beam, resolvedParams), axis })
  }
  return beams
}

function sameColor(a: readonly number[], b: readonly number[]): boolean {
  return a === b || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2])
}

// Cast one world beam against every cargo box; return the nearest hit (or a clear result at full range).
// `snap` is the step's batched pose rows (null = stock build), `near` the rows the cargo registry's floor grid says may lie
// near the beam (null = every row), `s` the sensor registry's scratch for the OBB test and `pilotBody` the walking pilot.
// `hit.box` is left holding the cargo body the beam hit, or null when it is clear or hit the pilot (ctx.markHit).
// `prev` is what this beam read on the step before. The same object is returned when the beam reads the same now,
// so a beam with nothing new allocates nothing and its caller can tell by comparing the two. A reading is never
// written in place.
export function castBeamRows(
  origin: Vec3,
  dir: Vec3,
  range: number,
  boxes: readonly LiveBox[],
  snap: Float32Array | null,
  near: readonly number[] | null,
  s: { pos: Vec3; quat: Quat; half: Vec3 },
  pilotBody: Jolt.Body | null,
  hit?: { box: LiveBox | null },
  prev?: FrameBeamHit,
): FrameBeamHit {
  if (hit) hit.box = null
  let bestT = Infinity
  let best: LiveBox | null = null
  const ox = origin[0]
  const oy = origin[1]
  const oz = origin[2]
  const dx = dir[0]
  const dy = dir[1]
  const dz = dir[2]
  const rows = near ? near.length : boxes.length
  for (let k = 0; k < rows; k++) {
    const i = near ? near[k]! : k
    const box = boxes[i]!
    const o = i * 7
    let cx: number
    let cy: number
    let cz: number
    if (snap) {
      cx = snap[o] as number
      cy = snap[o + 1] as number
      cz = snap[o + 2] as number
    } else {
      const p = box.body.GetPosition()
      cx = p.GetX()
      cy = p.GetY()
      cz = p.GetZ()
    }
    // Bounding-sphere prefilter, sqrt-free (dir is unit): most boxes are nowhere near a given beam, so
    // reject on the centre's behind/overshoot/perpendicular distance vs the box's bounding radius before
    // running the OBB slab test (and, on the stock-build path, the rotation's WASM getters). The
    // sphere contains the OBB, so this can never reject a box the slab test would hit.
    const rSq = box.hx * box.hx + box.hy * box.hy + box.hz * box.hz
    const wx = cx - ox
    const wy = cy - oy
    const wz = cz - oz
    const wSq = wx * wx + wy * wy + wz * wz
    const tProj = wx * dx + wy * dy + wz * dz
    if (tProj < 0) {
      if (wSq > rSq) continue // centre behind the emitter and origin outside the sphere
    } else if (tProj > range) {
      const over = tProj - range
      if (over * over > rSq) continue // whole sphere starts past the beam's range
    }
    if (wSq - tProj * tProj > rSq) continue // beam line passes wide of the sphere
    s.pos[0] = cx
    s.pos[1] = cy
    s.pos[2] = cz
    if (snap) {
      s.quat[0] = snap[o + 3] as number
      s.quat[1] = snap[o + 4] as number
      s.quat[2] = snap[o + 5] as number
      s.quat[3] = snap[o + 6] as number
    } else {
      const q = box.body.GetRotation()
      s.quat[0] = q.GetX()
      s.quat[1] = q.GetY()
      s.quat[2] = q.GetZ()
      s.quat[3] = q.GetW()
    }
    s.half[0] = box.hx
    s.half[1] = box.hy
    s.half[2] = box.hz
    const t = rayObb(origin, dir, s.pos, s.quat, s.half)
    if (t !== null && t <= range && t < bestT) {
      bestT = t
      best = box
    }
  }
  // the walking pilot blocks beams like a person blocks a real photo-eye (and a light curtain exists to see
  // one). Beams only: zones count and despawn cargo, so the pilot never enters a sink's tally. That includes a
  // light curtain's muting sensors: a person who blocks them in the right order mutes it, as on a real line.
  if (pilotBody) {
    const p = pilotBody.GetPosition()
    const t = rayCapsuleY(origin, dir, p.GetX(), p.GetY(), p.GetZ(), (PILOT_BODY_HEIGHT - 2 * PILOT_BODY_RADIUS) / 2, PILOT_BODY_RADIUS)
    if (t !== null && t <= range && t < bestT) {
      if (prev && prev.hit && prev.distance === t && prev.marks === undefined && sameColor(prev.color, PILOT_BEAM_COLOR)) return prev
      return { hit: true, distance: t, color: PILOT_BEAM_COLOR }
    }
  }
  if (!best) {
    if (prev && !prev.hit && prev.distance === range) return prev
    return { hit: false, distance: range, color: [0, 0, 0] }
  }
  if (hit) hit.box = best
  const marks = marksOf(best)
  if (prev && prev.hit && prev.distance === bestT && prev.marks === (marks ?? undefined) && sameColor(prev.color, best.color)) return prev
  return { hit: true, distance: bestT, color: best.color, ...(marks ? { marks } : {}) }
}

/** every unheld (no gripper, pilot or pin - see holders) cargo box whose surface is within `radius` of a world point: the pickup volume for
 *  a gripper link that declares no `grabZone`. Distance is measured to the box's oriented bounding box (0 if
 *  the point is inside), not its centre. A top-down vacuum cup contacts the box's top face, so a
 *  centre-distance test would miss it by ~half the box height, enough that the demo robot could not pick. */
export function grabbableBoxesInReach(boxes: readonly LiveBox[], holders: ReadonlyMap<number, BodyHolder>, snap: Float32Array | null, pos: Vec3, radius: number): LiveBox[] {
  const found: LiveBox[] = []
  const radiusSq = radius * radius
  // a commanded-but-empty gripper polls this every step while seeking (the idle-rig skip keeps it live for
  // exactly that), so read the batched snapshot rows (index-aligned with boxes[i]) instead of making ~9
  // WASM getter crossings per box; getters remain the stock-build fallback.
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]
    if (!box || holders.has(box.id)) continue
    let bx: number, by: number, bz: number
    let quat: Quat
    if (snap) {
      const o = i * 7
      bx = snap[o] as number
      by = snap[o + 1] as number
      bz = snap[o + 2] as number
      quat = [snap[o + 3] as number, snap[o + 4] as number, snap[o + 5] as number, snap[o + 6] as number]
    } else {
      const p = box.body.GetPosition()
      bx = p.GetX()
      by = p.GetY()
      bz = p.GetZ()
      const q = box.body.GetRotation()
      quat = [q.GetX(), q.GetY(), q.GetZ(), q.GetW()]
    }
    // the gripper point in the box's local frame, then the distance to the box surface (clamp to extents)
    const rel: Vec3 = [pos[0] - bx, pos[1] - by, pos[2] - bz]
    const local = qApply(qConjugate(quat), rel)
    const ex = Math.max(0, Math.abs(local[0]) - box.hx)
    const ey = Math.max(0, Math.abs(local[1]) - box.hy)
    const ez = Math.max(0, Math.abs(local[2]) - box.hz)
    const d = ex * ex + ey * ey + ez * ez
    if (d < radiusSq) found.push(box)
  }
  return found
}

/**
 * C-multigrab: every unheld cargo box whose centre lies inside an oriented box volume: `half`
 * half-extents at link-local `centre`, on a frame at `pos` rotated by `quat` (the gripper link's live world
 * pose). Centre-inside is the right test for a plate volume (a surface test would also catch a box the plate has
 * merely brushed past); the volume is authored deep enough to contain the cargo it is meant to lift.
 */
export function grabbableBoxesInZone(boxes: readonly LiveBox[], holders: ReadonlyMap<number, BodyHolder>, snap: Float32Array | null, pos: Vec3, quat: Quat, half: Vec3, centre: Vec3): LiveBox[] {
  const found: LiveBox[] = []
  const inv = qConjugate(quat)
  // same batched-snapshot read as grabbableBoxesInReach: a commanded-but-empty gripper polls this every step
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]
    if (!box || holders.has(box.id)) continue
    let bx: number, by: number, bz: number
    if (snap) {
      const o = i * 7
      bx = snap[o] as number
      by = snap[o + 1] as number
      bz = snap[o + 2] as number
    } else {
      const p = box.body.GetPosition()
      bx = p.GetX()
      by = p.GetY()
      bz = p.GetZ()
    }
    // the box centre in the gripper's frame, re-based on the volume's centre and tested against its half-extents
    const local = qApply(inv, [bx - pos[0], by - pos[1], bz - pos[2]])
    if (Math.abs(local[0] - centre[0]) > half[0] || Math.abs(local[1] - centre[1]) > half[1] || Math.abs(local[2] - centre[2]) > half[2]) continue
    found.push(box)
  }
  return found
}
