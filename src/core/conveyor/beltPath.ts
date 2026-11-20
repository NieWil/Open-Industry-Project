import {
  BELT_BEND_SUBDIVISIONS,
  BELT_DEFAULT_SEGMENT_LENGTH,
  BELT_MAX_TILT_DEG,
  type BeltGuardOpeningSpec,
  type BeltSegmentSpec,
  type BeltShapePreset,
} from '../types'
import { filletCorner } from '../filletCorner'

/** minimal belt-path inputs (segments + height) - the geometry fields the path builder needs, so any caller
 *  (an SDK belt view, a raw segment list) can build a path. */
export interface BeltPathParams {
  segments: BeltSegmentSpec[]
  height: number
}

/**
 * Path geometry for a multi-segment belt conveyor.
 *
 * The path lives in the part's local X-Y plane: +X is segment 0's tangent, +Z is
 * cross-belt (constant), and tilt rotates around +Z - so segments incline/decline
 * the belt vertically. Straight runs are chained tangent-to-tangent through fillet
 * arcs whose radius is the belt height, or tighter where a segment is too short to
 * hold it (filletCorner, the rule the part's drawn fillet uses too).
 *
 * Tail-origin: the part origin sits at the start of segment 0 (local x = 0 at the tail, the
 * run extending toward +x), with the tail surface at local y = 0. The flat single-
 * segment belt and the roller conveyor share this convention.
 */

const DEG = Math.PI / 180

export interface BeltRun {
  /** run start point, part-local (x horizontal-ish, y height) */
  x: number
  y: number
  /** tangent angle (rad); 0 = +X, positive inclines up */
  angle: number
  /** straight length after fillet insets at both ends (>= 0: each inset is capped at half the segment) */
  effLength: number
  /** cumulative top-surface arc length at the run start */
  sStart: number
}

/** tangent-fillet arc joining runs[i] and runs[i+1] */
export interface BeltJoint {
  /** arc centre, part-local */
  cx: number
  cy: number
  /** tangent point where the incoming run leaves (arc start), part-local */
  tpx: number
  tpy: number
  /** signed turn angle (rad), incoming tangent -> outgoing tangent */
  turning: number
  /** the belt height, or less where a short segment capped the inset */
  radius: number
  inset: number
  arcLength: number
  sStart: number
  /** incoming tangent angle (rad) */
  angleIn: number
}

export interface BeltBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface BeltPath {
  segments: BeltSegmentSpec[]
  /** belt height (the widest fillet bend radius; a joint's own is `radius`); end-drum radius = height / 2 */
  height: number
  runs: BeltRun[]
  /** joints[i] joins runs[i] and runs[i+1]; length = runs.length - 1 */
  joints: BeltJoint[]
  /** total top-surface arc length */
  topLength: number
  /** top + bottom + the two half-pulley wraps */
  loopLength: number
  /** part-local AABB of the top surface (X-Y), tail at y = 0 */
  bounds: BeltBounds
}

/** {x, y} point + tangent angle at an arc-length sample */
export interface BeltPose {
  x: number
  y: number
  angle: number
}

function clampTilt(deg: number): number {
  return Math.max(-BELT_MAX_TILT_DEG, Math.min(BELT_MAX_TILT_DEG, deg))
}

/**
 * Each segment's tangent angle and the turn into it (rad). A segment's `tiltDeg` turns the path relative to the
 * segment before. The turn, and the running angle, are both held within ±BELT_MAX_TILT_DEG, so the path never
 * doubles back in plan X: beltXToS and every caller that asks for the surface at a plan X rely on that. The belt
 * part's geometry() applies the same rule to the corners it draws (examples/parts/belt-conveyor/part.js).
 */
export function beltSegmentAngles(segments: readonly BeltSegmentSpec[]): { angles: number[]; turns: number[] } {
  const max = BELT_MAX_TILT_DEG * DEG
  const angles: number[] = []
  const turns: number[] = []
  let tilt = 0
  for (const seg of segments) {
    let turn = clampTilt(seg.tiltDeg) * DEG
    const next = tilt + turn
    if (next > max) turn = max - tilt
    else if (next < -max) turn = -max - tilt
    tilt = next > max ? max : next < -max ? -max : next
    angles.push(tilt)
    turns.push(turn)
  }
  return { angles, turns }
}

/** un-inset corner polyline of the segment chain (tail at origin), for bounds/extent */
function segmentCorners(segments: readonly BeltSegmentSpec[]): { x: number; y: number }[] {
  return beltSegmentFrames(segments).corners
}

/**
 * Un-inset segment frames for the resize gizmo (the belt gizmo's
 * segment end positions/tangents): `corners[0]` is the tail origin and
 * `corners[i+1]` the end of segment i, in the local X (along) / Y (elevation) plane;
 * `tangents[i]` is segment i's unit tangent. Fillet insets are ignored - handles
 * sit on the raw corner chain.
 */
export function beltSegmentFrames(segments: readonly BeltSegmentSpec[]): {
  corners: { x: number; y: number }[]
  tangents: { x: number; y: number }[]
} {
  const corners = [{ x: 0, y: 0 }]
  const tangents: { x: number; y: number }[] = []
  const { angles } = beltSegmentAngles(segments)
  let x = 0
  let y = 0
  for (let i = 0; i < segments.length; i++) {
    const tilt = angles[i]!
    tangents.push({ x: Math.cos(tilt), y: Math.sin(tilt) })
    x += Math.cos(tilt) * segments[i]!.length
    y += Math.sin(tilt) * segments[i]!.length
    corners.push({ x, y })
  }
  return { corners, tangents }
}

/** horizontal (local X) span of the belt run, used for footprint half-extent + resize */
export function beltHorizontalExtent(segments: readonly BeltSegmentSpec[]): number {
  const pts = segmentCorners(segments)
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    if (p.x < lo) lo = p.x
    if (p.x > hi) hi = p.x
  }
  return Math.max(hi - lo, 0)
}

/** Build the centred path for a set of segments + belt height. */
export function buildBeltPath(segments: readonly BeltSegmentSpec[], height: number): BeltPath {
  const r = Math.max(height, 0)
  const runs: BeltRun[] = []
  const joints: BeltJoint[] = []
  const n = segments.length
  const { angles, turns } = beltSegmentAngles(segments)

  // insets[i] = fillet inset at the start of run i, radii[i] = radius of the bend before run i. A segment too short
  // for the full-height bends at both its ends gets tighter bends (filletCorner), so effLength never goes negative.
  const insets: number[] = new Array(n).fill(0)
  const radii: number[] = new Array(n).fill(r)
  for (let i = 1; i < n; i++) {
    const turn = Math.abs(turns[i]!)
    if (turn <= 1e-9 || r <= 0) continue
    const f = filletCorner(r, turn, segments[i - 1]!.length, segments[i]!.length)
    insets[i] = f.inset
    radii[i] = f.radius
  }

  let cornerX = 0
  let cornerY = 0
  let s = 0

  for (let i = 0; i < n; i++) {
    const seg = segments[i]!
    const angle = angles[i]!
    const insetStart = insets[i]!
    const insetEnd = i + 1 < n ? insets[i + 1]! : 0
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)

    const run: BeltRun = {
      x: cornerX + ca * insetStart,
      y: cornerY + sa * insetStart,
      angle,
      effLength: seg.length - insetStart - insetEnd,
      sStart: s,
    }
    runs.push(run)
    s += Math.max(0, run.effLength)

    if (i + 1 >= n) break

    const turn = turns[i + 1]!
    const cornerOutX = cornerX + ca * seg.length
    const cornerOutY = cornerY + sa * seg.length
    if (Math.abs(turn) > 1e-9 && r > 0) {
      const inset = insets[i + 1]!
      const radius = radii[i + 1]!
      const tpx = cornerOutX - ca * inset
      const tpy = cornerOutY - sa * inset
      // tangent rotated +90deg, pushed to the inside of the turn
      const leftX = -sa
      const leftY = ca
      const sign = Math.sign(turn)
      joints.push({
        cx: tpx + leftX * sign * radius,
        cy: tpy + leftY * sign * radius,
        tpx,
        tpy,
        turning: turn,
        radius,
        inset,
        arcLength: radius * Math.abs(turn),
        sStart: s,
        angleIn: angle,
      })
      s += radius * Math.abs(turn)
    } else {
      // collinear boundary (zero turn, or a flat belt with r == 0): push a
      // degenerate zero-length joint so `joints` stays aligned 1:1 with the
      // internal run boundaries. Every consumer indexes `joints[i]`/`joints[i-1]`
      // positionally (mesh, side guards, colliders, bend breakpoints) and would
      // otherwise read the wrong joint - or `undefined` - when a boundary has no
      // bend (e.g. the default {tiltDeg: 0} segment the inspector appends).
      joints.push({
        cx: cornerOutX,
        cy: cornerOutY,
        tpx: cornerOutX,
        tpy: cornerOutY,
        turning: 0,
        radius: r,
        inset: 0,
        arcLength: 0,
        sStart: s,
        angleIn: angle,
      })
    }

    cornerX = cornerOutX
    cornerY = cornerOutY
  }

  // tail-origin: the path is built with segment 0 starting at local x = 0, so no
  // recentering - only measure the X/Y bounds for the footprint + collision callers.
  const corners = segmentCorners(segments)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of corners) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const pulleyArc = Math.PI * (r / 2)
  return {
    segments: segments.map((sp) => ({ ...sp })),
    height: r,
    runs,
    joints,
    topLength: s,
    loopLength: 2 * s + 2 * pulleyArc,
    bounds: { minX, maxX, minY, maxY },
  }
}

/** Build the path straight from belt params (segments + height). */
export function beltPathFromParams(p: BeltPathParams): BeltPath {
  const segs = p.segments.length > 0 ? p.segments : defaultBeltSegments()
  return buildBeltPath(segs, p.height)
}

/** Sample the top surface at arc-length `sIn`, returning point + tangent angle. */
export function sampleBeltPath(path: BeltPath, sIn: number): BeltPose {
  if (path.runs.length === 0) return { x: 0, y: 0, angle: 0 }
  const s = Math.max(0, Math.min(sIn, path.topLength))
  for (let i = 0; i < path.runs.length; i++) {
    const run = path.runs[i]!
    const runLen = Math.max(0, run.effLength)
    const runEnd = run.sStart + runLen
    if (s <= runEnd + 1e-9) {
      const along = s - run.sStart
      return { x: run.x + Math.cos(run.angle) * along, y: run.y + Math.sin(run.angle) * along, angle: run.angle }
    }
    const jt = path.joints[i]
    if (jt) {
      const arcEnd = jt.sStart + jt.arcLength
      if (s <= arcEnd + 1e-9) {
        const sign = Math.sign(jt.turning)
        const theta = ((s - jt.sStart) / Math.max(jt.radius, 1e-9)) * sign
        const cos = Math.cos(theta)
        const sin = Math.sin(theta)
        const dx = jt.tpx - jt.cx
        const dy = jt.tpy - jt.cy
        return {
          x: jt.cx + dx * cos - dy * sin,
          y: jt.cy + dx * sin + dy * cos,
          angle: jt.angleIn + theta,
        }
      }
    }
  }
  const last = path.runs[path.runs.length - 1]!
  const along = Math.max(0, last.effLength)
  return { x: last.x + Math.cos(last.angle) * along, y: last.y + Math.sin(last.angle) * along, angle: last.angle }
}

export function beltStartPose(path: BeltPath): BeltPose {
  return sampleBeltPath(path, 0)
}

export function beltEndPose(path: BeltPath): BeltPose {
  return sampleBeltPath(path, path.topLength)
}

/** Map a part-local X to top-surface arc-length s. Monotonic, because beltSegmentAngles keeps every tangent within ±89 deg. */
export function beltXToS(path: BeltPath, xLocal: number): number {
  const start = beltStartPose(path)
  const end = beltEndPose(path)
  if (xLocal <= start.x) return 0
  if (xLocal >= end.x) return path.topLength
  // walk runs/joints by their plan-X span, interpolating within the matching element
  const elems: { sStart: number; sEnd: number; xStart: number; xEnd: number }[] = []
  for (let i = 0; i < path.runs.length; i++) {
    const run = path.runs[i]!
    const len = Math.max(0, run.effLength)
    elems.push({
      sStart: run.sStart,
      sEnd: run.sStart + len,
      xStart: run.x,
      xEnd: run.x + Math.cos(run.angle) * len,
    })
    const jt = path.joints[i]
    if (jt) {
      const a = sampleBeltPath(path, jt.sStart)
      const b = sampleBeltPath(path, jt.sStart + jt.arcLength)
      elems.push({ sStart: jt.sStart, sEnd: jt.sStart + jt.arcLength, xStart: a.x, xEnd: b.x })
    }
  }
  for (const e of elems) {
    const lo = Math.min(e.xStart, e.xEnd)
    const hi = Math.max(e.xStart, e.xEnd)
    if (xLocal >= lo - 1e-9 && xLocal <= hi + 1e-9) {
      const span = e.xEnd - e.xStart
      const t = Math.abs(span) < 1e-9 ? 0 : (xLocal - e.xStart) / span
      return e.sStart + (e.sEnd - e.sStart) * Math.max(0, Math.min(1, t))
    }
  }
  return path.topLength
}

/**
 * beltXToS, but extrapolating past the ends along the end tangents (negative s
 * before the tail, > topLength past the head) - the inverse of sampleBeltPathExt.
 * Side-guard openings can reach the pulley-wrap stubs the guard mesh adds beyond
 * the belt ends, so the gizmo + guard builders map through this, not the clamping
 * beltXToS.
 */
export function beltXToSExt(path: BeltPath, xLocal: number): number {
  const start = beltStartPose(path)
  const end = beltEndPose(path)
  if (xLocal < start.x) {
    const c = Math.cos(start.angle)
    return Math.abs(c) > 1e-6 ? (xLocal - start.x) / c : 0
  }
  if (xLocal > end.x) {
    const c = Math.cos(end.angle)
    return path.topLength + (Math.abs(c) > 1e-6 ? (xLocal - end.x) / c : 0)
  }
  return beltXToS(path, xLocal)
}

// --- collision descriptors ----

export interface BeltBoxDescriptor {
  /** straight run box: local centre (x,y), tilt angle (rad), full size (len,height,width) */
  kind: 'box'
  cx: number
  cy: number
  angle: number
  length: number
  height: number
  /** signed surface velocity unit tangent (x,y) at this body */
  tanX: number
  tanY: number
}

export interface BeltHullDescriptor {
  /** bend prism: convex hull points in part-local X-Y (z added at ±width/2 by the consumer) */
  kind: 'hull'
  points: { x: number; y: number }[]
  /** surface velocity unit tangent (x,y) at the prism mid */
  tanX: number
  tanY: number
}

export type BeltCollider = BeltBoxDescriptor | BeltHullDescriptor

/**
 * Collision layout: one box per straight run (end runs extended by the pulley
 * radius for the wrap-around), and BEND_SUBDIVISIONS convex prisms per bend.
 */
export function beltColliders(path: BeltPath, minLength: number): BeltCollider[] {
  const out: BeltCollider[] = []
  if (path.runs.length === 0 || path.height <= 0) return out
  const height = path.height
  const pulley = height * 0.5
  const last = path.runs.length - 1
  for (let i = 0; i < path.runs.length; i++) {
    const run = path.runs[i]!
    const runLen = run.effLength
    if (runLen <= minLength) continue
    const extBack = i === 0 ? pulley : 0
    const extFront = i === last ? pulley : 0
    const boxLen = runLen + extBack + extFront
    const ca = Math.cos(run.angle)
    const sa = Math.sin(run.angle)
    // centre of the box: along tangent by boxLen/2 - extBack, down the normal by height/2
    const alongMid = boxLen * 0.5 - extBack
    const nX = -sa
    const nY = ca
    out.push({
      kind: 'box',
      cx: run.x + ca * alongMid + nX * (-height * 0.5),
      cy: run.y + sa * alongMid + nY * (-height * 0.5),
      angle: run.angle,
      length: boxLen,
      height,
      tanX: ca,
      tanY: sa,
    })
  }
  for (const jt of path.joints) {
    if (jt.radius <= 0 || Math.abs(jt.turning) <= 1e-4) continue
    const sign = Math.sign(jt.turning)
    const dx0 = jt.tpx - jt.cx
    const dy0 = jt.tpy - jt.cy
    const subAngle = jt.turning / BELT_BEND_SUBDIVISIONS
    const sagitta = jt.radius * (1 - Math.cos(subAngle * 0.5))
    // a convex bend (nose-over, sign < 0) has its centre below the surface. The underside offset stops at the centre:
    // when a short segment tightened the bend below the belt height, offsetting the full height would cross past it
    const depth = sign < 0 ? Math.min(height, jt.radius) : height
    const arcPoint = (ang: number): { x: number; y: number; nX: number; nY: number } => {
      const c = Math.cos(ang)
      const sn = Math.sin(ang)
      const px = jt.cx + dx0 * c - dy0 * sn
      const py = jt.cy + dx0 * sn + dy0 * c
      const nX = (sign * (jt.cx - px)) / Math.max(jt.radius, 1e-9)
      const nY = (sign * (jt.cy - py)) / Math.max(jt.radius, 1e-9)
      return { x: px, y: py, nX, nY }
    }
    for (let k = 0; k < BELT_BEND_SUBDIVISIONS; k++) {
      const angBack = (k / BELT_BEND_SUBDIVISIONS) * jt.turning
      const angFront = ((k + 1) / BELT_BEND_SUBDIVISIONS) * jt.turning
      const angMid = (angBack + angFront) * 0.5
      const mid = arcPoint(angMid)
      const sagX = sign * mid.nX * sagitta
      const sagY = sign * mid.nY * sagitta
      const points: { x: number; y: number }[] = []
      for (const ang of [angBack, angFront]) {
        const p = arcPoint(ang)
        points.push({ x: p.x - sagX, y: p.y - sagY })
        points.push({ x: p.x - p.nX * depth - sagX, y: p.y - p.nY * depth - sagY })
      }
      const tanX = Math.cos(jt.angleIn + angMid)
      const tanY = Math.sin(jt.angleIn + angMid)
      out.push({ kind: 'hull', points, tanX, tanY })
    }
  }
  return out
}

// --- side-guard chords (shared by renderer + physics) ----------------------

export interface BeltGuardChord {
  /** chord midpoint on the surface centreline, part-local X-Y */
  midX: number
  midY: number
  /** chord length, m */
  len: number
  /** chord angle (rad) about local Z */
  angle: number
}

type SRange = [number, number]

/** solid spans of [s0, s1] with `openings` (already in s) removed */
function keptSpans(s0: number, s1: number, openings: readonly SRange[]): SRange[] {
  if (s1 - s0 <= 1e-4) return []
  const clamped: SRange[] = []
  for (const [a, b] of openings) {
    const lo = Math.max(a, s0)
    const hi = Math.min(b, s1)
    if (hi - lo > 1e-4) clamped.push([lo, hi])
  }
  if (clamped.length === 0) return [[s0, s1]]
  clamped.sort((p, q) => p[0] - q[0])
  const merged: SRange[] = [clamped[0]!]
  for (let i = 1; i < clamped.length; i++) {
    const r = clamped[i]!
    const last = merged[merged.length - 1]!
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const out: SRange[] = []
  let cursor = s0
  for (const [lo, hi] of merged) {
    if (lo - cursor > 1e-4) out.push([cursor, lo])
    cursor = hi
  }
  if (s1 - cursor > 1e-4) out.push([cursor, s1])
  return out
}

export interface BeltChordOpts {
  /**
   * extend the first/last chord straight off the end tangents by the pulley radius
   * so frame/guards cover the end-drum region (back/front extensions)
   */
  extendEnds?: boolean
  /** sub-chords per bend so frame/guards follow the arc instead of cutting across */
  bendSubdiv?: number
  /** more openings, already in top-surface arc length (the authored ones, manualGuardOpenings) */
  openingsS?: readonly SRange[]
}

/** sample the surface, extrapolating straight along the end tangents past the ends */
export function sampleBeltPathExt(path: BeltPath, s: number): BeltPose {
  if (s < 0) {
    const sp = beltStartPose(path)
    return { x: sp.x + Math.cos(sp.angle) * s, y: sp.y + Math.sin(sp.angle) * s, angle: sp.angle }
  }
  if (s > path.topLength) {
    const ep = beltEndPose(path)
    const d = s - path.topLength
    return { x: ep.x + Math.cos(ep.angle) * d, y: ep.y + Math.sin(ep.angle) * d, angle: ep.angle }
  }
  return sampleBeltPath(path, s)
}

/**
 * Side-guard / frame wall chords following the path surface, split around the
 * merge openings: `openingsX` in host-local centreline X (neighbour merges and
 * extents trims, which are measured in plan), `opts.openingsS` in arc length (the
 * authored openings, used as-is like the part's drawn guard). Each element (run or bend
 * sub-chord) is split independently so the chords abut at every kink. With
 * extendEnds the run wraps over the end pulleys are covered too. Consumers add
 * the surface-normal offset + cross-belt Z themselves.
 */
export function beltGuardChords(
  path: BeltPath,
  openingsX: readonly SRange[],
  opts: BeltChordOpts = {},
): BeltGuardChord[] {
  const bendSubdiv = Math.max(1, opts.bendSubdiv ?? 1)
  const pulley = path.height / 2
  const openingsS: SRange[] = openingsX.map(([a, b]) => {
    // extrapolating inverse so an opening can reach the pulley-wrap stubs past the ends
    const sa = beltXToSExt(path, a)
    const sb = beltXToSExt(path, b)
    return sa <= sb ? [sa, sb] : [sb, sa]
  })
  if (opts.openingsS) openingsS.push(...opts.openingsS)
  const elements: SRange[] = []
  if (opts.extendEnds && pulley > 1e-6) elements.push([-pulley, 0])
  for (let i = 0; i < path.runs.length; i++) {
    const run = path.runs[i]!
    elements.push([run.sStart, run.sStart + Math.max(0, run.effLength)])
    const jt = path.joints[i]
    if (jt) {
      const a = jt.sStart
      const b = jt.sStart + jt.arcLength
      for (let k = 0; k < bendSubdiv; k++) {
        elements.push([a + ((b - a) * k) / bendSubdiv, a + ((b - a) * (k + 1)) / bendSubdiv])
      }
    }
  }
  if (opts.extendEnds && pulley > 1e-6) elements.push([path.topLength, path.topLength + pulley])
  const out: BeltGuardChord[] = []
  for (const [e0, e1] of elements) {
    for (const [sa, sb] of keptSpans(e0, e1, openingsS)) {
      const pa = sampleBeltPathExt(path, sa)
      const pb = sampleBeltPathExt(path, sb)
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const len = Math.hypot(dx, dy)
      if (len <= 1e-4) continue
      out.push({ midX: (pa.x + pb.x) / 2, midY: (pa.y + pb.y) / 2, len, angle: Math.atan2(dy, dx) })
    }
  }
  return out
}

/** two chord angles within this are the same straight line (~0.06 deg) */
const CHORD_ANGLE_TOL = 1e-3
/** chord endpoints this close are the same point */
const CHORD_JOIN_TOL = 1e-4

/**
 * Collapse consecutive collinear, touching guard chords into one longer chord.
 *
 * This is for collision, not looks. Each chord becomes its own convex body, and Jolt's enhanced internal edge
 * removal does not span separate bodies. Cargo sliding along the wall hits the next chord's leading edge and is
 * kicked ~35 mm off the guard (the same failure guardRuns.ts fixes across parts). A flat belt's run and its two
 * pulley-wrap stubs are all collinear, so an unmerged straight belt does this at both of its own run/stub
 * boundaries, on every belt, butted or not. Bend chords change angle, are not collinear, and are left alone;
 * they still need the compound path to ride smoothly.
 *
 * Chords arrive in path order (beltGuardChords walks elements start-to-end), so a single forward pass joins
 * every collinear neighbour; an opening between two chords leaves a real gap, which the endpoint test rejects.
 */
export function mergeCollinearChords(chords: readonly BeltGuardChord[]): BeltGuardChord[] {
  if (chords.length < 2) return chords.map((c) => ({ ...c }))
  const endpoints = (c: BeltGuardChord): { ax: number; ay: number; bx: number; by: number } => {
    const hx = (Math.cos(c.angle) * c.len) / 2
    const hy = (Math.sin(c.angle) * c.len) / 2
    return { ax: c.midX - hx, ay: c.midY - hy, bx: c.midX + hx, by: c.midY + hy }
  }
  const out: BeltGuardChord[] = [{ ...chords[0]! }]
  for (let i = 1; i < chords.length; i++) {
    const c = chords[i]!
    const last = out[out.length - 1]!
    const da = Math.abs(Math.atan2(Math.sin(c.angle - last.angle), Math.cos(c.angle - last.angle)))
    const le = endpoints(last)
    const ce = endpoints(c)
    if (da <= CHORD_ANGLE_TOL && Math.hypot(ce.ax - le.bx, ce.ay - le.by) <= CHORD_JOIN_TOL) {
      // join: one chord from `last`'s start to `c`'s end, keeping the shared angle
      out[out.length - 1] = { midX: (le.ax + ce.bx) / 2, midY: (le.ay + ce.by) / 2, len: last.len + c.len, angle: last.angle }
    } else out.push({ ...c })
  }
  return out
}

/**
 * Split authored side-guard openings (arc ranges from the tail) per side. They stay in arc length: an opening on a
 * steep run or past a bend is exactly where the author put it, and where the part's geometry() cuts its guard.
 */
export function manualGuardOpenings(specs: readonly BeltGuardOpeningSpec[]): { left: SRange[]; right: SRange[] } {
  const left: SRange[] = []
  const right: SRange[] = []
  for (const o of specs) {
    if (o.arcEnd <= o.arcStart) continue
    const r: SRange = [o.arcStart, o.arcEnd]
    if (o.side === 'left' || o.side === 'both') left.push(r)
    if (o.side === 'right' || o.side === 'both') right.push(r)
  }
  return { left, right }
}

// --- shape presets (segment templates) -------------------------

const PRESET_INCLINE_DEG = 12
const PRESET_WALK_THRU_DEG = 25
const PRESET_NOSE_OVER_DEG = 8
const PRESET_FLAT_LEN = 2
const PRESET_RAMP_LEN = 3

const PRESET_TEMPLATES: Record<Exclude<BeltShapePreset, 'custom'>, BeltSegmentSpec[]> = {
  straight: [{ length: BELT_DEFAULT_SEGMENT_LENGTH, tiltDeg: 0 }],
  zframe: [
    { length: PRESET_FLAT_LEN, tiltDeg: 0 },
    { length: PRESET_RAMP_LEN, tiltDeg: PRESET_INCLINE_DEG },
    { length: PRESET_FLAT_LEN, tiltDeg: -PRESET_INCLINE_DEG },
  ],
  walkthru: [
    { length: PRESET_FLAT_LEN, tiltDeg: 0 },
    { length: PRESET_RAMP_LEN, tiltDeg: PRESET_WALK_THRU_DEG },
    { length: PRESET_FLAT_LEN, tiltDeg: -PRESET_WALK_THRU_DEG },
    { length: PRESET_RAMP_LEN, tiltDeg: -PRESET_WALK_THRU_DEG },
    { length: PRESET_FLAT_LEN, tiltDeg: PRESET_WALK_THRU_DEG },
  ],
  noseover: [
    { length: PRESET_FLAT_LEN, tiltDeg: 0 },
    { length: PRESET_RAMP_LEN, tiltDeg: -PRESET_NOSE_OVER_DEG },
  ],
}

export function defaultBeltSegments(): BeltSegmentSpec[] {
  return PRESET_TEMPLATES.straight.map((s) => ({ ...s }))
}

export function beltPresetSegments(preset: BeltShapePreset): BeltSegmentSpec[] | null {
  if (preset === 'custom') return null
  return PRESET_TEMPLATES[preset].map((s) => ({ ...s }))
}

/** segments equal a preset template (so a freshly-stamped belt keeps its preset label) */
export function beltMatchesPreset(segments: readonly BeltSegmentSpec[], preset: BeltShapePreset): boolean {
  if (preset === 'custom') return true
  const tpl = PRESET_TEMPLATES[preset]
  if (tpl.length !== segments.length) return false
  return tpl.every(
    (t, i) =>
      Math.abs(t.length - segments[i]!.length) < 1e-6 && Math.abs(t.tiltDeg - segments[i]!.tiltDeg) < 1e-6,
  )
}
