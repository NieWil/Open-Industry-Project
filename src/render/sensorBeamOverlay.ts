import { Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three'
import type { Object3D, Scene } from 'three'
import { OVERLAY_LAYER } from './env'
import { retireInstancedMeshOnly } from './gpuRetire'
import { bucketCapacity } from './parts/instanceCapacity'
import { BEAM_GREEN, BEAM_RADIUS, beamGeo } from './parts/sensor'

/**
 * Scene-level renderer for every sensor's beam line (the green/red light-barrier cylinder declared
 * by a `beam` rig link, parts/sdk/rigBeams.ts), drawn as one instanced draw from the overlay pass.
 *
 * Why the beams can't live in their rig group: a beam is `depthWrite: false` (it must not occlude the
 * cargo it stops at), so it must be drawn after what it appears in front of. In the rig it would sit
 * in `partsGroup`, a render-bundle root under WebGPU, and bundles execute at the end of the main
 * pass, so the bundled conveyor hardware draws over it and only green stubs in the guards' discard
 * holes show (WebGL and `?nobundle` are fine). Same failure and fix as the flow arrows (flowArrowBank.ts).
 *
 * The beams keep `depthTest: true`: the overlay pass runs over the full depth buffer
 * (consolidatedOutlineNode.renderLayeredScene), so solid guard metal still hides them and the discard hole still shows them. depthTest-off
 * would float every beam over its own guard.
 *
 * Why instanced: outside the bundles the beams are encoded fresh every frame. Per-beam meshes cost a draw +
 * pipeline each, and every show/hide changes the overlay projection-cache signature
 * (consolidatedOutlineNode.overlayVisSig). One InstancedMesh with the tint on `instanceColor` is one draw
 * at any sensor count. It is not a bundle: instances re-aim every probe, so it would re-record continuously.
 *
 * Ownership: rig.ts's probeTick writes each beam's world aim + tint every probe (a beam inherits
 * nothing from its part), and view.tick calls {@link syncSensorBeams} once a frame to
 * resolve visibility and rewrite the instance buffers.
 */

/** shared beam material - one pipeline for every beam; the per-beam tint rides `instanceColor` */
const beamMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false })

/** the container the view parents into the scene and lists in collectOverlays */
export const sensorBeamGroup = new Group()
sensorBeamGroup.matrixAutoUpdate = false // identity, never moves - the instances carry world poses

const _z = new Vector3(0, 0, 1) // beamGeo runs along +Z
const _p = new Vector3()
const _q = new Quaternion()
const _scale = new Vector3()
const _m = new Matrix4()

/**
 * One sensor's beam. probeTick owns {@link aim}/{@link tint}/{@link setShow}; whether it actually
 * draws is resolved once a frame by {@link syncSensorBeams} (show and the part still visible).
 */
export class SensorBeam {
  /** the part root this beam belongs to - its live visibility gates the beam every frame */
  readonly root: Object3D
  /** probeTick's "wants to draw" (its `beam.showParam`); false until the first probe */
  show = false
  /** resolved by syncSensorBeams: `show` and the part is drawn (visible, in the scene) */
  visible = false
  readonly position = new Vector3()
  readonly quaternion = new Quaternion()
  length = 0
  readonly color = new Color().copy(BEAM_GREEN)

  constructor(root: Object3D) {
    this.root = root
  }

  /** probeTick: a beam of `length` m emitted from world `origin` along unit `dir` */
  aim(origin: Vector3, dir: Vector3, length: number): void {
    _q.setFromUnitVectors(_z, dir)
    _p.copy(dir).multiplyScalar(length / 2).add(origin)
    if (this.length === length && this.position.equals(_p) && this.quaternion.equals(_q)) return
    this.position.copy(_p)
    this.quaternion.copy(_q)
    this.length = length
    if (this.visible) dirty = true
  }

  /** probeTick: the live tint (green clear / red or the detected cargo colour when blocked).
   *  Returns whether it changed, so a steady beam doesn't mark its part dirty every probe. */
  tint(color: Color): boolean {
    if (this.color.equals(color)) return false
    this.color.copy(color)
    if (this.visible) dirty = true
    return true
  }

  /** probeTick: whether this beam wants to draw at all (its `beam.showParam`). syncSensorBeams, which runs
   *  every frame, combines it with the part's live visibility and sets the dirty mark. */
  setShow(show: boolean): void {
    this.show = show
  }
}

const beams = new Set<SensorBeam>()
let dirty = false
let visibleCount = 0

function mintMesh(capacity: number): InstancedMesh {
  const mesh = new InstancedMesh(beamGeo, beamMaterial, capacity)
  mesh.count = 0
  mesh.visible = false // empty-bank invariant: a count-0 bank must be invisible, not a no-op draw
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.raycast = () => {} // a visual overlay, never a pick/rest target
  mesh.renderOrder = 10
  mesh.matrixAutoUpdate = false // identity; the instances carry world poses
  // frustumCulled=false keeps the overlay pass's cached projection (subPassCache) camera-
  // independent, matching the gizmo/handles/flow-arrow overlay meshes
  mesh.frustumCulled = false
  mesh.layers.enable(OVERLAY_LAYER)
  mesh.userData.sensorBeam = true // E2E/debug handle: the beams are not under their part
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  // Pre-allocate instanceColor at capacity: three compiles the per-instance colour path into the
  // node graph only if the attribute exists at first compile, so a bank compiled empty would bake
  // without tint support and draw every later beam white (the same bug as SimBoxes, boxes.ts).
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3)
  mesh.instanceColor.setUsage(DynamicDrawUsage)
  return mesh
}

let mesh = mintMesh(bucketCapacity(8))
sensorBeamGroup.add(mesh)

/** grow-only bucketed capacity; re-mints the bank when it outgrows its buffers (geometry and
 *  material are module-shared, so the re-mint costs one WebGPU pipeline compile at that edit) */
function ensureCapacity(needed: number): void {
  if (needed <= mesh.instanceMatrix.count) return
  let cap = mesh.instanceMatrix.count
  while (cap < needed) cap *= 2
  const next = mintMesh(cap)
  sensorBeamGroup.remove(mesh)
  retireInstancedMeshOnly(mesh) // instance buffers only (geometry is module-shared); deferred, gpuRetire.ts
  sensorBeamGroup.add(next)
  mesh = next
}

/** adopt a beam (rig build); it stays until the part is disposed */
export function addSensorBeam(root: Object3D): SensorBeam {
  const beam = new SensorBeam(root)
  beams.add(beam)
  return beam
}

/** release a beam (rig dispose). Repacks immediately rather than waiting for the next frame's
 *  sync: a render can run outside view.tick (resize, on-demand redraw), and a disposed part's beam
 *  must vanish with it. */
export function removeSensorBeam(beam: SensorBeam): void {
  if (!beams.delete(beam) || !beam.visible) return
  dirty = true
  flush()
}

/**
 * Resolve every beam's visibility from its part and rewrite the instance buffers, once per frame
 * (view.tick).
 *
 * A beam is not a descendant of its part, so hiding the part doesn't hide it. probeTick can't own this:
 * probes are gated to seams, but parts hide and re-show outside them (WebGPU's staged compile), so a
 * probe inside that window would hide beams for good. probeTick decides only whether a beam wants to
 * draw (`setShow`); this pass ANDs that with the part's live visibility. The buffer rewrite runs only
 * on frames something moved/retinted/(un)hid.
 */
export function syncSensorBeams(): void {
  for (const beam of beams) {
    const visible = beam.show && drawnInScene(beam.root)
    if (visible === beam.visible) continue
    beam.visible = visible
    dirty = true
  }
  flush()
}

/** whether `root` would draw: it and every ancestor visible, under a Scene. A part a definition session
 *  holds (New Part, Catalog ✎) is detached from the scene but not disposed, so its root stays `visible`
 *  and only the missing Scene ancestor says it is gone (viewSync.ts `holdDeparted`). */
function drawnInScene(root: Object3D): boolean {
  let o: Object3D | null = root
  for (;;) {
    if (!o.visible) return false
    if (o.parent === null) return (o as Partial<Scene>).isScene === true
    o = o.parent
  }
}

/** rewrite the instance buffers from the visible beams; no-op when nothing changed */
function flush(): void {
  if (!dirty) return
  dirty = false
  let n = 0
  for (const beam of beams) if (beam.visible) n++
  ensureCapacity(n)
  let i = 0
  for (const beam of beams) {
    if (!beam.visible) continue
    _scale.set(BEAM_RADIUS, BEAM_RADIUS, Math.max(beam.length, 1e-4))
    mesh.setMatrixAt(i, _m.compose(beam.position, beam.quaternion, _scale))
    mesh.setColorAt(i, beam.color)
    i++
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.visible = n > 0 // empty-bank invariant (see mintMesh)
  visibleCount = n
}

/**
 * Whether any beam currently draws - the collectOverlays membership gate, so a scene with no
 * sensors (or every beam hidden by its `showParam`/a hidden part) costs no extra sub-pass. Beams start
 * hidden and are shown by the first probe, so a rig built for a catalog thumbnail (never probed)
 * never opens the gate. Read after syncSensorBeams() each frame.
 */
export function hasVisibleSensorBeam(): boolean {
  return visibleCount > 0
}

/** e2e / debugging introspection: every beam's live state, drawn ones first-class */
export function sensorBeamDebug(): { count: number; depthTest: boolean; beams: { visible: boolean; length: number; origin: [number, number, number]; end: [number, number, number]; color: [number, number, number] }[] } {
  const out = []
  for (const beam of beams) {
    _p.copy(_z).applyQuaternion(beam.quaternion) // unit beam direction
    const origin = new Vector3().copy(_p).multiplyScalar(-beam.length / 2).add(beam.position)
    const end = new Vector3().copy(_p).multiplyScalar(beam.length / 2).add(beam.position)
    out.push({
      visible: beam.visible,
      length: beam.length,
      origin: [origin.x, origin.y, origin.z] as [number, number, number],
      end: [end.x, end.y, end.z] as [number, number, number],
      color: [beam.color.r, beam.color.g, beam.color.b] as [number, number, number],
    })
  }
  return { count: visibleCount, depthTest: beamMaterial.depthTest, beams: out }
}
