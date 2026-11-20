import initJolt from 'jolt-physics'
import type JoltTypes from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import type { ConveyorFacets } from './conveyorFacets'
import { LAYER_MOVING, LAYER_NON_MOVING, NUM_BROAD_PHASE_LAYERS, NUM_OBJECT_LAYERS } from './layers'
import { BodyTableFull, PartBodies } from './partBodies'

const Jolt = await initJolt()

/** a physics system whose body table holds `maxBodies` */
function smallWorld(maxBodies: number): { iface: JoltTypes.JoltInterface; bodyInterface: JoltTypes.BodyInterface } {
  const settings = new Jolt.JoltSettings()
  settings.mMaxBodies = maxBodies
  const objectFilter = new Jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS)
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING)
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING)
  const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(NUM_OBJECT_LAYERS, NUM_BROAD_PHASE_LAYERS)
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new Jolt.BroadPhaseLayer(LAYER_NON_MOVING))
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new Jolt.BroadPhaseLayer(LAYER_MOVING))
  settings.mObjectLayerPairFilter = objectFilter
  settings.mBroadPhaseLayerInterface = bpInterface
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bpInterface, NUM_BROAD_PHASE_LAYERS, objectFilter, NUM_OBJECT_LAYERS)
  const iface = new Jolt.JoltInterface(settings)
  Jolt.destroy(settings)
  return { iface, bodyInterface: iface.GetPhysicsSystem().GetBodyInterface() }
}

describe('PartBodies past the body table', () => {
  it('throws on a body Jolt could not create and never files it', () => {
    const { iface, bodyInterface } = smallWorld(2)
    const axisY = new Jolt.Vec3(0, 1, 0)
    const facets = { register: () => {}, release: () => {} } as unknown as ConveyorFacets
    const bodies = new PartBodies(Jolt, bodyInterface, axisY, facets)
    const group = { signature: '', bodies: [], conveyorKeys: [], boxIds: [] }
    bodies.begin('deck', group)
    bodies.addStaticBox(1, 0.05, 0.3, 0, 0.75, 0, 0, 0.5)
    bodies.addStaticBox(1, 0.05, 0.3, 2, 0.75, 0, 0, 0.5)
    // the third is a NULL body: thrown, never filed or added
    expect(() => bodies.addStaticBox(1, 0.05, 0.3, 4, 0.75, 0, 0, 0.5)).toThrow(BodyTableFull)
    bodies.end()
    expect(group.bodies.length).toBe(2)
    expect(iface.GetPhysicsSystem().GetNumBodies()).toBe(2)
    // teardown removes only the real bodies
    expect(() => bodies.destroyAll()).not.toThrow()
    expect(iface.GetPhysicsSystem().GetNumBodies()).toBe(0)
    Jolt.destroy(axisY)
    Jolt.destroy(iface)
  })
})
