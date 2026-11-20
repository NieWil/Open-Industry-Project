import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { PerspectiveCamera, Ray, Raycaster } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { GizmoConstraint, GizmoHandle, GizmoSnap, GizmoState } from '../api'
import { worldPerPixel } from './editorCamera'
import { webgpuNodeFactory } from '../renderMode'

// WebGPU TSL port of the half-ring discard (gizmoRingNodeMaterial.ts), injected by
// createRenderer once three/webgpu is loaded. null on the WebGL path (where halfRing's
// onBeforeCompile runs instead); WebGPU ignores that GLSL, so without this the rotation
// rings draw as full circles instead of the camera-facing-half look.
let ringNodeFactory: ((colorHex: number, opacity: number, axis: Vector3) => MeshBasicMaterial) | null = null
export function setGizmoRingNodeFactory(factory: ((colorHex: number, opacity: number, axis: Vector3) => MeshBasicMaterial) | null): void {
  ringNodeFactory = factory
}

// an axis name's slot in a GizmoState.lockMove triple
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const
const AXIS_COLORS: Record<'x' | 'y' | 'z', number> = {
  x: 0xe06666,
  y: 0x66bb6a,
  z: 0x5599e0,
}
const RING_COLOR = 0x66bb6a
const GIZMO_PX = 95
const WHITE = new Color(0xffffff)

/**
 * Why every handle material sets `forceSinglePass`.
 *
 * three splits a `transparent` + `DoubleSide` material into two draws (back faces, then front
 * faces), so the ten meshes a transform gizmo shows would take twenty draws every frame (both
 * backends do it: WebGLRenderer.renderBufferDirect and the WebGPU renderer's renderObject). The split
 * exists so the far side of a see-through solid composites under the near side in the right order.
 * These handles are single-colour and depth-test-off, and `c over c` is the same colour either way
 * round, so the ordering makes no difference here.
 *
 * `forceSinglePass` drops the second draw, not the second fragment: DoubleSide still rasterizes
 * both faces, just in one pass and in index order. Same fragments, same blend, same pixels, so no
 * opacity compensation belongs here (one would make the handles visibly heavier: 0.4% of the
 * frame's pixels move). Measured on the demo: a selected conveyor's gizmo goes from 20 to 7 overlay draws
 * with this and the arrow merge below, pixel-identical.
 */

// the move arrows use a long shaft + cone that reach past the rotation rings
const moveShaftGeo = new CylinderGeometry(0.015, 0.015, 0.92, 10).translate(0, 0.56, 0)
const moveConeGeo = new ConeGeometry(0.06, 0.22, 16).translate(0, 1.13, 0)
// One arrow = one draw. Shaft and tip share a material and a frame, so merged at module scope they
// are the same triangles in one buffer instead of two meshes and two draws.
// (mergeGeometries needs matching attribute sets - cylinder/cone/box all carry position+normal+uv.)
const moveArrowGeo = mergeGeometries([moveShaftGeo, moveConeGeo])!
const moveArrowProxyGeo = new CylinderGeometry(0.1, 0.1, 1.2, 8).translate(0, 0.64, 0)
// plane pads: a translucent square offset into one quadrant of each axis pair,
// coloured by the third (normal) axis. xz is the horizontal ground pad. Each
// constrains a translate to its plane (move-gizmo plane handles). The geometries
// bake the +/+ quadrant; updatePadQuadrants moves each pad to the quadrant facing
// the camera by translating its group (see PAD_OFFSET).
const PAD_OFFSET = 0.42
const padXZGeo = new PlaneGeometry(0.28, 0.28).rotateX(-Math.PI / 2).translate(PAD_OFFSET, 0, PAD_OFFSET)
const padXYGeo = new PlaneGeometry(0.28, 0.28).translate(PAD_OFFSET, PAD_OFFSET, 0)
const padYZGeo = new PlaneGeometry(0.28, 0.28).rotateY(Math.PI / 2).translate(0, PAD_OFFSET, PAD_OFFSET)
const padProxyXZGeo = new PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2).translate(PAD_OFFSET, 0, PAD_OFFSET)
const padProxyXYGeo = new PlaneGeometry(0.42, 0.42).translate(PAD_OFFSET, PAD_OFFSET, 0)
const padProxyYZGeo = new PlaneGeometry(0.42, 0.42).rotateY(Math.PI / 2).translate(0, PAD_OFFSET, PAD_OFFSET)
// a pad flips quadrant once the camera crosses the axis plane by this fraction of its
// distance (~1.1 deg). A hard sign test would flip back and forth every frame while an
// orbit grazes the plane; the band makes the crossing commit.
const PAD_FLIP_BAND = 0.02
// rotate ring-set: X (YZ plane) / Y (XZ) / Z (XY) axis rings + an outer
// view ring that rotates about the camera normal. All four are live handles.
const ringGeo = new TorusGeometry(1, 0.02, 8, 128).rotateX(Math.PI / 2)
const ringXGeo = new TorusGeometry(1, 0.02, 8, 128).rotateY(Math.PI / 2)
const ringZGeo = new TorusGeometry(1, 0.02, 8, 128)
const ringProxyGeo = new TorusGeometry(1, 0.12, 8, 32).rotateX(Math.PI / 2)
const ringProxyXGeo = new TorusGeometry(1, 0.12, 8, 32).rotateY(Math.PI / 2)
const ringProxyZGeo = new TorusGeometry(1, 0.12, 8, 32)
const viewRingGeo = new TorusGeometry(1.14, 0.018, 8, 128)
const viewRingProxyGeo = new TorusGeometry(1.14, 0.1, 8, 32)
// interior sphere = the trackball region: the whole ring interior up to the
// rings' inner edge (distance < circle size minus ring half-width). The ring pick
// proxy is a tube of half-width 0.12 around radius 1, so its inner edge sits at
// 0.88; the sphere reaches just past it (rings are picked first, so the overlap
// resolves to the ring - this only closes the dead annulus between sphere and ring).
// Invisible at rest (drawn at alpha 0); a faint ball appears only on
// hover/grab (swapped to a highlight material).
const trackballProxyGeo = new SphereGeometry(0.9, 16, 12)
const trackballVisualGeo = new SphereGeometry(0.88, 24, 16)

const SECTOR_MAX_SEGS = 128
const SECTOR_SEG_ANGLE = 0.05
const CIRCLE_SEGS = 64
// radians of free trackball rotation per pixel of pointer drag
const TRACKBALL_SENSITIVITY = 0.005
// a translate drag travels at most this many camera-to-gizmo distances: near the horizon a pixel of cursor is
// hundreds of metres of plane
const MAX_TRAVEL_PER_CAMERA_DISTANCE = 20
// a ring whose axis lies within ~5° of the camera-facing plane (cos 85°) is
// edge-on -> switch from angular to a linear drag (the angular reading would jump)
const ORTHO_THRESHOLD = Math.cos((85 * Math.PI) / 180)
// a ring tilted less than ~75° from face-on (|axis·view| >= cos 75.5°) reads the cursor where it meets the ring's own
// plane, so the swept wedge, the cursor and the part agree. Read on a camera-facing plane instead, a tilted ring's
// squashed ellipse made the wedge lag the cursor across one quarter and leap up to ~40° per step across the next. Closer
// to edge-on the ring-plane hit runs off toward the horizon, so those rings keep the camera-facing reading.
const RING_PLANE_MIN = 0.25
const RING_RADIUS = 1 // axis-ring radius in gizmo-local units (the TorusGeometry radius)
// matches halfRing's shader discard (vFaceOn >= 0.92 draws the ring full): a ring
// this close to face-on shows as a full circle, so its whole proxy stays pickable.
const RING_FACE_ON = 0.92
const VIEW_RING_RADIUS = 1.14 // outer view ring scale (default 1.14)

const tmpW = new Vector3()
const tmpA = new Vector3()
const tmpB = new Vector3()
const tmpC = new Vector3()
const tmpD = new Vector3()
const tmpE = new Vector3()
const tmpQuat = new Quaternion()
const Y_UP = new Vector3(0, 1, 0)
const X_AXIS = new Vector3(1, 0, 0)
// default camera normal for the unit tests' top-down rays (view.ts passes the real one)
const DEFAULT_CAM_NORMAL = new Vector3(0, -1, 0)
// scratch for the view ring's per-frame facing (updateScale)
const _faceM = new Matrix4()
const _faceQ = new Quaternion()

/** Per-ring root-local rotation axis; the in-plane drag frame is derived per drag. */
const RING_AXIS: Record<'rotX' | 'rotY' | 'rotZ', Vector3> = {
  rotX: new Vector3(1, 0, 0),
  rotY: new Vector3(0, 1, 0),
  rotZ: new Vector3(0, 0, 1),
}

/** the angle from->to measured around axis (signed). */
function signedAngle(from: Vector3, to: Vector3, axis: Vector3): number {
  const cross = tmpE.crossVectors(from, to)
  const unsigned = Math.atan2(cross.length(), from.dot(to))
  return cross.dot(axis) < 0 ? -unsigned : unsigned
}

/**
 * Camera right/up world axes from its forward direction, assuming no roll (the
 * orbit/freelook camera keeps world up). These span the screen plane and seed the
 * trackball's rotation axis (the camera basis right/up columns).
 * Falls back to world X when looking straight up/down (cross degenerates).
 */
function cameraRightUp(camNormal: Vector3): { right: Vector3; up: Vector3 } {
  const f = tmpA.copy(camNormal).normalize()
  const right = new Vector3().crossVectors(f, Y_UP)
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
  right.normalize()
  const up = new Vector3().crossVectors(right, f).normalize()
  return { right, up }
}

/**
 * intersection of the ray origin+t*dir with the plane (normal, through point); null when parallel, and in perspective
 * when the plane lies behind the ray's origin: a cursor just above the horizon of a floor-plane drag hits the plane
 * behind the camera, which once put the part a kilometre back. An orthographic ray starts on the camera plane and has
 * no horizon, so a hit behind its origin is still the point under the cursor.
 */
function rayPlaneHit(origin: Vector3, dir: Vector3, normal: Vector3, point: Vector3, orthographic: boolean): Vector3 | null {
  const denom = normal.dot(dir)
  if (Math.abs(denom) < 1e-6) return null
  const t = normal.dot(tmpW.subVectors(point, origin)) / denom
  if (t <= 0 && !orthographic) return null
  return new Vector3().copy(dir).multiplyScalar(t).add(origin)
}

/**
 * normal of the plane that contains `axis` and faces the camera as squarely as
 * possible: axis x (axis x camNormal) (the per-axis translate plane). Falls
 * back to the camera plane when the axis points at the camera (motion invisible).
 */
function planeFacingCamera(axis: Vector3, camNormal: Vector3): Vector3 {
  tmpA.copy(axis).cross(camNormal)
  tmpB.copy(axis).cross(tmpA)
  const len = tmpB.length()
  return len < 1e-6 ? camNormal.clone() : tmpB.clone().multiplyScalar(1 / len)
}

/** snap v to the nearest multiple of step; pass through when step is null/zero */
function quantize(v: number, step: number | null): number {
  return step && step > 0 ? Math.round(v / step) * step : v
}

/** parameter t on the line origin+t*dir closest to the ray; null when parallel */
export function rayLineParam(origin: Vector3, dir: Vector3, ray: Ray): number | null {
  tmpW.subVectors(ray.origin, origin)
  const b = dir.dot(ray.direction)
  const denom = 1 - b * b
  if (denom < 1e-6) return null
  return (dir.dot(tmpW) - b * ray.direction.dot(tmpW)) / denom
}

/**
 * Draw only the camera-facing half of an axis ring (the X/Y/Z rotation rings show
 * as half rings; the view ring uses a different shader and stays full). Discards
 * fragments whose vertex sits behind the gizmo centre in view space (keeps the near
 * half), but only while the ring
 * is tilted: as its axis turns to face the camera (face-on, e.g. the yaw ring in top
 * view) the ring becomes a full circle. `axis` is the ring's plane normal
 * (= its rotation axis) in gizmo-local space; the shader derives the face-on factor
 * from it each frame via modelViewMatrix, so there's no per-frame CPU work. The full
 * pick proxy is untouched, so the unseen half stays grabbable (the hit test covers
 * the whole ring circle).
 */
function halfRing(material: MeshBasicMaterial, axis: Vector3): MeshBasicMaterial {
  // uFull (0/1) forces the whole ring to draw, skipping the away-half discard. Kept
  // on userData.ringFull so a lone ring (yaw-only mode) can show as a full circle -
  // the half look only helps when three rings overlap. Mutated live; three
  // reads uniform.value each frame, so toggling it needs no recompile.
  const ringFull = { value: 0 }
  material.userData.ringFull = ringFull
  material.customProgramCacheKey = () => 'oip-half-ring'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAxis = { value: axis }
    shader.uniforms.uFull = ringFull
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vRelZ;\nvarying float vFaceOn;\nuniform vec3 uAxis;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' +
          '\tvRelZ = (modelViewMatrix * vec4(transformed, 1.0)).z - modelViewMatrix[3].z;\n' +
          '\tvFaceOn = abs(normalize((modelViewMatrix * vec4(uAxis, 0.0)).xyz).z);',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRelZ;\nvarying float vFaceOn;\nuniform float uFull;')
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n\tif (uFull < 0.5 && vFaceOn < 0.92 && vRelZ < 0.0) discard;',
      )
  }
  return material
}

interface HandleStyle {
  material: MeshBasicMaterial
  color: Color
  opacity: number
}

type DragState =
  // unified translate: the constraint plane is
  // recomputed each frame from `plane`/`local`, so a keyboard X/Y/Z lock can
  // re-constrain the same drag without restarting it. `view` is the free
  // camera-facing plane (body drag); axes/planes mask the motion.
  | {
      kind: 'translate'
      center: Vector3
      clickOrigin: Vector3
      clickDir: Vector3
      camNormal: Vector3
      plane: GizmoConstraint | 'view'
      local: boolean
      last: [number, number, number]
    }
  // a rotation ring (X/Y/Z/view): rotate about axisWorld.
  // The drag angle is read where the cursor meets the ring's own plane (`planar`, prevRingVec), or on a
  // camera-facing plane for a ring near edge-on (prevVec), and accumulated via signed_angle about axisWorld; an
  // edge-on ring (axis ~in the view plane) switches to a linear drag. initialClickVec (on the ring's own plane)
  // anchors the feedback arc; cursorHit is the latest reading's intersection (the rotation line points at it).
  | {
      kind: 'ring'
      center: Vector3
      axisWorld: Vector3
      radius: number
      clickOrigin: Vector3
      clickDir: Vector3
      // kept so a keyboard X/Y/Z mid-drag can re-aim the ring (axis lock):
      // camNormal seeds the view axis + camera-facing reseed, grabQuat the local axis,
      // axisKey/local track the global -> local -> view cycle.
      camNormal: Vector3
      grabQuat: Quaternion
      axisKey: 'x' | 'y' | 'z' | 'view'
      local: boolean
      initialClickVec: Vector3
      prevVec: Vector3
      planar: boolean
      prevRingVec: Vector3
      accum: number
      rotation: number
      showLine: boolean
      cursorHit: Vector3 | null
    }
  // free trackball rotation: the pointer's pixel delta off the
  // grab point maps to a screen-space rotation axis (right/up span the screen).
  // Returns an absolute axis+angle from the start, so moveRotate applies it like a
  // ring drag. No fixed axis -> both axis and angle vary with the cursor.
  | { kind: 'trackball'; right: Vector3; up: Vector3; startX: number; startY: number }

export class TransformGizmo {
  readonly root = new Group()
  private readonly moveGroup = new Group()
  private readonly rotateGroup = new Group()
  private readonly moveProxies: Mesh[] = []
  // the three translate arrows (visual + pick proxy), by axis, so a GizmoState.lockMove can leave one out
  private readonly arrowGroups: { group: Group; axis: 0 | 1 | 2 }[] = []
  // the three translate plane pads (visual + pick proxy per plane), each parented to a
  // group updatePadQuadrants shifts into the camera-facing quadrant
  private readonly padGroups: { group: Group; axes: readonly ('x' | 'y' | 'z')[] }[] = []
  // which side of each gizmo-local axis the pads currently sit on; +1 = the baked
  // +/+ quadrant, so a gizmo that never sees a camera keeps the baked layout
  private readonly padSign: Record<'x' | 'y' | 'z', number> = { x: 1, y: 1, z: 1 }
  // axis rings (rotX/Y/Z) only; the outer view ring is picked separately after the
  // axis rings (tested first, then the view ring, then the trackball)
  private readonly rotateProxies: Mesh[] = []
  // ring visual meshes in the same order as ringDefs / rotateProxies: [Y, X, Z]
  private readonly rotateVisuals: Mesh[] = []
  private readonly viewRingProxies: Mesh[] = []
  private readonly trackballProxies: Mesh[] = []
  private readonly styles = new Map<GizmoHandle, HandleStyle>()
  private readonly proxyMaterial = new MeshBasicMaterial({ visible: false })
  private readonly viewRingGroup = new Group()
  // the trackball hover ball: hidden at rest, shown faintly while 'rotTrackball' is
  // highlighted (kept out of `styles` so applyHighlight only toggles its visibility).
  // the highlight alpha is near-invisible; kept low + single-sided (no
  // front/back double-blend) so it reads as a faint tint, not a milky fill.
  private readonly trackballMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.06,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private trackballVisual!: Mesh
  private readonly feedbackGroup = new Group()
  private readonly sectorGeo = new BufferGeometry()
  private readonly circleGeo = new BufferGeometry()
  private readonly edgeGeo = new BufferGeometry()
  private readonly sectorMaterial = new MeshBasicMaterial({
    color: RING_COLOR,
    transparent: true,
    opacity: 0.2,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  })
  private readonly tickMaterial = new LineBasicMaterial({
    color: RING_COLOR,
    transparent: true,
    opacity: 0.65,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly edgeMaterial = new LineBasicMaterial({
    color: RING_COLOR,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private state: GizmoState | null = null
  private drag: DragState | null = null
  // the camera projection the live drag started in (an orthographic ray may hit a plane behind its origin)
  private orthographic = false

  constructor() {
    this.root.visible = false
    this.root.add(this.moveGroup, this.rotateGroup)

    const axisRotation: Record<'x' | 'y' | 'z', [number, number, number]> = {
      x: [0, 0, -Math.PI / 2],
      y: [0, 0, 0],
      z: [Math.PI / 2, 0, 0],
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      const material = this.handleMaterial(axis, AXIS_COLORS[axis], 0.95)
      const arrow = new Group()
      arrow.rotation.set(...axisRotation[axis])
      arrow.add(this.visualMesh(moveArrowGeo, material))
      const proxy = new Mesh(moveArrowProxyGeo, this.proxyMaterial)
      proxy.userData.handle = axis
      arrow.add(proxy)
      this.moveGroup.add(arrow)
      this.moveProxies.push(proxy)
      this.arrowGroups.push({ group: arrow, axis: AXIS_INDEX[axis] })
    }

    const planeDefs = [
      { handle: 'xz' as const, color: AXIS_COLORS.y, geo: padXZGeo, proxy: padProxyXZGeo, axes: ['x', 'z'] as const },
      { handle: 'xy' as const, color: AXIS_COLORS.z, geo: padXYGeo, proxy: padProxyXYGeo, axes: ['x', 'y'] as const },
      { handle: 'yz' as const, color: AXIS_COLORS.x, geo: padYZGeo, proxy: padProxyYZGeo, axes: ['y', 'z'] as const },
    ]
    for (const p of planeDefs) {
      const padMaterial = this.handleMaterial(p.handle, p.color, 0.4)
      // visual + proxy share one group so the quadrant shift moves the handle and what
      // picks it together (they must never disagree about where the pad is)
      const padGroup = new Group()
      padGroup.add(this.visualMesh(p.geo, padMaterial))
      const padProxy = new Mesh(p.proxy, this.proxyMaterial)
      padProxy.userData.handle = p.handle
      padGroup.add(padProxy)
      this.moveGroup.add(padGroup)
      this.moveProxies.push(padProxy)
      this.padGroups.push({ group: padGroup, axes: p.axes })
    }

    const ringDefs = [
      { handle: 'rotY' as const, color: AXIS_COLORS.y, geo: ringGeo, proxy: ringProxyGeo },
      { handle: 'rotX' as const, color: AXIS_COLORS.x, geo: ringXGeo, proxy: ringProxyXGeo },
      { handle: 'rotZ' as const, color: AXIS_COLORS.z, geo: ringZGeo, proxy: ringProxyZGeo },
    ]
    for (const r of ringDefs) {
      // axis rings draw their camera-facing half only when tilted (half-ring look).
      // WebGPU can't run halfRing's onBeforeCompile GLSL, so it uses the TSL node material
      // (still registered in styles so hover/active colour swaps work the same).
      let mat: MeshBasicMaterial
      const ringFactory = webgpuNodeFactory(ringNodeFactory, 'gizmo ring')
      if (ringFactory) {
        // the node twin is transparent + DoubleSide too, so it takes the same single-pass
        // treatment as handleMaterial (which the WebGL branch below goes through)
        mat = ringFactory(r.color, 0.9, RING_AXIS[r.handle])
        mat.forceSinglePass = true
        this.styles.set(r.handle, { material: mat, color: new Color(r.color), opacity: 0.9 })
      } else {
        mat = halfRing(this.handleMaterial(r.handle, r.color, 0.9), RING_AXIS[r.handle])
      }
      const visual = this.visualMesh(r.geo, mat)
      this.rotateGroup.add(visual)
      this.rotateVisuals.push(visual)
      const proxy = new Mesh(r.proxy, this.proxyMaterial)
      proxy.userData.handle = r.handle
      // the ring's plane normal (gizmo-local) lets pick() reject hits on the
      // away half exactly where halfRing's shader discards them - so the unseen
      // half stops stealing the hover/grab (and hiding the interior trackball).
      proxy.userData.axis = RING_AXIS[r.handle]
      this.rotateGroup.add(proxy)
      this.rotateProxies.push(proxy)
    }

    const viewMaterial = this.handleMaterial('rotView', 0xcfd4da, 0.8)
    this.viewRingGroup.add(this.visualMesh(viewRingGeo, viewMaterial))
    const viewProxy = new Mesh(viewRingProxyGeo, this.proxyMaterial)
    viewProxy.userData.handle = 'rotView'
    this.viewRingGroup.add(viewProxy)
    this.viewRingProxies.push(viewProxy)
    this.rotateGroup.add(this.viewRingGroup)

    // interior trackball: an invisible pick proxy kept out of rotateProxies so the
    // rings are always tested first (the trackball is picked only on a ring miss).
    // pick() gates it on the "Use Trackball" toggle. The faint hover ball sits inside
    // the proxy and is shown only while the trackball is highlighted (applyHighlight).
    const trackballProxy = new Mesh(trackballProxyGeo, this.proxyMaterial)
    trackballProxy.userData.handle = 'rotTrackball'
    this.trackballVisual = new Mesh(trackballVisualGeo, this.trackballMaterial)
    this.trackballVisual.renderOrder = 997
    this.trackballVisual.visible = false
    this.rotateGroup.add(trackballProxy, this.trackballVisual)
    this.trackballProxies.push(trackballProxy)

    this.sectorGeo.setAttribute('position', new BufferAttribute(new Float32Array(SECTOR_MAX_SEGS * 9), 3))
    this.sectorGeo.setDrawRange(0, 0)
    const sector = new Mesh(this.sectorGeo, this.sectorMaterial)
    sector.renderOrder = 998
    sector.frustumCulled = false
    // full reference circle in the rotation plane (drawn behind the swept arc). A Line whose last point repeats
    // the first: the WebGPU renderer draws no LineLoop.
    this.circleGeo.setAttribute('position', new BufferAttribute(new Float32Array((CIRCLE_SEGS + 1) * 3), 3))
    const circle = new Line(this.circleGeo, this.tickMaterial)
    circle.renderOrder = 998
    circle.frustumCulled = false
    // 3 line segments: the two arc edges (center->start, center->end) + the cursor line
    this.edgeGeo.setAttribute('position', new BufferAttribute(new Float32Array(18), 3))
    this.edgeGeo.setDrawRange(0, 0)
    const edges = new LineSegments(this.edgeGeo, this.edgeMaterial)
    edges.renderOrder = 999
    edges.frustumCulled = false
    this.feedbackGroup.add(sector, circle, edges)
    this.feedbackGroup.visible = false
    this.root.add(this.feedbackGroup)
  }

  setState(state: GizmoState | null): void {
    this.state = state
    this.root.visible = state !== null
    if (!state) return
    this.root.position.set(state.center[0], state.center[1], state.center[2])
    this.orientRoot()
    // the swept-arc feedback rides under root (inheriting its orientation + screen scale)
    // transform mode shows the move + rotate handles together
    this.moveGroup.visible = state.mode === 'move' || state.mode === 'transform'
    // hide the whole rotate gizmo (rings + interior ball) while trackball-dragging
    this.rotateGroup.visible = (state.mode === 'rotate' || state.mode === 'transform') && this.drag?.kind !== 'trackball'
    // yaw-only (conveyors): show + pick the Y ring only; hide the X/Z tilt rings and the
    // view ring so the gizmo can never write a pitch/roll. rotateVisuals/Proxies = [Y,X,Z].
    const yawOnly = state.rotateYawOnly === true
    this.rotateVisuals.forEach((m, i) => (m.visible = !yawOnly || i === 0))
    this.rotateProxies.forEach((m, i) => (m.visible = !yawOnly || i === 0))
    this.viewRingGroup.visible = !yawOnly
    // the lone yaw ring draws as a full circle (no overlapping rings to declutter);
    // normal multi-ring mode keeps the half-ring look. rotateVisuals[0] = Y.
    const yawMat = this.rotateVisuals[0]?.material as MeshBasicMaterial | undefined
    const ringFull = yawMat?.userData.ringFull as { value: number } | undefined
    if (ringFull) ringFull.value = yawOnly ? 1 : 0
    // locks: an axis or a rotation the part sets itself has no handle at all (pick() skips hidden proxies)
    const lock = state.lockMove
    for (const a of this.arrowGroups) a.group.visible = !lock?.[a.axis]
    for (const p of this.padGroups) p.group.visible = !p.axes.some((ax) => lock?.[AXIS_INDEX[ax]])
    if (state.lockRotate) this.rotateGroup.visible = false
  }

  /**
   * The handles' orientation. Global space: the world axes. Local space: the part's full orientation, or a frame
   * when one is given (a rig node's parent frame). While a translate drag is live the gizmo follows the part
   * (setState fires each frame), so it honours the drag's keyboard lock (constrain), not the space toggle - and a
   * part's local translate is yaw-only, while a frame is used whole.
   */
  private planeHit(origin: Vector3, dir: Vector3, normal: Vector3, point: Vector3): Vector3 | null {
    return rayPlaneHit(origin, dir, normal, point, this.orthographic)
  }

  private orientRoot(): void {
    this.orientRootOnly()
    // the rotation feedback is built in world orientation: undo the root's turn, so a local-space gizmo turning with
    // the part does not carry the wedge (it ran a frame's turn ahead of the cursor)
    this.feedbackGroup.quaternion.copy(this.root.quaternion).invert()
  }

  private orientRootOnly(): void {
    const state = this.state
    if (!state) return
    const translate = this.drag?.kind === 'translate' ? this.drag : null
    const local = translate ? translate.local : state.space === 'local'
    if (local && state.frame) {
      this.root.quaternion.set(state.frame[0], state.frame[1], state.frame[2], state.frame[3])
      return
    }
    let rx = 0
    let ry = 0
    let rz = 0
    if (translate) {
      ry = translate.local ? state.rotationY : 0
    } else if (local) {
      rx = state.rotationX ?? 0
      ry = state.rotationY
      rz = state.rotationZ ?? 0
    }
    this.root.rotation.order = 'YXZ'
    this.root.rotation.set(rx, ry, rz)
  }

  pick(raycaster: Raycaster): GizmoHandle | null {
    if (!this.state) return null
    this.root.updateMatrixWorld(true)
    // transform mode shows move + rotate at once; the translate handles are tested
    // first, then the rings, so a ring behind an arrow never steals the grab
    // yaw-only hides the X/Z + view rings (setState sets their proxies invisible);
    // intersectObjects ignores visibility, so filter here too. Trackball is suppressed.
    const yawOnly = this.state.rotateYawOnly === true
    // a locked axis' arrow (and any pad using it) is hidden; intersectObjects would still hit its proxy
    const moves = this.state.lockMove ? this.moveProxies.filter((m) => m.parent?.visible !== false) : this.moveProxies
    if (this.state.lockRotate) return this.state.mode === 'rotate' ? null : this.pickFrom(raycaster, moves)
    const rings = yawOnly ? this.rotateProxies.filter((m) => m.visible) : this.rotateProxies
    const viewRings = yawOnly ? [] : this.viewRingProxies
    if (this.state.mode === 'transform') {
      return (
        this.pickFrom(raycaster, moves) ??
        this.pickRings(raycaster, rings, yawOnly) ??
        this.pickFrom(raycaster, viewRings)
      )
    }
    if (this.state.mode === 'rotate') {
      // axis rings, then the view ring, then the interior trackball (enabled + no ring hit)
      const hit = this.pickRings(raycaster, rings, yawOnly) ?? this.pickFrom(raycaster, viewRings)
      if (hit) return hit
      return this.state.trackball && !yawOnly ? this.pickFrom(raycaster, this.trackballProxies) : null
    }
    return this.pickFrom(raycaster, moves)
  }

  private pickFrom(raycaster: Raycaster, proxies: Mesh[]): GizmoHandle | null {
    const hits = raycaster.intersectObjects(proxies, false)
    return hits.length ? (hits[0]!.object.userData.handle as GizmoHandle) : null
  }

  // axis-ring pick that honours the half-ring look: halfRing's shader draw-discards
  // a tilted ring's away half, so reject hover/grab hits there too - otherwise the
  // invisible back half (projected across the gizmo interior) steals the pick and
  // blanks the trackball hover ball. yaw-only rings draw full, so skip the test.
  private pickRings(raycaster: Raycaster, proxies: Mesh[], yawOnly: boolean): GizmoHandle | null {
    const hits = raycaster.intersectObjects(proxies, false)
    if (!hits.length) return null
    const fwd = raycaster.ray.direction // unit, camera -> scene (the view forward)
    const center = tmpA.set(this.state!.center[0], this.state!.center[1], this.state!.center[2])
    for (const h of hits) {
      const axis = h.object.userData.axis as Vector3 | undefined
      if (!yawOnly && axis) {
        // mirror the shader: vFaceOn = |axis·forward|, vRelZ < 0 (away half) = hit
        // farther along the view forward than the gizmo centre
        const faceOn = Math.abs(tmpB.copy(axis).transformDirection(h.object.matrixWorld).dot(fwd))
        const awayHalf = tmpC.copy(h.point).sub(center).dot(fwd) > 0
        if (faceOn < RING_FACE_ON && awayHalf) continue // invisible half - not a real handle
      }
      return h.object.userData.handle as GizmoHandle
    }
    return null
  }

  /** hover highlight; locked to the dragged handle while a drag is active */
  setHighlight(handle: GizmoHandle | null): void {
    if (this.drag) return
    this.applyHighlight(handle)
  }

  beginDrag(handle: GizmoHandle, ray: Ray, camNormal: Vector3 = DEFAULT_CAM_NORMAL, screen?: { x: number; y: number }, orthographic = false): void {
    if (!this.state) return
    this.orthographic = orthographic
    this.applyHighlight(handle === 'view' ? null : handle)
    const center = new Vector3(this.state.center[0], this.state.center[1], this.state.center[2])
    if (handle === 'rotX' || handle === 'rotY' || handle === 'rotZ' || handle === 'rotView') {
      // In perspective the ring sits off the screen centre wherever the part is not, so "towards the viewer" is the
      // line of sight to it, not the camera's forward: the view ring turns about that line and its angle is read on
      // the plane facing it. A perspective ray starts at the camera, so the sight line is centre minus ray origin. An
      // orthographic ray starts on the near plane and every sight line is the camera normal.
      const sight = orthographic ? camNormal.clone() : center.clone().sub(ray.origin)
      this.beginRing(handle, ray, center, sight.lengthSq() > 1e-12 ? sight.normalize() : camNormal)
    } else if (handle === 'rotTrackball') {
      // seed the screen-space frame + grab pixel; dragDelta integrates the offset
      const { right, up } = cameraRightUp(camNormal)
      this.drag = { kind: 'trackball', right, up, startX: screen?.x ?? 0, startY: screen?.y ?? 0 }
    } else {
      // x | y | z (axis arrows) | xy | xz | yz (plane pads) | view (body drag)
      this.drag = {
        kind: 'translate',
        center,
        clickOrigin: ray.origin.clone(),
        clickDir: ray.direction.clone(),
        camNormal: camNormal.clone().normalize(),
        plane: handle === 'view' ? 'view' : (handle as GizmoConstraint),
        local: handle !== 'view' && this.state.space === 'local',
        last: [0, 0, 0],
      }
    }
  }

  /** set up a rotation-ring drag */
  private beginRing(handle: 'rotX' | 'rotY' | 'rotZ' | 'rotView', ray: Ray, center: Vector3, camNormal: Vector3): void {
    const isView = handle === 'rotView'
    const axisKey = isView ? 'view' : handle === 'rotX' ? 'x' : handle === 'rotY' ? 'y' : 'z'
    const local = !isView && this.state?.space === 'local'
    // the part's full orientation at grab (so a later global<->local cycle has the
    // local frame even when the grab happened in global space)
    const f = this.state?.frame
    const grabQuat = f
      ? new Quaternion(f[0], f[1], f[2], f[3])
      : new Quaternion().setFromEuler(new Euler(this.state?.rotationX ?? 0, this.state?.rotationY ?? 0, this.state?.rotationZ ?? 0, 'YXZ'))
    const axisWorld = this.ringAxisWorld(axisKey, local, grabQuat, camNormal)
    const seed = this.seedRing(center, axisWorld, ray.origin, ray.direction)
    this.drag = {
      kind: 'ring',
      center,
      axisWorld,
      radius: isView ? VIEW_RING_RADIUS : RING_RADIUS,
      clickOrigin: ray.origin.clone(),
      clickDir: ray.direction.clone(),
      camNormal: camNormal.clone().normalize(),
      grabQuat,
      axisKey,
      local,
      initialClickVec: seed.initialClickVec,
      prevVec: seed.prevVec,
      planar: seed.planar,
      prevRingVec: seed.prevRingVec,
      accum: 0,
      rotation: 0,
      showLine: false,
      cursorHit: seed.cursorHit,
    }
  }

  /** world rotation axis for a ring constraint: world axis (global), part-oriented (local), or camera normal (view) */
  private ringAxisWorld(axisKey: 'x' | 'y' | 'z' | 'view', local: boolean, grabQuat: Quaternion, camNormal: Vector3): Vector3 {
    if (axisKey === 'view') return camNormal.clone().normalize()
    const base = axisKey === 'x' ? RING_AXIS.rotX : axisKey === 'y' ? RING_AXIS.rotY : RING_AXIS.rotZ
    const axis = base.clone()
    return (local ? axis.applyQuaternion(grabQuat) : axis).normalize()
  }

  /**
   * Reference vectors for a ring drag at the original click ray: initialClickVec (on
   * the ring's own plane, anchors the feedback arc) and prevVec (on the camera-facing
   * plane, seeds the signed-angle accumulation). Used at grab and when a keyboard
   * X/Y/Z re-aims the ring, so the rotation recomputes from the grab about the new axis.
   */
  private seedRing(
    center: Vector3,
    axisWorld: Vector3,
    origin: Vector3,
    dir: Vector3,
  ): { initialClickVec: Vector3; prevVec: Vector3; planar: boolean; prevRingVec: Vector3; cursorHit: Vector3 | null } {
    const ringHit = this.planeHit(origin, dir, axisWorld, center)
    const camFacing = tmpA.subVectors(center, origin).normalize()
    const planar = ringHit !== null && ringHit.distanceToSquared(center) > 1e-12 && Math.abs(camFacing.dot(axisWorld)) >= RING_PLANE_MIN
    const camHit = this.planeHit(origin, dir, camFacing, center)
    const refHit = ringHit ?? camHit
    const initialClickVec = refHit ? new Vector3().subVectors(refHit, center).normalize() : axisWorld.clone()
    const prevVec = camHit ? new Vector3().subVectors(camHit, center).normalize() : initialClickVec.clone()
    const cursor = planar ? ringHit : camHit
    return { initialClickVec, prevVec, planar, prevRingVec: initialClickVec.clone(), cursorHit: cursor ? cursor.clone() : null }
  }

  /** re-constrain an active translate OR rotate drag (keyboard X/Y/Z, Shift+X/Y/Z) */
  constrain(target: GizmoConstraint): void {
    const drag = this.drag
    if (!drag) return
    if (drag.kind === 'ring') {
      this.constrainRing(drag, target)
      return
    }
    if (drag.kind !== 'translate') return
    // press once -> global axis/plane; again -> local; a third time releases to view
    if (drag.plane !== target) {
      drag.plane = target
      drag.local = false
    } else if (!drag.local) {
      drag.local = true
    } else {
      drag.plane = 'view'
      drag.local = false
    }
    this.applyHighlight(drag.plane === 'view' ? null : drag.plane)
    this.orientRoot()
  }

  /**
   * Re-pick a rotation ring's axis from a keyboard X/Y/Z (rotate skips plane
   * locks). Cycles the same axis global -> local -> view, then re-aims the ring and
   * reseeds from the grab so the rotation recomputes about the new axis from the cursor.
   */
  private constrainRing(drag: Extract<DragState, { kind: 'ring' }>, target: GizmoConstraint): void {
    if (target !== 'x' && target !== 'y' && target !== 'z') return
    // a yaw-only part (a conveyor) has only its yaw ring: re-aiming to X, Z or the view axis would show a turn the
    // controller never applies and freeze the part at its last yaw
    if (this.state?.rotateYawOnly === true) return
    if (drag.axisKey !== target) {
      drag.axisKey = target
      drag.local = false
    } else if (!drag.local) {
      drag.local = true
    } else {
      drag.axisKey = 'view'
      drag.local = false
    }
    drag.axisWorld = this.ringAxisWorld(drag.axisKey, drag.local, drag.grabQuat, drag.camNormal)
    drag.radius = drag.axisKey === 'view' ? VIEW_RING_RADIUS : RING_RADIUS
    const seed = this.seedRing(drag.center, drag.axisWorld, drag.clickOrigin, drag.clickDir)
    drag.initialClickVec = seed.initialClickVec
    drag.prevVec = seed.prevVec
    drag.planar = seed.planar
    drag.prevRingVec = seed.prevRingVec
    drag.accum = 0
    drag.cursorHit = seed.cursorHit
    const handle = drag.axisKey === 'view' ? 'rotView' : drag.axisKey === 'x' ? 'rotX' : drag.axisKey === 'y' ? 'rotY' : 'rotZ'
    this.applyHighlight(handle)
  }

  dragDelta(
    ray: Ray,
    snap?: GizmoSnap | null,
    screen?: { x: number; y: number },
  ): {
    translation?: [number, number, number]
    rotationDelta?: number
    rotationAxis?: [number, number, number]
  } | null {
    const drag = this.drag
    if (!drag) return null
    if (drag.kind === 'trackball') {
      // trackball: pixel offset -> screen-space rotation axis (up*dx + right*dy),
      // its length is the angle. Both axis and angle are absolute from the grab point.
      const dx = (screen?.x ?? drag.startX) - drag.startX
      const dy = (screen?.y ?? drag.startY) - drag.startY
      const axis = tmpA
        .copy(drag.up)
        .multiplyScalar(dx * TRACKBALL_SENSITIVITY)
        .addScaledVector(drag.right, dy * TRACKBALL_SENSITIVITY)
      const angle = axis.length()
      if (angle < 1e-9) return { rotationDelta: 0, rotationAxis: [0, 1, 0] }
      axis.multiplyScalar(1 / angle)
      return { rotationDelta: quantize(angle, snap?.rotate ?? null), rotationAxis: [axis.x, axis.y, axis.z] }
    }
    const tStep = snap?.translate ?? null
    if (drag.kind === 'translate') {
      const m = this.translateMotion(drag, ray)
      if (m) {
        // snap the motion along the gizmo's own axes, so a constrained drag steps in increments: snapping world
        // components would push a local-axis drag of a yawed part off its axis
        const axes = this.localAxes(drag.local)
        const s = new Vector3()
        for (const a of [axes.x, axes.y, axes.z]) s.addScaledVector(a, quantize(m.dot(a), tStep))
        drag.last = [s.x, s.y, s.z]
      }
      return { translation: drag.last }
    }
    // rotation ring: read the cursor where it meets the ring's own plane and accumulate the signed angle swept about
    // the world axis. A cursor past the tilted ring's horizon meets no plane: the rotation holds.
    if (drag.planar) {
      const ringHit = this.planeHit(ray.origin, ray.direction, drag.axisWorld, drag.center)
      if (ringHit && ringHit.distanceToSquared(drag.center) > 1e-12) {
        const current = tmpB.subVectors(ringHit, drag.center).normalize()
        drag.accum += signedAngle(drag.prevRingVec, current, drag.axisWorld)
        drag.prevRingVec.copy(current)
        drag.cursorHit = ringHit
        drag.showLine = true
        drag.rotation = drag.accum
      }
      return {
        rotationDelta: quantize(drag.rotation, snap?.rotate ?? null),
        rotationAxis: [drag.axisWorld.x, drag.axisWorld.y, drag.axisWorld.z],
      }
    }
    // a ring near edge-on: read the cursor on a camera-facing plane (perspective: facing the camera position)
    const camFacing = tmpA.subVectors(drag.center, ray.origin).normalize()
    const hit = this.planeHit(ray.origin, ray.direction, camFacing, drag.center)
    if (hit) {
      const current = tmpB.subVectors(hit, drag.center).normalize()
      drag.accum += signedAngle(drag.prevVec, current, drag.axisWorld)
      drag.prevVec.copy(current)
      if (drag.cursorHit) drag.cursorHit.copy(hit)
      else drag.cursorHit = hit.clone()
      if (Math.abs(camFacing.dot(drag.axisWorld)) < ORTHO_THRESHOLD) {
        // ring edge-on: angles jump, so drag linearly along (planeNormal x axis); one
        // gizmo-radius of travel = 90° (orthogonal-rotation fallback)
        drag.showLine = false
        const projAxis = tmpC.crossVectors(camFacing, drag.axisWorld)
        const click = this.planeHit(drag.clickOrigin, drag.clickDir, camFacing, drag.center)
        if (click) {
          const projection = tmpD.subVectors(hit, click).dot(projAxis)
          drag.rotation = (projection * (Math.PI / 2)) / ((this.root.scale.x || 1) * drag.radius)
        }
      } else {
        drag.showLine = true
        drag.rotation = drag.accum
      }
    }
    return {
      rotationDelta: quantize(drag.rotation, snap?.rotate ?? null),
      rotationAxis: [drag.axisWorld.x, drag.axisWorld.y, drag.axisWorld.z],
    }
  }

  endDrag(): void {
    const wasTrackball = this.drag?.kind === 'trackball'
    this.drag = null
    this.applyHighlight(null)
    this.feedbackGroup.visible = false
    // restore the rings hidden during a trackball drag (don't wait for the next setState)
    if (wasTrackball && this.state) {
      this.rotateGroup.visible = (this.state.mode === 'rotate' || this.state.mode === 'transform') && !this.state.lockRotate
    }
  }

  /**
   * Rotation overlay: a reference circle in the rotation plane, a filled swept
   * arc from the initial click to the applied angle, the two arc-edge radii, and (for
   * an angular drag) a line from the gizmo center toward the cursor. Drawn under root
   * in world orientation (orientRoot counter-rotates feedbackGroup by the root's turn), so the world axis/click
   * vectors are used as they are; radius is in local units (root's screen-scale sizes it).
   */
  setRotationFeedback(angleRad: number | null): void {
    const drag = this.drag
    if (angleRad === null || !drag || drag.kind !== 'ring') {
      this.feedbackGroup.visible = false
      return
    }
    const up = tmpA.copy(drag.axisWorld).normalize()
    // right = the click vector projected into the rotation plane (arc starts here)
    const right = tmpB.copy(drag.initialClickVec)
    right.addScaledVector(up, -up.dot(right))
    // click was along the axis (degenerate): pick any perpendicular for the arc anchor
    if (right.lengthSq() < 1e-9) right.crossVectors(Math.abs(up.x) < 0.9 ? X_AXIS : Y_UP, up)
    right.normalize()
    const fwd = tmpC.crossVectors(up, right)
    const r = drag.radius

    const circle = this.circleGeo.getAttribute('position') as BufferAttribute
    for (let i = 0; i <= CIRCLE_SEGS; i++) {
      const a = (i / CIRCLE_SEGS) * Math.PI * 2
      const c = Math.cos(a) * r
      const s = Math.sin(a) * r
      const j = i * 3
      circle.array[j] = c * right.x + s * fwd.x
      circle.array[j + 1] = c * right.y + s * fwd.y
      circle.array[j + 2] = c * right.z + s * fwd.z
    }
    circle.needsUpdate = true

    const sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, angleRad))
    const segs = Math.min(Math.max(Math.ceil(Math.abs(sweep) / SECTOR_SEG_ANGLE), 1), SECTOR_MAX_SEGS)
    const step = sweep / segs
    const pos = this.sectorGeo.getAttribute('position') as BufferAttribute
    for (let i = 0; i < segs; i++) {
      const c0 = Math.cos(i * step) * r
      const s0 = Math.sin(i * step) * r
      const c1 = Math.cos((i + 1) * step) * r
      const s1 = Math.sin((i + 1) * step) * r
      const j = i * 9
      pos.array[j] = 0
      pos.array[j + 1] = 0
      pos.array[j + 2] = 0
      pos.array[j + 3] = c0 * right.x + s0 * fwd.x
      pos.array[j + 4] = c0 * right.y + s0 * fwd.y
      pos.array[j + 5] = c0 * right.z + s0 * fwd.z
      pos.array[j + 6] = c1 * right.x + s1 * fwd.x
      pos.array[j + 7] = c1 * right.y + s1 * fwd.y
      pos.array[j + 8] = c1 * right.z + s1 * fwd.z
    }
    pos.needsUpdate = true
    this.sectorGeo.setDrawRange(0, segs * 3)

    const ce = Math.cos(sweep) * r
    const se = Math.sin(sweep) * r
    const edge = this.edgeGeo.getAttribute('position') as BufferAttribute
    edge.array.set([
      0, 0, 0, right.x * r, right.y * r, right.z * r,
      0, 0, 0, ce * right.x + se * fwd.x, ce * right.y + se * fwd.y, ce * right.z + se * fwd.z,
      0, 0, 0, 0, 0, 0,
    ])
    // rotation line: center -> the cursor's world hit, pulled into root-local space
    let lineVisible = false
    if (drag.showLine && drag.cursorHit) {
      const s = this.root.scale.x || 1
      const end = tmpD.subVectors(drag.cursorHit, drag.center).multiplyScalar(1 / s)
      edge.array.set([end.x, end.y, end.z], 15)
      lineVisible = true
    }
    edge.needsUpdate = true
    this.edgeGeo.setDrawRange(0, lineVisible ? 6 : 4)
    this.feedbackGroup.visible = true
  }

  /** screen-constant size: rescale against the camera each frame */
  updateScale(camera: PerspectiveCamera, viewportHeight: number): void {
    if (!this.root.visible) return
    const d = camera.position.distanceTo(this.root.position)
    const worldPerPx = worldPerPixel(camera, d, viewportHeight)
    this.root.scale.setScalar(Math.max(worldPerPx * GIZMO_PX, 1e-4))
    // the view ring faces the viewer in world space (undo the root's full orientation): along the line of sight to the
    // gizmo in perspective, the axis a view-ring drag turns about (beginDrag), and along the camera in orthographic
    if (this.rotateGroup.visible) {
      const ortho = (camera as PerspectiveCamera & { orthographic?: boolean }).orthographic === true
      const facing = ortho ? camera.quaternion : _faceQ.setFromRotationMatrix(_faceM.lookAt(camera.position, this.root.position, camera.up))
      this.viewRingGroup.quaternion.copy(this.root.quaternion).invert().multiply(facing)
    }
    if (this.moveGroup.visible) this.updatePadQuadrants(camera)
  }

  /**
   * Keep each translate plane pad in the quadrant nearest the camera, so a pad is never
   * parked behind the part it moves. The geometries
   * bake the +/+ quadrant, so a flip is a -2*PAD_OFFSET shift of the pad's group along
   * that axis: a pure translation, which leaves the winding - and therefore the
   * single-sided pick proxies - intact where a mirroring scale would not.
   * Frozen while a drag is live: the grabbed pad must not jump out from under the cursor
   * when the part it is moving crosses the camera's axis plane.
   */
  private updatePadQuadrants(camera: PerspectiveCamera): void {
    if (this.drag) return
    // camera offset in gizmo-local space - the root's yaw/tilt (local space) turns the
    // pads with the part, so the quadrant test has to be taken in that same frame
    const v = tmpA.copy(camera.position).sub(this.root.position)
    v.applyQuaternion(tmpQuat.copy(this.root.quaternion).invert())
    const band = PAD_FLIP_BAND * v.length()
    for (const axis of ['x', 'y', 'z'] as const) {
      if (v[axis] > band) this.padSign[axis] = 1
      else if (v[axis] < -band) this.padSign[axis] = -1
    }
    for (const pad of this.padGroups) {
      pad.group.position.set(0, 0, 0)
      for (const axis of pad.axes) {
        if (this.padSign[axis] < 0) pad.group.position[axis] = -2 * PAD_OFFSET
      }
    }
  }

  dispose(): void {
    for (const style of this.styles.values()) style.material.dispose()
    this.proxyMaterial.dispose()
    this.trackballMaterial.dispose()
    this.sectorMaterial.dispose()
    this.tickMaterial.dispose()
    this.edgeMaterial.dispose()
    this.sectorGeo.dispose()
    this.circleGeo.dispose()
    this.edgeGeo.dispose()
  }

  private applyHighlight(handle: GizmoHandle | null): void {
    for (const [h, style] of this.styles) {
      if (h === handle) {
        style.material.color.copy(style.color).lerp(WHITE, 0.5)
        style.material.opacity = 1
      } else {
        style.material.color.copy(style.color)
        style.material.opacity = style.opacity
      }
    }
    // the trackball has no colour-swap style; it just appears while hovered/grabbed
    this.trackballVisual.visible = handle === 'rotTrackball'
  }

  private handleMaterial(handle: GizmoHandle, color: number, opacity: number): MeshBasicMaterial {
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true, // one draw, same pixels - see the note above
      toneMapped: false,
    })
    this.styles.set(handle, { material, color: new Color(color), opacity })
    return material
  }

  private visualMesh(geometry: BufferGeometry, material: MeshBasicMaterial): Mesh {
    const mesh = new Mesh(geometry, material)
    mesh.renderOrder = 1000
    return mesh
  }

  /** the gizmo's X/Y/Z basis: world axes when global, yawed by the part when local */
  private localAxes(local: boolean): { x: Vector3; y: Vector3; z: Vector3 } {
    const f = local ? this.state?.frame : undefined
    if (f) {
      const q = new Quaternion(f[0], f[1], f[2], f[3])
      return { x: new Vector3(1, 0, 0).applyQuaternion(q), y: new Vector3(0, 1, 0).applyQuaternion(q), z: new Vector3(0, 0, 1).applyQuaternion(q) }
    }
    const ry = local ? this.state?.rotationY ?? 0 : 0
    const c = Math.cos(ry)
    const s = Math.sin(ry)
    return { x: new Vector3(c, 0, -s), y: new Vector3(0, 1, 0), z: new Vector3(s, 0, c) }
  }

  /**
   * Translate motion: project the start->current pointer motion
   * onto the constraint. Axis locks mask to one axis; plane/view locks ride the
   * plane. The constraint plane is rebuilt each call from `plane`/`local`, so a
   * mid-drag keyboard re-constraint (see constrain) takes effect immediately.
   */
  private translateMotion(
    drag: Extract<DragState, { kind: 'translate' }>,
    ray: Ray,
  ): Vector3 | null {
    const axes = this.localAxes(drag.local)
    let normal: Vector3
    let mask: Vector3 | null = null
    switch (drag.plane) {
      case 'view':
        normal = drag.camNormal
        break
      case 'x':
        mask = axes.x
        normal = planeFacingCamera(axes.x, drag.camNormal)
        break
      case 'y':
        mask = axes.y
        normal = planeFacingCamera(axes.y, drag.camNormal)
        break
      case 'z':
        mask = axes.z
        normal = planeFacingCamera(axes.z, drag.camNormal)
        break
      case 'yz':
        normal = axes.x
        break
      case 'xz':
        normal = axes.y
        break
      case 'xy':
        normal = axes.z
        break
    }
    const hit = this.planeHit(ray.origin, ray.direction, normal, drag.center)
    const click = this.planeHit(drag.clickOrigin, drag.clickDir, normal, drag.center)
    if (!hit || !click) return null
    const motion = hit.sub(click)
    // axis lock: project the planar motion onto the single axis
    if (mask) {
      const along = mask.dot(motion)
      motion.copy(mask).multiplyScalar(along)
    }
    const maxTravel = MAX_TRAVEL_PER_CAMERA_DISTANCE * drag.clickOrigin.distanceTo(drag.center)
    if (motion.length() > maxTravel) motion.setLength(maxTravel)
    return motion
  }
}
