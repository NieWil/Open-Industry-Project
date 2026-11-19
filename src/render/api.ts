import type { Vector3 } from 'three'
import type { BoxFrame, CargoKindName, CargoShapeRef } from '../core/frame'
import type { PartInstance, SceneJSON } from '../core/types'
import type { DisplayUnits } from '../core/units'
import type { SubPose } from '../core/rig/rigPose'

export interface RenderStats {
  drawCalls: number
  /**
   * How `drawCalls` was tallied. Under WebGPU render bundles the number means two different things.
   * A replayed frame counts one draw per bundle execute (~26 on the demo). A frame that re-recorded, or
   * that the live-edit hold rendered unbundled, counts every draw in the list (~620), for the same scene
   * and pixels. This field tells the overlay which case a spike in `draws` is. null where bundles are
   * not in play (WebGL, `?nobundle`); there the count is the frame's draws.
   */
  drawPath: 'replay' | 'record' | null
  triangles: number
  /**
   * EMA of the main-thread cost of a view frame, ms (JS + draw submission, not the GPU's async
   * execution). It shows headroom: at vsync the frame interval reads ~16.7 ms whether a frame took
   * 2 ms or 15 ms to produce.
   */
  cpuMs: number
  /**
   * Cumulative main-thread ms over every view frame since the view mounted (the sum `cpuMs` smooths),
   * and how many frames that covers. Window-diff two reads against the real time between them for a
   * time-weighted reading: frames / real time is the true frame rate, and ms / real time the main
   * thread's load. The per-frame EMAs can't give either under hitches, because the frame interval the
   * view advances by is clamped to 100 ms while the work is not: one 1.5 s frame in ten counts as
   * 0.1 s, so the averaged interval says ~34 fps while the main thread reads 161 ms a frame.
   */
  cpuTotalMs: number
  frames: number
  /**
   * EMA of one frame's GPU render-pass time, ms: the part of the frame cost that cpuMs excludes. Measured with
   * WebGPU timestamp queries, each frame counted once (frameMeter.ts). null on WebGL, on a WebGPU device without
   * timestamp queries, and until the first frame resolves.
   */
  gpuMs: number | null
  /**
   * GPU ms summed over every resolved frame, and how many frames that is: window-diff two reads the way
   * cpuTotalMs is. gpuTotalMs is null whenever gpuMs is. The frames resolve a frame or two late, so gpuFrames
   * trails `frames` by that much and a window divides by its own count.
   */
  gpuTotalMs: number | null
  gpuFrames: number
  /**
   * The display's refresh interval in ms: 60 Hz, or faster once the frames show it (frameMeter.ts
   * RefreshEstimate). null only before there is a view.
   */
  refreshMs: number | null
  /**
   * Frames whose interval exceeded 1.5x the rolling median of the frames around them, since the
   * view mounted. Catches hitches (pipeline compiles, GC, resize) that the EMAs smooth over;
   * sustained slowness re-baselines, so this counts hiccups, not steady load (the fps line already
   * shows that).
   *
   * The baseline is a median, not a running minimum: a minimum makes this number describe the display
   * rather than the app on any variable-refresh panel (frameHitch.ts). Believe `worstMs`/`p95` over
   * this one if they disagree.
   */
  missedFrames: number
  /** which three.js renderer is live - surfaced in the stats overlay so screenshots reveal the backend */
  backend: 'WebGPU' | 'WebGL'
  /**
   * part visuals the owned per-frame world-matrix walk updated last frame (matrixAutoUpdate
   * still true - drag-unfrozen, non-freezable kinds, buildings). The idle-scaling invariant
   * the walk exists for: this stays O(few) no matter how many parts the scene holds, so the
   * e2e regression gate asserts on it (a growing number means the freeze regressed).
   */
  matrixLiveParts: number
  /**
   * Live GPU resource counts (`renderer.info.memory`): how much the device is asked to hold, as
   * opposed to how fast it draws. Frame counters cannot see residency, and on a phone residency fails
   * first. An iPhone dropped its WebGL context inside a minute on the demo scene while holding ~60 fps
   * at under 5 ms of main-thread work, and every texture came back black. The device benchmark
   * (editor/bench.ts) samples these per window, so a purge can be tied to a moment.
   */
  textures: number
  geometries: number
}

/** viewport camera projection (the Perspective/Orthogonal view toggle) */
export type ProjectionMode = 'perspective' | 'orthographic'

/**
 * The camera a scene opens at when it has no remembered one: a ~14 m 3/4 of world zero. It suits the
 * default warehouse, where the first part is placed near the origin. A scene may declare its own opening
 * view instead (editor/demo/demoScenes DEMO_OPENING_VIEW). Once a scene has been framed, the pose remembered
 * for it takes precedence over both (editor/store/storePrefs viewport state).
 */
export const DEFAULT_CAMERA_POSE = { px: 9, py: 7, pz: 9, tx: 0, ty: 0, tz: 0 } as const

export type GizmoMode = 'transform' | 'move' | 'rotate'
/**
 * transform: move + rotate handles together (the
 * default); move: three axis arrows + the three plane pads (xy/xz/yz); rotate:
 * the X/Y/Z rings + the camera-facing view ring + an interior free-rotation
 * trackball (rotTrackball). Sizing is not a gizmo mode: the resize tool shows
 * only the face handles (setResizeHandles). 'view' is the camera-facing free-translate
 * constraint: not a pickable handle, used when dragging
 * the part body itself. 'rotTrackball' is the invisible sphere inside the rings
 * (trackball rotation): dragging it rotates freely about a screen-space
 * axis. Rings take precedence, so it only grabs when no ring is under the cursor.
 */
export type GizmoHandle =
  | 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' | 'view'
  | 'rotX' | 'rotY' | 'rotZ' | 'rotView' | 'rotTrackball'

/**
 * Keyboard transform constraint (X/Y/Z and Shift+X/Y/Z lock): an axis
 * (x/y/z) or the perpendicular plane (yz/xz/xy). Applied to an in-flight move
 * drag; pressing the same one cycles global -> local -> released.
 */
export type GizmoConstraint = 'x' | 'y' | 'z' | 'yz' | 'xz' | 'xy'

export interface GizmoState {
  center: [number, number, number]
  rotationY: number
  /** optional tilt (pitch/roll, radians) so local-space rings align to a tilted part's frame */
  rotationX?: number
  rotationZ?: number
  mode: GizmoMode
  /** 'local' aligns the move axes to rotationY; 'global' uses world axes (Local Space toggle) */
  space: 'local' | 'global'
  /** "Use Trackball": rotate mode shows + picks the interior free-rotation sphere */
  trackball?: boolean
  /**
   * yaw-only: show + pick the Y ring only, hiding the X/Z tilt rings, the view ring
   * and the trackball. Conveyors set this so the transform gizmo can never write a
   * pitch/roll (incline is a part param, not transform rotation) - the web mirror of
   * the native engine's per-node rotation-axis lock.
   */
  rotateYawOnly?: boolean
  /**
   * A full orientation [x, y, z, w] for the handles in 'local' space, in place of rotationY/X/Z. A part's local
   * translate is yaw-only (parts rarely pitch). A rig node's position is stored in its parent's frame, which can
   * be turned any way, so its gizmo is drawn in that frame and each arrow is one stored axis. Absent = the
   * yaw-based local frame.
   */
  frame?: [number, number, number, number]
  /** move handles to leave out, per local axis [x, y, z] (and every plane pad that uses one): an axis the part
   *  sets itself, where a drag would be overwritten (core/rig/rigPose.ts linkFieldOwnership) */
  lockMove?: [boolean, boolean, boolean]
  /** leave out every rotate handle (rings, view ring, trackball): a rotation the part sets itself (an aim) */
  lockRotate?: boolean
}

/** "Use Snap" increments applied to a gizmo drag delta; null on a field disables that snap */
export interface GizmoSnap {
  /** translate increment in meters */
  translate: number | null
  /** rotate increment in radians */
  rotate: number | null
}

/**
 * A viewport resize handle, one kind per gizmo:
 * - {@link BoxResizeHandle} - axis-aligned bounding-box face dot (straight conveyors).
 * - {@link CurveResizeHandle} - curved-conveyor arc angle / radial width.
 * - {@link BeltResizeHandle} - path-belt tail / per-segment length dot.
 * - {@link GuardOpeningHandle} - belt side-guard opening edge / guard-end dot (the
 *   side-guards gizmo mode), shown only while the Side Guards mode is active.
 */
export type ResizeHandle = BoxResizeHandle | CurveResizeHandle | BeltResizeHandle | GuardOpeningHandle | FlexResizeHandle

export interface BoxResizeHandle {
  axis: 'x' | 'y' | 'z'
  sign: 1 | -1
}

export interface CurveResizeHandle {
  /** 'angle' drags sweepDeg at the arc end; 'width' drags width at the arc midpoint */
  curve: 'angle' | 'width'
}

/** one of a flex conveyor's path dots (core flexPathOf): control point `flexPoint`, or its infeed end, dragged across
 *  the deck plane (core flexPull) */
export interface FlexResizeHandle {
  flexPoint: number | 'infeed'
}

export interface BeltResizeHandle {
  /** 'tail' drags segment 0 along local X (head stays put); a number is that segment's end-length dot */
  belt: 'tail' | number
}

export interface GuardOpeningHandle {
  /** which side-guard wall the dot sits on (-Z left / +Z right) */
  guard: 'left' | 'right'
  /** index into params.guardOpenings */
  opening: number
  /** which edge of that opening ('start' = the tail-side one) */
  edge: 'start' | 'end'
}

/** a point on a side-guard wall: the wall and the tail-relative row value (m) there */
export interface GuardWallPoint {
  guard: 'left' | 'right'
  s: number
}

/** world point to CSS-pixel screen coords (null behind the camera), plus the pointer's own pixel */
export interface ScreenProjector {
  project(v: { x: number; y: number; z: number }): { x: number; y: number } | null
  x: number
  y: number
}

/** editor callbacks pilot mode fires from inside the locked viewport */
export interface PilotHandlers {
  /** the user left pilot mode (Esc / pointer-lock lost) - drop back to idle */
  onExit: () => void
  /** the user pressed interact (E / F / click) - pick up or drop carried cargo */
  onInteract: () => void
}

/**
 * A robot editor-gizmo handle: a per-joint rotation handle `j0`, `j1`... (J1, J2...), the end-effector handle
 * `ee` that drags the arm via IK, or a `size:<param>` tool-size handle (a rigSize
 * param handle - the EOAT resize dots) that drags the named number param along a rig link's axis.
 */
export type RobotHandle = `j${number}` | 'ee' | `size:${string}`

/** one gizmo joint (J1-J5) as the overlay draws it; world space, directions unit length */
export interface RobotGizmoJoint {
  /** 'J1'... - the readout's name for it */
  label: string
  /** the ring's centre, on the joint axis: the pivot, or slid along the axis off the part origin (rigGizmo.ts) */
  center: Vector3
  axis: Vector3
  /** perpendicular to the axis, turning with the joint: where the handle sits on the ring */
  handleDir: Vector3
  /** perpendicular to the axis, fixed: where the handle sits at angle 0 (limits are measured from it) */
  zeroDir: Vector3
  /** the held angle (rad for a revolute joint) */
  angle: number
  min: number
  max: number
  revolute: boolean
}

/** where everything the robot gizmo draws sits right now, in world space */
export interface RobotGizmoLayout {
  joints: RobotGizmoJoint[]
  /** the end-effector handle */
  ee: Vector3
  sizes: { handle: `size:${string}`; pos: Vector3 }[]
  /** each tool outline's four corners, a closed loop */
  toolOutlines: Vector3[][]
}

/**
 * The robot visual's gizmo surface, read by the view to draw/pick/drag the joint
 * + IK handles. World-space; the view does the drawing, camera projection and IK targeting.
 */
export interface RobotGizmoApi {
  /** where the rings and handles go (recomputed per call from the posed rig) */
  layout(): RobotGizmoLayout
  /** a `size:<param>` handle's drag line: the tool-frame origin + its world axis direction, and the world
   *  length of one link-local unit along it (so the dragged distance converts back to the param's local
   *  metres under a scaled rig). Null when the param has no rigSize handle. */
  sizeInfo?(param: string): { origin: Vector3; dir: Vector3; unit: number } | null
  /** an end-effector drag starts: take the tool orientation the drag will hold */
  beginIK?(): void
  /** CCD IK toward a world target for the tool, keeping the orientation taken by beginIK unless `free`; returns the
   *  resulting gizmo joints' degrees */
  solveIK(target: Vector3, free?: boolean): number[]
  /** true for a custom-rig gizmo that poses its own visual (vs the built-in robot, whose pose is written to
   *  the part's j1..j6 params). When set, the editor routes drags through setJointAngle / solveIK rather than
   *  editing params, and the visual holds the gizmo pose at idle. */
  rig?: boolean
  /** set joint i to an absolute angle (deg), posing + holding the visual - the rig-gizmo joint-drag path */
  setJointAngle?(i: number, deg: number): void
  /** the current held pose angle (deg) of joint i - the drag's start reference for a rig gizmo */
  jointAngle?(i: number): number
  /** the full held authoring pose (joint name → radians / metres) - the teach-pendant capture source */
  rigPose?(): Record<string, number>
  /** hold a whole authoring pose (joint name → radians / metres), the inverse of rigPose: showing a taught waypoint */
  setRigPose?(pose: Record<string, number>): void
  /** true while the held pose is not the saved idle pose (dragged, or a waypoint shown): session state, never saved */
  jogged?(): boolean
  /** drop the held pose and go back to the saved idle pose */
  resetJog?(): void
}

/** a live sim box hit by a pointer ray: its stable body id, owning part (if any), and live pose/size */
export interface BoxPick {
  /** stable per-body sim id (BoxFrame.ids) */
  frameId: number
  /** owning scene part, or null for a transient spawner box (promote it on select) */
  partId: string | null
  /** live world-space center */
  position: [number, number, number]
  rotationY: number
  /** full dimensions (length, height, width) in meters */
  size: [number, number, number]
  /** live body tint as an sRGB hex (#rrggbb), so a promoted box keeps its spawned colour */
  color: string
  /** which cargo it is, so a promoted spawner body becomes the matching part */
  kind: CargoKindName
  /** a cargo part with its own body (kind 'part'): the part it is and the params it was made with, so a promoted
   *  body becomes that part, not a box of its size (editor/controller/liveCargo.ts) */
  product?: CargoShapeRef
}

/**
 * The viewport. Owns the WebGL canvas, camera + controls (right-drag orbit,
 * middle-drag pan, wheel zoom; left button is never consumed), lights,
 * ground, rAF loop, resize handling, the transform gizmo, and selection
 * outlines. The editor drives everything through this interface; all
 * pointer coordinates are CSS pixels relative to the window.
 */
export interface IRenderView {
  /**
   * Bring the viewport in line with `scene`. `load` says the scene replaced the previous one wholesale
   * (store.loadScene) rather than editing it: the parts it brings are held until they can draw and
   * then compiled as one batch, not one kind at a time the way a single added part is.
   */
  syncScene(scene: SceneJSON, opts?: { load?: boolean }): void
  /**
   * While on, parts leaving the scene keep their visuals, held aside, and a later sync that brings one back reattaches
   * it instead of building it again; the first sync with it off disposes what is still held. The editor turns it on
   * for a definition session (Catalog ✎), which swaps the scene for one holding just the part being edited, so Back
   * is not a rebuild of every part in the document.
   */
  setHoldDeparted(on: boolean): void
  /** hull-outline every listed part; [] clears */
  setSelection(ids: readonly string[]): void
  /** author mode: outline one internal rig link of a custom part (read-only inspection); null clears */
  setRigNodeHighlight(sel: { partId: string; linkName: string } | null): void
  /** re-apply every placed instance of a package after its geometry changed in the registry (edit/hot-reload) */
  refreshPackage(id: string): void
  /** author-mode gizmo placement for a rig node: its world position + its parent's world matrix; null if absent */
  rigLinkGizmo(partId: string, linkName: string): { worldPos: [number, number, number]; parentWorld: number[] } | null
  /**
   * Placement staging (docs/placement-staging.md): tag one scene part id as the live placement
   * preview. The editor stages the part into the scene (a transient scene per pointer-move) and it
   * renders as a normal part, with real shadows and wall occlusion, so the preview is pixel-identical
   * to what the drop commits. The tag only excludes it from picking, rest-surface raycasts, the
   * instance pool and the idle cargo batch, and forces its flow arrow on. null clears the tag (the
   * drop commits the same id, so nothing rebuilds).
   */
  setStaging(partId: string | null): void
  /**
   * The parts a live pointer drag is moving (null when idle). Push at pointer-down/drag-begin.
   * `structural` (resize/guard-opening, where the drag regenerates hardware) ejects them from
   * the instance pool immediately, so the one-time re-bake happens while the hand is still
   * stationary. A pure move drag (structural=false: gizmo/rotate/vertex-snap/reposition) keeps
   * them pooled and writes their poses into the pool buffers in place (writeThrough), so merged
   * draws and the aSel outline path keep working through the drag. Clearing is lazy: the next
   * rebuild after the commit syncs the pool to the final poses.
   */
  setPoolDragEject(ids: readonly string[] | null, structural?: boolean): void
  /**
   * Hover-preload: warm the durable GLB/texture/geometry caches this part
   * will need, so a later placement resolves them warm instead of blocking on a cold fetch/decode on the
   * drop. Fire-and-forget and deduped per (type, packageId) for the session; fired on palette hover.
   * `opts.pipeline` (WebGPU) additionally compiles the part's render pipeline off the draw path, so a heavy
   * first-of-its-kind drop doesn't flash invisible while its shader compiles at drop time (see view.warmPart).
   */
  warmPart(part: PartInstance, opts?: { pipeline?: boolean }): void
  /**
   * Parts the last syncs added that the view is still keeping off the screen: first-of-their-kind parts
   * whose render pipelines are compiling (WebGPU), and warm parts waiting on the per-frame reveal
   * budget. 0 means everything in the scene is drawn (always 0 on WebGL, which holds nothing back).
   * Read right after a sync, it says whether the incoming scene can draw in one frame or will appear
   * over the next several. The scene-swap cover uses it as its cold/warm test (editor/sceneSwapCover.ts).
   */
  heldParts(): number
  /** resolves on the first frame {@link heldParts} reads 0 (at once when it already does) */
  whenPartsRevealed(): Promise<void>
  flashSnap(x: number, z: number, y?: number): void

  // Vertex snapping: hold a key to
  // snap a vertex of the dragged selection onto a vertex of another part. `useCollision`
  // picks the source geometry - collision-proxy corners (the "Snap to Collision
  // Vertices" default) or the detailed render mesh. The view owns the camera projection:
  // it returns the vertex nearest the cursor in screen space, the camera-plane fallback
  // point, and draws the snap markers.
  /** nearest snap vertex (world) on any of `ids`, within `thresholdPx` of the cursor; null if none */
  vertexSnapSource(
    clientX: number,
    clientY: number,
    ids: readonly string[],
    thresholdPx: number,
    useCollision: boolean,
  ): Vector3 | null
  /** nearest snap vertex (world) on a visible part NOT in `exclude`, within `thresholdPx`; with its part id */
  vertexSnapTarget(
    clientX: number,
    clientY: number,
    exclude: ReadonlySet<string>,
    thresholdPx: number,
    useCollision: boolean,
  ): { point: Vector3; partId: string } | null
  /** intersect the cursor ray with the camera-facing plane through `through` (free-drag fallback) */
  cameraPlanePoint(clientX: number, clientY: number, through: Vector3): Vector3 | null
  /** show/update the vertex-snap source + target markers; null hides each */
  showVertexMarkers(source: Vector3 | null, target: Vector3 | null): void
  /** global flow-direction arrow overlay toggle */
  setFlowArrowsVisible(visible: boolean): void
  /** show/hide the floor reference grid */
  setGridVisible(visible: boolean): void
  /** the scene's Units: how the measure tool's read-out writes a length (metres, or feet and inches) */
  setDisplayUnits(units: DisplayUnits): void

  /** boxes from the sim while running */
  applyBoxFrame(frame: BoxFrame): void
  /** Apply a static, settled device pose to one part's rig while the sim is stopped (the idle
   *  actuation preview - e.g. a blade stop shown raised so an author can check placement without
   *  pressing Play). Routes to the same joint/subPose/lamp appliers the running frame uses. No-op
   *  while running (applyBoxFrame owns the rig then) unless the part is hand-posed, or for a part with no rig. */
  applyIdlePose(partId: string, pose: { joints?: Record<string, number>; subPoses?: Record<string, SubPose>; lamps?: Record<string, boolean> }): void
  /** the parts whose rig joints the editor poses (applyIdlePose) even while running, the sim's joint frames for them
   *  ignored: a flex conveyor the walking character is pulling, whose shape is ahead of the sim's */
  setHandPosed(partIds: readonly string[]): void
  clearBoxes(): void
  /** drives purely-visual motion (belt scroll, roller spin) */
  setRunning(running: boolean): void
  /** Drop the last-frame timestamp so the next rAF `dt` is a fresh frame, not the whole
   *  elapsed gap clamped to the 0.1s ceiling. Call after the loop was frozen (e.g. the tab
   *  was hidden) so a resume doesn't feed consumers - the PLC scan especially - a dt spike. */
  resetFrameClock(): void

  // Robot editor gizmo: per-joint rotation handles +
  // an end-effector IK handle, shown for the single selected six-axis robot.
  /** show the gizmo for this robot (joint rings + IK handle), or hide it (null) */
  setRobotGizmo(partId: string | null): void
  /** the robot gizmo handle nearest the cursor within the screen-pick threshold, or null */
  pickRobotHandle(clientX: number, clientY: number): RobotHandle | null
  /** light the robot gizmo handle under the pointer, and show its joint readout (null: none) */
  setRobotHighlight(handle: RobotHandle | null): void
  /** begin a robot gizmo drag: cache the joint screen-angle basis, or the IK drag plane */
  beginRobotDrag(handle: RobotHandle, clientX: number, clientY: number): void
  /** drag result: a joint's signed angle delta (deg) for a joint handle, the IK-solved [j1..j6] for the EE
   *  handle, or the dragged tool size (link-local metres) for a `size:<param>` handle */
  robotDragResult(clientX: number, clientY: number, free?: boolean): { jointDeltaDeg?: number; ik?: number[]; sizeValue?: number } | null
  endRobotDrag(): void
  /** true if a part's gizmo is a self-posing custom-rig gizmo (vs the built-in robot's param-driven one) */
  hasRigGizmo(partId: string): boolean
  /** current held pose angle (deg) of a rig gizmo joint - the joint-drag start reference */
  rigGizmoJointAngle(partId: string, i: number): number
  /** pose a rig gizmo joint to an absolute angle (deg) */
  poseRigGizmoJoint(partId: string, i: number, deg: number): void
  /** the rig gizmo's full held pose (joint name → radians / metres), or null for a part with no rig gizmo */
  rigJointPose(partId: string): Record<string, number> | null
  /** pose a self-posing rig gizmo's whole rig (joint name → radians / metres); a no-op for a part without one */
  setRigJointPose(partId: string, pose: Record<string, number>): void
  /** true while a rig gizmo holds its arm away from the saved idle pose (jogged by hand, or showing a waypoint) */
  rigJogged(partId: string): boolean
  /** put a jogged rig back at its saved idle pose */
  resetRigJog(partId: string): void

  pickPart(clientX: number, clientY: number): string | null
  /** every part id under the cursor, front-to-back, for list-select disambiguation */
  pickPartsAt(clientX: number, clientY: number): string[]
  /** author mode: the internal rig link of `partId` under the cursor, or null (empty space / bare root) */
  pickRigLink(clientX: number, clientY: number, partId: string): string | null
  /** raycast the live sim boxes/pallets (running only); null when none is under the cursor */
  pickBox(clientX: number, clientY: number): BoxPick | null
  groundPoint(clientX: number, clientY: number): { x: number; z: number } | null
  /** world point under the cursor for the ruler: the nearest part surface, else the ground plane */
  measurePoint(clientX: number, clientY: number): [number, number, number] | null
  /**
   * highest surface directly beneath the part (straight-down ray) for Snap-to-Floor,
   * skipping `excludeIds`, the building shell, and hidden parts. null when nothing is below.
   */
  surfaceBelow(
    part: PartInstance,
    excludeIds: ReadonlySet<string>,
  ): { point: [number, number, number]; normal: [number, number, number] } | null
  /**
   * raycast the pointer against placed part meshes for drop-placement /
   * collision reposition: the world hit point + outward surface normal of the
   * nearest part under the cursor. `excludeIds` (the parts being repositioned) and
   * the building shell are skipped - the shell is the ground reference, parts
   * drop at their default height on it. null when no part is hit.
   */
  surfaceAt(
    clientX: number,
    clientY: number,
    excludeIds?: ReadonlySet<string>,
  ): { point: [number, number, number]; normal: [number, number, number]; partId?: string } | null
  /** ids of parts whose projected footprint center lies in the CSS-pixel rect (running cargo
   *  is banded at its live sim pose, not its authored spawn transform) */
  partsInRect(x0: number, y0: number, x1: number, y1: number): string[]
  /** live cargo bodies in the rect that own no scene part yet - promote them to select them */
  cargoBodiesInRect(x0: number, y0: number, x1: number, y1: number): BoxPick[]

  // Transform gizmo (visible while state is non-null; editor positions it at
  // the selection's average center)
  setGizmo(state: GizmoState | null): void
  /** handle under the pointer, for hover highlight and drag start */
  pickGizmoHandle(clientX: number, clientY: number): GizmoHandle | null
  setGizmoHighlight(handle: GizmoHandle | null): void
  /** cache the drag plane/ray basis for the handle under the cursor */
  beginGizmoDrag(handle: GizmoHandle, clientX: number, clientY: number): void
  /**
   * cumulative delta since beginGizmoDrag: translation for arrow/plane
   * handles (world meters, constrained to the handle), rotationDelta (radians)
   * about rotationAxis (world unit axis) for a ring. When `snap` is
   * given the delta is quantized to its increments ("Use Snap").
   */
  gizmoDragDelta(
    clientX: number,
    clientY: number,
    snap?: GizmoSnap | null,
  ): {
    translation?: [number, number, number]
    rotationDelta?: number
    rotationAxis?: [number, number, number]
  } | null
  /**
   * Re-constrain the active move drag from a keyboard X/Y/Z (or Shift+X/Y/Z)
   * press: cycles the constraint global -> local ->
   * released on repeat presses of the same target. No-op unless a move drag is
   * live. The editor re-runs gizmoDragDelta afterwards to apply the new axis.
   */
  gizmoConstrain(target: GizmoConstraint): void
  endGizmoDrag(): void

  /**
   * Live transform readout ("Translating: x,y,z" status):
   * a small label near the gizmo for move drags. null hides it. Rotation
   * has its own swept-arc + degree feedback (showRotationFeedback).
   */
  setTransformReadout(text: string | null): void

  // Resize handles (resize-handle parity: round orange handle dots on the selected part)
  /** show face handles for this part per PART_DEFS resize axes; null hides */
  setResizeHandles(part: PartInstance | null): void
  /** when on, a selected conveyor that authors guardOpenings swaps its size handles for its openings' edge dots */
  setSideGuardMode(on: boolean): void
  /** guard-openings mode: the guard wall under the pointer and the row value there, or null */
  pickGuardWall(clientX: number, clientY: number): GuardWallPoint | null
  /** guard-openings mode: hover feedback for a wall point (a ghost dot on solid guard, an opening's dots inside one) */
  setGuardWallHover(hit: GuardWallPoint | null): void
  /** guard-openings mode: light the selected opening's dots */
  setSelectedGuardOpening(sel: { index: number; guard: 'left' | 'right' } | null): void
  /** begin a drag along a guard wall (a sweep or a slide); resizeDragExtent then reads the row value */
  beginGuardWallDrag(guard: 'left' | 'right'): void
  /** guard-openings mode: the gaps neighbours already cut, per wall in row space, which pickGuardWall treats as open */
  setGuardJunctionOpenings(j: { left: [number, number][]; right: [number, number][] } | null): void
  pickResizeHandle(clientX: number, clientY: number): ResizeHandle | null
  /** hover highlight on the handle dot under the pointer; null clears it */
  setResizeHighlight(handle: ResizeHandle | null): void
  beginResizeDrag(handle: ResizeHandle, clientX: number, clientY: number): void
  /** new full extent (length for x, width for z) implied by the pointer, unclamped */
  resizeDragExtent(clientX: number, clientY: number): number | null
  /** where the pointer meets the dragged part's deck plane, in world XZ (the flex path drag reads a point, not an
   *  extent, and an infeed drag moves the part's own frame under it); null when the ray misses the plane */
  resizeDragPoint(clientX: number, clientY: number): { x: number; z: number } | null
  endResizeDrag(): void

  /** show the ruler measurement line + readout between two world points; null clears it */
  setRuler(a: [number, number, number] | null, b: [number, number, number] | null): void

  /**
   * animate the camera to look down `dir` (a unit world axis) at the orbit target, in auto-ortho: the
   * orbit gizmo's axis-ball click, and Numpad 1 / 3 / 7
   */
  snapToAxis(dir: Vector3): void

  /** animate the camera to frame these parts (F key); `instant` places it in this call (capture_view, which may
   *  run while the window is minimized and frames come about once a second) */
  focusOn(ids: readonly string[], opts?: { instant?: boolean }): void

  /** start follow mode: the camera rig tracks these parts' center as they move (double-F) */
  startFollow(ids: readonly string[]): void

  /** stop follow mode */
  stopFollow(): void

  /** whether the camera is currently following a node */
  isFollowing(): boolean

  /**
   * true while a camera-navigation gesture owns the keyboard (freelook:
   * RMB held, WASD/QE fly - or pilot mode). The editor must not process
   * shortcuts or scene-pointer interactions then.
   */
  isNavigating(): boolean

  /** current camera position + orbit target, for detecting whether the view has moved */
  cameraPose(): { px: number; py: number; pz: number; tx: number; ty: number; tz: number }
  /**
   * The camera position + a point it really looks at: the orbit target, or, in pilot mode or a freelook flight (which
   * turn the camera and leave the target behind), a point straight ahead. What someone following this view is shown.
   */
  lookPose(): { px: number; py: number; pz: number; tx: number; ty: number; tz: number }

  /**
   * Zoom as if `e` had reached the canvas. For DOM drawn over the scene as part of it (annotation chips):
   * a scroll there means "zoom here", but the element under the cursor takes the event. Prevents the
   * event's default, so hand it a native event from a non-passive listener.
   */
  zoomWheel(e: WheelEvent): void

  /**
   * Replay a pointer press on the canvas, for the same DOM: a middle or right drag that starts on an
   * annotation chip should pan, orbit or fly the camera as it would anywhere else in the scene.
   */
  pointerDownThrough(e: PointerEvent): void

  /**
   * Switch the camera projection (explicit user toggle - sticky, unlike the auto-ortho an
   * orbit-gizmo axis click sets). No-op when the mode is already active, so the store→view
   * echo of a view-initiated change can't demote an auto-ortho to a sticky one.
   */
  setProjection(mode: ProjectionMode): void
  /** the projection currently rendering */
  projectionMode(): ProjectionMode
  /** whether the current orthographic view is an axis-snap auto-ortho (orbiting off it reverts to perspective) */
  projectionAuto(): boolean
  /**
   * Put back a remembered projection, auto-ortho flag included (a scene tab switch, a reload). Unlike
   * setProjection it is never a no-op: it always re-seats the auto flag and the axis reference, so the
   * incoming scene can't inherit the outgoing one's auto-ortho and revert to perspective on its first frame.
   */
  loadProjection(mode: ProjectionMode, auto: boolean): void
  /**
   * fires whenever the effective projection changes, including view-initiated switches the
   * store didn't ask for: an axis snap engaging auto-ortho, orbiting off-axis reverting it,
   * pilot/VR forcing perspective. (Freelook never switches it - in an orthogonal view the
   * RMB gesture pans the view plane instead of flying.) The editor mirrors
   * these into its state.
   */
  onProjectionChanged: ((mode: ProjectionMode) => void) | null

  /**
   * Fires once the camera comes to rest after a move: orbit, dolly, pan, a freelook or pilot flight,
   * an F-focus ease, an orbit-gizmo axis snap. One call per gesture, not per frame, because the editor
   * persists the pose as per-scene workspace state (editor/store/storePrefs). Silent while a navigation
   * gesture or VR owns the camera, and while follow mode tracks a moving part (it never comes to
   * rest). The write happens when the user lets go.
   */
  onCameraSettled:
    | ((pose: { px: number; py: number; pz: number; tx: number; ty: number; tz: number }, projection: ProjectionMode) => void)
    | null

  // Immersive VR (WebXR) is walk mode in a headset: the editor camera rides a floor rig the pilot
  // walks, the headset drives the eyes on it, the controllers walk / turn / Use (render/viewport/
  // xr.ts). Emulatable without hardware via IWER (e2e/webxr-smoke.mjs, e2e/verify-vr-walk.mjs).
  /** whether an immersive-vr session is available (false under WebGPU, which a headset boots away from) */
  vrSupported(): Promise<boolean>
  /**
   * enter VR on the floor under the camera; resolves false when unsupported or denied.
   * `onChange` fires with true once presenting and false when the session ends -
   * whether via exitVR or the headset/system UI - so UI state can't drift. The editor enters
   * walk mode on true and leaves it on false; leaving walk mode ends the session.
   */
  enterVR(onChange?: (presenting: boolean) => void): Promise<boolean>
  /** end the active VR session (no-op when not presenting) */
  exitVR(): void
  /** true while an immersive VR session is presenting */
  isVRPresenting(): boolean

  /**
   * Animate the camera back to a previously captured pose (restore the factory view on exiting
   * part focus). `instant` skips the 0.25 s ease and places the camera in this call. Use it for an
   * opening view set while a scene loads. The first navigation gesture cancels the ease (freelook/orbit
   * clear focusAnim), and a cold scene load can stretch those 0.25 s over seconds of wall clock, so an
   * eased opening pose can stop part-way between the default and the intended frame.
   */
  setCameraPose(
    pose: { px: number; py: number; pz: number; tx: number; ty: number; tz: number },
    opts?: { instant?: boolean },
  ): void

  /** world-space origin of a placed part (its visual root), for presence markers; null if absent */
  partWorldPosition(id: string): [number, number, number] | null
  /**
   * Project a world point to CSS-pixel client coords (window origin, like PointerEvent.clientX):
   * the inverse of the `clientX/clientY` every pick method takes. `visible` is false when the point
   * is off-screen or behind the camera. Positioning a DOM marker inside a container (e.g. the
   * presence overlay, which lives in `.viewport`) means subtracting that container's client origin
   * first; only a `position: fixed` host can use these numbers raw.
   */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number; visible: boolean }

  // Pilot mode (first-person walk-around): a grounded capsule with
  // gravity/jump, pointer-lock mouse-look, and raycast world collision.
  /** enter/leave pilot mode; handlers route in-viewport exit/interact back to the editor */
  setPilotActive(active: boolean, handlers?: PilotHandlers): void
  /** carriable cargo centred in the pilot crosshair and within reach, or null */
  pilotLookBox(): BoxPick | null
  /** placed part ids under the pilot crosshair within reach, nearest first (interact candidates) */
  pilotLookParts(): string[]
  /** the dock-door leaf (owning building id + leaf key) under the pilot crosshair within reach, or null */
  pilotLookDockLeaf(): { partId: string; leafKey: string } | null
  /** world hold point in front of the pilot camera for carried cargo, or null when not piloting */
  pilotHoldPoint(): { position: [number, number, number]; rotationY: number } | null
  /** cap the pilot's walking speed (m/s) while it hauls something heavy, a flex conveyor's end; null frees it */
  setPilotSpeedLimit(limit: number | null): void
  /** feet position of the active pilot for the sim-side push-body capsule, or null when not piloting */
  pilotBodyPosition(): [number, number, number] | null
  /** live first-person pose (feet position + heading) for collab presence, or null when not piloting */
  pilotPose(): { position: [number, number, number]; yaw: number } | null
  /** mobile virtual-joystick walk input: forward (+ahead) and strafe (+right), each in [-1, 1] */
  pilotSetMove(forward: number, strafe: number): void
  /** mobile look-pad finger drag (CSS px), yawing/pitching the first-person camera */
  pilotLook(dxPx: number, dyPx: number): void
  /** mobile on-screen Use button (interact, E/click equivalent) */
  pilotInteract(): void
  /** whether Use would act on what the walk is aiming at (the prompt is non-empty); VR colours its laser with it */
  setPilotAimLive(live: boolean): void
  /** reconcile in-world peer pilot avatars (collab presence capsules); pass [] to clear */
  setPilotAvatars(avatars: ReadonlyArray<{ id: number; color: string; position: [number, number, number]; yaw: number }>): void

  /**
   * live rotate-ring feedback: swept-arc visual + degree readout for the
   * applied rotation (after any Ctrl snapping). null hides it.
   */
  showRotationFeedback(angleRad: number | null): void

  getStats(): RenderStats
  dispose(): void
}
