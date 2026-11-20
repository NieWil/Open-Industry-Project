import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import { PACKAGE_FORMAT } from '../parts/partPackage'
import type { PartPackage } from '../parts/partPackage'
import { BELT_FRICTION, BOX_FRICTION, CONVEYOR_FRICTION } from '../types'
import type { SdkPart } from '../types'
import { cartonFrictionOf, conveyorSurfaceFriction, surfaceFrictionFromCarton } from './conveyorFriction'

function pkg(id: string, surface: 'belt' | 'roller', frictionParam?: string): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: id,
    conveyor: { surface, ...(frictionParam ? { frictionParam } : {}) },
    params: { friction: { type: 'number', default: 0.59 } },
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'drawn', bounds: { length: 1, width: 1, top: 0.1 }, conveys: true },
  } as unknown as PartPackage
}

const part = (packageId: string, params: Record<string, unknown> = {}): SdkPart => ({ id: 'p', type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params }) as unknown as SdkPart

describe('conveyor surface friction', () => {
  afterEach(() => clearPackages())

  it('turns a friction against a carton into the surface value Jolt combines back to it', () => {
    for (const carton of [0, 0.2, 0.59, 0.9, 1.4]) {
      const surface = surfaceFrictionFromCarton(carton)
      expect(Math.sqrt(surface * BOX_FRICTION)).toBeCloseTo(carton, 12)
      expect(cartonFrictionOf(surface)).toBeCloseTo(carton, 12)
    }
  })

  it("reads the declared friction param, the instance's value over the param's default", () => {
    registerPackage(pkg('t.belt', 'belt', 'friction'))
    expect(conveyorSurfaceFriction(part('t.belt'))).toBeCloseTo(surfaceFrictionFromCarton(0.59), 12)
    expect(conveyorSurfaceFriction(part('t.belt', { friction: 0.2 }))).toBeCloseTo(surfaceFrictionFromCarton(0.2), 12)
  })

  it("falls back to the surface kind without a param, and for a value Jolt can't take", () => {
    registerPackage(pkg('t.belt', 'belt'))
    registerPackage(pkg('t.roller', 'roller'))
    registerPackage(pkg('t.named', 'roller', 'friction'))
    expect(conveyorSurfaceFriction(part('t.belt', { friction: 0.2 }))).toBe(BELT_FRICTION)
    expect(conveyorSurfaceFriction(part('t.roller'))).toBe(CONVEYOR_FRICTION)
    expect(conveyorSurfaceFriction(part('t.named', { friction: -1 }))).toBe(CONVEYOR_FRICTION)
    expect(conveyorSurfaceFriction(part('t.named', { friction: Number.NaN }))).toBe(CONVEYOR_FRICTION)
  })
})
