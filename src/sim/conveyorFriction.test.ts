import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { conveyorEndsOf } from '../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PartPackage } from '../core/parts/partPackage'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { PartInstance, SdkPart } from '../core/types'
import { SimWorld } from './world'

// A conveyor's declared friction param (ConveyorDecl.frictionParam) is its grip against a carton. Proven on a stopped
// incline, where a carton holds when that grip beats the slope (mu >= tan 20deg = 0.36) and slides when it does not.
// Butted belts merge into one body with one friction, so a mixed pair proves each member's grip reaches its own facets.

const Jolt = await initJolt()

const TILT_DEG = 20
const params = {
  segments: { type: 'numberList', arity: 2, default: [[4, TILT_DEG]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
  width: { type: 'number', default: 0.6 },
  height: { type: 'number', default: 0.17 },
  friction: { type: 'number', default: 0.59 },
}

/** a stopped belt that declares its friction param */
function beltPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.grip-belt',
    name: 'Grip Belt',
    conveyor: { bed: 'path', surface: 'belt', frictionParam: 'friction' },
    params,
    behavior: `definePart({ params: ${JSON.stringify(params)}, step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: 0 }) } })`,
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.17 }, conveys: true },
  } as unknown as PartPackage
}

function belt(id: string, pos: [number, number, number], friction: number): SdkPart {
  return { id, type: 'part', packageId: 'test.grip-belt', position: pos, rotationY: 0, params: { friction } } as unknown as SdkPart
}

/** where a belt's tail must stand for its tail end to butt `a`'s head end */
function buttedAfter(a: PartInstance, id: string, friction: number): SdkPart {
  const head = conveyorEndsOf(a).find((e) => e.outX > 0)!
  const tail = conveyorEndsOf(belt(id, [0, 0, 0], friction)).find((e) => e.outX < 0)!
  return belt(id, [head.x - tail.x, head.y - tail.y, head.z - tail.z], friction)
}

/** set a carton down at arc length `s` along a belt standing at `pos` and let it settle; the returned call runs 2 s
 *  more and says how far it slid down the slope */
function slide(world: SimWorld, pos: [number, number, number], s: number): () => number {
  const t = (TILT_DEG * Math.PI) / 180
  const x = pos[0] + s * Math.cos(t)
  world.spawnBoxAt(x, pos[1] + s * Math.sin(t) + 0.25, pos[2], 0.15, 0.1, 0.15, 0)
  const index = world.frame().count - 1
  for (let i = 0; i < DEFAULT_SIM_HZ; i++) world.step() // land and settle
  const settled = world.frame().positions[index * 3]!
  return () => {
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) world.step()
    return settled - world.frame().positions[index * 3]!
  }
}

describe('conveyor friction param', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  for (const forceJsListener of [false, true]) {
    const listener = forceJsListener ? 'JS listener' : 'native listener'

    it(`a carton holds on a grippy belt and slides on a low-friction one (${listener})`, () => {
      registerPackage(beltPkg())
      world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [belt('grip', [0, 2, 0], 0.9), belt('slip', [0, 2, 5], 0.2)] }, { forceJsListener })
      const grip = slide(world, [0, 2, 0], 2)
      const slip = slide(world, [0, 2, 5], 2)
      expect(grip()).toBeLessThan(0.02)
      expect(slip()).toBeGreaterThan(0.5)
    })

    it(`each member of a merged deck grips as its own param says (${listener})`, () => {
      registerPackage(beltPkg())
      // 'a' (lowest id) owns the merged body, whose single friction is its lowest member's: the slippery one
      const a = belt('a', [0, 2, 0], 0.2)
      const b = buttedAfter(a, 'b', 0.9)
      world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [a, b] }, { forceJsListener })
      const bodies = (world as unknown as { partGroups: Map<string, { bodies: unknown[] }> }).partGroups
      expect(bodies.get('b')?.bodies.length ?? 0).toBe(0) // b's deck is inside a's body: the pair really merged
      const onA = slide(world, a.position, 2)
      const onB = slide(world, b.position, 2)
      expect(onB()).toBeLessThan(0.02)
      expect(onA()).toBeGreaterThan(0.5)
    })
  }
})
