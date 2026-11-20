// Keyboard handling of the EditorController (../controller.ts). The input router: no state of
// its own, and it drives every other area, so every function takes the owning controller (`ec`) and reaches
// each area through the controller's entry points.

import { resolveKeyAction } from '../../core/keymap'
import { keyBelongsToTarget } from '../dialogHost'
import * as dragOps from './drag'
import * as placementOps from './placement'
import type { EditorController } from '../controller'

/** an unmodified, non-repeat "Use" press - shared by the normal shortcut path and the
 *  mid-drag/reposition guards, which swallow keys before the main dispatch. Resolved through the
 *  keymap like everything else, so a rebind can't leave these two paths disagreeing. */
function isPlainUseKey(e: KeyboardEvent): boolean {
  return !e.repeat && resolveKeyAction(e, 'editor') === 'sim.use'
}

export function onKeyDown(ec: EditorController, e: KeyboardEvent): void {
  if (ec.view.isNavigating()) return
  // a key meant for the focused field or control (dialogHost.ts): typing, the ST editor and its find bar, Space on a
  // checkbox. A control keeps only the keys it uses, so Ctrl+Z still undoes after clicking an Inspector checkbox.
  if (keyBelongsToTarget(e)) return
  // keyboard edits interleaved with an in-flight transient drag would corrupt history
  if (ec.drag) {
    if (e.key === 'Escape') {
      dragOps.cancelActiveDrag(ec)
      e.preventDefault()
    } else if (
      // Use (C) mid-drag: pin the grabbed cargo box so the release leaves it frozen where it's
      // dropped instead of handing it back to gravity/conveyors; a second press unpins. The body
      // is already kinematic for the gesture, so nothing changes until release.
      isPlainUseKey(e) &&
      (ec.drag.kind === 'gizmo' || ec.drag.kind === 'rotate') &&
      dragOps.toggleCargoPin(ec, ec.drag.ids)
    ) {
      e.preventDefault()
    } else if (dragOps.constrainActiveDrag(ec, e)) {
      e.preventDefault()
    }
    return
  }
  // an in-flight Shift+G reposition is modal: Esc cancels, C pins grabbed cargo (as above), Alt
  // engages the face snap, X/Y/Z pick its alignment axis; everything else waits
  if (ec.reposition) {
    if (e.key === 'Escape') {
      ec.cancelReposition()
      e.preventDefault()
    } else if (isPlainUseKey(e) && dragOps.toggleCargoPin(ec, [ec.reposition.id])) {
      e.preventDefault()
    } else if (e.key === 'Alt') {
      // engage the Alt face snap immediately, not just on the next mouse move
      if (ec.lastPointer) ec.updateReposition(ec.lastPointer.x, ec.lastPointer.y, true)
      e.preventDefault()
    } else {
      // X/Y/Z pick which local axis aligns to the surface normal (Shift = negative)
      const k = e.key.toLowerCase()
      if (k === 'x' || k === 'y' || k === 'z') {
        ec.surfaceAlignAxis = (k === 'x' ? 0 : k === 'y' ? 1 : 2) + (e.shiftKey ? 3 : 0)
        if (ec.lastPointer) ec.updateReposition(ec.lastPointer.x, ec.lastPointer.y, e.altKey)
        e.preventDefault()
      }
    }
    return
  }
  // Face snap while placing from the catalog (Alt held): Alt engages immediately and
  // X/Y/Z pick the alignment axis (Shift = negative) - same keys as the reposition gesture
  if (e.altKey && ec.store.getState().mode === 'placing') {
    const k = e.key.toLowerCase()
    if (e.key === 'Alt' || k === 'x' || k === 'y' || k === 'z') {
      if (k === 'x' || k === 'y' || k === 'z') {
        ec.surfaceAlignAxis = (k === 'x' ? 0 : k === 'y' ? 1 : 2) + (e.shiftKey ? 3 : 0)
      }
      if (ec.lastPointer) placementOps.previewPlacing(ec.placement, ec, ec.lastPointer.x, ec.lastPointer.y, true)
      e.preventDefault()
      return
    }
  }
  // Esc leaves armed (not yet dragging) vertex-snap mode before any other shortcut
  if (ec.vsnap && e.key === 'Escape') {
    ec.disarmVertexSnap()
    e.preventDefault()
    return
  }
  const s = ec.store.getState()

  // Escape runs ahead of the keymap: it isn't one action but "back out of whatever is in
  // flight", so it can't be a single table entry. It's listed there as `fixed` - documented in
  // the shortcuts panel, never routed through the resolver, never remappable.
  if (e.key === 'Escape') {
    // one press backs out one level. Without this, holding Escape to cancel a drag (handled above)
    // or a camera move (the view stops only the first press) lets the auto-repeats walk on through
    // the ruler, placing and guard mode to the selection.
    if (e.repeat) {
      e.preventDefault()
      return
    }
    // editing the display's values included: each change is saved as it is made, so leaving loses nothing
    if (s.presenting) ec.store.setState({ presenting: false })
    else if (ec.rulerVisible) ec.clearRuler()
    else if (s.mode === 'placing') ec.store.cancelPlacing()
    // guard-openings mode backs out one level at a time: the selected opening, then the mode (the conveyor
    // stays selected), and only then the selection
    else if (s.sideGuardMode && s.selectedGuardOpening) ec.store.setSelectedGuardOpening(null)
    else if (s.sideGuardMode) ec.store.setSideGuardMode(false)
    else ec.store.clearSelection()
    e.preventDefault()
    return
  }

  // Everything else resolves through the keymap (core/keymap.ts) rather than comparing keys
  // inline: spatial keys match the physical key so the tool cluster doesn't scatter on AZERTY,
  // the Ctrl family matches the printed legend, and the shortcuts panel renders off the same
  // table - a binding can't ship undocumented.
  const action = resolveKeyAction(e, 'editor')
  switch (action) {
    case 'edit.undo':
      ec.store.undo()
      e.preventDefault()
      return
    case 'edit.redo':
      ec.store.redo()
      e.preventDefault()
      return
    case 'edit.duplicate':
      ec.store.duplicateSelection()
      e.preventDefault()
      return
    case 'edit.copy':
      ec.store.copySelection()
      e.preventDefault()
      return
    case 'edit.cut':
      // Cut: copy the selection, then delete it
      ec.store.cutSelection()
      e.preventDefault()
      return
    case 'edit.paste':
      ec.store.paste()
      e.preventDefault()
      return
    case 'edit.moveUp':
      // Move Up: shift the selection up one slot
      ec.store.moveSelection(-1)
      e.preventDefault()
      return
    case 'edit.moveDown':
      // Move Down: shift the selection down one slot
      ec.store.moveSelection(1)
      e.preventDefault()
      return
    case 'edit.lock':
      ec.store.setLocked(s.selectedIds, true)
      e.preventDefault()
      return
    case 'edit.unlock':
      ec.store.setLocked(s.selectedIds, false)
      e.preventDefault()
      return
    case 'edit.toggleVisible': {
      // the scene-tree menu's Hide / Show rule: hide when all of the selection is visible,
      // otherwise show all of it, so a mixed selection resolves the same from either place
      if (s.selectedIds.length === 0) return
      const sel = new Set(s.selectedIds)
      const allVisible = s.scene.parts.every((p) => !sel.has(p.id) || p.visible !== false)
      ec.store.setVisible(s.selectedIds, !allVisible)
      e.preventDefault()
      return
    }
    case 'edit.group':
      ec.store.setGrouped(s.selectedIds, true)
      e.preventDefault()
      return
    case 'edit.ungroup':
      ec.store.setGrouped(s.selectedIds, false)
      e.preventDefault()
      return
    case 'edit.reparent':
      // "Reparent to New Node": wrap the
      // selection in a fresh Group container. There's no conventional default shortcut for it;
      // bound here for discoverability, since it's the real "group these into one" verb.
      ec.store.reparentToNewNode()
      e.preventDefault()
      return
    case 'view.distractionFree':
      ec.store.toggleDistractionFree()
      e.preventDefault()
      return
    case 'tool.transform':
      // Transform Mode: combined move+rotate gizmo
      ec.store.setTool('transform')
      return
    case 'tool.select':
      ec.store.setTool('select')
      return
    case 'tool.move':
      ec.store.setTool('move')
      return
    case 'tool.rotate':
      ec.store.setTool('rotate')
      return
    case 'tool.ruler':
      ec.store.setTool('ruler')
      return
    case 'view.space':
      // Use Local Space
      ec.store.toggleSpace()
      return
    case 'snap.grid':
      // Use Snap
      ec.store.toggleGridSnap()
      return
    case 'view.trackball':
      // Use Trackball: free-rotate sphere in the rotate gizmo
      ec.store.toggleTrackball()
      return
    case 'view.projection':
      // Perspective/Orthogonal view toggle. Numpad 5 is the second chord and
      // is matched by e.code - with NumLock off that key reports 'Clear'.
      ec.store.toggleProjection()
      e.preventDefault()
      return
    case 'view.front':
    case 'view.rear':
    case 'view.right':
    case 'view.left':
    case 'view.top':
    case 'view.bottom':
      // the orbit gizmo's axis snap. Matched by e.code, so they work with NumLock off too.
      ec.viewAlongAxis(action)
      e.preventDefault()
      return
    case 'place.floor':
      // Snap Object to Floor
      ec.snapSelectedToFloor()
      e.preventDefault()
      return
    case 'place.reposition':
      // Shift+G: reposition the selection on collision surfaces
      ec.beginReposition(s)
      e.preventDefault()
      return
    case 'edit.sideGuards':
      // G: enter / leave guard-openings mode (store.setSideGuardMode). It needs one selected conveyor that
      // authors guardOpenings and ends by itself when the selection moves off it; pressed with nothing to
      // edit, it says why instead of doing nothing silently.
      if (!ec.store.toggleSideGuardMode() && !s.sideGuardMode)
        ec.store.flashViewportHint(s.readOnly ? 'View only: guard openings cannot be edited' : 'Select one conveyor with side guards to edit its openings')
      return
    case 'snap.live':
      // N: toggle live (part) snap; Shift+N: toggle just the generic face snap (boxes flushing onto
      // neighbour faces) - the declared snaps (conveyor mates, device mounts) stay on the master toggle
      ec.store.setLiveSnap(!s.liveSnap)
      return
    case 'snap.face':
      ec.store.setFaceSnap(!s.faceSnap)
      return
    case 'snap.vertex':
      // Vertex Snap: hold to snap a vertex of the
      // selection onto a vertex of another part. Release / Esc / RMB cancels.
      if (e.repeat) return
      if (!ec.vsnap) ec.armVertexSnap()
      return
    case 'view.flowArrows':
      // Toggle Flow Arrows (period)
      ec.store.toggleFlowArrows()
      return
    case 'pilot.enter':
      // enter first-person Pilot Mode (Esc exits, handled by the pilot controller)
      ec.store.enterPilot()
      e.preventDefault()
      return
    case 'view.focus': {
      if (e.repeat) {
        e.preventDefault()
        return
      }
      const ids = s.selectedIds.length > 0 ? s.selectedIds : s.scene.parts.map((p) => p.id)
      if (ids.length === 0) {
        e.preventDefault()
        return
      }
      // consecutive presses on the same selection cycle focus → follow → stop (controller/camera.ts focusPress)
      ec.focusPress(ids, s.selectedIds)
      e.preventDefault()
      return
    }
    case 'edit.delete':
      // in guard-openings mode Delete removes the selected opening and never the conveyor being edited
      if (s.sideGuardMode) ec.store.removeSelectedGuardOpening()
      else ec.store.deleteSelection()
      e.preventDefault()
      return
    case 'sim.use':
      // Use (C): use/toggle each selected part (blade stop, chain transfer, custom interactive parts
      // via the sim); selected live cargo freezes in place instead (see pilot.ts useSelection).
      // Key-repeat echoes are ignored.
      if (e.repeat) return
      ec.useSelection()
      return
  }
}

export function onKeyUp(ec: EditorController, e: KeyboardEvent): void {
  if (e.key === 'Alt' && ec.reposition) {
    // Alt released mid-reposition: drop the face-snap alignment (the part's own yaw returns)
    if (ec.lastPointer) ec.updateReposition(ec.lastPointer.x, ec.lastPointer.y, false)
    return
  }
  if (e.key === 'Alt' && ec.store.getState().mode === 'placing') {
    // Alt released mid-placement: the ghost returns to the plain rest-under-cursor preview
    if (ec.lastPointer) placementOps.previewPlacing(ec.placement, ec, ec.lastPointer.x, ec.lastPointer.y, false)
    return
  }
  if (e.key.toLowerCase() !== 'b') return
  // Releasing the hold-key ends vertex-snap mode. An in-flight drag keeps going and
  // commits on mouse-up (no source is kept once the mode is off); only the armed,
  // not-yet-dragging state disarms immediately.
  if (ec.drag?.kind === 'vertexSnap') ec.vsnap = null
  else if (ec.vsnap) ec.disarmVertexSnap()
}
