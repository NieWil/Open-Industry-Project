// A cargo part's own body (docs/cargo-bodies.md): a rig that moves as one rigid body. Its collider is the rig's link
// shapes at rest pose, a box per box link and a true cylinder per cylinder link (a rolling drum), and its visual is
// the part's own rig. The sim builds one compound shape per (package, params) from these pieces; the renderer draws
// one instanced batch per the same key.
//
// Unlike a machine's rig, where a cylinder link collides as its bounding box (rigPose.ts shapeHalfExtents), cargo
// keeps the cylinder round: whether a drum rolls is the point of declaring it.

import { linkHalfExtents, qApply, resolvedCylinder, rigWorldPoses } from './rig/rigPose'
import type { Quat, RigParams, Vec3 } from './rig/rigPose'
import { rigLinkEmitsBody } from './rig/rigLinkBody'
import type { RigGeometry } from './parts/partPackage'

/** One sub-shape of a cargo body, part-local at rest pose. */
export type CargoPiece =
  | { shape: 'box'; half: Vec3; pos: Vec3; quat: Quat }
  /** round about its own local +Y (a rig cylinder's axis), `halfHeight` along it */
  | { shape: 'cylinder'; radius: number; halfHeight: number; pos: Vec3; quat: Quat }

/** The colliding pieces of a cargo rig at `params` (raw instance params; `resolved` adds the schema defaults). */
export function cargoPieces(geo: RigGeometry, params: RigParams, resolved: Record<string, unknown> = params): CargoPiece[] {
  const byName = new Map(geo.links.map((l) => [l.name, l]))
  const out: CargoPiece[] = []
  for (const [name, lp] of rigWorldPoses(geo, {}, undefined, 1, params)) {
    const link = byName.get(name)
    if (!link || link.array || !rigLinkEmitsBody(link, resolved)) continue
    const pos: Vec3 = [lp.pos[0], lp.pos[1], lp.pos[2]]
    const quat: Quat = [lp.quat[0], lp.quat[1], lp.quat[2], lp.quat[3]]
    if (link.shape.kind === 'cylinder') {
      const c = resolvedCylinder(link.shape, params)
      out.push({ shape: 'cylinder', radius: c.radius, halfHeight: c.height / 2, pos, quat })
    } else {
      out.push({ shape: 'box', half: linkHalfExtents(link, params), pos, quat })
    }
  }
  return out
}

/** The pieces' axis-aligned bounds, part-local. Null when there are none. */
export function cargoPiecesBounds(pieces: readonly CargoPiece[]): { min: Vec3; max: Vec3 } | null {
  if (pieces.length === 0) return null
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of pieces) {
    // the piece's own box corners (a cylinder by its bounding box), rotated
    const h: Vec3 = p.shape === 'box' ? p.half : [p.radius, p.halfHeight, p.radius]
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const c = qApply(p.quat, [sx * h[0], sy * h[1], sz * h[2]])
      for (let k = 0; k < 3; k++) {
        const v = p.pos[k]! + c[k]!
        if (v < min[k]!) min[k] = v
        if (v > max[k]!) max[k] = v
      }
    }
  }
  return { min, max }
}

/** How far the bounds' centre sits from the part's origin, m: cargo is centre-origin, like a box, pallet or tote. */
export function cargoCentreOffset(bounds: { min: Vec3; max: Vec3 }): number {
  return Math.hypot((bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2)
}

/** A stable key for a cargo body's shape: the same package at the same pieces shares one collider and one batch. */
export function cargoShapeKey(packageId: string, pieces: readonly CargoPiece[]): string {
  const r = (n: number): number => Math.round(n * 1e5) / 1e5
  return `${packageId}|${pieces.map((p) => (p.shape === 'box' ? `b${p.half.map(r)}` : `c${r(p.radius)},${r(p.halfHeight)}`) + `@${p.pos.map(r)}/${p.quat.map(r)}`).join(';')}`
}
