// Walk (pilot) mode for the view (extracted from view.ts): the collider broadphase, the crosshair / VR
// Use ray, conveyor carry, spawn poses, entering and leaving the walk, and collab peers' avatars.

import { CapsuleGeometry, Color, Group, Mesh, MeshStandardMaterial, Sphere } from 'three'
import type { InstancedMesh, Intersection, Material, Object3D, Vector3 } from 'three'
import { isCargoPart } from '../../core/frame'
import { conveyorSurfaceVelocity } from '../../core/conveyor/conveyorSurface'
import { FLOOR_SURFACE_Y } from '../../core/types'
import type { BoxPick, PilotHandlers } from '../api'
import { PILOT_EYE_HEIGHT } from './pilot'
import type { PilotColliders, PilotSpawn } from './pilot'
import type { ViewXR } from './xr'
import { ensureColliderBVH } from '../bvh'
import type { RenderView } from './view'

/**
 * Walk mode's own state on the view (`view.walk`): collab peers' avatars, the walk's handlers and the
 * VR hand-back target, and the crosshair cache + broadphase scratch.
 */
export class ViewWalkState {
  // collab presence: peer pilot avatars (capsules). A standalone group on layer 0, outside
  // partsGroup, so it renders in the main pass but is never raycast/selected/serialized.
  readonly presenceGroup = new Group()
  readonly pilotAvatarGeo = new CapsuleGeometry(0.32, 1.0, 4, 12)
  readonly pilotAvatars = new Map<number, Mesh>()
  pilotHandlers: PilotHandlers | null = null
  /** the editor's orbit target when VR began; handed back with the camera when the VR walk ends */
  vrTarget: Vector3 | null = null
  /** would Use do something on the aimed thing (setPilotAimLive)? The VR laser's colour */
  pilotAimLive = false
  // scratch for the pilot broadphase's per-mesh world-sphere cull (pilotMeshNearFeet)
  readonly pilotSphereTmp = new Sphere()
  // pilot crosshair cache: the per-frame prompt refresh reads the same center-screen ray up
  // to three times (cargo → dock leaf → usable part), and an interact click re-reads it;
  // one reach-capped raycast per rendered frame serves them all (pilotCrosshairHits)
  pilotAimHits: Intersection[] = []
  pilotAimTick = -1

  /** free the peer avatars and their shared capsule */
  dispose(): void {
    for (const mesh of this.pilotAvatars.values()) (mesh.material as Material).dispose()
    this.pilotAvatars.clear()
    this.pilotAvatarGeo.dispose()
  }
}

/** what walk mode reaches on the view beyond its own {@link ViewWalkState} */
export type WalkHost = Pick<
  RenderView,
  | 'applyProjection'
  | 'boundsOf'
  | 'boxes'
  | 'camTmp'
  | 'camera'
  | 'controls'
  | 'entries'
  | 'freelook'
  | 'hidden'
  | 'nav'
  | 'orbitGizmo'
  | 'partsGroup'
  | 'pilot'
  | 'raycastParts'
  | 'raycaster'
  | 'renderer'
  | 'running'
  | 'setPointerRay'
  | 'simHasFrame'
  | 'stopFollow'
  | 'tickSerial'
  | 'walk'
  | 'xr'
>

/** pilot mode: how far in front of the camera carried cargo is held */
export const PILOT_HOLD_DISTANCE = 2.2
/** pilot mode: max camera distance at which crosshair cargo can be picked up */
const PILOT_REACH = 3.0
/** pilot broadphase: horizontal/upward envelope around the feet (m) - covers the wall-ray fan,
 *  step probes, ground ring and a frame of walk+carry travel, with margin */
const PILOT_NEAR = 3.0
/** pilot broadphase: how far below the feet ground candidates matter (probeGround ray.far + margin) */
const PILOT_GROUND_DEPTH = 61

/**
 * Broadphase for the pilot's per-frame ray fan (9 ground probes + wall/step
 * rays): flat lists of the individual meshes within reach of the feet, so
 * walking cost is O(nearby geometry) however large the scene. Culling is
 * two-level - the part's cached AABB, then each mesh's own world bounding
 * sphere - because a building's AABB contains the pilot everywhere indoors,
 * yet its far walls and dock assemblies must not be tested on every ray
 * (measured ~2 M candidate triangles per ray without the per-mesh cull).
 * Hidden subtrees are pruned the way the renderer draws them (the dock door's
 * invisible Use-target clone can't be a phantom wall), with two exceptions.
 * Sources a merge pass hid behind a raycast-inert merged copy (instance-pool
 * `poolHidden`, staticFold `staticFoldSource`) are on screen via the copy, so
 * they still block the pilot; and a rig link authored `hidden` (`collisionSolid`)
 * is render-only-off (the sim still builds its body), so it stays solid here
 * too. A platform railing is the case that matters: its barrier is that hidden
 * wall, and pruning it would let the pilot walk between the decorative rails and
 * off the deck. Walls keep the render meshes - a conveyor's side
 * guards are what block the pilot - while ground substitutes a part's flat
 * collision-proxy deck (raycastSurfaces parity), skipping three's
 * per-instance InstancedMesh raycast across every rendered roller. Cargo
 * contributes to neither: its idle visual is an instancing stub, its proxy a
 * stale authored pose, and live cargo interacts with the pilot through the
 * sim-side capsule instead.
 */
export function pilotCollidersNear(view: WalkHost, x: number, y: number, z: number): PilotColliders {
  const walls: Object3D[] = []
  const ground: Object3D[] = []
  for (const [id, entry] of view.entries) {
    if (view.hidden.has(id) || isCargoPart(entry.part)) continue
    const bbox = view.boundsOf(entry)
    if (
      !bbox.isEmpty() && // no bounds yet (async geometry loading) = stay a candidate
      (bbox.min.x > x + PILOT_NEAR || bbox.max.x < x - PILOT_NEAR ||
        bbox.min.z > z + PILOT_NEAR || bbox.max.z < z - PILOT_NEAR ||
        bbox.min.y > y + PILOT_NEAR || bbox.max.y < y - PILOT_GROUND_DEPTH)
    ) continue
    const wallStart = walls.length
    pilotCollectMeshes(view, entry.visual.object, x, y, z, true, walls)
    if (entry.proxy) pilotCollectMeshes(view, entry.proxy, x, y, z, false, ground)
    else for (let i = wallStart; i < walls.length; i++) ground.push(walls[i]!)
  }
  return { walls, ground }
}

/**
 * Collect the meshes under `root` the pilot rays should test (see
 * pilotCollidersNear for the visibility rules). Merged copies themselves
 * (instance pool / staticFold) are skipped - they're raycast-inert anyway.
 * `pruneHidden` is false for collision proxies: they live off-scene and are
 * collider geometry by construction.
 */
export function pilotCollectMeshes(view: WalkHost, node: Object3D, x: number, y: number, z: number, pruneHidden: boolean, out: Object3D[]): void {
  const ud = node.userData
  if (
    pruneHidden && !node.visible &&
    ud.poolHidden !== true && ud.staticFoldSource !== true &&
    // hidden-but-bodied rig link (railing wall, fence barrier, gate leaf): render-only-off, still solid
    ud.collisionSolid !== true
  ) return
  const mesh = node as Mesh
  if (mesh.isMesh && ud.instancePool !== true && ud.staticFold !== true && pilotMeshNearFeet(view, mesh, x, y, z)) {
    // generated geometry (a part's geometry()) has no tree until something collides with it
    ensureColliderBVH(mesh)
    out.push(mesh)
  }
  const children = node.children
  for (let i = 0; i < children.length; i++) pilotCollectMeshes(view, children[i]!, x, y, z, pruneHidden, out)
}

/** true when `mesh`'s world bounding sphere overlaps the pilot broadphase envelope around the feet */
export function pilotMeshNearFeet(view: WalkHost, mesh: Mesh, x: number, y: number, z: number): boolean {
  // an InstancedMesh's own boundingSphere spans its instances; a plain mesh uses its
  // geometry's. Both are cached - computed at most once here, as three's raycast does.
  let sphere: Sphere | null
  const inst = mesh as InstancedMesh
  if (inst.isInstancedMesh === true) {
    if (inst.boundingSphere === null) inst.computeBoundingSphere()
    sphere = inst.boundingSphere
  } else {
    const geo = mesh.geometry
    if (geo.boundingSphere === null) geo.computeBoundingSphere()
    sphere = geo.boundingSphere
  }
  if (sphere === null || !(sphere.radius >= 0)) return true // no usable bounds: stay a candidate
  const s = view.walk.pilotSphereTmp.copy(sphere).applyMatrix4(mesh.matrixWorld)
  const r = s.radius
  const c = s.center
  return !(
    c.x - r > x + PILOT_NEAR || c.x + r < x - PILOT_NEAR ||
    c.z - r > z + PILOT_NEAR || c.z + r < z - PILOT_NEAR ||
    c.y - r > y + PILOT_NEAR || c.y + r < y - PILOT_GROUND_DEPTH
  )
}

export function setPilotActive(view: WalkHost, active: boolean, handlers?: PilotHandlers): void {
  // the orbit gizmo is meaningless while walking (no orbit target) and its top-right corner
  // collides with the mobile Exit button - hide it for the duration of pilot mode
  view.orbitGizmo.setVisible(!active)
  if (active) {
    view.applyProjection('perspective', false) // walking is first-person perspective
    view.walk.pilotHandlers = handlers ?? null
    view.nav.focusAnim = null
    view.stopFollow() // walking owns the camera; drop follow mode
    view.freelook.setSuspended(true)
    view.controls.enabled = false
    // touch devices have no pointer lock / mouse-look: drive the walk from the on-screen
    // joystick + look pad instead (the editor renders them while piloting)
    const coarse =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
    view.pilot.setTouchMode(coarse)
    if (view.xr?.presenting) {
      view.pilot.setHeadset(view.xr.rig)
      view.pilot.enter(headsetSpawn(view))
    } else {
      view.pilot.enter(computePilotSpawn(view))
    }
  } else {
    // VR is walk mode in a headset: ending the walk (the page's Pilot button, Esc) ends the session.
    // Read the borrowed target first: a session may end synchronously inside exit() (IWER does), and
    // its end handler clears vrTarget before the line below would see it
    const vrTarget = view.walk.vrTarget
    view.xr?.exit()
    view.pilot.exit(false)
    view.freelook.setSuspended(false)
    view.controls.enabled = true
    if (vrTarget) {
      // a VR walk hands the camera back to the editor pose it borrowed (xr.ts restores it), so the
      // orbit target it circled goes back too
      view.controls.target.copy(vrTarget)
    } else {
      // re-anchor the orbit target ahead of where the walk left the camera
      const fwd = view.camera.getWorldDirection(view.camTmp)
      view.controls.target.copy(view.camera.position).addScaledVector(fwd, 5)
    }
    view.walk.pilotHandlers = null
  }
}

/**
 * The walk's start in a headset: on the floor under the editor camera, facing its heading. Not an
 * eye-height below the camera like the desktop spawn: from an orbit view that is a fall of metres,
 * and a fall the body doesn't feel quickly makes someone in a headset sick.
 */
export function headsetSpawn(view: WalkHost): PilotSpawn {
  const pose = view.xr?.editorPose
  if (!pose) return computePilotSpawn(view)
  const fwd = view.camTmp.set(0, 0, -1).applyQuaternion(pose.quaternion)
  const yaw = Math.hypot(fwd.x, fwd.z) > 1e-3 ? Math.atan2(-fwd.x, -fwd.z) : 0
  return { position: [pose.position.x, FLOOR_SURFACE_Y, pose.position.z], yaw, pitch: 0 }
}

/**
 * Reconcile the in-world peer pilot avatars (collab presence). Each peer walking the scene in
 * pilot mode gets a colored capsule at their feet position, facing their heading. The capsules
 * live in `presenceGroup` (layer 0, outside `partsGroup`) so they render in the main pass and
 * are occluded by real geometry, yet are never raycast, selected, or serialized. The name tag
 * stays a DOM billboard (PresenceOverlay) for crisp, depth-independent legibility.
 */
export function setPilotAvatars(view: WalkHost, avatars: ReadonlyArray<{ id: number; color: string; position: [number, number, number]; yaw: number }>): void {
  const seen = new Set<number>()
  for (const a of avatars) {
    seen.add(a.id)
    let mesh = view.walk.pilotAvatars.get(a.id)
    if (!mesh) {
      const color = new Color(a.color)
      const mat = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.28, roughness: 0.5, metalness: 0 })
      mesh = new Mesh(view.walk.pilotAvatarGeo, mat)
      view.walk.presenceGroup.add(mesh)
      view.walk.pilotAvatars.set(a.id, mesh)
    }
    // capsule centre sits half the cylinder + a cap-radius above the feet (total height ~1.64 m)
    mesh.position.set(a.position[0], a.position[1] + 0.82, a.position[2])
    mesh.rotation.y = a.yaw
  }
  for (const [id, mesh] of view.walk.pilotAvatars) {
    if (seen.has(id)) continue
    view.walk.presenceGroup.remove(mesh)
    ;(mesh.material as Material).dispose()
    view.walk.pilotAvatars.delete(id)
  }
}

/**
 * Hits along the pilot's center-screen (crosshair) ray, nearest-first, computed
 * at most once per rendered frame with `far` capped at PILOT_REACH - the prompt
 * refresh and an interact click share one cast. An uncapped cast (far = ∞) per
 * caller would narrow-phase every part down an aisle, every frame, only to
 * discard everything past 3 m.
 */
export function pilotCrosshairHits(view: WalkHost): Intersection[] {
  if (view.walk.pilotAimTick === view.tickSerial) return view.walk.pilotAimHits
  view.walk.pilotAimTick = view.tickSerial
  aimPilotRay(view)
  view.raycaster.far = PILOT_REACH
  view.walk.pilotAimHits = view.raycaster.intersectObjects(view.raycastParts(PILOT_REACH), true)
  view.raycaster.far = Infinity
  return view.walk.pilotAimHits
}

/** aim `view.raycaster` down the walk's Use ray: the screen-centre crosshair, or in VR the pointing controller */
export function aimPilotRay(view: WalkHost): void {
  if (view.xr?.presenting) {
    view.xr.aimRay(view.raycaster.ray)
    return
  }
  const rect = view.renderer.domElement.getBoundingClientRect()
  view.setPointerRay(rect.left + rect.width / 2, rect.top + rect.height / 2)
}

export function pilotLookBox(view: WalkHost): BoxPick | null {
  aimPilotRay(view)
  // reach from where the ray starts (the eye, or in VR the hand), not the camera's local position
  const o = view.camTmp.copy(view.raycaster.ray.origin)
  // reach-capped so the cargo batch's narrow phase drops far hits early
  view.raycaster.far = PILOT_REACH
  const pick = view.boxes.pick(view.raycaster)
  view.raycaster.far = Infinity
  if (!pick) return null
  const dx = pick.position[0] - o.x
  const dy = pick.position[1] - o.y
  const dz = pick.position[2] - o.z
  return dx * dx + dy * dy + dz * dz <= PILOT_REACH * PILOT_REACH ? pick : null
}

/**
 * One VR frame of the walk: the controllers drive the pilot (xrInput.ts has the map), which places
 * the rig, and the laser is drawn out to whatever the Use ray hits within reach.
 */
export function tickHeadsetWalk(view: WalkHost, xr: ViewXR, dt: number): void {
  const intent = xr.pollInput()
  view.pilot.setMoveAxis(intent.forward, intent.strafe)
  if (intent.turn !== 0) view.pilot.turn(intent.turn)
  if (intent.use) {
    // the press may have moved the aim to the other hand: re-cast from that laser, not this
    // frame's cached cast (the prompt refresh ran before the input was read)
    view.walk.pilotAimTick = -1
    view.pilot.interact()
  }
  view.pilot.update(dt)
  const hit = pilotCrosshairHits(view)[0]
  xr.setLaser(hit ? hit.distance : PILOT_REACH, view.walk.pilotAimLive)
}

/**
 * Surface velocity the part under the pilot's feet imparts at (x, z) - the
 * conveyor moving-platform carry, gated on the sim actually running so a
 * stopped scene's conveyors don't drag the pilot.
 */
export function pilotSurfaceVelocity(view: WalkHost, object: Object3D, x: number, z: number): { vx: number; vz: number } | null {
  if (!view.running || !view.simHasFrame) return null
  let obj: Object3D | null = object
  while (obj && obj !== view.partsGroup) {
    const id = obj.userData.partId
    if (typeof id === 'string') {
      const part = view.entries.get(id)?.part
      return part ? conveyorSurfaceVelocity(part, x, z) : null
    }
    obj = obj.parent
  }
  return null
}

/**
 * Placed part ids under the pilot crosshair within reach, nearest-first - the
 * interact candidates (a 3 m interact ray). Like
 * pickPart, hidden parts fall through; the caller picks the first that has a
 * use action, so non-interactable geometry doesn't block the one behind it.
 */
export function pilotLookParts(view: WalkHost): string[] {
  const hits = pilotCrosshairHits(view)
  const ids: string[] = []
  for (const hit of hits) {
    if (hit.distance > PILOT_REACH) break // sorted nearest-first: nothing else is in reach
    let obj: Object3D | null = hit.object
    while (obj && obj !== view.partsGroup) {
      const id = obj.userData.partId
      if (typeof id === 'string') {
        if (view.hidden.has(id)) break
        if (!ids.includes(id)) ids.push(id)
        break
      }
      obj = obj.parent
    }
  }
  return ids
}

/**
 * The dock-door leaf under the pilot crosshair (its owning building id + leaf
 * key), or null. Each leaf's door panel is tagged `userData.dockLeaf`; aiming
 * at one panel toggles only that leaf. Only the
 * nearest in-reach part surface counts - a door behind a wall isn't reachable,
 * and aiming at the surround (no dockLeaf) returns null so generic Use runs.
 */
export function pilotLookDockLeaf(view: WalkHost): { partId: string; leafKey: string } | null {
  const hits = pilotCrosshairHits(view)
  for (const hit of hits) {
    if (hit.distance > PILOT_REACH) return null // nothing else is in reach
    let obj: Object3D | null = hit.object
    let leafKey: string | undefined
    while (obj && obj !== view.partsGroup) {
      if (leafKey === undefined && typeof obj.userData.dockLeaf === 'string') leafKey = obj.userData.dockLeaf
      const id = obj.userData.partId
      if (typeof id === 'string') {
        if (view.hidden.has(id)) break // this part is hidden - try the next hit
        return leafKey !== undefined ? { partId: id, leafKey } : null
      }
      obj = obj.parent
    }
  }
  return null
}

/**
 * Spawn at the current fly/editor camera position: the feet
 * sit an eye-height below the camera so the view doesn't pop on entry, then
 * gravity drops the character onto whatever floor is beneath it.
 */
export function computePilotSpawn(view: WalkHost): PilotSpawn {
  const cam = view.camera.position
  const fwd = view.camera.getWorldDirection(view.camTmp)
  // carry the editor camera's heading + pitch so the look angle matches on entry (same basis as Freelook)
  const yaw = Math.atan2(-fwd.x, -fwd.z)
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)))
  return { position: [cam.x, cam.y - PILOT_EYE_HEIGHT, cam.z], yaw, pitch }
}
