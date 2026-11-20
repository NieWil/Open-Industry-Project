import { describe, expect, it } from 'vitest'
import { runProjectTests, testName } from './projectTestsRun'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'

const ungraded = (): ProjectJSON => ({
  version: PROJECT_VERSION,
  name: 'Ungraded',
  scene: { version: SCENE_VERSION, parts: [] },
})

describe('running project tests in-app', () => {
  // The early return is the whole reason this is cheap: it keeps the wasm import off both the boot
  // path and any project with nothing to run. The assertion is meaningful because the node test
  // env would fail to resolve 'jolt-physics/wasm' - if the guard ever regresses, this goes red rather
  // than quietly loading a physics engine to decide there is nothing to do.
  it('returns nothing, without loading jolt, when the project carries no tests', async () => {
    await expect(runProjectTests(ungraded())).resolves.toEqual([])
  })

  it('names an unnamed spec by position, the way the CLI does', () => {
    expect(testName({}, 0)).toBe('test-1')
    expect(testName({}, 2)).toBe('test-3')
    expect(testName({ name: 'boxes arrive' }, 3)).toBe('boxes arrive')
  })
})
