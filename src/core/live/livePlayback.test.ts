import { describe, expect, it } from 'vitest'
import type { BoxFrame } from '../frame'
import { blendFrames, LivePlayback } from './livePlayback'

const frame = (simTime: number, x: number, extra: Partial<BoxFrame> = {}): BoxFrame => ({
  count: 1,
  ids: new Uint32Array([1]),
  positions: new Float32Array([x, 0, 0]),
  quats: new Float32Array([0, 0, 0, 1]),
  halfExtents: new Float32Array([0.1, 0.1, 0.1]),
  colors: new Float32Array([1, 1, 1]),
  kinds: new Uint8Array([0]),
  partIds: [null],
  simTime,
  ...extra,
})

describe('live playback', () => {
  it('blends poses, joints and mobile bases between two frames', () => {
    const s = Math.SQRT1_2
    const a = frame(1, 0, { joints: { arm: { j: 0 } }, basePoses: { agv: { pos: [0, 0, 0], yaw: 3 } } })
    const b = frame(1.05, 1, { quats: new Float32Array([0, s, 0, s]), joints: { arm: { j: 1 } }, basePoses: { agv: { pos: [2, 0, 0], yaw: -3 } }, lamps: { x: { on: true } } })
    const m = blendFrames(a, b, 0.5)
    expect(m.positions[0]).toBeCloseTo(0.5)
    expect(Math.hypot(...m.quats)).toBeCloseTo(1)
    expect(m.quats[1]).toBeGreaterThan(0.3)
    expect(m.joints!.arm!.j).toBeCloseTo(0.5)
    expect(m.basePoses!.agv!.pos[0]).toBeCloseTo(1)
    // yaw goes the short way round, through pi
    expect(Math.abs(Math.abs(m.basePoses!.agv!.yaw) - Math.PI)).toBeLessThan(0.01)
    expect(m.lamps).toBe(b.lamps)
    expect(m.simTime).toBeCloseTo(1.025)
  })

  it('plays smoothly behind jittery arrivals at the sharer rate', () => {
    const p = new LivePlayback()
    let now = 0
    let sim = 0
    const xs: number[] = []
    for (let k = 0; k < 400; k++) {
      // a frame every 50 ms, arriving 0-30 ms late; the viewer samples at 60 Hz
      if (k % 3 === 0) {
        sim += 0.05
        p.push(frame(sim, sim), now + ((k * 7919) % 30))
      }
      now += 16.7
      const f = p.sample(now)
      if (f && k > 60) xs.push(f.positions[0]!)
    }
    for (let i = 1; i < xs.length; i++) {
      const step = xs[i]! - xs[i - 1]!
      expect(step).toBeGreaterThanOrEqual(-1e-6) // never backwards
      expect(step).toBeLessThan(0.04) // never a jump of a whole frame's travel (0.05) plus
    }
    const behind = sim - xs[xs.length - 1]!
    expect(behind).toBeGreaterThan(0.03)
    expect(behind).toBeLessThan(0.3)
  })

  it('holds when frames stop, and starts over when the run restarts', () => {
    const p = new LivePlayback()
    p.push(frame(5, 5), 0)
    p.push(frame(5.05, 5.05), 50)
    for (let t = 60; t < 2000; t += 16) p.sample(t)
    expect(p.sample(2000)!.positions[0]).toBeCloseTo(5.05)
    p.push(frame(0.05, 0), 2050)
    expect(p.sample(2066)!.simTime).toBeCloseTo(0.05)
  })
})
