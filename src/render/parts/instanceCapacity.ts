/**
 * Round an instance-buffer request up to a coarse capacity bucket.
 *
 * Mitigates the WebGPU resize hitch. Under three's WebGPU backend the node builder captures the
 * instanceMatrix array by reference and keys the pipeline on the mesh uuid. Growing past capacity therefore
 * mints a new InstancedMesh, which cold-compiles a pipeline on the draw path. That is the stutter on the first
 * conveyor extend (mint sites: viewport/instancePool.ts, parts/common.ts:ensureInstanceCapacity).
 *
 * With coarse buckets a typical resize stays under capacity (same mesh, warm pipeline). A mint happens only
 * when a bucket boundary is crossed, O(log size) per drag instead of per pointer-move. three sizes the WebGPU
 * instance uniform to the buffer's capacity, so drawing `mesh.count` < capacity is correct. WebGL is
 * unaffected either way.
 *
 * ## The floor is 128 because capacity is baked into the shader
 *
 * The WGSL declares `array<mat4x4<f32>, CAPACITY>`, so identical banks at different capacities are
 * different shaders and separate cold compiles. No cache key can merge them, because a shader may
 * never be bound a buffer smaller than it declares. The fix is fewer distinct capacities.
 *
 * Measured on the demo (`e2e/probes/shader-similarity.mjs`): floor 128 puts its banks on two capacities and
 * removes most of the pipelines a floor of 8 mints. 256 saves only a few more for several times the
 * instanceMatrix memory, so the floor is 128.
 *
 * Every mint site sizes through this, including fixed-size banks (the building's module/cladding/column
 * banks, the cargo batch, the flow-arrow and sensor-beam banks). Exact fit there would give
 * non-power-of-two capacities (5, 10, 13, 20, 200), each one its own shader.
 *
 * Callers must set `mesh.count` to the live count after construction. three's InstancedMesh constructor
 * initialises `count` to the capacity, and both bounds (`computeBoundingSphere`) and raycasting iterate
 * `count`, so leaving it at capacity would draw and hit-test empty slots.
 *
 * docs/webgpu-instancing.md lists the upstream issues that would let us delete this.
 */

/** Smallest bucket. Also the floor: a bank still gets headroom, and a 0-length buffer is impossible. */
const FLOOR = 128

export function bucketCapacity(n: number): number {
  let cap = FLOOR
  if (!Number.isFinite(n) || n <= cap) return cap // guard: a non-finite request must not spin the loop below
  while (cap < n) cap *= 2
  return cap
}
