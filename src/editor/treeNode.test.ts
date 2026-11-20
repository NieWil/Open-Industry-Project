import { describe, expect, it, vi } from 'vitest'
import { buildTreeNode, buildTreeNodes, matchesTreeFilter, placedCopiesOf, sessionDefinitionScope } from './treeNode'
import { rigNodeKey } from './store/store'
import type { TreeNodeController, TreeNodeSource, TreeNodeStore } from './treeNode'
import type { EditorState } from './store/store'
import type { PartInstance } from '../core/types'
import type { RigLink } from '../core/parts/partPackage'
import type { RigGeometry } from './rigTree'

// The kind-erased TreeNode adapter of the unified scene-tree node model. These specs pin the two axes that
// matter - capabilities (per kind) and scope (scene vs definition, with the count of instances an edit
// reaches) - and that each action dispatches to the right
// store/controller method. Pure model; no UI.

// A minimal state holding only the fields the model reads (selection, parts, rig selection/locks, and the
// session fields editTarget derives scope from). Not a real EditorStore - the model is pure, so
// building the whole store (localStorage/prefab side effects) would only add fragility to a unit test.
function stateWith(over: Partial<EditorState>): EditorState {
  const base = {
    selectedIds: [] as string[],
    selectedRigNode: null,
    lockedRigNodes: new Set<string>(),
    packageEdit: null,
    focusedPartId: null,
  }
  return { ...base, ...over, scene: { version: 1, parts: [], ...(over.scene ?? {}) } } as unknown as EditorState
}

const sdkPart = (over: Partial<PartInstance> & { packageId?: string } = {}): PartInstance =>
  ({ id: 'cp_1', type: 'part', packageId: 'pkg.a', position: [0, 0, 0], rotation: [0, 0, 0], params: {}, ...over }) as unknown as PartInstance

const link = (over: Partial<RigLink> = {}): RigLink => ({ name: 'arm', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0], ...over })

const rigGeom = (links: RigLink[]): RigGeometry => ({ kind: 'rig', links, joints: [] }) as RigGeometry

function fakeStore(): TreeNodeStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    rename: vi.fn(),
    setVisible: vi.fn(),
    setLocked: vi.fn(),
    selectMany: vi.fn(),
    deleteSelection: vi.fn(),
    setRigNodeLocked: vi.fn(),
  }
}
function fakeController(): TreeNodeController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    renameRigNode: vi.fn(() => true),
    addRigNode: vi.fn(),
    deleteRigNode: vi.fn(),
    setRigLinkHidden: vi.fn(),
  }
}

const partSrc = (part: PartInstance, depth = 0): TreeNodeSource => ({ kind: 'part', part, depth })
const rigSrc = (partId: string, l: RigLink, geometry: RigGeometry, depth = 1): TreeNodeSource => ({ kind: 'rigLink', partId, link: l, geometry, depth })

describe('TreeNode - scene part adapter', () => {
  it('exposes part capabilities + label/flags, and is scene-scoped at the base scene', () => {
    const part = sdkPart({ name: 'Robot', visible: false, locked: true })
    const state = stateWith({ scene: { parts: [part] } as EditorState['scene'], selectedIds: ['cp_1'] })
    const n = buildTreeNode(partSrc(part), state, { store: fakeStore(), controller: fakeController() })

    expect(n.kind).toBe('part')
    expect(n.label).toBe('Robot')
    expect(n.scope).toBe('scene')
    expect(n.instancesAffected).toBe(0)
    expect(n.caps).toMatchObject({ rename: true, reparent: true, reorder: true, delete: true, hide: true, lock: true, addChild: false, openScene: true })
    expect(n.flags).toEqual({ hidden: true, locked: true, selected: true })
  })

  it('labels an unnamed part by its type (not its raw id) and reports openScene=false for a non-custom part', () => {
    const grp = { id: 'b1', type: 'group', position: [0, 0, 0], rotation: [0, 0, 0], params: {} } as unknown as PartInstance
    const state = stateWith({ scene: { parts: [grp] } as EditorState['scene'] })
    const n = buildTreeNode(partSrc(grp), state, { store: fakeStore(), controller: null })
    expect(n.label).toBe('Group') // PART_DEFS.group.label, not "b1"
    expect(n.caps.openScene).toBe(false)
  })

  it('numbers unnamed same-type siblings with an auto suffix (1 = no suffix), and a real name still wins', () => {
    const a = { id: 'b1', type: 'group', position: [0, 0, 0], rotation: [0, 0, 0], params: {} } as unknown as PartInstance
    const b = { id: 'b2', type: 'group', position: [0, 0, 0], rotation: [0, 0, 0], params: {} } as unknown as PartInstance
    const named = { id: 'b3', type: 'group', name: 'Crate', position: [0, 0, 0], rotation: [0, 0, 0], params: {} } as unknown as PartInstance
    const state = stateWith({ scene: { parts: [a, b, named] } as EditorState['scene'] })
    const deps = { store: fakeStore(), controller: null }
    expect(buildTreeNode(partSrc(a), state, deps).label).toBe('Group')
    expect(buildTreeNode(partSrc(b), state, deps).label).toBe('Group 2')
    expect(buildTreeNode(partSrc(named), state, deps).label).toBe('Crate')
  })

  it('routes part actions to the store (rename / hide-as-negated-visible / lock / select-then-delete)', () => {
    const part = sdkPart()
    const store = fakeStore()
    const state = stateWith({ scene: { parts: [part] } as EditorState['scene'] })
    const n = buildTreeNode(partSrc(part), state, { store, controller: null })

    n.commitRename('NewName')
    expect(store.rename).toHaveBeenCalledWith('cp_1', 'NewName')
    n.setHidden(true)
    expect(store.setVisible).toHaveBeenCalledWith(['cp_1'], false) // hidden=true → visible=false
    n.setLocked(true)
    expect(store.setLocked).toHaveBeenCalledWith(['cp_1'], true)
    n.delete()
    expect(store.selectMany).toHaveBeenCalledWith(['cp_1'])
    expect(store.deleteSelection).toHaveBeenCalled()
    n.addChild() // no-op for a part
    expect(store.rename).toHaveBeenCalledTimes(1)
  })

  it('is definition-scoped inside a package edit, counting the other instances of the package (as the banner does)', () => {
    const a1 = sdkPart({ id: 'a1', packageId: 'pkg.a' })
    const a2 = sdkPart({ id: 'a2', packageId: 'pkg.a' })
    const b1 = sdkPart({ id: 'b1', packageId: 'pkg.b' })
    // the session's own scene holds just its draft; the placements are in the parked document
    const state = stateWith({
      scene: { parts: [a1] } as EditorState['scene'],
      packageEdit: { packageId: 'pkg.a', partId: 'a1', document: { parts: [a2, b1] } } as EditorState['packageEdit'],
      focusedPartId: 'a1',
    })
    const n = buildTreeNode(partSrc(a1), state, { store: fakeStore(), controller: null })
    expect(n.scope).toBe('definition')
    expect(n.instancesAffected).toBe(1) // a1 is the session's draft; only a2 updates on save
    expect(n.instancesAffected).toBe(sessionDefinitionScope(state)!.instancesAffected)
  })
})

describe('matchesTreeFilter', () => {
  const q = (s: string) => s.trim().toLowerCase()

  it('finds a part by the label its row shows, numbered or not', () => {
    const p = sdkPart({ id: 'cp_7' })
    expect(matchesTreeFilter(p, 'Belt Conveyor 2', q('belt conveyor 2'))).toBe(true)
    expect(matchesTreeFilter(p, 'Belt Conveyor 2', q('Conveyor 2'))).toBe(true)
    expect(matchesTreeFilter(p, 'Belt Conveyor', q('conveyor 2'))).toBe(false)
  })

  it('still finds a part by its id and its category', () => {
    const p = sdkPart({ id: 'cp_7' })
    expect(matchesTreeFilter(p, 'Infeed', q('CP_7'))).toBe(true)
    expect(matchesTreeFilter(p, 'Infeed', q('zzz'))).toBe(false)
  })
})

describe('TreeNode - rig link adapter', () => {
  const owner = sdkPart({ id: 'cp_1', packageId: 'pkg.a' })
  const twin = sdkPart({ id: 'cp_2', packageId: 'pkg.a' }) // a second instance of the same package
  const geom = rigGeom([link({ name: 'base' }), link({ name: 'arm', parent: 'base' })])

  function rigState(over: Partial<EditorState> = {}) {
    return stateWith({ scene: { parts: [owner, twin] } as EditorState['scene'], ...over })
  }

  it('is always definition-scoped, counts package instances, and exposes rig capabilities', () => {
    const state = rigState()
    const n = buildTreeNode(rigSrc('cp_1', link({ name: 'arm', parent: 'base' }), geom), state, { store: fakeStore(), controller: fakeController() })
    expect(n.kind).toBe('rigLink')
    expect(n.label).toBe('arm')
    expect(n.key).toContain('arm')
    expect(n.scope).toBe('definition')
    expect(n.instancesAffected).toBe(2) // both cp_1 and cp_2 use pkg.a
    expect(n.caps).toMatchObject({ rename: true, reparent: false, reorder: false, delete: true, hide: true, lock: true, addChild: true, openScene: false })
  })

  it('leaves a package-edit session’s own throwaway out of the count, as the session banner does', () => {
    // cp_1 is the session's draft, in the session's own scene; only cp_2, in the parked document, is a placement
    const base = rigState()
    const document = { ...base.scene, parts: base.scene.parts.filter((p) => p.id !== 'cp_1') }
    const state = rigState({ scene: { ...base.scene, parts: base.scene.parts.filter((p) => p.id === 'cp_1') }, packageEdit: { packageId: 'pkg.a', partId: 'cp_1', document }, focusedPartId: 'cp_1' })
    const n = buildTreeNode(rigSrc('cp_1', link({ name: 'arm', parent: 'base' }), geom), state, { store: fakeStore(), controller: fakeController() })
    expect(n.instancesAffected).toBe(1)
    expect(n.instancesAffected).toBe(placedCopiesOf(state, 'pkg.a'))
    expect(n.instancesAffected).toBe(sessionDefinitionScope(state)!.instancesAffected)
  })

  it('disables delete for the rig’s last remaining node', () => {
    const onlyGeom = rigGeom([link({ name: 'base' })])
    const n = buildTreeNode(rigSrc('cp_1', link({ name: 'base' }), onlyGeom), rigState(), { store: fakeStore(), controller: fakeController() })
    expect(n.caps.delete).toBe(false)
  })

  it('reads hidden/locked/selected flags from the link + editor state', () => {
    const state = rigState({
      lockedRigNodes: new Set([rigNodeKey('cp_1', 'arm')]),
      selectedRigNode: { partId: 'cp_1', linkName: 'arm' } as EditorState['selectedRigNode'],
    })
    const n = buildTreeNode(rigSrc('cp_1', link({ name: 'arm', hidden: true }), geom), state, { store: fakeStore(), controller: fakeController() })
    expect(n.flags).toEqual({ hidden: true, locked: true, selected: true })
  })

  it('routes rig actions to the controller package edits (+ store for the editor-only lock)', () => {
    const store = fakeStore()
    const controller = fakeController()
    const confirm = vi.fn(() => true)
    const n = buildTreeNode(rigSrc('cp_1', link({ name: 'arm' }), geom), rigState(), { store, controller })

    n.commitRename('forearm', confirm)
    expect(controller.renameRigNode).toHaveBeenCalledWith('pkg.a', 'arm', 'forearm', confirm)
    n.setHidden(true)
    expect(controller.setRigLinkHidden).toHaveBeenCalledWith('pkg.a', 'arm', true)
    n.addChild()
    expect(controller.addRigNode).toHaveBeenCalledWith('pkg.a', 'arm')
    n.delete()
    expect(controller.deleteRigNode).toHaveBeenCalledWith('pkg.a', 'arm')
    n.setLocked(true) // editor-only lock lives on the store, keyed by partId+linkName
    expect(store.setRigNodeLocked).toHaveBeenCalledWith('cp_1', 'arm', true)
  })

  it('no-ops rig package edits when there is no controller (e.g. tests)', () => {
    const store = fakeStore()
    const n = buildTreeNode(rigSrc('cp_1', link({ name: 'arm' }), geom), rigState(), { store, controller: null })
    expect(() => {
      n.commitRename('x')
      n.setHidden(true)
      n.addChild()
      n.delete()
    }).not.toThrow()
    n.setLocked(true) // still works - it's a store op, not a controller op
    expect(store.setRigNodeLocked).toHaveBeenCalledWith('cp_1', 'arm', true)
  })

  it('no-ops package edits when the owning part is missing / not custom', () => {
    const controller = fakeController()
    const state = stateWith({ scene: { parts: [] } as unknown as EditorState['scene'] }) // owner cp_1 absent
    const n = buildTreeNode(rigSrc('cp_1', link({ name: 'arm' }), geom), state, { store: fakeStore(), controller })
    n.commitRename('x')
    n.delete()
    expect(controller.renameRigNode).not.toHaveBeenCalled()
    expect(controller.deleteRigNode).not.toHaveBeenCalled()
    expect(n.instancesAffected).toBe(0)
  })
})

describe('buildTreeNodes', () => {
  it('maps an ordered source list to TreeNodes, preserving order + depth', () => {
    const part = sdkPart({ id: 'cp_1' })
    const geom = rigGeom([link({ name: 'base' }), link({ name: 'arm', parent: 'base' })])
    const state = stateWith({ scene: { parts: [part] } as EditorState['scene'] })
    const nodes = buildTreeNodes(
      [partSrc(part, 0), rigSrc('cp_1', link({ name: 'base' }), geom, 1), rigSrc('cp_1', link({ name: 'arm', parent: 'base' }), geom, 2)],
      state,
      { store: fakeStore(), controller: fakeController() },
    )
    expect(nodes.map((n) => [n.kind, n.label, n.depth])).toEqual([
      ['part', 'Part', 0], // unnamed custom part, package 'pkg.a' unregistered → generic 'Part'
      ['rigLink', 'base', 1],
      ['rigLink', 'arm', 2],
    ])
  })
})

describe('sessionDefinitionScope (the banner blast radius)', () => {
  it('is null at the base scene and in a plain part-focus (inspecting one placement)', () => {
    expect(sessionDefinitionScope(stateWith({}))).toBeNull()
    expect(sessionDefinitionScope(stateWith({ focusedPartId: 'cp_1' }))).toBeNull()
  })

  it('reports a package-edit session, counting package instances and excluding the draft', () => {
    // 'tw' is the package-edit draft; a1/a2 are the real placements that update on save
    const parts = [sdkPart({ id: 'tw', packageId: 'pkg.a' }), sdkPart({ id: 'a1', packageId: 'pkg.a' }), sdkPart({ id: 'a2', packageId: 'pkg.a' }), sdkPart({ id: 'b1', packageId: 'pkg.b' })]
    const state = stateWith({
      scene: { parts } as EditorState['scene'],
      packageEdit: { packageId: 'pkg.a', partId: 'tw' } as EditorState['packageEdit'],
      focusedPartId: 'tw',
    })
    expect(sessionDefinitionScope(state)).toEqual({ kind: 'package', ref: 'pkg.a', instancesAffected: 2 })
  })

  it('reports zero instances for a package opened with no durable placements (Catalog ✎ on an unplaced part)', () => {
    // only the draft 'tw' exists; it's the focused throwaway, so it's excluded → 0 durable instances
    const state = stateWith({
      scene: { parts: [sdkPart({ id: 'tw', packageId: 'pkg.x' })] } as EditorState['scene'],
      packageEdit: { packageId: 'pkg.x', partId: 'tw' } as EditorState['packageEdit'],
      focusedPartId: 'tw',
    })
    expect(sessionDefinitionScope(state)).toEqual({ kind: 'package', ref: 'pkg.x', instancesAffected: 0 })
  })
})
