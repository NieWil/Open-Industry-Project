import initJolt from 'jolt-physics'
import { expect, it } from 'vitest'
import { demoProject, LADDER_TIMEOUT_MS, ladderSpec } from './demoAcceptance'
import { createPlcDemoScene } from './demoScenes'
import { runProjectTest } from '../project/projectTestRunner'

// The demo cell's acceptance ladder at one step rate (demoAcceptance.ts: why each rate is its own file).

const Jolt = await initJolt()

it(`demo cell at 144 Hz: feeds, forms, palletizes and puts away, and never drops a case through the floor`, () => {
  const scene = createPlcDemoScene()
  const result = runProjectTest(Jolt, demoProject(scene, 144), ladderSpec(scene))
  // name every rung that broke, not just "false"
  expect(result.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual([])
  expect(result.ok).toBe(true)
}, LADDER_TIMEOUT_MS)
