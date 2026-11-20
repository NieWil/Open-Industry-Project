// A building's static colliders - its perimeter walls (open dock doors cut out) and the interior column grid - as
// boxes; SimWorld adds each as a static body at the building's yaw.
import { DOCK_OPENING_HALF_WIDTH, openDockOpenings } from '../core/building/buildingDocks'
import { INTERIOR_COLUMN_SIZE, interiorColumns } from '../core/building/buildingColumns'
import { toWorldXZ } from '../core/parts/partGeometry'
import { buildingEaveHeight, BUILDING_SECTION_SIZE, BUILDING_WALL_THICKNESS } from '../core/types'
import type { BuildingPart } from '../core/types'

/** a static box: half extents and its WORLD centre, yawed like the part it belongs to */
export interface YawBox {
  hx: number
  hy: number
  hz: number
  x: number
  y: number
  z: number
}

/**
 * Half the side of the square ground slab: the default ground, or wider when a building's footprint reaches past
 * it. A building draws its own floor at any size, so its floor has to hold what stands on it there too. A scene
 * whose buildings fit keeps the default slab, so its physics does not change.
 */
export function groundHalfExtent(parts: readonly { type: string; position: readonly number[]; rotationY: number; params?: unknown }[], base: number): number {
  let half = base
  for (const p of parts) {
    if (p.type !== 'building') continue
    const b = p as unknown as BuildingPart
    const hl = (b.params.lengthSections * BUILDING_SECTION_SIZE) / 2 + BUILDING_WALL_THICKNESS
    const hw = (b.params.widthSections * BUILDING_SECTION_SIZE) / 2 + BUILDING_WALL_THICKNESS
    for (const [lx, lz] of [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]] as const) {
      const c = toWorldXZ(b, lx, lz)
      half = Math.max(half, Math.abs(c.x) + 1, Math.abs(c.z) + 1)
    }
  }
  return half
}

/** a building's colliders: four static perimeter walls + the interior column grid, each yawed like the part (visibility
 *  booleans are viewing aids only) */
export function buildingBoxes(part: BuildingPart): YawBox[] {
  const out: YawBox[] = []
  const length = part.params.lengthSections * BUILDING_SECTION_SIZE
  const width = part.params.widthSections * BUILDING_SECTION_SIZE
  const height = buildingEaveHeight(part.params.heightSections)
  const py = part.position[1]
  const t = BUILDING_WALL_THICKNESS
  const walls = [
    { lx: 0, lz: -width / 2, hx: length / 2 + t / 2, hz: t / 2 },
    { lx: 0, lz: width / 2, hx: length / 2 + t / 2, hz: t / 2 },
    { lx: -length / 2, lz: 0, hx: t / 2, hz: width / 2 + t / 2 },
    { lx: length / 2, lz: 0, hx: t / 2, hz: width / 2 + t / 2 },
  ]
  // an open dock door is a hole in its wall (core/building/buildingDocks.ts): a load goes through it, as it does for the
  // walking character, whose walls are the drawn ones. A shut door stays solid wall.
  const open = openDockOpenings(part)
  for (const w of walls) {
    const alongX = w.hx > w.hz
    const lo = (alongX ? w.lx : w.lz) - (alongX ? w.hx : w.hz)
    const hi = (alongX ? w.lx : w.lz) + (alongX ? w.hx : w.hz)
    const gaps = open
      .filter((o) => Math.abs((alongX ? o.z : o.x) - (alongX ? w.lz : w.lx)) < 0.5)
      .map((o) => alongX ? o.x : o.z)
      .sort((m, n) => m - n)
    let from = lo
    for (const g of [...gaps, null]) {
      const to = g === null ? hi : g - DOCK_OPENING_HALF_WIDTH
      if (to - from > 1e-3) {
        const mid = (from + to) / 2, half = (to - from) / 2
        const c = toWorldXZ(part, alongX ? mid : w.lx, alongX ? w.lz : mid)
        out.push({ hx: alongX ? half : w.hx, hy: height / 2, hz: alongX ? w.hz : half, x: c.x, y: py + height / 2, z: c.z })
      }
      if (g !== null) from = g + DOCK_OPENING_HALF_WIDTH
    }
  }
  // the interior column grid (core/building/buildingColumns.ts): floor-to-eave solids, the same stations the view draws
  const half = INTERIOR_COLUMN_SIZE / 2
  for (const col of interiorColumns(part)) {
    const c = toWorldXZ(part, col.x, col.z)
    out.push({ hx: half, hy: height / 2, hz: half, x: c.x, y: py + height / 2, z: c.z })
  }
  return out
}
