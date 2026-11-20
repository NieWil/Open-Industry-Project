// Editor camera navigation for the view: F-focus and follow, orbit about the
// selection, the orbit gizmo, wheel zoom, navigation cancel, camera-settle reports, projection switching.

import { Box3, Matrix4, Quaternion, Spherical, Vector3 } from 'three'
import type { Object3D } from 'three'
import { isCargoPart } from '../../core/frame'
import { activeNav } from '../../core/navigation'
import { partFootprint, toWorldXZ } from '../../core/parts/partGeometry'
import type { ProjectionMode } from '../api'
import { worldPerPixel } from './editorCamera'
import { snapOrbitAngles, wrapAngle } from './orbitSnap'
import { WHEEL_ZOOM, applyWheelZoom } from './wheelZoom'
import type { Entry, FocusAnim } from './viewTypes'
import type { RenderView } from './view'

/**
 * Editor camera navigation's own state (`view.nav`): orbit-gizmo and orbit-pivot scratch, the
 * cancel-navigation snapshot, the projection's auto-ortho flags, camera-settle detection, the
 * F-focus ease, wheel zoom and follow mode.
 */
export class CameraNavState {
  readonly orbitOffset = new Vector3()
  readonly orbitSph = new Spherical()
  // camera position + target when an orbit-gizmo drag began, for a right-click abort restore (the target
  // moves too when the drag turns about the selection)
  readonly orbitStartPos = new Vector3()
  readonly orbitStartTarget = new Vector3()
  /** the corner gizmo's orbit pivot for its current drag: the same pick as an OrbitControls drag */
  gizmoPivot: Vector3 | null = null
  /** Alt is down: an orbit snaps to the nearest 45° view (applyOrbitSnap) */
  altHeld = false
  // Orbit snapping for the current drag (applyOrbitSnap): the orbit's own angles, which keep taking the drag while the
  // camera shows a snapped stop, and the angles last written to the camera, so each step's turn is the difference.
  // null = not snapping (no Alt, or the drag hasn't turned yet).
  orbitSnap: { theta: number; phi: number; wroteTheta: number; wrotePhi: number; snapped: boolean } | null = null
  // camera + target when an OrbitControls orbit/pan drag began, for a right-click /
  // Esc abort that snaps them back (cancel navigation)
  readonly navStartPos = new Vector3()
  /** the point this orbit drag (and its damping tail) turns about: the selection's centre, or null for the
   *  orbit target as OrbitControls has it. See pickOrbitPivot / updateOrbitControls. */
  orbitPivot: Vector3 | null = null
  readonly pivotM = new Matrix4()
  readonly pivotQ0 = new Quaternion()
  readonly pivotQ1 = new Quaternion()
  readonly pivotT0 = new Vector3()
  readonly pivotD = new Vector3()
  readonly pivotRD = new Vector3()
  readonly navStartTarget = new Vector3()
  navigating = false
  navCancelled = false
  /** the pointer that last pressed in the viewport: the one an OrbitControls drag holds, for ending it when its
   *  release is lost (endLostNavigation) */
  navPointer: { id: number; type: string } | null = null
  // Camera projection state (Perspective/Orthogonal). orthoAuto marks an
  // orthographic mode engaged by an orbit-gizmo axis snap: any
  // orbit off that pose reverts it to perspective, while an explicit setProjection stays
  // until toggled back. orthoRefQuat is the settled axis-view orientation the revert check
  // compares against: a full quaternion, not the view direction, so an azimuth-only spin at
  // the top-view pole (forward unchanged) still counts as orbiting away. navStartProjection
  // snapshots the state a nav/orbit drag began in, so a right-click/Esc abort restores it
  // with the pose (the drag itself may have auto-reverted the projection).
  orthoAuto = false
  orthoRefQuat: Quaternion | null = null
  navStartProjection: { mode: ProjectionMode; auto: boolean } | null = null
  // camera-settle detection (trackCameraSettle): the camera + target last compared against, when they
  // started holding still (0 = not timing), and whether anything has moved since the last report -
  // without which a camera at rest would re-report every frame. Vectors, not a pose object: this runs
  // per frame, and cameraPose() mints a fresh six-field object every call.
  readonly settleP = new Vector3()
  readonly settleT = new Vector3()
  settleSeen = false
  settleSince = 0
  settleMoved = false
  focusAnim: FocusAnim | null = null
  // wheel zoom (wheelZoom.ts): the zoom still to apply, in log scale, eased out over a few frames
  // about `zoomPivot`, the point that was under the cursor. zoomPick caches that point per cursor
  // pixel for a moment: a continuous scroll moves the camera only by scaling about the pivot, which
  // keeps the same point under the same pixel, so one raycast serves the whole gesture.
  zoomPending = 0
  readonly zoomPivot = new Vector3()
  zoomPick = { x: NaN, y: NaN, at: 0 }
  // "follow selection" (double-F): once active, the orbit rig tracks the followed
  // parts' moving center each frame, preserving the camera's relative distance/angle.
  // null = not following. followCenter is the last anchor, so we apply only per-frame deltas.
  followIds: readonly string[] | null = null
  followCenter: Vector3 | null = null
  readonly followTmp = new Vector3()
  readonly followAcc = new Vector3()
  readonly followPos = new Vector3()
}

/** what camera navigation reaches on the view beyond its own {@link CameraNavState} */
export type CameraHost = Pick<
  RenderView,
  | 'applyProjection'
  | 'boxes'
  | 'camTmp'
  | 'camera'
  | 'cameraPose'
  | 'container'
  | 'controls'
  | 'ensureFreshPose'
  | 'entries'
  | 'groundPlane'
  | 'hidden'
  | 'hitPoint'
  | 'isNavigating'
  | 'nav'
  | 'onCameraSettled'
  | 'onProjectionChanged'
  | 'partsGroup'
  | 'raycastParts'
  | 'raycaster'
  | 'selection'
  | 'setPointerRay'
  | 'stagingId'
  | 'stopFollow'
  | 'xr'
>

/** how long the camera must hold still before onCameraSettled fires - one write per gesture */
const CAMERA_SETTLE_MS = 400

const FOCUS_DURATION = 0.25
const FOCUS_DISTANCE_FACTOR = 2.2
/** F-focus and axis snaps frame from at least this far (the wheel may go much closer, see wheelZoom.ts) */
const FOCUS_MIN_DISTANCE = 1.5

/**
 * Centre + bounding radius of some parts, as F frames them: their rendered geometry, a running box's live
 * pose, the declared footprint for anything with nothing drawn, a default for none. Shared by focusOn and the
 * orbit pivot (pickOrbitPivot), so an orbit turns about the same centre F would frame.
 */
export function frameBounds(view: CameraHost, entries: readonly Entry[]): { center: Vector3; radius: number } {
  let center = new Vector3(0, 0.5, 0)
  let radius = 6
  // Prefer the parts' actual rendered geometry (a fresh world AABB). This is accurate for custom rigs
  // that declare no footprint bounds (whose partFootprint is a tiny default box that frames the camera
  // far too close). Fall back to the declared footprint when the object AABB is empty (e.g. an async
  // mesh not yet loaded), then to a sensible default for an empty scene.
  const union = new Box3()
  const tmp = new Box3()
  let haveBox = false
  const boxless: Entry[] = []
  for (const entry of entries) {
    // A running cargo body's real pose is in the instanced batch, not its (stub) visual, whose
    // AABB is empty, so the footprint fallback below would frame the authored spawn pose. Framing a
    // box mid-line has to read the batch, or double-F flies the camera to where the box started and
    // then tracks deltas from there, a permanent offset (startFollow already anchors live).
    if (isCargoPart(entry.part) && view.boxes.livePartBox(entry.part.id, tmp)) {
      union.union(tmp)
      haveBox = true
      continue
    }
    entry.visual.object.updateWorldMatrix(true, true)
    tmp.setFromObject(entry.visual.object)
    if (!tmp.isEmpty()) {
      union.union(tmp)
      haveBox = true
    } else boxless.push(entry)
  }
  if (haveBox) {
    // A mixed selection: an entry with nothing drawn (a note or a group is an empty transform; an async mesh
    // may not have loaded) still belongs in the frame, so it adds its declared footprint (a point at its
    // origin for a note or group) instead of being dropped.
    const corner = new Vector3()
    for (const { part } of boxless) {
      const fp = partFootprint(part)
      const cx = fp.cx ?? 0
      const cz = fp.cz ?? 0
      for (const lx of [cx - fp.hx, cx + fp.hx]) {
        for (const lz of [cz - fp.hz, cz + fp.hz]) {
          const w = toWorldXZ(part, lx, lz)
          union.expandByPoint(corner.set(w.x, part.position[1] + fp.y0, w.z))
          union.expandByPoint(corner.set(w.x, part.position[1] + fp.y1, w.z))
        }
      }
    }
    union.getCenter(center)
    radius = Math.max(0.5, union.getSize(new Vector3()).length() / 2)
  } else if (entries.length) {
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    const spheres = entries.map(({ part }) => {
      const fp = partFootprint(part)
      const wc = toWorldXZ(part, fp.cx ?? 0, fp.cz ?? 0)
      const c = new Vector3(wc.x, part.position[1] + (fp.y0 + fp.y1) / 2, wc.z)
      const r = Math.hypot(fp.hx, (fp.y1 - fp.y0) / 2, fp.hz)
      min.x = Math.min(min.x, c.x - r)
      min.y = Math.min(min.y, c.y - r)
      min.z = Math.min(min.z, c.z - r)
      max.x = Math.max(max.x, c.x + r)
      max.y = Math.max(max.y, c.y + r)
      max.z = Math.max(max.z, c.z + r)
      return { c, r }
    })
    center = min.add(max).multiplyScalar(0.5)
    radius = 0.5
    for (const s of spheres) radius = Math.max(radius, center.distanceTo(s.c) + s.r)
  }
  return { center, radius }
}

export function focusOn(view: CameraHost, ids: readonly string[], opts?: { instant?: boolean }): void {
  const entries = ids.length
    ? ids.map((id) => view.entries.get(id)).filter((e): e is Entry => e !== undefined)
    : [...view.entries.values()]
  const { center, radius } = frameBounds(view, entries)
  const dir = new Vector3().subVectors(view.camera.position, view.controls.target)
  if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1)
  dir.normalize()
  const dist = Math.min(Math.max(radius * FOCUS_DISTANCE_FACTOR, FOCUS_MIN_DISTANCE), view.controls.maxDistance)
  if (opts?.instant) {
    const to = center.clone().addScaledVector(dir, dist)
    setCameraPose(view, { px: to.x, py: to.y, pz: to.z, tx: center.x, ty: center.y, tz: center.z }, { instant: true })
    return
  }
  view.nav.orbitPivot = null
  view.nav.focusAnim = {
    t: 0,
    fromTarget: view.controls.target.clone(),
    toTarget: center,
    fromPos: view.camera.position.clone(),
    toPos: center.clone().addScaledVector(dir, dist),
  }
}

/**
 * Follow mode (double-F): start tracking the given parts so the camera rig moves
 * with their center as they animate. Only per-frame motion deltas are applied, so the
 * caller's framing (e.g. a preceding `focusOn`) and any orbit/zoom the user does are kept.
 */
export function startFollow(view: CameraHost, ids: readonly string[]): void {
  const arr = ids.slice()
  view.nav.followIds = arr
  const anchor = followAnchor(view, arr)
  if (anchor) {
    view.nav.followCenter = anchor.clone()
  } else {
    view.nav.followIds = null
    view.nav.followCenter = null
  }
}

/** averaged world-space origin of the given parts, or null if none are present */
export function followAnchor(view: CameraHost, ids: readonly string[]): Vector3 | null {
  let count = 0
  view.nav.followAcc.set(0, 0, 0)
  for (const id of ids) {
    // a running cargo body's real pose lives in the instanced batch, not its (stub) visual
    // object - read it from SimBoxes so follow tracks a box as it moves down the line
    if (view.boxes.livePartPosition(id, view.nav.followPos)) {
      view.nav.followAcc.add(view.nav.followPos)
      count++
      continue
    }
    const entry = view.entries.get(id)
    if (!entry) continue
    // a frozen part's poseRev may have moved this frame (follow runs before the owned matrix
    // walk); re-bake before reading its matrixWorld - O(followed ids), no-op when unchanged
    view.ensureFreshPose(entry)
    const obj = entry.visual.object
    obj.updateWorldMatrix(true, false)
    view.nav.followAcc.add(view.nav.followPos.setFromMatrixPosition(obj.matrixWorld))
    count++
  }
  if (count === 0) return null
  return view.nav.followAcc.multiplyScalar(1 / count)
}

/**
 * Per-frame follow update: translate the camera and orbit target by the followed center's
 * motion since last frame. Skipped (but rebased) while a focus animation is reframing, so the
 * two never fight. Runs after the part ticks so it reads this frame's positions.
 */
export function updateFollow(view: CameraHost): void {
  if (!view.nav.followIds || !view.nav.followCenter) return
  const anchor = followAnchor(view, view.nav.followIds)
  if (!anchor) {
    view.stopFollow()
    return
  }
  if (view.nav.focusAnim) {
    // A framing animation is in flight (double-F = focusOn + startFollow): it lerps toward
    // endpoints sampled when focusOn ran, so on a moving body it would end FOCUS_DURATION's
    // worth of travel behind, and follow, applying only deltas afterwards, would keep that gap
    // forever. Slide the endpoints by the same motion so the animation converges on the live pose.
    const drift = view.nav.followTmp.subVectors(anchor, view.nav.followCenter)
    view.nav.focusAnim.toTarget.add(drift)
    view.nav.focusAnim.toPos.add(drift)
    view.nav.followCenter.copy(anchor)
    return
  }
  const delta = view.nav.followTmp.subVectors(anchor, view.nav.followCenter)
  view.camera.position.add(delta)
  view.controls.target.add(delta)
  view.nav.followCenter.copy(anchor)
}

/** orbit-gizmo axis click: animate the camera to look down `dir` at the target */
export function snapToAxis(view: CameraHost, dir: Vector3): void {
  const target = view.controls.target
  const dist = Math.min(
    Math.max(view.camera.position.distanceTo(target), FOCUS_MIN_DISTANCE),
    view.controls.maxDistance,
  )
  view.nav.focusAnim = {
    t: 0,
    fromTarget: target.clone(),
    toTarget: target.clone(),
    fromPos: view.camera.position.clone(),
    toPos: target.clone().addScaledVector(dir, dist),
  }
  // an axis view is orthographic. Engaged as auto (orbiting off the axis reverts to
  // perspective, syncProjection) unless ortho is already explicit, which stays.
  if (!(view.camera.orthographic && !view.nav.orthoAuto)) view.applyProjection('orthographic', true)
}

/** orbit-gizmo drag start: snapshot the camera so a right-click abort can restore it */
export function beginOrbit(view: CameraHost): void {
  view.nav.focusAnim = null
  view.nav.orbitSnap = null
  view.nav.orbitStartPos.copy(view.camera.position)
  view.nav.orbitStartTarget.copy(view.controls.target)
  view.nav.navStartProjection = snapshotProjection(view)
  // the gizmo is the orbit a trackpad has (no middle button), so it turns about the selection too
  view.nav.gizmoPivot = pickOrbitPivot(view)
}

/** orbit-gizmo right-click abort: restore the camera to its pre-orbit pose */
export function cancelOrbit(view: CameraHost): void {
  view.nav.gizmoPivot = null
  view.camera.position.copy(view.nav.orbitStartPos)
  view.controls.target.copy(view.nav.orbitStartTarget)
  view.camera.lookAt(view.controls.target)
  restoreProjection(view)
}

/**
 * The pivot an orbit drag turns about: the centre of the selection (as F would frame it), when the setting is
 * on and that centre is on screen. Off screen, orbiting about it would swing the view somewhere the person is
 * not looking, so the drag keeps OrbitControls' own target.
 */
export function pickOrbitPivot(view: CameraHost): Vector3 | null {
  if (!activeNav().orbitSelection || view.selection.size === 0) return null
  const entries: Entry[] = []
  for (const id of view.selection) {
    const e = view.entries.get(id)
    if (e) entries.push(e)
  }
  if (entries.length === 0) return null
  const { center } = frameBounds(view, entries)
  const ndc = view.nav.pivotD.copy(center).project(view.camera)
  if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null
  return center
}

/**
 * OrbitControls' update (installed over it in the constructor), orbiting about `orbitPivot` instead of the
 * target when one is set.
 *
 * OrbitControls can only turn the camera about the point it looks at. Its update rotates the camera's offset
 * from the target by some R (yaw about world up, pitch about the camera's right) and pans both by the same
 * vector. Turning about P instead differs by a pure translation, (P - T0) - R(P - T0), applied to camera and
 * target: the view direction is untouched, so nothing jumps, P stays put on screen, and damping, the pole
 * clamp and the cancel snapshot all keep working because OrbitControls still does the turning. R is read off
 * the rig's orientation before and after (as lookAt gives it, so a focus ease that moved the camera without
 * turning it reads as no rotation). Once a frame turns nothing and no drag is live, the tail is over.
 */
export function updateOrbitControls(view: CameraHost, update: (deltaTime?: number | null) => boolean, deltaTime?: number | null): boolean {
  const pivot = view.nav.orbitPivot
  if (!pivot) {
    const changed = update(deltaTime)
    return (view.nav.navigating && applyOrbitSnap(view)) || changed
  }
  notePivotStart(view)
  // the snap turns the rig before the pivot shift, so the shift carries the snapped turn about the pivot too
  const turned = update(deltaTime)
  const changed = (view.nav.navigating && applyOrbitSnap(view)) || turned
  if (shiftToPivot(view, pivot)) return true
  if (!view.nav.navigating) view.nav.orbitPivot = null
  return changed
}

/**
 * After an orbit step, with Alt held: fold the step's turn into the orbit's own angles, and put the camera at the
 * snap stop they are near (orbitSnap.ts), or at those angles when they are near none. Reaching a straight view turns
 * the projection auto-orthographic, as an axis click does, and turning off it reverts that (syncProjection). A
 * drag that only pans never turns, so it never snaps. Returns whether it moved the camera.
 */
export function applyOrbitSnap(view: CameraHost): boolean {
  const nav = view.nav
  if (!nav.altHeld) {
    nav.orbitSnap = null
    return false
  }
  const target = view.controls.target
  const sph = nav.orbitSph.setFromVector3(nav.orbitOffset.copy(view.camera.position).sub(target))
  const s = nav.orbitSnap
  if (!s) {
    nav.orbitSnap = { theta: sph.theta, phi: sph.phi, wroteTheta: sph.theta, wrotePhi: sph.phi, snapped: false }
    return false
  }
  const dTheta = wrapAngle(sph.theta - s.wroteTheta)
  const dPhi = sph.phi - s.wrotePhi
  // the pole guard (Spherical.makeSafe) nudges phi by 1e-6 at the top view; that is not a turn
  if (Math.abs(dTheta) < 1e-5 && Math.abs(dPhi) < 1e-5) return false
  s.theta += dTheta
  s.phi = Math.min(Math.max(s.phi + dPhi, view.controls.minPolarAngle), view.controls.maxPolarAngle)
  const stop = snapOrbitAngles(s.theta, s.phi, view.controls.minPolarAngle, view.controls.maxPolarAngle)
  sph.theta = stop ? stop.theta : s.theta
  sph.phi = stop ? stop.phi : s.phi
  sph.makeSafe()
  view.camera.position.copy(target).add(nav.orbitOffset.setFromSpherical(sph))
  view.camera.lookAt(target)
  s.wroteTheta = sph.theta
  s.wrotePhi = sph.phi
  s.snapped = stop !== null
  if (stop?.axis && !view.camera.orthographic) view.applyProjection('orthographic', true)
  return true
}

/** An OrbitControls drag ended: a snapped camera stays where it snapped, rather than drifting on the damping tail. */
export function endOrbitSnap(view: CameraHost): void {
  if (view.nav.orbitSnap?.snapped) (view.controls as unknown as { _sphericalDelta: Spherical })._sphericalDelta.set(0, 0, 0)
  view.nav.orbitSnap = null
}

/** before a turn about the target: note the target and the rig's orientation (as lookAt gives it) */
export function notePivotStart(view: CameraHost): void {
  const t0 = view.nav.pivotT0.copy(view.controls.target)
  view.nav.pivotQ0.setFromRotationMatrix(view.nav.pivotM.lookAt(view.camera.position, t0, view.camera.up))
}

/**
 * After a turn about the target (noted by notePivotStart): move camera and target together so the turn was
 * about `pivot` instead. Returns false when the rig did not turn.
 */
export function shiftToPivot(view: CameraHost, pivot: Vector3): boolean {
  view.nav.pivotQ1.setFromRotationMatrix(view.nav.pivotM.lookAt(view.camera.position, view.controls.target, view.camera.up))
  const r = view.nav.pivotQ1.multiply(view.nav.pivotQ0.invert())
  if (1 - Math.abs(r.w) < 1e-12) return false
  const d = view.nav.pivotD.subVectors(pivot, view.nav.pivotT0)
  const shift = d.sub(view.nav.pivotRD.copy(d).applyQuaternion(r))
  view.camera.position.add(shift)
  view.controls.target.add(shift)
  return true
}

/** right-click / Esc mid orbit-pan: snap the camera back, then freeze input until release */
export function cancelNavigation(view: CameraHost): void {
  view.nav.navCancelled = true
  view.nav.focusAnim = null
  view.nav.orbitPivot = null
  view.camera.position.copy(view.nav.navStartPos)
  view.controls.target.copy(view.nav.navStartTarget)
  // flush OrbitControls' accumulated (damped) rotate/pan so the restore snaps
  // cleanly instead of drifting; update() then resyncs its internal spherical
  const oc = view.controls as unknown as { _sphericalDelta: Spherical; _panOffset: Vector3 }
  oc._sphericalDelta.set(0, 0, 0)
  oc._panOffset.set(0, 0, 0)
  view.controls.update()
  restoreProjection(view)
  // ignore further drag input until the buttons release (navigation cancelled)
  view.controls.enabled = false
}

/**
 * Freelook's orthogonal fallback: slide the camera and the orbit
 * target along the view plane so the projection and the plan/elevation framing hold.
 * Grab-style: the scene follows the cursor. Pixel delta → world via the ortho frustum.
 */
export function panBy(view: CameraHost, dxPx: number, dyPx: number): void {
  const k = worldPerPixel(
    view.camera,
    view.camera.position.distanceTo(view.controls.target),
    view.container.clientHeight || 1,
  )
  // camera basis columns: [0..2] = right, [4..6] = up. Pan only translates, so the
  // last-rendered matrixWorld basis is current even mid-gesture.
  const m = view.camera.matrixWorld.elements
  view.camTmp
    .set(
      -dxPx * m[0]! + dyPx * m[4]!,
      -dxPx * m[1]! + dyPx * m[5]!,
      -dxPx * m[2]! + dyPx * m[6]!,
    )
    .multiplyScalar(k)
  view.camera.position.add(view.camTmp)
  view.controls.target.add(view.camTmp)
}

/** orbit-gizmo drag: rotate the camera around the target, matching OrbitControls' feel */
export function orbitBy(view: CameraHost, dxPx: number, dyPx: number): void {
  view.nav.focusAnim = null
  const pivot = view.nav.gizmoPivot
  if (pivot) notePivotStart(view)
  const target = view.controls.target
  const k = (2 * Math.PI) / (view.container.clientHeight || 1)
  view.nav.orbitOffset.copy(view.camera.position).sub(target)
  view.nav.orbitSph.setFromVector3(view.nav.orbitOffset)
  view.nav.orbitSph.theta -= dxPx * k
  view.nav.orbitSph.phi -= dyPx * k
  view.nav.orbitSph.phi = Math.min(
    Math.max(view.nav.orbitSph.phi, view.controls.minPolarAngle),
    view.controls.maxPolarAngle,
  )
  view.nav.orbitSph.makeSafe()
  view.nav.orbitOffset.setFromSpherical(view.nav.orbitSph)
  view.camera.position.copy(target).add(view.nav.orbitOffset)
  view.camera.lookAt(target)
  applyOrbitSnap(view)
  if (pivot) shiftToPivot(view, pivot)
}

/**
 * Set `zoomPivot` to the visible surface under the cursor; with nothing there (sky, or a hit past
 * the far plane) fall back to the floor plane, then to the cursor ray at the orbit target's depth.
 */
export function zoomPivotAt(view: CameraHost, clientX: number, clientY: number): void {
  const now = performance.now()
  const last = view.nav.zoomPick
  if (clientX === last.x && clientY === last.y && now - last.at < 250) return
  view.nav.zoomPick = { x: clientX, y: clientY, at: now }
  view.setPointerRay(clientX, clientY)
  const ray = view.raycaster.ray
  const far = view.camera.far
  for (const hit of view.raycaster.intersectObjects(view.raycastParts(far), true)) {
    if (hit.distance > far) break
    if (!zoomTargetable(view, hit.object)) continue
    view.nav.zoomPivot.copy(hit.point)
    return
  }
  const floor = ray.intersectPlane(view.groundPlane, view.hitPoint)
  if (floor && floor.distanceTo(ray.origin) <= far) {
    view.nav.zoomPivot.copy(floor)
    return
  }
  const depth = view.camTmp.subVectors(view.controls.target, view.camera.position).length()
  ray.at(Math.max(depth, WHEEL_ZOOM.minPivotDistance), view.nav.zoomPivot)
}

/**
 * Can a raycast hit on `obj` anchor a zoom? Not when it is not drawn: a hidden or staged part, or a
 * node switched off (the building's auto-hidden near walls and roof, which three's raycaster still
 * hits). Merge-pass sources are the exception, as in pilotCollectMeshes: hidden, but on screen
 * through their merged copy.
 */
export function zoomTargetable(view: CameraHost, obj: Object3D): boolean {
  for (let node: Object3D | null = obj; node && node !== view.partsGroup; node = node.parent) {
    const ud = node.userData
    if (!node.visible && ud.poolHidden !== true && ud.staticFoldSource !== true) return false
    const id = ud.partId
    if (typeof id === 'string' && (view.hidden.has(id) || id === view.stagingId)) return false
  }
  return true
}

/** per frame, before OrbitControls: ease the pending wheel zoom in about its pivot */
export function stepWheelZoom(view: CameraHost, dt: number): void {
  if (view.nav.zoomPending === 0) return
  if (view.nav.focusAnim) {
    view.nav.zoomPending = 0 // something framed the camera since; drop the rest of the scroll
    return
  }
  let step = view.nav.zoomPending * (1 - Math.exp(-dt / WHEEL_ZOOM.smoothTau))
  if (Math.abs(view.nav.zoomPending - step) < 1e-4) step = view.nav.zoomPending
  view.nav.zoomPending -= step
  applyWheelZoom(view.camera.position, view.controls.target, view.nav.zoomPivot, step, {
    orthographic: view.camera.orthographic,
    maxDistance: view.controls.maxDistance,
    floorY: -view.groundPlane.constant,
  })
}

/**
 * Report the camera once it comes to rest (see IRenderView.onCameraSettled). Polled per frame
 * rather than hung off OrbitControls' 'end' event because that event covers only orbit/dolly/pan:
 * a freelook flight, a pilot walk, an F-focus ease, an orbit-gizmo axis snap and follow mode all
 * move the camera without it, and a pose that is persisted must not depend on which mover put the
 * camera where it is. Six float compares a frame.
 */
export function trackCameraSettle(view: CameraHost): void {
  if (!view.onCameraSettled) return
  // a navigation gesture or the headset is still driving the camera: it has not come to rest, only
  // paused mid-flight (a freelook hover between WASD taps holds a pose for whole seconds)
  if (view.isNavigating() || view.xr?.presenting === true) {
    view.nav.settleMoved = true
    view.nav.settleSince = 0
    return
  }
  const p = view.camera.position
  const t = view.controls.target
  // first observation is a baseline only: the camera as loaded has not "moved", and reporting it
  // would write back the just-restored pose on every load
  if (!view.nav.settleSeen) {
    view.nav.settleSeen = true
    view.nav.settleP.copy(p)
    view.nav.settleT.copy(t)
    return
  }
  // squared distances: two compares, no allocation, no sqrt. EPS is 1e-4 m: under damping the tail
  // decays toward the target rather than snapping, so an exact compare would never call it still.
  const EPS_SQ = 1e-8
  if (view.nav.settleP.distanceToSquared(p) > EPS_SQ || view.nav.settleT.distanceToSquared(t) > EPS_SQ) {
    view.nav.settleP.copy(p)
    view.nav.settleT.copy(t)
    view.nav.settleSince = 0
    view.nav.settleMoved = true
    return
  }
  if (!view.nav.settleMoved) return
  // Wall clock, not the frame dt the rest of the tick runs on: dt is capped at 0.1 s so a slow
  // frame can't jolt the sim, which would silently stretch this delay on the machines that
  // render slowest (a software-WebGL frame at 5 fps credits 500 ms per second of real time).
  const now = performance.now()
  if (view.nav.settleSince === 0) view.nav.settleSince = now
  if (now - view.nav.settleSince < CAMERA_SETTLE_MS) return
  view.nav.settleSince = 0
  view.nav.settleMoved = false
  view.onCameraSettled(view.cameraPose(), view.camera.projectionMode) // one allocation per gesture
}

/** the single projection-change chokepoint: camera + auto flag + outline + notification */
export function applyProjection(view: CameraHost, mode: ProjectionMode, auto: boolean): void {
  const changed = mode !== view.camera.projectionMode
  view.nav.orthoAuto = mode === 'orthographic' && auto
  view.nav.orthoRefQuat = null // re-capture at the next settled frame (syncProjection)
  if (!changed) return
  if (mode === 'orthographic') {
    // seed the frustum from the current orbit distance so the toggle keeps the
    // target-plane framing; syncProjection tracks it per frame from here on
    view.camera.setFocusDistance(view.camera.position.distanceTo(view.controls.target))
  } else {
    // leaving ortho with an unfolded wheel zoom (same-frame transient) would otherwise
    // carry camera.zoom into the perspective projection
    foldOrthoZoom(view)
  }
  view.camera.setProjection(mode)
  // (the outline needs no notice here: both twins compare window-space depth directly, so
  // their occlusion test is projection-agnostic)
  view.onProjectionChanged?.(mode)
}

export function snapshotProjection(view: CameraHost): { mode: ProjectionMode; auto: boolean } {
  return { mode: view.camera.projectionMode, auto: view.nav.orthoAuto }
}

/** nav-abort partner of snapshotProjection: an aborted orbit un-reverts auto-ortho too */
export function restoreProjection(view: CameraHost): void {
  const snap = view.nav.navStartProjection
  if (!snap) return
  view.nav.navStartProjection = null
  view.applyProjection(snap.mode, snap.auto)
}

/**
 * Fold OrbitControls' orthographic dolly (it mutates camera.zoom, not position) back into
 * the camera↔target distance, keeping position+target the single source of zoom truth -
 * F-focus/pose animations and the distance-derived frustum then all keep working.
 */
export function foldOrthoZoom(view: CameraHost): void {
  const cam = view.camera
  if (cam.zoom === 1) return
  const target = view.controls.target
  const dir = view.camTmp.copy(cam.position).sub(target)
  const dist = Math.min(
    Math.max(dir.length() / cam.zoom, view.controls.minDistance),
    view.controls.maxDistance,
  )
  cam.position.copy(target).addScaledVector(dir.normalize(), dist)
  cam.zoom = 1
  cam.updateProjectionMatrix()
}

/**
 * Per-frame orthographic upkeep, after every camera mover ran: fold any wheel/pinch zoom
 * into distance, re-derive the frustum from it, and let an auto-ortho (axis snap) revert
 * to perspective once the user orbits off the snapped axis.
 */
export function syncProjection(view: CameraHost): void {
  if (!view.camera.orthographic) return
  foldOrthoZoom(view)
  view.camera.setFocusDistance(view.camera.position.distanceTo(view.controls.target))
  if (view.nav.orthoAuto && !view.nav.focusAnim) {
    // reference orientation = the first frame after the snap animation settles (post the
    // frame's controls.update(), so OrbitControls' pole-epsilon clamp is already baked in).
    // Any later rotation beyond ~0.6°, including an azimuth-only spin at the top-view
    // pole (which leaves the view direction unchanged), is an orbit away from the axis
    // view and reverts the auto-ortho to perspective. Pan/follow only translate, so they
    // never trigger it.
    if (!view.nav.orthoRefQuat) view.nav.orthoRefQuat = view.camera.quaternion.clone()
    else if (view.nav.orthoRefQuat.angleTo(view.camera.quaternion) > 0.01) view.applyProjection('perspective', false)
  }
}

/** animate the camera back to a previously captured pose (e.g. restore the factory view on exiting part focus) */
/** how far ahead of a walking or flying camera its look point is put (metres); a follower orbits about it */
const LOOK_AHEAD_M = 5
const lookDir = new Vector3()

/**
 * The camera's position and a point it really looks at. Orbiting, that is the orbit target. Pilot and freelook turn
 * the camera on their own and leave the target where it was, so then it is a point straight ahead.
 */
export function lookPose(view: CameraHost, freeCamera: boolean): { px: number; py: number; pz: number; tx: number; ty: number; tz: number } {
  const p = view.camera.position
  if (!freeCamera) {
    const t = view.controls.target
    return { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z }
  }
  view.camera.getWorldDirection(lookDir).multiplyScalar(LOOK_AHEAD_M)
  return { px: p.x, py: p.y, pz: p.z, tx: p.x + lookDir.x, ty: p.y + lookDir.y, tz: p.z + lookDir.z }
}

export function setCameraPose(
  view: CameraHost,
  pose: { px: number; py: number; pz: number; tx: number; ty: number; tz: number },
  opts?: { instant?: boolean },
): void {
  if (opts?.instant) {
    // Same steps as cancelNavigation: write the rig, then flush OrbitControls’ damped
    // rotate/pan and update() so its internal spherical resyncs to where we just put the camera
    // (otherwise the next frame damps back toward the pose we jumped away from).
    view.nav.focusAnim = null
    view.nav.zoomPending = 0
    view.nav.orbitPivot = null
    view.camera.position.set(pose.px, pose.py, pose.pz)
    view.controls.target.set(pose.tx, pose.ty, pose.tz)
    view.camera.lookAt(view.controls.target)
    const oc = view.controls as unknown as { _sphericalDelta: Spherical; _panOffset: Vector3 }
    oc._sphericalDelta.set(0, 0, 0)
    oc._panOffset.set(0, 0, 0)
    view.controls.update()
    view.camera.updateMatrixWorld(true)
    return
  }
  view.nav.focusAnim = {
    t: 0,
    fromTarget: view.controls.target.clone(),
    toTarget: new Vector3(pose.tx, pose.ty, pose.tz),
    fromPos: view.camera.position.clone(),
    toPos: new Vector3(pose.px, pose.py, pose.pz),
  }
}

export function updateFocus(view: CameraHost, dt: number): void {
  const anim = view.nav.focusAnim
  if (!anim) return
  anim.t = Math.min(anim.t + dt / FOCUS_DURATION, 1)
  const k = anim.t * anim.t * (3 - 2 * anim.t)
  view.controls.target.lerpVectors(anim.fromTarget, anim.toTarget, k)
  view.camera.position.lerpVectors(anim.fromPos, anim.toPos, k)
  if (anim.t >= 1) view.nav.focusAnim = null
}
