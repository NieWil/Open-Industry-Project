import { Box3, BufferGeometry, Float32BufferAttribute, Sphere } from 'three'
import type { BufferAttribute } from 'three'
import type { MeshDescription } from '../../core/geometry/meshDescription'
import { dropColliderBVH } from '../bvh'
import { noteGeometryRecycle } from '../geometryRecycle'

// The web host adapter for the geometry tier (docs/procedural-geometry.md): realize a portable
// MeshDescription (plain flat buffers computed in three-free core) into a three.js BufferGeometry.
//
// This is the only place three.js touches a geometry description. The part script that emitted the
// description never sees `THREE`; the realization (allocation, normals, GPU buffers) belongs to the host,
// the same way a behavior emits commands and the host applies them. The description carries no normals (it's
// host-agnostic data), so we derive them from the faces here.
export function realizeMeshDescription(desc: MeshDescription): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(desc.positions, 3))
  geo.setAttribute('uv', new Float32BufferAttribute(desc.uvs, 2))
  geo.setIndex([...desc.indices]) // three picks Uint16/Uint32 by the max index
  geo.setAttribute('normal', new Float32BufferAttribute(new Float32Array(desc.positions.length), 3))
  deriveNormalsAndBounds(geo)
  return geo
}

/**
 * The geometry's vertex normals, bounding box and bounding sphere, with the same arithmetic as three's
 * computeVertexNormals / computeBoundingBox / computeBoundingSphere, so the results are bit-identical. Those go
 * through a Vector3 per vertex and cost ~4.5x this flat loop: 5.3 ms of normals and 2.5 ms of bounds on every
 * pointer-move of a rack resize (~50k vertices). Expects realizeMeshDescription's shape: indexed, a normal
 * attribute as long as position, no morph targets, at least one vertex.
 */
function deriveNormalsAndBounds(geo: BufferGeometry): void {
  const normal = geo.getAttribute('normal') as BufferAttribute
  const p = (geo.getAttribute('position') as BufferAttribute).array as Float32Array
  const n = normal.array as Float32Array
  const idx = geo.index!.array
  n.fill(0)
  const add = (v: number, x: number, y: number, z: number): void => {
    n[v] = n[v]! + x
    n[v + 1] = n[v + 1]! + y
    n[v + 2] = n[v + 2]! + z
  }
  // area-weighted face normals summed per vertex, rounded to float32 after each add as three's setXYZ does.
  // A triangle that repeats a vertex adds a zero cross product, so writing each corner in turn matches three's
  // read-all-then-write order.
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3
    const b = idx[t + 1]! * 3
    const c = idx[t + 2]! * 3
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!
    const cbx = p[c]! - bx, cby = p[c + 1]! - by, cbz = p[c + 2]! - bz
    const abx = p[a]! - bx, aby = p[a + 1]! - by, abz = p[a + 2]! - bz
    const nx = cby * abz - cbz * aby
    const ny = cbz * abx - cbx * abz
    const nz = cbx * aby - cby * abx
    add(a, nx, ny, nz)
    add(b, nx, ny, nz)
    add(c, nx, ny, nz)
  }
  for (let i = 0; i < n.length; i += 3) {
    const x = n[i]!, y = n[i + 1]!, z = n[i + 2]!
    const inv = 1 / (Math.sqrt(x * x + y * y + z * z) || 1) // Vector3.normalize: divideScalar is multiplyScalar(1 / s)
    n[i] = x * inv; n[i + 1] = y * inv; n[i + 2] = z * inv
  }
  normal.needsUpdate = true
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
  }
  const box = (geo.boundingBox ??= new Box3())
  box.min.set(minX, minY, minZ)
  box.max.set(maxX, maxY, maxZ)
  const sphere = (geo.boundingSphere ??= new Sphere())
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5
  let r2 = 0
  for (let i = 0; i < p.length; i += 3) {
    const dx = cx - p[i]!, dy = cy - p[i + 1]!, dz = cz - p[i + 2]!
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz)
  }
  sphere.center.set(cx, cy, cz)
  sphere.radius = Math.sqrt(r2)
}

/**
 * Re-emit `desc` into an existing geometry instead of minting a replacement: the "don't free on the
 * interactive path" half of the render-bundle resource lifetime rules (src/render/gpuRetire.ts).
 *
 * gpuRetire makes a free safe (hold the buffers until no recording can reach them, then re-record);
 * this makes the free unnecessary, which is better. A procedural part re-emits its geometry on every
 * pointer-move of a resize/merge drag, and by far the most common case is the same topology at new
 * coordinates: same vertex count, same index count, only the numbers changed. Rewriting the existing
 * attribute arrays then keeps every GPU buffer handle alive, so:
 *   - nothing is freed, so nothing can be freed under a live render-bundle recording;
 *   - the recorded draw (buffer handles + index count) stays valid, so the edit needs no re-record.
 *     It replays with the new contents via the per-object attribute refresh, the same
 *     "rewrites attributes in place (replay-safe)" path the reconcile already relies on;
 *   - a drag doesn't allocate a fresh position/uv/normal/index set per frame.
 *
 * Returns false (the caller mints a new geometry and retires the old one) when the buffers can't be reused:
 *  - a different vertex or index count (a real topology change: a post added, a guard split in two).
 *    Over-allocating to a capacity bucket isn't used: it would need drawRange juggling, a tail fill
 *    to keep bounds correct, and stale indices held past the live range, and a draw-count change
 *    re-records anyway. Topology changes are rare; per-pointer-move changes are not.
 *  - a Uint16 index buffer that the new indices would overflow (checked, not assumed).
 *  - anything not shaped like realizeMeshDescription's output (no uv/normal/index).
 */
export function rewriteMeshDescription(geo: BufferGeometry, desc: MeshDescription): boolean {
  const pos = geo.getAttribute('position') as BufferAttribute | undefined
  const uv = geo.getAttribute('uv') as BufferAttribute | undefined
  const normal = geo.getAttribute('normal') as BufferAttribute | undefined
  const index = geo.index
  if (!pos || !uv || !normal || !index) {
    noteGeometryRecycle(false)
    return false
  }
  const posArr = pos.array as Float32Array
  const uvArr = uv.array as Float32Array
  const idxArr = index.array as Uint16Array | Uint32Array
  // same buffer shape ⇒ same vertex count ⇒ every index still addresses a live vertex
  if (
    posArr.length !== desc.positions.length ||
    uvArr.length !== desc.uvs.length ||
    idxArr.length !== desc.indices.length ||
    normal.array.length !== posArr.length
  ) {
    noteGeometryRecycle(false)
    return false
  }
  // A Uint16 index buffer was sized by the previous max index, not by the vertex count, so an equal
  // vertex count does not by itself prove the new indices fit. Cheap to check, silent corruption if not.
  if (idxArr.BYTES_PER_ELEMENT === 2) {
    for (let i = 0; i < desc.indices.length; i++) {
      if (desc.indices[i]! > 65535) {
        noteGeometryRecycle(false)
        return false
      }
    }
  }
  posArr.set(desc.positions)
  uvArr.set(desc.uvs)
  idxArr.set(desc.indices)
  pos.needsUpdate = true
  uv.needsUpdate = true
  index.needsUpdate = true
  // rewrites the existing normal array, and the bounds culling, raycast and outlines read, from the new vertices
  deriveNormalsAndBounds(geo)
  dropColliderBVH(geo)
  noteGeometryRecycle(true)
  return true
}
