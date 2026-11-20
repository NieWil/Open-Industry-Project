import { describe, expect, it } from 'vitest'
import {
  beltColliders,
  beltEndPose,
  beltGuardChords,
  beltHorizontalExtent,
  beltMatchesPreset,
  beltPresetSegments,
  beltSegmentFrames,
  manualGuardOpenings,
  beltStartPose,
  beltXToS,
  buildBeltPath,
  sampleBeltPath,
} from './beltPath'
import type { BeltPath } from './beltPath'
import { createGeometryBuilder } from '../geometry/geometryBuilder'
import { BELT_HEIGHT, BELT_MAX_TILT_DEG } from '../types'
import type { BeltSegmentSpec } from '../types'

const flat = [{ length: 4, tiltDeg: 0 }]

describe('buildBeltPath', () => {
  it('builds a single flat run anchored at the tail', () => {
    const path = buildBeltPath(flat, BELT_HEIGHT)
    expect(path.runs.length).toBe(1)
    expect(path.joints.length).toBe(0)
    expect(path.topLength).toBeCloseTo(4, 6)
    // tail-origin: tail at x = 0, head at +4, both at y = 0
    expect(beltStartPose(path).x).toBeCloseTo(0, 6)
    expect(beltStartPose(path).y).toBeCloseTo(0, 6)
    expect(beltEndPose(path).x).toBeCloseTo(4, 6)
    expect(beltEndPose(path).y).toBeCloseTo(0, 6)
    expect(beltHorizontalExtent(flat)).toBeCloseTo(4, 6)
  })

  it('chains a z-frame into 3 runs + 2 bends that finish elevated', () => {
    const segs = beltPresetSegments('zframe')!
    const path = buildBeltPath(segs, BELT_HEIGHT)
    expect(path.runs.length).toBe(3)
    expect(path.joints.length).toBe(2)
    // tilts 0,+12,-12 -> ends flat but raised above the tail
    expect(beltStartPose(path).y).toBeCloseTo(0, 6)
    expect(beltEndPose(path).y).toBeGreaterThan(0.4)
    expect(beltEndPose(path).angle).toBeCloseTo(0, 6)
  })

  it('samples the ends exactly', () => {
    const path = buildBeltPath(beltPresetSegments('noseover')!, BELT_HEIGHT)
    const s0 = sampleBeltPath(path, 0)
    const sN = sampleBeltPath(path, path.topLength)
    expect(s0).toEqual(beltStartPose(path))
    expect(sN.x).toBeCloseTo(beltEndPose(path).x, 6)
    expect(sN.y).toBeCloseTo(beltEndPose(path).y, 6)
  })
})

describe('beltColliders', () => {
  it('one extended box for a flat run, tangent along +X', () => {
    const path = buildBeltPath(flat, BELT_HEIGHT)
    const cols = beltColliders(path, 0.01)
    expect(cols.length).toBe(1)
    const box = cols[0]!
    expect(box.kind).toBe('box')
    if (box.kind === 'box') {
      // end runs are extended by the pulley radius (height/2) at both ends
      expect(box.length).toBeCloseTo(4 + BELT_HEIGHT, 6)
      // tail-origin: bed runs x 0..4, so the box centre is at 2
      expect(box.cx).toBeCloseTo(2, 6)
      expect(box.tanX).toBeCloseTo(1, 6)
      expect(box.tanY).toBeCloseTo(0, 6)
    }
  })

  it('z-frame yields 3 run boxes + 8 bend prisms', () => {
    const path = buildBeltPath(beltPresetSegments('zframe')!, BELT_HEIGHT)
    const cols = beltColliders(path, 0.01)
    const boxes = cols.filter((c) => c.kind === 'box')
    const hulls = cols.filter((c) => c.kind === 'hull')
    expect(boxes.length).toBe(3)
    expect(hulls.length).toBe(8) // 2 bends * BELT_BEND_SUBDIVISIONS(4)
    // a ramp prism conveys partly upward
    expect(hulls.some((h) => h.tanY > 0.1)).toBe(true)
  })
})

describe('beltGuardChords', () => {
  it('covers the whole path when there are no openings', () => {
    const path = buildBeltPath(flat, BELT_HEIGHT)
    const chords = beltGuardChords(path, [])
    const total = chords.reduce((a, c) => a + c.len, 0)
    expect(total).toBeCloseTo(path.topLength, 4)
  })

  it('leaves a gap where a merge opening sits', () => {
    const path = buildBeltPath(flat, BELT_HEIGHT)
    // a 1 m opening around the middle of the 0..4 bed
    const chords = beltGuardChords(path, [[1.5, 2.5]])
    const total = chords.reduce((a, c) => a + c.len, 0)
    expect(total).toBeCloseTo(path.topLength - 1, 6)
  })

  it('cuts an authored opening on a steep run to exactly its arc length', () => {
    // the 89 deg run of rows turning past vertical, where plan X barely moves along the belt
    const path = buildBeltPath([{ length: 2, tiltDeg: 0 }, { length: 2, tiltDeg: 60 }, { length: 2, tiltDeg: 60 }], BELT_HEIGHT)
    const run = path.runs[2]!
    const s0 = run.sStart + 0.4
    const manual = manualGuardOpenings([{ side: 'left', arcStart: s0, arcEnd: s0 + 0.5 }])
    expect(manual.right).toEqual([])
    const total = (openingsS: [number, number][]) => beltGuardChords(path, [], { openingsS }).reduce((acc, c) => acc + c.len, 0)
    expect(total([]) - total(manual.left)).toBeCloseTo(0.5, 9)
  })

  it('extends over the end drums when asked (covers the pulley wraps)', () => {
    const path = buildBeltPath(flat, BELT_HEIGHT)
    const chords = beltGuardChords(path, [], { extendEnds: true, bendSubdiv: 4 })
    const total = chords.reduce((a, c) => a + c.len, 0)
    // top surface + a pulley-radius extension at each end (= one belt height)
    expect(total).toBeCloseTo(path.topLength + path.height, 4)
  })
})

describe('presets', () => {
  it('round-trips a stamped preset', () => {
    const segs = beltPresetSegments('walkthru')!
    expect(beltMatchesPreset(segs, 'walkthru')).toBe(true)
    expect(beltMatchesPreset(segs, 'zframe')).toBe(false)
    expect(beltPresetSegments('custom')).toBeNull()
  })
})

/** shortest distance from (x, y) to the path's top surface: its runs and bend arcs, measured exactly */
function distToPath(path: BeltPath, x: number, y: number): number {
  let best = Infinity
  for (const run of path.runs) {
    const ca = Math.cos(run.angle)
    const sa = Math.sin(run.angle)
    const t = Math.max(0, Math.min(run.effLength, (x - run.x) * ca + (y - run.y) * sa))
    best = Math.min(best, Math.hypot(x - (run.x + ca * t), y - (run.y + sa * t)))
  }
  for (const jt of path.joints) {
    if (jt.arcLength <= 0) continue
    const a0 = Math.atan2(jt.tpy - jt.cy, jt.tpx - jt.cx)
    const a = Math.atan2(y - jt.cy, x - jt.cx)
    const sweep = Math.atan2(Math.sin(a - a0), Math.cos(a - a0)) * Math.sign(jt.turning)
    if (sweep >= -1e-9 && sweep <= Math.abs(jt.turning) + 1e-9) best = Math.min(best, Math.abs(Math.hypot(x - jt.cx, y - jt.cy) - jt.radius))
  }
  return best
}

// The drawn belt is g.fillet over the segment corners (the belt part's geometry()); the simulated one is
// buildBeltPath. Both must be the same curve, including where a short segment forces a tighter bend and where the
// rows ask the belt to turn past vertical.
describe('the path matches the drawn fillet', () => {
  const cases: [string, BeltSegmentSpec[], number][] = [
    ['z-frame', beltPresetSegments('zframe')!, BELT_HEIGHT],
    ['walk-thru', beltPresetSegments('walkthru')!, BELT_HEIGHT],
    ['nose-over', beltPresetSegments('noseover')!, BELT_HEIGHT],
    ['short segment between two bends', [{ length: 2, tiltDeg: 0 }, { length: 0.1, tiltDeg: 45 }, { length: 2, tiltDeg: -45 }], BELT_HEIGHT],
    ['tall frame', [{ length: 2, tiltDeg: 0 }, { length: 0.5, tiltDeg: 60 }, { length: 2, tiltDeg: -60 }], 0.6],
    ['short tail before a bend', [{ length: 0.05, tiltDeg: 0 }, { length: 2, tiltDeg: 45 }], BELT_HEIGHT],
    ['rows turning past vertical', [{ length: 2, tiltDeg: 0 }, { length: 2, tiltDeg: 60 }, { length: 2, tiltDeg: 60 }], BELT_HEIGHT],
  ]
  for (const [name, segs, height] of cases) {
    it(name, () => {
      const path = buildBeltPath(segs, height)
      const corners = beltSegmentFrames(segs).corners.map((c) => [c.x, c.y, 0] as const)
      const drawn = createGeometryBuilder().fillet(corners, height, 64)
      for (const q of drawn) expect(distToPath(path, q[0], q[1])).toBeLessThan(1e-9)
      let drawnLen = 0
      for (let i = 1; i < drawn.length; i++) drawnLen += Math.hypot(drawn[i]![0] - drawn[i - 1]![0], drawn[i]![1] - drawn[i - 1]![1])
      expect(path.topLength).toBeCloseTo(drawnLen, 4)

      for (const run of path.runs) expect(run.effLength).toBeGreaterThanOrEqual(0)
      // continuous, and never doubling back in plan X (the X-keyed lookups depend on it)
      const n = 4000
      let prev = sampleBeltPath(path, 0)
      for (let i = 1; i <= n; i++) {
        const q = sampleBeltPath(path, (path.topLength * i) / n)
        expect(Math.hypot(q.x - prev.x, q.y - prev.y)).toBeLessThanOrEqual(path.topLength / n + 1e-9)
        expect(q.x).toBeGreaterThanOrEqual(prev.x - 1e-12)
        expect(Math.abs(q.angle)).toBeLessThanOrEqual((BELT_MAX_TILT_DEG * Math.PI) / 180 + 1e-12)
        prev = q
      }
      // X -> arc length inverts the sampler on every straight run
      for (const run of path.runs) {
        if (run.effLength <= 1e-3) continue
        const s = run.sStart + run.effLength / 2
        expect(beltXToS(path, sampleBeltPath(path, s).x)).toBeCloseTo(s, 6)
      }
    })
  }
})
