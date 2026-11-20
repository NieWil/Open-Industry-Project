import { describe, expect, it } from 'vitest'
import { keptNodes, mergeRigPiece, movingPartCentre, releaseKeptNodes, reparentRigLink, reparentTargets, rigPivot, setRigPivot, splitRigNode, splitSourcesFor } from './rigSplit'
import type { RigGeometry } from './rigTree'
import type { RigJoint, RigLink } from '../core/parts/partPackage'

const model = (name: string, extra: Partial<RigLink> = {}): RigLink => ({ name, shape: { kind: 'mesh', asset: 'mesh-1' }, offset: [0, 0.4, 0], ...extra })
const geom = (links: RigLink[], joints: RigJoint[] = []): RigGeometry => ({ kind: 'rig', links, joints }) as RigGeometry
const linkOf = (g: RigGeometry, name: string): RigLink => g.links.find((l) => l.name === name)!

describe('splitRigNode', () => {
  it('keeps the node alone on a new child at the source frame, leaving the source as it is', () => {
    const out = splitRigNode(geom([model('body')]), 'body', 'Motors', 'body')!
    expect(out.name).toBe('Motors')
    // the source stops drawing it because the piece keeps it (glbBox drawnElsewhere), not through hideNodes
    expect(linkOf(out.geometry, 'body').shape).toEqual({ kind: 'mesh', asset: 'mesh-1' })
    expect(keptNodes(out.geometry, 'mesh-1')).toEqual(new Set(['Motors']))
    expect(linkOf(out.geometry, 'Motors')).toEqual({ name: 'Motors', parent: 'body', shape: { kind: 'mesh', asset: 'mesh-1', keepNode: 'Motors' }, offset: [0, 0, 0] })
  })

  it('carries the source scale, fit and materials so the piece lines up', () => {
    const body = model('body', { shape: { kind: 'mesh', asset: 'm', scale: 0.001, fitHeight: 1, material: 'steel', materials: { a: 'b' } } })
    const piece = linkOf(splitRigNode(geom([body]), 'body', 'Bit', 'body')!.geometry, 'Bit')
    expect(piece.shape).toEqual({ kind: 'mesh', asset: 'm', keepNode: 'Bit', scale: 0.001, fitHeight: 1, material: 'steel', materials: { a: 'b' } })
  })

  it('groups a second piece under the first, undoing the offsets between them', () => {
    const one = splitRigNode(geom([model('body')]), 'body', 'Motors', 'body')!.geometry
    const moved = { ...one, links: one.links.map((l) => (l.name === 'Motors' ? { ...l, offset: [0.1, 0, -0.2] as [number, number, number] } : l)) }
    const two = splitRigNode(moved, 'body', 'Bit', 'Motors')!
    expect(linkOf(two.geometry, 'Bit').offset).toEqual([-0.1, 0, 0.2])
    expect(keptNodes(two.geometry, 'mesh-1')).toEqual(new Set(['Motors', 'Bit']))
  })

  it('splits a node from inside a piece already split, under that piece', () => {
    // Bit is a child of Motors in the GLB: Motors keeps it until Bit is split out, then drawnElsewhere leaves it out
    const one = splitRigNode(geom([model('body')]), 'body', 'Motors', 'body')!.geometry
    const two = splitRigNode(one, 'body', 'Bit', 'Motors')!
    expect(linkOf(two.geometry, 'Bit')).toMatchObject({ parent: 'Motors', shape: { keepNode: 'Bit' } })
    expect(linkOf(two.geometry, 'Motors').shape).toEqual({ kind: 'mesh', asset: 'mesh-1', keepNode: 'Motors' })
  })

  it('names the new link apart from an existing one', () => {
    const g = geom([model('body'), { name: 'Bit', shape: { kind: 'frame' }, offset: [0, 0, 0] }])
    expect(splitRigNode(g, 'body', 'Bit', 'body')!.name).toBe('Bit-2')
  })

  it('refuses a node already split, a non-scene mesh and a rotated link in between', () => {
    const once = splitRigNode(geom([model('body')]), 'body', 'Bit', 'body')!.geometry
    expect(splitRigNode(once, 'body', 'Bit', 'body')).toBeNull()
    expect(splitRigNode(geom([model('body', { shape: { kind: 'mesh', asset: 'm', node: 'Case' } })]), 'body', 'Bit', 'body')).toBeNull()
    const rotated = geom([model('body'), { name: 'arm', parent: 'body', shape: { kind: 'frame' }, offset: [0, 0, 0], rotation: [0, 1, 0] }])
    expect(splitRigNode(rotated, 'body', 'Bit', 'arm')).toBeNull()
  })
})

describe('splitSourcesFor', () => {
  it('offers the link itself and whole-scene ancestors it lines up with', () => {
    const g = splitRigNode(geom([model('body')]), 'body', 'Motors', 'body')!.geometry
    expect(splitSourcesFor(g, 'body').map((l) => l.name)).toEqual(['body'])
    expect(splitSourcesFor(g, 'Motors').map((l) => l.name)).toEqual(['body'])
  })

  it('offers nothing past a rotated link', () => {
    const g = geom([model('body'), { name: 'arm', parent: 'body', shape: { kind: 'frame' }, offset: [0, 0, 0], rotation: [0, 0.5, 0] }])
    expect(splitSourcesFor(g, 'arm')).toEqual([])
  })
})

describe('setRigPivot', () => {
  const hinge: RigJoint = { name: 'swing', link: 'Arm', type: 'revolute', axis: [0, 0, 1], min: -1, max: 1 }

  it('inserts a frame at the pivot for a mesh link and moves the joint onto it, keeping the mesh in place', () => {
    const g = splitRigNode(geom([model('body')]), 'body', 'Arm', 'body')!.geometry
    const out = setRigPivot({ ...g, joints: [hinge] }, 'Arm', [0.2, 0.5, 0])!
    const near = (a: readonly number[] | null, b: readonly number[]): void => b.forEach((v, k) => expect(a![k]).toBeCloseTo(v))
    expect(out.jointLink).toBe('Arm-pivot')
    expect(linkOf(out.geometry, 'Arm-pivot')).toMatchObject({ name: 'Arm-pivot', parent: 'body', shape: { kind: 'frame' } })
    near(linkOf(out.geometry, 'Arm-pivot').offset, [0.2, 0.1, 0])
    expect(linkOf(out.geometry, 'Arm').parent).toBe('Arm-pivot')
    near(linkOf(out.geometry, 'Arm').offset, [-0.2, -0.1, 0])
    expect(out.geometry.joints).toEqual([{ ...hinge, link: 'Arm-pivot' }])
    near(rigPivot(out.geometry, 'Arm-pivot'), [0.2, 0.5, 0])
    // the mesh's own frame is where it was
    near(rigPivot(out.geometry, 'Arm'), rigPivot(g, 'Arm')!)
  })

  it('moves a frame and shifts its children back', () => {
    const g = geom(
      [model('body'), { name: 'f', parent: 'body', shape: { kind: 'frame' }, offset: [0.2, 0.1, 0] }, { name: 'Arm', parent: 'f', shape: { kind: 'mesh', asset: 'mesh-1', keepNode: 'Arm' }, offset: [-0.2, -0.1, 0] }],
      [{ ...hinge, link: 'f' }],
    )
    const out = setRigPivot(g, 'f', [0.3, 0.5, 0])!
    expect(out.jointLink).toBe('f')
    expect(linkOf(out.geometry, 'f').offset[0]).toBeCloseTo(0.3)
    expect(linkOf(out.geometry, 'Arm').offset[0]).toBeCloseTo(-0.3)
    expect(rigPivot(out.geometry, 'Arm')![0]).toBeCloseTo(0)
  })

  it('refuses a link with no joint', () => {
    expect(setRigPivot(geom([model('body')]), 'body', [0, 0, 0])).toBeNull()
  })
})

describe('mergeRigPiece', () => {
  it('puts the node back into the model and removes the piece with its joint', () => {
    const g = splitRigNode(geom([model('body')]), 'body', 'Bit', 'body')!.geometry
    const out = mergeRigPiece({ ...g, joints: [{ name: 'spin', link: 'Bit', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }] }, 'Bit')!
    expect(out.select).toBe('body')
    expect(out.geometry.links).toEqual([model('body')])
    expect(out.geometry.joints).toEqual([])
  })

  it('moves its children up and keeps them in place, removing a pivot frame it leaves empty', () => {
    let g = splitRigNode(geom([model('body')]), 'body', 'Motors', 'body')!.geometry
    g = splitRigNode(g, 'body', 'Bit', 'Motors')!.geometry
    g = setRigPivot({ ...g, joints: [{ name: 'turn', link: 'Motors', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }] }, 'Motors', [0.1, 0.6, 0])!.geometry
    const before = rigPivot(g, 'Bit')!
    const out = mergeRigPiece(g, 'Motors')!.geometry
    expect(out.links.map((l) => l.name)).toEqual(['body', 'Bit'])
    expect(linkOf(out, 'Bit').parent).toBe('body')
    rigPivot(out, 'Bit')!.forEach((v, k) => expect(v).toBeCloseTo(before[k]!))
    expect(out.joints).toEqual([])
  })

  it('takes the node out of the model hideNodes, as a part split before pieces were derived lists it', () => {
    const g = geom([model('body', { shape: { kind: 'mesh', asset: 'mesh-1', hideNodes: ['Bit', 'Screw'] } }), { name: 'Bit', parent: 'body', shape: { kind: 'mesh', asset: 'mesh-1', keepNode: 'Bit' }, offset: [0, 0, 0] }])
    const out = mergeRigPiece(g, 'Bit')!
    expect(out.select).toBe('body')
    expect(linkOf(out.geometry, 'body').shape).toEqual({ kind: 'mesh', asset: 'mesh-1', hideNodes: ['Screw'] })
  })

  it('refuses a node that is not a split piece', () => {
    expect(mergeRigPiece(geom([model('body')]), 'body')).toBeNull()
  })
})

describe('releaseKeptNodes', () => {
  it('drops a node a removed piece kept from hideNodes on its asset only, and the list when it empties', () => {
    const links: RigLink[] = [
      model('body', { shape: { kind: 'mesh', asset: 'mesh-1', hideNodes: ['Bit'] } }),
      { name: 'other', shape: { kind: 'mesh', asset: 'mesh-2', hideNodes: ['Bit'] }, offset: [0, 0, 0] },
    ]
    const bit: RigLink = { name: 'Bit', parent: 'body', shape: { kind: 'mesh', asset: 'mesh-1', keepNode: 'Bit' }, offset: [0, 0, 0] }
    const out = releaseKeptNodes(links, [bit])
    expect(out[0]!.shape).toEqual({ kind: 'mesh', asset: 'mesh-1' })
    expect(out[1]).toBe(links[1])
  })
})

describe('reparentRigLink', () => {
  it('moves a node under another and keeps it in place', () => {
    let g = splitRigNode(geom([model('body')]), 'body', 'Motors', 'body')!.geometry
    g = splitRigNode(g, 'body', 'Bit', 'body')!.geometry
    g = { ...g, links: g.links.map((l) => (l.name === 'Motors' ? { ...l, offset: [0, 0.1, 0] as [number, number, number] } : l)) }
    const out = reparentRigLink(g, 'Bit', 'Motors')!
    expect(linkOf(out, 'Bit')).toMatchObject({ parent: 'Motors' })
    expect(linkOf(out, 'Bit').offset[1]).toBeCloseTo(-0.1)
    expect(rigPivot(out, 'Bit')![1]).toBeCloseTo(rigPivot(g, 'Bit')![1])
  })

  it('moves a node to the root', () => {
    const g = splitRigNode(geom([model('body')]), 'body', 'Bit', 'body')!.geometry
    const bit = linkOf(reparentRigLink(g, 'Bit', undefined)!, 'Bit')
    expect(bit.parent).toBeUndefined()
    expect(bit.offset).toEqual([0, 0.4, 0])
  })

  it('never offers a node inside its own subtree', () => {
    let g = splitRigNode(geom([model('body')]), 'body', 'Motors', 'body')!.geometry
    g = splitRigNode(g, 'body', 'Bit', 'Motors')!.geometry
    expect(reparentTargets(g, 'Motors')).toEqual([undefined, 'body'])
    expect(reparentRigLink(g, 'Motors', 'Bit')).toBeNull()
  })
})

describe('movingPartCentre', () => {
  it('unions the mesh boxes in the subtree in part coordinates', () => {
    const g = geom([
      model('body'),
      { name: 'head', parent: 'body', shape: { kind: 'frame' }, offset: [0, 0, 0] },
      { name: 'a', parent: 'head', shape: { kind: 'mesh', asset: 'm', keepNode: 'a' }, offset: [0, 0, 0] },
      { name: 'b', parent: 'head', shape: { kind: 'mesh', asset: 'm', keepNode: 'b' }, offset: [0, 0, 0] },
    ])
    const boxes: Record<string, { min: number[]; max: number[] }> = { a: { min: [0, 0, 0], max: [0.2, 0.2, 0.2] }, b: { min: [0.4, 0, 0], max: [0.6, 0.2, 0.2] } }
    expect(movingPartCentre(g, 'head', (l) => boxes[l.name] ?? null)).toEqual([0.3, 0.5, 0.1])
  })
})
