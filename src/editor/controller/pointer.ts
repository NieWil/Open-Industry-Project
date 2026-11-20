// Pointer, wheel and context-menu handling of the EditorController (../controller.ts). The
// pointer's memory between events (a pending touch tap, the last press) is its own state (PointerPress, held by
// the controller); as the input router it drives every other area, so its functions take the controller too.

import { normalizeAngle } from '../../core/math'
import { groupRoot } from '../../core/scene/hierarchy'
import { getPackage } from '../../core/parts/partRegistry'
import { partDisplayName } from '../../core/parts/partDisplayName'
import { ROTATION_SNAP } from '../../core/types'
import type { SdkPart } from '../../core/types'
import type { ListSelectItem } from '../store/store'
import * as dragOps from './drag'
import type { Drag } from './drag'
import * as placementOps from './placement'
import type { EditorController } from '../controller'

// a touch that travels farther than this (px) between press and release is read as a
// camera gesture (orbit/pinch) rather than a tap - see the touch handling in onPointer*
const TAP_SLOP_PX = 10

// two presses within this window, this close together, are one double-click (the group
// drill-in gesture). Tracked by hand because PointerEvent.detail is 0 on pointerdown in
// Chromium - only the legacy mouse events carry a click count.
const DOUBLE_CLICK_MS = 400
const DOUBLE_CLICK_SLOP_PX = 5

/**
 * Alt+RMB list-select. Opened on
 * contextmenu, not pointerdown, so the contextmenu the gesture itself emits
 * can't reach the freshly-rendered backdrop and dismiss the popup.
 * Freelook yields Alt+RMB, so plain RMB still flies. Events on the open popup
 * are left to its React handlers (its backdrop owns dismissal).
 */
/** The pointer's own memory between events: a pending touch tap, and the last press for the double-click test. */
export class PointerPress {
  // touch only: a pending finger-press awaiting release. The editor never starts a
  // capture-drag on touch (OrbitControls owns one-finger orbit + two-finger pinch/pan),
  // so a press that lifts without travelling resolves as a tap (select/place). It is
  // null on mouse, and cleared the moment a second finger turns the gesture into a pinch.
  touchTap: { pointerId: number; x: number; y: number; shift: boolean; moved: boolean } | null = null
  /** the previous part-picking press, for the double-click drill-in (see onPointerDown) */
  lastPress: { t: number; x: number; y: number } | null = null
}

export function onContextMenu(ec: EditorController, e: MouseEvent): void {
  if (ec.view.isNavigating()) return // pilot/freelook owns the viewport
  if (!e.altKey) return
  const t = e.target
  if (t instanceof Element && t.closest('.viewport-toolbar-wrap, .context-menu, .context-backdrop')) return
  e.preventDefault()
  e.stopPropagation()
  ec.listSelect(e.clientX, e.clientY, e.shiftKey)
}

export function onPointerDown(pp: PointerPress, ec: EditorController, e: PointerEvent): void {
  // Overlay UI (tool toolbar, its popovers, list-select popup) must not start a scene
  // interaction. Match the wrap, not `.viewport-toolbar` itself: the Snap Settings popover
  // renders as a sibling of the button row inside it, so matching only the row would let a
  // press inside a popover reach here, capture the pointer on the viewport container, and
  // swallow the button's click entirely (mousedown hit, mouseup retargeted, no click).
  // `.note-chip` is here for the same reason: an annotation has nothing in the 3-D scene to hit, so its
  // chip is the hit target. Without the opt-out this press would capture the pointer on the viewport and
  // swallow the click, so the note could never be selected by clicking the thing that represents it. The agent chip
  // (AgentActivity.tsx) is the same: its Review, Keep and Revert buttons sit in the viewport's corner.
  if (e.target instanceof Element && e.target.closest('.viewport-toolbar-wrap, .context-menu, .context-backdrop, .note-chip, .agent-activity, .present-bar, .present-back, .present-values')) return
  // a display link (locked Present): a visitor may move the camera, which the canvas handles, but not act on the design
  if (ec.store.getState().presentLocked) return
  // right-click aborts an in-flight transform ("Transform Aborted"),
  // reverting to the drag's start pose. The container holds pointer capture
  // during a drag, so this RMB targets it directly and never reaches freelook.
  if (e.button === 2 && ec.drag) {
    dragOps.cancelActiveDrag(ec)
    e.preventDefault()
    return
  }
  // pilot/freelook owns the locked viewport (clicks interact, never select/drag)
  if (ec.view.isNavigating()) return
  if (e.button !== 0) return
  // a left click confirms an in-flight Shift+G reposition (commits on click)
  if (ec.reposition) {
    ec.commitReposition()
    return
  }
  // a focused inspector/tree input commits on blur; force that commit to
  // happen now so drag.start snapshots the post-commit scene (otherwise the
  // blur commit gets baked into the drag's transient and reverted)
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) active.blur()
  const s = ec.store.getState()

  // Touch: never start a capture-drag (it would fight OrbitControls, which owns
  // one-finger orbit + two-finger pinch/pan). A primary finger-press becomes a
  // pending tap, resolved on release (resolveTap); a second finger is a pinch and
  // is handed straight to OrbitControls. Precise edits use the Inspector on touch.
  if (e.pointerType === 'touch') {
    if (!e.isPrimary) {
      pp.touchTap = null
      return
    }
    pp.touchTap = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, shift: e.shiftKey, moved: false }
    return
  }

  // vertex-snap mode (B held): LMB either jumps the origin onto a vertex (origin mode)
  // or begins the vertex drag. Swallow the press so it never falls through to select/gizmo.
  if (ec.vsnap) {
    if (s.vertexSnapOriginMode) ec.originSnapToVertex(e.clientX, e.clientY, e.shiftKey)
    else ec.beginVertexSnapDrag(e)
    return
  }

  if (s.mode === 'placing' && s.placingType) {
    // prefer the cached preview (WYSIWYG under Alt toggles), but only when
    // it was computed for this pointer position (a stray move can race it)
    const cached = ec.placement.preview
    const fresh =
      cached && Math.hypot(cached.clientX - e.clientX, cached.clientY - e.clientY) < 2
        ? cached
        : placementOps.computePlacing(ec.placement, ec, s.placingType, e.clientX, e.clientY, e.altKey)
    if (!fresh) return
    ec.placement.preview = null
    placementOps.placePart(ec.placement, ec, s.placingType, fresh)
    return
  }

  if (ec.drag) return

  // List Select tool: a plain left-click pops the overlapping-parts
  // picker, bypassing gizmo/resize/band.
  if (s.tool === 'list') {
    ec.listSelect(e.clientX, e.clientY, e.shiftKey)
    return
  }

  // Ruler tool: LMB-drag measures between two points. The
  // first point anchors here; the drag steers the second; release keeps the line.
  if (s.tool === 'ruler') {
    const a = ec.view.measurePoint(e.clientX, e.clientY)
    if (!a) return
    ec.container.setPointerCapture(e.pointerId)
    ec.drag = { kind: 'ruler', pointerId: e.pointerId, a, moved: false }
    ec.view.setRuler(a, a)
    ec.rulerVisible = true
    return
  }

  // a custom rig part's gizmo (joint rings + IK handle, it poses its own visual) takes precedence over the
  // transform gizmo - the six-axis robot reaches this as an SDK custom part
  const rigId = ec.singleRigGizmoId(s)
  if (rigId) {
    const handle = ec.view.pickRobotHandle(e.clientX, e.clientY)
    if (handle) {
      dragOps.beginRigGizmoDrag(ec, e, handle, rigId)
      return
    }
  }

  const flexDot = ec.pickFlexDot(s, e.clientX, e.clientY)
  if (flexDot) {
    dragOps.beginResizeDrag(ec, e, flexDot, s)
    return
  }
  if (ec.gizmoVisible(s)) {
    const handle = ec.view.pickGizmoHandle(e.clientX, e.clientY)
    if (handle) {
      dragOps.beginGizmoDrag(ec, e, handle, s)
      return
    }
  }
  if (s.selectedIds.length === 1) {
    const handle = ec.view.pickResizeHandle(e.clientX, e.clientY)
    if (handle) {
      dragOps.beginResizeDrag(ec, e, handle, s)
      return
    }
  }
  // guard-openings mode: a press on a guard (not a dot) sweeps a new opening or grabs the one it is in
  if (s.sideGuardMode && dragOps.beginGuardWallPress(ec, e, s)) return

  // while running the live boxes sit on top of the conveyors; clicking one
  // selects it (promoting a transient spawner box into the scene) ahead of the
  // part underneath
  if (s.running) {
    const box = ec.view.pickBox(e.clientX, e.clientY)
    if (box) {
      ec.selectBox(box, e.shiftKey)
      return
    }
  }

  // Author mode (a custom part opened in its own scene): a click on an internal rig link selects that
  // link node for read-only inspection, mirroring selecting a node inside an opened scene. The
  // gizmo/resize/box checks above still win, so posing the rig is unaffected. A hit that isn't one of
  // this part's links (empty space, or the bare root) falls through to normal part picking below.
  if (s.focusedPartId) {
    const link = ec.view.pickRigLink(e.clientX, e.clientY, s.focusedPartId)
    // a locked link isn't viewport-pickable: fall through to part picking, so the
    // click selects the part root instead. The Scene-tree row can still select it for inspection.
    if (link && !ec.store.isRigNodeLocked(s.focusedPartId, link)) {
      // re-grabbing the already-selected node's body free-moves it on the camera-facing plane, exactly as
      // re-grabbing a selected part does; the first press only selects it
      const rn = s.selectedRigNode
      if (rn && rn.partId === s.focusedPartId && rn.linkName === link && (s.tool === 'move' || s.tool === 'transform')) {
        dragOps.beginGizmoDrag(ec, e, 'view', s)
        return
      }
      ec.store.selectRigNode(s.focusedPartId, link)
      return
    }
  }

  const rawPick = ec.view.pickPart(e.clientX, e.clientY)
  // a click inside a grouped subtree selects the group's root,
  // so the group moves/selects as one (the tree can still pick the part directly)
  const root = rawPick ? groupRoot(s.scene.parts, rawPick) : null
  // ...but a double-click drills in to the part actually under the cursor (the Blender/Figma
  // idiom). Without it a grouped part is unreachable from the viewport, and so is anything keyed on
  // the part being the selection: the pose gizmo on a palletizer inside a "cell" group would never
  // appear. Doubling on the drag branch below would break dragging a
  // group by its body, so the drill-in is its own gesture.
  const picked = dblClick(pp, ec, e) && rawPick !== null && root !== rawPick ? rawPick : root
  if (picked) {
    if (e.shiftKey) {
      ec.store.toggleSelect(picked)
      return
    }
    if (s.selectedIds.length === 1 && s.selectedIds[0] === picked) {
      // re-grabbing the already-selected part body free-translates it on the
      // camera-facing plane; axis-lock keys constrain it
      if (s.tool === 'move' || s.tool === 'transform') dragOps.beginGizmoDrag(ec, e, 'view', s)
      return
    }
    ec.store.select(picked)
    return
  }

  if (s.tool === 'select' || s.tool === 'move' || s.tool === 'transform') {
    ec.container.setPointerCapture(e.pointerId)
    ec.drag = { kind: 'band', pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, shift: e.shiftKey, el: null }
  } else if (!e.shiftKey) {
    ec.store.clearSelection()
  }
}

export function onPointerMove(pp: PointerPress, ec: EditorController, e: PointerEvent): void {
  if (ec.view.isNavigating()) return // pilot/freelook drives the camera, not the editor
  ec.lastPointer = { x: e.clientX, y: e.clientY }
  // touch: a press that travels past the slop is a camera gesture (orbit/pinch), not a tap
  if (
    pp.touchTap &&
    e.pointerId === pp.touchTap.pointerId &&
    !pp.touchTap.moved &&
    Math.hypot(e.clientX - pp.touchTap.x, e.clientY - pp.touchTap.y) > TAP_SLOP_PX
  ) {
    pp.touchTap.moved = true
  }
  // chorded right-click aborts an in-flight transform / reposition (RMB
  // cancel). Pressing a second mouse button while the first is held fires a
  // pointermove, not a pointerdown, so the right button is read off the bitmask.
  if ((e.buttons & 2) !== 0) {
    if (ec.drag) {
      dragOps.cancelActiveDrag(ec)
      return
    }
    if (ec.reposition) {
      ec.cancelReposition()
      return
    }
  }
  // vertex-snap mode, not yet dragging: track the source vertex under the cursor
  if (ec.vsnap && !ec.drag) {
    ec.updateVertexSnapSource(e.clientX, e.clientY, e.shiftKey)
    return
  }
  const s = ec.store.getState()

  if (ec.reposition) {
    ec.updateReposition(e.clientX, e.clientY, e.altKey)
    return
  }

  // touch has no hover, and a one-finger move in placing mode is an orbit (the tap
  // that follows places); skip the preview-follow so the camera, not the preview, responds
  if (s.mode === 'placing' && s.placingType && e.pointerType !== 'touch') {
    placementOps.previewPlacing(ec.placement, ec, e.clientX, e.clientY, e.altKey)
    return
  }

  const drag = ec.drag
  if (!drag) {
    if (e.pointerType === 'touch') return // no gizmo/resize hover highlight on touch
    ec.refreshHoverHighlight(s, e.clientX, e.clientY)
    return
  }
  if (e.pointerId !== drag.pointerId) return
  // Every drag here is made with a button held, so a move with none means the release was lost (Alt-Tab mid-drag
  // swallows the pointerup). Cancel, as Escape does, rather than keep moving the part with no button down.
  if (e.buttons === 0) {
    dragOps.cancelActiveDrag(ec)
    return
  }
  // the snap-invert modifier: Ctrl, or Cmd on a Mac, the way the keymap reads "ctrl" (core/keymap.ts matchesChord)
  const snapKey = e.ctrlKey || e.metaKey
  switch (drag.kind) {
    case 'band':
      dragOps.moveBand(ec, drag, e)
      break
    case 'gizmo':
      dragOps.moveGizmo(ec, drag, e.clientX, e.clientY, snapKey, e.altKey, e.shiftKey)
      break
    case 'rigNode':
      dragOps.moveRigNode(ec, drag, e.clientX, e.clientY, snapKey, e.shiftKey)
      break
    case 'rotate':
      dragOps.moveRotate(ec, drag, e.clientX, e.clientY, snapKey, e.shiftKey, e.altKey)
      break
    case 'resize':
      dragOps.moveResize(ec, drag, e)
      break
    case 'guardOpening':
      dragOps.moveGuardOpening(ec, drag, e)
      break
    case 'ruler':
      moveRuler(ec, drag, e)
      break
    case 'rigGizmo':
      dragOps.moveRigGizmo(ec, drag, e)
      break
    case 'vertexSnap':
      ec.moveVertexSnap(drag, e.clientX, e.clientY, e.shiftKey)
      break
  }
}

export function onPointerUp(pp: PointerPress, ec: EditorController, e: PointerEvent): void {
  // touch never holds an editor capture-drag: a press that lifts without travelling
  // is a tap (select/place); anything else was a camera gesture handled by OrbitControls
  if (e.pointerType === 'touch') {
    const tap = pp.touchTap
    if (tap && tap.pointerId === e.pointerId) {
      pp.touchTap = null
      if (!tap.moved) ec.resolveTap(e.clientX, e.clientY, tap.shift)
    }
    return
  }
  if (e.button !== 0) return
  const drag = ec.drag
  if (!drag || e.pointerId !== drag.pointerId) return
  ec.drag = null
  if (ec.container.hasPointerCapture(e.pointerId)) ec.container.releasePointerCapture(e.pointerId)

  if (drag.kind === 'band') {
    dragOps.finishBand(ec, drag, e)
    return
  }
  if (drag.kind === 'ruler') {
    // a drag leaves the measurement on screen; a bare click clears it
    if (!drag.moved) ec.clearRuler()
    return
  }
  if (drag.kind === 'rigGizmo') {
    // the rig posed its own visual (transient authoring pose); nothing to commit to the scene - except a
    // tool-size handle drag, whose streamed param transients commit here as one undo step
    ec.view.endRobotDrag()
    if (drag.sizeParam !== undefined && drag.start) {
      if (drag.moved) ec.store.commit('Resize tool', ec.store.getState().scene, { before: drag.start })
      else ec.store.setTransient(drag.start)
    } else {
      ec.noteRigJog(drag.id) // a joint or IK drag held the arm somewhere new: the Inspector says it is not saved
    }
    return
  }
  if (drag.kind === 'vertexSnap') {
    dragOps.setDraggedBodyFrozen(ec, drag.ids, false)
    ec.view.setTransformReadout(null)
    // a vertex snap is a translation - same commit-seam re-rest as the main commit below, so a legged
    // deck snapped onto/off a platform regrows its legs to the surface now beneath it
    if (drag.moved)
      ec.commitTransform('Vertex Snap', ec.reRestSurfaceParams(ec.store.getState().scene, drag.ids), { before: drag.start })
    // mode may still be armed (B still held): re-pick a fresh source; else clear the markers
    if (ec.vsnap) ec.updateVertexSnapSource(e.clientX, e.clientY, e.shiftKey)
    else ec.view.showVertexMarkers(null, null)
    ec.resetSnap()
    return
  }
  // author-mode rig-node drag: edits were applied live to the package (not the scene), so there's nothing to
  // commit - just release the gizmo basis and reposition the gizmo on the link's new spot.
  if (drag.kind === 'rigNode') {
    ec.view.endGizmoDrag()
    ec.view.setTransformReadout(null)
    ec.view.showRotationFeedback(null)
    // one undo step for the whole drag: before = pre-drag package, after = the live-registered result.
    // commitPackage's (non-transient) store update drives onStoreChange → pushGizmo, re-centering the gizmo.
    if (drag.moved) {
      const after = getPackage(drag.packageId)
      if (after) ec.store.commitPackage(dragOps.isRigNodeRotation(drag) ? 'Rotate node' : 'Move node', after, { before: drag.startPkg })
    } else {
      ec.pushGizmo(ec.store.getState()) // no edit to commit; just settle the gizmo
    }
    ec.resetSnap()
    return
  }
  if (drag.kind === 'gizmo' || drag.kind === 'rotate') ec.view.endGizmoDrag()
  if (drag.kind === 'gizmo' || drag.kind === 'rotate') dragOps.setDraggedBodyFrozen(ec, drag.ids, false)
  if (drag.kind === 'rotate') ec.view.showRotationFeedback(null)
  if (drag.kind === 'gizmo') ec.view.setTransformReadout(null)
  if (drag.kind === 'resize' || drag.kind === 'guardOpening') ec.view.endResizeDrag()
  if (drag.kind === 'guardOpening') {
    // a click selects (or clears) an opening and commits nothing; a drag is one undo step
    const { after, select } = dragOps.finishGuardOpening(ec, drag)
    if (after) ec.commitTransform('Edit guard opening', after, { before: drag.start })
    ec.store.setSelectedGuardOpening(select)
    ec.resetSnap()
    return
  }
  // Shift+drag duplicate: `before` is the pre-clone scene, so one undo removes the copies.
  const dup = drag.kind === 'gizmo' || drag.kind === 'rotate' ? drag.dup : undefined
  if (!drag.moved) {
    // released without moving: keep the copies (stacked on the originals) as their own single
    // undo step, exactly like a plain Duplicate; a non-duplicate no-move drag commits nothing.
    if (dup) {
      ec.store.commit(
        dup.origSelection.length > 1 ? 'Duplicate parts' : 'Duplicate part',
        ec.store.getState().scene,
        { before: dup.before },
      )
    }
    ec.resetSnap()
    return
  }
  // the snap mover: the single dragged part, or the root of a single-root subtree drag (a host carrying
  // its attached devices). Must match filterSingle/applyPoses so the commit folds the same candidate
  // the preview showed.
  const movingId = drag.kind === 'resize' ? drag.id : dragOps.snapRootOf(drag.start, drag.ids)
  // resize only touches params; it never carries structural snap overrides
  let after = drag.kind === 'resize' ? ec.store.getState().scene : ec.withSnapOverrides(ec.store.getState().scene, movingId)
  // the commit-seam rest invariant: any drag that moved or reshaped parts re-resolves their
  // rest:'surfaceBelow' params from the surface now beneath them (one raycast per legged part, no-op for
  // the rest): translate up/down/onto a platform, a rotate orbiting a conveyor about its bed centre, a
  // resize sliding an inclined bed's origin along the slope or any origin across a platform edge. Gating
  // this per gesture orphans an inclined resize's legs, so don't add a kind check here.
  after = ec.reRestSurfaceParams(
    after,
    drag.kind === 'resize' ? [drag.id] : drag.ids,
  )
  const label = dup
    ? dup.origSelection.length > 1
      ? 'Duplicate parts'
      : 'Duplicate part'
    : drag.kind === 'resize'
      ? 'Resize part'
      : drag.kind === 'rotate'
        ? drag.ids.length > 1
          ? 'Rotate parts'
          : 'Rotate part'
        : drag.kind === 'gizmo' && drag.ids.length > 1
          ? 'Move parts'
          : 'Move part'
  ec.commitTransform(label, after, { before: dup ? dup.before : drag.start })
  ec.resetSnap()
}

export function onPointerCancel(pp: PointerPress, ec: EditorController, e: PointerEvent): void {
  if (e.pointerType === 'touch') {
    if (pp.touchTap && pp.touchTap.pointerId === e.pointerId) pp.touchTap = null
    return
  }
  if (!ec.drag || e.pointerId !== ec.drag.pointerId) return
  dragOps.cancelActiveDrag(ec)
}

/**
 * Resolve a touch tap (press + release with no travel) at the given point. Mirrors
 * the mouse pointer-down selection/placement, minus the capture-drag affordances:
 * place in placing mode, list-select with the List tool, otherwise pick the live
 * box (while running) or a part - an empty tap clears the selection (Shift appends).
 */
export function resolveTap(ec: EditorController, clientX: number, clientY: number, shift: boolean): void {
  if (ec.drag || ec.reposition) return
  const s = ec.store.getState()
  if (s.mode === 'placing' && s.placingType) {
    const preview = placementOps.computePlacing(ec.placement, ec, s.placingType, clientX, clientY, false)
    if (preview) placementOps.placePart(ec.placement, ec, s.placingType, preview)
    return
  }
  if (s.tool === 'ruler') return // measuring needs a two-point drag; a tap is a no-op
  if (s.tool === 'list') {
    ec.listSelect(clientX, clientY, shift)
    return
  }
  if (s.running) {
    const box = ec.view.pickBox(clientX, clientY)
    if (box) {
      ec.selectBox(box, shift)
      return
    }
  }
  const picked = ec.view.pickPart(clientX, clientY)
  if (picked) {
    if (shift) ec.store.toggleSelect(picked)
    else ec.store.select(picked)
    return
  }
  if (!shift) ec.store.clearSelection()
}

// --- mouse wheel ---------------------------------------------------------
// the scroll wheel rotates the part being placed or repositioned in rotate-snap
// steps, blocking the camera zoom while it does. Both placement gestures keep the editor in
// placing mode (click-to-place steered by pointermove, drag-to-place by the
// card's captured pointer), and wheel events are never pointer-captured, so the
// wheel reaches us here in either case.
export function onWheel(ec: EditorController, e: WheelEvent): void {
  if (ec.view.isNavigating()) return // freelook owns the wheel (fly speed)
  const step = e.deltaY < 0 ? ROTATION_SNAP : -ROTATION_SNAP
  if (ec.reposition) {
    ec.turnReposition(step, e.altKey)
  } else if (ec.store.getState().mode === 'placing') {
    ec.placement.angle = normalizeAngle(ec.placement.angle + step)
    if (ec.lastPointer) placementOps.previewPlacing(ec.placement, ec, ec.lastPointer.x, ec.lastPointer.y, e.altKey)
  } else {
    return // nothing live: let the view zoom toward the cursor
  }
  e.preventDefault()
  e.stopPropagation()
}

/** true when this press is the second half of a double-click on the same spot */
export function dblClick(pp: PointerPress, ec: EditorController, e: PointerEvent): boolean {
  const prev = pp.lastPress
  pp.lastPress = { t: performance.now(), x: e.clientX, y: e.clientY }
  return (
    prev !== null &&
    pp.lastPress.t - prev.t < DOUBLE_CLICK_MS &&
    Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_CLICK_SLOP_PX
  )
}

/**
 * list-select: enumerate every part under the cursor and,
 * when more than one overlaps, pop the picker so any of them - not just the
 * front-most pickPart would return - can be selected. One hit selects directly;
 * none is a no-op (never deselects). Shift appends.
 */
export function listSelect(ec: EditorController, clientX: number, clientY: number, append: boolean): void {
  const s = ec.store.getState()
  if (s.mode === 'placing' || ec.reposition || ec.drag) return
  const byId = new Map(s.scene.parts.map((p) => [p.id, p]))
  const items: ListSelectItem[] = []
  for (const id of ec.view.pickPartsAt(clientX, clientY)) {
    const part = byId.get(id)
    if (part)
      items.push({
        id,
        name: partDisplayName(part, s.scene.parts),
        type: part.type,
        packageId: part.type === 'part' ? (part as SdkPart).packageId : undefined,
      })
  }
  if (items.length === 0) return
  if (items.length === 1) {
    const id = items[0]!.id
    if (append) ec.store.toggleSelect(id)
    else ec.store.select(id)
    return
  }
  ec.store.openListSelect({ x: clientX, y: clientY, items, append })
}

export function moveRuler(ec: EditorController, drag: Drag & { kind: 'ruler' }, e: PointerEvent): void {
  const b = ec.view.measurePoint(e.clientX, e.clientY)
  if (!b) return
  if (b[0] !== drag.a[0] || b[1] !== drag.a[1] || b[2] !== drag.a[2]) drag.moved = true
  ec.view.setRuler(drag.a, b)
}
