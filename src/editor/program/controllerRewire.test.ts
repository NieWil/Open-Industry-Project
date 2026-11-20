// A controller edit that renames tags follows the rename through the scene's wiring (controllerRewire.ts):
// a part's tag parameters move, wherever the part sits in the tree, and a scene nothing was wired into
// produces no commit at all.

import initJolt from 'jolt-physics'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { createPart } from '../../core/scene/scene'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON, SdkPart } from '../../core/types'
import { buildPackage } from '../../sim/buildPackage'
import { rewireTags } from './controllerRewire'

await initJolt()

const TAGGED = `
definePart({
  joints: ['j1'],
  params: { cmd: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'Cmd' }, label: { type: 'string', default: 'Motor' } },
  step(ctx) {},
})
`

function part(id: string, params: Record<string, unknown>, extra: Partial<PartInstance> = {}): PartInstance {
  return { id, type: 'part', packageId: 'test.tagged', position: [0, 0, 0], rotationY: 0, params, ...extra } as SdkPart
}

describe('rewiring the scene after tags are renamed', () => {
  beforeAll(() => {
    registerPackage(
      buildPackage(
        {
          id: 'test.tagged',
          name: 'Tagged',
          geometry: {
            kind: 'rig',
            links: [
              { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
              { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
            ],
            joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
          },
        },
        TAGGED,
      ),
      true,
    )
  })
  afterAll(() => unregisterPackage('test.tagged'))

  const renames = [{ from: 'Motor', to: 'Main.Motor' }]

  it("points a part's tag parameter at the new name, and leaves its other text alone", () => {
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [part('a', { cmd: 'Motor', label: 'Motor' })] }
    const out = rewireTags(scene, renames)
    expect(out?.parts).toEqual(['a'])
    expect((out!.scene.parts[0] as SdkPart).params).toEqual({ cmd: 'Main.Motor', label: 'Motor' })
  })

  it('rewires a part inside a group like any other: a tag name means the same thing at every depth', () => {
    const cell = createPart('group', 'cell', [0, 0, 0]) as PartInstance
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [cell, part('inside', { cmd: 'Motor' }, { parent: 'cell' })] }
    expect(rewireTags(scene, renames)?.parts).toEqual(['inside'])
  })

  it('has nothing to commit when no part was wired to a renamed tag', () => {
    expect(rewireTags({ version: SCENE_VERSION, parts: [part('a', { cmd: 'Conveyor' })] }, renames)).toBeNull()
    expect(rewireTags({ version: SCENE_VERSION, parts: [part('a', { cmd: 'Motor' })] }, [])).toBeNull()
  })
})
