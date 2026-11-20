# WebGPU instancing: the resize and duplicate hitch

Extending an instanced part (a conveyor, for example) can stutter under WebGPU, because growing a bank past its
buffer mints a new InstancedMesh, and the buffer capacity is part of its vertex WGSL. **Capacity bucketing**
(`bucketCapacity`) keeps a resize under its allocated buffer, so no fresh mesh is minted. It works around a coupling in
three and is unnecessary once three keys render pipelines on structure (see
[What would make them unnecessary](#what-would-make-them-unnecessary)).

## How instanced meshes share pipelines under WebGPU

three's `WebGPURenderer` node system renders an InstancedMesh's `instanceMatrix` as a uniform buffer declared in the
vertex WGSL as `array<mat4x4<f32>, capacity>`. The buffer is named by its index within one shader build
(`nodeUniform<n>`), not by the mesh. The vertex program is cached by its WGSL string and the render pipeline by the
program ids (`stageVertex.id + stageFragment.id + backendState`). So two structurally identical banks at the same
capacity emit the same WGSL and share one program and one pipeline. Consequences:

- **Duplicate, instantiate, paste.** A copy of a part already in the scene reuses its banks' pipelines. What remains
  is the per-object node-to-WGSL **codegen**, which still runs synchronously for every new render object. For heavy
  parts the incremental pre-warm (`viewWarm.ts` `pumpWarm`) hides it: a freshly added part is held hidden while
  `compileAsync` runs its codegen off the draw path, then revealed. Measured with the pre-warm, a duplicate hitches
  about 90 ms (roller) and 120 ms (platform).
- **Resize, extend.** Growing a bank past its buffer capacity mints a **new** `InstancedMesh` (three also captures
  `instanceMatrix.array` by reference, so a buffer can't grow in place). A new capacity is a new shader, so the new
  object cold-compiles. That is the one-frame hitch when extending a conveyor.

Banks are minted in three places:

- `src/render/parts/instanceBank.ts` (`growBank` / `InstanceBank`) is the single mint site for per-part banks
  (rollers, axle stubs, legs, frame and leg bolts, array links). `common.ts`'s `ensureInstanceCapacity` and
  `createInstancePool` are thin facades over it.
- `src/render/parts/instancedTemplate.ts` (`realizeInstancedTemplate`) builds SDK `MeshPart.instances` banks. Its
  callers (`sdk/functionMesh.ts`, `sdk/rig.ts`) mint a new bank when the count outgrows its bucket. They do not go
  through `InstanceBank`.
- `src/render/viewport/instancePool.ts` (`ensureCapacity`), the scene-wide merged-hardware pool, has its own
  persistent-object lifecycle.

**WebGL is unaffected.** Instanced attributes are count-independent there, and buffer size is not part of the
pipeline key. This is a problem of the WebGPU node backend only.

## The structural model

Engines with a structural pipeline key draw these as one batched object and, on resize, set the instance count on the
**same** object. The per-instance transforms live in a **storage buffer bound at draw time**, and the compiled
pipeline is keyed on **shader + vertex format + framebuffer format**, not the buffer or the object identity. Growing
the buffer never invalidates the pipeline, because instance count is a runtime draw parameter, not a pipeline
property.

`e2e/verify-webgpu-duplicate-amortizes.mjs` runs real WebGPU (Dawn) and asserts that the second duplicate of a roller
conveyor adds at most 4 vertex programs (it adds 0). If a three bump puts a per-object name back into the WGSL, that
gate fails: every duplicate would then cold-compile its banks (about 14 vertex programs for a roller conveyor).

## Capacity bucketing (resize)

`src/render/parts/instanceCapacity.ts` (`bucketCapacity(n)`) rounds every instance-buffer request up to the next power
of two, with a floor of 128. The floor is high because capacity is baked into the shader (`array<mat4x4<f32>,
CAPACITY>`), so every distinct capacity is another pipeline. Floor 128 puts the demo's banks on two capacities and
saves 28 pipelines for about 0.85 MB more instance-matrix memory, measured with `e2e/probes/shader-similarity.mjs`
(see the header of `instanceCapacity.ts`). Because buffers are sized to a coarse bucket instead of exact-fit, a
typical interactive resize stays **under** the allocated capacity. The reconcile rewrites the same mesh's transforms
in place, the uuid and its warm pipeline are kept, and there is no hitch. A mint fires only when a resize crosses a
bucket boundary (O(log final size) over a whole drag, and never on the first small nudge from a loaded size). three
sizes the WebGPU instance uniform to buffer capacity, so drawing with `mesh.count` below capacity is correct. Above
the floor, a bank over-allocates less than 2x.

The capacity policy (bucket plus at least 2x doubling headroom) and the WebGPU mint-on-grow for per-part banks live
in `src/render/parts/instanceBank.ts` (`growBank` / `InstanceBank`). Every per-part bank grows through it, so a change
to the mint branch touches no call site. The scene pool and the SDK template banks are separate (see the mint sites
above).

**Verification:**
- `src/render/parts/instanceCapacity.test.ts`: bucketing properties (power of two at least n, under 2x waste,
  monotonic).
- `src/render/parts/instanceBank.test.ts`: reuse under capacity, mint-on-grow carries layer mask and
  shadow flag, doubling headroom, `write` / `dispose`.
- `src/render/parts/instancedTemplate.test.ts`: a bank reserves headroom above its live count (5 gives
  `bucketCapacity(5)` = 128).
- `e2e/verify-webgpu-resize-no-recompile.mjs`: real WebGPU, one `commit`. A modest extend adds instances and
  re-mints **0** bank meshes.
- `e2e/verify-webgpu-resize-drag-mints.mjs`: real WebGPU, the gizmo path. A 15-step `setTransient` drag adds ~170
  instances with re-mints bounded by bucket crossings, far below the step count.
- `verify-webgpu-leg-grow` checks that grown legs are not invisible.

## What would make them unnecessary

three keys render pipelines by program id (`Pipelines._getRenderCacheKey` is
`stageVertex.id + ',' + stageFragment.id + ',' + backend.getRenderCacheKey(renderObject)` in
`three/src/renderers/common/Pipelines.js`). The capacity workaround is unneeded if three either:

1. keys **render** pipelines on a structural key (shader + binding layout) rather than the mesh, **or**
2. binds `instanceMatrix` as an **index-read storage buffer** decoupled from the node graph and the object id.

Then `growBank`'s mint-fresh branch and `bucketCapacity` can both go. Because every per-part bank
grows through `InstanceBank`, removing the mint branch is a one-file change. Related upstream issues:

- [mrdoob/three.js#32099](https://github.com/mrdoob/three.js/issues/32099): an InstancedMesh's instance count is
  baked at first render under WebGPU. Closed as not planned: growing past the first render is not supported.
- [mrdoob/three.js#32735](https://github.com/mrdoob/three.js/issues/32735): the pipeline cache is keyed on
  `node.id`, with a proposal for a structural key, scoped to compute pipelines. The same idea applied to render
  pipelines would remove the coupling.

The project does not carry a private patch against three for this.

## BatchedMesh for what the instance pool cannot take

The meshes the instance pool cannot take (moving rig links, jointed parts) each draw on their own. Batching them into
material-keyed `BatchedMesh`es would cut the demo's WebGL draws from 339 to 240 (measured), but the app does not do
it:

- WebGPU has no multi-draw, so three draws a `BatchedMesh` as one draw per instance. The gain is zero there, and the
  same mechanism in `staticFold` took idle WebGPU draws from 22 to 99 when tried.
- Per-instance culling cannot help under render bundles, which record the draw list once.

A batching path would need a WebGPU indirect or multi-draw path for `BatchedMesh` in three. It would also need one
invalidation seam shared with `instancePool`, not a separate manager that re-derives the pool's `poolUnit` /
`poolHidden` flags: the pool changes those flags behind its exempt-key gate, so a separate manager goes stale after a
selection.
