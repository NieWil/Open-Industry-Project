// Vertex snapping (hold B) of the EditorController (../controller.ts). Its arm (`ec.vsnap`)
// stays on the controller because the keyboard, pointer, drag and run edges all clear it, and the snap drag
// itself is a drag (./drag.ts helpers), so every function takes the owning controller (`ec`).

import { Vector3 } from 'three'
import { subtreeIds } from '../../core/scene/hierarchy'
import type { SnapPose } from '../../core/snap/snapFeatures'
import type { PartInstance } from '../../core/types'
import * as dragOps from './drag'
import type { Drag } from './drag'
import type { EditorController } from '../controller'

// screen-px radius around the cursor within which a vertex snaps (vertex-snap threshold = 30)
const VERTEX_SNAP_PX = 26

// empty exclude set for origin-mode target search (any vertex in the scene)
const EMPTY_IDS: ReadonlySet<string> = new Set()

/** effective collision-vs-mesh source: the stored default, inverted while Shift is held */
export function vsnapUseCollision(ec: EditorController, shift: boolean): boolean {
  return ec.store.getState().vertexSnapCollision !== shift
}

/** Arm vertex-snap mode (B down): begin tracking the source vertex under the cursor. */
export function armVertexSnap(ec: EditorController): void {
  const s = ec.store.getState()
  if (s.selectedIds.length === 0 || s.mode === 'placing' || s.running) return
  ec.vsnap = { source: null }
  if (ec.lastPointer) ec.updateVertexSnapSource(ec.lastPointer.x, ec.lastPointer.y, false)
}

/**
 * Re-pick the source vertex as the cursor moves (pre-drag). In origin mode the
 * source is the nearest vertex anywhere in the scene (the point the origin jumps
 * to); otherwise it is the nearest vertex on the selection's own subtree.
 */
export function updateVertexSnapSource(ec: EditorController, clientX: number, clientY: number, shift: boolean): void {
  if (!ec.vsnap) return
  const s = ec.store.getState()
  const useCollision = vsnapUseCollision(ec, shift)
  let source: Vector3 | null
  if (s.vertexSnapOriginMode) {
    const hit = ec.view.vertexSnapTarget(clientX, clientY, EMPTY_IDS, VERTEX_SNAP_PX, useCollision)
    source = hit ? hit.point : null
  } else {
    const ids = subtreeIds(s.scene.parts, s.selectedIds)
    source = ec.view.vertexSnapSource(clientX, clientY, ids, VERTEX_SNAP_PX, useCollision)
  }
  ec.vsnap.source = source
  ec.view.showVertexMarkers(source, null)
  ec.view.setTransformReadout(source ? (s.vertexSnapOriginMode ? 'Snap Origin to Vertex' : 'Vertex Snap') : null)
}

/** Origin mode: jump the selection (subtree) so the primary's origin sits on the picked vertex. */
export function originSnapToVertex(ec: EditorController, clientX: number, clientY: number, shift: boolean): void {
  if (ec.readOnly) return
  ec.updateVertexSnapSource(clientX, clientY, shift)
  const src = ec.vsnap?.source
  const s = ec.store.getState()
  const primary = s.scene.parts.find((p) => p.id === s.selectedIds[0])
  if (!src || !primary) return
  const dx = src.x - primary.position[0]
  const dy = src.y - primary.position[1]
  const dz = src.z - primary.position[2]
  if (dx === 0 && dy === 0 && dz === 0) return
  const ids = subtreeIds(s.scene.parts, s.selectedIds)
  const before = s.scene
  const after = {
    ...before,
    parts: before.parts.map((p) =>
      ids.includes(p.id)
        ? ({ ...p, position: [p.position[0] + dx, p.position[1] + dy, p.position[2] + dz] } as PartInstance)
        : p,
    ),
  }
  ec.commitTransform('Vertex Snap', after, { before })
  // stay armed for a follow-up snap; re-pick the source at the cursor
  ec.updateVertexSnapSource(clientX, clientY, shift)
}

/** Begin the vertex-snap drag on LMB-down while armed with a source. Returns true if started. */
export function beginVertexSnapDrag(ec: EditorController, e: PointerEvent): boolean {
  if (ec.readOnly) return false
  const source = ec.vsnap?.source
  if (!source) return false
  const s = ec.store.getState()
  const start = dragOps.dragStartScene(ec, s)
  const ids = subtreeIds(start.parts, s.selectedIds)
  if (ids.length === 0) return false
  const origin = new Map<string, [number, number, number]>()
  for (const p of start.parts) {
    if (ids.includes(p.id)) origin.set(p.id, [...p.position] as [number, number, number])
  }
  ec.container.setPointerCapture(e.pointerId)
  ec.drag = { kind: 'vertexSnap', pointerId: e.pointerId, start, ids, origin, source: source.clone(), moved: false }
  ec.syncPoolDragEject() // eject at pointer-down, before the first move transient
  dragOps.setDraggedBodyFrozen(ec, ids, true)
  ec.resetSnap()
  return true
}

export function moveVertexSnap(ec: EditorController, drag: Drag & { kind: 'vertexSnap' }, clientX: number, clientY: number, shift: boolean): void {
  const hit = ec.view.vertexSnapTarget(clientX, clientY, new Set(drag.ids), VERTEX_SNAP_PX, vsnapUseCollision(ec, shift))
  let dx: number
  let dy: number
  let dz: number
  let target: Vector3 | null = null
  if (hit) {
    target = hit.point
    dx = hit.point.x - drag.source.x
    dy = hit.point.y - drag.source.y
    dz = hit.point.z - drag.source.z
    ec.view.setTransformReadout('Vertex Snap (Snapped)')
  } else {
    // no vertex under the cursor: free-translate on the camera-facing plane through the source
    const onPlane = ec.view.cameraPlanePoint(clientX, clientY, drag.source)
    if (!onPlane) return
    dx = onPlane.x - drag.source.x
    dy = onPlane.y - drag.source.y
    dz = onPlane.z - drag.source.z
    ec.view.setTransformReadout('Vertex Snap')
  }
  if (!drag.moved && dx === 0 && dy === 0 && dz === 0) return
  drag.moved = true
  const poses = new Map<string, SnapPose>()
  for (const p of drag.start.parts) {
    const o = drag.origin.get(p.id)
    if (o) poses.set(p.id, { position: [o[0] + dx, o[1] + dy, o[2] + dz], rotationY: p.rotationY })
  }
  dragOps.applyPoses(ec, drag.start, poses)
  dragOps.syncDraggedBody(ec, drag.ids, poses, false)
  // the source dot moves with the selection; the target dot marks the snap point (when snapped)
  ec.view.showVertexMarkers(new Vector3(drag.source.x + dx, drag.source.y + dy, drag.source.z + dz), target)
}

/** Disarm vertex-snap mode (B up) when no drag is in flight. */
export function disarmVertexSnap(ec: EditorController): void {
  ec.vsnap = null
  ec.view.showVertexMarkers(null, null)
  ec.view.setTransformReadout(null)
}
