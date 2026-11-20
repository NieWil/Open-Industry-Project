import { describe, expect, it } from 'vitest'
import { fitRigToModel, MODEL_COLLIDER } from './modelFit'
import type { RigGeometry } from './partPackage'

const mesh = { kind: 'mesh' as const, asset: 'mesh-1' }
/** a blank part's rig after an import: its one node, now a mesh, still at the old box's offset */
const single: RigGeometry = { kind: 'rig', links: [{ name: 'body', shape: mesh, offset: [0, 0.3, 0] }], joints: [] }
const box = { min: [1, 0.5, -0.2], max: [1.4, 0.9, 0.2] } // 0.4 x 0.4 x 0.4, off-centre and raised

describe('fitRigToModel', () => {
  it('stands the model on the origin, adds a collider of its size and declares its bounds', () => {
    const fit = fitRigToModel(single, 'body', box)!
    expect(fit.links[0]!.offset.map((v) => +v.toFixed(6))).toEqual([-1.2, -0.5, 0])
    expect(fit.links[1]).toEqual({ name: MODEL_COLLIDER, shape: { kind: 'box', size: [0.4, 0.4, 0.4].map((v) => expect.closeTo(v, 6)) }, offset: [0, expect.closeTo(0.2, 6), 0], hidden: true })
    expect(fit.bounds).toEqual({ length: expect.closeTo(0.4, 6), width: expect.closeTo(0.4, 6), top: expect.closeTo(0.4, 6) })
  })

  it('refits a part an earlier import fitted: the collider is replaced, not added again', () => {
    const once = fitRigToModel(single, 'body', box)!
    const twice = fitRigToModel(once, 'body', { min: [-1, 0, -0.5], max: [1, 2, 0.5] })!
    expect(twice.links.map((l) => l.name)).toEqual(['body', MODEL_COLLIDER])
    expect(twice.bounds).toEqual({ length: 2, width: 1, top: 2 })
  })

  it('gives a flat model a collider it can stand on', () => {
    const fit = fitRigToModel(single, 'body', { min: [-1, 0, -1], max: [1, 0, 1] })!
    expect((fit.links[1]!.shape as { size: number[] }).size[1]).toBe(0.01)
  })

  it("leaves the author's arrangement alone", () => {
    const withChild: RigGeometry = { ...single, links: [...single.links, { name: 'lamp', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 1, 0] }] }
    const jointed: RigGeometry = { ...single, joints: [{ name: 'lift', link: 'body', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 1 }] }
    const turned: RigGeometry = { ...single, links: [{ ...single.links[0]!, rotation: [0, Math.PI / 2, 0] }] }
    const sized: RigGeometry = { ...single, bounds: { length: 1, width: 1, top: 1, params: [{ field: 'length', param: 'len' }] } }
    const visibleCollider: RigGeometry = { ...single, links: [...single.links, { name: MODEL_COLLIDER, shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0.5, 0] }] }
    for (const g of [withChild, jointed, turned, sized, visibleCollider]) expect(fitRigToModel(g, 'body', box)).toBeNull()
    expect(fitRigToModel(single, 'missing', box)).toBeNull()
  })
})
