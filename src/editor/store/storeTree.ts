// The scene tree's edits: delete, order (move up/down, reorder), rename, the visible / locked / grouped flags, and
// soft-parenting (reparent, unparent, wrap in a new node, tree drag-and-drop). Each one is a single store.commit.
// Extracted from store.ts verbatim; the EditorStore methods of the same names delegate here.
import { containerAnchor, partsById, subtreeIds, wouldCreateCycle } from '../../core/scene/hierarchy'
import { uniqueSiblingName } from '../../core/parts/partDisplayName'
import { createPart, nextId } from '../../core/scene/scene'
import type { PartInstance } from '../../core/types'
import type { EditorStore } from './store'

export function deleteSelection(store: EditorStore): void {
  const { scene, selectedIds } = store.getState()
  if (selectedIds.length === 0) return
  // deleting a part removes its whole subtree, so no child is left orphaned
  const remove = new Set(subtreeIds(scene.parts, selectedIds))
  const parts = scene.parts.filter((p) => !remove.has(p.id))
  if (parts.length === scene.parts.length) return
  const removed = scene.parts.length - parts.length
  store.commit(removed > 1 ? 'Delete parts' : 'Delete part', { ...scene, parts })
  store.setState({ selectedIds: [] })
}

export function moveSelection(store: EditorStore, dir: -1 | 1): void {
  const { scene, selectedIds } = store.getState()
  if (selectedIds.length === 0) return
  const sel = new Set(selectedIds)
  // reorder within a single sibling group (parts sharing one parent): a
  // within-parent move. With no nesting every part is a root sibling, so this reorders
  // the flat list. A selection spanning parents is a no-op.
  const selParts = scene.parts.filter((p) => sel.has(p.id))
  const parentKey = selParts[0]!.parent ?? null
  if (!selParts.every((p) => (p.parent ?? null) === parentKey)) return
  // sibling ids in array order, and the array slots they occupy
  const slots: number[] = []
  const sibIds: string[] = []
  scene.parts.forEach((p, i) => {
    if ((p.parent ?? null) === parentKey) {
      slots.push(i)
      sibIds.push(p.id)
    }
  })
  const idxs: number[] = []
  sibIds.forEach((id, i) => {
    if (sel.has(id)) idxs.push(i)
  })
  if (idxs.length === 0) return
  // any selected sibling already at that end of the group blocks the whole move
  if (dir < 0 ? idxs[0] === 0 : idxs[idxs.length - 1] === sibIds.length - 1) return
  const order = [...sibIds]
  const swap = (a: number, b: number) => {
    const tmp = order[a]!
    order[a] = order[b]!
    order[b] = tmp
  }
  if (dir < 0) for (const i of idxs) swap(i - 1, i)
  else for (let k = idxs.length - 1; k >= 0; k--) swap(idxs[k]!, idxs[k]! + 1)
  // write the reordered siblings back into their original array slots
  const byId = new Map(scene.parts.map((p) => [p.id, p]))
  const parts = [...scene.parts]
  slots.forEach((slot, k) => {
    parts[slot] = byId.get(order[k]!)!
  })
  const many = idxs.length > 1
  const label = dir < 0 ? (many ? 'Move parts up' : 'Move part up') : many ? 'Move parts down' : 'Move part down'
  store.commit(label, { ...scene, parts })
}

export function rename(store: EditorStore, id: string, name: string): void {
  const scene = store.getState().scene
  const part = scene.parts.find((p) => p.id === id)
  if (!part) return
  const trimmed = name.trim()
  if (trimmed === (part.name ?? '')) return
  // Names are unique among siblings (the unique-name rule): a typed name that collides with another part under the
  // same parent auto-suffixes ("Motor" → "Motor 2"), but the same label may recur in a different branch (two
  // cells can each hold a "Start"). Empty clears the name (falls back to the numbered type label). `id`, not
  // name, is identity - this only shapes the display label.
  const finalName = trimmed === '' ? '' : uniqueSiblingName(scene.parts, part.parent, trimmed, id)
  const parts = scene.parts.map((p) => {
    if (p.id !== id) return p
    if (finalName === '') {
      const rest = { ...p }
      delete rest.name
      return rest as PartInstance
    }
    return { ...p, name: finalName } as PartInstance
  })
  store.commit('Rename part', { ...scene, parts }, { coalesceKey: `rename:${id}` })
}

export function setVisible(store: EditorStore, ids: readonly string[], visible: boolean): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  const scene = store.getState().scene
  let changed = 0
  const parts = scene.parts.map((p) => {
    if (!idSet.has(p.id) || (p.visible !== false) === visible) return p
    changed++
    if (visible) {
      const rest = { ...p }
      delete rest.visible
      return rest as PartInstance
    }
    return { ...p, visible: false } as PartInstance
  })
  if (changed === 0) return
  const verb = visible ? 'Show' : 'Hide'
  store.commit(changed > 1 ? `${verb} parts` : `${verb} part`, { ...scene, parts })
}

export function setLocked(store: EditorStore, ids: readonly string[], locked: boolean): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  const scene = store.getState().scene
  let changed = 0
  const parts = scene.parts.map((p) => {
    if (!idSet.has(p.id) || (p.locked === true) === locked) return p
    changed++
    if (locked) return { ...p, locked: true } as PartInstance
    const rest = { ...p }
    delete rest.locked
    return rest as PartInstance
  })
  if (changed === 0) return
  const verb = locked ? 'Lock' : 'Unlock'
  store.commit(changed > 1 ? `${verb} parts` : `${verb} part`, { ...scene, parts })
}

export function setGrouped(store: EditorStore, ids: readonly string[], grouped: boolean): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  const scene = store.getState().scene
  let changed = 0
  const parts = scene.parts.map((p) => {
    if (!idSet.has(p.id) || (p.grouped === true) === grouped) return p
    changed++
    if (grouped) return { ...p, grouped: true } as PartInstance
    const rest = { ...p }
    delete rest.grouped
    return rest as PartInstance
  })
  if (changed === 0) return
  store.commit(grouped ? 'Select as one' : 'Select parts individually', { ...scene, parts })
}

export function reorder(store: EditorStore, orderedIds: readonly string[]): void {
  const scene = store.getState().scene
  if (orderedIds.length !== scene.parts.length) return
  const byId = new Map(scene.parts.map((p) => [p.id, p]))
  const parts: PartInstance[] = []
  for (const id of orderedIds) {
    const p = byId.get(id)
    if (!p) return // not a permutation of the current ids: ignore
    parts.push(p)
  }
  if (scene.parts.every((p, i) => p.id === parts[i]!.id)) return
  store.commit('Reorder parts', { ...scene, parts })
}

export function reparent(store: EditorStore, ids: readonly string[], parentId: string | null): void {
  const scene = store.getState().scene
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  let changed = 0
  const byId = partsById(scene.parts)
  const parts = scene.parts.map((p) => {
    if (!idSet.has(p.id)) return p
    if (wouldCreateCycle(scene.parts, p.id, parentId, byId)) return p
    if ((p.parent ?? null) === (parentId ?? null)) return p
    changed++
    if (parentId === null) {
      const rest = { ...p }
      delete rest.parent
      return rest as PartInstance
    }
    return { ...p, parent: parentId } as PartInstance
  })
  if (changed === 0) return
  store.commit(changed > 1 ? 'Reparent parts' : 'Reparent part', { ...scene, parts })
}

export function unparent(store: EditorStore, ids: readonly string[]): void {
  const top = store.getState().focusedPartId
  reparent(store, top === null ? ids : ids.filter((id) => id !== top), top)
}

export function reparentToNewNode(store: EditorStore): void {
  const { scene, selectedIds } = store.getState()
  if (selectedIds.length === 0) return
  const selSet = new Set(selectedIds)
  const roots = scene.parts.filter((p) => selSet.has(p.id) && !(p.parent !== undefined && selSet.has(p.parent)))
  if (roots.length === 0) return
  // the focused part is the document's root inside a session: wrapping IT would put the new node
  // outside the document, where the dock can't show it and a master edit can't capture it
  const top = store.getState().focusedPartId
  if (top !== null && roots.some((p) => p.id === top)) return
  const id = nextId(scene, 'group')
  const base = roots[0]!.parent ?? null
  const commonParent = roots.every((p) => (p.parent ?? null) === base) ? base : top
  const node = {
    // the container's origin is the pivot its subtree turns about - always the members' centroid
    ...createPart('group', id, containerAnchor(roots) ?? [0, 0, 0]),
    name: `Group ${id.slice(id.indexOf('_') + 1)}`,
    grouped: true,
    ...(commonParent !== null ? { parent: commonParent } : {}),
  } as PartInstance
  const movedIds = new Set(roots.map((p) => p.id))
  const firstIdx = scene.parts.findIndex((p) => movedIds.has(p.id))
  const parts: PartInstance[] = []
  scene.parts.forEach((p, i) => {
    if (i === firstIdx) parts.push(node) // slot the node where the selection began
    parts.push(movedIds.has(p.id) ? ({ ...p, parent: id } as PartInstance) : p)
  })
  store.commit('Reparent to new node', { ...scene, parts })
  store.setState({ selectedIds: [id] })
}

export function moveInTree(store: EditorStore, draggedIds: readonly string[], targetId: string, dropPos: 'before' | 'after' | 'inside'): void {
  const scene = store.getState().scene
  const moving = new Set(draggedIds)
  if (moving.has(targetId)) return
  const target = scene.parts.find((p) => p.id === targetId)
  if (!target) return
  const byId = partsById(scene.parts)
  for (const d of draggedIds) if (wouldCreateCycle(scene.parts, d, targetId, byId)) return
  // the focused part is the top row of the dock inside a session, and its siblings aren't shown:
  // a drop "before"/"after" it can only mean into it (a sibling slot would leave the session)
  const pos = targetId === store.getState().focusedPartId ? 'inside' : dropPos
  const newParent = pos === 'inside' ? targetId : target.parent
  const setParent = (p: PartInstance): PartInstance => {
    if ((p.parent ?? undefined) === (newParent ?? undefined)) return p
    if (newParent === undefined) {
      const rest = { ...p }
      delete rest.parent
      return rest as PartInstance
    }
    return { ...p, parent: newParent } as PartInstance
  }
  const movingOrdered = scene.parts.filter((p) => moving.has(p.id)).map(setParent)
  const rest = scene.parts.filter((p) => !moving.has(p.id))
  let idx = rest.findIndex((p) => p.id === targetId)
  if (idx === -1) return
  if (pos !== 'before') idx += 1 // 'after'/'inside' insert just past the target row
  const parts = [...rest.slice(0, idx), ...movingOrdered, ...rest.slice(idx)]
  if (parts.length === scene.parts.length && parts.every((p, i) => p === scene.parts[i])) return
  const origById = new Map(scene.parts.map((p) => [p.id, p]))
  const reparented = movingOrdered.some((p) => (p.parent ?? undefined) !== (origById.get(p.id)!.parent ?? undefined))
  const label = reparented ? (draggedIds.length > 1 ? 'Reparent parts' : 'Reparent part') : 'Reorder parts'
  store.commit(label, { ...scene, parts })
}
