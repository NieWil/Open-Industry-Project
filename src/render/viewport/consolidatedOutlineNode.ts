import { Color, ColorManagement, DepthTexture, HalfFloatType, RenderTarget, Vector2 } from 'three'
import type { Camera, ColorSpace, Object3D, PerspectiveCamera, Scene, Texture } from 'three'
import { MeshBasicNodeMaterial, RenderPipeline } from 'three/webgpu'
import type { WebGPURenderer } from 'three/webgpu'
import {
  Discard,
  Fn,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  int,
  ivec2,
  max,
  orthographicDepthToViewZ,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  screenUV,
  select,
  smoothstep,
  texture,
  textureLoad,
  uniform,
  varying,
  vec2,
  vec4,
} from 'three/tsl'
import { bundleActivitySerial, bundleGroupsRegistered, bundleReplaySuppressed, setBundlesActive, wantsBundleLiveSplit } from '../bundleGroups'
import { beginPassCapture, endPassCapture } from './subPassCache'
import type { ISelectionOutline } from './outline'
import type { OutlineMaskMergeSurface } from './outlineMaskMerge'

/** three 0.187 gives `texture()` a generic overload, so `ReturnType<typeof texture>` resolves against
 *  it and widens to `TextureNode<unknown>`, which `textureLoad` (vec4) does not accept. Name the
 *  vec4 instantiation once; @types/three does not export TextureNode by name. */
type Vec4TextureNode = ReturnType<typeof texture<'vec4'>>
import {
  ACTIVE_HIDDEN_EDGE,
  ACTIVE_VISIBLE_EDGE,
  EDGE_FEATHER,
  EDGE_STRENGTH,
  HIDDEN_EDGE,
  VISIBLE_EDGE,
} from './outline'
import { OVERLAY_LAYER } from '../env'
import { SEL_ATTR, batchHasSelection } from './selTierChannel'
import { renderQuality } from '../quality'

type LayeredRenderer = WebGPURenderer & {
  autoClear: boolean
  shadowMap: { autoUpdate: boolean }
  setRenderTarget(target: RenderTarget | null): void
  clear(): void
  render(scene: Scene, camera: Camera): void
  renderObject(...args: unknown[]): void
  setRenderObjectFunction(fn: ((...args: unknown[]) => void) | null): void
}

// px half-width (→ ~2px band). Stock OutlineNode feathers its edge, so a solid 1.5px band looks too
// heavy; 1.0 matches its perceived weight. Keep in sync with consolidatedOutline.ts (WebGL twin).
const OUTLINE_THICKNESS = 1.0

/**
 * WebGPU port of ConsolidatedSelectionOutline (consolidatedOutline.ts): the Blender-overlay-style
 * single-pass outline replacing the two stock `outline()` nodes in outlineNode.ts. The saving is largest
 * here. The stock path runs each tier's full chain (mask + downsample + edge + separable blur, and it
 * can't skip the unused glow blur), so a multi-select is ~16 render passes. This is one combined-mask
 * render (two tier materials in a single scene traversal) + one detect node folded into the composite,
 * about 3 passes. Same five-value mask encoding + max()-priority as the WebGL twin.
 *
 * The scene render adds an overlay sub-pass the WebGL twin doesn't need (renderLayeredScene says why).
 * Otherwise only the outline stage differs: outlineNode composites `reg.add(act).add(base)` (two
 * OutlineNodes), and this composites `detect().add(base)`, where detect() reads the one mask texture.
 */
class WebGPUConsolidatedOutline implements ISelectionOutline {
  private readonly renderer: LayeredRenderer
  private readonly scene: Scene
  private readonly camera: Camera
  private readonly getOverlays: () => readonly Object3D[]
  private readonly sceneRT: RenderTarget
  private readonly maskRT: RenderTarget
  private readonly pipeline: RenderPipeline
  /** the same output with no outline composite: what a frame with nothing selected draws (render) */
  private readonly pipelineBare: RenderPipeline
  /** run the full composite on the next frame even with nothing selected, so its pipeline compiles
   *  inside the load bracket (first frame, and after warmSelection) instead of on the first click */
  private composeWarmPending = true
  private readonly maskRegular: MeshBasicNodeMaterial
  private readonly maskActive: MeshBasicNodeMaterial
  private readonly maskPool: MeshBasicNodeMaterial
  // palette-merged mask (outlineMaskMerge.ts): one merged mesh masks every selected part's unique
  // meshes, tiered from a palette texture keyed by a per-vertex aSlot. Null on ?nomaskmerge.
  private readonly getMaskMerge: () => OutlineMaskMergeSurface | null
  private readonly maskMerge: MeshBasicNodeMaterial | null
  private readonly uMergePalette: Vec4TextureNode | null
  private lastMergePalette: Texture | null = null
  private readonly uNear = uniform(0.1)
  private readonly uFar = uniform(2000)
  // 1 while the editor camera projects orthographically: the mask's depth linearisation is
  // projection-specific, and a uniform-driven select keeps the pipeline a single variant
  // (no rebuild/recompile on the Perspective/Orthogonal toggle)
  private readonly uOrtho = uniform(0)
  private readonly uTexel = uniform(new Vector2(1 / 1, 1 / 1))
  // Selected roots. The per-object membership sets setRenderObjectFunction filters on are rebuilt
  // from these every frame in renderMask (not cached at select time), so a within-part geometry swap
  // is picked up live. For example, a conveyor's leg InstancedMesh is swapped for a larger one when its
  // pool grows past capacity on resize (writeLegs → ensureInstanceCapacity), and refreshOutline's
  // membership gate never re-calls select() on a resize (selection + structureRev are unchanged).
  // The WebGL twin and both stock paths re-traverse the roots live each frame for the same reason.
  private regularRoots: readonly Object3D[] = []
  private activeRoots: readonly Object3D[] = []
  private regularMeshes = new Set<Object3D>()
  private activeMeshes = new Set<Object3D>()

  constructor(renderer: WebGPURenderer, scene: Scene, camera: Camera, getOverlays: () => readonly Object3D[], getMaskMerge: () => OutlineMaskMergeSurface | null = () => null) {
    this.renderer = renderer as LayeredRenderer
    this.scene = scene
    this.camera = camera
    this.getOverlays = getOverlays
    this.getMaskMerge = getMaskMerge

    // scene buffer (linear HDR, tone mapping deferred to the pipeline output). Depth is a sampleable
    // DepthTexture so the mask can resolve occlusion against the full scene (the xray-dim split).
    //
    // colorSpace is the working space. It must match what `compileAsync` pre-warms
    // against or the whole pre-warm is wasted. three puts the destination texture's colorSpace in the
    // render-pipeline cache key (WebGPUBackend.getRenderCacheKey). Because view.ts sets
    // AgXToneMapping, `needsFrameBufferTarget` is true, so every compileAsync with a null render
    // target compiles into three's internal `_getFrameBufferTarget()`, a target built with
    // `colorSpace: ColorManagement.workingColorSpace` (Renderer.js). At the RenderTarget default
    // (NoColorSpace), every warmed pipeline keys on 'srgb-linear' while the live frame, which renders
    // here, keys on '': same format, same depth format, same sample count, different key. Measured
    // on the demo scene with the default: 34 of 42 'srgb-linear' pipelines were compiled and never
    // drawn, and the live path recompiled its own copies (e2e/probes/pipeline-census.mjs).
    // Both values mean "no conversion on sample", so this changes no pixels (an A/B of the two
    // values gave byte-identical frames). Don't flip texture.colorSpace on a live target: setting
    // needsUpdate on a render-target texture reinitializes it and the next frame is black.
    this.sceneRT = new RenderTarget(1, 1, {
      type: HalfFloatType,
      depthBuffer: true,
      samples: renderQuality.msaaSamples,
      // three types this getter as plain `string`; read it rather than hardcoding
      // LinearSRGBColorSpace so the two stay coupled if the working space is ever changed
      colorSpace: ColorManagement.workingColorSpace as ColorSpace,
    })
    this.sceneRT.depthTexture = new DepthTexture(1, 1)
    // 8-bit combined mask (exact multiples of 0.25); no depth (occlusion resolved in-shader)
    this.maskRT = new RenderTarget(1, 1, { depthBuffer: false })

    this.maskRegular = this.makeMaskMaterial(0.25)
    this.maskActive = this.makeMaskMaterial(0.75)
    this.maskPool = this.makePoolMaskMaterial()
    // build the merge material against the manager's palette texture (updated per frame in
    // renderMask when the manager re-mints on growth). Absent under ?nomaskmerge.
    const mergeSurface = getMaskMerge()
    if (mergeSurface) {
      this.uMergePalette = texture(mergeSurface.palette)
      this.lastMergePalette = mergeSurface.palette
      this.maskMerge = this.makeMergeMaskMaterial(this.uMergePalette)
    } else {
      this.uMergePalette = null
      this.maskMerge = null
    }

    const base = texture(this.sceneRT.texture)
    this.pipeline = new RenderPipeline(renderer, this.detect().add(base))
    this.pipelineBare = new RenderPipeline(renderer, base)
    this.syncSize()
  }

  /** mask material for one tier: writes tierBase (occluded) or tierBase+0.25 (visible) into R.
   *  Visibility = the fragment is not behind the scene surface, tested exactly as the stock
   *  OutlineNode does (perspectiveDepthToViewZ + a positionView.z compare). */
  private makeMaskMaterial(tierBase: number): MeshBasicNodeMaterial {
    const mat = new MeshBasicNodeMaterial()
    mat.depthTest = false
    mat.depthWrite = false
    mat.toneMapped = false
    const sceneDepth = texture(this.sceneRT.depthTexture!).sample(screenUV)
    const viewZ = this.sceneViewZ(sceneDepth)
    const visible = select(positionView.z.lessThanEqual(viewZ), float(0.25), float(0))
    mat.colorNode = vec4(float(tierBase).add(visible), 0, 0, 1)
    return mat
  }

  /** scene-depth → view-Z with the linearisation matching the camera's current projection (uOrtho) */
  private sceneViewZ(sceneDepth: Parameters<typeof perspectiveDepthToViewZ>[0]) {
    return select(
      this.uOrtho.greaterThan(0.5),
      orthographicDepthToViewZ(sceneDepth, this.uNear, this.uFar),
      perspectiveDepthToViewZ(sceneDepth, this.uNear, this.uFar),
    )
  }

  /** mask material for the pool meshes: the tier is stored per instance in the pools' aSel channel
   *  (instancePool.setSelectionTiers: 0 unselected / 1 regular / 2 active). Unselected instances
   *  discard, so one render of the pool group masks every selected part's pooled hardware. */
  private makePoolMaskMaterial(): MeshBasicNodeMaterial {
    const mat = new MeshBasicNodeMaterial()
    mat.depthTest = false
    mat.depthWrite = false
    mat.toneMapped = false
    // attribute() is typed with an open generic (AttributeNode<string>) the TSL math-node methods
    // don't exist on, so cast to a float node, same as beltFabricBankNodeMaterial's instanced attrs
    const aSel = attribute(SEL_ATTR, 'float') as unknown as ReturnType<typeof float>
    const sceneDepth = texture(this.sceneRT.depthTexture!).sample(screenUV)
    const viewZ = this.sceneViewZ(sceneDepth)
    const visible = select(positionView.z.lessThanEqual(viewZ), float(0.25), float(0))
    const tierBase = select(aSel.lessThan(1.5), float(0.25), float(0.75))
    mat.colorNode = Fn(() => {
      Discard(aSel.lessThan(0.5))
      return vec4(tierBase.add(visible), 0, 0, 1)
    })()
    return mat
  }

  /** mask material for the palette-merged mesh (outlineMaskMerge.ts). Each vertex carries an aSlot
   *  index into the palette texture. The matrix (4 columns) + tier are texel-fetched from that
   *  slot, and the world position is computed in the vertex stage (the mesh sits at identity). The
   *  tier + view-Z go to the fragment as varyings for the same occlusion test + encoding as the pool
   *  material. Hidden meshes get a zero matrix from the palette, so their triangles collapse. */
  private makeMergeMaskMaterial(pal: Vec4TextureNode): MeshBasicNodeMaterial {
    const mat = new MeshBasicNodeMaterial()
    mat.depthTest = false
    mat.depthWrite = false
    mat.toneMapped = false
    const aSlot = attribute('aSlot', 'float') as unknown as ReturnType<typeof float>
    const slot = int(aSlot.add(0.5))
    const c0 = textureLoad(pal, ivec2(int(0), slot))
    const c1 = textureLoad(pal, ivec2(int(1), slot))
    const c2 = textureLoad(pal, ivec2(int(2), slot))
    const c3 = textureLoad(pal, ivec2(int(3), slot))
    const tier = textureLoad(pal, ivec2(int(4), slot)).x
    // world = matrix * position, columns weighted by the local position components (c3 is the
    // translation column with w=1, so the homogeneous point stays valid)
    const world = c0.mul(positionGeometry.x).add(c1.mul(positionGeometry.y)).add(c2.mul(positionGeometry.z)).add(c3)
    const viewPos = cameraViewMatrix.mul(world)
    // varyings to the fragment: the view-space Z for the occlusion compare, and the tier
    const vViewZ = varying(viewPos.z)
    const vTier = varying(tier)
    mat.vertexNode = cameraProjectionMatrix.mul(viewPos)
    const sceneDepth = texture(this.sceneRT.depthTexture!).sample(screenUV)
    const viewZ = this.sceneViewZ(sceneDepth)
    const visible = select(vViewZ.lessThanEqual(viewZ), float(0.25), float(0))
    const tierBase = select(vTier.lessThan(1.5), float(0.25), float(0.75))
    mat.colorNode = vec4(tierBase.add(visible), 0, 0, 1)
    return mat
  }

  /** single detect+colour node: ring-sample the mask, band where the neighbourhood straddles a
   *  boundary, colour by the max (priority-ordered) value seen. Additive over the scene base. */
  private detect() {
    const mask = texture(this.maskRT.texture)
    const regOcc = uniform(new Color().copy(HIDDEN_EDGE))
    const regVis = uniform(new Color().copy(VISIBLE_EDGE))
    const actOcc = uniform(new Color().copy(ACTIVE_HIDDEN_EDGE))
    const actVis = uniform(new Color().copy(ACTIVE_VISIBLE_EDGE))
    // 16 directions × 2 sub-rings (0.5, 1.0 × thickness), a ~2px band. DIRS/RINGS match the WebGL
    // twin so both feather over the same sample density (the coverage's smoothness is ~1/total).
    const DIRS = 16
    const RINGS = 2
    const offsets: Array<[number, number]> = []
    for (let i = 0; i < DIRS; i++) {
      const a = (i / DIRS) * Math.PI * 2
      for (let r = 1; r <= RINGS; r++) offsets.push([Math.cos(a) * OUTLINE_THICKNESS * (r * 0.5), Math.sin(a) * OUTLINE_THICKNESS * (r * 0.5)])
    }
    const total = offsets.length + 1
    return Fn(() => {
      const center = mask.sample(screenUV).r
      const maxSel = center.toVar()
      const bg = select(center.greaterThan(0.003), float(0), float(1)).toVar()
      for (const [dx, dy] of offsets) {
        const m = mask.sample(screenUV.add(this.uTexel.mul(vec2(dx, dy)))).r
        maxSel.assign(max(maxSel, m))
        bg.assign(bg.add(select(m.greaterThan(0.003), float(0), float(1))))
      }
      const bgFrac = bg.div(float(total))
      const selFrac = float(1).sub(bgFrac)
      // feathered coverage: peaks on the silhouette (selection & background balanced), ramps to 0 at
      // the band's inner/outer rims so the edge looks antialiased like stock. EDGE_FEATHER is shared
      // with the WebGL twin.
      const cov = smoothstep(float(0), float(EDGE_FEATHER), selFrac).mul(smoothstep(float(0), float(EDGE_FEATHER), bgFrac))
      // priority via thresholds on the max value (actVis 1.0 > actOcc .75 > regVis .5 > regOcc .25)
      const col = select(
        maxSel.greaterThan(0.875), actVis,
        select(maxSel.greaterThan(0.625), actOcc, select(maxSel.greaterThan(0.375), regVis, regOcc)),
      )
      return col.mul(EDGE_STRENGTH).mul(cov)
    })()
  }

  select(objects: readonly Object3D[], activeObjects: readonly Object3D[] = []): void {
    this.regularRoots = objects
    this.activeRoots = activeObjects
  }

  // true only inside warmSelection's mask render. It skips the sub-pass projection capture, whose
  // list would otherwise be recorded under staged-reveal visibility and replayed for a real frame
  private warmingMask = false

  /** Load-time pipeline warm (see ISelectionOutline.warmSelection): one off-screen mask render so
   *  the renderObject-substituted mask materials (merge palette / pool aSel / per-tier leftovers)
   *  mint their pipelines during the load's held-loop bracket instead of on the first selection.
   *  The caller stages the membership first. The mask is written to maskRT only, and the next real
   *  frame's renderMask clears it, so nothing ever reaches the composite. */
  warmSelection(): void {
    this.warmingMask = true
    try {
      this.renderMask()
    } finally {
      this.warmingMask = false
    }
    // ...and have the next frame run the composite, whose renderMask also clears this warm's mask
    this.composeWarmPending = true
  }

  setSize(): void {
    this.syncSize()
  }

  /** The targets follow the renderer's drawing buffer, which already carries the new ratio. */
  setPixelRatio(): void {
    this.syncSize()
  }

  private syncSize(): void {
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    this.sceneRT.setSize(size.x, size.y)
    this.maskRT.setSize(size.x, size.y)
    this.uTexel.value.set(1 / size.x, 1 / size.y)
  }

  render(): void {
    this.renderer.info.autoReset = false
    this.renderer.info.reset()
    this.renderLayeredScene()
    // Nothing selected: the composite would sample an all-zero mask 33 times per pixel and add nothing,
    // so draw the scene straight through (the WebGL twin returns early the same way,
    // consolidatedOutline.ts). No mask clear either: renderMask clears before it draws a selection.
    if (this.regularRoots.length === 0 && this.activeRoots.length === 0 && !this.composeWarmPending) {
      this.pipelineBare.render()
      return
    }
    this.composeWarmPending = false
    this.renderMask()
    this.pipeline.render()
  }

  /** combined mask: one scene traversal drawing each selected mesh with its tier's mask material */
  private renderMask(): void {
    const { renderer, scene, camera } = this
    // Palette-merged mask (outlineMaskMerge.ts): one merged mesh covers every selected part's
    // unique meshes. Only the leftovers it couldn't absorb (InstancedMesh banks / skinned) still
    // filter per-mesh. Null under ?nomaskmerge, and then the tier sets come from the roots.
    const merge = this.maskMerge ? this.getMaskMerge() : null
    // Rebuild membership from the live scene graph each frame (see regularRoots): the roots are
    // stable across a resize but their leg InstancedMesh children can be swapped.
    // (With merge active, the merge manager's own per-frame walk re-derives leftovers live.)
    this.regularMeshes = merge ? new Set(merge.leftoverRegular) : collectMeshes(this.regularRoots)
    this.activeMeshes = merge ? new Set(merge.leftoverActive) : collectMeshes(this.activeRoots)
    const mergeActive = !!(merge && this.maskMerge && merge.slotCount > 0)
    // "selection present" is decided by the roots, not the tier sets: with merge the leftovers
    // can be empty while the merged mesh carries the whole selection.
    if (this.regularRoots.length === 0 && this.activeRoots.length === 0) {
      // clear the mask so a stale outline doesn't linger, then skip
      renderer.setRenderTarget(this.maskRT)
      renderer.clear()
      renderer.setRenderTarget(null)
      return
    }
    // point the merge material's palette node at the manager's current texture (re-minted on
    // growth) and flip the (normally hidden) merged group visible for this render only
    if (merge && this.uMergePalette && merge.palette !== this.lastMergePalette) {
      this.uMergePalette.value = merge.palette
      this.lastMergePalette = merge.palette
    }
    const mergeMesh = mergeActive ? merge!.mesh : null
    const mergeGroup = merge ? merge.group : null
    const mergeGroupWasVisible = mergeGroup ? mergeGroup.visible : false
    if (mergeGroup) mergeGroup.visible = mergeActive
    const cam = camera as PerspectiveCamera
    this.uNear.value = cam.near
    this.uFar.value = cam.far
    // read per frame off the camera (EditorCamera flips this flag on the projection toggle)
    this.uOrtho.value = (cam as { isOrthographicCamera?: boolean }).isOrthographicCamera ? 1 : 0
    const oldAutoClear = renderer.autoClear
    // Deferred pool ejection: a merely-selected part stays in the instance pool (its sources stay
    // at visible=false). Its silhouette comes from the pool meshes, rendered with the aSel mask
    // material. The tier is per instance and unselected instances discard, so mask draw
    // calls scale with #pools, not #selected parts. The SimBoxes cargo batches (selChannelGroup)
    // carry the same channel: selected boxes/pallets mask from inside their instanced batch
    // instead of being promoted to standalone meshes.
    // Only the batches whose rows actually hold a selected instance are drawn. The rest would have
    // every fragment discarded by the aSel mask material, so submitting them is wasted work that
    // grows with the scene (selTierChannel.batchHasSelection). The warm render is the exception. It
    // exists to mint these pipelines before a real selection needs them, and at that moment
    // nothing is selected, so it takes every batch.
    const poolMeshes = new Set<Object3D>()
    for (const g of this.scene.children) {
      if (g.userData.instancePoolGroup === true || g.userData.selChannelGroup === true) {
        for (const m of g.children) if (this.warmingMask || batchHasSelection(m)) poolMeshes.add(m)
      }
    }
    // Null the scene background for the mask render: it draws as a fullscreen quad that bypasses
    // the setRenderObjectFunction mesh filter, flooding the mask R channel with the background
    // colour so no background(0) region survives. The edge detector then finds no silhouette
    // and the whole outline disappears. renderLayeredScene nulls it for the same reason.
    // try/finally so a thrown render can't leak a null background onto every subsequent frame.
    const savedBackground = scene.background
    // Sub-pass projection cache (subPassCache.ts), same bracket as the overlay pass.
    // Here the projected list is the full visible layer-0 set (the membership filter applies at
    // renderObject time, below, from the per-frame live sets), so the replay saves the graph
    // recursion rather than the list length. The mask can pick up content that changes without a
    // structural notify (the live-cargo outline proxies under boxes.outlineGroup spawn/despawn while
    // the sim runs), so the epoch alone is not enough. The sig is the scene-activity serial
    // (bundleGroups): it advances every active frame (a re-record, about the uncached cost) and
    // freezes while parked, which is when the replay saves time. Cacheable only when the bundle
    // machinery is registered (its structural flush forces frustumCulled=false across the part
    // containers, making the projection camera-independent) and the `?bundlelive` split is off
    // (its livePartsGroup renders real parts outside the bundles without forced cull-off).
    const cacheMask = !this.warmingMask && bundleGroupsRegistered() && !wantsBundleLiveSplit()
    try {
      scene.background = null
      renderer.autoClear = false
      renderer.setRenderTarget(this.maskRT)
      renderer.clear()
      renderer.setRenderObjectFunction((object, s, c, geometry, _material, group, lightsNode, clippingContext) => {
        const tier = object === mergeMesh ? this.maskMerge
          : poolMeshes.has(object as Object3D) ? this.maskPool
          : this.activeMeshes.has(object as Object3D) ? this.maskActive
          : this.regularMeshes.has(object as Object3D) ? this.maskRegular : null
        if (tier) renderer.renderObject(object, s, c, geometry, tier, group, lightsNode, clippingContext)
        // A pipeline is keyed on material and attribute layout, and the warm stages only one part as
        // active, so a mesh the merge leaves over would get only one tier's pipeline. A real selection
        // makes any part active, so the warm draws each leftover with the other tier too.
        if (this.warmingMask && (tier === this.maskActive || tier === this.maskRegular)) {
          const other = tier === this.maskActive ? this.maskRegular : this.maskActive
          renderer.renderObject(object, s, c, geometry, other, group, lightsNode, clippingContext)
        }
      })
      if (cacheMask) beginPassCapture(renderer, 'mask', String(bundleActivitySerial()))
      renderer.render(scene, camera)
    } finally {
      endPassCapture()
      renderer.setRenderObjectFunction(null)
      scene.background = savedBackground
      renderer.autoClear = oldAutoClear
      renderer.setRenderTarget(null)
      if (mergeGroup) mergeGroup.visible = mergeGroupWasVisible
    }
  }

  /**
   * The mobile tier's one-pass collapse (the WebGL twin always draws one pass). An extra pass into an
   * off-screen HDR target is tile store/load traffic on exactly the mobile GPUs that reach this code,
   * and bandwidth is what a phone has least of. The overlays draw with everything else, so on this
   * backend bundled content may paint over them.
   */
  private renderSinglePass(): void {
    const { renderer, scene, camera } = this
    const oldAutoClear = renderer.autoClear
    try {
      renderer.autoClear = false
      renderer.setRenderTarget(this.sceneRT)
      renderer.clear()
      setBundlesActive(!bundleReplaySuppressed())
      renderer.render(scene, camera)
    } finally {
      setBundlesActive(false)
      renderer.autoClear = oldAutoClear
      renderer.setRenderTarget(null)
    }
  }

  /** Layered scene render into sceneRT: the scene, then the editor overlays (OVERLAY_LAYER) alone over its
   *  depth. They need a pass of their own here because render bundles execute after every base draw
   *  (finishRender → executeBundles), so a depth-write-off overlay drawn inline is painted over by bundled
   *  hardware. The last pass runs against the full depth buffer, so geometry in front still hides it.
   *  The overlays are hidden during the scene pass so they are not drawn twice. Collapses to one plain
   *  pass on the mobile tier (quality.ts singlePass, renderSinglePass above). */
  private renderLayeredScene(): void {
    if (renderQuality.singlePass) {
      this.renderSinglePass()
      return
    }
    const { renderer, scene, camera } = this
    const overlays = this.getOverlays()
    const oldAutoClear = renderer.autoClear
    const oldShadowAutoUpdate = renderer.shadowMap.autoUpdate
    const savedMask = camera.layers.mask
    const savedBackground = scene.background
    const oldMatrixWorldAutoUpdate = scene.matrixWorldAutoUpdate
    try {
      renderer.autoClear = false
      renderer.setRenderTarget(this.sceneRT)
      for (const o of overlays) o.visible = false
      renderer.clear()
      // Render bundles are active only for this main scene pass (which includes its
      // shadow-map update). The overlay sub-pass below shares this scene+camera+target
      // (the same render-context key), so an active bundle there would replay this pass's baked
      // draw list. renderMask's per-object material substitution can't run from a replay either.
      // bundleReplaySuppressed: a frame whose draw list just changed renders unbundled (the
      // re-record is applied a frame late on r185 WebGPU, the live-edit hold in bundleGroups.ts liveHoldFrames), so a
      // stale prior encode can't replay over the change (the "roof cut-out on load").
      setBundlesActive(!bundleReplaySuppressed())
      renderer.render(scene, camera)
      setBundlesActive(false)
      scene.matrixWorldAutoUpdate = false
      scene.background = null
      if (overlays.length > 0) {
        for (const o of overlays) o.visible = true
        camera.layers.set(OVERLAY_LAYER)
        renderer.shadowMap.autoUpdate = false
        // Bracketed with the sub-pass projection cache (subPassCache.ts; `?nopasscache` reverts):
        // with bundles inert this pass would otherwise traverse the full graph to find the
        // dozen-odd gizmo/handle/ruler meshes. Its projected list is exactly the visible
        // overlay-layer meshes, and the manipulators flip child visibility outside any notify
        // seam (mode switches, handle relayouts, yaw-only ring hides). So the sig hashes the
        // visible overlay subtrees (identity + visit order) on top of the epoch. Overlay
        // meshes are created frustumCulled=false (view/handles), keeping the list camera-
        // independent. Matrices are read live per draw, so a gizmo drag moves on replay.
        beginPassCapture(renderer, 'overlay', overlayVisSig(overlays))
        try {
          renderer.render(scene, camera)
        } finally {
          endPassCapture()
        }
        renderer.shadowMap.autoUpdate = oldShadowAutoUpdate
      }
    } finally {
      setBundlesActive(false) // a thrown main pass must not leak active bundles into other passes
      camera.layers.mask = savedMask
      scene.background = savedBackground
      scene.matrixWorldAutoUpdate = oldMatrixWorldAutoUpdate
      renderer.autoClear = oldAutoClear
      renderer.shadowMap.autoUpdate = oldShadowAutoUpdate
      for (const o of overlays) o.visible = true
      renderer.setRenderTarget(null)
    }
  }

  dispose(): void {
    this.pipeline.dispose()
    this.pipelineBare.dispose()
    this.maskRegular.dispose()
    this.maskActive.dispose()
    this.maskPool.dispose()
    this.maskMerge?.dispose()
    this.sceneRT.dispose()
    this.maskRT.dispose()
  }
}

/** every Mesh/InstancedMesh under the given roots: the membership setRenderObjectFunction filters on */
function collectMeshes(roots: readonly Object3D[]): Set<Object3D> {
  const set = new Set<Object3D>()
  for (const root of roots) root.traverse((o) => { if ((o as { isMesh?: boolean; isInstancedMesh?: boolean }).isMesh || (o as { isInstancedMesh?: boolean }).isInstancedMesh) set.add(o) })
  return set
}

/**
 * Identity + visibility hash of the overlay subtrees, used as the overlay pass's projection-cache sig.
 * traverseVisible mirrors drawingPipeline.project's visit set exactly (both skip invisible subtrees), so
 * any change to what would be projected (a manipulator mode switch, a handle-pool relayout, a
 * root joining/leaving the overlays list) changes the hash. The subtrees are small (a few dozen
 * nodes), so hashing per frame is trivial next to the full-graph traversal it avoids.
 */
function overlayVisSig(overlays: readonly Object3D[]): string {
  let h = 0
  for (const root of overlays) root.traverseVisible((o) => { h = (h * 31 + o.id) | 0 })
  return h.toString(36)
}

export function createWebGPUConsolidatedOutline(renderer: WebGPURenderer, scene: Scene, camera: Camera, getOverlays: () => readonly Object3D[], getMaskMerge: () => OutlineMaskMergeSurface | null = () => null): ISelectionOutline {
  return new WebGPUConsolidatedOutline(renderer, scene, camera, getOverlays, getMaskMerge)
}
