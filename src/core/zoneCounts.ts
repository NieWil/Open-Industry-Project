// What a part's detection zones (rig links with a `zone`, read by ctx.zone) hold in a stopped scene: the authored
// cargo, counted by centre exactly as the sim counts live cargo (sim/cargoSensing.ts rigZones + pointInZone). The idle
// actuation preview feeds these to a behavior, so a machine whose state depends on what it holds previews truthfully:
// a pallet dispenser with pallets authored in its magazine settles holding them up on its forks, not parked under
// them with the stack drawn in mid-air.

import type { BoxFrame } from './frame'
import type { PartPackage } from './parts/partPackage'
import { qApply, qFromAxisAngle, resolvedBoxSize, rigWorldPoses } from './rig/rigPose'
import type { RigParams } from './rig/rigPose'
import type { SdkPart } from './types'

/** Cargo in each of `part`'s zones, from `cargo` (the stopped scene's buildAuthoredCargoFrame). Undefined when the part has no zones. */
export function authoredZoneCounts(part: SdkPart, pkg: PartPackage, cargo: BoxFrame): Record<string, number> | undefined {
  if (pkg.geometry.kind !== 'rig') return undefined
  const zoned = pkg.geometry.links.filter((l) => l.zone)
  if (zoned.length === 0) return undefined
  const params = part.params as RigParams
  const scale = typeof params.scale === 'number' && params.scale > 0 ? params.scale : 1
  const rest = rigWorldPoses(pkg.geometry, {}, undefined, scale, params)
  const q = qFromAxisAngle([0, 1, 0], part.rotationY)
  const cos = Math.cos(part.rotationY)
  const sin = Math.sin(part.rotationY)
  const counts: Record<string, number> = {}
  for (const link of zoned) {
    const lp = rest.get(link.name)
    if (!lp || !link.zone) continue
    const w = qApply(q, lp.pos)
    const cx = part.position[0] + w[0], cy = part.position[1] + w[1], cz = part.position[2] + w[2]
    const s = resolvedBoxSize(link.zone.size, link.zone.sizeParams, params)
    const hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2
    let n = 0
    for (let i = 0; i < cargo.count; i++) {
      const x = cargo.positions[i * 3]!, y = cargo.positions[i * 3 + 1]!, z = cargo.positions[i * 3 + 2]!
      if (y < cy - hy || y > cy + hy) continue
      const dx = x - cx, dz = z - cz
      if (Math.abs(dx * cos - dz * sin) <= hx && Math.abs(dx * sin + dz * cos) <= hz) n++
    }
    counts[link.name] = n
  }
  return counts
}
