import { describe, expect, it } from 'vitest'
import { flexStations } from './flexPath'

// The flex conveyor's shape (core/conveyor/flexPath.ts): equal-chord sections along a curve through the control points. The
// part's behavior mirrors this, and src/sim/flexConveyor.test.ts checks the running part against it.

const N = 12
const endOf = (s: ReturnType<typeof flexStations>): [number, number] => s.stations[s.stations.length - 1]!

describe('flex conveyor path', () => {
  it('lays a straight bed as n equal sections to the end point', () => {
    const s = flexStations([[4, 0], [9, 0]], N)
    expect(s.stations).toHaveLength(N + 1)
    expect(s.pitch).toBeCloseTo(9 / N, 6)
    for (const h of s.headings) expect(h).toBeCloseTo(0, 6)
    expect(endOf(s)[0]).toBeCloseTo(9, 4)
  })

  it('puts the last hinge on the last control point, through an S and a U', () => {
    for (const pts of [[[3, 0], [5, -2], [8, -2]], [[4, 0], [6, 3], [2, 6]], [[2, 1], [4, -1], [6, 1], [8, -1]]]) {
      const s = flexStations(pts, N)
      const [ex, ez] = endOf(s)
      const last = pts[pts.length - 1]!
      expect(Math.hypot(ex - last[0]!, ez - last[1]!), JSON.stringify(pts)).toBeLessThan(0.02)
      // every section the same length (the accordion is uniform)
      for (let k = 0; k < N; k++) {
        const a = s.stations[k]!, b = s.stations[k + 1]!
        expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(s.pitch, 3)
      }
    }
  })

  it('leaves the infeed heading +X, whatever the path does after', () => {
    const s = flexStations([[3, 2], [5, 5]], N)
    // the first section leaves close to +X: its chord sits at half the turn its own arc makes (0.16 rad here), where an
    // unpinned tangent put it at 0.36
    expect(Math.abs(s.headings[0]!)).toBeLessThan(0.2)
    expect(s.headings[N - 1]!).toBeLessThan(-0.5) // ...and it has turned toward +Z by the end (negative yaw)
  })
})
