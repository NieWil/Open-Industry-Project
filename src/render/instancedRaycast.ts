import { InstancedMesh, Matrix4, Mesh, Sphere, Vector3 } from 'three'
import type { Intersection, Material, Raycaster } from 'three'

// Far-aware InstancedMesh raycasting (three 0.187 - docs/three-coupling.md, Tier 1).
//
// Stock InstancedMesh.raycast composes (and Mesh.raycast inverts) a matrix for every instance and
// never consults raycaster.far. The pilot's per-frame ray fan (far ≈ 0.35 m) runs beside banks of
// hundreds of instances, so nearly all that work is spent on instances out of reach.
//
// The patch pre-gates each instance with a ~25-flop world-space sphere test read off the
// instanceMatrix array (template sphere through instance + mesh matrices, radius scaled by the max
// basis-column scale), skipping instances whose sphere misses the ray line or lies outside
// [near, far]. The gate is conservative: survivors run the stock compose + (BVH-patched)
// Mesh.raycast narrow phase, so the Intersections are identical.
//
// Feature-detects the r187 shape and delegates to stock on anything unexpected (slower, never
// wrong). Off switch: `?stockinstraycast`. Canary: instancedRaycast.test.ts (patched vs stock).
// Retire when three's own instanced loop prunes by ray.far per instance.

/** stock r185 InstancedMesh.raycast, captured before the patch (fallback + canary reference) */
export const stockInstancedMeshRaycast = InstancedMesh.prototype.raycast

const _mesh = new Mesh()
const _instanceLocal = new Matrix4()
const _instanceWorld = new Matrix4()
const _sphere = new Sphere()
const _center = new Vector3()
const _instanceIntersects: Intersection[] = []

export function farAwareInstancedMeshRaycast(
  this: InstancedMesh,
  raycaster: Raycaster,
  intersects: Intersection[],
): void {
  const geometry = this.geometry
  const arr = this.instanceMatrix?.array as ArrayLike<number> | undefined
  const count = this.count
  // r187-shape guard: anything unexpected → stock (slower, never wrong)
  if (!geometry || !arr || arr.length < count * 16) {
    stockInstancedMeshRaycast.call(this, raycaster, intersects)
    return
  }

  const material = this.material as Material | Material[] | undefined
  if (material === undefined) return
  _mesh.geometry = geometry
  _mesh.material = material

  // whole-batch reject first, exactly as stock does
  if (this.boundingSphere === null) this.computeBoundingSphere()
  _sphere.copy(this.boundingSphere!).applyMatrix4(this.matrixWorld)
  if (raycaster.ray.intersectsSphere(_sphere) === false) return

  // unit-template bounds for the per-instance gate; an unusable sphere (empty geometry →
  // -1/NaN radius) falls back to stock
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere()
  const gs = geometry.boundingSphere
  if (gs === null || !(gs.radius >= 0) || !Number.isFinite(gs.radius)) {
    stockInstancedMeshRaycast.call(this, raycaster, intersects)
    return
  }

  const matrixWorld = this.matrixWorld
  const baseR = gs.radius * matrixWorld.getMaxScaleOnAxis()
  const cx = gs.center.x, cy = gs.center.y, cz = gs.center.z
  const centered = cx === 0 && cy === 0 && cz === 0
  const ray = raycaster.ray
  const O = ray.origin
  const D = ray.direction // unit length - the Ray contract distanceSqToPoint also assumes
  const far = raycaster.far
  const near = raycaster.near

  for (let instanceId = 0; instanceId < count; instanceId++) {
    const b = instanceId * 16
    const m0 = arr[b]!, m1 = arr[b + 1]!, m2 = arr[b + 2]!
    const m4 = arr[b + 4]!, m5 = arr[b + 5]!, m6 = arr[b + 6]!
    const m8 = arr[b + 8]!, m9 = arr[b + 9]!, m10 = arr[b + 10]!
    // conservative instance radius: template radius × longest basis column of the instance matrix
    const sSq = Math.max(
      m0 * m0 + m1 * m1 + m2 * m2,
      m4 * m4 + m5 * m5 + m6 * m6,
      m8 * m8 + m9 * m9 + m10 * m10,
    )
    const r = baseR * Math.sqrt(sSq)
    // instance-sphere centre: template centre through the instance matrix, then mesh world
    if (centered) _center.set(arr[b + 12]!, arr[b + 13]!, arr[b + 14]!)
    else {
      _center.set(
        m0 * cx + m4 * cy + m8 * cz + arr[b + 12]!,
        m1 * cx + m5 * cy + m9 * cz + arr[b + 13]!,
        m2 * cx + m6 * cy + m10 * cz + arr[b + 14]!,
      )
    }
    _center.applyMatrix4(matrixWorld)
    const vx = _center.x - O.x, vy = _center.y - O.y, vz = _center.z - O.z
    const t = vx * D.x + vy * D.y + vz * D.z
    // any hit's ray-parameter lies within ±r of t, so a sphere wholly beyond far (or short
    // of near) cannot produce a hit Mesh.raycast would keep
    if (t - r > far || t + r < near) continue
    const vv = vx * vx + vy * vy + vz * vz
    const dSq = t > 0 ? vv - t * t : vv // Ray.distanceSqToPoint (origin-clamped)
    if (dSq > r * r) continue
    // survivor: stock narrow phase
    this.getMatrixAt(instanceId, _instanceLocal)
    _instanceWorld.multiplyMatrices(matrixWorld, _instanceLocal)
    _mesh.matrixWorld = _instanceWorld
    _mesh.raycast(raycaster, _instanceIntersects)
    for (let i = 0, l = _instanceIntersects.length; i < l; i++) {
      const intersect = _instanceIntersects[i]!
      intersect.instanceId = instanceId
      intersect.object = this
      intersects.push(intersect)
    }
    _instanceIntersects.length = 0
  }
}

const killed =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('stockinstraycast')
if (!killed) {
  ;(InstancedMesh.prototype as { raycast: typeof farAwareInstancedMeshRaycast }).raycast =
    farAwareInstancedMeshRaycast
}
