// Guard gaps for a drawn straight or spur bed. Where the host opens a guard (a diverter mounted on it, its arms
// crossing the guard), it hands the part a `guardGaps` row [x0, x1, side ±1] in bed-local X (core/guards/guardOpenings.ts
// withGuardGaps). The part's geometry() leaves that stretch of guard out, and since the sim builds its guard colliders
// from the same geometry, the gap is open there too. A belt takes its openings in `guardOpenings` instead, in arc
// length, and a rig's guard links are split by the host.

/** the hidden, host-fed `guardGaps` param */
export function guardGapsParam(group) {
  return { guardGaps: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Guard gaps [x0 m, x1 m, side ±1]', group, desc: 'Where the guards are opened, for a device whose arms cross them. Worked out by the host from the scene; not for editing.' } }
}

/**
 * The solid runs of one side's guard: [lo, hi] with that side's gaps taken out, ascending. With no gap it is the
 * whole run. Build each run as its own collision part, so its collider stops at the gap as the mesh does.
 */
export function guardGapRuns(p, sign, lo, hi) {
  var rows = Array.isArray(p.guardGaps) ? p.guardGaps : []
  var gaps = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    if (r[2] !== sign) continue
    var a = Math.max(r[0], lo), b = Math.min(r[1], hi)
    if (b - a > 1e-4) gaps.push([a, b])
  }
  gaps.sort(function (x, y) { return x[0] - y[0] })
  var runs = [], cur = lo
  for (var k = 0; k < gaps.length; k++) {
    if (gaps[k][0] - cur > 1e-4) runs.push([cur, gaps[k][0]])
    cur = Math.max(cur, gaps[k][1])
  }
  if (hi - cur > 1e-4) runs.push([cur, hi])
  return runs
}
