// Camera bookkeeping of the EditorController (../controller.ts): the remembered pose per
// scene slot, the opening view, the Focus / Follow press run and the follow badge. The bookkeeping is this
// area's own state (CameraState, held by the controller); the store and view come in as dependencies.

import { Vector3 } from 'three'
import { partDisplayName } from '../../core/parts/partDisplayName'
import { DEMO_OPENING_VIEW } from '../demo/demoScenes'
import { clearViewportState, persistViewportState, readViewportState } from '../store/storePrefs'
import { takeLinkCamera } from './linkCamera'
import { SCENE_SLOT, sceneSlotKey } from '../project/documentStore'
import { DEFAULT_CAMERA_POSE } from '../../render/api'
import type { IRenderView, ProjectionMode } from '../../render/api'
import type { EditorState, EditorStore } from '../store/store'
import type { EditorController } from '../controller'

/** The camera's own bookkeeping: the slot it is filed under, the Focus / Follow press run, the part-focus return. */
export class CameraState {
  // which slot the camera on screen belongs to (viewportKey at the last restore): where the pose is filed when the
  // document moves under it (a new id, a demo fork)
  key = ''
  // "Focus Selection" (F): consecutive presses on the same selection cycle focus → follow
  // → stop-follow (even count ≥ 2 = following). focusKey is the selection the count belongs to;
  // it resets when the selection changes. selKey detects those selection changes.
  focusCount = 0
  focusKey = ''
  selKey = ''
  // factory-view camera pose captured on entering part focus, restored when returning to the main scene
  preFocusPose: { px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null = null
  // the projection last mirrored between the store and the view (set from the store at construction)
  projection: ProjectionMode = 'perspective'
}

/** what the camera bookkeeping reads and drives: the store (document slot, projection, follow badge) and the view */
export type CameraDeps = Pick<EditorController, 'store' | 'view'>

/**
 * Which slot the camera belongs to. A scene's remembered camera is keyed by its project slot id, so
 * each tab reopens on its own framing rather than inheriting the previous scene's.
 *
 * Two cases are not project slots. A room's scene is not in the project at all and every room would
 * otherwise collide on the default 'scene-1' - so it keys by room, and reloading a shared session
 * restores the view of that room. An ephemeral `?scene=demo` peek is not a slot either; it gets its
 * own key. When the peek turns into the user's own scene the camera is carried over to the real slot
 * explicitly (the handover in onStoreChange), because nothing moves it at that moment and a settle
 * that never fires would leave the new slot with no camera at all.
 */
export function viewportKey(store: EditorStore): string {
  if (store.demoSession) return '@demo'
  const room = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('room') : null
  if (room) return '@room:' + room
  return sceneSlotKey(SCENE_SLOT)
}

export function openingView(store: EditorStore): { px: number; py: number; pz: number; tx: number; ty: number; tz: number } {
  // A `?scene=demo` visit opens on the palletizing cell rather than the default, which frames world
  // zero - the infeed tail here, with the arm cropped at the frame edge (see DEMO_OPENING_VIEW).
  return store.demoSession ? { ...DEMO_OPENING_VIEW } : { ...DEFAULT_CAMERA_POSE }
}

/** Put the camera on this scene's remembered pose, or its opening view when it has none. */
export function restoreCamera(c: CameraState, ec: CameraDeps): void {
  const key = viewportKey(ec.store)
  c.key = key
  // a scene slot framed before cameras were kept per document is under its bare id: the first document to
  // ask for it takes it (storePrefs.readViewportState)
  let saved = readViewportState(key, key.startsWith('@') ? undefined : SCENE_SLOT)
  // A room link may carry the camera its sender copied it at. That is this visit's opening view, over a camera
  // remembered from an earlier one. It is filed as the room's camera at once, since an instant pose is not a
  // gesture that settles, and the address no longer has it on a reload.
  const linked = key.startsWith('@room:') ? takeLinkCamera() : null
  if (linked) {
    const { ortho, ...pose } = linked
    saved = { pose, projection: ortho ? 'orthographic' : 'perspective', auto: false }
    persistViewportState(key, saved)
  }
  ec.view.setCameraPose(saved ? saved.pose : openingView(ec.store), { instant: true })
  // the projection is saved with the pose: an orthographic frustum is derived from the camera→target
  // distance (EditorCamera.setFocusDistance), so restored without the pose it was framed at it
  // would come back at an arbitrary zoom.
  const projection = saved ? saved.projection : 'perspective'
  // loadProjection, not setProjection: the latter is a no-op when the mode already matches, which would leave the
  // outgoing scene's axis-snap auto flag armed. The incoming scene would then revert to perspective on its first
  // frame and save that over its own orthographic view.
  ec.view.loadProjection(projection, saved?.auto === true)
  c.projection = projection
  ec.store.setProjection(projection)
}

export function resetCamera(ec: CameraDeps): void {
  clearViewportState(viewportKey(ec.store))
  ec.view.setProjection('perspective')
  ec.view.setCameraPose(openingView(ec.store))
}

/** the world axis each axis view looks down, as the orbit gizmo maps them (+X right, +Y top, +Z front) */
const AXIS_VIEWS = {
  'view.front': new Vector3(0, 0, 1),
  'view.rear': new Vector3(0, 0, -1),
  'view.right': new Vector3(1, 0, 0),
  'view.left': new Vector3(-1, 0, 0),
  'view.top': new Vector3(0, 1, 0),
  'view.bottom': new Vector3(0, -1, 0),
} as const

export type AxisViewId = keyof typeof AXIS_VIEWS

/** an orthographic view down a world axis, as an orbit-gizmo ball click gives (Numpad 1 / 3 / 7, the palette) */
export function viewAlongAxis(view: IRenderView, id: AxisViewId): void {
  view.snapToAxis(AXIS_VIEWS[id])
}

/** whether the current F run is following (an even press count ≥ 2) */
export function isFollowing(c: CameraState): boolean {
  return c.focusCount >= 2 && c.focusCount % 2 === 0
}

/** One "Focus Selection" (F) press on `ids` (the selection, or the whole scene when nothing is selected). */
export function focusPress(c: CameraState, view: IRenderView, ids: readonly string[], selectedIds: readonly string[]): void {
  // count consecutive presses on the same selection: 1st focuses, 2nd starts following the
  // node as it moves, 3rd stops, 4th follows again…
  const key = ids.join(',')
  if (key !== c.focusKey) {
    c.focusKey = key
    c.focusCount = 0
  }
  c.focusCount += 1
  view.focusOn(ids)
  const following = isFollowing(c)
  // following the whole scene is meaningless - only follow a real selection (follow is
  // disabled when nothing is selected)
  if (following && selectedIds.length > 0) view.startFollow(selectedIds)
  else view.stopFollow()
}

/** A transform was committed: end the F run unless it is following (see EditorController.commitTransform). */
export function endFocusRun(c: CameraState): void {
  if (!isFollowing(c)) {
    c.focusCount = 0
    c.focusKey = ''
  }
}

/**
 * F-follow on a store change: a selection change ends the consecutive-press run. If we were following, we
 * keep following and retarget to the new selection (and stop if nothing is selected); otherwise the count just
 * resets so the next F starts fresh.
 */
export function syncFocusSelection(c: CameraState, view: IRenderView, s: EditorState): void {
  const selKey = s.selectedIds.join(',')
  if (selKey !== c.selKey) {
    c.selKey = selKey
    const wasFollowing = isFollowing(c)
    if (wasFollowing && s.selectedIds.length > 0) {
      c.focusKey = selKey
      view.focusOn(s.selectedIds)
      view.startFollow(s.selectedIds)
    } else {
      c.focusCount = 0
      c.focusKey = ''
      if (view.isFollowing()) view.stopFollow()
    }
  }
}

/** reconcile the follow-mode badge (state.following) with the view's live follow state */
export function syncFollowBadge(ec: CameraDeps, s: EditorState): void {
  if (!ec.view.isFollowing()) {
    if (s.following) ec.store.setFollowing(null)
    return
  }
  // while following, the tracked parts are the current selection (onStoreChange retargets)
  const ids = s.selectedIds
  if (ids.length === 0) return
  ec.store.setFollowing({ ids: [...ids], label: followLabel(ec.store, ids) })
}

/** badge text for the followed selection: a single part's name, else "N parts" */
export function followLabel(store: EditorStore, ids: readonly string[]): string {
  if (ids.length === 1) {
    const parts = store.getState().scene.parts
    const part = parts.find((p) => p.id === ids[0])
    return part ? partDisplayName(part, parts) : '1 part'
  }
  return `${ids.length} parts`
}

export function stopFollowing(c: CameraState, ec: CameraDeps): void {
  c.focusCount = 0
  c.focusKey = ''
  ec.view.stopFollow()
  ec.store.setFollowing(null)
}
