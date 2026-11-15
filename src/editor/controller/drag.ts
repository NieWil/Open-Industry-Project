// Drag state machine of the EditorController (../controller.ts). The drag in flight
// (`ec.drag`) is shared with every input module, so it stays on the controller, and a drag reaches across
// most areas (snap, live cargo, gizmo, the pool seam): every function takes the owning controller (`ec`).

import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { isCargoPart } from '../../core/frame'
import { clamp, normalizeAngle, quatFromYXZ } from '../../core/math'
import { subtreeIds } from '../../core/scene/hierarchy'
import { bandSelection } from '../../core/selection'
import { rotateXZ, yawAboutPivot } from '../../core/transforms'
import { getPackage } from '../../core/parts/partRegistry'
import { linkFieldOwnership, restQuatOf } from '../../core/rig/rigPose'
import type { LinkFieldOwnership, RigParams } from '../../core/rig/rigPose'
import { resolvePartParams } from '../../core/parts/partScript'
import type { ParamValue } from '../../core/parts/partApi'
import { rigInclineRad } from '../../core/parts/partGeometry'
import type { PartPackage, RigLink } from '../../core/parts/partPackage'
import {
  bedView,
  curvedGizmoOf,
  flexPull,
  flexPathOf,
  effectiveResize,
  isBeltLike,
  isConveyorLike,
  partNumberRange,
  resizeBeltSegmentLength,
  resizeBeltTail,
  resizeParamKey,
  resizePart,
  surfaceBelowParam,
  withFlexPose,
} from '../../core/parts/partGeometry'
import {
  guardArcRange,
  isolateOnWall,
  moveOpening,
  openingAt,
  openingSpecsToRows,
  resizeOpeningEdge,
  rowIndexAfterWrite,
  rowsToOpeningSpecs,
  snapArc,
  sweepOpening,
} from '../../core/guards/guardOpeningEdit'
import { sceneDisplayUnits } from '../../core/scene/sceneUnits'
import { formatLength } from '../../core/units'
import type { DisplayUnits } from '../../core/units'
import { FLOOR_SURFACE_Y } from '../../core/types'
import type { BeltGuardOpeningSpec, SdkPart, PartInstance, SceneJSON } from '../../core/types'
import type { SnapPose } from '../../core/snap/snapFeatures'
import type { GizmoConstraint, GizmoHandle, GizmoSnap, GuardOpeningHandle, GuardWallPoint, ResizeHandle, RobotHandle } from '../../render/api'
import { guardOpeningsTarget } from '../store/store'
import type { EditorState } from '../store/store'
import type { EditorController } from '../controller'

const BAND_THRESHOLD_PX = 8

/** "Translating: x, y, z" readout for a move delta in meters */
function fmtTranslate(t: [number, number, number]): string {
  const f = (v: number): string => (Math.abs(v) < 5e-4 ? '0' : v.toFixed(2))
  return `${f(t[0])}, ${f(t[1])}, ${f(t[2])} m`
}

// --- drag state ------------------------------------------------------------

export type Drag =
  | { kind: 'band'; pointerId: number; sx: number; sy: number; shift: boolean; el: HTMLDivElement | null }
  // restCache memoizes each legged part's resolved surface height for the live re-rest, keyed by the XZ it was
  // cast from, so a pure vertical raise (legs growing) reuses it with zero raycasts per frame - see liveReRest.
  // `dup` marks a Shift+drag duplicate: `start` already holds the staged clones (the drag moves
  // them), so on release the commit's undo `before` is `dup.before` (the pre-clone scene) - one
  // "Duplicate" step removes the copies and restores; RMB/Esc reverts to it and re-selects the
  // originals. See beginGizmoDrag / finishDrag / cancelActiveDrag.
  | { kind: 'gizmo'; pointerId: number; start: SceneJSON; ids: string[]; handle: GizmoHandle; moved: boolean; restCache?: RestCache; dup?: DupContext }
  // author mode: drag a rig node's offset (the link's local position in its parent's frame). parentInv is the
  // parent group's inverse world matrix, captured at start, to map the world-space drag delta to local.
  | { kind: 'rigNode'; pointerId: number; packageId: string; linkName: string; handle: GizmoHandle; startOffset: [number, number, number]; parentInv: number[]; startQuat: [number, number, number, number]; parentQuat: [number, number, number, number]; startPkg: PartPackage; moved: boolean; lockMove: [boolean, boolean, boolean]; lockRotate: boolean }
  | { kind: 'rotate'; pointerId: number; start: SceneJSON; ids: string[]; cx: number; cy: number; cz: number; moved: boolean; dup?: DupContext }
  | { kind: 'resize'; pointerId: number; start: SceneJSON; id: string; handle: ResizeHandle; moved: boolean }
  // Side-guard opening edit (Side Guards mode): drag an opening edge, or create one by
  // dragging a guard end inward. `start` is the pre-drag scene (undo target). `create`
  // synthesizes the opening at index `opening` (= original count) before resizing `edge`.
  // guard-openings mode. `op`: 'edge' resizes one edge of opening `index`, 'slide' moves it whole by the pointer's
  // travel from `anchor`, 'sweep' cuts a new one from `anchor` to the pointer. `base` is the part's openings with
  // the edited row isolated on `guard` (a both-sided row split first); every move rebuilds from it, so undo and
  // cancel see one clean change. `px`/`py` is the press, which a click must stay near to remain a click.
  | {
      kind: 'guardOpening'
      pointerId: number
      start: SceneJSON
      id: string
      guard: 'left' | 'right'
      op: 'edge' | 'slide' | 'sweep'
      base: BeltGuardOpeningSpec[]
      index: number
      edge: 'start' | 'end'
      anchor: number
      px: number
      py: number
      moved: boolean
      /** what the last move produced (the openings, and the edited row's index in them; -1 = none yet) */
      last: { specs: BeltGuardOpeningSpec[]; index: number } | null
    }
  | { kind: 'ruler'; pointerId: number; a: [number, number, number]; moved: boolean }
  // custom-rig gizmo drag (the rig poses its own visual, no j-params): joint = handle index, -1 for the EE.
  // Transient authoring pose held by the visual, so there's no scene/undo commit, except for a tool-size
  // (`size:<param>`) handle drag, which streams the named number param as scene transients (like a resize
  // drag) and commits once on release; `sizeParam`/`start`/`moved` are set only for that variant.
  | { kind: 'rigGizmo'; pointerId: number; id: string; joint: number; startAngle: number; sizeParam?: string; start?: SceneJSON; moved?: boolean }
  // vertex snap: translate the selection so `source` (a vertex
  // captured at drag start) lands on a vertex of another part. `ids` is the moved
  // subtree; `origin` holds each id's pre-drag position so the displacement reapplies.
  | { kind: 'vertexSnap'; pointerId: number; start: SceneJSON; ids: string[]; origin: Map<string, [number, number, number]>; source: Vector3; moved: boolean }

/** Per-drag memo of a legged part's rest surface: the XZ the surface was raycast from, and the resulting Y. */
type RestCache = Map<string, { x: number; z: number; surfaceY: number }>

/** Shift+drag-duplicate context: the pre-clone scene (undo `before`) and the pre-duplicate selection
 *  (restored on cancel). Present on a translate/rotate drag whose clones the gesture is moving. */
type DupContext = { before: SceneJSON; origSelection: string[] }

/**
 * "Use Snap": grid increments for a transform drag, or null when off.
 * The toggle's state is inverted while Ctrl is held (hold-to-toggle), matching
 * the snap modifier. A zero increment leaves that axis unsnapped.
 */
function gizmoSnap(s: EditorState, ctrl: boolean, fine = false): GizmoSnap | null {
  const g = s.gridSnap
  if (g.enabled === ctrl) return null
  // holding Shift during a snapped drag subdivides the step (translate /10, rotate /3)
  const t = fine ? g.translate / 10 : g.translate
  const r = fine ? g.rotate / 3 : g.rotate
  return {
    translate: g.translate > 0 ? t : null,
    rotate: g.rotate > 0 ? (r * Math.PI) / 180 : null,
  }
}

// --- begin drags -----------------------------------------------------------

/**
 * scene snapshot a drag starts from. For selected live boxes the authored pose is stale (physics
 * owns the bodies), so substitute their live poses - full YXZ rotation, not just yaw, so rotating
 * a tumbled/tilted body starts from where it actually is instead of snapping upright - and the
 * drag then grabs from where the boxes actually are, and the commit persists that.
 *
 * Covers the whole selection (liveCargo holds every selected running cargo part): rebasing only
 * one of a banded group would leave the rest starting from their spawn poses, so the first drag
 * would teleport them back up the line before applying the delta.
 */
export function dragStartScene(ec: EditorController, s: EditorState): SceneJSON {
  if (ec.liveCargo.size === 0) return s.scene
  return {
    ...s.scene,
    parts: s.scene.parts.map((p) => {
      const lb = ec.liveCargo.get(p.id)
      return lb
        ? ({ ...p, position: [...lb.position] as [number, number, number], rotationX: lb.rotationX, rotationY: lb.rotationY, rotationZ: lb.rotationZ } as PartInstance)
        : p
    }),
  }
}

/**
 * Everything an edit of the selected rig node works from, computed once for the gizmo, the drag and its locks:
 * the node's world position, the frame its stored offset and rest rotation live in, and who owns which of its
 * fields (core linkFieldOwnership). The frame is the parent link's world frame, except that a top-level link of
 * an inclined rig lives in the tilted root. The whole-bed incline rotates every top-level link about the root,
 * so its offset is expressed before that tilt. Without this, a drag on an inclined conveyor's node would move it
 * off the line it is dragged along, by the incline angle. Null when there is no such node to edit.
 */
export function rigNodeEditFrame(ec: EditorController, s: EditorState): { worldPos: [number, number, number]; frame: Matrix4; frameQuat: Quaternion; own: LinkFieldOwnership; pkg: PartPackage; part: SdkPart; link: RigLink } | null {
  const rn = s.selectedRigNode
  if (!rn) return null
  const part = s.scene.parts.find((p) => p.id === rn.partId)
  if (!part || part.type !== 'part') return null
  const pkg = getPackage((part as SdkPart).packageId)
  const geo = pkg?.geometry
  if (!pkg || !geo || geo.kind !== 'rig') return null
  const link = geo.links.find((l) => l.name === rn.linkName)
  const info = ec.view.rigLinkGizmo(rn.partId, rn.linkName)
  if (!link || !info) return null
  // resolved as the renderer resolves them, so a setting the part never set counts at its default
  const params = resolvePartParams(pkg.params, part.params as Record<string, ParamValue>) as RigParams
  const frame = new Matrix4().fromArray(info.parentWorld)
  const incline = link.parent ? 0 : rigInclineRad(geo, params)
  if (incline !== 0) frame.multiply(new Matrix4().makeRotationZ(incline))
  const frameQuat = new Quaternion()
  frame.decompose(new Vector3(), frameQuat, new Vector3())
  const own = linkFieldOwnership(geo, link.name, params, pkg.behavior)
  if (!own) return null
  return { worldPos: info.worldPos, frame, frameQuat, own, pkg, part: part as SdkPart, link }
}

export function beginGizmoDrag(ec: EditorController, e: PointerEvent, handle: GizmoHandle, s: EditorState): void {
  if (ec.readOnly) return
  // author mode: dragging the gizmo of a selected rig node moves that link's offset (not a scene part).
  if (s.selectedRigNode) {
    const nf = rigNodeEditFrame(ec, s)
    if (!nf) return
    const lockRotate = nf.own.rotation !== null
    // a rotation the part sets itself (an aim) is not the author's to turn; its rings are hidden anyway
    if (handle.startsWith('rot') && lockRotate) return
    ec.container.setPointerCapture(e.pointerId)
    ec.view.beginGizmoDrag(handle, e.clientX, e.clientY)
    const { link, frame, frameQuat } = nf
    ec.drag = {
      kind: 'rigNode',
      pointerId: e.pointerId,
      packageId: nf.part.packageId,
      linkName: link.name,
      handle,
      startOffset: [link.offset[0], link.offset[1], link.offset[2]],
      // world -> the frame the offset is stored in (a ring's world turn is carried into the same frame)
      parentInv: [...frame.clone().invert().elements],
      startQuat: [...restQuatOf(link)] as [number, number, number, number],
      parentQuat: [frameQuat.x, frameQuat.y, frameQuat.z, frameQuat.w],
      startPkg: nf.pkg, // pre-drag package snapshot → the undo "before" committed on release
      moved: false,
      // an axis the part sets itself keeps its value whatever the drag does (a body drag included)
      lockMove: nf.own.offset.map((o) => o !== null) as [boolean, boolean, boolean],
      lockRotate,
    }
    ec.resetSnap()
    return
  }
  // Shift+drag on a translate/rotate gizmo handle duplicates the selection and drags the copies
  // (the originals stay put); one "Duplicate" undo step is committed on release. The clones are staged
  // transiently (like any drag) and the selection retargets onto them, so `s` is rebound below so
  // the rest of begin builds the drag from the clone scene + clone selection.
  let dup: DupContext | undefined
  if (e.shiftKey) {
    const d = ec.store.duplicateSelectionDetached()
    if (d) {
      dup = { before: s.scene, origSelection: [...s.selectedIds] }
      ec.store.setTransient(d.scene, d.selectionIds)
      s = { ...s, scene: d.scene, selectedIds: d.selectionIds }
    }
  }
  ec.container.setPointerCapture(e.pointerId)
  ec.view.beginGizmoDrag(handle, e.clientX, e.clientY)
  const ids = [...s.selectedIds]
  const start = dragStartScene(ec, s)
  // soft parenting: a translate/rotate drag carries the selection's descendants
  // rigidly (the rotate pivot below stays on the selection, so children orbit it)
  const affected = subtreeIds(start.parts, ids)
  if (handle === 'rotX' || handle === 'rotY' || handle === 'rotZ' || handle === 'rotView' || handle === 'rotTrackball') {
    const parts = start.parts.filter((p) => ids.includes(p.id))
    let cx = 0
    let cy = 0
    let cz = 0
    for (const p of parts) {
      // pivot about the footprint centre (matches pushGizmo), so a conveyor yaws
      // about its bed centre rather than swinging its head about the tail origin
      const c = ec.partGizmoCenter(p)
      cx += c[0]
      cy += c[1]
      cz += c[2]
    }
    const n = Math.max(parts.length, 1)
    // pivot from the selection only; `affected` (selection + descendants) is what moves
    ec.drag = { kind: 'rotate', pointerId: e.pointerId, start, ids: affected, cx: cx / n, cy: cy / n, cz: cz / n, moved: false, dup }
  } else {
    ec.drag = { kind: 'gizmo', pointerId: e.pointerId, start, ids: affected, handle, moved: false, dup }
  }
  // deferred pool ejection: pull the grabbed subtree out of the instance pool now, while the hand is still
  // stationary, so the one-time re-bake never happens on a moving frame
  ec.syncPoolDragEject()
  setDraggedBodyFrozen(ec, affected, true)
  ec.resetSnap()
}

export function beginResizeDrag(ec: EditorController, e: PointerEvent, handle: ResizeHandle, s: EditorState): void {
  if (ec.readOnly) return
  const part = ec.selectedParts(s)[0]
  if (!part) return
  if ('guard' in handle) {
    beginGuardOpeningDrag(ec, e, handle, part, s)
    return
  }
  if ('flexPoint' in handle) {
    const flex = flexPathOf(part)
    if (!flex || (handle.flexPoint === 'infeed' ? flex.points.length === 0 : !flex.points[handle.flexPoint])) return
  } else if ('curve' in handle) {
    if (!curvedGizmoOf(part)) return
  } else if ('belt' in handle) {
    if (!isBeltLike(part)) return // built-in belt OR a belt-like SDK part (docs/part-gizmos.md)
  } else {
    const resize = effectiveResize(part) // package-driven for custom parts, not the static PART_DEFS flag
    if (!(handle.axis === 'x' ? resize.x : handle.axis === 'y' ? resize.y : resize.z)) return
  }
  ec.container.setPointerCapture(e.pointerId)
  ec.view.beginResizeDrag(handle, e.clientX, e.clientY)
  ec.drag = { kind: 'resize', pointerId: e.pointerId, start: s.scene, id: part.id, handle, moved: false }
  ec.syncPoolDragEject() // eject at pointer-down, before the first resize transient re-bakes the pool
  ec.resetSnap()
}

// --- guard-openings mode ----------------------------------------------------

/** a press that travels less than this (CSS px) is a click: it selects, it never edits */
const GUARD_CLICK_SLOP_PX = 4

function openingSpecsOf(part: PartInstance): BeltGuardOpeningSpec[] {
  return rowsToOpeningSpecs((part.params as { guardOpenings?: number[][] }).guardOpenings ?? [])
}

function withOpenings(scene: SceneJSON, id: string, specs: readonly BeltGuardOpeningSpec[]): SceneJSON {
  const rows = openingSpecsToRows(specs)
  return {
    ...scene,
    parts: scene.parts.map((p) => (p.id === id ? ({ ...p, params: { ...p.params, guardOpenings: rows } } as unknown as PartInstance) : p)),
  }
}

/** Grab an opening's edge dot: the drag resizes that edge, on that wall only. */
function beginGuardOpeningDrag(ec: EditorController, e: PointerEvent, handle: GuardOpeningHandle, part: PartInstance, s: EditorState): void {
  if (!guardArcRange(part)) return
  const specs = openingSpecsOf(part)
  if (!specs[handle.opening]) return
  ec.container.setPointerCapture(e.pointerId)
  ec.view.beginResizeDrag(handle, e.clientX, e.clientY)
  startGuardDrag(ec, e, s, part.id, handle.guard, 'edge', isolateOnWall(specs, handle.opening, handle.guard), handle.opening, handle.edge, 0)
}

/**
 * A press on a guard wall in guard-openings mode (not on a dot). Inside an opening it grabs that opening: a click
 * selects it, a drag slides it. On solid guard a drag sweeps a new opening from the press to the pointer, and a
 * click only drops the opening selection. Returns false when the pointer is on no guard, so the press falls
 * through to ordinary picking.
 */
export function beginGuardWallPress(ec: EditorController, e: PointerEvent, s: EditorState): boolean {
  const part = guardOpeningsTarget(s)
  if (!part || ec.readOnly) return false
  const hit = guardWallUnder(ec, s, part.id, e.clientX, e.clientY)
  if (!hit) return false
  const specs = openingSpecsOf(part)
  const inside = openingAt(specs, hit.guard, hit.s)
  ec.container.setPointerCapture(e.pointerId)
  ec.view.beginGuardWallDrag(hit.guard)
  if (inside >= 0) startGuardDrag(ec, e, s, part.id, hit.guard, 'slide', isolateOnWall(specs, inside, hit.guard), inside, 'start', hit.s)
  else startGuardDrag(ec, e, s, part.id, hit.guard, 'sweep', specs, specs.length, 'end', hit.s)
  return true
}

/**
 * The guard-wall point under the pointer, or null when the press belongs to something else. The wall is picked
 * within a few pixels of its line, so it must give way to a part actually drawn there: anything in front of the
 * edited conveyor, or, off its mesh, a neighbouring conveyor (whose guard can sit a few cm away). Background (the
 * floor, a platform, the building) never takes it, or a sweep starting just past the guard's edge would select
 * the platform under it instead.
 */
export function guardWallUnder(ec: EditorController, s: EditorState, targetId: string, x: number, y: number): GuardWallPoint | null {
  const hit = ec.view.pickGuardWall(x, y)
  if (!hit) return null
  const ids = ec.view.pickPartsAt(x, y)
  const front = ids[0]
  if (front === undefined || front === targetId) return hit
  if (ids.includes(targetId)) return null // another part hides the guard here
  const p = s.scene.parts.find((q) => q.id === front)
  return p && isConveyorLike(p) ? null : hit
}

function startGuardDrag(
  ec: EditorController,
  e: PointerEvent,
  s: EditorState,
  id: string,
  guard: 'left' | 'right',
  op: 'edge' | 'slide' | 'sweep',
  base: BeltGuardOpeningSpec[],
  index: number,
  edge: 'start' | 'end',
  anchor: number,
): void {
  ec.drag = { kind: 'guardOpening', pointerId: e.pointerId, start: s.scene, id, guard, op, base, index, edge, anchor, px: e.clientX, py: e.clientY, moved: false, last: null }
  ec.syncPoolDragEject() // the opening drag regenerates the guard geometry per move - eject up front
  ec.resetSnap()
}

/**
 * The openings a guard drag has reached with the pointer at row value `v`, and the row the gesture is editing.
 * With a snap `step` every edge the gesture places snaps to the grid: a sweep's two ends, a resized edge, and a
 * slid opening's start edge (its width is kept, so its end moves with it).
 */
function guardDragSpecs(
  drag: Drag & { kind: 'guardOpening' },
  v: number,
  step: number | null | undefined,
  lo: number,
  hi: number,
): { specs: BeltGuardOpeningSpec[]; index: number } {
  if (drag.op === 'sweep') return sweepOpening(drag.base, drag.guard, snapArc(drag.anchor, step), snapArc(v, step), lo, hi) ?? { specs: drag.base, index: -1 }
  if (drag.op === 'slide') {
    const start = drag.base[drag.index]!.arcStart
    return { specs: moveOpening(drag.base, drag.index, snapArc(start + v - drag.anchor, step) - start, lo, hi), index: drag.index }
  }
  return { specs: resizeOpeningEdge(drag.base, drag.index, drag.edge, snapArc(v, step), lo, hi), index: drag.index }
}

export function moveGuardOpening(ec: EditorController, drag: Drag & { kind: 'guardOpening' }, e: PointerEvent): void {
  if (!drag.moved && Math.hypot(e.clientX - drag.px, e.clientY - drag.py) < GUARD_CLICK_SLOP_PX) return
  const v = ec.view.resizeDragExtent(e.clientX, e.clientY)
  if (v === null) return
  const part = drag.start.parts.find((p) => p.id === drag.id)
  const range = part ? guardArcRange(part) : null
  if (!range) return
  const s = ec.store.getState()
  // the grid snap ("Use Snap", Ctrl inverts, Shift subdivides) steps the edges like a move drag steps a position
  const { specs, index } = guardDragSpecs(drag, v, gizmoSnap(s, e.ctrlKey || e.metaKey, e.shiftKey)?.translate, range.lo, range.hi)
  drag.moved = true
  drag.last = { specs, index }
  ec.store.setTransient(withOpenings(drag.start, drag.id, specs))
  const o = specs[index]
  ec.view.setTransformReadout(o ? openingReadout(o.arcStart, o.arcEnd, sceneDisplayUnits(s.scene)) : null)
}

/** the live readout while an opening is dragged: where it starts and ends along the guard, and its width */
export function openingReadout(a: number, b: number, units: DisplayUnits): string {
  if (b <= a) return 'Opening closed (release to remove it)'
  return `Opening ${formatLength(a, units)} to ${formatLength(b, units)} (${formatLength(b - a, units)} wide)`
}

/**
 * Release of a guard drag: `after` is the scene to commit (null for a click, which edits nothing) and `select` the
 * opening to select once it is committed. A click inside an opening selects it and on solid guard clears the
 * selection; a real drag selects the opening it produced. The caller selects after committing, because any scene
 * change drops the selection (store.setState: an index into the rows means nothing once the rows change).
 */
export function finishGuardOpening(
  ec: EditorController,
  drag: Drag & { kind: 'guardOpening' },
): { after: SceneJSON | null; select: { index: number; guard: 'left' | 'right' } | null } {
  ec.view.setTransformReadout(null)
  if (!drag.moved) return { after: null, select: drag.op === 'sweep' ? null : { index: drag.index, guard: drag.guard } }
  // the edited row's index in what was written (a shut opening is dropped, which can shift the rows after it)
  const index = drag.last && drag.last.index >= 0 ? rowIndexAfterWrite(drag.last.specs, drag.last.index) : null
  return { after: ec.store.getState().scene, select: index === null ? null : { index, guard: drag.guard } }
}


// --- custom-rig gizmo drag -------------------------------------------------

/** begin a custom-rig gizmo drag - the rig poses its own visual (no params), so the pose is transient */
export function beginRigGizmoDrag(ec: EditorController, e: PointerEvent, handle: RobotHandle, id: string): void {
  if (ec.readOnly) return
  ec.container.setPointerCapture(e.pointerId)
  ec.view.beginRobotDrag(handle, e.clientX, e.clientY)
  // a tool-size (rigSize) handle edits a scene param, not the transient pose - remember the start scene
  // so the streamed transients commit as one undo step on release (the resize-drag pattern)
  if (handle.startsWith('size:')) {
    ec.drag = { kind: 'rigGizmo', pointerId: e.pointerId, id, joint: -1, startAngle: 0, sizeParam: handle.slice(5), start: ec.store.getState().scene, moved: false }
    ec.resetSnap()
    return
  }
  const joint = handle === 'ee' ? -1 : Number(handle.slice(1))
  const startAngle = joint < 0 ? 0 : ec.view.rigGizmoJointAngle(id, joint)
  ec.drag = { kind: 'rigGizmo', pointerId: e.pointerId, id, joint, startAngle }
  ec.resetSnap()
}

export function moveRigGizmo(ec: EditorController, drag: Drag & { kind: 'rigGizmo' }, e: PointerEvent): void {
  // Alt frees an end-effector drag's tool orientation (held by default, so a level tool stays level)
  const r = ec.view.robotDragResult(e.clientX, e.clientY, e.altKey)
  if (!r) return
  // tool-size handle: write the dragged size back to the named param (clamped to its schema range) as a
  // live transient - the rig reflows (plate/rails/caps/cup grid) and the gizmo dot follows each move.
  if (drag.sizeParam !== undefined && drag.start) {
    if (r.sizeValue === undefined) return
    const key = drag.sizeParam
    const part = drag.start.parts.find((p) => p.id === drag.id)
    if (!part) return
    const range = partNumberRange(part, key)
    const val = range ? clamp(r.sizeValue, range.min, range.max) : r.sizeValue
    if ((part.params as unknown as Record<string, number>)[key] !== val) drag.moved = true
    ec.store.setTransient({
      ...drag.start,
      parts: drag.start.parts.map((p) =>
        p.id === drag.id ? ({ ...p, params: { ...p.params, [key]: val } } as unknown as PartInstance) : p,
      ),
    })
    return
  }
  // EE drag: solveIK already posed the live rig (the gizmo holds it). Joint drag: apply the accumulated
  // delta to the held pose. Either way the visual owns the pose - no scene mutation / undo entry.
  if (drag.joint >= 0 && r.jointDeltaDeg !== undefined) {
    ec.view.poseRigGizmoJoint(drag.id, drag.joint, drag.startAngle + r.jointDeltaDeg)
  }
}

// --- move handlers ---------------------------------------------------------

export function moveBand(ec: EditorController, drag: Drag & { kind: 'band' }, e: PointerEvent): void {
  if (!drag.el) {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < BAND_THRESHOLD_PX) return
    const el = document.createElement('div')
    el.className = 'rubber-band'
    ec.container.appendChild(el)
    drag.el = el
  }
  const r = ec.container.getBoundingClientRect()
  drag.el.style.left = `${Math.min(drag.sx, e.clientX) - r.left}px`
  drag.el.style.top = `${Math.min(drag.sy, e.clientY) - r.top}px`
  drag.el.style.width = `${Math.abs(e.clientX - drag.sx)}px`
  drag.el.style.height = `${Math.abs(e.clientY - drag.sy)}px`
}

/** pure: a copy of `start` with the given poses applied (no transient side effect). A pose that carries
 *  the full-orientation tilt (rotationX/Z - only the Alt surface alignment emits them) writes it, zeros
 *  included (an aligned wall pose clears a previous tilt); a pose without keeps the part's own tilt. */
export function posedScene(start: SceneJSON, poses: Map<string, SnapPose>): SceneJSON {
  return {
    ...start,
    parts: start.parts.map((p) => {
      const pose = poses.get(p.id)
      if (!pose) return p
      const next = { ...p, position: pose.position, rotationY: pose.rotationY } as PartInstance
      if (pose.rotationX !== undefined) {
        if (pose.rotationX !== 0) next.rotationX = pose.rotationX
        else delete next.rotationX
      }
      if (pose.rotationZ !== undefined) {
        if (pose.rotationZ !== 0) next.rotationZ = pose.rotationZ
        else delete next.rotationZ
      }
      return next
    }),
  }
}

/**
 * The single gesture-preview path. Every transient scene a gesture streams, and so what its release
 * commits, is staged here: poses applied + the engaged snap candidate's param overrides folded (a
 * stair's numSteps refit to a deck, a chain transfer adopting the host pitch). Preview == commit is
 * the contract the seam resolvers (core/scene/sceneResolve.ts) depend on: they derive cuts and openings
 * from whatever scene they are handed, so a gesture that streams a pose without the override fold
 * shows its neighbour effects only on commit (the stair→platform railing bug). Any
 * new gesture must build its transient through this, never through a bare posedScene. Re-rest is
 * the one legitimate per-gesture variation (liveReRest's cached raycasts vs the commit's fresh
 * reRestSurfaceParams) and stays at the call sites. Snap only engages for single-part drags
 * (filterSingle resets it otherwise); movingId null ⇒ pure pose fold.
 */
export function stagedPreview(ec: EditorController, start: SceneJSON, poses: Map<string, SnapPose>, movingId: string | null): SceneJSON {
  return ec.withSnapOverrides(posedScene(start, poses), movingId)
}

export function applyPoses(ec: EditorController, start: SceneJSON, poses: Map<string, SnapPose>): void {
  ec.store.setTransient(stagedPreview(ec, start, poses, snapRootOf(start, [...poses.keys()])))
}

/**
 * The part that drives snapping for a dragged id set: the single id, or, for a soft-parented subtree drag
 * (a cabinet carrying its face-mounted buttons), the one id whose parent is outside the set. A multi-select
 * of unrelated parts has several roots and returns null (multi-part drags never snap). Exported so the
 * gesture preview, the snap filter, and the commit all agree on the same mover.
 */
export function snapRootOf(start: SceneJSON, ids: readonly string[]): string | null {
  if (ids.length === 1) return ids[0]!
  const idSet = new Set(ids)
  let root: string | null = null
  for (const p of start.parts) {
    if (!idSet.has(p.id)) continue
    if (p.parent !== undefined && idSet.has(p.parent)) continue
    if (root !== null) return null
    root = p.id
  }
  return root
}

/**
 * Snap-filter a drag proposal. A single part snaps by itself; a single-root subtree (a host carrying its
 * attached devices) snaps by its root. The root's candidate is found against everything outside the moved
 * set (excludeIds, so the subtree never snaps to its own members) and the carried parts are rebased by the
 * snap's delta (translation + yaw about the root), exactly like the Shift+G reposition carry. A multi-root
 * selection never snaps.
 */
function filterSingle(
  ec: EditorController,
  drag: { ids: string[]; start: SceneJSON },
  poses: Map<string, SnapPose>,
  alt: boolean,
): void {
  const rootId = snapRootOf(drag.start, drag.ids)
  if (rootId === null) {
    ec.resetSnap()
    return
  }
  const part = drag.start.parts.find((p) => p.id === rootId)
  const proposed = poses.get(rootId)
  if (!part || !proposed) return
  const exclude = drag.ids.length > 1 ? new Set(drag.ids) : undefined
  const c = ec.applyLiveSnap(part, proposed, alt, exclude)
  if (!c) return
  poses.set(rootId, c.pose)
  if (drag.ids.length > 1) {
    const dyaw = normalizeAngle(c.pose.rotationY - proposed.rotationY)
    for (const id of drag.ids) {
      if (id === rootId) continue
      const p = poses.get(id)
      if (!p) continue
      const r = rotateXZ(p.position[0] - proposed.position[0], p.position[2] - proposed.position[2], dyaw)
      poses.set(id, {
        position: [
          c.pose.position[0] + r.x,
          c.pose.position[1] + (p.position[1] - proposed.position[1]),
          c.pose.position[2] + r.z,
        ],
        rotationY: normalizeAngle(p.rotationY + dyaw),
      })
    }
  }
}

/**
 * A node's new rest rotation (XYZ Euler, radians) after a gizmo ring turned it by `delta` about the world `axis`.
 * The rest rotation is parent-local, so the world turn W is carried into the parent frame P as P^-1 W P and
 * applied on top of the start rotation: the node's world orientation goes from P*L0 to W*P*L0, which is what
 * the ring promised. Pure (quaternions as [x, y, z, w]), so its unit test can use a turned parent.
 */
export function nodeRotationAfterTurn(parentQuat: readonly [number, number, number, number], startQuat: readonly [number, number, number, number], axis: readonly [number, number, number], delta: number): [number, number, number] {
  const w = new Quaternion().setFromAxisAngle(new Vector3(axis[0], axis[1], axis[2]).normalize(), delta)
  const p = new Quaternion(...parentQuat)
  const local = p.clone().invert().multiply(w).multiply(p).multiply(new Quaternion(...startQuat))
  const e = new Euler().setFromQuaternion(local, 'XYZ')
  return [e.x, e.y, e.z]
}

/** a rig-node drag on a ring (rotation) rather than an arrow, pad or the node's body (translation) */
export function isRigNodeRotation(drag: Drag & { kind: 'rigNode' }): boolean {
  return drag.handle.startsWith('rot')
}

/**
 * Author mode: a rig-node gizmo drag, handled like a scene part's: an arrow, a plane pad or the node's own body
 * moves it, a ring rotates it. Translation: the world-space delta mapped into the link's parent frame (parentInv,
 * captured at drag start) and added to its start offset. Rotation: the world-axis turn conjugated into the parent
 * frame and applied to the start rest rotation, written back as XYZ Euler (an authored quat is superseded, as an
 * Inspector rotation edit does). Applied live through the transient package path; release commits one undo step.
 */
export function moveRigNode(ec: EditorController, drag: Drag & { kind: 'rigNode' }, clientX: number, clientY: number, ctrl: boolean, shift: boolean): void {
  const snap = gizmoSnap(ec.store.getState(), ctrl, shift)
  const d = ec.view.gizmoDragDelta(clientX, clientY, snap)
  if (isRigNodeRotation(drag)) {
    const delta = d?.rotationDelta
    const axis = d?.rotationAxis
    if (delta === undefined || !axis) return
    if (!drag.moved && delta === 0) return
    drag.moved = true
    ec.view.showRotationFeedback(delta)
    const rotation = nodeRotationAfterTurn(drag.parentQuat, drag.startQuat, axis, delta)
    const pkg = getPackage(drag.packageId)
    if (!pkg || pkg.geometry.kind !== 'rig') return
    const links = pkg.geometry.links.map((l) => {
      if (l.name !== drag.linkName) return l
      const next = { ...l, rotation }
      delete next.quat
      return next
    })
    ec.store.setTransientPackage({ ...pkg, geometry: { ...pkg.geometry, links } })
    return
  }
  const t = d?.translation
  if (!t) return
  if (!drag.moved && t[0] === 0 && t[1] === 0 && t[2] === 0) return
  drag.moved = true
  const m = new Matrix4().fromArray(drag.parentInv)
  const p0 = new Vector3(0, 0, 0).applyMatrix4(m)
  const p1 = new Vector3(t[0], t[1], t[2]).applyMatrix4(m)
  // an axis the part sets itself stays at its value: the refresh would put it back anyway
  const step = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z]
  const offset: [number, number, number] = [0, 1, 2].map((i) => drag.startOffset[i]! + (drag.lockMove[i] ? 0 : step[i]!)) as [number, number, number]
  // live preview through the transient store path (no history): the pump fires onStoreChange → pushGizmo so
  // the gizmo follows the node, as a part drag's does through setTransient. Release commits one undo step.
  const pkg = getPackage(drag.packageId)
  if (!pkg || pkg.geometry.kind !== 'rig') return
  const links = pkg.geometry.links.map((l) => (l.name === drag.linkName ? { ...l, offset } : l))
  ec.store.setTransientPackage({ ...pkg, geometry: { ...pkg.geometry, links } })
  // Show the resulting parent-local offset, not the world-space drag delta `t`: offset is the property the
  // node actually carries (and what the Inspector field shows), and the two diverge once the parent frame is
  // rotated. During the transient drag the Inspector is frozen (React skips the transient stream), so this
  // viewport readout is the only live view of the value being authored - it must match the property.
  ec.view.setTransformReadout(`Offset  ${fmtTranslate(offset)}`)
}

/**
 * Live per-frame variant of reRestSurfaceParams used during a gizmo drag. Same result - every moved legged
 * part's `rest: 'surfaceBelow'` param reflows from the surface now beneath it - but the surface height is
 * resolved by a downward raycast only when that part's XZ has actually changed since the last cast; a pure
 * vertical raise (the "legs grow as you lift" gesture) reuses the cache and casts nothing, so the cost doesn't
 * scale with selection size and needs no multi-select cap. Fidelity edge: raising a deck straight up
 * past an intervening surface keeps the cached (lower) surface for the rest of the drag - the fresh raycast
 * in the commit-time reRestSurfaceParams corrects it on drop.
 */
function liveReRest(ec: EditorController, drag: Drag & { kind: 'gizmo' }, scene: SceneJSON): SceneJSON {
  const cache = (drag.restCache ??= new Map())
  const moved = new Set(drag.ids)
  let changed = false
  const parts = scene.parts.map((p): PartInstance => {
    const name = moved.has(p.id) ? surfaceBelowParam(p) : null
    if (!name) return p
    const [x, , z] = p.position
    let hit = cache.get(p.id)
    if (!hit || hit.x !== x || hit.z !== z) {
      const surf = ec.view.surfaceBelow(p, moved)
      hit = { x, z, surfaceY: surf ? surf.point[1] : FLOOR_SURFACE_Y }
      cache.set(p.id, hit)
    }
    const standH = Math.max(0.1, p.position[1] - hit.surfaceY)
    const cur = (p.params as Record<string, unknown>)[name]
    if (typeof cur === 'number' && Math.abs(cur - standH) < 1e-4) return p
    changed = true
    return { ...p, params: { ...(p.params as Record<string, unknown>), [name]: standH } } as PartInstance
  })
  return changed ? { ...scene, parts } : scene
}

export function moveGizmo(ec: EditorController, drag: Drag & { kind: 'gizmo' }, clientX: number, clientY: number, ctrl: boolean, alt: boolean, shift = false): void {
  const snap = gizmoSnap(ec.store.getState(), ctrl, shift)
  const t = ec.view.gizmoDragDelta(clientX, clientY, snap)?.translation
  if (!t) return
  if (!drag.moved && t[0] === 0 && t[1] === 0 && t[2] === 0) return
  drag.moved = true
  const moved = new Set(drag.ids) // Set, not ids.includes: O(parts × selection) per move at scale
  const poses = new Map<string, SnapPose>()
  for (const p of drag.start.parts) {
    if (!moved.has(p.id)) continue
    poses.set(p.id, {
      position: [p.position[0] + t[0], p.position[1] + t[1], p.position[2] + t[2]],
      rotationY: p.rotationY,
    })
  }
  filterSingle(ec, drag, poses, alt)
  // Live re-rest: a small translate reflows a legged part's rest:'surfaceBelow' param (e.g. standHeight) from
  // the surface now beneath it every frame, so its legs grow in real time as you raise it, not just at the
  // drop. Runs for every selection size; liveReRest caches the raycast per part (see there) so raising N decks
  // costs no raycasts after the first, and it's a no-op for parts with no rest param.
  const posed = stagedPreview(ec, drag.start, poses, drag.ids.length === 1 ? drag.ids[0]! : null)
  ec.store.setTransient(liveReRest(ec, drag, posed))
  syncDraggedBody(ec, drag.ids, poses, false)
  // Read out the applied delta (post-snap pose minus start), not the raw gizmo delta `t`: while a
  // single-part drag is pinned to a snap, `t` keeps tracking the pointer but the part isn't moving -
  // the readout must freeze with it. Multi-part drags never snap, so this equals `t` there.
  const s0 = drag.start.parts.find((p) => p.id === drag.ids[0])
  const a0 = poses.get(drag.ids[0] ?? '')
  const applied = s0 && a0
    ? ([a0.position[0] - s0.position[0], a0.position[1] - s0.position[1], a0.position[2] - s0.position[2]] as [number, number, number])
    : t
  ec.view.setTransformReadout(`Move  ${fmtTranslate(applied)}`)
}

/**
 * keyboard transform lock: X/Y/Z constrains an active
 * move drag to that axis, Shift+X/Y/Z to the perpendicular plane; pressing the
 * same target again cycles global -> local -> released (handled in the gizmo).
 * Only translate (move/body) drags constrain - rotate is yaw-only and scale uses
 * its own per-axis handles. Returns true when the key was a constraint.
 */
export function constrainActiveDrag(ec: EditorController, e: KeyboardEvent): boolean {
  const drag = ec.drag
  if (!drag || e.ctrlKey || e.metaKey || e.repeat) return false
  if (drag.kind === 'gizmo') {
    const map: Record<string, GizmoConstraint> = e.shiftKey
      ? { x: 'yz', y: 'xz', z: 'xy' }
      : { x: 'x', y: 'y', z: 'z' }
    const target = map[e.key.toLowerCase()]
    if (!target) return false
    ec.view.gizmoConstrain(target)
    // re-run the drag at the cursor so the new constraint takes effect immediately
    if (ec.lastPointer) moveGizmo(ec, drag, ec.lastPointer.x, ec.lastPointer.y, false, e.altKey, e.shiftKey)
    return true
  }
  if (drag.kind === 'rigNode') {
    // a node drag constrains exactly as a part's: a translation takes an axis or (Shift) a plane, a ring an axis
    const rotation = isRigNodeRotation(drag)
    if (rotation && e.shiftKey) return false
    const map: Record<string, GizmoConstraint> = e.shiftKey ? { x: 'yz', y: 'xz', z: 'xy' } : { x: 'x', y: 'y', z: 'z' }
    const target = map[e.key.toLowerCase()]
    if (!target) return false
    ec.view.gizmoConstrain(target)
    if (ec.lastPointer) moveRigNode(ec, drag, ec.lastPointer.x, ec.lastPointer.y, false, false)
    return true
  }
  if (drag.kind === 'rotate') {
    // rotation re-picks the axis only (no plane lock for rotate); Shift is
    // reserved for snap-subdivide, so it isn't a constraint here
    if (e.shiftKey) return false
    const target = ({ x: 'x', y: 'y', z: 'z' } as Record<string, GizmoConstraint>)[e.key.toLowerCase()]
    if (!target) return false
    ec.view.gizmoConstrain(target)
    if (ec.lastPointer) moveRotate(ec, drag, ec.lastPointer.x, ec.lastPointer.y, false, false, e.altKey)
    return true
  }
  return false
}

export function moveRotate(ec: EditorController, drag: Drag & { kind: 'rotate' }, clientX: number, clientY: number, ctrl: boolean, shift: boolean, alt: boolean): void {
  const snap = gizmoSnap(ec.store.getState(), ctrl, shift)
  const d = ec.view.gizmoDragDelta(clientX, clientY, snap)
  const delta = d?.rotationDelta
  const axis = d?.rotationAxis
  if (delta === undefined || !axis) return
  if (!drag.moved && delta === 0) return
  drag.moved = true
  ec.view.showRotationFeedback(delta)
  const single = drag.ids.length === 1
  const moved = new Set(drag.ids) // Set, not ids.includes: O(parts × selection) per move at scale

  // rotation about (near-)vertical takes the yaw path, so conveyors still structurally snap
  if (Math.abs(axis[1]) > 0.999) {
    const yaw = axis[1] >= 0 ? delta : -delta
    const poses = new Map<string, SnapPose>()
    for (const p of drag.start.parts) {
      if (!moved.has(p.id)) continue
      // always orbit the position about the pivot. For a single centred part the
      // pivot is its position, so this keeps it in place. For a conveyor the pivot is
      // the bed centre, so the tail-origin position swings around it and the bed centre stays put.
      const o = yawAboutPivot(p.position[0], p.position[2], drag.cx, drag.cz, yaw)
      poses.set(p.id, {
        position: [o.x, p.position[1], o.z],
        rotationY: normalizeAngle(p.rotationY + yaw),
      })
    }
    filterSingle(ec, drag, poses, alt)
    applyPoses(ec, drag.start, poses)
    syncDraggedBody(ec, drag.ids, poses, true)
    return
  }

  // backstop for the yaw-only invariant: the X/Z/view rings are hidden for a
  // conveyor selection, but the keyboard axis-constraint (press X/Z mid-drag) could
  // still steer a yaw-ring drag onto a tilt axis. Drop any non-vertical rotation so
  // a conveyor can never gain transform pitch/roll (incline is the tiltDeg param).
  if (drag.start.parts.some((p) => moved.has(p.id) && isConveyorLike(p))) return

  // tilt (X/Z/view rings): compose the world-axis delta onto each part's YXZ
  // orientation; multi-select orbits positions about the center. No structural snap.
  const q = new Quaternion().setFromAxisAngle(new Vector3(axis[0], axis[1], axis[2]).normalize(), delta)
  const euler = new Euler()
  const off = new Vector3()
  ec.store.setTransient({
    ...drag.start,
    parts: drag.start.parts.map((p) => {
      if (!moved.has(p.id)) return p
      euler.set(p.rotationX ?? 0, p.rotationY, p.rotationZ ?? 0, 'YXZ')
      euler.setFromQuaternion(new Quaternion().setFromEuler(euler).premultiply(q), 'YXZ')
      let position = p.position
      if (!single) {
        off.set(p.position[0] - drag.cx, p.position[1] - drag.cy, p.position[2] - drag.cz).applyQuaternion(q)
        position = [drag.cx + off.x, drag.cy + off.y, drag.cz + off.z]
      }
      return { ...p, position, rotationX: euler.x, rotationY: euler.y, rotationZ: euler.z } as PartInstance
    }),
  })
  // live cargo: mirror the full tilted orientation to the body (cargo is the one part family whose
  // body accepts arbitrary orientation - it tumbles anyway), so the tilt rings work while running.
  // Every selected box, not just a lone one: a multi-select also orbits positions about the centre
  // (see `!single` above), and physics owns those bodies - unsynced, the group visibly stays put.
  for (const part of liveCargoParts(ec, drag.ids)) {
    ec.sim.moveBody(part.id, part.position, quatFromYXZ(part.rotationX ?? 0, part.rotationY, part.rotationZ ?? 0))
  }
}

// --- live cargo body sync --------------------------------------------------

/**
 * The cargo parts among `ids`. While the sim runs these are the bodies physics owns. The scene
 * transient alone can't move them (updateScene skips live cargo), so every gesture has to freeze
 * and steer them directly. Empty when none of the ids is cargo.
 */
function liveCargoParts(ec: EditorController, ids: readonly string[]): PartInstance[] {
  if (ids.length === 0) return []
  const want = new Set(ids)
  return ec.store.getState().scene.parts.filter((p) => want.has(p.id) && isCargoPart(p))
}

/** mirror a live box's gizmo drag onto its physics body (the scene pose only restores on Stop) */
export function syncDraggedBody(ec: EditorController, ids: readonly string[], poses: Map<string, SnapPose>, withRotation: boolean): void {
  // the whole selection, not just a lone box: a band over a running line selects many, and
  // steering only one leaves the rest physics-owned (they keep conveying out from under the drag)
  for (const part of liveCargoParts(ec, ids)) {
    const pose = poses.get(part.id)
    if (!pose) continue
    // full orientation, not just the pose's yaw: the part's tilt (kept by a yaw drag, rebased from the
    // live body by dragStartScene) is kept, so a tilted box doesn't snap upright when yawed/moved
    ec.sim.moveBody(part.id, pose.position, withRotation ? quatFromYXZ(part.rotationX ?? 0, pose.rotationY, part.rotationZ ?? 0) : null)
  }
}

/**
 * Use (C) on live cargo: flip its pin in ec.frozenCargo. Bookkeeping only - the caller decides how
 * the body catches up (useSelection freezes it on the spot; pressed mid-drag the body is already
 * kinematic for the gesture, and the release's setDraggedBodyFrozen(..., false) leaves a pinned box
 * frozen where it was dropped). Pins the whole set together: if any box is loose the press pins
 * them all, otherwise it releases them all - so a mixed selection resolves to "pin", and one press
 * can hold a banded group. Returns false (nothing flipped) when no id is live cargo or the sim
 * isn't running.
 */
export function toggleCargoPin(ec: EditorController, ids: readonly string[]): boolean {
  if (!ec.store.getState().running) return false
  const parts = liveCargoParts(ec, ids)
  if (parts.length === 0) return false
  const pin = parts.some((p) => !ec.frozenCargo.has(p.id))
  for (const p of parts) {
    if (pin) ec.frozenCargo.add(p.id)
    else ec.frozenCargo.delete(p.id)
  }
  return true
}

/**
 * Freeze the grabbed cargo bodies for the duration of a gizmo drag so gravity and
 * conveyor contacts don't fight the manipulation; released on drag end/cancel.
 * Covers every box/pallet in the gesture: leaving the rest of a banded group dynamic
 * lets the line convey them out from under the drag. No-op when the sim isn't running.
 * A box the Use key pinned (ec.frozenCargo) stays frozen through the release -
 * the grab borrowed a state the user had already pinned.
 */
export function setDraggedBodyFrozen(ec: EditorController, ids: readonly string[], frozen: boolean): void {
  for (const part of liveCargoParts(ec, ids)) {
    ec.sim.freezeBody(part.id, frozen || ec.frozenCargo.has(part.id))
  }
}

export function moveResize(ec: EditorController, drag: Drag & { kind: 'resize' }, e: PointerEvent): void {
  // guard-opening handles use the dedicated 'guardOpening' drag (moveGuardOpening), never this one
  if ('guard' in drag.handle) return
  // a flex conveyor's path dot: the point under the pointer moves that control point (or the infeed, which moves the
  // part's origin with the rest of the path held), and the bed length follows (core flexPull). A shape the part
  // cannot take stops at its limit, pulled from the shape the drag has reached so far (the transient), so the dot
  // parks at full stretch rather than wherever the last accepted pointer sample happened to be.
  if ('flexPoint' in drag.handle) {
    const at = ec.view.resizeDragPoint(e.clientX, e.clientY)
    const part = ec.store.getState().scene.parts.find((p) => p.id === drag.id)
    const next = at && part ? flexPull(part, drag.handle.flexPoint, at.x, at.z) : null
    if (!next) return
    drag.moved = true
    ec.store.setTransient({
      ...drag.start,
      parts: drag.start.parts.map((p) => (p.id === drag.id ? withFlexPose(p, next) : p)),
    })
    return
  }
  const extent = ec.view.resizeDragExtent(e.clientX, e.clientY)
  if (extent === null) return
  const part = drag.start.parts.find((p) => p.id === drag.id)
  if (!part) return
  // curved conveyors: the arc gizmo drags the sweep / width param about the fixed arc-center origin, so only
  // the param changes (position holds). The param keys come from the unified gizmo (built-in fixed names or an
  // SDK curved bed's `arc`-handle-named params); clamping is package-driven via partNumberRange, so it works
  // for an SDK curve too (PART_DEFS.part carries no static params - they come from the package schema).
  if ('curve' in drag.handle) {
    const gizmo = curvedGizmoOf(part)
    if (!gizmo) return
    const ckey = drag.handle.curve === 'angle' ? gizmo.sweepKey : gizmo.widthKey
    const range = partNumberRange(part, ckey)
    const cval = range ? clamp(extent, range.min, range.max) : extent
    const params = part.params as unknown as Record<string, number>
    if (params[ckey] !== cval) drag.moved = true
    ec.store.setTransient({
      ...drag.start,
      parts: drag.start.parts.map((p) =>
        p.id === drag.id ? ({ ...p, params: { ...p.params, [ckey]: cval } } as unknown as PartInstance) : p,
      ),
    })
    return
  }
  // belt path handles: tail (drag_along_t, shifts origin to hold the head) or a
  // segment-end (absolute new length, origin holds and downstream segments follow). Works for the
  // built-in belt and a belt-like SDK part (the segments live in either shape) via its path bed.
  if ('belt' in drag.handle) {
    const before = bedView(part, 'path')?.segments ?? []
    const r =
      drag.handle.belt === 'tail'
        ? resizeBeltTail(part, extent)
        : resizeBeltSegmentLength(part, drag.handle.belt, extent)
    const idx = drag.handle.belt === 'tail' ? 0 : drag.handle.belt
    const after = bedView({ ...part, params: r.params } as unknown as PartInstance, 'path')?.segments ?? before
    if (before[idx]?.length !== after[idx]?.length) drag.moved = true
    ec.store.setTransient({
      ...drag.start,
      parts: drag.start.parts.map((p) =>
        p.id === drag.id ? ({ ...p, position: r.position, params: r.params } as unknown as PartInstance) : p,
      ),
    })
    return
  }
  const key = resizeParamKey(part, drag.handle.axis) // 'y' resolves to the declared height param (built-ins: 'height')
  const range = partNumberRange(part, key) // PART_DEFS for built-ins, the package schema for custom parts
  const clamped = range ? clamp(extent, range.min, range.max) : extent
  if ((part.params as unknown as Record<string, number>)[key] !== clamped) drag.moved = true
  const r = resizePart(part, drag.handle.axis, drag.handle.sign, clamped)
  ec.store.setTransient({
    ...drag.start,
    parts: drag.start.parts.map((p) =>
      p.id === drag.id ? ({ ...p, position: r.position, params: r.params } as unknown as PartInstance) : p,
    ),
  })
}

// --- finish / cancel -------------------------------------------------------

export function finishBand(ec: EditorController, drag: Drag & { kind: 'band' }, e: PointerEvent): void {
  if (drag.el) {
    drag.el.remove()
    const x0 = Math.min(drag.sx, e.clientX)
    const y0 = Math.min(drag.sy, e.clientY)
    const x1 = Math.max(drag.sx, e.clientX)
    const y1 = Math.max(drag.sy, e.clientY)
    const hits = ec.view.partsInRect(x0, y0, x1, y1)
    // spawner-born cargo in the band owns no part yet - promote it, exactly as click-select does
    // (one commit for the whole band), so a running line's boxes are band-selectable at all
    // (not while drawing another connection's shared run: its cargo is that client's, and nothing here may adopt it)
    if (!ec.store.getState().liveFollowing) hits.push(...ec.promoteCargoBoxes(ec.view.cargoBodiesInRect(x0, y0, x1, y1)))
    // what those hits mean against the tree (grouped-subtree redirect, dedupe, shift-extend) is
    // selection policy, not pointer plumbing - see core/selection.ts
    const s = ec.store.getState()
    ec.store.selectMany(bandSelection(s.scene.parts, hits, drag.shift ? s.selectedIds : []))
  } else if (!drag.shift) {
    ec.store.clearSelection()
  }
}

/**
 * End an open drag or reposition that writes the scene, because the scene was replaced by something other than its
 * own moves (EditorController.onStoreChange). The new scene stays as it is: nothing is reverted.
 */
export function dropOvertakenGesture(ec: EditorController): void {
  const drag = ec.drag
  if (drag && 'start' in drag && drag.start !== undefined) cancelActiveDrag(ec, false)
  if (ec.reposition) ec.cancelReposition(false)
}

/** `revert: false` ends the drag and leaves the scene as it is now (dropOvertakenGesture) */
export function cancelActiveDrag(ec: EditorController, revert = true): void {
  const drag = ec.drag
  if (!drag) return
  ec.drag = null
  if (ec.container.hasPointerCapture(drag.pointerId)) ec.container.releasePointerCapture(drag.pointerId)
  if (drag.kind === 'band') {
    drag.el?.remove()
  } else if (drag.kind === 'ruler') {
    ec.clearRuler()
  } else if (drag.kind === 'rigGizmo') {
    ec.view.endRobotDrag() // transient pose held by the visual; nothing to revert in the scene…
    // …except a tool-size handle drag's streamed param transients - restore the pre-drag scene (RMB cancel)
    if (drag.sizeParam !== undefined && drag.start) {
      if (revert) ec.store.setTransient(drag.start)
    } else ec.noteRigJog(drag.id) // the pose the drag reached stays held: say so
  } else if (drag.kind === 'rigNode') {
    ec.view.endGizmoDrag()
    ec.view.setTransformReadout(null)
    ec.view.showRotationFeedback(null)
    // revert the live transient edit (no history); the transient pump re-centers the gizmo via onStoreChange
    if (drag.moved) ec.store.setTransientPackage(drag.startPkg)
    else ec.pushGizmo(ec.store.getState())
  } else if (drag.kind === 'vertexSnap') {
    // RMB / Esc cancels the whole gesture and leaves vertex-snap mode
    setDraggedBodyFrozen(ec, drag.ids, false)
    ec.view.setTransformReadout(null)
    ec.view.showVertexMarkers(null, null)
    ec.vsnap = null
    if (revert) ec.store.setTransient(drag.start)
  } else {
    if (drag.kind === 'gizmo' || drag.kind === 'rotate') ec.view.endGizmoDrag()
    if (drag.kind === 'gizmo' || drag.kind === 'rotate') setDraggedBodyFrozen(ec, drag.ids, false)
    if (drag.kind === 'rotate') ec.view.showRotationFeedback(null)
    if (drag.kind === 'gizmo') ec.view.setTransformReadout(null)
    if (drag.kind === 'resize' || drag.kind === 'guardOpening') ec.view.endResizeDrag()
    if (drag.kind === 'guardOpening') ec.view.setTransformReadout(null)
    // a cancelled Shift+drag duplicate discards the staged copies and re-selects the originals
    // (drag.start holds the clones); every other drag just reverts its transient scene.
    const dup = drag.kind === 'gizmo' || drag.kind === 'rotate' ? drag.dup : undefined
    if (revert) {
      if (dup) ec.store.setTransient(dup.before, dup.origSelection)
      else ec.store.setTransient(drag.start)
    }
  }
  ec.resetSnap()
}
