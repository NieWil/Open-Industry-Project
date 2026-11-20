import type { RigLink } from './parts/partPackage'
import type { PartPackage } from './parts/partPackage'
import { keptSegments } from './guards/guardOpenings'
import { arrayInstanceDeltas, resolvedBoxSize } from './rig/rigPose'
import type { PlatformOpenings, DeckNotch, Range, StructureConnections } from './structureConnections'
import { platformConnectionKey } from './structureConnections'

/**
 * Pure geometry transform: rewrite a rig's link list so a snapped staircase's structure-connection edits show up
 * (docs/part-snap-stairs.md). Both the renderer (rebuild the visual from the cut links) and the sim (build
 * colliders from the cut links) use it, so render and collision can never drift. The transient connection data is
 * computed once in structureConnections.ts; this applies it, opt-in per part:
 *
 *  - Platform: split each opened edge's railing rails/toe/wall boxes into the solid segments left by the gap
 *    (keptSegments), and drop the perimeter posts standing in the gap; carve the deck into the complement
 *    rectangles around each notch. Uncut edges + all other links pass through untouched (so they keep tracking
 *    their size/offset params on the normal refresh path).
 *  - Staircase: lift the whole flight so its top plane sits flush on the deck and the handrail runs on into the
 *    platform railing (applyStairLift). The floor-anchored (`anchor: 'floor'`) links stretch back down to stay on the
 *    floor, and the `dropWhenMounted` ones (its own top landing, which the deck replaces) are left out.
 *
 * Both transforms are keyed on declarative link markers, never link names: a deck part tags each perimeter
 * railing link with `onEdge: 'posX'|'negX'|'posZ'|'negZ'` (the deck edge it runs on) and its walking
 * surface `notchable`; a lifted guest tags its floor-seated links `anchor: 'floor'`, and where it meets the
 * deck comes from its own `snap.edgeMount` declaration (docs/part-snap-cuts.md). An untagged link always passes through untouched, so the
 * transform is a no-op on parts that don't opt in.
 */

type Vec3Tuple = [number, number, number]
type RigGeo = Extract<PartPackage['geometry'], { kind: 'rig' }>

const EDGES = [
  { key: 'posX', axis: 2 }, // +X edge runs along Z
  { key: 'negX', axis: 2 }, // -X edge runs along Z
  { key: 'posZ', axis: 0 }, // +Z edge runs along X
  { key: 'negZ', axis: 0 }, // -Z edge runs along X
] as const

/** the box link's resolved size along `axis` (C-paramgeo: param × scale + add, clamped) */
function resolvedAxisSize(link: RigLink, axis: number, params: Record<string, unknown>): number {
  if (link.shape.kind !== 'box') return 0
  return resolvedBoxSize(link.shape.size, link.shape.sizeParams, params as Record<string, number>)[axis] ?? link.shape.size[axis] ?? 0
}

/** clone a box link as a fixed-size segment: size[axis]=len, offset[axis]=center; drops the axis' sizeParam */
function segmentBox(link: RigLink, axis: number, center: number, len: number): RigLink {
  if (link.shape.kind !== 'box') return link
  const size = [...link.shape.size] as Vec3Tuple
  size[axis] = len
  const offset = [...link.offset] as Vec3Tuple
  offset[axis] = center
  const sizeParams = link.shape.sizeParams?.filter((s) => s.axis !== axis)
  return {
    ...link,
    array: undefined,
    offset,
    shape: { ...link.shape, size, ...(sizeParams && sizeParams.length ? { sizeParams } : { sizeParams: undefined }) },
  }
}

/** a multi-instance array (posts) vs a bare visibility gate / no array (a rail box) - the cut dispatch:
 *  multi-instance links skip instances in the gap; single boxes split into kept segments. A bare-gate array
 *  resolves to one instance at [0,0,0], so routing it through the skip path would delete the whole link
 *  whenever the gap covers the link origin (the "stair removes the entire railing side" bug). Exported for the
 *  renderer, which routes railing links between the instanced-array and split-mesh paths by the same test. */
export function isMultiInstance(array: RigLink['array']): boolean {
  return !!array && (array.grid !== undefined || array.distribute !== undefined || array.count !== undefined)
}

/**
 * The post-run cut as a pure delta transform. The sim's link rewrite (skipPosts) and the renderer's
 * instanced-array refresh both call it, so the collider posts and the drawn posts can never disagree:
 * drop instances whose centre (delta along `axis`) sits in an opening, and frame the gap with a post at each
 * opening edge (within the array's span, merged into a kept grid post when one already stands there).
 */
export function cutPostDeltas(deltas: readonly (readonly number[])[], axis: number, openings: readonly Range[]): { kept: number[][]; framing: number[][] } {
  if (openings.length === 0) return { kept: deltas.map((d) => [...d]), framing: [] }
  const kept: number[][] = []
  const keptCoords: number[] = []
  for (const d of deltas) {
    const coord = d[axis] ?? 0
    if (openings.some(([a, b]) => coord >= a - 1e-4 && coord <= b + 1e-4)) continue
    kept.push([...d])
    keptCoords.push(coord)
  }
  const framing: number[][] = []
  const lo = deltas.length ? Math.min(...deltas.map((d) => d[axis] ?? 0)) : 0
  const hi = deltas.length ? Math.max(...deltas.map((d) => d[axis] ?? 0)) : 0
  const proto = deltas[0] ?? [0, 0, 0]
  for (const [a, b] of openings) {
    for (const edge of [a, b]) {
      if (edge < lo - 1e-4 || edge > hi + 1e-4) continue
      if (keptCoords.some((c) => Math.abs(c - edge) < POST_MERGE_EPS)) continue
      const d = [...proto]
      d[axis] = edge
      framing.push(d)
      keptCoords.push(edge)
    }
  }
  return { kept, framing }
}

/** a deck-strip rectangle in platform-local XZ (the complement of the notches over the deck) */
export interface DeckStripRect {
  x0: number
  x1: number
  z0: number
  z1: number
}

/**
 * The deck-hole cut as pure rectangles, shared by the sim's link rewrite (deckStrips) and the renderer's
 * deck-children refresh: carve the hl×hw deck into the complement strips around every notch. No notches ⇒ one
 * full-deck rect. A strip thinner than 1 mm is dropped (a notch flush with the rim).
 */
export function deckStripRects(hl: number, hw: number, notches: readonly DeckNotch[]): DeckStripRect[] {
  let rects: DeckStripRect[] = [{ x0: -hl, x1: hl, z0: -hw, z1: hw }]
  for (const n of notches) {
    const next: DeckStripRect[] = []
    for (const r of rects) {
      // no overlap → the rect survives whole
      if (n.x1 <= r.x0 + 1e-3 || n.x0 >= r.x1 - 1e-3 || n.z1 <= r.z0 + 1e-3 || n.z0 >= r.z1 - 1e-3) { next.push(r); continue }
      if (n.x0 > r.x0 + 1e-3) next.push({ x0: r.x0, x1: n.x0, z0: r.z0, z1: r.z1 })
      if (n.x1 < r.x1 - 1e-3) next.push({ x0: n.x1, x1: r.x1, z0: r.z0, z1: r.z1 })
      const mx0 = Math.max(r.x0, n.x0)
      const mx1 = Math.min(r.x1, n.x1)
      if (n.z0 > r.z0 + 1e-3) next.push({ x0: mx0, x1: mx1, z0: r.z0, z1: n.z0 })
      if (n.z1 < r.z1 - 1e-3) next.push({ x0: mx0, x1: mx1, z0: n.z1, z1: r.z1 })
    }
    rects = next
  }
  return rects.filter((r) => r.x1 - r.x0 > 1e-3 && r.z1 - r.z0 > 1e-3)
}

/** split a single railing box spanning `axis` (centred) into the solid segments an opening leaves */
function splitRailBox(link: RigLink, axis: number, openings: readonly Range[], params: Record<string, unknown>): RigLink[] {
  const len = resolvedAxisSize(link, axis, params)
  if (len <= 1e-4) return [link]
  const segments = keptSegments(-len / 2, len / 2, openings)
  if (segments.length === 1 && Math.abs(segments[0]![0] + len / 2) < 1e-4 && Math.abs(segments[0]![1] - len / 2) < 1e-4) return [link]
  // each segment is a copy of the link, so it keeps the link's showParam (the railing toggle hides the cut rail too)
  return segments.map((seg, i) => ({ ...segmentBox(link, axis, (seg[0] + seg[1]) / 2, seg[1] - seg[0]), name: `${link.name}_seg${i}` }))
}

/** a boundary post added this close to a kept grid post would double up - skip it (≈1.5 post widths) */
const POST_MERGE_EPS = 0.06

/**
 * Expand a distribute post array, dropping instances whose centre (delta along `axis`) sits in an opening, and
 * adding a post at each opening boundary, so each solid segment of the railing has a post at both ends. Without
 * them the rails end in mid-air at the gap and the platform railing does not visually meet the stair's handrail
 * arriving there. The kept/framing positions come from {@link cutPostDeltas}, the same pure transform the
 * renderer's instanced refresh applies, so the collider posts and the drawn posts can't drift.
 */
function skipPosts(link: RigLink, axis: number, openings: readonly Range[], params: Record<string, unknown>): RigLink[] {
  if (!link.array) return [link]
  const deltas = arrayInstanceDeltas(link.array, params as Record<string, number>, undefined, link.showParam)
  const { kept, framing } = cutPostDeltas(deltas, axis, openings)
  // expanded instances are copies of the link, so they keep its showParam (showRailings), or the whole cut side
  // of the railing would ignore the toggle once a stair connects
  const toLink = (d: number[], name: string): RigLink => ({
    ...link,
    array: undefined,
    offset: [link.offset[0] + (d[0] ?? 0), link.offset[1] + (d[1] ?? 0), link.offset[2] + (d[2] ?? 0)] as Vec3Tuple,
    name,
  })
  return [
    ...kept.map((d, i) => toLink(d, `${link.name}_i${i}`)),
    ...framing.map((d, i) => toLink(d, `${link.name}_b${i}`)),
  ]
}

/** carve the deck box into the complement rectangles around the notches ({@link deckStripRects}, the same
 *  pure rects the renderer's deck-children refresh lays out); [] when the notches cover everything */
function deckStrips(link: RigLink, hl: number, hw: number, notches: readonly DeckNotch[]): RigLink[] {
  if (link.shape.kind !== 'box') return [link]
  const thick = link.shape.size[1]
  return deckStripRects(hl, hw, notches).map((s, i) => ({
    ...link,
    array: undefined,
    name: `${link.name}_strip${i}`,
    offset: [(s.x0 + s.x1) / 2, link.offset[1], (s.z0 + s.z1) / 2] as Vec3Tuple,
    shape: { kind: 'box' as const, size: [s.x1 - s.x0, thick, s.z1 - s.z0] as Vec3Tuple },
  }))
}

export interface PlatformCut {
  openings: PlatformOpenings
  notches: DeckNotch[]
}

/** Rewrite a platform rig's links so its railing opens over the stair gap and its deck carves out each notch. */
export function applyPlatformCut(geo: RigGeo, cut: PlatformCut, params: Record<string, unknown>): RigGeo {
  // deck extents come from the deck link's own resolved box (its sizeParams track the part's size params),
  // so the clamp needs no knowledge of which params the part names its footprint with
  const deckLink = geo.links.find((l) => l.notchable && l.shape.kind === 'box')
  const hl = deckLink ? resolvedAxisSize(deckLink, 0, params) / 2 : 0
  const hw = deckLink ? resolvedAxisSize(deckLink, 2, params) / 2 : 0
  const links: RigLink[] = []
  for (const link of geo.links) {
    // deck notch(es)
    if (link.notchable && cut.notches.length > 0 && hl > 0 && hw > 0) {
      links.push(...deckStrips(link, hl, hw, cut.notches))
      continue
    }
    // a declared railing link on an opened edge? Multi-instance arrays (the post run) skip instances in the
    // gap and gain framing posts. Any other box (rails/toe/wall, including bare-gate showRailings links, which
    // resolve to one instance at the origin and must never go down the skip path) splits into the solid
    // segments around the gap.
    const edge = EDGES.find((e) => link.onEdge === e.key && cut.openings[e.key].length > 0)
    if (edge) {
      const open = cut.openings[edge.key]
      if (isMultiInstance(link.array)) links.push(...skipPosts(link, edge.axis, open, params))
      else if (link.shape.kind === 'box') links.push(...splitRailBox(link, edge.axis, open, params))
      else links.push(link)
      continue
    }
    links.push(link)
  }
  return { ...geo, links }
}

/** shift one link up by `lift` - through the axis-1 offset param when the link's Y is param-driven
 *  (the landing/rails), else through the static offset (treads/posts/newels) */
function liftLink(link: RigLink, lift: number): RigLink {
  const yParam = link.offsetParams?.find((o) => o.axis === 1)
  if (yParam) {
    const offsetParams = link.offsetParams!.map((o) => (o.axis === 1 ? { ...o, add: (o.add ?? 0) + lift } : o))
    return { ...link, offsetParams }
  }
  const offset = [link.offset[0], link.offset[1] + lift, link.offset[2]] as Vec3Tuple
  return { ...link, offset }
}

/**
 * Rewrite a snapped staircase's rig so the whole flight rises by `lift` (deckTop − its top walking surface,
 * ≤ half a step for the fixed-rise SDK flight). Every link shifts up, so the top plane (last tread + landing)
 * sits flush on the deck and the handrail stays continuous from the newel to the platform railing. Lifting only
 * the landing would leave the sloped rail arriving a residual below the flat one, a visible jog at the top post.
 * (A top-anchored flight that re-derived an exact per-step rise would have no jog, but the rig's constant-slope
 * steel can't express that.) The residual shows at the foot instead, where `anchor: 'floor'` links keep it
 * seated. A plain box (the newels) stretches down by the lift: its top rises, its bottom stays on the floor. An
 * array link (the risers) also adds a filler plate under its first instance spanning floor→lift, so the first
 * step reads as one taller riser instead of a floating flight. A sinking lift (negative residual) shrinks the
 * foot boxes the same way and skips the filler (the first riser meets the floor early).
 *
 * This is only called for a mounted part, so its `dropWhenMounted` links are removed first, whatever the lift. The
 * deck replaces them (a flight's own top landing, which would otherwise stand on the deck it reaches).
 */
export function applyStairLift(geo: RigGeo, lift: number): RigGeo {
  const mounted = geo.links.some((l) => l.dropWhenMounted) ? geo.links.filter((l) => !l.dropWhenMounted) : geo.links
  if (Math.abs(lift) < 1e-4) return mounted === geo.links ? geo : { ...geo, links: mounted }
  const links: RigLink[] = []
  for (const link of mounted) {
    if (link.anchor === 'floor' && link.shape.kind === 'box') {
      if (link.array) {
        links.push(liftLink(link, lift))
        if (lift > 0.003) {
          const size = [...link.shape.size] as Vec3Tuple
          size[1] = lift
          links.push({
            ...link,
            name: `${link.name}_foot`,
            array: undefined,
            shape: { ...link.shape, size },
            offset: [link.offset[0], lift / 2, link.offset[2]] as Vec3Tuple,
            collision: 'none',
          })
        }
        continue
      }
      const size = [...link.shape.size] as Vec3Tuple
      size[1] = Math.max(size[1] + lift, 0.02)
      links.push({ ...link, shape: { ...link.shape, size }, offset: [link.offset[0], link.offset[1] + lift / 2, link.offset[2]] as Vec3Tuple })
      continue
    }
    links.push(liftLink(link, lift))
  }
  return { ...geo, links }
}

/**
 * The single function render and sim both call to turn a rig part's static package geometry into its
 * per-instance cut geometry, given the scene's structure connections (computeStructureConnections). A platform
 * gains its railing gap + deck notch (applyPlatformCut); a top-connected stair lifts its whole flight flush to the
 * deck (applyStairLift); every other rig part passes through unchanged. One function keeps the visual (rig.ts)
 * and the colliders (world.buildRigBodies) from drifting, as keptSegments does for the guard-opening cut.
 */
export function structureCutGeo(geo: RigGeo, partId: string, params: Record<string, unknown>, conn: StructureConnections | undefined): RigGeo {
  if (!conn) return geo
  const platformCut = conn.platform.get(partId)
  if (platformCut) return applyPlatformCut(geo, platformCut, params)
  const lift = conn.stairTopConnected.get(partId)
  if (lift !== undefined) return applyStairLift(geo, lift)
  return geo
}

/**
 * Stable per-part signature of the structure cut this part currently carries, for the render/sim rebuild
 * reconcilers (folded next to the guard-opening / spur-extent keys). Empty when the part is unaffected, so an
 * ordinary rig never re-registers a new signature. `conn.platform` only holds platforms and `stairTopConnected`
 * only holds stairs, so the part id alone disambiguates (no package lookup needed). The stair side folds in the
 * landing lift so a change in the deck height (the raise amount) re-cuts the flight.
 */
export function structureCutKey(partId: string, conn: StructureConnections | undefined): string {
  if (!conn) return ''
  const platformCut = conn.platform.get(partId)
  if (platformCut) return platformConnectionKey(platformCut)
  const lift = conn.stairTopConnected.get(partId)
  return lift !== undefined ? `landing:${lift}` : ''
}
