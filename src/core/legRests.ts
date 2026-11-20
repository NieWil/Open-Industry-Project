import { FLOOR_SURFACE_Y } from './types'
import type { PartInstance } from './types'
import type { ParamValue } from './parts/partApi'
import { partFootprint, surfaceBelowParam, toLocalXZ, toWorldXZ } from './parts/partGeometry'
import { getPackage } from './parts/partRegistry'
import { platformDeck } from './structureConnections'
import { memoizeByParticipants } from './memoParts'

/**
 * Geometry-derived per-leg footing for a legged conveyor crossing a platform: the host derives each leg's support
 * from the platform decks' geometry instead of each leg probing the surface under it.
 *
 * Without this, a legged part's feet all end on one plane, `position.y - standHeight` (`rest:'surfaceBelow'`,
 * resolved under the part origin). Across a platform edge that is wrong: legs over the deck pierce it, or legs
 * overhanging it float at deck height.
 *
 * Emits, per leg-bearing part, rows `[x0, x1, dy]` where the surface below differs from the part's floor plane
 * (part-local X, metres; dy = surface top minus the floor plane, so dy > 0 stands feet on a deck, dy < 0 drops
 * them to the warehouse floor). Consumers resize each leg in a row and drop legs squeezed under 5 cm.
 * geometry() stays world-unaware (the guardExtents cost model; docs/seam-resolvers.md).
 *
 * Supports are platform decks only (the `deck` snap surface). The warehouse floor is the fallback only for a part
 * whose own floor plane is a deck: a conveyor stacked on a machine or rack never grows feet through it.
 *
 * Straight beds only; curved beds keep single-plane legs (arc stations need a 2D profile, deferred).
 */

/** rows [x0, x1, dy]: local-X interval + foot offset above the part's own floor plane (may be negative) */
export type LegRestRows = number[][]

/** decks at least this far under the part origin count as supports (anything closer can't host a leg) */
const MIN_DECK_DROP = 0.05
/** a deck top this close to the part's own floor plane means the part stands on that deck */
const OWN_FLOOR_TOLERANCE = 0.05
/** ignore foot corrections under 2 mm - quantization noise, not a real step */
const MIN_DY = 0.002
/** drop sliver rows a trestle could never stand in */
const MIN_ROW_WIDTH = 0.02

/** 1 mm quantization for stable change-detection keys (positions drift continuously during a drag) */
function quant(v: number): number {
  return Math.round(v * 1e3) / 1e3
}

/**
 * The part's resolved stand height (its floor-plane distance) when it is a straight leg-bearing part:
 * a function-geometry part declaring the host-fed `legRests` param (its `rest:'surfaceBelow'` param is the
 * stand), or a rig part with a non-arc `kind:'leg'` link (the link names its stand param). Null otherwise.
 */
function legStandHeight(part: PartInstance): number | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg) return null
  let standName: string | null = null
  if (pkg.params['legRests']) standName = surfaceBelowParam(part)
  else if (pkg.geometry.kind === 'rig') {
    for (const l of pkg.geometry.links) {
      if (l.shape.kind === 'leg' && !l.shape.arc) { standName = l.shape.standParam; break }
    }
  }
  if (!standName) return null
  const v = (part.params as Record<string, unknown>)[standName]
  if (typeof v === 'number' && v > 0) return v
  const d = pkg.params[standName]?.default
  return typeof d === 'number' && d > 0 ? d : null
}

/** clip the segment A→B (2D, param t ∈ [0,1]) against the origin-centred slab |x| ≤ hl, |z| ≤ hw */
function clipSegment(ax: number, az: number, bx: number, bz: number, hl: number, hw: number): [number, number] | null {
  let t0 = 0
  let t1 = 1
  const axes: [number, number, number][] = [[ax, bx - ax, hl], [az, bz - az, hw]]
  for (const [p, d, h] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(p) > h) return null
      continue
    }
    let lo = (-h - p) / d
    let hi = (h - p) / d
    if (lo > hi) { const t = lo; lo = hi; hi = t }
    if (lo > t0) t0 = lo
    if (hi < t1) t1 = hi
    if (t0 >= t1) return null
  }
  return [t0, t1]
}

function computeSceneLegRestsUncached(parts: readonly PartInstance[]): Map<string, LegRestRows> {
  const out = new Map<string, LegRestRows>()
  const decks: { part: PartInstance; hl: number; hw: number; top: number }[] = []
  const legged: { part: PartInstance; stand: number }[] = []
  for (const p of parts) {
    const deck = platformDeck(p)
    if (deck) { decks.push({ part: p, hl: deck.hl, hw: deck.hw, top: deck.deckTop }); continue }
    const stand = legStandHeight(p)
    if (stand !== null) legged.push({ part: p, stand })
  }
  if (decks.length === 0 || legged.length === 0) return out

  for (const { part, stand } of legged) {
    const ownFloor = part.position[1] - stand
    const fp = partFootprint(part)
    const cx = fp.cx ?? 0
    const x0 = cx - fp.hx
    const x1 = cx + fp.hx
    if (!(x1 - x0 > MIN_ROW_WIDTH)) continue
    // both centreline endpoints once in world space; each deck reuses them for its own local clip
    const aw = toWorldXZ(part, x0, fp.cz ?? 0)
    const bw = toWorldXZ(part, x1, fp.cz ?? 0)
    // deck intervals under the bed centreline, + whether the part itself stands on a deck (its own floor
    // plane is a deck top). Only then does the warehouse floor take over the uncovered stretches
    const supports: { s0: number; s1: number; top: number }[] = []
    let onDeck = false
    for (const d of decks) {
      if (!(d.top <= part.position[1] - MIN_DECK_DROP)) continue // at/above the bed: an overhead deck, not a support
      const a = toLocalXZ(d.part, aw.x, aw.z)
      const b = toLocalXZ(d.part, bw.x, bw.z)
      const t = clipSegment(a.x, a.z, b.x, b.z, d.hl, d.hw)
      if (!t) continue
      if (Math.abs(d.top - ownFloor) <= OWN_FLOOR_TOLERANCE) onDeck = true
      supports.push({ s0: x0 + t[0] * (x1 - x0), s1: x0 + t[1] * (x1 - x0), top: d.top })
    }
    if (supports.length === 0) continue
    // piecewise sweep: the highest covering deck is used (first hit looking down); uncovered stretches
    // fall to the warehouse floor for a deck-standing part, else keep the part's own plane (no row)
    const cuts = [x0, x1]
    for (const s of supports) { cuts.push(s.s0, s.s1) }
    cuts.sort((a, b) => a - b)
    const rows: LegRestRows = []
    for (let i = 1; i < cuts.length; i++) {
      const lo = cuts[i - 1]!
      const hi = cuts[i]!
      if (!(hi - lo > 1e-9)) continue
      const mid = (lo + hi) / 2
      let top: number | null = null
      for (const s of supports) if (mid >= s.s0 && mid <= s.s1 && (top === null || s.top > top)) top = s.top
      if (top === null) { if (!onDeck) continue; top = FLOOR_SURFACE_Y }
      const dy = top - ownFloor
      if (Math.abs(dy) <= MIN_DY) continue
      const qdy = quant(dy)
      const last = rows[rows.length - 1]
      if (last && last[2] === qdy && Math.abs(last[1]! - quant(lo)) <= 1e-9) last[1] = quant(hi)
      else rows.push([quant(lo), quant(hi), qdy])
    }
    const kept = rows.filter((r) => r[1]! - r[0]! > MIN_ROW_WIDTH)
    if (kept.length > 0) out.set(part.id, kept)
  }
  return out
}

/** Memoized on the participating parts (legged parts + platforms) like every other scene resolver
 *  (docs/seam-resolvers.md): a sync that moves neither recomputes nothing. */
export const computeSceneLegRests = memoizeByParticipants(
  (p) => legStandHeight(p) !== null || platformDeck(p) !== null,
  computeSceneLegRestsUncached,
)

/**
 * Fold host-derived leg-rest rows into a legged part's params as `legRests`, the footing counterpart of the
 * withSnapExtents fold. A no-op unless the package declares a `legRests` param (the opt-in convention;
 * rig-geometry parts consume the rows directly in the renderer's leg layout instead). geometry() stays
 * world-unaware: the host resolves the platforms below and passes the result in as data.
 */
export function withLegRests(
  part: PartInstance,
  params: Record<string, ParamValue>,
  rests: LegRestRows | undefined,
): Record<string, ParamValue> {
  if (!rests || rests.length === 0 || part.type !== 'part') return params
  if (!getPackage(part.packageId)?.params['legRests']) return params
  return { ...params, legRests: rests as unknown as ParamValue }
}

/** the foot offset at a station: the row containing x (rows are disjoint), else 0 (the part's own plane) */
export function legRestDyAt(rests: LegRestRows | undefined, x: number): number {
  if (rests) for (const r of rests) if (x >= r[0]! && x <= r[1]!) return r[2]!
  return 0
}

/** stable key for change detection between renders (positions drift continuously during a drag) */
export function legRestsKey(rests: LegRestRows | undefined): string {
  if (!rests || rests.length === 0) return ''
  return JSON.stringify(rests)
}
