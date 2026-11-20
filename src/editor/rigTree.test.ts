import { describe, expect, it } from 'vitest'
import { AUTHORABLE_SHAPE_KINDS, canDeleteRigNode, convertShape, defaultShape, isAuthorableShapeKind, flattenRigForest, rigSubtree } from './rigTree'
import type { RigGeometry } from './rigTree'
import type { RigLink, RigShape } from '../core/parts/partPackage'

// flattenRigForest pre-orders a rig's link/joint forest into the flat row list the
// scene tree renders through the unified TreeRow. Pre-order + correct per-row depth is what makes the flat
// render match a nested one.

const link = (name: string, parent?: string): RigLink => ({ name, parent, shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] })

const geom = (links: RigLink[], joints: RigGeometry['joints'] = []): RigGeometry => ({ kind: 'rig', links, joints }) as RigGeometry

describe('flattenRigForest', () => {
  it('pre-orders the forest (parent before its children) with depth = baseDepth + 1 at the roots', () => {
    // base → arm → hand, and a second root 'tool'
    const g = geom([link('base'), link('arm', 'base'), link('hand', 'arm'), link('tool')])
    const rows = flattenRigForest(g, 2)
    expect(rows.map((r) => [r.link.name, r.depth])).toEqual([
      ['base', 3],
      ['arm', 4],
      ['hand', 5],
      ['tool', 3],
    ])
  })

  it('attaches each link’s driving joint (and undefined when none)', () => {
    const g = geom([link('base'), link('arm', 'base')], [{ name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }])
    const rows = flattenRigForest(g, 0)
    expect(rows.find((r) => r.link.name === 'arm')!.joint?.name).toBe('shoulder')
    expect(rows.find((r) => r.link.name === 'base')!.joint).toBeUndefined()
  })

  it('keeps sibling declaration order', () => {
    const g = geom([link('root'), link('c2', 'root'), link('c1', 'root'), link('c3', 'root')])
    expect(flattenRigForest(g, 0).map((r) => r.link.name)).toEqual(['root', 'c2', 'c1', 'c3'])
  })

  it('treats a link with a dangling parent as a root', () => {
    const g = geom([link('a', 'ghost'), link('b', 'a')])
    expect(flattenRigForest(g, 0).map((r) => [r.link.name, r.depth])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })
})

describe('canDeleteRigNode', () => {
  it('refuses a node whose subtree is the whole rig, not only the last node', () => {
    const g = geom([link('base'), link('arm', 'base'), link('hand', 'arm')])
    expect(canDeleteRigNode(g, 'base')).toBe(false) // takes arm and hand with it: nothing would be left
    expect(canDeleteRigNode(g, 'arm')).toBe(true)
    expect(canDeleteRigNode(geom([link('only')]), 'only')).toBe(false)
  })

  it('allows a root while another root remains', () => {
    const g = geom([link('base'), link('pivot'), link('arm', 'pivot')])
    expect(canDeleteRigNode(g, 'base')).toBe(true)
    expect(canDeleteRigNode(g, 'pivot')).toBe(true)
    expect([...rigSubtree(g, 'pivot')].sort()).toEqual(['arm', 'pivot'])
  })
})

// convertShape / defaultShape are the Inspector's shape selector seam: the panel can build four primitives
// from nothing, and switching between them must carry the author's dimensions rather than resetting to a
// default cube. Everything else in the RigShape union is appliance geometry the panel displays but never
// constructs.

describe('authorable shape kinds', () => {
  it('offers exactly the primitives the panel has fields for', () => {
    expect([...AUTHORABLE_SHAPE_KINDS]).toEqual(['box', 'cylinder', 'cone', 'frame'])
  })

  it('rejects the appliance kinds a <select> could otherwise smuggle through', () => {
    expect(isAuthorableShapeKind('cylinder')).toBe(true)
    for (const k of ['roller', 'chain', 'leg', 'deck', 'label', 'mesh', '']) expect(isAuthorableShapeKind(k)).toBe(false)
  })
})

describe('defaultShape', () => {
  it('births every kind at the same 0.3 m envelope', () => {
    expect(defaultShape('box')).toEqual({ kind: 'box', size: [0.3, 0.3, 0.3] })
    expect(defaultShape('cylinder')).toEqual({ kind: 'cylinder', radius: 0.15, height: 0.3 })
    expect(defaultShape('cone')).toEqual({ kind: 'cone', radius: 0.15, height: 0.3 })
    expect(defaultShape('frame')).toEqual({ kind: 'frame' })
  })
})

describe('convertShape', () => {
  it('carries the dimensions across, so a switch keeps the size the author dialled in', () => {
    // a 2 m tall cylinder is still 2 m tall as a box - the whole point of the seam
    expect(convertShape({ kind: 'cylinder', radius: 0.4, height: 2 }, 'box')).toEqual({ kind: 'box', size: [0.8, 2, 0.8] })
    expect(convertShape({ kind: 'box', size: [0.8, 2, 0.8] }, 'cylinder')).toEqual({ kind: 'cylinder', radius: 0.4, height: 2 })
    expect(convertShape({ kind: 'cylinder', radius: 0.4, height: 2 }, 'cone')).toEqual({ kind: 'cone', radius: 0.4, height: 2 })
  })

  it('round-trips a square footprint through a round shape', () => {
    const box: RigShape = { kind: 'box', size: [0.5, 1.2, 0.5] }
    expect(convertShape(convertShape(box, 'cylinder'), 'box')).toEqual(box)
  })

  it('squares off a rectangular footprint on the way through a round shape (a cylinder has no X vs Z)', () => {
    // the documented loss: the wider horizontal extent wins, so nothing silently shrinks
    expect(convertShape({ kind: 'box', size: [1, 0.2, 0.4] }, 'cylinder')).toEqual({ kind: 'cylinder', radius: 0.5, height: 0.2 })
    expect(convertShape(convertShape({ kind: 'box', size: [1, 0.2, 0.4] }, 'cylinder'), 'box')).toEqual({ kind: 'box', size: [1, 0.2, 1] })
  })

  it('drops sizeParams rather than re-indexing them onto the wrong axis', () => {
    // a box entry names the axis it stretches; a cylinder's axis 0 and 2 both mean the radius, so carrying
    // this array across would double-apply. Losing it visibly is better than stretching the wrong dimension.
    const stretched: RigShape = { kind: 'box', size: [1, 0.2, 0.4], sizeParams: [{ axis: 0, param: 'length' }] }
    expect(convertShape(stretched, 'cylinder')).toEqual({ kind: 'cylinder', radius: 0.5, height: 0.2 })
    expect(convertShape(stretched, 'box')).toEqual({ kind: 'box', size: [1, 0.2, 1] })
  })

  it("inherits a mesh link's collision box, the one dimension its package actually declares", () => {
    expect(convertShape({ kind: 'mesh', asset: 'm1' }, 'box', [0.6, 1.4, 0.2])).toEqual({ kind: 'box', size: [0.6, 1.4, 0.6] })
    // no collision box: the GLB's extent lives in the asset, which the panel can't measure - use the default
    expect(convertShape({ kind: 'mesh', asset: 'm1' }, 'box')).toEqual({ kind: 'box', size: [0.3, 0.3, 0.3] })
  })

  it('starts a replacement for an appliance / dimensionless kind at the default size', () => {
    for (const shape of [
      { kind: 'frame' },
      { kind: 'label', text: 'STOP' },
      { kind: 'leg', spanParam: 'length', widthParam: 'width', standParam: 'stand', frameDepth: 0.1 },
    ] as const) {
      expect(convertShape(shape, 'box')).toEqual({ kind: 'box', size: [0.3, 0.3, 0.3] })
    }
  })

  it('drops geometry entirely for a frame (a pure pivot node)', () => {
    expect(convertShape({ kind: 'cylinder', radius: 9, height: 9 }, 'frame')).toEqual({ kind: 'frame' })
  })
})
