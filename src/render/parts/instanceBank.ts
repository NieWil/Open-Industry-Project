import { DynamicDrawUsage, InstancedMesh, type BufferGeometry, type Group, type Material } from 'three'
import type { InstanceTransform } from '../../core/parts/partApi'
import { bucketCapacity } from './instanceCapacity'
import { writeInstanceMatrices } from './instancedTemplate'
import { retireInstancedMeshOnly } from '../gpuRetire'

/**
 * The single owner of per-part instance-bank capacity, growth, and the WebGPU mint-on-grow mechanics, for
 * rollers, axle stubs, legs, frame/leg bolts and array links (via `common.ts`'s `createInstancePool` /
 * `ensureInstanceCapacity`, thin facades over this). Keeping the "allocate → decide reuse-vs-grow → mint
 * fresh carrying render state → dispose" logic in one place gives one capacity policy (separate copies with
 * different policies let gizmo drags re-mint on every power-of-two step) and one place that knows about the
 * WebGPU coupling, so converging on a shared storage-buffer model (Tier 2) or deleting the workaround when
 * three fixes it upstream is a single-file change. See docs/webgpu-instancing.md.
 *
 * Why growth mints a fresh mesh (WebGPU): three's node backend keys the render pipeline on the mesh uuid and
 * captures `instanceMatrix.array` by reference, so a buffer can't grow in place. Enlarging it means a new
 * InstancedMesh (new uuid), which cold-compiles a pipeline on the draw path. Bucketing (instanceCapacity.ts)
 * keeps that off the interactive-resize path; this module mints only when a bank crosses a capacity bucket.
 * WebGL is unaffected (a fresh mesh is cheap; no pipeline recompile).
 */

/** The structural shape a growable bank exposes. `growBank` mutates `mesh` in place, so any consumer that
 *  cached `ref.mesh` must re-read it after a call that may have grown the bank. */
export interface BankRef {
  mesh: InstancedMesh
  parent: Group
}

/** The one mesh factory: bucketed initial capacity, live count 0, dynamic-draw instanceMatrix (rewritten each
 *  layout). Every per-part bank buffer is born here so the capacity floor is applied in exactly one place. */
export function makeBankMesh(geometry: BufferGeometry, material: Material, capacity: number, cast = true): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, bucketCapacity(capacity))
  mesh.count = 0
  mesh.castShadow = cast
  mesh.receiveShadow = true
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  return mesh
}

/** The one capacity policy: never shrink; grow to the next power-of-two bucket at ≥2× headroom, so a run of
 *  incremental climbs (a conveyor dragged longer) reuses one buffer and crosses few bucket boundaries. That
 *  keeps a continuous gizmo drag from re-minting (and so re-compiling) on every added piece. */
function grownCapacity(current: number, needed: number): number {
  return bucketCapacity(Math.max(needed, current * 2))
}

/**
 * Ensure `ref`'s buffer holds `needed` instances. Under capacity: a no-op; the caller reuses `ref.mesh` and
 * rewrites its matrices in place (same object ⇒ warm pipeline ⇒ no hitch). Over capacity: mint a fresh
 * InstancedMesh at the grown capacity and swap it under the parent, carrying every render-state flag the old
 * one had: geometry, material, shadow flags, layer mask and visibility. Dropping the layer mask would pull a
 * regrowing bank on OVERLAY_LAYER out of the overlay sub-pass. No structureVersion bump fires on a regrow, so
 * nothing re-tags the new mesh, and the mask is carried here.
 */
export function growBank(ref: BankRef, needed: number): void {
  const old = ref.mesh
  if (needed <= old.instanceMatrix.count) return
  const next = makeBankMesh(old.geometry, old.material as Material, grownCapacity(old.instanceMatrix.count, needed), old.castShadow)
  next.layers.mask = old.layers.mask // keep layer membership (OVERLAY_LAYER)
  next.visible = old.visible
  ref.parent.remove(old)
  // Retire, never dispose: a regrow swaps the mesh in a live scene, and no structureVersion bump
  // fires for it (see above), so a recorded render bundle still holds this mesh's per-instance
  // buffer by handle. Mesh-only: `next` was built on `old.geometry`, and
  // InstancedMesh.dispose frees the instance attributes, not the geometry (gpuRetire.ts).
  retireInstancedMeshOnly(old)
  ref.parent.add(next)
  ref.mesh = next
}

/**
 * OO face of the same mechanism, for banks authored against it directly. `mesh` identity is stable across
 * `write`s that stay within capacity (warm pipeline); it changes only when `ensure` must grow. `createInstancePool`
 * returns one of these, so every roller/leg/bolt/array pool already is an InstanceBank structurally.
 */
export class InstanceBank implements BankRef {
  mesh: InstancedMesh
  parent: Group
  constructor(parent: Group, geometry: BufferGeometry, material: Material, capacity: number, cast = true) {
    this.parent = parent
    this.mesh = makeBankMesh(geometry, material, capacity, cast)
    parent.add(this.mesh)
  }

  /** grow the buffer to hold `count` if needed (minting + carrying render state on WebGPU); reuse otherwise */
  ensure(count: number): void {
    growBank(this, count)
  }

  /** ensure + write per-instance matrices + set the live count: the declarative template-bank path */
  write(transforms: readonly InstanceTransform[]): void {
    this.ensure(transforms.length)
    writeInstanceMatrices(this.mesh, transforms)
  }

  /** swap the draw material (selection / ghost tint) without touching the instance buffer */
  setMaterial(mat: Material): void {
    if (this.mesh.material !== mat) this.mesh.material = mat
  }

  dispose(): void {
    this.parent.remove(this.mesh)
    // retire, like a regrow: a part teardown runs live, under recordings that hold this buffer.
    // Mesh-only: the geometry is the caller's (gpuRetire.ts).
    retireInstancedMeshOnly(this.mesh)
  }
}
