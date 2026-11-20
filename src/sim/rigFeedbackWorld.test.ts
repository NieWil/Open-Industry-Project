import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../core/types'
import type { SdkPart, SceneJSON } from '../core/types'
import { registerPackage, unregisterPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// End-to-end test of closed-loop rig feedback at the host seam (world.tickBehaviors ↔ RigDriver.drive):
// a behavior commands joints/grippers, the host applies them (clamp to limits / grab cargo), and feeds
// the host-applied state back as ctx.measured next tick (the read half of the command bags).

const Jolt = await initJolt()

function part(id: string, packageId: string, pos: [number, number, number] = [0, 0, 0]): SdkPart {
  return { id, type: 'part', packageId, position: pos, rotationY: 0, params: {} } as SdkPart
}

function scene(parts: SdkPart[]): SceneJSON {
  return { version: SCENE_VERSION, parts }
}

describe('joint feedback (world end-to-end)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    unregisterPackage('test.jointfb')
  })

  // Commands j1 well beyond its +1 limit and echoes the host's applied (clamped) feedback onto a tag.
  const PUSH_PAST_LIMIT = `
    definePart({
      joints: ['j1'],
      step(ctx) {
        ctx.joints.j1 = 5.0 // command past the +1 limit - the command bag is unclamped
        ctx.writeNumber('pos', ctx.measured.joints.j1) // read the host-applied (clamped) pose
      },
    })`

  function setup(): SimWorld {
    registerPackage(
      buildPackage(
        {
          id: 'test.jointfb',
          name: 'JointFb',
          geometry: {
            kind: 'rig',
            links: [
              { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
              { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0.2, 0] },
            ],
            joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
          },
        },
        PUSH_PAST_LIMIT,
      ),
    )
    world = new SimWorld(Jolt, scene([part('p', 'test.jointfb')]))
    return world
  }

  it('feeds back the host-clamped joint pose, not the (over-limit) command', () => {
    const w = setup()
    // first tick: no feedback yet → measured reads the declared rest value (0), not the commanded 5
    w.step()
    expect(w.frame().tags?.['p']?.pos).toBe(0)
    // second tick: the host clamped the +5 command to the joint's +1 limit during FK and fed it back
    w.step()
    expect(w.frame().tags?.['p']?.pos).toBe(1)
  })
})

describe('grip feedback (world end-to-end)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    unregisterPackage('test.gripfb')
  })

  // Always commands the gripper shut, and echoes whether the host actually caught cargo onto a tag.
  const ALWAYS_GRAB = `
    definePart({
      grippers: ['hand'],
      step(ctx) {
        ctx.grips.hand = true // command shut every tick - the command bag says "closed" regardless
        ctx.writeTag('holding', ctx.measured.grips.hand) // read whether cargo is ACTUALLY held
      },
    })`

  function setup(): SimWorld {
    registerPackage(
      buildPackage(
        {
          id: 'test.gripfb',
          name: 'GripFb',
          geometry: {
            kind: 'rig',
            links: [
              { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
              { name: 'hand', parent: 'base', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0.5, 0] },
            ],
            joints: [],
          },
        },
        ALWAYS_GRAB,
      ),
    )
    world = new SimWorld(Jolt, scene([part('g', 'test.gripfb')]))
    return world
  }

  it('reads false when the gripper closes on empty space (command shut, caught nothing)', () => {
    const w = setup()
    w.step() // commands hand shut; no cargo in reach → grabs nothing
    expect(w.frame().tags?.['g']?.holding).toBe(false)
    w.step() // feedback from the empty close is still false
    expect(w.frame().tags?.['g']?.holding).toBe(false)
  })

  it('reads true once the host actually grabs cargo in reach (successful pick)', () => {
    const w = setup()
    // a box sitting at the gripper link's world pose ([0,0.5,0]) - within grab reach
    w.spawnBoxAt(0, 0.5, 0, 0.1, 0.1, 0.1)
    // tick 1: command shut → host grabs the box this tick (feedback not visible until next tick)
    w.step()
    expect(w.frame().tags?.['g']?.holding).toBe(false)
    // tick 2: the host reports the gripper is carrying cargo → measured.grips.hand reads true
    w.step()
    expect(w.frame().tags?.['g']?.holding).toBe(true)
  })
})

describe('gripper grab reach - RigLink.grip?.radius (world end-to-end)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    unregisterPackage('test.gripreach')
  })

  // Always commands the gripper shut; echoes whether the host actually caught cargo (measured feedback).
  const ALWAYS_GRAB = `
    definePart({
      grippers: ['hand'],
      step(ctx) {
        ctx.grips.hand = true
        ctx.writeTag('holding', ctx.measured.grips.hand)
      },
    })`

  // A transform-only 'frame' gripper (like the robots' grab points) has zero half-extents, so its effective
  // reach is exactly the declared grabRadius, or the host's 0.2 m default without one. The robot manipulators
  // grab through much larger pickup volumes (0.45 m suction spheres, the AGV's fork box); grabRadius is how a
  // rig declares that reach.
  function setup(grabRadius?: number): SimWorld {
    registerPackage(
      buildPackage(
        {
          id: 'test.gripreach',
          name: 'GripReach',
          geometry: {
            kind: 'rig',
            links: [
              { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
              { name: 'hand', parent: 'base', shape: { kind: 'frame' }, offset: [0, 0.5, 0], ...(grabRadius !== undefined ? { grip: { radius: grabRadius } } : {}) },
            ],
            joints: [],
          },
        },
        ALWAYS_GRAB,
      ),
    )
    world = new SimWorld(Jolt, scene([part('g', 'test.gripreach')]))
    return world
  }

  // the box's OBB surface sits ~0.45 m from the gripper: outside the 0.2 default, inside a 0.6 grabRadius
  const BOX_AT = [0.5, 0.5, 0] as const

  it('a declared grabRadius extends the grab reach', () => {
    const w = setup(0.6)
    w.spawnBoxAt(BOX_AT[0], BOX_AT[1], BOX_AT[2], 0.1, 0.1, 0.1)
    w.step() // grab resolves this tick…
    w.step() // …feedback reads back the next
    expect(w.frame().tags?.['g']?.holding).toBe(true)
  })

  it('without grabRadius the reach stays at the 0.2 m default (the same box is out of reach)', () => {
    const w = setup()
    w.spawnBoxAt(BOX_AT[0], BOX_AT[1], BOX_AT[2], 0.1, 0.1, 0.1)
    w.step()
    w.step()
    expect(w.frame().tags?.['g']?.holding).toBe(false)
  })
})
