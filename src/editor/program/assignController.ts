// Assign to Controller: put every tag of the chosen parts on one controller, as one undo step. A tag names its
// controller in its own spelling (`Cell2::%IX0.0`, core/io/controllerTag.ts), so this rewrites that prefix and
// leaves the rest of the tag alone. Duplicating a cell for a second PLC is then a duplicate and one assignment.

import { controllerOf, moveTagToController, tagParamKeys } from '../../core/io/controllerTag'
import type { PartInstance, SceneJSON } from '../../core/types'
import { keepAddedAddress, plcsWithAdded } from '../store/storePlcs'
import type { EditorStore } from '../store/store'

export interface ControllerAssignment {
  /** the scene with the tags moved, or null when every tag was on that controller already */
  scene: SceneJSON | null
  /** how many tag fields changed, and on how many parts */
  tags: number
  parts: number
}

/** The scene with every non-empty tag of the parts `ids` on `controller` (null: the default controller). */
export function assignToController(scene: SceneJSON, ids: readonly string[], controller: string | null): ControllerAssignment {
  const chosen = new Set(ids)
  let tags = 0
  let changedParts = 0
  const parts = scene.parts.map((p): PartInstance => {
    if (!chosen.has(p.id)) return p
    const params = typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
    let next: Record<string, unknown> | null = null
    for (const key of tagParamKeys(p)) {
      const raw = params[key]
      if (typeof raw !== 'string') continue
      const moved = moveTagToController(raw, controller)
      if (moved === raw) continue
      next ??= { ...params }
      next[key] = moved
      tags++
    }
    if (!next) return p
    changedParts++
    return { ...p, params: next } as PartInstance
  })
  return { scene: tags > 0 ? { ...scene, parts } : null, tags, parts: changedParts }
}

/** Rename a controller and every tag of the open document on it, as one undo step (store.renameNamedPlc). False when refused. */
export function commitControllerRename(store: EditorStore, from: string, to: string): boolean {
  return store.renameNamedPlc(from, to)
}

/** The controllers the parts' non-empty tags are on (null: the default one), each once, in the order first met. */
export function tagControllers(parts: readonly PartInstance[]): (string | null)[] {
  const out: (string | null)[] = []
  for (const p of parts) {
    const params = typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
    for (const key of tagParamKeys(p)) {
      const raw = params[key]
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const c = controllerOf(raw.trim())
      if (!out.includes(c)) out.push(c)
    }
  }
  return out
}

/** Whether any of the parts `ids` has a tag to move. */
export function hasTags(scene: SceneJSON, ids: readonly string[]): boolean {
  const chosen = new Set(ids)
  return scene.parts.some((p) => {
    if (!chosen.has(p.id)) return false
    const params = typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
    return tagParamKeys(p).some((key) => typeof params[key] === 'string' && (params[key] as string).trim() !== '')
  })
}

/**
 * Move the parts' tags in the open document, as one undo step named `label`. A controller the scene does not list yet
 * is added to it in the same step (store/storePlcs.ts), ready for its address in Controller Properties.
 */
export function commitControllerAssignment(store: EditorStore, ids: readonly string[], controller: string | null, label: string): ControllerAssignment {
  const result = assignToController(store.getState().scene, ids, controller)
  if (!result.scene) return result
  const added = controller !== null ? plcsWithAdded(store, controller) : null
  store.commit(label, added ? { ...result.scene, plcs: added } : result.scene)
  if (added) keepAddedAddress(store, controller!)
  return result
}
