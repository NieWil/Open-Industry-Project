import { describe, expect, it } from 'vitest'
import { MAX_SIM_HZ } from '../core/types'
import type { StepStats } from '../sim/protocol'
import { budgetShare, limitOf, loadAtRate, renderWindow, rowMs, splitRows, stepWindow, sustainableHz, type RenderSample } from './simLoad'

const phases = { cull: 0, behaviors: 0, beams: 0, zones: 0, script: 0, scriptTags: 0, scriptSetup: 0, scriptBody: 0, drives: 0, facets: 0, solver: 0, flow: 0 }

function stats(o: { steps: number; totalMs: number; frameTotalMs?: number; plcTotalMs?: number; behaviors?: number; drives?: number; solver?: number }): StepStats {
  return {
    steps: o.steps,
    totalMs: o.totalMs,
    frameTotalMs: o.frameTotalMs ?? 0,
    plcTotalMs: o.plcTotalMs ?? 0,
    frames: 0,
    maxMs: 0,
    bodies: 0,
    active: 0,
    behaviorCount: 0,
    rigCount: 0,
    scriptMsByPart: {},
    rigMsByPart: {},
    phases: { ...phases, behaviors: o.behaviors ?? 0, drives: o.drives ?? 0, solver: o.solver ?? 0 },
  }
}

describe('stepWindow', () => {
  it('load follows the rate where ms per step does not: twice the steps at the same cost is twice the load', () => {
    const a = { stats: stats({ steps: 0, totalMs: 0 }), at: 0 }
    const at60 = stepWindow(a, { stats: stats({ steps: 30, totalMs: 24 }), at: 500 })!
    const at120 = stepWindow(a, { stats: stats({ steps: 60, totalMs: 48 }), at: 500 })!
    expect(at60.msPerStep).toBeCloseTo(0.8)
    expect(at120.msPerStep).toBeCloseTo(0.8)
    expect(at60.load).toBeCloseTo(0.048)
    expect(at120.load).toBeCloseTo(0.096)
  })

  it('counts the frame build and the PLC scan as worker time, and splits the window by where it went', () => {
    const a = { stats: stats({ steps: 0, totalMs: 0 }), at: 0 }
    const w = stepWindow(a, { stats: stats({ steps: 10, totalMs: 8, frameTotalMs: 1, plcTotalMs: 1, behaviors: 5, drives: 1, solver: 1 }), at: 100 })!
    expect(w.msPerStep).toBeCloseTo(1)
    expect(w.load).toBeCloseTo(0.1)
    // rig drives are the parts' cost (a robot moving its links), not upkeep
    expect(w.split!.parts).toBeCloseTo(0.6)
    expect(w.split!.physics).toBeCloseTo(0.1)
    expect(w.split!.plc).toBeCloseTo(0.1)
    expect(w.split!.upkeep).toBeCloseTo(0.2)
  })

  it('reads a pause as no load and no step cost, and a counter reset as no window', () => {
    const a = { stats: stats({ steps: 50, totalMs: 40 }), at: 0 }
    expect(stepWindow(a, { stats: stats({ steps: 50, totalMs: 40 }), at: 500 })).toEqual({ msPerStep: null, load: 0, split: null })
    expect(stepWindow(a, { stats: stats({ steps: 3, totalMs: 2 }), at: 500 })).toBeNull()
    expect(stepWindow(a, { stats: stats({ steps: 60, totalMs: 48 }), at: 0 })).toBeNull()
  })
})

describe('rate estimates', () => {
  it('loadAtRate is the per-step cost times the steps in a second', () => {
    expect(loadAtRate(0.8, 240)).toBeCloseTo(0.192)
  })

  it('sustainableHz keeps 20% of the core free, rounds down to 10 Hz and stops at the maximum', () => {
    expect(sustainableHz(1)).toBe(800)
    expect(sustainableHz(3)).toBe(260) // 266.7
    expect(sustainableHz(0.1)).toBe(MAX_SIM_HZ)
    expect(sustainableHz(0)).toBe(MAX_SIM_HZ)
  })
})

describe('splitRows', () => {
  it('states every share of the step in ms, adding up to the step itself', () => {
    const rows = splitRows({ parts: 0.34, physics: 0.08, plc: 0.32, upkeep: 0.26 }, 1.77)!
    expect(rows.map((r) => r.label)).toEqual(['parts', 'plc', 'physics', 'upkeep'])
    expect(rows[0]!.ms).toBeCloseTo(0.6018)
    expect(rows.reduce((a, r) => a + r.ms, 0)).toBeCloseTo(1.77)
  })

  it('leaves plc out when no scan ran, and has nothing to say without a split or a step time', () => {
    expect(splitRows({ parts: 0.6, physics: 0.3, plc: 0, upkeep: 0.1 }, 1)!.map((r) => r.label)).toEqual(['parts', 'physics', 'upkeep'])
    expect(splitRows(null, 1)).toBeNull()
    expect(splitRows({ parts: 1, physics: 0, plc: 0, upkeep: 0 }, null)).toBeNull()
  })

  it('never rounds a real cost down to 0.00', () => {
    expect(rowMs(0.001)).toBe('<0.01')
    expect(rowMs(0)).toBe('0.00')
    expect(rowMs(0.6018)).toBe('0.60')
  })
})

/** a render sample; the GPU unmeasured unless given */
const S = (cpuTotalMs: number, frames: number, at: number, gpuTotalMs: number | null = null, gpuFrames = 0): RenderSample => ({ cpuTotalMs, frames, at, gpuTotalMs, gpuFrames })

describe('renderWindow', () => {
  it('weights by time: one long frame among quick ones drags fps and raises the load, where an interval clamp would hide it', () => {
    // 9 frames of 10 ms in 9 x 16.7 ms, then one 1500 ms frame: 10 frames in ~1650 ms of real time
    const w = renderWindow(S(0, 0, 0), S(9 * 10 + 1500, 10, 9 * 16.7 + 1500))!
    expect(w.fps).toBeCloseTo(6.06, 1)
    expect(w.msPerFrame).toBeCloseTo(159)
    expect(w.load).toBeCloseTo(0.96, 2)
  })

  it('reads a vsync-paced frame as its share of the interval', () => {
    const w = renderWindow(S(100, 10, 0), S(220, 40, 500))!
    expect(w.fps).toBeCloseTo(60)
    expect(w.msPerFrame).toBeCloseTo(4)
    expect(w.load).toBeCloseTo(0.24)
  })

  it('has no frame cost when no frame ran, and no window across a remount', () => {
    expect(renderWindow(S(5, 3, 0), S(5, 3, 500))).toEqual({ fps: 0, msPerFrame: null, load: 0, gpuMsPerFrame: null, gpuLoad: null })
    expect(renderWindow(S(5, 3, 0), S(1, 1, 500))).toBeNull()
  })

  it('reads the GPU per its own resolved frames, which trail the drawn ones', () => {
    // 15 frames drawn in 500 ms (30 fps); 14 resolved at 28 ms each
    const w = renderWindow(S(0, 0, 0, 1000, 50), S(120, 15, 500, 1000 + 14 * 28, 64))!
    expect(w.gpuMsPerFrame).toBeCloseTo(28)
    expect(w.gpuLoad).toBeCloseTo(0.84)
  })

  it('caps a GPU frame at the frame interval, so the GPU is never busier than the time that passed', () => {
    // 30 frames in 500 ms (16.7 ms each) while the passes add up to 20 ms a frame
    const w = renderWindow(S(0, 0, 0, 0, 0), S(240, 30, 500, 600, 30))!
    expect(w.gpuMsPerFrame).toBeCloseTo(16.67, 1)
    expect(w.gpuLoad).toBeCloseTo(1)
  })

  it('has no GPU reading where the GPU is not measured', () => {
    const w = renderWindow(S(0, 0, 0), S(120, 15, 500))!
    expect(w.gpuMsPerFrame).toBeNull()
    expect(w.gpuLoad).toBeNull()
  })
})

describe('budgetShare', () => {
  it('reads a frame over budget as over 100%, by how much', () => {
    // the AS/RS demo on a 60 Hz display: an 18.3 ms GPU frame, busy 90% of the time at 49 fps
    expect(budgetShare(18.3, 1000 / 60)).toBeCloseTo(1.1, 2)
  })

  it('has no share without a time or a budget', () => {
    expect(budgetShare(null, 16.7)).toBeNull()
    expect(budgetShare(5, null)).toBeNull()
    expect(budgetShare(5, 0)).toBeNull()
  })
})

describe('limitOf', () => {
  const HZ60 = 1000 / 60

  it('names the side furthest into its budget', () => {
    expect(limitOf({ render: 0.34, gpu: 1.1, sim: 0.14 }, 49, HZ60)).toBe('gpu')
    expect(limitOf({ render: 1.4, gpu: 1.1, sim: 0.14 }, 30, HZ60)).toBe('render')
    expect(limitOf({ render: 0.3, gpu: 0.5, sim: 1.2 }, 60, HZ60)).toBe('sim')
  })

  it('names a side close to its budget, though the run still keeps up', () => {
    expect(limitOf({ render: 0.3, gpu: 0.93, sim: 0.2 }, 58, HZ60)).toBe('gpu')
  })

  it('names nothing while every side has headroom', () => {
    expect(limitOf({ render: 0.3, gpu: 0.5, sim: 0.2 }, 60, HZ60)).toBeNull()
  })

  it('names the GPU by elimination when it is not measured and neither CPU side explains a slow frame rate', () => {
    expect(limitOf({ render: 0.24, gpu: null, sim: 0.21 }, 30, HZ60)).toBe('gpu')
    expect(limitOf({ render: 0.24, gpu: null, sim: 0.21 }, 60, HZ60)).toBeNull()
    expect(limitOf({ render: 0.24, gpu: null, sim: 0.21 }, 30, null)).toBeNull()
  })

  it('does not guess when the GPU is measured and has headroom', () => {
    expect(limitOf({ render: 0.24, gpu: 0.4, sim: 0.2 }, 30, HZ60)).toBeNull()
  })
})
