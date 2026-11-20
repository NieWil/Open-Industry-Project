import { FRAME_WALL_THICKNESS, GUARD_CONTACT_TOLERANCE } from '../types'
import type { PartInstance } from '../types'
import type { PartEnd } from '../parts/partGeometry'
import type { BedGuardHost } from '../conveyor/conveyorBeds'
import type { ParamValue } from '../parts/partApi'
import { bedOf, bedView, conveyorEndsOf, guardPusherContacts, isConveyorLike, isGuardPusher, toLocalXZ } from '../parts/partGeometry'
import { endAtHostHeight, junctionMouths, mitresKey, sortCuts } from './guardExtents'
import type { GuardMitres } from './guardExtents'
import { rowsToOpeningSpecs, straightGuardOpenings } from './guardOpeningEdit'
import { getPackage } from '../parts/partRegistry'
import { memoizeLocalized } from '../memoParts'

/** a part whose end/contact can open another's side guard: any custom/SDK conveyor (belt-like, straight, spur,
 *  rotating-deck, curved), or a pusher that mounts against the guard (the pop-up diverter, whose arms cross the
 *  guard). The spur matters most among conveyors: it exists to merge onto a line, and without the opening the
 *  host's guard stays a solid wall across the junction. */
export function isOpener(p: PartInstance): boolean {
  return p.type === 'part' && (isConveyorLike(p) || isGuardPusher(p))
}

/** the ends/contacts of an opener that can meet a host's side guard: a conveyor's conveying ends, else a
 *  mounted pusher's (diverter's) push-side contacts. */
function openerEnds(p: PartInstance): PartEnd[] {
  return isConveyorLike(p) ? conveyorEndsOf(p) : guardPusherContacts(p)
}

/**
 * Geometry-derived side-guard openings.
 *
 * A straight conveyor's side guard opens wherever a neighbour's conveying end physically meets that side (the
 * T / spur merge snapFeatures.alignToStraightTarget produces). The geometry opens it, not the snap action: any
 * end touching a side gets the gap. The renderer splits the guard mesh and the sim the guard collider so cargo
 * can transfer.
 *
 * Ranges are in the host's local centreline X (tail-origin: 0 at the tail, +X
 * along length), matching the guard layout in conveyor.ts / belt.ts / world.ts.
 *
 * A straight host's authored openings (`params.guardOpenings`, cut by hand with the Side-Guards gizmo) are folded
 * into the same result, converted from tail-relative rows (see {@link addAuthoredOpenings} for why belt-like
 * hosts consume theirs on the param instead). Neighbour openings are transient, authored ones an ordinary param,
 * but downstream there is one set per guard and the renderer and sim cut identically.
 *
 * Guards only: the host's frame (below-deck wall + flange) never opens, as a real line's side channel runs
 * unbroken through a merge. The mover fits its own frame (guardExtents.ts retracts/extends its rails to the
 * host's outer wall plane).
 */

export type Range = [number, number]

export interface GuardOpenings {
  /** -Z side (leftGuard) */
  left: Range[]
  /** +Z side (rightGuard) */
  right: Range[]
  /** how the opening's ends are cut where a neighbour's guard meets them (guardExtents.ts GuardMitre); absent when
   *  none is. An end a later merge swallowed matches no piece end any more. */
  mitres?: GuardMitres
}

/** widen the opening past the incoming mouth so the guard rails clear a transferring box */
const OPENING_MARGIN = FRAME_WALL_THICKNESS
/** ignore slivers that would only nick the guard */
const MIN_OPENING = 0.05

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4
}

/** union overlapping/touching ranges, ascending */
function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length < 2) return ranges
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Range[] = [sorted[0]!]
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!
    const last = out[out.length - 1]!
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/**
 * Solid guard spans of [x0, x1] with `openings` removed. Returns the whole span
 * when there are no openings; the inverse of the merged openings otherwise.
 */
export function keptSegments(x0: number, x1: number, openings: readonly Range[]): Range[] {
  if (x1 - x0 <= 1e-4) return []
  const clamped: Range[] = []
  for (const [a, b] of openings) {
    const lo = Math.max(a, x0)
    const hi = Math.min(b, x1)
    if (hi - lo > 1e-4) clamped.push([lo, hi])
  }
  if (clamped.length === 0) return [[x0, x1]]
  const merged = mergeRanges(clamped)
  const out: Range[] = []
  let cursor = x0
  for (const [lo, hi] of merged) {
    if (lo - cursor > 1e-4) out.push([cursor, lo])
    cursor = hi
  }
  if (x1 - cursor > 1e-4) out.push([cursor, x1])
  return out
}

/**
 * The local-X guard span + half-width of a part that can host side-guard openings (its bed's guardHost): a belt
 * (tail-origin, bed 0..horizontal-extent) or a straight or spur bed (centre-origin, bed ±length/2). The two
 * conventions differ only in where the origin sits along the length. The consumer
 * (belt geometry() vs the rig guard-splitter) reads the openings in the same local frame it built the
 * guard in, so each stays self-consistent. null for any other part (curved/turntable/non-conveyor).
 * `slope` turns a plan local X into that frame's X (an inclined bed's guards run along its slope; 1 for a
 * belt, whose openings are plan X until its geometry maps them onto the path).
 */
export function hostGuardFrame(host: PartInstance): BedGuardHost | null {
  return bedOf(host)?.guardHost(host) ?? null
}

/**
 * Openings on `host`'s left/right guards from every other conveyor's end that
 * butts against it, and from every guard pusher mounted on it. `host` must be a bed whose guards open (a belt, a
 * straight or a spur); other types return empty. A bed that takes end joins only (a spur: it is itself a merge)
 * opens for pushers only, so a conveyor end placed against its side leaves the guard closed (checkLayout.ts warns).
 */
export function deriveGuardOpenings(host: PartInstance, others: readonly PartInstance[]): GuardOpenings {
  const result: GuardOpenings = { left: [], right: [] }
  const frame = hostGuardFrame(host)
  if (!frame) return result
  // openings live in the host's local centreline X; the guard builders (belt geometry / rig guard-splitter)
  // read them in that same frame. bedLo..bedHi is the length span, hw the half-width at which the guards sit.
  const { bedLo, bedHi, hw, slope } = frame
  // a bed that takes end joins only (a spur) opens for a device mounted on its guard, never for a conveyor end
  const takesMerges = !(bedOf(host)?.endJoinsOnly ?? false)
  let mitres: GuardMitres | undefined

  for (const other of others) {
    if (other.id === host.id) continue
    if (!isOpener(other)) continue
    if (!takesMerges && isConveyorLike(other)) continue

    // Preferred: an extent-capable mover (spur / straight / belt) states exactly where its own guards
    // end on this host's wall plane. The opening spans those two corners, so the host's guard ends
    // precisely where the mover's begins. The mouth projection below cannot do this on a splayed face:
    // its symmetric margin equals the guard offset only when the faces are parallel, so a spur would get a
    // hole at one corner and an overlap at the other. Curved conveyors and guard-mounted pushers have no
    // junction mouth and fall through to the projection.
    let cornered = false
    const mouths = junctionMouths(other, host)
    for (const [mouth, sideName] of [[mouths.hostLeft, 'left'], [mouths.hostRight, 'right']] as const) {
      if (!mouth || !mouth.left || !mouth.right) continue
      const side = result[sideName]
      const a = toLocalXZ(host, mouth.left.x, mouth.left.z).x / slope
      const b = toLocalXZ(host, mouth.right.x, mouth.right.z).x / slope
      const lo = Math.max(Math.min(a, b), bedLo)
      const hi = Math.min(Math.max(a, b), bedHi)
      if (hi - lo < MIN_OPENING) continue
      side.push([round(lo), round(hi)])
      cornered = true
      // the host's half of each corner's mitre (guardExtents.ts GuardMitre): only where the mover's guard really ends
      // on the corner (a gapped straight's doesn't, so there is nothing to meet), and only where the opening's end is
      // the corner rather than the bed's end
      for (const [corner, x] of [[mouth.left, a], [mouth.right, b]] as const) {
        if (!corner.reaches || corner.mitre <= 0 || x < bedLo || x > bedHi) continue
        mitres ??= { left: [], right: [], inner: hw + FRAME_WALL_THICKNESS }
        mitres[sideName].push({ x: round(x), c: corner.mitre / slope })
      }
    }
    if (cornered) continue

    for (const end of openerEnds(other)) {
      const center = toLocalXZ(host, end.x, end.z)
      // the end centre must sit on a side edge, within the host's length, and at the host's surface height
      if (Math.abs(Math.abs(center.z) - hw) > GUARD_CONTACT_TOLERANCE) continue
      if (center.x / slope < bedLo - GUARD_CONTACT_TOLERANCE || center.x / slope > bedHi + GUARD_CONTACT_TOLERANCE) continue
      if (!endAtHostHeight(end, host, center.x)) continue

      // project the incoming mouth (faceWidth across, perpendicular to outward)
      // onto the host's length axis to size the gap
      const half = end.faceWidth / 2
      const perpX = -end.outZ
      const perpZ = end.outX
      const c1 = toLocalXZ(host, end.x + perpX * half, end.z + perpZ * half)
      const c2 = toLocalXZ(host, end.x - perpX * half, end.z - perpZ * half)
      let lo = Math.min(c1.x, c2.x) / slope - OPENING_MARGIN
      let hi = Math.max(c1.x, c2.x) / slope + OPENING_MARGIN
      lo = Math.max(lo, bedLo)
      hi = Math.min(hi, bedHi)
      if (hi - lo < MIN_OPENING) continue

      const side = center.z < 0 ? result.left : result.right
      side.push([round(lo), round(hi)])
    }
  }
  addAuthoredOpenings(host, result, bedLo, bedHi)
  result.left = mergeRanges(result.left)
  result.right = mergeRanges(result.right)
  if (mitres) result.mitres = sortCuts(mitres)
  return result
}

/**
 * Fold the host's own authored openings (`params.guardOpenings`, the hole an author cuts for a sensor or a
 * hand transfer) into the same map as the neighbour-derived ones, so the render splitter, the sim collider and
 * the merge resolver all read one set of openings per guard. The rig-tier counterpart of the belt's
 * `manualGuardOpenings` fold in beltGuards.ts.
 *
 * Rows are tail-relative (0 = the upstream end) on both families; a centre-origin bed shifts them into its
 * own local X by `bedLo` (= −length/2), the frame every consumer of {@link GuardOpenings} already reads.
 *
 * Belt-like hosts are excluded. A belt's geometry() takes the authored rows straight off the
 * param in arc space, and the renderer appends the neighbour-derived rows to that same param
 * (render/parts/sdk/functionMesh.ts `withNeighborOpenings`). Folding here as well would apply an authored
 * opening twice and in the wrong space, since arc-length ≠ centreline X once the path bends.
 */
function addAuthoredOpenings(host: PartInstance, result: GuardOpenings, bedLo: number, bedHi: number): void {
  if (host.type !== 'part' || bedView(host, 'path') !== null) return
  const pkg = getPackage(host.packageId)
  if (!pkg || pkg.params.guardOpenings == null) return // authoring openings is opt-in, per package
  const own = (host.params as Record<string, unknown>).guardOpenings
  const rows = own !== undefined ? own : pkg.params.guardOpenings.default
  if (!Array.isArray(rows) || rows.length === 0) return
  const authored = straightGuardOpenings(rowsToOpeningSpecs(rows as number[][]), bedHi - bedLo)
  for (const [a, b] of authored.left) result.left.push([round(a + bedLo), round(b + bedLo)])
  for (const [a, b] of authored.right) result.right.push([round(a + bedLo), round(b + bedLo)])
}

/**
 * Fold a host's openings into a drawn straight or spur bed's `guardGaps` param as rows [x0, x1, side ±1] in its own
 * local X (the frame deriveGuardOpenings measures in), so its geometry() leaves those gaps in its guards and the sim,
 * reading the same params, leaves them in its colliders. A no-op unless the part declares the param. A belt takes its
 * openings in `guardOpenings` instead, in arc length (render/parts/sdk/functionMesh.ts withNeighborOpenings), and a
 * rig's guard links are split by the host, so neither takes gaps.
 */
export function withGuardGaps(
  part: PartInstance,
  params: Record<string, ParamValue>,
  openings: GuardOpenings | undefined,
): Record<string, ParamValue> {
  if (!openings || (openings.left.length === 0 && openings.right.length === 0) || part.type !== 'part') return params
  if (!getPackage(part.packageId)?.params.guardGaps || bedView(part, 'path') !== null) return params
  const rows: number[][] = []
  for (const [a, b] of openings.left) rows.push([a, b, -1])
  for (const [a, b] of openings.right) rows.push([a, b, 1])
  return { ...params, guardGaps: rows as unknown as ParamValue }
}

function hasOpenings(op: GuardOpenings): boolean {
  return op.left.length > 0 || op.right.length > 0
}

/**
 * Per-conveyor opening map for a whole scene, keyed by part id. Only straight
 * roller/belt conveyors with at least one opening appear.
 *
 * A naive host×opener scan is O(n^2) (every conveyor is both) and dominates drag cost in large scenes (~64 ms
 * per frame at 480 conveyors, a one-off measurement). A contact needs an opener's end within
 * GUARD_CONTACT_TOLERANCE of the host's guard edge, so openers are broad-phased through a footprint grid
 * (footprintGrid.ts, shared with the extents resolver) by disc distance (rHost + rOpener + tol). The result is
 * unchanged: deriveGuardOpenings is order-independent over the set of contacting openers, and the bound is
 * conservative.
 *
 * Memoized per host on the identity of that host and its openers (memoParts.ts `memoizeLocalized`), so a drag
 * re-derives only the hosts whose opener set moved.
 */
export const computeSceneOpenings = memoizeLocalized<GuardOpenings>({
  isTarget: (p) => hostGuardFrame(p) !== null, // any side-guard host (belt-like or straight roller bed)
  isInfluencer: isOpener,
  tolerance: GUARD_CONTACT_TOLERANCE,
  derive: (part, near) => {
    const op = deriveGuardOpenings(part, near)
    return hasOpenings(op) ? op : undefined
  },
})

/**
 * The side (left = −Z, right = +Z) of a rig link declared a side guard (RigLink.sideGuard), else null. Shared by
 * render (mesh split) + sim (collider split) so a guard's cut side is classified identically in both, and by the
 * same tail/centre-origin convention {@link deriveGuardOpenings} uses (side = sign of the contact's local Z).
 */
export function rigGuardSide(link: { sideGuard?: 'left' | 'right' }): 'left' | 'right' | null {
  return link.sideGuard ?? null
}

/** The rail counterpart of {@link rigGuardSide}: a declared side rail (RigLink.sideRail, a below-deck wall or
 *  flange). The rig consumers use it to apply the part's own snap extents (a guardExtents.ts retraction at a flush
 *  side-merge) to its rail boxes. Not used for host openings: the host frame never opens. */
export function rigFrameSide(link: { sideRail?: 'left' | 'right' }): 'left' | 'right' | null {
  return link.sideRail ?? null
}

/** stable key for change detection between renders (positions drift continuously during a drag) */
export function openingsKey(op: GuardOpenings | undefined): string {
  if (!op) return ''
  return JSON.stringify([op.left, op.right]) + mitresKey(op.mitres)
}
