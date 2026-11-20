import { InstancedMesh, Matrix4, Quaternion, Sphere, Vector3, type Material } from 'three'
import type { InstanceTransform, MeshDescription } from '../../core/parts/partApi'
import { bucketCapacity } from './instanceCapacity'
import { realizeMeshDescription } from './meshDescriptionGeometry'

// Host realization for a MeshPart.instances bank (docs/part-authoring-guide.md, Tier 2): draw the author's
// `desc` as a unit template at each per-instance transform, as one InstancedMesh. The general form of the
// built-in roller/leg banks, drivable from any geometry() part.
//
// Poolable by construction: a plain InstancedMesh on the default layer, no instanceColor, no spinUniform
// material. So the scene-global instance pool (viewport/instancePool.ts) merges identical banks across parts,
// keyed on geometryContentKey of the realized template. Keep `desc` a unit shape and put size in each
// instance's scale, and two parts using the same template share one pool.

const _pos = new Vector3()
const _quat = new Quaternion()
const _scale = new Vector3()
const _mat = new Matrix4()

/** Build a bank InstancedMesh from a template description + its per-instance transforms. The instance
 *  buffer is sized to a coarse capacity bucket (bucketCapacity), not exact-fit, so extending a conveyor a
 *  little keeps the count under capacity and reuses this mesh (the reconcile in sdkPart writes the new
 *  transforms in place). A fresh mesh would cold-compile a pipeline on the draw path under WebGPU and
 *  hitch. See parts/instanceCapacity.ts. */
export function realizeInstancedTemplate(
  desc: MeshDescription,
  instances: readonly InstanceTransform[],
  material: Material,
): InstancedMesh {
  const mesh = new InstancedMesh(realizeMeshDescription(desc), material, bucketCapacity(instances.length))
  mesh.castShadow = true
  mesh.receiveShadow = true
  writeInstanceMatrices(mesh, instances)
  return mesh
}

/**
 * Empty-bank visibility invariant: a bank whose live count is 0 must be invisible, not a visible
 * mesh that draws nothing. A visible count-0 InstancedMesh still costs three a full render-object +
 * node-codegen setup per pass (main/shadow/outline mask). Instanced builder states are per mesh uuid
 * and can't be cached, so a part with gate-empty banks (a platform with `showRailings`/`showSupports`
 * off holds ~24 of them) runs ~3 codegen builds per empty bank at every first draw. That measured as
 * the largest share of the bulk-duplicate hitch (e2e/probes/dup-tick-breakdown.mjs). Invisible ⇒
 * projectObject skips it. The viewport instance pool owns visibility while a bank is folded into a
 * merged copy (`poolHidden`), so never touch a folded bank; the pool re-derives visibility at its
 * next rebuild.
 */
export function syncBankEmptyVisibility(mesh: InstancedMesh): void {
  // hidden by a merge seam (viewport instance pool / building static fold): that seam owns
  // visibility until its next rebuild, so don't change it here
  if (mesh.userData.poolHidden || mesh.userData.staticFoldSource) return
  const want = mesh.count > 0
  if (mesh.visible !== want) mesh.visible = want
}

/**
 * (Re)write the per-instance matrices + `count` onto an existing bank mesh. The caller guarantees capacity
 * (`instanceMatrix.count`) fits `instances.length` - realizeInstancedTemplate allocates a bucketed capacity
 * ≥ the count and the reconcile in sdkPart rebuilds the mesh only when the count outgrows that bucket, so
 * this only ever writes in-bounds.
 * A missing quaternion/scale is identity / unit, so the common case (axis-aligned scaled boxes) stays terse.
 */
export function writeInstanceMatrices(mesh: InstancedMesh, instances: readonly InstanceTransform[]): void {
  for (let i = 0; i < instances.length; i++) {
    const it = instances[i]!
    _pos.set(it.position[0], it.position[1], it.position[2])
    if (it.quaternion) _quat.set(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3])
    else _quat.identity()
    if (it.scale) _scale.set(it.scale[0], it.scale[1], it.scale[2])
    else _scale.set(1, 1, 1)
    _mat.compose(_pos, _quat, _scale)
    mesh.setMatrixAt(i, _mat)
  }
  mesh.count = instances.length
  mesh.instanceMatrix.needsUpdate = true
  if (instances.length > 0) mesh.computeBoundingSphere()
  else (mesh.boundingSphere ??= new Sphere()).set(_pos.set(0, 0, 0), 0) // empty bank: a valid, cull-safe sphere
  syncBankEmptyVisibility(mesh)
}

/**
 * {@link writeInstanceMatrices} for a bank whose count changes on its own: a roller bed sliding along its world
 * grid holds n rollers at one phase and n+1 at the next. A recorded render bundle bakes the instance count, so
 * every changed count is a re-record, and a drag would re-record on every other pointer-move. Instead the drawn
 * count holds at its high-water mark: surplus slots are parked as collapsed (zero-scale) copies of the first
 * instance, which draw no pixels and sit inside the bounds already. Returns whether the drawn count changed (it
 * grew, or the bank emptied), which the caller treats as structural.
 */
export function writeInstanceMatricesHeld(mesh: InstancedMesh, instances: readonly InstanceTransform[]): boolean {
  const held = mesh.count
  writeInstanceMatrices(mesh, instances)
  const n = instances.length
  if (n > 0 && held > n && held <= mesh.instanceMatrix.count) {
    mesh.getMatrixAt(0, _mat)
    _mat.decompose(_pos, _quat, _scale)
    _mat.compose(_pos, _quat, _scale.set(0, 0, 0))
    for (let i = n; i < held; i++) mesh.setMatrixAt(i, _mat)
    mesh.count = held
    return false
  }
  return mesh.count !== held
}
