/**
 * The flex conveyor's shape: a bed of `n` equal sections hinged end to end, laid along a smooth path.
 *
 * The path starts at the part origin heading local +X (the infeed) and runs through the control points the part's
 * `points` param holds ([x, z] rows, part-local, the last one the discharge end): a Catmull-Rom curve, its start
 * tangent pinned to +X. The sections are then fitted along it with equal chords, found by bisection, so the last
 * hinge is exactly on the last control point and the section pitch (the accordion) is one number: chord = pitch.
 *
 * Shared by the editor's point handles (which must write the bed length that puts the end under the dot) and
 * mirrored, line for line, in the part's own behavior (examples/parts/flex-conveyor, which cannot import core):
 * flexPath.test.ts runs the part and checks the two agree.
 */

export interface FlexStations {
  /** the n+1 hinge points, part-local [x, z], from the infeed (0, 0) to the discharge end */
  stations: [number, number][]
  /** each section's heading, radians, positive toward -Z (the SDK yaw convention) */
  headings: number[]
  /** the equal chord every section spans: the bed length is n x this */
  pitch: number
  /** the sharpest hinge the fit needs, radians (magnitude): a real section only angles so far, so a shape past a
   *  part's limit is one it cannot take */
  maxHinge: number
}

const SAMPLES = 24 // polyline samples per curve span: fine enough that a chord never sees the facets

/** the path as a dense polyline: origin, then a Catmull-Rom curve through the control points */
export function flexPolyline(points: readonly (readonly number[])[]): [number, number][] {
  const ctrl: [number, number][] = [[0, 0]]
  for (const p of points) if (Number.isFinite(p[0]) && Number.isFinite(p[1])) ctrl.push([p[0]!, p[1]!])
  if (ctrl.length < 2) ctrl.push([1, 0])
  const d0 = Math.hypot(ctrl[1]![0], ctrl[1]![1]) || 1
  const last = ctrl[ctrl.length - 1]!, prev = ctrl[ctrl.length - 2]!
  // phantom ends: level with the first control point and 2|P1| behind it, which makes the Catmull-Rom tangent at the
  // infeed exactly +X; and past the end along its last span
  const ext: [number, number][] = [[ctrl[1]![0] - 2 * d0, ctrl[1]![1]], ...ctrl, [2 * last[0] - prev[0], 2 * last[1] - prev[1]]]
  const out: [number, number][] = [[0, 0]]
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1]!, p1 = ext[i]!, p2 = ext[i + 1]!, p3 = ext[i + 2]!
    for (let k = 1; k <= SAMPLES; k++) {
      const t = k / SAMPLES, t2 = t * t, t3 = t2 * t
      const c = (a: number, b: number, cc: number, d: number): number =>
        0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3)
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  return out
}

/** walk the polyline from `from` (at segment index `seg`) to the first point exactly `d` away; null past the end */
function stepChord(poly: [number, number][], from: [number, number], seg: number, d: number): { at: [number, number]; seg: number } | null {
  for (let i = seg; i < poly.length - 1; i++) {
    const a = poly[i]!, b = poly[i + 1]!
    if (Math.hypot(b[0] - from[0], b[1] - from[1]) < d) continue
    // the crossing on segment a->b: |a + t(b - a) - from| = d, the root with t in [0, 1]
    const dx = b[0] - a[0], dz = b[1] - a[1], fx = a[0] - from[0], fz = a[1] - from[1]
    const A = dx * dx + dz * dz, B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - d * d
    const disc = Math.max(0, B * B - 4 * A * C)
    const t = A > 0 ? Math.min(1, Math.max(0, (-B + Math.sqrt(disc)) / (2 * A))) : 0
    return { at: [a[0] + t * dx, a[1] + t * dz], seg: i }
  }
  return null
}

/** fit `n` equal-chord sections along the path through `points` */
export function flexStations(points: readonly (readonly number[])[], n: number): FlexStations {
  const poly = flexPolyline(points)
  const end = poly[poly.length - 1]!
  let arc = 0
  for (let i = 1; i < poly.length; i++) arc += Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1])
  // bisection on the chord: too long and the walk runs off the end before n steps, too short and it stops short
  let lo = Math.hypot(end[0], end[1]) / n, hi = arc / n
  let best: [number, number][] = []
  for (let iter = 0; iter < 48; iter++) {
    const d = (lo + hi) / 2
    const st: [number, number][] = [[0, 0]]
    let seg = 0
    let ok = true
    for (let k = 0; k < n; k++) {
      const s = stepChord(poly, st[st.length - 1]!, seg, d)
      if (!s) { ok = false; break }
      st.push(s.at)
      seg = s.seg
    }
    if (!ok) { hi = d; continue }
    best = st
    const last = st[st.length - 1]!
    // n chords that stop before the end: lengthen them
    if (Math.hypot(end[0] - last[0], end[1] - last[1]) > 1e-9 && seg < poly.length - 1) lo = d
    else hi = d
  }
  if (best.length !== n + 1) {
    // degenerate (a path folding back on itself): fall back to a straight bed to the end point
    best = Array.from({ length: n + 1 }, (_, k): [number, number] => [(end[0] * k) / n, (end[1] * k) / n])
  }
  const headings: number[] = []
  for (let k = 0; k < n; k++) headings.push(Math.atan2(-(best[k + 1]![1] - best[k]![1]), best[k + 1]![0] - best[k]![0]))
  const pitch = Math.hypot(best[1]![0] - best[0]![0], best[1]![1] - best[0]![1])
  let maxHinge = 0
  for (let k = 0; k < n; k++) {
    let d = headings[k]! - (k === 0 ? 0 : headings[k - 1]!)
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    maxHinge = Math.max(maxHinge, Math.abs(d))
  }
  return { stations: best, headings, pitch, maxHinge }
}
