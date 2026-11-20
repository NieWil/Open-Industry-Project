// A rig part saved without one of its size params is drawn at the param's default (render/parts/sdk/rig.ts resolves
// its params before sizing the links), so its bodies must be built at that default too, or it looks one size and
// collides at another. The fixture's slab is 1 m long as authored, and its `length` param defaults to 3 m. A box
// dropped 1.2 m along it lands on the 3 m slab, and falls past a 1 m one.

import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()

function slabPkg() {
  return buildPackage(
    {
      id: 'acme.slab',
      name: 'Slab',
      geometry: {
        kind: 'rig',
        links: [{ name: 'slab', shape: { kind: 'box', size: [1, 0.1, 1], sizeParams: [{ axis: 0, param: 'length' }] }, offset: [0, 0.5, 0] }],
        joints: [],
        bounds: { length: 3, width: 1, top: 0.55 },
      },
    },
    "definePart({ params: { length: { type: 'number', default: 3, min: 0.5, max: 6 } }, step() {} })",
  )
}

/** the height a box dropped above the slab at local x settles at, for the given instance params */
function settledY(params: Record<string, number>, x: number): number {
  clearPackages()
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [slabPkg()],
    parts: [{ id: 'cp_1', type: 'part', packageId: 'acme.slab', position: [0, 0, 0], rotationY: 0, params }],
  })
  if (!res.ok) throw new Error(JSON.stringify(res))
  // loading a scene fills in a part's missing params, so hand the sim the part as given: the way a part reaches it
  // without a load (one placed before its package gained the param, a script, a test)
  const w = new SimWorld(Jolt, { ...res.scene, parts: res.scene.parts.map((p) => ({ ...p, params })) as typeof res.scene.parts })
  w.spawnBoxAt(x, 1, 0, 0.1, 0.1, 0.1)
  for (let i = 0; i < 120; i++) w.step()
  const y = w.frame().positions[1]!
  w.dispose()
  return y
}

describe("a rig part's bodies take its default-resolved params", () => {
  it('a missing size param builds the collider at its default, where the part is drawn', () => {
    // the slab's top is at 0.55: a box resting on it sits at 0.65, one on the floor at 0.1
    expect(settledY({ length: 3 }, 1.2)).toBeCloseTo(0.65, 1)
    expect(settledY({}, 1.2)).toBeCloseTo(0.65, 1)
    // the control: a slab set 1 m long really is 1 m long, and the box falls past it
    expect(settledY({ length: 1 }, 1.2)).toBeLessThan(0.2)
  })
})
