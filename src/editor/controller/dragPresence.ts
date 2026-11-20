// What a live drag tells the instance pool and collab peers (for ../controller.ts). The only
// state of its own is whether a drag has been published to peers (DragPresence); the drag itself, and the
// store and view it reports to, come in as narrow dependencies.

import { subtreeIds } from '../../core/scene/hierarchy'
import type { PartInstance } from '../../core/types'
import { hasCollabProvider, setLocalDrag } from '../../collab/session'
import type { EditorState } from '../store/store'
import type { EditorController } from '../controller'

/** the parts a live pointer drag is currently moving, or null when no such drag is active */
/** collab live-drag streaming: `published` is true once we've published a drag, so we publish exactly one
 *  "drag ended" (null) when it stops */
export class DragPresence {
  published = false
}

/** what the drag reporting reads: the live gesture (a pointer drag or a Shift+G reposition), the store, the view */
export type DragPresenceDeps = Pick<EditorController, 'store' | 'view' | 'drag' | 'reposition'>

export function activeDragIds(ec: DragPresenceDeps, s: EditorState): string[] | null {
  const d = ec.drag
  if (d) {
    switch (d.kind) {
      case 'gizmo':
      case 'rotate':
      case 'vertexSnap':
        return d.ids
      case 'resize':
      case 'guardOpening':
        return [d.id]
      default:
        return null // band-select / ruler move no parts
    }
  }
  // a collision reposition (drag-the-body move) carries the whole selection subtree
  if (ec.reposition) return subtreeIds(s.scene.parts, s.selectedIds)
  return null
}

export function pushPoolDrag(ec: DragPresenceDeps, s: EditorState): void {
  const d = ec.drag
  const dragIds = activeDragIds(ec, s)
  // an Inspector scrub (store.beginLiveEdit) regenerates hardware per step like a resize drag → eject
  const liveIds = dragIds === null ? ec.store.liveEditIds() : null
  // reposition (drag === null) and every translate/rotate kind are pose-only → write-through
  const structural = liveIds !== null || (d !== null && (d.kind === 'resize' || d.kind === 'guardOpening'))
  ec.view.setPoolDragEject(dragIds ?? liveIds, structural)
}

/**
 * Stream the live poses of the parts under an in-flight drag over awareness, so peers see
 * the motion smoothly instead of a single jump on commit. Ephemeral - never written to the
 * doc. A no-op in solo mode (setLocalDrag has no provider). Publishes one terminating null
 * when the drag ends; the authoritative pose then arrives via the normal commit → doc path.
 */
export function publishDragPresence(st: DragPresence, ec: DragPresenceDeps, s: EditorState): void {
  // solo mode: no provider to publish to - skip building the pose payload (a byId map over the
  // whole scene) on every transient frame. `published` can only be set with a provider
  // attached; if a room connects mid-drag, the next store change publishes normally.
  if (!hasCollabProvider()) {
    if (st.published) {
      setLocalDrag(null)
      st.published = false
    }
    return
  }
  const ids = activeDragIds(ec, s)
  if (ids && ids.length > 0) {
    const byId = new Map(s.scene.parts.map((p) => [p.id, p]))
    const poses = ids
      .map((id) => byId.get(id))
      .filter((p): p is PartInstance => p !== undefined)
      .map((p) => ({
        id: p.id,
        position: [p.position[0], p.position[1], p.position[2]] as [number, number, number],
        rotationY: p.rotationY,
        ...(p.rotationX ? { rotationX: p.rotationX } : {}),
        ...(p.rotationZ ? { rotationZ: p.rotationZ } : {}),
      }))
    setLocalDrag(poses)
    st.published = true
  } else if (st.published) {
    setLocalDrag(null)
    st.published = false
  }
}
