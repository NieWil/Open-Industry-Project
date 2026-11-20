import { collisionProxy, conveyorDeckSubs, shapeCornersLocal } from '../geometry/collisionShapes'
import { flexPathOf, partFootprint, toLocalXZ, toWorldXZ } from '../parts/partGeometry'
import { rotateXZ } from '../transforms'
import { BUILDING_SECTION_SIZE } from '../types'
import type { BuildingPart, BuildingWallRule, PartInstance } from '../types'

/**
 * Where a building's loading-dock openings are, for the layers that are not the renderer.
 *
 * The walls are laid out in corner-anchored 10 m cells around the perimeter, in order (front -Z, back +Z,
 * left -X, right +X), and a wall rule painted by perimeter index decides each cell's module; a `dock_door` rule cuts
 * a loading-dock bay into a ground-floor cell with one or two door openings. The renderer builds the bays
 * (render/parts/building.ts, dockDoor.ts); the sim needs to know where they are too, because its walls are solid
 * boxes and an open door has to let a load through it (a trailer unloaded onto a conveyor that runs out of it).
 * Both read this module, so the collider opening and the drawn one cannot drift apart.
 */

const posmod = (n: number, m: number): number => ((n % m) + m) % m

/** wall-rule matching: does this rule paint the perimeter cell `idx`? */
export function wallRuleMatches(rule: BuildingWallRule, idx: number, perimeter: number): boolean {
  if (rule.run <= 0 || perimeter <= 0) return false
  const rel = posmod(idx - rule.start, perimeter)
  if (rule.count > 0 && rel >= rule.count * rule.run + (rule.count - 1) * rule.gap) return false
  return posmod(rel, rule.run + rule.gap) < rule.run
}

/** the last rule that paints this perimeter cell (later rules win), or null = default Wall_D */
export function wallRuleAt(rules: readonly BuildingWallRule[], idx: number, perimeter: number): BuildingWallRule | null {
  let matched: BuildingWallRule | null = null
  for (const rule of rules) if (wallRuleMatches(rule, idx, perimeter)) matched = rule
  return matched
}

/** a perimeter wall cell: its corner (building-local) and the yaw its 10 m run leaves that corner along */
export interface WallCell {
  idx: number
  x: number
  z: number
  yaw: number
}

/** every perimeter cell of an L x W (sections) footprint, in perimeter order */
export function perimeterCells(L: number, W: number): WallCell[] {
  const S = BUILDING_SECTION_SIZE
  const x0 = (-L * S) / 2
  const z0 = (-W * S) / 2
  const x1 = x0 + L * S
  const z1 = z0 + W * S
  const cells: WallCell[] = []
  for (let i = 0; i < L; i++) cells.push({ idx: i, x: x0 + i * S, z: z0, yaw: 0 })
  for (let i = 0; i < L; i++) cells.push({ idx: L + i, x: x0 + (i + 1) * S, z: z1, yaw: Math.PI })
  for (let j = 0; j < W; j++) cells.push({ idx: 2 * L + j, x: x0, z: z0 + (j + 1) * S, yaw: Math.PI / 2 })
  for (let j = 0; j < W; j++) cells.push({ idx: 2 * L + W + j, x: x1, z: z0 + j * S, yaw: -Math.PI / 2 })
  return cells
}

/** opening centres along a dock cell's run, m from its corner */
export const DOCK_OPENINGS_1 = [5.0] as const
export const DOCK_OPENINGS_2 = [2.75, 7.25] as const
/** half the clear width a dock opening leaves in the wall: the door is ~3 m, and two sit 4.5 m apart */
export const DOCK_OPENING_HALF_WIDTH = 1.5

export interface DockOpening {
  /** the leaf key `openDoors` names: `<perimeter cell>:<opening>` */
  key: string
  /** the opening's centre on the wall line, building-local */
  x: number
  z: number
  /** the yaw of the wall run it is cut in (0 = along local +x) */
  yaw: number
}

/** every dock-door opening of the building (ground floor), open or shut, building-local */
export function dockOpenings(part: BuildingPart): DockOpening[] {
  const L = part.params.lengthSections
  const W = part.params.widthSections
  const rules = part.params.rules ?? []
  const perimeter = 2 * L + 2 * W
  const out: DockOpening[] = []
  for (const cell of perimeterCells(L, W)) {
    const rule = wallRuleAt(rules, cell.idx, perimeter)
    if (rule?.wall !== 'dock_door') continue
    const centres = rule.doorCount === 2 ? DOCK_OPENINGS_2 : DOCK_OPENINGS_1
    centres.forEach((c, leaf) => {
      const r = rotateXZ(c, 0, cell.yaw)
      out.push({ key: `${cell.idx}:${leaf}`, x: cell.x + r.x, z: cell.z + r.z, yaw: cell.yaw })
    })
  }
  return out
}

/** a personnel door's centre along its cell's run, m from its corner; mirrors AT in scripts/build-personnel-door.mjs */
export const PERSONNEL_DOOR_AT = 5.0
/** half the width of the door and its frame along the wall (a 0.9 m leaf in a 0.05 m frame) */
export const PERSONNEL_DOOR_HALF_WIDTH = 0.5

/** every personnel door of the building (ground floor), building-local: its centre on the wall line and its run's yaw */
export function personnelDoors(part: BuildingPart): { idx: number; x: number; z: number; yaw: number }[] {
  const L = part.params.lengthSections
  const W = part.params.widthSections
  const rules = part.params.rules ?? []
  const perimeter = 2 * L + 2 * W
  const out: { idx: number; x: number; z: number; yaw: number }[] = []
  for (const cell of perimeterCells(L, W)) {
    if (wallRuleAt(rules, cell.idx, perimeter)?.wall !== 'personnel_door') continue
    const r = rotateXZ(PERSONNEL_DOOR_AT, 0, cell.yaw)
    out.push({ idx: cell.idx, x: cell.x + r.x, z: cell.z + r.z, yaw: cell.yaw })
  }
  return out
}

/** the dock openings whose doors stand open (the building's `openDoors`) */
export function openDockOpenings(part: BuildingPart): DockOpening[] {
  const open = new Set((part.params as { openDoors?: readonly string[] }).openDoors ?? [])
  return open.size === 0 ? [] : dockOpenings(part).filter((o) => open.has(o.key))
}

/** how high a dock door's leaf closes down from: its open rise (render/parts/dockDoor.ts DOOR_TRAVEL) */
export const DOCK_OPENING_HEIGHT = 3.1
/** how far either side of the wall line the closing leaf sweeps: the wall's thickness plus the door's track */
const DOCK_DOOR_SWEEP = 0.5

/** the 2-D convex hull of some points (monotone chain), counter-clockwise */
function hull2(pts: { x: number; z: number }[]): { x: number; z: number }[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z)
  if (p.length < 3) return p
  const cross = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }): number =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)
  const lower: { x: number; z: number }[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: { x: number; z: number }[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** does a convex polygon overlap the axis-aligned box |x| <= hx, |z| <= hz? (separating axes) */
function polyHitsBox(poly: { x: number; z: number }[], hx: number, hz: number): boolean {
  if (poly.length === 0) return false
  const axes: { x: number; z: number }[] = [{ x: 1, z: 0 }, { x: 0, z: 1 }]
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    if (a.x !== b.x || a.z !== b.z) axes.push({ x: b.z - a.z, z: a.x - b.x })
  }
  for (const n of axes) {
    let lo = Infinity
    let hi = -Infinity
    for (const q of poly) {
      const d = q.x * n.x + q.z * n.z
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    const r = hx * Math.abs(n.x) + hz * Math.abs(n.z)
    if (lo >= r || hi <= -r) return false
  }
  return true
}

/** a part's solid, part-local: its plan outline and the height it spans (above the part's origin) */
interface Piece {
  pts: { x: number; z: number }[]
  y0: number
  y1: number
}

function blockingPieces(part: PartInstance): Piece[] {
  const flex = flexPathOf(part)
  if (flex && flex.points.length > 0) {
    // the bed runs from the origin through its points; each run is a strip the bed's width wide
    const half = Number((part.params as Record<string, unknown>).width) / 2 || 0.5
    const fp = partFootprint(part)
    const path: [number, number][] = [[0, 0], ...flex.points]
    const out: Piece[] = []
    for (let i = 1; i < path.length; i++) {
      const [ax, az] = path[i - 1]!
      const [bx, bz] = path[i]!
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 1e-9) continue
      const nx = (-(bz - az) / len) * half
      const nz = ((bx - ax) / len) * half
      out.push({
        pts: [{ x: ax + nx, z: az + nz }, { x: ax - nx, z: az - nz }, { x: bx - nx, z: bz - nz }, { x: bx + nx, z: bz + nz }],
        y0: fp.y0,
        y1: fp.y1,
      })
    }
    return out
  }
  const decks = conveyorDeckSubs(part)
  return (decks.length > 0 ? decks : collisionProxy(part)).map((shape) => {
    const corners = shapeCornersLocal(shape)
    return { pts: corners, y0: Math.min(...corners.map((c) => c.y)), y1: Math.max(...corners.map((c) => c.y)) }
  })
}

/**
 * The first part standing in a dock opening, where its leaf would close onto it, or null when the doorway is clear.
 * A flex conveyor is judged by its path (its footprint is the package's fixed box, which does not follow the points), a
 * conveyor by its deck solids, anything else by its footprint. `parts` is the scene as the character sees it - pass
 * the walk-session overlays in.
 */
export function dockOpeningBlocker(building: BuildingPart, leafKey: string, parts: readonly PartInstance[]): PartInstance | null {
  const opening = dockOpenings(building).find((o) => o.key === leafKey)
  if (!opening) return null
  const y0 = building.position[1]
  const y1 = y0 + DOCK_OPENING_HEIGHT
  for (const part of parts) {
    if (part.id === building.id || part.type === 'building' || part.type === 'group' || part.type === 'annotation') continue
    for (const piece of blockingPieces(part)) {
      const lo = part.position[1] + piece.y0
      const hi = part.position[1] + piece.y1
      if (hi <= y0 || lo >= y1) continue
      // into the opening's own frame: x along the wall, z across it
      const pts = piece.pts.map((c) => {
        const w = toWorldXZ(part, c.x, c.z)
        const b = toLocalXZ(building, w.x, w.z)
        return rotateXZ(b.x - opening.x, b.z - opening.z, -opening.yaw)
      })
      if (polyHitsBox(hull2(pts), DOCK_OPENING_HALF_WIDTH, DOCK_DOOR_SWEEP)) return part
    }
  }
  return null
}
