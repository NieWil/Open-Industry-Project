import { describe, expect, it } from 'vitest'
import {
  ancestorIds,
  childIdsOf,
  containerAnchor,
  descendantIds,
  effectivelyHiddenSet,
  groupRoot,
  isAncestor,
  orderedTree,
  reseatContainers,
  sanitizeParents,
  subtreeIds,
  wouldCreateCycle,
} from './hierarchy'
import type { PartInstance } from '../types'

/** minimal part with an optional parent; type/params are irrelevant to hierarchy */
function part(id: string, parent?: string, extra?: Partial<PartInstance>): PartInstance {
  return {
    id,
    ...(parent !== undefined ? { parent } : {}),
    ...extra,
    type: 'group',
    position: [0, 0.75, 0],
    rotationY: 0,
    params: {},
  } as PartInstance
}

// a: root; b,c children of a; d child of b; e: root
const tree = () => [part('a'), part('b', 'a'), part('c', 'a'), part('d', 'b'), part('e')]

describe('hierarchy', () => {
  it('childIdsOf returns direct children in array order', () => {
    expect(childIdsOf(tree(), 'a')).toEqual(['b', 'c'])
    expect(childIdsOf(tree(), 'b')).toEqual(['d'])
    expect(childIdsOf(tree(), 'd')).toEqual([])
  })

  it('descendantIds walks the whole subtree depth-first, excluding self', () => {
    expect(descendantIds(tree(), 'a')).toEqual(['b', 'd', 'c'])
    expect(descendantIds(tree(), 'b')).toEqual(['d'])
    expect(descendantIds(tree(), 'e')).toEqual([])
  })

  it('subtreeIds unions ids with descendants in array order, deduped', () => {
    expect(subtreeIds(tree(), ['a'])).toEqual(['a', 'b', 'c', 'd'])
    // overlapping selection (a and its child b) dedupes
    expect(subtreeIds(tree(), ['b', 'a'])).toEqual(['a', 'b', 'c', 'd'])
    expect(subtreeIds(tree(), ['b', 'e'])).toEqual(['b', 'd', 'e'])
  })

  it('isAncestor walks up the parent chain', () => {
    const t = tree()
    expect(isAncestor(t, 'a', 'd')).toBe(true)
    expect(isAncestor(t, 'b', 'd')).toBe(true)
    expect(isAncestor(t, 'a', 'a')).toBe(true) // reflexive
    expect(isAncestor(t, 'c', 'd')).toBe(false)
    expect(isAncestor(t, 'd', 'a')).toBe(false)
  })

  it('ancestorIds walks up the parent chain, nearest first, excluding self', () => {
    const t = tree()
    expect(ancestorIds(t, 'd')).toEqual(['b', 'a'])
    expect(ancestorIds(t, 'b')).toEqual(['a'])
    expect(ancestorIds(t, 'a')).toEqual([]) // root has no ancestors
    expect(ancestorIds(t, 'e')).toEqual([])
  })

  it('ancestorIds is cycle-safe', () => {
    // a <-> b cycle; ancestorIds must terminate
    const cyclic = [part('a', 'b'), part('b', 'a')]
    expect(ancestorIds(cyclic, 'a')).toEqual(['b'])
  })

  // Regression: "Open Part Editor" focus (controller/viewScene.ts focusViewScene) hides every part outside
  // the focused part's keep-set. The keep-set is subtreeIds ∪ ancestorIds; without ancestors
  // a part under a group would have its group hidden, which inherit-hides the part itself.
  it('focus keep-set (subtree ∪ ancestors) keeps a grouped part and its container visible', () => {
    // g = "Robot cell" group; robot child of g; box a separate root (sibling clutter)
    const parts = [part('g'), part('robot', 'g'), part('box')]
    const keep = new Set([...subtreeIds(parts, ['robot']), ...ancestorIds(parts, 'robot')])
    expect(keep.has('robot')).toBe(true)
    expect(keep.has('g')).toBe(true) // the container is kept, so it stays visible
    expect(keep.has('box')).toBe(false) // unrelated clutter is hidden

    // simulate focusViewScene: force non-kept parts hidden, then check inherited visibility
    const focused = parts.map((p) => (keep.has(p.id) ? p : ({ ...p, visible: false })))
    const hidden = effectivelyHiddenSet(focused)
    expect(hidden.has('robot')).toBe(false) // robot stays visible (the bug made it invisible)
    expect(hidden.has('g')).toBe(false)
    expect(hidden.has('box')).toBe(true)
  })

  it('wouldCreateCycle blocks dropping a node into its own subtree', () => {
    const t = tree()
    expect(wouldCreateCycle(t, 'a', 'd')).toBe(true) // a under its descendant d
    expect(wouldCreateCycle(t, 'a', 'a')).toBe(true) // under itself
    expect(wouldCreateCycle(t, 'd', 'e')).toBe(false) // d under unrelated e
    expect(wouldCreateCycle(t, 'b', null)).toBe(false) // to root
  })

  it('sanitizeParents drops dangling and cyclic refs to roots', () => {
    const dangling = sanitizeParents([part('a', 'ghost'), part('b', 'a')])
    expect(dangling.find((p) => p.id === 'a')?.parent).toBeUndefined()
    expect(dangling.find((p) => p.id === 'b')?.parent).toBe('a')

    // a<->b mutual cycle: at least one link is broken so no part is its own ancestor
    const cyclic = sanitizeParents([part('a', 'b'), part('b', 'a')])
    const stillCyclic = cyclic.some((p) => p.parent !== undefined && isAncestor(cyclic, p.id, p.parent))
    expect(stillCyclic).toBe(false)
  })

  it('sanitizeParents returns the same array (no copy) when everything is valid', () => {
    const t = tree()
    expect(sanitizeParents(t)).toEqual(t)
  })

  it('orderedTree walks roots then subtrees with depth + hasChildren', () => {
    const rows = orderedTree(tree())
    expect(rows.map((r) => `${r.part.id}@${r.depth}${r.hasChildren ? '+' : ''}`)).toEqual([
      'a@0+',
      'b@1+',
      'd@2',
      'c@1',
      'e@0',
    ])
  })

  it('orderedTree prunes a collapsed subtree but keeps hasChildren', () => {
    const rows = orderedTree(tree(), (id) => id === 'b')
    expect(rows.map((r) => r.part.id)).toEqual(['a', 'b', 'c', 'e']) // d hidden under collapsed b
    expect(rows.find((r) => r.part.id === 'b')?.hasChildren).toBe(true)
  })

  it('groupRoot redirects a click to the topmost grouped ancestor', () => {
    // a grouped; b child of a; d grandchild; c child of a (ungrouped group)
    const grouped = [part('a', undefined, { grouped: true }), part('b', 'a'), part('d', 'b'), part('c', 'a')]
    expect(groupRoot(grouped, 'd')).toBe('a') // descendant -> group root
    expect(groupRoot(grouped, 'b')).toBe('a')
    expect(groupRoot(grouped, 'a')).toBe('a') // the group itself
    // nested groups: the topmost grouped ancestor wins
    const nested = [part('a', undefined, { grouped: true }), part('b', 'a', { grouped: true }), part('d', 'b')]
    expect(groupRoot(nested, 'd')).toBe('a')
    // nothing grouped -> the clicked id is returned unchanged
    expect(groupRoot(tree(), 'd')).toBe('d')
  })

  // `part` above pins every position to [0,0.75,0]; these need real ones
  const at = (id: string, position: [number, number, number], parent?: string): PartInstance =>
    ({ ...part(id, parent), position }) as PartInstance

  it('containerAnchor centres a container on its members', () => {
    expect(containerAnchor([at('a', [0, 0, 0]), at('b', [4, 2, -6])])).toEqual([2, 1, -3])
    expect(containerAnchor([at('a', [3, 1, 5])])).toEqual([3, 1, 5]) // lone member: on it
    expect(containerAnchor([])).toBeNull() // nothing to centre on
  })

  it('reseatContainers seats each container on its children, deepest first', () => {
    // outer > inner > two leaves; both containers authored at a meaningless origin
    const parts = [
      at('outer', [99, 99, 99]),
      at('inner', [99, 99, 99], 'outer'),
      at('leaf1', [0, 0, 0], 'inner'),
      at('leaf2', [4, 0, 8], 'inner'),
      at('leaf3', [10, 0, 0], 'outer'),
    ]
    const isContainer = (p: PartInstance) => p.id === 'outer' || p.id === 'inner'
    const seated = reseatContainers(parts, isContainer)
    const byId = new Map(seated.map((p) => [p.id, p]))
    expect(byId.get('inner')?.position).toEqual([2, 0, 4]) // centroid of leaf1/leaf2
    // outer sees inner already re-seated (deepest first), so it centres on [2,0,4] and leaf3
    expect(byId.get('outer')?.position).toEqual([6, 0, 2])
    // members never move - soft parenting keeps positions world-space
    expect(byId.get('leaf1')?.position).toEqual([0, 0, 0])
    expect(byId.get('leaf2')?.position).toEqual([4, 0, 8])
  })

  it('reseatContainers leaves a childless container where it was authored', () => {
    const parts = [at('empty', [7, 0, 7]), at('leaf', [1, 0, 1])]
    const seated = reseatContainers(parts, (p) => p.id === 'empty')
    expect(seated.find((p) => p.id === 'empty')?.position).toEqual([7, 0, 7])
  })

  it('reseatContainers is cycle-safe', () => {
    const cyclic = [part('a', 'b'), part('b', 'a')]
    expect(() => reseatContainers(cyclic, () => true)).not.toThrow()
  })

  it('effectivelyHiddenSet inherits hidden down the tree', () => {
    // a hidden; b child of a; d grandchild; c visible root; e child of c
    const parts = [
      part('a', undefined, { visible: false }),
      part('b', 'a'),
      part('d', 'b'),
      part('c'),
      part('e', 'c'),
    ]
    const hidden = effectivelyHiddenSet(parts)
    expect([...hidden].sort()).toEqual(['a', 'b', 'd']) // a and its whole subtree
    expect(hidden.has('c')).toBe(false)
    expect(hidden.has('e')).toBe(false)
    // a child's own visible flag doesn't un-hide it under a hidden parent
    expect(effectivelyHiddenSet([part('a', undefined, { visible: false }), part('b', 'a')]).has('b')).toBe(true)
  })

  it('orderedTree renders a dangling-parent part as a root and is cycle-safe', () => {
    // 'x' points at a missing parent -> treated as root; mutual cycle won't infinite-loop
    expect(orderedTree([part('x', 'missing')]).map((r) => r.part.id)).toEqual(['x'])
    const cyc = orderedTree([part('a', 'b'), part('b', 'a')])
    expect(cyc.length).toBe(2)
  })
})
