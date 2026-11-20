import { describe, expect, it } from 'vitest'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { EditorStore } from '../store/store'
import { forSim, WalkOverlays } from './viewScene'

const deck: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'forsim.belt',
  name: 'Belt',
  params: {},
  behavior: 'definePart({ step() {} })',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}

const store = { getState: () => ({ focusedPartId: null, walkFlex: null }) } as unknown as EditorStore

describe('forSim', () => {
  it('hands the worker the package of a part the scene does not embed', () => {
    // a pasted part: the registry draws it, but only placement embeds a package in the scene
    registerPackage(deck)
    try {
      const part = { id: 'b1', type: 'part', packageId: deck.id, position: [0, 0.75, 0], rotationY: 0, params: {} } as unknown as PartInstance
      const scene: SceneJSON = { version: SCENE_VERSION, parts: [part] }
      expect(forSim(new WalkOverlays(), store, scene).packages?.map((p) => p.id)).toEqual([deck.id])
      // one already embedded is not added twice
      expect(forSim(new WalkOverlays(), store, { ...scene, packages: [deck] }).packages?.map((p) => p.id)).toEqual([deck.id])
    } finally {
      unregisterPackage(deck.id)
    }
  })
})
