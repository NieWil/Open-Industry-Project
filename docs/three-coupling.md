# three.js coupling ledger

Every place this codebase depends on three beyond its public API, in one place. **Read this
before bumping three, and update it when you add or retire a coupling.** The upgrade checklist
at the bottom is the whole playbook: a bump should be a checklist run, not a search through history.

Version policy: `package.json` pins `"three": "^0.187.0"` - caret on a 0.x package admits only
patch releases (0.187.x), so a bump is always a deliberate edit here, never lockfile drift.
Take each minor release as it ships rather than letting several pile up: the patches below are
re-checked against one release's changes at a time, and a moved internal is a small port while the
gap is one release wide.

Patches target three 0.187. The Tier 1 patches rely on these internal shapes: `_pipelines.getForRender(renderObject, promises)`,
`_pipelines.caches` and `renderer._objects`. Projection is `renderer.drawingPipeline.project(object, camera, groupOrder, renderList,
clippingContext)`: public API since r187 (`StandardDrawingPipeline`, marked experimental upstream), and it recurses
through `this.project`, so a wrapper on the instance sees every visit. Assigning a new `drawingPipeline` drops
both projection wrappers.
`NodeMaterialObserver` tracks `bufferWidth/Height` for every render object and watches `wireframe`. The replay
patch works beside it.

One type-level coupling: `@types/three` 0.187 gives `texture()` a generic overload, so `ReturnType<typeof texture>`
widens to `TextureNode<unknown>`, which `textureLoad` rejects. consolidatedOutlineNode.ts names the vec4
instantiation (`ReturnType<typeof texture<'vec4'>>`), since @types/three exports no `TextureNode` by name.

## Tier 1 - internals monkeypatches

The three patches follow one convention: **feature-detect the r187 shape, degrade by failure semantics,
ship a kill-switch, name a retire condition.** Where stock behavior is merely slower, the patch
silently no-ops; where stock behavior is *wrong*, it fails loud and forces the safe path. Keep
that asymmetry when adding a new one. The last two rows are the exception: diagnostic probes that only
count, so they change no output and ship no kill-switch.

| Patch | three internals touched | On shape move | Kill-switch | Verified by |
|---|---|---|---|---|
| [bundleReplayRefresh.ts](../src/render/viewport/bundleReplayRefresh.ts) - replay-frame refresh + camera patch for render bundles | `Renderer._renderBundle`, `_bundleNeedsUpdate`, `_bundles`, `backend.draw/addBundle/updateBinding`, `_nodes.*` incl. `getNodeFrameForRender`, `_geometries`, `_bindings`; `RenderObject.getNodeBuilderState().updateNodes/updateBeforeNodes`, `RenderObject.camera` (record-capture filter), `Node.getUpdateType/getUpdateBeforeType`, shared `NodeUniformsGroup`s; shared-NodeFrame semantics (see [Render-bundle replay](#render-bundle-replay)) | **Loud**: console warn + `forceBundleLiveSplit()` (movable parts leave the bundles, camera moves re-record) - stock replay silently freezes rig poses, so a quiet no-op is not safe. The record-time derivations (`deriveCamNodes` → `deriveNodeCover` → full list) each fall back a layer independently; an all-filtered-out record capture falls back to the raw list with a console warn. | `?nobundlecam` (patch), `?nobundle` (bundles entirely); sub-mode `?bundlelive` | `e2e/verify-render-bundles.mjs` (the gate), `e2e/probes/bundle-campatch.mjs`, `e2e/probes/bundle-rig-freeze.mjs`, `e2e/probes/roof-load-camera.mjs` (parked-load stale-camera regression), `e2e/probes/hide-building-parity.mjs` (nested-shadow-render camera-poison regression), `e2e/verify-bundle-camera-integrity.mjs` (curated gate - forces a nested shadow render inside the bundle walk and asserts the camera singleton survives it), `e2e/probes/sim-dirty-census.mjs` (escape detector), unit spec `bundleReplayRefresh.test.ts` |
| [subPassCache.ts](../src/render/viewport/subPassCache.ts) - cached projection for the overlay + mask sub-passes | `drawingPipeline.project` bracketing, render-list `push/pushLight` capture (stock `pushRenderItem` calls `renderList.push`) | silent no-op → stock full-graph traversal (perf-only; analyzed in its header) | `?nopasscache` | diagnostics `globalThis.__oipSubPassCache` ({records, replays}); idle CPU probes. Retire if three's bundle-children skip reaches inert-bundle passes. |
| [instancedRaycast.ts](../src/render/instancedRaycast.ts) - far-aware per-instance raycast gate (pilot ray fan / crosshair cargo pick) | replaces `InstancedMesh.prototype.raycast`; leans on the r187 shape: `instanceMatrix.array` 16-float column-major stride, module-`_mesh` narrow-phase delegation (composes with the three-mesh-bvh `Mesh.raycast` patch), `Ray.distanceSqToPoint` origin-clamp semantics, unit `ray.direction`. Skips instances whose world bounding sphere misses the ray or lies beyond `raycaster.far` / short of `near` - stock tests every instance with 2 matrix ops + an invert and never consults `far` | silent delegate to the captured stock function on any unexpected shape (slower, never wrong); the gate is strictly conservative, survivors run stock narrow phase → identical Intersections | `?stockinstraycast` | canary `src/render/instancedRaycast.test.ts` (patched vs captured-stock parity over aimed + random sweeps - fails the suite if a bump moves semantics); `e2e/verify-pilot-collision.mjs`, `verify-mesh-pick.mjs`, `verify-instance-pool.mjs` (pick parity); perf probe `e2e/probes/pilot-walk-cpu.mjs`. Retire when three's own instanced loop prunes by `ray.far` per instance. |
| [projectionStats.ts](../src/render/viewport/projectionStats.ts) - per-pass projection visit counters, installed on every WebGPU boot (createRenderer.ts `installProjectionStats`) | replaces `renderer.drawingPipeline.project` with a counting wrapper (the same method subPassCache brackets, so the two wrap one function), keyed by pass from the camera and its layer mask; it forwards every argument, so a parameter three adds still arrives (it relies only on `camera` being the second) | silent no-op: no wrapper and no `__oipProjStats` (a diagnostic probe; nothing reads it to decide anything) | none | diagnostics `globalThis.__oipProjStats` (`visits` per pass: `main` / `walls` / `wallA` / `wallB` / `overlay` / `other`, `reset()`). A missing global after a bump means the shape moved. |
| `withCompileLedger` ([viewWarm.ts](../src/render/viewport/viewWarm.ts)) - the compile ledger for every staged phase, scene swap and interaction-extras burst | wraps `_pipelines.getForRender(renderObject, promises)` while a compile runs, counting items and live-path mints and timing each pipeline promise; it hands every promise back to three, which awaits them itself | silent no-op: the compile runs unwrapped and the `__oipCompilePhases` item and pipeline keys are missing | none | `globalThis.__oipCompilePhases` / `__oipPipelineTimes`, read by `e2e/probes/compile-phases.mjs` and by the curated gate `e2e/verify-webgpu-warm-completeness.mjs` (`phase2Items`), which fails if the key goes missing. |

### Render-bundle replay

[bundleReplayRefresh.ts](../src/render/viewport/bundleReplayRefresh.ts) lets a camera move refresh the
replayed render bundles instead of re-recording them (bundleGroups.ts `markBundleCameraState`), which keeps
orbit off the encode path. It is on by default; `?nobundlecam` reverts it. Measured by
`e2e/probes/bundle-campatch.mjs`.

**Why it can work.** A render bundle stores commands and resource handles, never uniform bytes. Nothing
camera-shaped is per-draw (`modelViewMatrix` is GPU-computed; camera matrices and position are global
uniform nodes in the shared 'render' group), so fresh bytes in those buffers reach every replayed draw.
Stock replay leaves them stale because `Bindings._update` gates shared groups behind
`NodeManager.updateGroup`, a version compare that replay frames don't reliably bump.

**What the patch does.**

- **Record:** wraps `backend.draw` to capture the renderObjects actually encoded (three's own
  `renderBundleData.renderObjects` desyncs from them), plus two per-recording derivations: the
  camera-sensitive subset (viewTick ancestry) and the deduped shared uniforms groups.
- **Replay, active frames (part 1):** refresh the always-active bucket plus parts marked dirty this frame.
  The bucket holds only unmarkable mutators, and marks carry the rest (pools via `markPool` and the pool backstop, the matrix walk via poseRev,
  ticks/viewTicks that report a mutation, syncScene edits). Ticking uniforms (scroll, spin) live in the
  shared tick group (parts/tickUniformGroup.ts) and ship as one byte upload (part 1.5).
- **Replay, camera-only frames:** refresh just the camera-sensitive subset.
- **Replay, every view-camera frame (part 2; shadow bundles keep stock behaviour):** re-ship the camera into
  the recording's shared groups. This is unconditional, because those groups are frozen at record time: a
  scene recorded before the projection settled and never orbited would replay a stale camera forever. It
  refreshes uniform values over the cam-node set (deriveCamNodes: the deduped non-OBJECT update nodes, one
  representative draw per NodeBuilderState; deriveNodeCover is the fallback), then forces `update()` and
  `backend.updateBinding()` on each shared group, bypassing the version gate. `UniformsGroup.update()`
  byte-compares, so parked values upload nothing.
- **Replay, camera repair:** if that walk ran a nested render, re-run its update
  lists before the upload. The camera family are singleton nodes fed from `frame.camera`, which
  `_renderScene` doesn't restore, so a ShadowNode's pass leaves them holding the light camera. Detected via
  `info.calls` (always bumped, never restored), so clean frames skip it. Gate:
  `e2e/verify-bundle-camera-integrity.mjs`.
- **Stale-recording guard:** re-record instead of replaying when three has disposed a RenderObject this
  recording baked (its cache key changed: material version bump, material or geometry dispose).
  `bindings.deleteForRender` refcounts bind groups and destroys buffers at zero, so a stale recording either
  submits destroyed buffers or, refreshed, resurrects the draw with a released null texture ("Cannot read
  properties of null" in `updateSampler`). Disposals are counted by wrapping `bindings.deleteForRender`, so
  the O(draws) liveness scan runs only on a frame with one. Invalidation clears the recording's `version`,
  never `bundleGroup.needsUpdate`, which would invalidate every (camera, renderContext) bundle of the group.

**Shared-NodeFrame semantics, and why the repair pass exists.** A nested render (ShadowNode.updateBefore's
shadow-map pass) restores `renderId` but leaves `camera/object/material` pointing at the nested pass's. The
cam-node walk re-fetches its frame after before-nodes, and the record capture filters draws to this bundle's
(context, camera), or nested shadow draws poison every derived list (the stale shadow-camera "zoomed-out
isometric" flash). The re-fetch only fixes the group that nest-rendered. Because the cam-node set is deduped
globally, the camera family has one owner, so a shadow node in a later group is left stale. Hence the
**repair pass**, gated on `Renderer.info.calls` having moved across the walk (a nested render always bumps
it and it is never restored) and made exact by `NodeFrame`'s renderId-stamped render gate.

**When the repair matters.** A shadow node fires at most once per render call, and the repair matters when that
first touch is part 2's walk, in a group after the camera owner. That happens when an unlit material (such as a
baked wall's `MeshBasicMaterial`: camera nodes, no shadow node) is the first group of a bundle and a lit material
comes later. Which group comes first is three's render-list sort, so it varies by scene: in the demo a lit
material sorts first, its group owns both the camera family and the shadow node, and the re-fetch after
before-nodes already covers it. `verify-bundle-camera-integrity` therefore builds the hazardous order itself (it
moves the shadow node to a later group when the scene's order lacks it) and asserts DIRTY 0. With the repair
disabled, every check reads DIRTY.

**Shadow-pass `alphaTest` churn is not patched.** An alpha-tested shadow caster churns the shadow pass's material
version every frame, a CPU cost that grows with the number of such casters: slower, never wrong. No gate tracks it
(a one-off A/B put it near 1.8 ms a frame at 100 belts). Nothing in src/ or the shipped GLBs (no `alphaMode: MASK`)
sets an `alphaTest` above 0. The side guards' beam cutouts are geometry (core/guards/guardHoles.ts) for this reason. An
imported MASK model brings the cost. Measure its frame cost before adding a patch for it.

## Tier 2 - behavioral assumptions on public API

These use public API but lean on r187 *behavior*. Each has a canary or gate.

- **GPU time per frame** ([frameMeter.ts](../src/render/viewport/frameMeter.ts)) - after each
  `resolveTimestampsAsync()` the view reads `backend.timestampQueryPool.render.timestamps` (documented fields,
  the map three's own Inspector reads through `getTimestamp(uid)`), whose keys end `:f<frameId>` (`Backend`'s
  timestamp uid), and counts every frame once. It relies on three inserting a frame's passes together and frames
  in order. If the pool or the key format moves, the stats window's gpu line shows "-" and "limited by the GPU"
  falls back to elimination; nothing else reads it. Canary: `frameMeter.test.ts` pins the parsing; after a bump,
  `?stats` on the demo must show a gpu line with a value.

- **OrbitControls private fields** ([view.ts](../src/render/viewport/view.ts)) - the wheel belongs to
  the view's cursor zoom ([wheelZoom.ts](../src/render/viewport/wheelZoom.ts)), so the constructor
  detaches `OrbitControls._onMouseWheel` from the canvas (`enableZoom = false` would also kill the
  touch pinch). If that field moves the view warns once and both zooms run (two steps per
  notch, toward two different points), so the check after a bump is: one wheel
  notch over the demo moves the camera exactly `WHEEL_ZOOM.perNotch`, no console warning.
  `cancelNavigation` / `setCameraPose` ([viewCamera.ts](../src/render/viewport/viewCamera.ts)) also zero `_sphericalDelta` and `_panOffset` to flush the
  damping, and `endOrbitSnap` zeroes `_sphericalDelta` so an orbit released on a snapped view stays there. Gates:
  `e2e/verify-wheel-zoom.mjs`, `e2e/verify-orbit-snap.mjs`.

- **OrbitControls modifier swap + `update` override** ([view.ts](../src/render/viewport/view.ts)) - two
  behaviours of r187's OrbitControls the camera navigation (core/navigation.ts) is built on. (1) At
  pointerdown, `_onMouseDown` swaps ROTATE and PAN when Shift, Ctrl or Meta is held, so the view sets
  `mouseButtons.MIDDLE` to the style's plain action and never swaps it itself (doing both would make
  Shift+middle orbit). (2) Orbit around selection turns about a pivot by wrapping the instance's
  `update` (`updateOrbitControls`, [viewCamera.ts](../src/render/viewport/viewCamera.ts)), because the pointer handlers call `this.update()` themselves
  mid-gesture; a wrapper around the frame loop's call alone would leave part of each turn about the target.
  If either moves, Shift+middle stops swapping or the selection drifts on screen while orbiting.
  Gate: `e2e/verify-nav-style.mjs`.

- **OrbitControls ends a drag on a document `pointerup`** ([view.ts](../src/render/viewport/view.ts)
  `endLostNavigation`) - a drag whose release was lost (Alt-Tab mid-orbit) is ended by dispatching a synthetic
  `pointerup` for the held pointer on `domElement.ownerDocument`, where r187 adds its pointerup listener at
  pointerdown. If OrbitControls moves that listener, the synthetic release goes unheard and the camera again
  follows the hover until the next click. The gate reads `controls._pointers` to see the pointer let go.
  Gate: `e2e/verify-drag-lost-release.mjs`.

- **Owned world-matrix walk** - `scene.matrixWorldAutoUpdate = false`; the view owns the walk,
  poseRev/structRev drive freezes. Canary: `src/render/viewport/matrixWalk.test.ts` (in
  `npm test` - fails the suite if a three bump changes matrix semantics). Gate:
  `e2e/idle-matrix-gate.mjs`, `e2e/verify-matrix-freeze.mjs`.
- **Identical instanced banks share one program** - three names an instanced uniform buffer by its index within
  one shader build (`nodeUniform<n>`), so two structurally identical banks at the same capacity emit the same WGSL
  and share a program and pipeline. A duplicated conveyor then compiles nothing new. If a bump puts a per-object
  name back (0.186 used `NodeBuffer_<id>`), every duplicate cold-compiles its banks again. Gate:
  `e2e/verify-webgpu-duplicate-amortizes.mjs`; background: [webgpu-instancing.md](webgpu-instancing.md).
- **Instanced uniform sizing** - three sizes each InstancedMesh's instance-matrix uniform to
  buffer *capacity*, not the count at first compile, so cargo spawned after the first compile is drawn.
  Gates: `e2e/verify-webgpu-cargo-visible.mjs`, `verify-webgpu-authored-cargo-visible.mjs`.
- **WebGPU texture image swap** - the backend keeps the GPUTexture allocation when a texture's
  image is swapped to a different size; we `dispose()` after decode. Audit seam:
  `gpuTextureAudit.ts` (`window.__oip.view.auditGpuTextures()`), gate
  `e2e/verify-webgpu-belt-weave-live.mjs`.

- **Texture view cache keyed by size and mip count** - r187's `WebGPUBindingUtils.createBindGroup` caches a
  texture's GPUTextureView on its backend data as `view-<w>-<h>-<mips>-<base>` and never clears it when
  `Textures.updateTexture` replaces the empty 1x1 single-mip default with the real upload. A real image of that
  same shape binds the default's view and samples black for the session. The loader's failed-fetch fallback
  ([gltf.ts](../src/render/gltf.ts) `fallbackImage`) is therefore 2x2. Gate:
  `e2e/verify-texture-fail-fallback.mjs` (its "late" leg fails a texture after the viewport has drawn; with a
  1x1 fallback it reads ~42% luminance on WebGPU). Retire the 2x2 when three clears the view cache on re-create.
- **Material dispose ⇒ RenderObject dispose ⇒ `bindings.deleteForRender`** - the reason
  [gpuRetire.ts](../src/render/gpuRetire.ts) has `retireGeometry`/`retireTexture` but
  no `retireMaterial`. In r187 a `material.dispose()` fires `RenderObject.onMaterialDispose` →
  `RenderObject.dispose()` → `RenderObjects`' `onDispose` → `bindings.deleteForRender(ro)`. That is
  the call `bundleReplayRefresh.ts` wraps to count disposals, so the stale-recording guard
  invalidates and re-records any bundle holding that draw on the same frame, before its replay can
  submit the destroyed bind-group buffers. Geometry and textures never had that cover (three only
  nulls the RenderObject's cached attribute list on a geometry dispose, and does nothing at all on
  a texture dispose), which is what gpuRetire's queue exists for. r187's `_bundleNeedsUpdate` also
  re-records a bundle whose attribute buffers were disposed, but it checks three's own
  `renderBundleData.renderObjects`, which desyncs from the encoded draws, and textures have no such check,
  so the queue stays. If a bump stops disposing the
  RenderObject on a material dispose, or routes the free elsewhere, materials silently join the
  hazard: a black bundled pass with no throw. Gates:
  `e2e/verify-webgpu-resize-no-gpu-errors.mjs`, `verify-webgpu-spur-slide-no-gpu-errors.mjs`,
  `verify-warm-load-no-gpu-errors.mjs` (all read the `__oipGpuErrors` tally).
- **`shadow.mapSize` changes destroy a live shadow map - so we never change one.** r187's
  `ShadowNode.renderShadow` calls `shadowMap.setSize(shadow.mapSize…)` on every shadow render, and
  `RenderTarget.setSize` **disposes** whenever the size differs - destroying the `ShadowDepthTexture`
  that recorded render bundles hold by handle. Under WebGPU a resize blacks out the whole bundled main
  pass (Dawn reports "Destroyed texture [ShadowDepthTexture] used in a submit" and every bundled pass goes
  dark), and `gpuRetire.ts` cannot prevent it, because the free happens inside three, not at one of our
  call sites. On the WebGPU node path `ShadowNode` owns its render target separately from
  `light.shadow.map`, so disposing `light.shadow.map` is not the fault. **Closed by pinning, not by fixing
  three:** the resolution is a per-client preference resolved once at boot (`src/render/quality.ts`
  `shadowMapSize`), and `env.ts`'s `setLighting` has no resize path at all. The hazard is intact upstream,
  so anything that resizes a live shadow map - a new quality slider, a light rebuild, a tier switch
  mid-session - re-opens it.
  Check with `node e2e/probes/shadow-quality-black.mjs` (shoots both ends of the range, one page each).
- **Render bundles execute last, in scene-child order** - three records bundles at the top of the
  pass (`Renderer._renderObjects` → `_renderBundles` → `renderBundles.push`) but the backend only
  replays them in `finishRender` → `executeBundles`, *after* every non-bundled opaque and transparent
  draw. Two consequences we depend on. (1) Nothing drawn in the base transparent pass can sit on top
  of bundled content - which is why the flow arrows, sensor beams and the floor grid all render from
  the post-main overlay sub-pass instead (viewRegistries.ts `collectOverlays`). (2) The relative order of two
  bundle groups is a draw order, so a group holding `depthWrite:false` transparent draws must come
  last among them: [bundleGroups.ts](../src/render/bundleGroups.ts) `mountOpaqueBundleGroupBefore`
  mounts the opaque-only merges (instance pool output, part batches) ahead of `view.partsGroup`,
  which carries the rig cues. Appended after it, the pool's merged conveyor hardware would paint over
  every spawner/despawner marker's fill, and flicker against it while a scene loads, since a
  structural change renders the odd frame unbundled and correctly. Gate:
  `e2e/verify-cue-over-bundles.mjs` (parity vs `?nobundle`). If a bump changes when bundles execute
  or how their order is derived, that gate fails and the overlay-pass rationale needs re-checking.
  The insert is immediately before the parts group rather than at index 0, to keep the reorder as
  small as possible - only the merge's order relative to the group it merges from matters,
  so env.ts's lights and containers keep their places.
- **`compileAsync` semantics** - `compileStaged`/`pumpWarm` rely on compileAsync projecting
  visibility synchronously at call time and restoring shared renderer state before suspending
  (documented at their definitions in viewWarm.ts). Since r187 two calls must never overlap: a call keeps
  `_precompilationState` (and the render context and target it swaps in) on the renderer while it awaits a
  node build, so a second call started then overwrites it and the first throws on resume. Every WebGPU
  `compileAsync` therefore runs in viewWarm.ts's compile lane (`inCompileLane`), and a burst compiles its
  roots one at a time. Inside one call r187 keeps up to 16 pipelines in flight, which is why we no longer
  feed Dawn ourselves (measured on the demo, 3 cold runs per arm: ours vs three's own loop differed by
  +108 ms on the cover for phase 1 and -60 ms for phase 2, both within the run-to-run spread). The settle signal `view.incrementalWarmReady`
  (owned by `ViewWarmState` in viewWarm.ts; RenderView forwards it under that name as a test hook)
  is what e2e waits on (see verify-render-bundles.mjs). A wait that returns before the warm settles
  measures compile noise, not the change under test.
- **A compile scoped to a root still walks the whole target scene** - `compileAsync(root, camera, scene)` projects
  only `root`, then traverses every visible object of `scene` to collect its lights. So one call per object costs
  objects x scene. The interaction warm compiles the pooled hidden sources in batches for that reason (`borrowed`
  in viewWarm.ts): a holder `Group` whose `children` are the sources themselves, left under their own parents. That
  relies on the projection reading only `visible`, `children` and each object's own world matrix, and on
  `compileAsync` updating the root's matrices only when `matrixWorldAutoUpdate` is set, which the holder turns off.
  If a three bump makes the projection read `parent`, or update matrices unconditionally, the batch must go back to
  one root per source or the sources be compiled under a real common ancestor.
- **Shared uniform groups are version-gated** - the per-frame tick uniforms (roller/turntable spin,
  belt and chain scroll) join one shared uniform group
  ([tickUniformGroup.ts](../src/render/parts/tickUniformGroup.ts)), relying on `Bindings._update`
  re-uploading a shared group only when `groupNode.version` moves. Since r187 a shared bind group is one
  per render context, not one per renderer: `Bindings.getSharedBindGroup` keeps the original for the first
  context and clones it for each later one, and `NodeManager.updateGroup` keys its version record on
  (groupNode, binding), so each clone sees a version bump once. Part 2 of the replay patch uploads the
  clones its recording references. createRenderer.ts wires
  `bumpTickUniformGroup` into common.ts's `setTickUniformBump` seam so a tick that advanced bumps
  the version. On bundled replay frames bundleReplayRefresh uploads the tick bindings itself; the
  version gate is what carries stock frames (`?nobundle`, re-records, overlay/XR passes). If a bump
  stops gating on the version (or starts ignoring it), belts and rollers freeze on stock frames -
  wrong pixels, no error.
- **One LightsNode per scene ⇒ a mesh may be drawn in exactly one of the layered sub-passes.**
  `Lighting.getNode` keys its LightsNode by scene alone, and each pass swaps that one node's light
  array (`beginRender`/`finishRender`). A `RenderObject` is chain-keyed on
  (object, material, renderContext, lightsNode). The layered sub-passes share all four, since they
  reuse one scene, camera and render target. Its validity key `getDynamicCacheKey()` hashes
  `_nodes.getCacheKey(scene, lightsNode)`, the light set live at creation. So a mesh reachable from
  two sub-passes is disposed and rebuilt by `RenderObjects.get` on **every fetch**. Each disposal trips
  the bundle patch's stale-recording guard, so the scene re-records every frame and draws about ten
  times as many calls. So the walls have no sub-pass of their own: their light is baked and
  they draw in the main pass. The rule applies to the overlay pass: its
  meshes are hidden through the scene pass (`collectOverlays`), so each draws in exactly one. The
  pass selects by camera layer mask, so anything carrying `OVERLAY_LAYER` is drawn there.

- **Pipeline-cache size as an observable** - `renderer._pipelines.caches.size`, read by
  `cacheSizeOf` (viewCompileLedger.ts, into `globalThis.__oipCompilePhases`), `e2e/probes/pipeline-census.mjs`,
  `e2e/probes/post-cover-hitches.mjs`, and
  `e2e/verify-webgpu-mobile-singlepass.mjs`, whose `mintedAfterSettle === 0` check asserts the
  mobile tier compiles nothing on the draw path once the scene has settled. It is a private field
  read for diagnosis, never mutated, so a shape move cannot make the app wrong. It can turn a
  curated gate into a false PASS: `?? 0` on both samples means a renamed cache reads as "0 minted",
  which is the passing value. On a healthy build both samples also read 0, since the pre-warm reaches
  every material the settled demo draws. So the canary is the cache size itself. It read 106 on the
  settled demo when last measured and grows by one when a never-drawn material appears (showing the grid takes it
  to 107). A
  size of 0 or -1 means the field moved. This is the draw-budget rule from AGENTS.md: an improvement
  nobody can explain is not trusted.

## Upgrade checklist (any three bump)

1. Bump `package.json`, then **delete `.types/`** before typechecking (stale `tsc -b` cache
   hides real errors - see AGENTS.md).
2. `npm test` - the canaries (`matrixWalk.test.ts`, `bundleReplayRefresh.test.ts`,
   `bundleReplayPools.test.ts`) fail fast on moved semantics.
3. Boot the demo (`/app/?webgpu&scene=demo`) with the console open. A loud
   `render-bundle replay-refresh patch: three internals moved` warn means the replay patch needs
   re-porting (the app stays correct via the forced `?bundlelive` split, at ~15× the idle draws).
   The warn lists the missing internals by name. There is no version compare, and the "r187" in its
   text is only a label. The warn means a field is absent from the running renderer: a moved
   internal, a stale build or service worker serving an older three, or a renderer not on
   `WebGPUBackend`.
4. Headed gates, in order of information density: `e2e/verify-render-bundles.mjs` (primary),
   `idle-matrix-gate.mjs`, `webgpu-smoke.mjs`, `verify-webgpu-cargo-visible.mjs`,
   `perf-webgpu-load.mjs` (load time ≈ baseline).
5. Silent no-op patches show as **perf regressions, not failures** - check the diagnostics:
   `__oipBundleCam.camNodesTotal > 0` (cam-node walk engaged; each recording that fell back
   subtracts 1), `__oipBundleCam.staleSkipped`, `staleRecords` and `camRepairs` all 0 on the settled
   demo, `verify-render-bundles` parity 0% on every axis, `__oipSubPassCache.replays > 0`
   (sub-pass cache engaged).
6. Update the current-version references in each patch header - and this ledger.
7. **Draco decoder URLs** (not a patch, but a prod-only dependency on an addon default):
   `render/dracoDecoder.ts` calls no `setDecoderPath`, relying on r187's `DRACOLoader` resolving
   `../libs/draco/gltf/*` through `new URL(…, import.meta.url)` so vite emits the decoder into
   hashed, same-origin `/assets/*`. If a bump ever changes that default to a CDN, every
   Draco-compressed rig GLB (`TEXTURE_ONLY` in `scripts/optimize-assets.mjs`) fails to parse
   **in prod only** - COEP require-corp blocks the cross-origin decoder, and dev serves
   uncompressed models that never touch it. Check for `draco_decoder-*.wasm` in `dist/assets/`
   after a build.

## Kill-switch index

`?nowebgpu` (WebGL fallback) · `?nobundle` · `?nobundlecam` · `?bundlelive` ·
`?nopasscache` · `?serialcompile` · `?noinstancepool` · `?stockinstraycast`

Diagnostics globals: `__oipBundleCam` (bundle patch counters), `__oipSubPassCache`,
`__oipProjStats` (per-pass projection visits),
`__oipBundleCamWalk` (probe A/B seam: `'full' | 'cover'` | unset = cam-nodes).
