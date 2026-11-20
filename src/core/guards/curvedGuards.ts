import type { PartInstance } from '../types'
import { ARC_END_EXT, FRAME_WALL_THICKNESS, GUARD_COLLISION_THICKNESS, GUARD_HEIGHT, GUARD_THICKNESS } from '../types'
import { bedView, curvedGizmoOf, DEG, toWorldXZ } from '../parts/partGeometry'
import { MAX_SEGMENT_DEG } from '../geometry/collisionShapes'
import type { GuardWall } from './beltGuards'

/**
 * The single enumeration of a curved conveyor's side-guard collision boxes: the arc chord walls plus the straight
 * tangent lead-in/out stubs. Shared by the sim's builder (world.ts addCustomCurvedGuards) and the cross-part
 * merge resolver (guardRuns.ts), exactly like beltGuardWalls and functionStaticWalls: the merge is keyed by
 * wall, so both sides must walk the same list in the same order.
 *
 * Only the stubs are straight, so only they can ever be collinear with a butted neighbour. The arc chords
 * turn, and `sameWall`'s parallel test rejects them without needing a special case. Without curves as a wall
 * source, a skew-driven box riding the guard off a straight into a curve is knocked 32.9 mm inward at the
 * feeder-guard/stub butt, against 0.00 mm for the same feeder with no curve attached.
 *
 * Guard face radius: placement is by face, not centre. A rail's face belongs just outside the belt edge
 * (bed edge ± FRAME_WALL_THICKNESS), where this part's own visual guard is drawn. The outer arc chords also
 * divide out chord inscription (an inscribed chord is tightest at its midpoint), while the straight stubs
 * do not, since a straight segment has none.
 */
function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
}

export function curvedGuardWalls(part: PartInstance): GuardWall[] {
  const view = bedView(part, 'arc')
  if (!view) return []
  const py = part.position[1]
  const gh = GUARD_HEIGHT
  // the shared sheet-metal profile (see beltGuards.ts) - named constants, so a curve can't drift off the
  // cross-section a butted straight has to match
  const hy = (gh + GUARD_THICKNESS) / 2
  const cy = py + (gh - GUARD_THICKNESS) / 2
  const hz = GUARD_COLLISION_THICKNESS / 2
  const sweep = view.sweepDeg * DEG
  const segs = Math.max(1, Math.ceil(view.sweepDeg / MAX_SEGMENT_DEG))
  const dt = sweep / segs
  const T = hz
  const innerFace = view.innerRadius - FRAME_WALL_THICKNESS
  const outerFace = view.innerRadius + view.width + FRAME_WALL_THICKNESS
  // the stubs reach the snap end and no further: a curved belt's half-pulley (ARC_END_EXT), a curved roller's
  // near-flush endGap. A stub past the snap end lies on the butted neighbour's own guard, where it would put a
  // wall back over that neighbour's openings or switched-off side (curves never read a neighbour's openings).
  const stub = curvedGizmoOf(part)?.endExt ?? ARC_END_EXT
  // [enabled, chord placement radius, straight-stub placement radius, side tag]
  const rails: [boolean, number, number, -1 | 1][] = [
    [view.innerGuard, innerFace - T, innerFace - T, -1],
    [view.outerGuard, (outerFace + T) / Math.cos(dt / 2), outerFace + T, 1],
  ]
  const out: GuardWall[] = []
  for (const [on, gr, stubR, side] of rails) {
    if (!on || gr <= 0) continue
    let i = 0
    const push = (x: number, z: number, yaw: number, halfLen: number): void => {
      out.push({ key: `curve:${side}:${i++}`, side, pos: [x, cy, z], quat: yawQuat(yaw), halfLen, hy, hz })
    }
    const chord = 2 * gr * Math.sin(dt / 2)
    for (let s = 0; s < segs; s++) {
      const t0 = s * dt, t1 = (s + 1) * dt
      // chord midpoint (SDK convention P(t) = (r·cos t, −r·sin t)), yawed to the tangent at the mid-angle
      const mid = toWorldXZ(part, (gr * Math.cos(t0) + gr * Math.cos(t1)) / 2, (-gr * Math.sin(t0) - gr * Math.sin(t1)) / 2)
      push(mid.x, mid.z, part.rotationY + (s + 0.5) * dt + Math.PI / 2, chord / 2 + 0.005)
    }
    if (stub > 0) {
      // back stub: guard point (stubR, 0); the flow-in tangent is −Z, so the stub extends upstream (+Z)
      const back = toWorldXZ(part, stubR, stub / 2)
      push(back.x, back.z, part.rotationY + Math.PI / 2, stub / 2)
      // front stub: at the exit point P(sweep), extended downstream along the flow-out tangent (−sin, −cos)
      const tox = -Math.sin(sweep), toz = -Math.cos(sweep)
      const front = toWorldXZ(part, stubR * Math.cos(sweep) + tox * (stub / 2), -stubR * Math.sin(sweep) + toz * (stub / 2))
      push(front.x, front.z, part.rotationY + sweep + Math.PI / 2, stub / 2)
    }
  }
  return out
}
