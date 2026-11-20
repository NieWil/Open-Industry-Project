// --- vertex snapping ----------
// Find the mesh vertex nearest the cursor in screen space, with a per-part
// projected-AABB broad-phase prune (closest vertex on node / in scene, with a
// min-screen-distance-to-AABB prune). The view owns the
// camera projection; the controller drives the modal interaction + markers.
// Extracted from view.ts: every function takes the owning RenderView first and
// reads its shared members (camera, renderer, entries, ...) plus the per-view
// VertexSnapState scratch/markers held on view.vsnap.

import { Matrix4, Mesh, MeshBasicMaterial, Plane, SphereGeometry, Vector2, Vector3 } from 'three'
import type { Box3, BufferGeometry, InstancedMesh } from 'three'
import { collisionVerticesLocal } from '../../core/geometry/collisionGeometry'
import type { Entry, RenderView } from './view'

/** small sphere drawn at the vertex-snap source/target points (filled dots) */
const vertexMarkerGeo = new SphereGeometry(0.045, 16, 12)

/** per-view vertex-snap state: scratch (reused per query so the per-vertex loop never allocates) + markers */
export interface VertexSnapState {
  readonly view: Matrix4
  readonly vert: Vector3
  readonly eye: Vector3
  readonly screen: Vector2
  readonly mat: Matrix4
  readonly inst: Matrix4
  sourceMarker: Mesh | null
  targetMarker: Mesh | null
}

export function createVertexSnapState(): VertexSnapState {
  return {
    view: new Matrix4(),
    vert: new Vector3(),
    eye: new Vector3(),
    screen: new Vector2(),
    mat: new Matrix4(),
    inst: new Matrix4(),
    sourceMarker: null,
    targetMarker: null,
  }
}

/** snapshot the view matrix + canvas rect a vertex query projects through */
function vsnapPrepare(view: RenderView): DOMRect {
  view.camera.updateMatrixWorld()
  view.vsnap.view.copy(view.camera.matrixWorldInverse)
  return view.renderer.domElement.getBoundingClientRect()
}

/** project a world point to CSS px (into vsnap.screen); false when behind the camera */
function vsnapProject(view: RenderView, v: Vector3, rect: DOMRect): boolean {
  const s = view.vsnap
  s.eye.copy(v).applyMatrix4(s.view) // world -> eye space
  if (s.eye.z >= 0) return false // behind the camera (looks down -z)
  s.eye.applyMatrix4(view.camera.projectionMatrix) // -> NDC (perspective divide)
  s.screen.set(
    rect.left + ((s.eye.x + 1) / 2) * rect.width,
    rect.top + ((1 - s.eye.y) / 2) * rect.height,
  )
  return true
}

/** min screen-px distance from the cursor to a world AABB; 0 (never prune) if a corner is behind */
function vsnapBoxDist(view: RenderView, box: Box3, cx: number, cy: number, rect: DOMRect): number {
  const s = view.vsnap
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < 8; i++) {
    s.vert.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    )
    if (!vsnapProject(view, s.vert, rect)) return 0
    minX = Math.min(minX, s.screen.x)
    maxX = Math.max(maxX, s.screen.x)
    minY = Math.min(minY, s.screen.y)
    maxY = Math.max(maxY, s.screen.y)
  }
  const dx = Math.max(minX - cx, 0, cx - maxX)
  const dy = Math.max(minY - cy, 0, cy - maxY)
  return Math.hypot(dx, dy)
}

/** test one projected world vertex against the cursor; lower best.dist + copy it when closer */
function vsnapConsider(view: RenderView, world: Vector3, cx: number, cy: number, rect: DOMRect, best: { dist: number; point: Vector3 | null }): void {
  if (!vsnapProject(view, world, rect)) return
  const s = view.vsnap
  const d = Math.hypot(s.screen.x - cx, s.screen.y - cy)
  if (d < best.dist) {
    best.dist = d
    best.point = (best.point ?? new Vector3()).copy(world)
  }
}

/** scan one part's snap vertices; lower best.dist + copy the world point when a closer one is found */
function vsnapScanEntry(view: RenderView, entry: Entry, cx: number, cy: number, rect: DOMRect, useCollision: boolean, best: { dist: number; point: Vector3 | null }): void {
  const s = view.vsnap
  const root = entry.visual.object
  // broad-phase: skip the whole part when its projected world AABB is already farther than best
  const bbox = view.boundsOf(entry)
  if (!bbox.isEmpty() && vsnapBoxDist(view, bbox, cx, cy, rect) >= best.dist) return
  root.updateWorldMatrix(true, true) // only the survivors pay for the matrix refresh
  if (useCollision) {
    // collision-proxy corners in the part's local frame ("Snap to Collision
    // Vertices"); the part root's world matrix carries them to world space so they
    // track the part's position + rotation, matching what the user sees.
    for (const p of collisionVerticesLocal(entry.part)) {
      s.vert.set(p.x, p.y, p.z).applyMatrix4(root.matrixWorld)
      vsnapConsider(view, s.vert, cx, cy, rect, best)
    }
    return
  }
  // "Snap to Mesh Vertices": every render-mesh vertex (Instanced meshes per instance)
  root.traverse((child) => {
    const mesh = child as Mesh & { isMesh?: boolean; isInstancedMesh?: boolean }
    if (!mesh.isMesh) return
    const pos = (mesh.geometry as BufferGeometry).getAttribute('position')
    if (!pos) return
    const instanced = mesh as unknown as InstancedMesh
    const count = mesh.isInstancedMesh ? instanced.count : 1
    for (let inst = 0; inst < count; inst++) {
      if (mesh.isInstancedMesh) {
        instanced.getMatrixAt(inst, s.inst)
        s.mat.multiplyMatrices(mesh.matrixWorld, s.inst)
      } else {
        s.mat.copy(mesh.matrixWorld)
      }
      for (let i = 0; i < pos.count; i++) {
        s.vert.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(s.mat)
        vsnapConsider(view, s.vert, cx, cy, rect, best)
      }
    }
  })
}

/** nearest snap vertex (world) on any of `ids`, within `thresholdPx` of the cursor; null if none */
export function vertexSnapSource(view: RenderView, clientX: number, clientY: number, ids: readonly string[], thresholdPx: number, useCollision: boolean): Vector3 | null {
  const rect = vsnapPrepare(view)
  const best: { dist: number; point: Vector3 | null } = { dist: thresholdPx, point: null }
  for (const id of ids) {
    const entry = view.entries.get(id)
    if (entry) vsnapScanEntry(view, entry, clientX, clientY, rect, useCollision, best)
  }
  return best.point
}

/** nearest snap vertex (world) on a visible part not in `exclude`, within `thresholdPx`; with its part id */
export function vertexSnapTarget(
  view: RenderView,
  clientX: number,
  clientY: number,
  exclude: ReadonlySet<string>,
  thresholdPx: number,
  useCollision: boolean,
): { point: Vector3; partId: string } | null {
  const rect = vsnapPrepare(view)
  const best: { dist: number; point: Vector3 | null } = { dist: thresholdPx, point: null }
  let bestId: string | null = null
  for (const [id, entry] of view.entries) {
    if (exclude.has(id) || view.hidden.has(id)) continue
    const before = best.dist
    vsnapScanEntry(view, entry, clientX, clientY, rect, useCollision, best)
    if (best.dist < before) bestId = id
  }
  return best.point && bestId ? { point: best.point, partId: bestId } : null
}

/** intersect the cursor ray with the camera-facing plane through `through` (free-drag fallback) */
export function cameraPlanePoint(view: RenderView, clientX: number, clientY: number, through: Vector3): Vector3 | null {
  view.setPointerRay(clientX, clientY)
  const normal = view.camera.getWorldDirection(view.camTmp).clone()
  const plane = new Plane().setFromNormalAndCoplanarPoint(normal, through)
  const out = new Vector3()
  return view.raycaster.ray.intersectPlane(plane, out) ? out : null
}

function makeVertexMarker(view: RenderView, color: number): Mesh {
  const mesh = new Mesh(
    vertexMarkerGeo,
    new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }),
  )
  mesh.renderOrder = 999 // drawn over geometry like a gizmo so the snap point is always visible
  mesh.visible = false
  view.scene.add(mesh)
  return mesh
}

/** show/update the vertex-snap source + target markers; null hides each */
export function showVertexMarkers(view: RenderView, source: Vector3 | null, target: Vector3 | null): void {
  const s = view.vsnap
  if (source) {
    s.sourceMarker ??= makeVertexMarker(view, 0xffd24a)
    s.sourceMarker.position.copy(source)
    s.sourceMarker.visible = true
  } else if (s.sourceMarker) {
    s.sourceMarker.visible = false
  }
  if (target) {
    s.targetMarker ??= makeVertexMarker(view, 0x66e0ff)
    s.targetMarker.position.copy(target)
    s.targetMarker.visible = true
  } else if (s.targetMarker) {
    s.targetMarker.visible = false
  }
}
