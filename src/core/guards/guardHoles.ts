import { FRAME_WALL_THICKNESS, GUARD_HEIGHT, GUARD_HOLE_PANEL, GUARD_HOLE_RADIUS, GUARD_THICKNESS } from '../types'
import type { PartInstance } from '../types'
import type { MeshDescription, ParamValue } from '../parts/partApi'
import { hostGuardFrame } from './guardOpenings'
import { hostSurfaceY } from './guardExtents'
import { bedView, curvedGizmoOf, toLocalXZ } from '../parts/partGeometry'
import { getPackage, registryRevision } from '../parts/partRegistry'
import { resolvePartParams } from '../parts/partScript'
import { qApply, qFromAxisAngle, resolvedBeamRange, rigWorldPoses } from '../rig/rigPose'
import type { RigParams } from '../rig/rigPose'
import { extrudeDescription } from '../geometry/geometryShapes'

/**
 * Sensor-beam holes through conveyor side guards, derived from the scene: where every sensing beam in it crosses a
 * guard's sheet, that guard gets a round hole (GUARD_HOLE_RADIUS) the beam passes through.
 *
 * A hole is a fact about the document (a mounted eye's beam never moves), so it is worked out once per scene change,
 * like a guard opening (guardOpenings.ts). The host's geometry splits its sheet around it and fills the gap with a
 * holed panel ({@link guardHolePanelDescription}). A per-frame shader with a 16-slot scene-wide uniform is the
 * alternative and has no priority (a part with 16 beams starves every eye), a per-pixel loop, render-bundle churn,
 * and holes that never show in a thumbnail or headless shot.
 *
 * Visual only: beams aren't physical, so the sim never reads these and the guard's collider stays whole.
 *
 * The frame is the host's own, the one its guard is built in:
 *   - a straight bed (belt-like, roller, spur): x along its length in the same frame as {@link GuardOpenings}
 *     (a belt's plan X from the tail, which its geometry maps onto the path; a centre-origin bed's X along its
 *     slope), left = −Z, right = +Z.
 *   - a curved bed: x is the arc angle (radians, 0 at the inlet, growing with the sweep), left = the inner guard,
 *     right = the outer one.
 * y is the hole centre's height above the running surface. A disc past the sheet's edge is pulled back inside, so a
 * hole is never a notch.
 */

export type GuardHole = [x: number, y: number]
export interface GuardHoles {
  left: GuardHole[]
  right: GuardHole[]
}

/** a beam is taken from this far behind its emitter, so the guard an eye stands against is cut even when the lens
 *  sits just outside it (a seated lens is 7.5 mm behind that guard's sheet). No further: anything behind the eye is
 *  the wrong way along the beam, and a 0.15 m back extent cuts a neighbouring conveyor's guard standing behind the
 *  sensor. */
export const BEAM_BACK_EXTENT = 0.03
/** the guard sheet's plane, measured out from the bed edge: past the frame wall, mid-sheet */
const GUARD_PLANE = FRAME_WALL_THICKNESS + GUARD_THICKNESS / 2
/** the top return is this thick; a hole stays clear of it */
const GUARD_LIP_T = 0.005
/** the band a hole centre may take, above the running surface: the disc clears the flange below and the top
 *  return above, each by 5 mm */
const HOLE_Y_MIN = GUARD_HOLE_RADIUS + 0.005
const HOLE_Y_MAX = GUARD_HEIGHT - GUARD_LIP_T - GUARD_HOLE_RADIUS - 0.005

type V3 = [number, number, number]
interface BeamSegment {
  a: V3
  b: V3
  /** where the lens sits along a→b (0..1): a crossing before it is behind the eye */
  lens: number
}

/** a crossing behind the lens is kept only on the guard the beam enters its bed through: the guard the eye stands
 *  against. Any other guard back there (a spur merging beside the eye, a bed alongside) lies against the beam's
 *  direction, and cutting it would put a hole behind the sensor. */
function behindAndLeaving(t: number, lens: number, inward: boolean): boolean {
  return t < lens && !inward
}

function numParam(params: Record<string, ParamValue>, key: string): number | null {
  const v = params[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** a rig part's sensing beams as world segments, at rest: the sim's collectBeams ray (rigWorldPoses + the part's
 *  yaw), run BEAM_BACK_EXTENT behind the emitter and out to the range the renderer draws and the sim senses
 *  (rigPose.resolvedBeamRange: the link's `rangeParam`, else its static range). */
export function beamSegments(part: PartInstance): BeamSegment[] {
  if (part.type !== 'part') return []
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return []
  const geo = pkg.geometry
  const emitters = geo.links.filter((l) => l.beam)
  if (emitters.length === 0) return []
  const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>)
  const scale = numParam(params, 'scale') ?? 1
  const rest = rigWorldPoses(geo, {}, undefined, scale, params as RigParams)
  const yaw = qFromAxisAngle([0, 1, 0], part.rotationY)
  const out: BeamSegment[] = []
  for (const link of emitters) {
    const lp = rest.get(link.name)
    if (!lp || !link.beam) continue
    const wp = qApply(yaw, lp.pos)
    const o: V3 = [part.position[0] + wp[0], part.position[1] + wp[1], part.position[2] + wp[2]]
    const wd = qApply(yaw, qApply(lp.quat, link.beam.axis ?? [0, 0, 1]))
    const len = Math.hypot(wd[0], wd[1], wd[2]) || 1
    const d: V3 = [wd[0] / len, wd[1] / len, wd[2] / len]
    const range = resolvedBeamRange(link.beam, params)
    out.push({
      a: [o[0] - d[0] * BEAM_BACK_EXTENT, o[1] - d[1] * BEAM_BACK_EXTENT, o[2] - d[2] * BEAM_BACK_EXTENT],
      b: [o[0] + d[0] * range, o[1] + d[1] * range, o[2] + d[2] * range],
      lens: BEAM_BACK_EXTENT / (BEAM_BACK_EXTENT + range),
    })
  }
  return out
}

function hasBeams(p: PartInstance): boolean {
  if (p.type !== 'part') return false
  const pkg = getPackage(p.packageId)
  return !!pkg && pkg.geometry.kind === 'rig' && pkg.geometry.links.some((l) => !!l.beam)
}

/** a guard toggle param: absent (or not a boolean) means the guard is up */
function guardUp(host: PartInstance, key: string): boolean {
  return (host.params as Record<string, unknown>)[key] !== false
}

/** the hole centre's height, pulled into the band where the disc is a hole in the sheet */
function holeY(rel: number): number {
  return Math.min(HOLE_Y_MAX, Math.max(HOLE_Y_MIN, rel))
}

/** the guard height band a crossing must fall in to be one: from the flange up to the guard top */
function crossesSheet(rel: number): boolean {
  return rel >= -0.005 && rel <= GUARD_HEIGHT
}

/** a hole may not overlap one already on that guard (two eyes a panel apart): the first one keeps it */
function pushHole(list: GuardHole[], x: number, y: number, minGap: number): void {
  for (const h of list) if (Math.abs(h[0] - x) < minGap) return
  list.push([Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])
}

/** holes in a straight bed's guards (belt-like, roller, spur): the segment against the planes z = ±(hw + plane) */
function straightHoles(host: PartInstance, beams: readonly BeamSegment[]): GuardHoles | null {
  const frame = hostGuardFrame(host)
  if (!frame) return null
  const { hw, slope, sides } = frame
  const belt = bedView(host, 'path')
  const leftUp = belt ? belt.leftGuard : guardUp(host, 'leftGuard')
  const rightUp = belt ? belt.rightGuard : guardUp(host, 'rightGuard')
  const out: GuardHoles = { left: [], right: [] }
  const zg = hw + GUARD_PLANE
  for (const { a, b, lens } of beams) {
    const la = toLocalXZ(host, a[0], a[2])
    const lb = toLocalXZ(host, b[0], b[2])
    const dz = lb.z - la.z
    if (Math.abs(dz) < 1e-9) continue // runs parallel to the guards: crosses neither
    for (const side of [-1, 1] as const) {
      if (side < 0 ? !leftUp : !rightUp) continue
      const t = (side * zg - la.z) / dz
      if (t < 0 || t > 1) continue
      if (behindAndLeaving(t, lens, side * dz < 0)) continue
      const planX = la.x + (lb.x - la.x) * t
      const x = planX / slope
      // within this side's own guard run (a spur's two guards are offset by its splay)
      const [lo, hi] = side < 0 ? sides.left : sides.right
      if (x < lo || x > hi) continue
      const rel = (a[1] + (b[1] - a[1]) * t - hostSurfaceY(host, planX)) * slope
      if (!crossesSheet(rel)) continue
      pushHole(side < 0 ? out.left : out.right, x, holeY(rel), GUARD_HOLE_PANEL)
    }
  }
  return out
}

/** holes in a curved bed's guards: the segment against the circles r = rc ± (hw + plane) about the part origin */
function curvedHoles(host: PartInstance, beams: readonly BeamSegment[]): GuardHoles | null {
  const arc = curvedGizmoOf(host)
  if (!arc) return null
  const hw = arc.width / 2
  const rc = arc.innerRadius + hw
  const sweep = (arc.sweepDeg * Math.PI) / 180
  const out: GuardHoles = { left: [], right: [] }
  const surfY = host.position[1]
  for (const { a, b, lens } of beams) {
    const la = toLocalXZ(host, a[0], a[2])
    const lb = toLocalXZ(host, b[0], b[2])
    const dx = lb.x - la.x
    const dz = lb.z - la.z
    const A = dx * dx + dz * dz
    if (A < 1e-12) continue
    for (const side of [-1, 1] as const) {
      if (!guardUp(host, side < 0 ? 'innerGuard' : 'outerGuard')) continue
      const r = rc + side * (hw + GUARD_PLANE)
      if (r <= 0) continue
      // |la + t·d| = r
      const B = 2 * (la.x * dx + la.z * dz)
      const C = la.x * la.x + la.z * la.z - r * r
      const disc = B * B - 4 * A * C
      if (disc < 0) continue
      const sq = Math.sqrt(disc)
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t < 0 || t > 1) continue
        const px = la.x + dx * t
        const pz = la.z + dz * t
        // into the bed: toward the centreline radius, i.e. shrinking past the outer guard, growing past the inner
        if (behindAndLeaving(t, lens, side * (px * dx + pz * dz) < 0)) continue
        const ang = Math.atan2(-pz, px) // the curve's arc: P(θ) = (r·cos θ, −r·sin θ)
        if (ang < 0 || ang > sweep) continue
        const rel = a[1] + (b[1] - a[1]) * t - surfY
        if (!crossesSheet(rel)) continue
        pushHole(side < 0 ? out.left : out.right, ang, holeY(rel), GUARD_HOLE_PANEL / r)
      }
    }
  }
  return out
}

/** a host's reach in plan, from its origin: whatever a beam must come within to cross one of its guards */
function hostReach(host: PartInstance): number | null {
  const frame = hostGuardFrame(host)
  if (frame) {
    // a spur's longer guard reaches past the bed's ends
    const { left, right } = frame.sides
    const x = Math.max(Math.abs(frame.bedLo), Math.abs(frame.bedHi), Math.abs(left[0]), Math.abs(left[1]), Math.abs(right[0]), Math.abs(right[1]))
    return Math.hypot(x, frame.hw + 0.1)
  }
  const arc = curvedGizmoOf(host)
  if (arc) return arc.innerRadius + arc.width + 0.1
  return null
}

/** plan distance from a point to a segment */
function planDistance(px: number, pz: number, s: BeamSegment): number {
  const dx = s.b[0] - s.a[0]
  const dz = s.b[2] - s.a[2]
  const len2 = dx * dx + dz * dz
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - s.a[0]) * dx + (pz - s.a[2]) * dz) / len2))
  return Math.hypot(px - (s.a[0] + dx * t), pz - (s.a[2] + dz * t))
}

/** the holes every beam in `beams` cuts in `host`'s guards; null when it isn't a guarded bed or nothing crosses */
export function deriveGuardHoles(host: PartInstance, beams: readonly BeamSegment[]): GuardHoles | null {
  const reach = hostReach(host)
  if (reach === null) return null
  const near = beams.filter((s) => planDistance(host.position[0], host.position[2], s) <= reach)
  if (near.length === 0) return null
  const holes = hostGuardFrame(host) ? straightHoles(host, near) : curvedHoles(host, near)
  if (!holes || (holes.left.length === 0 && holes.right.length === 0)) return null
  holes.left.sort((p, q) => p[0] - q[0])
  holes.right.sort((p, q) => p[0] - q[0])
  return holes
}

const isGuardHost = (p: PartInstance): boolean => p.type === 'part' && (hostGuardFrame(p) !== null || curvedGizmoOf(p) !== null)

/** broad-phase grid cell (m): about a conveyor's length, and a few cells for a sensor's longest beam */
const CELL = 4
const cellOf = (v: number): number => Math.floor(v / CELL)

/**
 * Per-host hole map for a whole scene, keyed by part id; only hosts a beam actually crosses appear.
 *
 * Localized, like guard openings (memoParts.ts memoizeLocalized), because it runs every frame of a drag: a
 * whole-scene rerun measured 25.6 ms per frame at 500 beds / 1000 eyes. A beam can reach further than a footprint
 * broad phase looks, so the broad phase is over the segments:
 *   - each beam part's segments are cached on its object identity, so an unchanged sensor never re-poses its rig.
 *   - segments are bucketed in a CELL grid by plan bounding box, and a host gathers only the cells it reaches.
 *   - each host's result is cached on its own ref plus its gathered segments' refs.
 * Both caches drop wholesale when the package registry moves (a package edit can change a beam or a guard under
 * identical part refs).
 */
export const computeSceneGuardHoles = (() => {
  let rev = -1
  let segCache = new WeakMap<object, BeamSegment[]>()
  let hostMemo = new WeakMap<object, boolean>()
  let beamMemo = new WeakMap<object, boolean>()
  let hostCache = new Map<string, { host: PartInstance; near: BeamSegment[]; result: GuardHoles | null }>()
  let lastOut = new Map<string, GuardHoles>()
  let lastParticipants: PartInstance[] = []
  const flag = (memo: WeakMap<object, boolean>, p: PartInstance, fn: (p: PartInstance) => boolean): boolean => {
    let v = memo.get(p as unknown as object)
    if (v === undefined) { v = fn(p); memo.set(p as unknown as object, v) }
    return v
  }
  return (parts: readonly PartInstance[]): Map<string, GuardHoles> => {
    const r = registryRevision()
    if (r !== rev) {
      rev = r
      segCache = new WeakMap()
      hostMemo = new WeakMap()
      beamMemo = new WeakMap()
      hostCache = new Map()
      lastParticipants = []
    }
    // nothing that hosts a guard or carries a beam changed (same objects, same order), so the last map is returned.
    // This is by far the common case: a frame with no edit, or a drag of a part that is neither (cargo, a fence, a light).
    const participants: PartInstance[] = []
    for (const p of parts) if (flag(beamMemo, p, hasBeams) || flag(hostMemo, p, isGuardHost)) participants.push(p)
    if (participants.length === lastParticipants.length && participants.every((p, i) => p === lastParticipants[i])) return lastOut
    lastParticipants = participants
    const grid = new Map<string, BeamSegment[]>()
    let anyBeam = false
    for (const p of participants) {
      if (!flag(beamMemo, p, hasBeams)) continue
      let segs = segCache.get(p as unknown as object)
      if (!segs) { segs = beamSegments(p); segCache.set(p as unknown as object, segs) }
      for (const s of segs) {
        anyBeam = true
        const x0 = cellOf(Math.min(s.a[0], s.b[0])), x1 = cellOf(Math.max(s.a[0], s.b[0]))
        const z0 = cellOf(Math.min(s.a[2], s.b[2])), z1 = cellOf(Math.max(s.a[2], s.b[2]))
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
          const k = `${cx},${cz}`
          const list = grid.get(k)
          if (list) list.push(s)
          else grid.set(k, [s])
        }
      }
    }
    const nextCache = new Map<string, { host: PartInstance; near: BeamSegment[]; result: GuardHoles | null }>()
    const out = new Map<string, GuardHoles>()
    let changed = !anyBeam && lastOut.size > 0
    if (anyBeam) {
      for (const host of participants) {
        if (!flag(hostMemo, host, isGuardHost)) continue
        const reach = hostReach(host)
        if (reach === null) continue
        const [hx, , hz] = host.position
        // the segments in the cells this host's reach covers, deduped, in grid order (stable while nothing moves)
        const seen = new Set<BeamSegment>()
        const near: BeamSegment[] = []
        for (let cx = cellOf(hx - reach); cx <= cellOf(hx + reach); cx++) for (let cz = cellOf(hz - reach); cz <= cellOf(hz + reach); cz++) {
          for (const s of grid.get(`${cx},${cz}`) ?? []) {
            if (seen.has(s)) continue
            seen.add(s)
            if (planDistance(hx, hz, s) <= reach) near.push(s)
          }
        }
        const prev = hostCache.get(host.id)
        let result: GuardHoles | null
        if (prev && prev.host === host && prev.near.length === near.length && prev.near.every((s, i) => s === near[i])) result = prev.result
        else { result = near.length ? deriveGuardHoles(host, near) : null; changed = true }
        nextCache.set(host.id, { host, near, result })
        if (result) out.set(host.id, result)
      }
    }
    if (nextCache.size !== hostCache.size) changed = true
    hostCache = nextCache
    // an unchanged scene hands back the same map, so its consumers' identity checks hold
    if (!changed && out.size === lastOut.size) return lastOut
    lastOut = out
    return out
  }
})()

/** stable key for change detection between renders */
export function guardHolesKey(h: GuardHoles | undefined): string {
  return h ? JSON.stringify([h.left, h.right]) : ''
}

/** as numberList rows [x, y, side ±1] - the form a function conveyor's `guardHoles` param takes */
export function guardHoleRows(h: GuardHoles | undefined): number[][] {
  if (!h) return []
  return [...h.left.map(([x, y]) => [x, y, -1]), ...h.right.map(([x, y]) => [x, y, 1])]
}

/**
 * The guard panel a hole sits in, drawn once for every family that draws its guard as a sheet: a GUARD_HOLE_PANEL
 * long plate, x centred on the hole, from `y0` up to `y1`, `thickness` along +z from z 0, with a round hole of
 * GUARD_HOLE_RADIUS through it at height `holeY`. The rig roller's guard splitter draws this directly; a function
 * conveyor draws the same outline through `g.extrude` in its own geometry().
 */
export function guardHolePanelDescription(y0: number, y1: number, holeY: number, thickness: number): MeshDescription {
  const h = GUARD_HOLE_PANEL / 2
  return extrudeDescription([[-h, y0], [h, y0], [h, y1], [-h, y1]], 0, thickness, { axis: 'z', holes: [holeOutline(0, holeY)] })
}

/** the hole's outline in (x, y): 16 facets, the same count a function conveyor's panel uses */
export function holeOutline(cx: number, cy: number): [number, number][] {
  const pts: [number, number][] = []
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8
    pts.push([cx + GUARD_HOLE_RADIUS * Math.cos(a), cy + GUARD_HOLE_RADIUS * Math.sin(a)])
  }
  return pts
}
