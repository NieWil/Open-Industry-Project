/// <reference types="node" />
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// A `conveys` link turned inside its part (not under a joint) is built at that turn: its collider and its running
// face follow the link, as a jointed deck's do. Built from the part's yaw alone, a deck yawed across the bed kept its
// collider along the part's x, so cargo at its far end fell through.

const Jolt = await initJolt()
const DECK_Y = 1

/** a 4 m deck yawed 90 degrees in its part (its +x along the world's -z), run along its own +x */
const turned = buildPackage(
  {
    id: 'acme.turned',
    name: 'Turned',
    geometry: {
      kind: 'rig',
      links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.1, 1] }, offset: [0, -0.05, 0], rotation: [0, Math.PI / 2, 0], conveys: true }],
      joints: [],
      bounds: { length: 1, width: 4, top: 0.05 },
    },
  },
  "definePart({ step(ctx) { ctx.setSurfaceSpeed(ctx.readNumber('v')) } })",
)

function world(): SimWorld {
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [turned],
    parts: [{ id: 'deck', type: 'part', packageId: 'acme.turned', position: [0, DECK_Y, 0], rotationY: 0, params: {} }],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  const w = new SimWorld(Jolt, res.scene)
  w.spawnBoxAt(0, DECK_Y + 0.2, 1.5, 0.2, 0.2, 0.2) // near the deck's far end along the world's +z
  return w
}

function pose(w: SimWorld): [number, number, number] {
  const f = w.frame()
  return [f.positions[0]!, f.positions[1]!, f.positions[2]!]
}

describe('a conveys link turned inside its part', () => {
  it('holds cargo where the turned deck is, and carries it along the deck', () => {
    const w = world()
    w.setBehaviorInputTags({ v: 0 })
    for (let i = 0; i < 60; i++) w.step()
    expect(pose(w)[1]).toBeGreaterThan(DECK_Y) // resting on the deck, not fallen through
    const before = pose(w)
    w.setBehaviorInputTags({ v: 0.5 })
    for (let i = 0; i < 60; i++) w.step()
    const after = pose(w)
    expect(after[2] - before[2]).toBeLessThan(-0.3) // along the deck's +x, which is the world's -z
    expect(Math.abs(after[0] - before[0])).toBeLessThan(0.05)
    w.dispose()
  })
})
