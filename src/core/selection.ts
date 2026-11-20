import { groupRoot, partsById } from './scene/hierarchy'
import type { PartInstance } from './types'

/**
 * Selection policy: which ids a gesture's raw hits actually select. The viewport reports what it
 * caught in pixels (a click's pick, a band's rect sweep); this decides what that means against the
 * scene tree, so the rule lives in one tested place instead of inside the pointer plumbing.
 *
 * The only rule is the grouped-subtree redirect: a hit inside a grouped subtree selects the
 * group's root, so the group selects and moves as one (see {@link groupRoot}). The Scene tree
 * bypasses this - a tree row selects exactly the part it names.
 */

/**
 * The selection a rubber-band gesture lands on: each raw hit redirected to its group root, deduped,
 * in first-caught order. `current` is the selection to extend (a shift-band adds to it); omit it for
 * a plain band, which replaces the selection outright.
 *
 * Because a hit only ever arrives from a part the band actually caught, a group is selected exactly
 * when the band caught one of its members. A geometry-less container is never caught on its own -
 * see `view.partsInRect`, which skips zero-extent footprints.
 */
export function bandSelection(
  parts: readonly PartInstance[],
  hits: readonly string[],
  current: readonly string[] = [],
): string[] {
  const out = [...current]
  const seen = new Set(out)
  const byId = partsById(parts)
  for (const id of hits) {
    const root = groupRoot(parts, id, byId)
    if (seen.has(root)) continue
    seen.add(root)
    out.push(root)
  }
  return out
}

/** a point in screen (CSS-pixel) space; y-down, as the DOM reports it */
export interface ScreenPoint {
  x: number
  y: number
}

/**
 * Convex hull of 2D points (Andrew's monotone chain). Returns the boundary points; a set with
 * fewer than three distinct points is returned as-is (a degenerate hull has no edges). Winding is
 * irrelevant to the SAT test below - screen space is y-down, so this is clockwise, but a valid
 * simple convex polygon either way.
 */
function convexHull(points: readonly ScreenPoint[]): ScreenPoint[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const n = pts.length
  if (n < 3) return pts
  const cross = (o: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const build = (seq: readonly ScreenPoint[]): ScreenPoint[] => {
    const half: ScreenPoint[] = []
    for (const p of seq) {
      while (half.length >= 2 && cross(half[half.length - 2]!, half[half.length - 1]!, p) <= 0) half.pop()
      half.push(p)
    }
    half.pop() // drop the shared endpoint; the other half re-adds it
    return half
  }
  const lower = build(pts)
  const upper = build([...pts].reverse())
  return lower.concat(upper)
}

/**
 * Does the convex silhouette of `points` overlap the axis-aligned screen rect [minX,maxX]×[minY,maxY]?
 *
 * A rubber-band catches a part when the part's projected footprint overlaps the band. Intersecting
 * the screen-space bounding box of the projected corners with the band over-approximates: a part
 * sitting diagonally on screen (e.g. a long conveyor) has a bounding box whose empty corners extend
 * well past its real silhouette, so a band drawn over nearby floor falls in one of those corners and
 * wrongly selects it. This does a separating-axis test between the points' convex hull and the
 * rectangle instead. They overlap iff no axis separates them. The axes tested are the rect's own two
 * (the bounding-box check, kept as a fast reject) plus each hull-edge normal.
 */
export function silhouetteOverlapsRect(
  points: readonly ScreenPoint[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  if (points.length === 0) return false
  // rect axes (screen x, y): the points' bounding box must overlap the rect. Necessary for any
  // overlap, and a fast reject for the common case where the part is nowhere near the band.
  let loX = Infinity
  let hiX = -Infinity
  let loY = Infinity
  let hiY = -Infinity
  for (const p of points) {
    if (p.x < loX) loX = p.x
    if (p.x > hiX) hiX = p.x
    if (p.y < loY) loY = p.y
    if (p.y > hiY) hiY = p.y
  }
  if (hiX < minX || loX > maxX || hiY < minY || loY > maxY) return false

  const hull = convexHull(points)
  if (hull.length < 3) return true // a point or line: the bounding-box overlap above is decisive
  const rectCorners: ScreenPoint[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  // hull-edge axes: project the hull and the rect corners onto each edge normal; a gap on any one
  // axis proves the two shapes don't touch.
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!
    const b = hull[(i + 1) % hull.length]!
    const nx = -(b.y - a.y)
    const ny = b.x - a.x
    let pLo = Infinity
    let pHi = -Infinity
    for (const p of hull) {
      const d = p.x * nx + p.y * ny
      if (d < pLo) pLo = d
      if (d > pHi) pHi = d
    }
    let rLo = Infinity
    let rHi = -Infinity
    for (const c of rectCorners) {
      const d = c.x * nx + c.y * ny
      if (d < rLo) rLo = d
      if (d > rHi) rHi = d
    }
    if (pHi < rLo || rHi < pLo) return false // separating axis
  }
  return true
}
