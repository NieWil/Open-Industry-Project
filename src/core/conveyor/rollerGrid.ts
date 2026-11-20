import type { PartInstance } from '../types'
import { ARC_END_EXT, ROLLER_PITCH, ROLLER_RADIUS } from '../types'
import { forwardXZ } from '../math'
import { bedView, conveyorEndsOf, isWorldPhaseRollerBed, rectangleBedOf, resolveInclineRad } from '../parts/partGeometry'
import { getPackage } from '../parts/partRegistry'
import { memoizeByParticipants } from '../memoParts'

/**
 * World-space roller pitch grid (instanced-mesh rollers + conveyor snapping).
 *
 * Rollers sit at world points whose projection onto the conveyor axis is a multiple of the
 * roller pitch, so two collinear conveyors drop rollers on the same grid lines
 * automatically - a butt join always reads as one continuous bed, with no
 * snap-time communication. The grid passes through `anchor` (a curved
 * conveyor's end roller, or an anchor inherited down a chain of collinear
 * straights) when one exists, else through the world origin.
 */

/** Resolved grid inputs for one straight roller bed (the instanced-roller grid arguments). */
export interface RollerGrid {
  /** world point the grid line passes through; null = world origin */
  anchor: readonly [number, number, number] | null
  /** nudge the low (back / -X) edge roller inward by the roller radius; suppressed at a collinear butt */
  nudgeLo: boolean
  /** nudge the high (front / +X) edge roller inward; suppressed at a collinear butt */
  nudgeHi: boolean
}

const DEFAULT_GRID: RollerGrid = { anchor: null, nudgeLo: true, nudgeHi: true }

/** Stable string for a resolved roller grid, to detect neighbour-driven changes (positions drift
 *  continuously during a drag). The render-side twin of openingsKey/extentsKey/deckClusterKey. */
export function gridSignature(grid: RollerGrid | undefined): string {
  if (!grid) return ''
  const a = grid.anchor
  return `${a ? `${a[0].toFixed(4)},${a[2].toFixed(4)}` : '-'}|${grid.nudgeLo ? 1 : 0}${grid.nudgeHi ? 1 : 0}`
}

/** fposmod (floored modulo): positive remainder. */
function fposmod(a: number, b: number): number {
  const r = a % b
  return r < 0 ? r + b : r
}

interface RollerBed {
  lo: number
  hi: number
  radius: number
  pitch: number
}

/** pitch + tube radius of an SDK roller bed: the pitch is the maxSpacing of its worldPhase distribute link (the
 *  roller spacing), falling back to the v1 light-class pitch; the radius is the shared duty-class tube (only the
 *  retired `kind:'roller'` link could declare its own). */
function sdkRollerSpec(part: PartInstance): { pitch: number; radius: number } {
  const pkg = part.type === 'part' ? getPackage(part.packageId) : undefined
  if (pkg && pkg.geometry.kind === 'rig') {
    for (const l of pkg.geometry.links) {
      const s = l.array?.distribute
      if (s?.worldPhase && typeof s.maxSpacing === 'number' && s.maxSpacing > 0) {
        return { pitch: s.maxSpacing, radius: ROLLER_RADIUS }
      }
    }
  }
  return { pitch: ROLLER_PITCH, radius: ROLLER_RADIUS }
}

/** the roller pitch of a straight SDK roller bed (for the track-snap engine), or null when the part isn't one */
export function rollerBedPitch(part: PartInstance): number | null {
  return isWorldPhaseRollerBed(part) && rectangleBedOf(part) ? sdkRollerSpec(part).pitch : null
}

/** local +X span + roller radius/pitch of a straight SDK roller bed (centre-origin), or null otherwise. An
 *  SDK roller conveyor is a custom rig whose rollers sit on the shared world pitch grid (isWorldPhaseRollerBed),
 *  so it anchors + continues across snapped beds. */
function rollerBed(part: PartInstance): RollerBed | null {
  if (!isWorldPhaseRollerBed(part)) return null
  const view = rectangleBedOf(part)
  if (!view) return null
  // centre-origin: bed spans local x ±length/2
  const spec = sdkRollerSpec(part)
  return { lo: -view.length / 2, hi: view.length / 2, radius: spec.radius, pitch: spec.pitch }
}

/**
 * Local +X offsets (from the part origin) of each roller - the
 * instanced-roller local-X layout.
 *
 * Rollers fall on the world pitch grid through `grid.anchor` (else world
 * origin). Edge rollers are pulled inward by the roller radius so the tube
 * doesn't poke past the footprint, unless that end abuts a collinear neighbour
 * (`grid.nudgeLo/Hi` false), where the seam roller must stay on the shared grid.
 * When anchored, rollers within half a pitch of the anchor are dropped (the
 * anchoring curve owns that seam roller). Returns [] for non-roller parts.
 */
export function rollerStations(part: PartInstance, grid: RollerGrid = DEFAULT_GRID): number[] {
  const bed = rollerBed(part)
  if (!bed) return []
  const { lo, hi, radius, pitch } = bed
  if (pitch <= 0 || hi <= lo) return []

  const f = forwardXZ(part.rotationY)
  const sOrigin = part.position[0] * f.x + part.position[2] * f.z
  const hasAnchor = grid.anchor !== null
  const anchorS = hasAnchor ? grid.anchor![0] * f.x + grid.anchor![2] * f.z : 0
  const toAnchor = anchorS - sOrigin
  let phase = fposmod(toAnchor, pitch)
  // snap a phase within FP-epsilon of a full pitch back to 0, so a grid-aligned seam
  // (toAnchor an exact multiple of pitch - e.g. two collinear beds butting on a grid
  // line) keeps its edge roller instead of dropping it to fposmod rounding
  if (pitch - phase < 1e-6) phase = 0

  const out: number[] = []
  let x = phase + Math.ceil((lo - phase) / pitch) * pitch
  while (x < hi) {
    if (x >= lo && !(hasAnchor && Math.abs(x - toAnchor) < pitch * 0.5)) out.push(x)
    x += pitch
  }
  if (out.length > 0 && radius > 0) {
    if (grid.nudgeLo) out[0] = Math.max(out[0]!, lo + radius)
    if (grid.nudgeHi) out[out.length - 1] = Math.min(out[out.length - 1]!, hi - radius)
  }
  return out
}

// --- neighbour-aware grid resolution -----------------------------------------

const NEIGHBOUR_CENTER_RADIUS = 8 // cheap O(m^2) prefilter; beds this far apart can't butt
const END_CONTACT_DISTANCE = 0.15 // the roller-grid resolver's end-match threshold
const COLLINEAR_DOT = 0.99 // |axisA · axisB| above this == collinear

interface GridNode {
  id: string
  isStraight: boolean // roller_conveyor: resolved (anchor + butt flags)
  isCurve: boolean // curved roller bed: anchor source only, never resolved
  axis: { x: number; z: number }
  /** sin of the bed's incline along +axis (0 flat): two beds only continue one grid when their slopes match too */
  rise: number
  center: { x: number; z: number }
  ends: { end: 'front' | 'back'; x: number; y: number; z: number }[]
}

/**
 * A curved roller bed a butted straight anchors its grid to: the built-in `curved_roller_conveyor`, or an SDK
 * curved bed that butts flush (its snap `endExt` is below the belt half-pulley). Its end roller seeds the shared
 * pitch. A curved belt (endExt == ARC_END_EXT) has no rollers to continue, so it is excluded, like the built-in
 * `curved_belt_conveyor` (not a grid node). So is any curve that declares a belt surface, whatever its gap: a
 * shallow curved belt's drum-radius endExt (height / 2) is below ARC_END_EXT too.
 */
function isCurveAnchor(part: PartInstance): boolean {
  const v = bedView(part, 'arc')
  if (v === null || v.endExt >= ARC_END_EXT - 1e-6) return false
  return !(part.type === 'part' && getPackage(part.packageId)?.conveyor?.surface === 'belt')
}

function gridNode(part: PartInstance): GridNode | null {
  // a built-in straight roller bed or an SDK custom straight roller bed (world-phase array grid). Both place
  // rollers on the shared world pitch grid, so both take part in anchor propagation (docs/seam-resolvers.md).
  const isStraight = isWorldPhaseRollerBed(part)
  const isCurve = isCurveAnchor(part)
  if (!isStraight && !isCurve) return null
  const f = forwardXZ(part.rotationY)
  return {
    id: part.id,
    isStraight,
    isCurve,
    axis: f,
    rise: Math.sin(resolveInclineRad(part)),
    center: { x: part.position[0], z: part.position[2] },
    ends: conveyorEndsOf(part).map((e) => ({ end: e.end, x: e.x, y: e.y, z: e.z })),
  }
}

/**
 * Resolve the world-pitch grid of every straight roller conveyor from its
 * butted neighbours - the roller-grid resolver plus the
 * roller-refresh anchor-propagation cascade.
 *
 * A straight that butts a curved roller conveyor anchors its grid to that
 * curve's contacting end; the anchor then propagates down chains of collinear
 * straights so the whole run shares one phase. Each end abutting a collinear
 * roller neighbour suppresses that end's edge nudge so the seam roller stays on
 * the grid. Only straight `roller_conveyor` parts get an entry (curves render
 * angularly; spurs always use the default grid); callers fall back to the
 * default grid for ids absent from the map.
 *
 * Memoized on grid-node part identity (memoParts.ts): the per-frame transient sync of
 * dragging a non-participant part reuses the cached map instead of re-resolving.
 */
export const resolveRollerGrids = memoizeByParticipants(
  (p) => isWorldPhaseRollerBed(p) || isCurveAnchor(p),
  resolveRollerGridsUncached,
)

function resolveRollerGridsUncached(parts: readonly PartInstance[]): Map<string, RollerGrid> {
  const nodes: GridNode[] = []
  for (const part of parts) {
    const n = gridNode(part)
    if (n) nodes.push(n)
  }

  const anchors = new Map<string, [number, number, number] | null>()
  const butt = new Map<string, { front: boolean; back: boolean }>()
  const collinearStraightNeighbours = new Map<string, string[]>()
  const nodeById = new Map<string, GridNode>()
  for (const n of nodes) {
    nodeById.set(n.id, n)
    if (n.isStraight) {
      anchors.set(n.id, null)
      butt.set(n.id, { front: false, back: false })
      collinearStraightNeighbours.set(n.id, [])
    }
  }

  // Spatial hash so each straight tests only nearby beds, not every node. Candidates
  // are the nodes an `o` loop wouldn't skip (straight or curve), bucketed into
  // NEIGHBOUR_CENTER_RADIUS-sized cells. With cell == radius, any two centres within
  // NEIGHBOUR_CENTER_RADIUS fall in the same or an adjacent cell, so scanning the 3x3
  // block around a straight can't miss a neighbour an all-pairs scan would find. The
  // exact hypot gate below still decides, and candidates are re-sorted into original
  // `nodes` order before the accumulation runs. The output is identical to an all-pairs
  // scan (last-write-wins anchors, same neighbour-list order) at O(n) instead of O(n^2)
  // on a spread-out field.
  const CELL = NEIGHBOUR_CENTER_RADIUS
  const orderOf = new Map<string, number>()
  const buckets = new Map<string, GridNode[]>()
  nodes.forEach((n, i) => {
    orderOf.set(n.id, i)
    if (!n.isStraight && !n.isCurve) return
    const key = `${Math.floor(n.center.x / CELL)}:${Math.floor(n.center.z / CELL)}`
    const list = buckets.get(key)
    if (list) list.push(n)
    else buckets.set(key, [n])
  })

  for (const s of nodes) {
    if (!s.isStraight) continue
    const flags = butt.get(s.id)!
    const cx = Math.floor(s.center.x / CELL)
    const cz = Math.floor(s.center.z / CELL)
    const candidates: GridNode[] = []
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const list = buckets.get(`${gx}:${gz}`)
        if (list) candidates.push(...list)
      }
    }
    candidates.sort((a, b) => orderOf.get(a.id)! - orderOf.get(b.id)!)
    for (const o of candidates) {
      if (o.id === s.id) continue
      if (Math.hypot(s.center.x - o.center.x, s.center.z - o.center.z) > NEIGHBOUR_CENTER_RADIUS) continue
      // collinear in plan and on the same slope. Across a change of grade (a flat run onto an incline, the joint an
      // incline end-mate makes) the two beds cannot share one pitch line, and suppressing the seam's edge nudge
      // there would put both end rollers on the same spot at the bend. An opposed pair (dot < 0) climbs
      // the same slope when its rises are opposite.
      const planDot = s.axis.x * o.axis.x + s.axis.z * o.axis.z
      const collinear = Math.abs(planDot) > COLLINEAR_DOT && Math.abs(s.rise - Math.sign(planDot) * o.rise) < 1e-6
      for (const oe of o.ends) {
        for (const se of s.ends) {
          const d = Math.hypot(se.x - oe.x, se.y - oe.y, se.z - oe.z)
          if (d >= END_CONTACT_DISTANCE) continue
          if (collinear) {
            if (se.end === 'front') flags.front = true
            else flags.back = true
            if (o.isStraight) collinearStraightNeighbours.get(s.id)!.push(o.id)
          }
          // a curve is flat, so it seeds only a flat bed's pitch (an inclined bed's rollers can't continue it)
          if (o.isCurve && s.rise === 0) anchors.set(s.id, [oe.x, oe.y, oe.z])
        }
      }
    }
  }

  // Propagate curve anchors down collinear straight chains to a fixed point
  // (not a one-hop anchor read + re-ping cascade).
  for (let iter = 0; iter <= nodes.length; iter++) {
    let changed = false
    for (const [id, neighbours] of collinearStraightNeighbours) {
      if (anchors.get(id) != null) continue
      for (const nId of neighbours) {
        const a = anchors.get(nId)
        if (a != null) {
          anchors.set(id, a)
          changed = true
          break
        }
      }
    }
    if (!changed) break
  }

  const grids = new Map<string, RollerGrid>()
  for (const n of nodes) {
    if (!n.isStraight) continue
    const flags = butt.get(n.id)!
    grids.set(n.id, {
      anchor: anchors.get(n.id) ?? null,
      nudgeLo: !flags.back,
      nudgeHi: !flags.front,
    })
  }
  return grids
}
