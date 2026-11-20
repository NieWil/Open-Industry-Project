// The unified scene-tree node model: one editor view-model that adapts the two underlying node kinds - a
// scene `PartInstance` and a rig `RigLink` - behind a single shape. The dock's context menu
// (SceneTreeMenu) builds a `TreeNode` for the right-clicked row and gates its items on `caps`; the rows
// themselves still take primitives (a freshly built node per render would defeat TreeRow's memo).
//
// This module is pure + author-time: no DOM/three/Jolt, no sim/render touch. It does not change the runtime
// or determinism: the actions it dispatches are exactly the store/controller edits the UI already performs.
//
// Two axes the model makes first-class:
//   • `kind` - 'part' | 'rigLink'. The incidental distinction; the view should stop branching on it.
//   • `scope` - 'scene' | 'definition'. The one with consequences: a 'definition' edit propagates to every
//     instance of a package, so it must stay legible. `instancesAffected` counts the instances it reaches.

import type { SdkPart, PartInstance } from '../core/types'
import { PART_DEFS } from '../core/types'
import { partDisplayName, partTypeName } from '../core/parts/partDisplayName'
import { controllersUsed } from '../core/io/controllerTag'
import type { RigLink } from '../core/parts/partPackage'
import type { RigGeometry } from './rigTree'
import { canDeleteRigNode } from './rigTree'
import type { EditorState } from './store/store'
import { documentSceneOf, editTarget, rigNodeKey } from './store/store'
import { selectionSet } from './store/selectionSet'

export type TreeNodeKind = 'part' | 'rigLink'

/** Which document an edit on this node goes to. `'scene'` = the mutable session document (this placement
 *  only). `'definition'` = a portable part package, so the edit changes every instance. */
export type TreeNodeScope = 'scene' | 'definition'

/** What this kind of node structurally supports - drives row chrome + the capability-driven menu so the view
 *  needs no kind switch. Transient gating (e.g. disable-while-running) is layered on top by the view; these
 *  flags describe the node and do not change with run state. */
export interface TreeNodeCaps {
  rename: boolean
  /** soft-parent move (scene); false for rig links: reparenting one is a kinematic change, not supported here */
  reparent: boolean
  /** sibling drag-reorder; scene only today */
  reorder: boolean
  /** false for a rig's last remaining node (the controller refuses to empty a rig) */
  delete: boolean
  hide: boolean
  lock: boolean
  /** add a child node under this one - rig links only (the "Add Child Node" affordance) */
  addChild: boolean
  /** open this node's definition in its own scene - a custom part only */
  openScene: boolean
}

/** Current per-node state the view paints (selection/visibility/lock). Renaming is pure component state and
 *  stays in the view, not the model. */
export interface TreeNodeFlags {
  hidden: boolean
  locked: boolean
  selected: boolean
}

/** The minimal store surface the action layer dispatches to (the real EditorStore structurally satisfies it;
 *  tests pass spies). */
export interface TreeNodeStore {
  rename(id: string, name: string): void
  setVisible(ids: readonly string[], visible: boolean): void
  setLocked(ids: readonly string[], locked: boolean): void
  selectMany(ids: readonly string[]): void
  deleteSelection(): void
  setRigNodeLocked(partId: string, linkName: string, locked: boolean): void
}

/** The minimal controller surface (package edits). null in contexts without a live controller (e.g. tests) -
 *  rig actions then no-op, exactly like the existing rig handlers. */
export interface TreeNodeController {
  renameRigNode(packageId: string, linkName: string, rawName: string, confirmBehaviorRewrite?: (count: number) => boolean): boolean
  addRigNode(packageId: string, parentLinkName: string): void
  deleteRigNode(packageId: string, linkName: string): void
  setRigLinkHidden(packageId: string, linkName: string, hidden: boolean): void
}

export interface TreeNodeDeps {
  store: TreeNodeStore
  controller: TreeNodeController | null
}

/** One tree row, kind-erased. The `commit*`/`set*`/`delete` methods hide whether the edit routes to the store
 *  (scene part) or the controller package edit (rig link). */
export interface TreeNode {
  key: string
  kind: TreeNodeKind
  label: string
  depth: number
  scope: TreeNodeScope
  /** how many placements a `scope:'definition'` edit reaches; 0 when `scope:'scene'` */
  instancesAffected: number
  caps: TreeNodeCaps
  flags: TreeNodeFlags
  /** commit a rename. `confirmBehaviorRewrite` is consulted only for a rig link whose definition references
   *  the old name in its behavior script (see renameRigNode); ignored for a scene part. */
  commitRename(next: string, confirmBehaviorRewrite?: (count: number) => boolean): void
  setHidden(hidden: boolean): void
  setLocked(locked: boolean): void
  /** add a child node - rig links only; a no-op when `caps.addChild` is false */
  addChild(): void
  delete(): void
}

/** A row to adapt, plus its display depth (computed by the existing tree walk and passed through, so the adapter
 *  doesn't duplicate the ordering logic). */
export type TreeNodeSource =
  | { kind: 'part'; part: PartInstance; depth: number }
  | { kind: 'rigLink'; partId: string; link: RigLink; geometry: RigGeometry; depth: number }

// Count placements a definition edit reaches, in the document's scene (a definition session shows its own): a
// custom part is one part per placement.
function countInstancesOfPackage(state: EditorState, packageId: string, exceptPartId?: string | null): number {
  return documentSceneOf(state).parts.filter((p) => p.type === 'part' && (p as SdkPart).packageId === packageId && p.id !== exceptPartId).length
}

/**
 * The placed copies of a package in the scene that a definition edit (a rig node, a joint, the behavior)
 * changes - leaving out a package-edit session's own throwaway, which Back discards. The rig rows, the
 * session banner and the Inspector's node panel all read this, so they can't disagree.
 */
export function placedCopiesOf(state: EditorState, packageId: string): number {
  const pe = state.packageEdit
  return countInstancesOfPackage(state, packageId, pe?.packageId === packageId ? pe.partId : null)
}

// A scene part is definition-scoped when the active session edits a definition's internals (package
// edit); a plain part-focus or the base scene is scene-scoped. Rig links are always definition-scoped. The
// count is the session's own (sessionDefinitionScope), so the banner and the rows can't disagree.
function partScope(state: EditorState): { scope: TreeNodeScope; instancesAffected: number } {
  const d = sessionDefinitionScope(state)
  return d ? { scope: 'definition', instancesAffected: d.instancesAffected } : { scope: 'scene', instancesAffected: 0 }
}

/** Does a tree row match the dock's filter text `q` (already trimmed + lower-cased)? `label` is the name
 *  the row shows (partDisplayName) - an unnamed part reads "Belt Conveyor 2", and typing what you see has
 *  to find it. The id, type name, generic def label and category match too. */
export function matchesTreeFilter(part: PartInstance, label: string, q: string): boolean {
  const def = PART_DEFS[part.type]
  return (
    label.toLowerCase().includes(q) ||
    part.id.toLowerCase().includes(q) ||
    // the type name (a custom part's package name - def.label is only the generic "Custom Part")
    partTypeName(part).toLowerCase().includes(q) ||
    def.label.toLowerCase().includes(q) ||
    def.category.toLowerCase().includes(q) ||
    // the controller its tags are on, so filtering by Cell2 lists Cell2's parts
    controllersUsed([part]).some((c) => c.toLowerCase().includes(q))
  )
}

/** The session's definition scope: set when you're editing a definition rather than a placement -
 *  a custom part package (`package-edit`, the Catalog ✎). null at the base
 *  scene or in a plain part-focus (inspecting one placement, scene-scoped). `instancesAffected` is how many
 *  placements a save here updates, using the same counting as the per-node model so the
 *  banner and the rows never disagree. Drives the scene-tree's "Editing definition - N instances" banner. */
export interface DefinitionScope {
  kind: 'package'
  /** the definition's id - a package id */
  ref: string
  instancesAffected: number
}

export function sessionDefinitionScope(state: EditorState): DefinitionScope | null {
  const t = editTarget(state)
  // Exclude the session's own throwaway (the package-edit draft): it's discarded on Back, so it isn't a
  // placement the save propagates to. The count is the durable instances that will update.
  if (t?.kind === 'package-edit') {
    return { kind: 'package', ref: t.packageId, instancesAffected: placedCopiesOf(state, t.packageId) }
  }
  return null
}

function buildPartNode(part: PartInstance, depth: number, state: EditorState, deps: TreeNodeDeps): TreeNode {
  const { scope, instancesAffected } = partScope(state)
  return {
    key: part.id,
    kind: 'part',
    // an unnamed part reads as its type name (numbered across siblings), not its raw id - see partDisplayName
    label: partDisplayName(part, state.scene.parts),
    depth,
    scope,
    instancesAffected,
    caps: {
      rename: true,
      reparent: true,
      reorder: true,
      delete: true,
      hide: true,
      lock: true,
      addChild: false,
      openScene: part.type === 'part',
    },
    flags: {
      hidden: part.visible === false,
      locked: part.locked === true,
      selected: selectionSet(state.selectedIds).has(part.id),
    },
    commitRename(next) {
      deps.store.rename(part.id, next)
    },
    setHidden(hidden) {
      deps.store.setVisible([part.id], !hidden)
    },
    setLocked(locked) {
      deps.store.setLocked([part.id], locked)
    },
    addChild() {
      /* not a part affordance */
    },
    delete() {
      // no targeted delete on the store - select then delete, matching the menu's right-click-selects flow
      deps.store.selectMany([part.id])
      deps.store.deleteSelection()
    },
  }
}

function buildRigNode(partId: string, link: RigLink, geometry: RigGeometry, depth: number, state: EditorState, deps: TreeNodeDeps): TreeNode {
  // the owning custom part supplies the packageId every rig edit targets; missing/non-custom → actions no-op
  const owner = state.scene.parts.find((p) => p.id === partId)
  const packageId = owner?.type === 'part' ? (owner as SdkPart).packageId : null
  const instancesAffected = packageId ? placedCopiesOf(state, packageId) : 0
  const sel = state.selectedRigNode
  return {
    key: rigNodeKey(partId, link.name),
    kind: 'rigLink',
    label: link.name,
    depth,
    scope: 'definition', // a rig link lives in a package - editing it changes every instance
    instancesAffected,
    caps: {
      rename: true,
      reparent: false, // reparenting a link is a kinematic change, not supported
      reorder: false,
      delete: canDeleteRigNode(geometry, link.name), // a part needs ≥1 node; the controller refuses to empty a rig
      hide: true,
      lock: true,
      addChild: true,
      openScene: false,
    },
    flags: {
      hidden: link.hidden === true,
      locked: state.lockedRigNodes.has(rigNodeKey(partId, link.name)),
      selected: sel?.partId === partId && sel.linkName === link.name,
    },
    commitRename(next, confirmBehaviorRewrite) {
      if (packageId) deps.controller?.renameRigNode(packageId, link.name, next, confirmBehaviorRewrite)
    },
    setHidden(hidden) {
      if (packageId) deps.controller?.setRigLinkHidden(packageId, link.name, hidden)
    },
    setLocked(locked) {
      deps.store.setRigNodeLocked(partId, link.name, locked)
    },
    addChild() {
      if (packageId) deps.controller?.addRigNode(packageId, link.name)
    },
    delete() {
      if (packageId) deps.controller?.deleteRigNode(packageId, link.name)
    },
  }
}

/** Adapt one source row to a {@link TreeNode}. */
export function buildTreeNode(src: TreeNodeSource, state: EditorState, deps: TreeNodeDeps): TreeNode {
  return src.kind === 'part'
    ? buildPartNode(src.part, src.depth, state, deps)
    : buildRigNode(src.partId, src.link, src.geometry, src.depth, state, deps)
}

/** Adapt an already-ordered list of source rows (from the existing tree walk) to {@link TreeNode}s. */
export function buildTreeNodes(srcs: readonly TreeNodeSource[], state: EditorState, deps: TreeNodeDeps): TreeNode[] {
  return srcs.map((s) => buildTreeNode(s, state, deps))
}
