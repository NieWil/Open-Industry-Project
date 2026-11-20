import type { BeltGuardOpeningSpec, PartInstance } from '../types'
import { bedView, rectangleBedOf } from '../parts/partGeometry'
import { buildBeltPath } from '../conveyor/beltPath'
import { getPackage } from '../parts/partRegistry'

/**
 * Pure edits on a belt's authored side-guard openings (params.guardOpenings),
 * driven by the viewport side-guard gizmo (handles.ts / controller.ts). Openings
 * are arc-length ranges from the tail; the renderer ignores any whose arcEnd <=
 * arcStart, so a drag may briefly collapse an opening without artefacts.
 *
 * The gestures (editor/controller/drag.ts, guard-openings mode): sweep along a guard to cut an opening, drag an edge dot to resize, drag
 * inside an opening to slide it, click one and press Delete to remove it. Every edit touches one wall. A
 * both-sided row is split first ({@link isolateOnWall}).
 *
 * An SDK belt stores its openings as a `numberList` param - rows `[arcStart, arcEnd, side]`
 * with side −1 = left / +1 = right / 0 = both (the belt behavior's convention). The gizmo
 * plumbing edits {@link BeltGuardOpeningSpec} objects, so {@link rowsToOpeningSpecs} /
 * {@link openingSpecsToRows} bridge the two at the controller boundary.
 */

const EPS = 1e-4

type SRange = [number, number]

/** side code an SDK-belt guardOpenings row carries: −1 left / +1 right / 0 both */
function sideOfCode(code: number): BeltGuardOpeningSpec['side'] {
  return code < 0 ? 'left' : code > 0 ? 'right' : 'both'
}
function codeOfSide(side: BeltGuardOpeningSpec['side']): number {
  return side === 'left' ? -1 : side === 'right' ? 1 : 0
}

/** Parse an SDK belt's `guardOpenings` numberList (`[arcStart, arcEnd, side]` rows) into edit specs. */
export function rowsToOpeningSpecs(rows: readonly (readonly number[])[]): BeltGuardOpeningSpec[] {
  const out: BeltGuardOpeningSpec[] = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue
    const arcStart = row[0]
    const arcEnd = row[1]
    if (typeof arcStart !== 'number' || typeof arcEnd !== 'number') continue
    out.push({ arcStart, arcEnd, side: sideOfCode(typeof row[2] === 'number' ? row[2] : 0) })
  }
  return out
}

/**
 * Inverse of {@link rowsToOpeningSpecs}: edit specs back to the belt's `guardOpenings` rows. An opening dragged
 * shut (no width left) is dropped rather than written: it cuts nothing, and {@link openingsOnSide} gives it no
 * dots, so once saved it could never be selected or removed again.
 */
export function openingSpecsToRows(specs: readonly BeltGuardOpeningSpec[]): number[][] {
  return specs.filter((o) => o.arcEnd > o.arcStart).map((o) => [o.arcStart, o.arcEnd, codeOfSide(o.side)])
}

/**
 * Editable side-guard arc-length bounds for the in-viewport gizmo, or null if the part isn't a
 * belt that authors guard openings. Belt-only: the gizmo places its dots along the (possibly bent)
 * belt path, so it needs the belt's arc-length model. Belt guards wrap a pulley-radius past each
 * end (beltGuardChords extendEnds), so the openings reach [lo, hi] = [−pulley, topLength+pulley].
 */
export function beltGuardArcRange(part: PartInstance): GuardArcRange | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.params.guardOpenings == null) return null // the part must author openings for the gizmo to drive
  const view = bedView(part, 'path')
  if (!view) return null // gizmo is belt-only (needs the belt path's arc-length parameterisation)
  const path = buildBeltPath(view.segments, view.height)
  const pulley = path.height / 2
  return { lo: -pulley, hi: path.topLength + pulley }
}

/**
 * The straight (roller-bed) counterpart of {@link beltGuardArcRange}. A centre-origin straight bed's guard box
 * spans exactly ±length/2 with no pulley wrap to reach past, so the editable range is the plain bed
 * [0, length].
 *
 * Rows stay tail-relative (0 = the upstream end) like the belt's, so `guardOpenings` means the same thing
 * to an author on either family even though the two bodies use different origins (belt = tail,
 * roller = centre - core/parts/partGeometry isTailOriginConveyor). {@link straightGuardOpenings} plus the
 * host's own bedLo shift do the conversion into local X, in one place (guardOpenings.deriveGuardOpenings).
 */
export function straightGuardArcRange(part: PartInstance): GuardArcRange | null {
  if (part.type !== 'part') return null
  const pkg = getPackage(part.packageId)
  if (!pkg || pkg.params.guardOpenings == null) return null // the part must author openings for the gizmo to drive
  const view = rectangleBedOf(part)
  return view ? { lo: 0, hi: view.length } : null
}

/**
 * Editable side-guard bounds for any conveyor that authors openings: a bent belt (arc-length along its
 * path) or a straight roller bed (distance from the tail). Null when the part authors none, which is what
 * makes Side-Guards mode inert on every other selection.
 */
export function guardArcRange(part: PartInstance): GuardArcRange | null {
  return beltGuardArcRange(part) ?? straightGuardArcRange(part)
}

/**
 * Authored openings as per-side ranges in the same tail-relative space the rows are written in, ready for
 * the host to shift into its local X and merge with the neighbour-derived openings. For a straight
 * conveyor (roller) the bed is unbent, so this is a plain clamp with no path walk (cf.
 * beltPath.manualGuardOpenings, whose arc lengths follow the bent belt path). Ranges are clamped to
 * [0, length]; collapsed rows are dropped.
 */
export function straightGuardOpenings(
  specs: readonly BeltGuardOpeningSpec[],
  length: number,
): { left: SRange[]; right: SRange[] } {
  const left: SRange[] = []
  const right: SRange[] = []
  for (const o of specs) {
    if (o.arcEnd <= o.arcStart) continue
    const r: SRange = [clampArc(o.arcStart, 0, length), clampArc(o.arcEnd, 0, length)]
    if (r[1] - r[0] <= EPS) continue
    if (o.side === 'left' || o.side === 'both') left.push(r)
    if (o.side === 'right' || o.side === 'both') right.push(r)
  }
  return { left, right }
}

export type GuardWall = 'left' | 'right'

/**
 * The editable side-guard arc-length bounds. Not just [0, length]: belt guards
 * wrap a pulley-radius past each end (beltGuardChords extendEnds), so openings reach
 * [lo, hi] = [-pulley, length+pulley]; a straight roller has no wrap so [0, length].
 */
export interface GuardArcRange {
  lo: number
  hi: number
}

export function clampArc(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** an opening lives on a guard wall when its side matches, or it spans both */
export function openingOnSide(o: BeltGuardOpeningSpec, side: GuardWall): boolean {
  return o.side === side || o.side === 'both'
}

/** indices into `specs` of the openings shown on `side`, ordered by arcStart */
export function openingsOnSide(specs: readonly BeltGuardOpeningSpec[], side: GuardWall): number[] {
  return specs
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => openingOnSide(o, side) && o.arcEnd > o.arcStart)
    .sort((a, b) => a.o.arcStart - b.o.arcStart)
    .map(({ i }) => i)
}

/** Move one edge of opening `index` to arc `value`, clamped to [lo, hi] and to the other edge. */
export function resizeOpeningEdge(
  specs: readonly BeltGuardOpeningSpec[],
  index: number,
  edge: 'start' | 'end',
  value: number,
  lo: number,
  hi: number,
): BeltGuardOpeningSpec[] {
  const o = specs[index]
  if (!o) return specs as BeltGuardOpeningSpec[]
  const v = clampArc(value, lo, hi)
  const next: BeltGuardOpeningSpec =
    edge === 'start' ? { ...o, arcStart: Math.min(v, o.arcEnd) } : { ...o, arcEnd: Math.max(v, o.arcStart) }
  return specs.map((s, i) => (i === index ? next : s))
}

/**
 * The opening on `side` whose span contains `s`, or -1. The last such row is returned, since it is the one most
 * recently swept, so a press inside two overlapping openings grabs the newer one.
 */
export function openingAt(specs: readonly BeltGuardOpeningSpec[], side: GuardWall, s: number): number {
  for (let i = specs.length - 1; i >= 0; i--) {
    const o = specs[i]!
    if (openingOnSide(o, side) && o.arcEnd > o.arcStart && s >= o.arcStart - EPS && s <= o.arcEnd + EPS) return i
  }
  return -1
}

/**
 * The gizmo edits one wall at a time. A row that cuts both walls (side 0, which the Inspector can still write) is
 * split before it is edited: row `index` becomes this wall's copy, in place, so the index stays valid, and the
 * other wall's copy is appended unchanged. A single-sided row comes back as is.
 */
export function isolateOnWall(specs: readonly BeltGuardOpeningSpec[], index: number, side: GuardWall): BeltGuardOpeningSpec[] {
  const o = specs[index]
  if (!o || o.side !== 'both') return specs as BeltGuardOpeningSpec[]
  const other: GuardWall = side === 'left' ? 'right' : 'left'
  return [...specs.map((s, i) => (i === index ? { ...s, side } : s)), { ...o, side: other }]
}

/** Remove opening `index` from one wall: a single-sided row goes, a both-sided one keeps cutting the other wall. */
export function removeFromWall(specs: readonly BeltGuardOpeningSpec[], index: number, side: GuardWall): BeltGuardOpeningSpec[] {
  const o = specs[index]
  if (!o) return specs as BeltGuardOpeningSpec[]
  if (o.side === 'both') return specs.map((s, i) => (i === index ? { ...s, side: side === 'left' ? 'right' : 'left' } : s))
  return specs.filter((_, i) => i !== index)
}

/** the narrowest opening a sweep writes: anything less is a click that wobbled, not a gap */
export const MIN_SWEEP = 0.02

/**
 * A new single-sided opening swept along a wall from `a` to `b` (either order), clamped to the guard. Null while it
 * is narrower than {@link MIN_SWEEP}, so a press that barely moves writes nothing.
 */
export function sweepOpening(
  specs: readonly BeltGuardOpeningSpec[],
  side: GuardWall,
  a: number,
  b: number,
  lo: number,
  hi: number,
): { specs: BeltGuardOpeningSpec[]; index: number } | null {
  const arcStart = clampArc(Math.min(a, b), lo, hi)
  const arcEnd = clampArc(Math.max(a, b), lo, hi)
  if (arcEnd - arcStart < MIN_SWEEP) return null
  return { specs: [...specs, { arcStart, arcEnd, side }], index: specs.length }
}

/** Slide opening `index` by `delta`, keeping its width; it stops at the guard ends instead of shrinking there. */
export function moveOpening(
  specs: readonly BeltGuardOpeningSpec[],
  index: number,
  delta: number,
  lo: number,
  hi: number,
): BeltGuardOpeningSpec[] {
  const o = specs[index]
  if (!o) return specs as BeltGuardOpeningSpec[]
  // min/max with 0: a row already hanging past an end (typed in the Inspector) may still move back inward
  const shift = clampArc(delta, Math.min(0, lo - o.arcStart), Math.max(0, hi - o.arcEnd))
  return specs.map((s, i) => (i === index ? { ...s, arcStart: o.arcStart + shift, arcEnd: o.arcEnd + shift } : s))
}

/**
 * Where row `index` of `specs` lands in the rows {@link openingSpecsToRows} writes, which drops shut openings, or
 * null when it is one of those. Keeps the gizmo's selected opening pointing at the right row after a commit.
 */
export function rowIndexAfterWrite(specs: readonly BeltGuardOpeningSpec[], index: number): number | null {
  const o = specs[index]
  if (!o || o.arcEnd <= o.arcStart) return null
  let n = 0
  for (let i = 0; i < index; i++) if (specs[i]!.arcEnd > specs[i]!.arcStart) n++
  return n
}

/** `v` rounded to the nearest multiple of `step`, or unchanged when there is no step */
export function snapArc(v: number, step: number | null | undefined): number {
  return step && step > 0 ? Math.round(v / step) * step : v
}
