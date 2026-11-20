// Transform gizmo, resize handles and the IK gizmo of the EditorController (../controller.ts).
// No state of its own (the view holds the gizmos); it reads the selection, live cargo and the drag in flight,
// and shares the drag module's helpers, so every function takes the owning controller (`ec`).

import { isCargoPart } from '../../core/frame'
import { curvedGizmoOf, flexPathOf, effectiveResize, isConveyorLike, partFootprint, toWorldXZ } from '../../core/parts/partGeometry'
import type { PartInstance } from '../../core/types'
import { junctionOpeningRows } from '../../core/junctionOpeningRows'
import type { ResizeHandle } from '../../render/api'
import { guardOpeningsTarget } from '../store/store'
import type { EditorState } from '../store/store'
import * as dragOps from './drag'
import type { EditorController } from '../controller'

// phones/tablets have no precise pointer: a fingertip can't grab the gizmo's small
// axis/ring handles, and touch never starts a gizmo drag anyway (see onPointerDown).
// Drawing the manipulator there is a false affordance that only occludes the selection,
// so suppress it (gizmoVisible) and rely on the selection outline + Inspector for edits.
// Evaluated once at startup; guarded for non-DOM test envs where matchMedia is absent.
export const IS_COARSE_POINTER =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false

// Re-evaluate the gizmo/resize hover highlight at a screen position. Separate from
// the pointermove path so a tool-mode change can refresh it immediately.
export function refreshHoverHighlight(ec: EditorController, s: EditorState, x: number, y: number): void {
  // a pose gizmo handle beats everything below it, as it does on press (pointer.ts)
  const rigHandle = ec.singleRigGizmoId(s) ? ec.view.pickRobotHandle(x, y) : null
  ec.view.setRobotHighlight(rigHandle)
  const flexDot = rigHandle ? null : ec.pickFlexDot(s, x, y)
  const gizmoHandle = !rigHandle && !flexDot && ec.gizmoVisible(s) ? ec.view.pickGizmoHandle(x, y) : null
  ec.view.setGizmoHighlight(gizmoHandle)
  // gizmo wins when both are under the cursor, matching begin-drag precedence (a flex path dot excepted)
  const dot = flexDot ?? (!rigHandle && !gizmoHandle && s.selectedIds.length === 1 ? ec.view.pickResizeHandle(x, y) : null)
  ec.view.setResizeHighlight(dot)
  // guard-openings mode: off a dot, the point on a guard under the pointer shows where a press would act
  const target = s.sideGuardMode && !dot ? guardOpeningsTarget(s) : null
  ec.view.setGuardWallHover(target ? dragOps.guardWallUnder(ec, s, target.id, x, y) : null)
}

/**
 * A flex conveyor's path dot (its infeed or a control point) under the pointer, or null. These are the resize
 * handles that take precedence over the transform gizmo. The infeed is the part origin, where the gizmo pivots, so
 * under a gizmo-first rule it could never be grabbed. The control points sit along the bed's own +X, where the
 * gizmo's X arrow lies, so from any distance where the arrow reaches them the arrow would take the press and move
 * the part instead of the point. The dots are small, so the gizmo's arrows and planes stay reachable around them.
 */
export function pickFlexDot(ec: EditorController, s: EditorState, x: number, y: number): ResizeHandle | null {
  if (s.selectedIds.length !== 1) return null
  const handle = ec.view.pickResizeHandle(x, y)
  return handle && 'flexPoint' in handle ? handle : null
}

export function gizmoVisible(ec: EditorController, s: EditorState): boolean {
  // a viewer can select (highlight) but never transform - hide the gizmo handles entirely
  if (ec.readOnly) return false
  // author mode: a selected rig node gets a scene part's gizmo - move arrows, rotate rings, or both, by tool -
  // for its offset and rest rotation (its size stays in the Inspector: a node has no face handles). Coarse
  // pointers edit via the Inspector only.
  if (s.selectedRigNode) {
    // a locked rig node keeps its tree selection but shows no gizmo (mirrors a locked scene part below)
    if (ec.store.isRigNodeLocked(s.selectedRigNode.partId, s.selectedRigNode.linkName)) return false
    return !IS_COARSE_POINTER && (s.tool === 'transform' || s.tool === 'move' || s.tool === 'rotate')
  }
  if (s.mode === 'placing' || s.selectedIds.length === 0) return false
  // guard-openings mode edits the openings, not the part: its drags run along the guards, where the move
  // arrows would otherwise sit on top of them
  if (s.sideGuardMode) return false
  // coarse-pointer devices (phones/tablets) can't grab the gizmo handles, so don't
  // draw the manipulator at all; editing happens through the Inspector there.
  if (IS_COARSE_POINTER) return false
  // skip locked nodes when building the gizmo: a
  // selection holding a locked part shows no gizmo, so it can't be dragged
  if (ec.selectedParts(s).some((p) => p.locked)) return false
  // select draws no gizmo; the face handles (pushResizeHandles) still show there, so it doubles as resizing
  return s.tool === 'transform' || s.tool === 'move' || s.tool === 'rotate'
}

export function partGizmoCenter(ec: EditorController, part: PartInstance): [number, number, number] {
  const fp = partFootprint(part)
  const cx = fp.cx ?? 0
  const cz = fp.cz ?? 0
  if (cx === 0 && cz === 0) return [part.position[0], part.position[1], part.position[2]]
  const w = toWorldXZ(part, cx, cz)
  return [w.x, part.position[1], w.z]
}

export function pushGizmo(ec: EditorController, s: EditorState): void {
  if (!ec.gizmoVisible(s)) {
    ec.view.setGizmo(null)
    return
  }
  // author mode: a rig-node selection shows the tool's gizmo, world-axis, at the link's world position; an
  // arrow or the body moves its offset, a ring turns its rest rotation (beginGizmoDrag / moveRigNode)
  // The gizmo is drawn in the frame the node's offset is stored in (its parent's, tilted for an inclined rig's
  // top-level link), so each arrow is one stored axis - which is what lets an axis the part sets itself
  // (linkFieldOwnership: a param-driven offset, an aimed rotation) have no handle.
  if (s.selectedRigNode) {
    const nf = dragOps.rigNodeEditFrame(ec, s)
    const nodeMode = s.tool === 'transform' ? 'transform' : s.tool === 'rotate' ? 'rotate' : 'move'
    const q = nf?.frameQuat
    ec.view.setGizmo(
      nf && q
        ? {
            center: nf.worldPos,
            rotationY: 0,
            mode: nodeMode,
            space: 'local',
            frame: [q.x, q.y, q.z, q.w],
            lockMove: nf.own.offset.map((o) => o !== null) as [boolean, boolean, boolean],
            lockRotate: nf.own.rotation !== null,
          }
        : null,
    )
    return
  }
  const parts = ec.selectedParts(s)
  if (parts.length === 0) {
    ec.view.setGizmo(null)
    return
  }
  // a selected live box: pin the gizmo's center to its moving body but keep the
  // authored yaw, so starting the sim doesn't snap the gizmo's orientation. We
  // can't track the body's live yaw (it's unstable while the box tumbles), and
  // forcing 0 flips any part placed at a non-zero angle. Position is stale until Stop.
  const mode = s.tool === 'transform' ? 'transform' : s.tool === 'rotate' ? 'rotate' : 'move'
  const live = ec.selectedLiveCargo(s)
  // freshly selecting moving boxes: liveCargo is only ticked on the next sim frame, so without
  // this the first pushGizmo falls through to the authored-spawn center and the gizmo visibly
  // jumps onto the bodies one frame later. Seed it from the latest frame now so the gizmo starts
  // on the live bodies.
  if (
    !ec.drag &&
    ec.lastFrame &&
    parts.some((p) => isCargoPart(p) && !ec.liveCargo.has(p.id))
  ) {
    ec.refreshLiveCargo(ec.lastFrame, s)
  }
  const livePose = live ? ec.liveCargo.get(live.id) : undefined
  if (live && livePose && !ec.drag) {
    ec.view.setGizmo({
      center: [...livePose.position],
      rotationY: live.rotationY,
      rotationX: live.rotationX,
      rotationZ: live.rotationZ,
      mode,
      space: s.space,
      trackball: s.trackball,
    })
    return
  }
  let cx = 0
  let cy = 0
  let cz = 0
  for (const p of parts) {
    // running cargo: physics owns the body, so the authored transform is a stale spawn pose -
    // average the live positions or a banded group's gizmo anchors where the boxes started.
    // Otherwise the footprint centre, not the data origin: conveyors anchor on the bed.
    const c = ec.liveCargo.get(p.id)?.position ?? ec.partGizmoCenter(p)
    cx += c[0]
    cy += c[1]
    cz += c[2]
  }
  const n = parts.length
  const single = n === 1 ? parts[0]! : null
  // local space orients the rings to a part's frame; use the active node (the
  // last-selected, == the last id in selectedIds) for a multi-selection - the same node
  // a Shift+G reposition steers - so a shift-click that switches the active node
  // reorients the gizmo too. Single-select is just that one part; global = world axes.
  const activeId = s.selectedIds[s.selectedIds.length - 1]
  const active = parts.find((p) => p.id === activeId) ?? parts[n - 1]!
  const orient = s.space === 'local' ? active : single
  ec.view.setGizmo({
    center: [cx / n, cy / n, cz / n],
    rotationY: orient ? orient.rotationY : 0,
    rotationX: orient ? orient.rotationX : undefined,
    rotationZ: orient ? orient.rotationZ : undefined,
    mode,
    space: s.space,
    trackball: s.trackball,
    // conveyors are yaw-only (incline is the tiltDeg param, never transform pitch/roll);
    // any conveyor in the selection locks the tilt rings so a drag can't tilt it.
    rotateYawOnly: parts.some((p) => isConveyorLike(p)),
  })
}

export function pushResizeHandles(ec: EditorController, s: EditorState): void {
  const parts = ec.selectedParts(s)
  const single = parts.length === 1 ? parts[0]! : null
  const resize = single ? effectiveResize(single) : null
  const show =
    single !== null &&
    resize !== null &&
    !IS_COARSE_POINTER && // touch can't grab the face-cube handles either - see gizmoVisible
    single.locked !== true && // locked parts show no handles
    (resize.x === true || resize.y === true || resize.z === true || curvedGizmoOf(single) !== null || flexPathOf(single) !== null) &&
    s.mode !== 'placing' &&
    s.tool !== 'ruler' &&
    s.tool !== 'list' &&
    !ec.liveCargoSelected(s)
  ec.view.setSideGuardMode(s.sideGuardMode)
  ec.view.setResizeHandles(show ? single : null)
  ec.view.setSelectedGuardOpening(s.sideGuardMode ? s.selectedGuardOpening : null)
  // the gaps neighbours already cut are not solid guard to sweep (core/junctionOpeningRows)
  const target = s.sideGuardMode ? guardOpeningsTarget(s) : null
  ec.view.setGuardJunctionOpenings(target ? junctionOpeningRows(target, s.scene.parts) : null)
}

/** the single selected custom rig part whose visual exposes an IK gizmo, else null. The six-axis robot is
 *  an SDK custom part, so it reaches the gizmo through this path like any other rig. */
export function singleRigGizmoId(ec: EditorController, s: EditorState): string | null {
  if (IS_COARSE_POINTER) return null
  // a running sim poses the rig every frame (applyBoxFrame), so a drag would be undone as it was made
  if (s.running) return null
  if (s.selectedIds.length !== 1 || s.mode === 'placing') return null
  const id = s.selectedIds[0]!
  const p = s.scene.parts.find((x) => x.id === id)
  return p && p.type === 'part' && p.locked !== true && ec.view.hasRigGizmo(id) ? id : null
}

/** the part whose IK gizmo is interactive (a custom rig part) */
export function singleManipulatorId(ec: EditorController, s: EditorState): string | null {
  return ec.singleRigGizmoId(s)
}

export function pushRobotGizmo(ec: EditorController, s: EditorState): void {
  ec.view.setRobotGizmo(singleManipulatorId(ec, s))
}
