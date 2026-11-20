import type { PartInstance } from './types'
import type { SnapEdgeMount } from './parts/partApi'
import { toLocalXZ, toWorldXZ } from './parts/partGeometry'
import { getPackage } from './parts/partRegistry'
import { memoizeByParticipants } from './memoParts'
import { edgeMountContact } from './snap/snapConnectors'

/**
 * Geometry-derived structure connections between a part that meets a deck edge and the deck's host (the
 * platform's connection/stair-connection detection, opened to any part: docs/part-snap-cuts.md). When a guest's
 * edge-mount contact is on a platform's deck edge (snapFeatures, `edgeMount`), each effect the guest declares
 * happens:
 *
 *  1. `opens` - a gap in the host's links that run on that edge (`onEdge`) over the guest's width, so a flight
 *     is walkable onto the deck. Ranges per edge, centred on the edge's run axis.
 *  2. `notch` - a rectangular cut in the deck where the guest's footprint (origin → contact) overlaps the deck
 *     interior (the deck hole). Edge-flush seats (the contact on the edge, the part outside) only nick the
 *     rim, so there is no notch. A notch is cut when a flight is placed over the deck.
 *  3. `lift` - the guest itself, once its contact is on the edge, lifts its whole rig so the contact sits
 *     flush with the deck top and the handrail runs continuous into the platform railing. Lifting only the
 *     landing would leave a jog in the rail at the top post. `anchor: 'floor'` links stretch back down so the foot
 *     stays on the floor. The lift (deckTop − contact height) is the map value.
 *
 * All transient (never serialised); recomputed every render/sim sync, mirroring the conveyor guard-merge
 * (guardOpenings.ts). A platform is any part advertising a `deck` snap surface with a heightParam (its
 * length/width/height params give the deck). A guest is any part whose `edgeMount` declares one of the effects
 * (its contact point and `alongParam` width give where and how wide). See docs/part-snap-cuts.md.
 */

export type Range = [number, number]

export interface PlatformOpenings {
  /** +X edge (x = +length/2), ranges in z */
  posX: Range[]
  /** -X edge (x = -length/2), ranges in z */
  negX: Range[]
  /** +Z edge (z = +width/2), ranges in x */
  posZ: Range[]
  /** -Z edge (z = -width/2), ranges in x */
  negZ: Range[]
}

/** a rectangular hole to cut from the deck, in platform-local XZ (clamped to the deck) */
export interface DeckNotch {
  x0: number
  x1: number
  z0: number
  z1: number
}

export interface PlatformConnection {
  openings: PlatformOpenings
  notches: DeckNotch[]
}

export interface StructureConnections {
  /** platforms that gained a railing gap and/or a deck notch, keyed by part id */
  platform: Map<string, PlatformConnection>
  /** guests that declare `lift` and meet a platform deck edge, by part id → the local-Y lift that raises the
   *  contact flush to the deck top (deckTop − contact height; ≤ half a unit for a whole-unit `fromFloor` fit).
   *  Named for its first user, the staircase; every lifted edge-mount guest is listed here. */
  stairTopConnected: Map<string, number>
}

/** an end whose centre is this close to a deck edge / plane opens the railing (the snap tolerance) */
const CONTACT_TOLERANCE = 0.15
/** ignore slivers that would only nick the railing / deck */
const MIN_OPENING = 0.05
/** the raised landing top sits this far above the deck plane, so the two walking surfaces are never exactly
 *  coplanar (z-fighting flashes the deck black when a dragged landing crosses solid deck) */
const LANDING_CLEARANCE = 0.001

/**
 * Openings / notch coordinates quantize to 1 mm. The render applies the cut in
 * place per refresh (rig.ts railing/deck pools - the conveyor guard-merge cost model), so a re-cut per
 * pointer-move is cheap; the quantization only keeps the change-detection keys stable against float noise.
 */
function quant(v: number): number {
  return Math.round(v * 1e3) / 1e3
}

/** the flight lift keeps mm precision too - it sets the walking-surface flushness, and only changes on a
 *  height edit (never during the common slide-along-edge drag) */
function round(v: number): number {
  return Math.round(v * 1e3) / 1e3
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

function pushOpening(arr: Range[], lo: number, hi: number): void {
  if (hi - lo > MIN_OPENING) arr.push([quant(lo), quant(hi)])
}

function numParam(part: PartInstance, name: string): number | null {
  const v = (part.params as Record<string, unknown>)[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// --- part identification (SDK parts, via their declarative snap) -----------------------------------------

export interface PlatformDeck {
  hl: number
  hw: number
  deckTop: number
}

/** a platform: a part advertising a `deck` snap surface carrying a heightParam. Its length/width/height params
 *  give the deck rectangle + elevation; the origin sits at the deck top (examples/parts/platform/part.js). Exported
 *  for the leg-rest resolver (legRests.ts), which reuses the same deck discovery for leg footing. */
export function platformDeck(part: PartInstance): PlatformDeck | null {
  if (part.type !== 'part') return null
  const surface = getPackage(part.packageId)?.snap?.surfaces?.find((s) => s.kind === 'deck' && s.heightParam)
  if (!surface) return null
  const len = numParam(part, surface.lengthParam)
  const wid = numParam(part, surface.widthParam)
  if (len === null || wid === null || len <= 0 || wid <= 0) return null
  return { hl: len / 2, hw: wid / 2, deckTop: part.position[1] }
}

/** a guest: a part whose `edgeMount` declares an effect on the deck it meets (opens / notch / lift) */
interface EdgeGuest {
  em: SnapEdgeMount
  /** extent along the edge (the mount's alongParam): the width of the gap it opens */
  width: number
  /** the contact point in the part's local frame, at its current params */
  at: [number, number, number]
  /** world Y of the contact (the height that has to meet the deck plane) */
  topY: number
}

function edgeGuest(part: PartInstance): EdgeGuest | null {
  if (part.type !== 'part') return null
  const em = getPackage(part.packageId)?.snap?.edgeMount
  if (!em || !(em.opens || em.notch || em.lift)) return null
  const width = numParam(part, em.alongParam)
  if (width === null || width <= 0) return null
  const at = em.facing === 'into' ? edgeMountContact(em, part.params as Record<string, unknown>) : ([0, 0, 0] as [number, number, number])
  return { em, width, at, topY: part.position[1] + at[1] }
}

/**
 * Where a guest's contact meets the host's deck edges: each edge and the range along it that the guest covers
 * (its width projected onto the edge, clamped to the deck); none when it meets no edge. The contact is a segment `width` long:
 * for a part facing into the deck it runs across the part (local Z) at the contact point; for a part lying along
 * the edge it runs along the part (local X) through its origin. It only meets the edge when it sits at the deck
 * plane and its centre lies on the edge (the stair-endpoint check).
 */
function meetEdges(host: PartInstance, deck: PlatformDeck, guest: PartInstance, g: EdgeGuest): { edge: keyof PlatformOpenings; lo: number; hi: number }[] {
  if (Math.abs(g.topY - deck.deckTop) > CONTACT_TOLERANCE) return []
  const into = g.em.facing === 'into'
  const half = g.width / 2
  const centerW = toWorldXZ(guest, g.at[0], g.at[2])
  const cornerAW = into ? toWorldXZ(guest, g.at[0], g.at[2] - half) : toWorldXZ(guest, -half, 0)
  const cornerBW = into ? toWorldXZ(guest, g.at[0], g.at[2] + half) : toWorldXZ(guest, half, 0)
  const c = toLocalXZ(host, centerW.x, centerW.z)
  const a = toLocalXZ(host, cornerAW.x, cornerAW.z)
  const b = toLocalXZ(host, cornerBW.x, cornerBW.z)
  const { hl, hw } = deck
  const zMin = Math.min(c.z, a.z, b.z)
  const zMax = Math.max(c.z, a.z, b.z)
  const xMin = Math.min(c.x, a.x, b.x)
  const xMax = Math.max(c.x, a.x, b.x)
  const tol = CONTACT_TOLERANCE
  // every edge the contact lies on: at a deck corner that is two, and both open. Being on the edge's line is not
  // enough. The contact has to overlap the edge itself, or a flight whose top meets the line out past a deck corner
  // would lift (and drop its landing) against a deck it never reaches
  const out: { edge: keyof PlatformOpenings; lo: number; hi: number }[] = []
  const meet = (edge: keyof PlatformOpenings, lo: number, hi: number): void => {
    if (hi - lo > 0.01) out.push({ edge, lo, hi })
  }
  if (Math.abs(c.x - hl) < tol) meet('posX', Math.max(zMin, -hw), Math.min(zMax, hw))
  if (Math.abs(c.x + hl) < tol) meet('negX', Math.max(zMin, -hw), Math.min(zMax, hw))
  if (Math.abs(c.z - hw) < tol) meet('posZ', Math.max(xMin, -hl), Math.min(xMax, hl))
  if (Math.abs(c.z + hw) < tol) meet('negZ', Math.max(xMin, -hl), Math.min(xMax, hl))
  return out
}

/**
 * A rectangular deck notch where a `notch` guest's footprint (origin → contact, `width` across) overlaps the deck
 * interior (the deck hole). Gated on the guest's vertical span crossing the deck plane (bottom below, top at or
 * above within tolerance), not on the top being near the plane, so a flight descending through a mezzanine deck
 * cuts its stairwell wherever it stands. The snap seats the contact on the edge (the whole part outside the deck),
 * so an edge-flush seat only nicks the rim (below MIN_OPENING, no notch). The hole is cut when a flight is placed
 * over the deck. An axis-aligned rectangle, not a convex-hull polygon (the box deck can only carve rectangles).
 */
function guestDeckNotch(host: PartInstance, deck: PlatformDeck, guest: PartInstance, g: EdgeGuest): DeckNotch | null {
  const bottomY = guest.position[1] // origin: the part's lowest point (a flight's foot)
  if (!(bottomY < deck.deckTop - CONTACT_TOLERANCE && g.topY >= deck.deckTop - CONTACT_TOLERANCE)) return null
  const { hl, hw } = deck
  const half = g.width / 2
  const corners = [
    toWorldXZ(guest, 0, -half),
    toWorldXZ(guest, 0, half),
    toWorldXZ(guest, g.at[0], -half),
    toWorldXZ(guest, g.at[0], half),
  ].map((w) => toLocalXZ(host, w.x, w.z))
  const x0 = Math.max(Math.min(...corners.map((p) => p.x)), -hl)
  const x1 = Math.min(Math.max(...corners.map((p) => p.x)), hl)
  const z0 = Math.max(Math.min(...corners.map((p) => p.z)), -hw)
  const z1 = Math.min(Math.max(...corners.map((p) => p.z)), hw)
  if (x1 - x0 <= MIN_OPENING || z1 - z0 <= MIN_OPENING) return null
  return { x0: quant(x0), x1: quant(x1), z0: quant(z0), z1: quant(z1) }
}

function hasOpenings(op: PlatformOpenings): boolean {
  return op.posX.length > 0 || op.negX.length > 0 || op.posZ.length > 0 || op.negZ.length > 0
}

/**
 * Compute every deck-edge connection in a scene: each platform's railing openings + deck notches, and the guests
 * lifted flush onto a deck. Keyed by part id; only affected parts appear. Guests = parts with an effect-declaring
 * edgeMount; hosts = platforms.
 */
function computeStructureConnectionsUncached(parts: readonly PartInstance[]): StructureConnections {
  const platform = new Map<string, PlatformConnection>()
  const stairTopConnected = new Map<string, number>()
  const platforms: { part: PartInstance; deck: PlatformDeck }[] = []
  const guests: { part: PartInstance; g: EdgeGuest }[] = []
  for (const p of parts) {
    const deck = platformDeck(p)
    if (deck) { platforms.push({ part: p, deck }); continue }
    const g = edgeGuest(p)
    if (g) guests.push({ part: p, g })
  }
  if (platforms.length === 0 || guests.length === 0) return { platform, stairTopConnected }

  for (const host of platforms) {
    const openings: PlatformOpenings = { posX: [], negX: [], posZ: [], negZ: [] }
    const notches: DeckNotch[] = []
    for (const s of guests) {
      const met = meetEdges(host.part, host.deck, s.part, s.g)
      if (met.length > 0) {
        if (s.g.em.opens) for (const m of met) pushOpening(openings[m.edge], m.lo, m.hi)
        // a lifted guest raises its contact to the deck top (+ a hair of clearance so the two walking surfaces
        // never z-fight when a dragged landing crosses solid deck)
        if (s.g.em.lift) stairTopConnected.set(s.part.id, round(host.deck.deckTop - s.g.topY + LANDING_CLEARANCE))
      }
      if (s.g.em.notch) {
        const notch = guestDeckNotch(host.part, host.deck, s.part, s.g)
        if (notch) notches.push(notch)
      }
    }
    openings.posX = mergeRanges(openings.posX)
    openings.negX = mergeRanges(openings.negX)
    openings.posZ = mergeRanges(openings.posZ)
    openings.negZ = mergeRanges(openings.negZ)
    if (hasOpenings(openings) || notches.length > 0) platform.set(host.part.id, { openings, notches })
  }
  return { platform, stairTopConnected }
}

/** Memoized on the participating parts (platforms + guests) like every other scene resolver
 *  (docs/seam-resolvers.md): a sync that moves neither recomputes nothing. */
export const computeStructureConnections = memoizeByParticipants(
  (p) => platformDeck(p) !== null || edgeGuest(p) !== null,
  computeStructureConnectionsUncached,
)

/** stable key for change detection between renders (positions drift continuously during a drag) */
export function platformConnectionKey(c: PlatformConnection | undefined): string {
  if (!c) return ''
  return JSON.stringify([c.openings.posX, c.openings.negX, c.openings.posZ, c.openings.negZ, c.notches])
}
