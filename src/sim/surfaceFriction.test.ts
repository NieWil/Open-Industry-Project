import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PartPackage } from '../core/parts/partPackage'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { SdkPart } from '../core/types'
import { SimWorld } from './world'

// A solid's declared surface friction (MeshPart.friction on a drawn hull, RigLink.friction on a rig link). Proven on a
// 15 degree slope, where a carton (friction 0.5) holds on either default (0.5 for a hull, 0.6 for a link: combined
// grip above tan 15deg = 0.27) and slides once the solid declares 0.06 (combined about 0.17).

const Jolt = await initJolt()

const SLOPE = (15 * Math.PI) / 180
const LEN = 4

/** a drawn wedge whose top falls along +X at SLOPE, hulled, with an optional friction */
function wedgePkg(id: string, friction?: number): PartPackage {
  const h = LEN * Math.tan(SLOPE)
  const extra = friction === undefined ? '' : `, friction: ${friction}`
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Wedge',
    params: {},
    behavior: `definePart({
      geometry(g) { return [{ desc: g.extrude([[0, 0], [${LEN}, 0], [0, ${h}]], -0.5, 0.5, { axis: 'z' }), collision: 'hull'${extra} }] },
      step() {},
    })`,
    geometry: { kind: 'drawn', bounds: { length: LEN, width: 1, top: h } },
  } as unknown as PartPackage
}

/** a rig with one box link laid at SLOPE, falling along +X, with an optional friction */
function rampPkg(id: string, friction?: number): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'Ramp',
    params: {},
    behavior: 'definePart({ step() {} })',
    geometry: {
      kind: 'rig',
      links: [{ name: 'ramp', shape: { kind: 'box', size: [LEN, 0.1, 1] }, offset: [0, 1, 0], rotation: [0, 0, -SLOPE], ...(friction === undefined ? {} : { friction }) }],
      joints: [],
      bounds: { length: LEN, width: 1, top: 2 },
    },
  } as unknown as PartPackage
}

const placed = (id: string, packageId: string, z: number): SdkPart =>
  ({ id, type: 'part', packageId, position: [0, 0, z], rotationY: 0, params: {} }) as unknown as SdkPart

/** set a carton down over the slope at (x, y) and let it settle; the returned call runs 2 s more and says how far it
 *  slid down the slope (along +X) */
function slide(world: SimWorld, x: number, y: number, z: number): () => number {
  world.spawnBoxAt(x, y, z, 0.15, 0.1, 0.15, 0)
  const index = world.frame().count - 1
  for (let i = 0; i < DEFAULT_SIM_HZ; i++) world.step()
  const settled = world.frame().positions[index * 3]!
  return () => {
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) world.step()
    return world.frame().positions[index * 3]! - settled
  }
}

describe('a solid surface friction', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('a carton holds on a hulled slope at its default friction and slides once the hull declares a low one', () => {
    registerPackage(wedgePkg('test.wedge'))
    registerPackage(wedgePkg('test.slick-wedge', 0.06))
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [placed('grip', 'test.wedge', 0), placed('slick', 'test.slick-wedge', 3)] })
    // over x = 1.5, where the wedge top stands (LEN - 1.5) tan 15deg = 0.67 m up
    const y = (LEN - 1.5) * Math.tan(SLOPE) + 0.3
    const grip = slide(world, 1.5, y, 0)
    const slick = slide(world, 1.5, y, 3)
    expect(grip()).toBeLessThan(0.02)
    expect(slick()).toBeGreaterThan(0.5)
  })

  it('a carton holds on a sloped rig link at its default friction and slides once the link declares a low one', () => {
    registerPackage(rampPkg('test.ramp'))
    registerPackage(rampPkg('test.slick-ramp', 0.06))
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [placed('grip', 'test.ramp', 0), placed('slick', 'test.slick-ramp', 3)] })
    // over x = -1, where the link top stands 1 + 0.05 / cos + tan 15deg above the floor
    const y = 1 + 0.05 / Math.cos(SLOPE) + Math.tan(SLOPE) + 0.3
    const grip = slide(world, -1, y, 0)
    const slick = slide(world, -1, y, 3)
    expect(grip()).toBeLessThan(0.02)
    expect(slick()).toBeGreaterThan(0.5)
  })
})
