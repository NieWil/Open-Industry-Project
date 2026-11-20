import type { BeltGuardOpeningSpec, PartInstance } from '../types'
import { FRAME_WALL_THICKNESS, GUARD_COLLISION_THICKNESS, GUARD_HEIGHT, GUARD_THICKNESS } from '../types'
import type { PartPackage } from '../parts/partPackage'
import { bedView } from '../parts/partGeometry'
import { beltGuardChords, buildBeltPath, manualGuardOpenings, mergeCollinearChords } from '../conveyor/beltPath'
import { rotateXZ } from '../transforms'
import type { GuardExtents } from './guardExtents'
import type { GuardOpenings, Range } from './guardOpenings'

/**
 * The single description of where a belt-like part's side-guard collision boxes go.
 *
 * Shared by the sim's guard builder (world.ts addCustomBeltGuards) and the cross-part merge resolver
 * (guardRuns.ts). They must agree exactly: the resolver decides which walls collapse into one body, and the
 * builder emits that decision. So both read the same walls in the same order from this function rather than
 * each deriving them. A second copy of the opening/extent fold would let the builder and resolver drift apart.
 */

/** Quaternion for a belt run/guard: yaw about world +Y, then tilt about the body's local +Z (cross-belt). */
export function yawTiltQuat(rotationY: number, angle: number): [number, number, number, number] {
  const sa = Math.sin(rotationY / 2)
  const ca = Math.cos(rotationY / 2)
  const sb = Math.sin(angle / 2)
  const cb = Math.cos(angle / 2)
  return [sa * sb, sa * cb, ca * sb, ca * cb]
}

/** A function-belt's `guardOpenings` numberList ([start m, end m, side ±1/0] rows) → guard-opening specs. */
export function parseGuardOpenings(v: unknown): BeltGuardOpeningSpec[] {
  if (!Array.isArray(v)) return []
  const out: BeltGuardOpeningSpec[] = []
  for (const row of v) {
    if (!Array.isArray(row) || row.length < 2) continue
    const a = Number(row[0]), b = Number(row[1]), sd = Number(row[2] ?? 0)
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue
    out.push({ arcStart: a, arcEnd: b, side: sd < 0 ? 'left' : sd > 0 ? 'right' : 'both' })
  }
  return out
}

export interface GuardWall {
  /** stable identity for the merge override - index is stable because both callers use this enumeration */
  key: string
  side: -1 | 1
  /** world centre of the wall box */
  pos: [number, number, number]
  /** world orientation (yaw composed with the chord's incline tilt) */
  quat: [number, number, number, number]
  /** half length along the wall's own local +X - the axis a merged span is measured in */
  halfLen: number
  hy: number
  hz: number
}

/**
 * Every side-guard collision box a belt-like part contributes, in world space, with neighbour openings and
 * snap extents already folded in. Empty for a non-belt part or one with both guards switched off.
 */
export function beltGuardWalls(
  part: PartInstance,
  pkg: PartPackage,
  neighbor?: GuardOpenings,
  extents?: GuardExtents,
): GuardWall[] {
  const view = bedView(part, 'path')
  if (!view) return []
  if (!view.leftGuard && !view.rightGuard) return []
  const own = (part.params as Record<string, unknown>).guardOpenings
  const authored = own !== undefined ? own : pkg.params.guardOpenings?.default
  // the part's own snap extents (a flush side-merge retracting this belt's steel to the host's outer wall
  // plane) become synthetic end-trim ranges, so the guard collider retracts exactly like the rendered guard.
  const BIG = 1e3
  const trims: GuardOpenings = { left: [...(neighbor?.left ?? [])], right: [...(neighbor?.right ?? [])] }
  if (extents?.leftBack !== undefined) trims.left.push([-BIG, extents.leftBack])
  if (extents?.leftFront !== undefined) trims.left.push([extents.leftFront, BIG])
  if (extents?.rightBack !== undefined) trims.right.push([-BIG, extents.rightBack])
  if (extents?.rightFront !== undefined) trims.right.push([extents.rightFront, BIG])

  const path = buildBeltPath(view.segments, view.height)
  const py = part.position[1]
  const gh = GUARD_HEIGHT
  // the sheet-metal profile every guard family shares (guardRunMerge.test.ts pins it): a GUARD_HEIGHT rail
  // whose collider spans half a sheet past each edge, so its centre sits GUARD_THICKNESS/2 below the top.
  // Named constants, not literals: a heterogeneous butt only merges while all four families agree here.
  const hy = (gh + GUARD_THICKNESS) / 2
  const guardN = (gh - GUARD_THICKNESS) / 2
  const gz = view.width / 2 + FRAME_WALL_THICKNESS + GUARD_COLLISION_THICKNESS / 2
  const manual = manualGuardOpenings(parseGuardOpenings(authored))
  const out: GuardWall[] = []
  for (const side of [-1, 1] as const) {
    if (!(side === -1 ? view.leftGuard : view.rightGuard)) continue
    // the trims are plan X; the authored openings stay arc length
    const ranges: Range[] = side === -1 ? trims.left : trims.right
    const openingsS = side === -1 ? manual.left : manual.right
    // collinear chords collapse first (a flat belt's run + its two pulley-wrap stubs are one straight line).
    // One body per chord would ram cargo riding the wall at every chord boundary.
    const chords = mergeCollinearChords(beltGuardChords(path, ranges, { extendEnds: true, bendSubdiv: 4, openingsS }))
    let i = 0
    for (const chord of chords) {
      if (chord.len <= 1e-3) continue
      const nx = -Math.sin(chord.angle)
      const ny = Math.cos(chord.angle)
      const r = rotateXZ(chord.midX + nx * guardN, side * gz, part.rotationY)
      out.push({
        key: `belt:${side}:${i++}`,
        side,
        pos: [part.position[0] + r.x, py + chord.midY + ny * guardN, part.position[2] + r.z],
        quat: yawTiltQuat(part.rotationY, chord.angle),
        halfLen: chord.len / 2,
        hy,
        hz: GUARD_COLLISION_THICKNESS / 2,
      })
    }
  }
  return out
}
