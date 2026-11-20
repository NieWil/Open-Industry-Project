import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { DEMO_SCAN_MS, demoProject, ladderSpec } from './demoAcceptance'
import { createPlcDemoScene } from './demoScenes'
import { runProjectTest } from '../project/projectTestRunner'

// The demo cell's conveyors and sensors are reactive parts (definePart's `react`): called when an input changes or
// when they asked, not on every step. A reactive part may be called on any step, so the cell must run the same with
// every one of them called on every step. A part that takes a call to mean a change, or that needs a tick it did not
// ask for, moves a box differently here.

const Jolt = await initJolt()

describe('demo cell - reactive parts', () => {
  it('runs the same with every reactive part called on every step', { timeout: 600_000 }, () => {
    const run = (wakeAllParts: boolean): { hash: number; frames: number; boxes: number } => {
      const scene = createPlcDemoScene()
      let hash = 0
      let frames = 0
      let boxes = 0
      const bits = new Uint32Array(1)
      const real = new Float32Array(bits.buffer)
      runProjectTest(
        Jolt,
        demoProject(scene),
        { duration: 30, scanMs: DEMO_SCAN_MS, inputs: ladderSpec(scene).inputs, checks: [] },
        {
          wakeAllParts,
          flowFacts: false,
          onFrame: (f) => {
            frames++
            boxes = Math.max(boxes, f.count)
            hash = (Math.imul(hash, 31) + f.count) | 0
            for (let i = 0; i < f.count * 3; i++) {
              real[0] = f.positions[i]!
              hash = (Math.imul(hash, 31) + bits[0]!) | 0
            }
          },
        },
      )
      return { hash, frames, boxes }
    }
    // (guards the test itself: the cell's roller conveyors are the reactive ones)
    const roller = (createPlcDemoScene().packages ?? []).find((p) => p.id === 'oip.roller-conveyor')
    expect(roller?.behavior).toContain('  react(ctx) {')
    const quiet = run(false)
    const woken = run(true)
    expect(quiet.boxes).toBeGreaterThan(100) // the cell is stocked and running, not empty
    expect(quiet.frames).toBeGreaterThan(1000)
    expect(woken).toEqual(quiet)
  })
})
