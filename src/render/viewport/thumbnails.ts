import {
  AgXToneMapping,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three'
import type { Mesh, Object3D, Texture } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { createSdkPart, createPart } from '../../core/scene/scene'
import { unitPieces } from '../../core/frame'
import type { PartPackage } from '../../core/parts/partPackage'
import { PART_DEFS } from '../../core/types'
import type { PartType } from '../../core/types'
import { modelsSettled, runSpeculativeWarm } from '../gltf'
import { customMeshesSettled } from '../parts/sdkPart'
import { createPartVisual } from '../parts/registry'
import type { PartVisual } from '../parts/registry'
import { isWebGPURenderMode } from '../renderMode'
import { SCENE_SKY } from '../metalEnvironment'

/** logical px; the drawing buffer is this times the device pixel ratio */
const SIZE = 120

let cache: Map<PartType, string> | null = null
let pending: Promise<Map<PartType, string>> | null = null

/**
 * One PNG data-URL per part type, rendered offscreen from the same visual
 * factories the viewport uses. The part set is code-defined and fixed, so the
 * map is generated once per session and memoised.
 */
export function getPartThumbnails(): Promise<Map<PartType, string>> {
  if (cache) return Promise.resolve(cache)
  if (!pending) {
    pending = renderAll().then((map) => {
      cache = map
      pending = null
      return map
    })
  }
  return pending
}

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Wait (bounded) until every texture the objects' materials sample has its image. modelsSettled covers GLBs
 * only, and a bitmap texture (gltf.ts loadTextureBitmap) is an empty Texture until its decode finishes, which
 * samples black (without this wait the generic Part card's deck is captured black). Node materials keep their textures in
 * nodes, not properties, so this is best-effort on the WebGPU path.
 */
async function texturesLoaded(objects: readonly Object3D[], timeoutMs = 5000): Promise<void> {
  const textures = new Set<Texture>()
  for (const root of objects) {
    root.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(mat)) if ((value as Texture | null)?.isTexture) textures.add(value as Texture)
      }
    })
  }
  const deadline = performance.now() + timeoutMs
  while ([...textures].some((t) => !t.image) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** iso-angle framing that fits the object's bounding sphere with a little padding */
function frameCamera(camera: PerspectiveCamera, object: Object3D): void {
  const box = new Box3().setFromObject(object)
  if (box.isEmpty()) return
  const sphere = box.getBoundingSphere(new Sphere())
  const radius = Math.max(sphere.radius, 0.05)
  const fov = (camera.fov * Math.PI) / 180
  const dist = (radius / Math.sin(fov / 2)) * 1.15
  const dir = new Vector3(1, 0.7, 1).normalize()
  camera.position.copy(sphere.center).addScaledVector(dir, dist)
  camera.lookAt(sphere.center)
  camera.near = Math.max(dist - radius * 2, 0.01)
  camera.far = dist + radius * 2
  camera.updateProjectionMatrix()
}


/**
 * A lit offscreen renderer + camera + capture, shared by every thumbnail pass. null when no GPU
 * backend is available (headless test) - callers fall back to label-only / glyph cards.
 *
 * The backend follows the viewport: under the experimental ?webgpu flag the part factories build
 * TSL node materials (renderMode.ts) that a WebGLRenderer cannot compile, so we render the
 * thumbnails with an offscreen WebGPURenderer instead - the same materials the live scene uses.
 * Building that renderer is async (device init), so makeContext() is async; `capture` itself is a
 * Promise-returning seam for that, though render() is synchronous on both backends. `dispose` frees
 * every GPU resource.
 */
interface ThumbContext {
  scene: Scene
  camera: PerspectiveCamera
  /** Frame, render, and capture one object to a PNG data-URL; leaves the scene as it found it. */
  capture(object: Object3D): Promise<string>
  dispose(): void
}

/** the renderer surface both backends share for offscreen thumbnail capture */
type ThumbRenderer = WebGLRenderer | WebGPURenderer

function configureRenderer(renderer: ThumbRenderer): void {
  renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2))
  renderer.setSize(SIZE, SIZE)
  renderer.setClearColor(0x000000, 0)
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = 1.2
}

/** the shared lit scene + camera; `disposeLights` frees the three lights the context owns */
function buildThumbScene(): { scene: Scene; camera: PerspectiveCamera; disposeLights(): void } {
  const scene = new Scene()
  // the viewport's sky colours; metals reflect them through the visuals' own envMaps (metalEnvironment.ts)
  const hemi = new HemisphereLight(SCENE_SKY.sky, SCENE_SKY.ground, 1.4)
  const key = new DirectionalLight(0xfff3e0, 2.4)
  key.position.set(4, 6, 5)
  const fill = new DirectionalLight(0xdde6f2, 1.0)
  fill.position.set(-5, 3, -4)
  scene.add(hemi, key, fill)
  const camera = new PerspectiveCamera(35, 1, 0.01, 1000)
  return {
    scene,
    camera,
    disposeLights() {
      hemi.dispose()
      key.dispose()
      fill.dispose()
    },
  }
}

/** Backend follows the viewport: WebGPU under ?webgpu (so node materials compile), else WebGL. */
function makeContext(): Promise<ThumbContext | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  return isWebGPURenderMode() ? makeWebGPUContext() : Promise.resolve(makeWebGLContext())
}

function makeWebGLContext(): ThumbContext | null {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true })
  } catch {
    return null
  }
  return buildContext(renderer)
}

/**
 * Offscreen WebGPU renderer for the ?webgpu path. three/webgpu is dynamically imported (it's the
 * big second copy of three, already fetched for the viewport's renderer); init() acquires a device
 * so render() runs synchronously afterwards (like WebGL). The WebGPU node-material factories are
 * already registered globally by createWebGPURenderer, so the visuals we build here compile as the
 * live scene's TSL materials. Returns null if init fails, so the caller degrades to glyph/label
 * cards exactly as it does when WebGL is unavailable.
 */
async function makeWebGPUContext(): Promise<ThumbContext | null> {
  try {
    const { WebGPURenderer } = await import('three/webgpu')
    const renderer = new WebGPURenderer({ antialias: true, alpha: true })
    await renderer.init()
    return buildContext(renderer)
  } catch {
    return null
  }
}

/**
 * Wrap an initialised renderer (WebGL, or WebGPU after init()) in the shared lit scene + capture.
 * render() is synchronous on both, so a captured frame is on the canvas for toDataURL immediately -
 * one capture path for both backends.
 */
function buildContext(renderer: ThumbRenderer): ThumbContext {
  configureRenderer(renderer)
  const { scene, camera, disposeLights } = buildThumbScene()
  return {
    scene,
    camera,
    capture(object: Object3D): Promise<string> {
      scene.add(object)
      frameCamera(camera, object)
      renderer.render(scene, camera)
      const url = renderer.domElement.toDataURL('image/png')
      scene.remove(object)
      return Promise.resolve(url)
    },
    dispose() {
      disposeLights()
      renderer.dispose()
      // dispose() leaves the WebGL context alive until GC. Thumbnails re-render on every package change,
      // and once the browser holds too many contexts it force-loses the oldest one, the main viewport's.
      if (renderer instanceof WebGLRenderer) renderer.forceContextLoss()
    },
  }
}

/**
 * One PNG data-URL per custom-part package, rendered offscreen from the same visual factory the viewport
 * uses (createCustomVisual). The catalog shows a placeholder glyph for a custom card otherwise - built-ins
 * get a thumbnail (static asset or renderAll below) but packages are dynamic, so they're rendered on demand.
 * The package must already be registered (the catalog only lists registered ones); an unregistered id would
 * render an empty deck. Returns an empty map when no GPU backend is available.
 */
export async function renderPackageThumbnails(pkgs: readonly PartPackage[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (pkgs.length === 0) return result
  const ctx = await makeContext()
  if (!ctx) return result

  // Built under runSpeculativeWarm: an offscreen card is for a part the user may never place, so its
  // GLB/texture fetches must stay off the assets-quiet signal (or the catalog sweep, which waits on that
  // signal, would end up waiting on the catalog) and must be classified as speculative for the first-load
  // gate. Same reasoning as view.warmPart; see the ledger in gltf.ts.
  const items = runSpeculativeWarm(() =>
    pkgs.map((pkg) => {
      const part = createSdkPart(pkg, `__thumb_${pkg.id}`, [0, PART_DEFS.part.defaultY, 0], 0)
      const visual = createPartVisual(part)
      // A unit load draws nothing of its own: the pallet and cases it stacks itself are cargo the stopped view
      // builds beside it (core/frame unitPieces). Build them here too, or its card is an empty frame.
      const pieces: PartVisual[] = []
      for (const piece of unitPieces([part], part)) {
        try {
          const v = createPartVisual(piece)
          v.update(piece) // sync the piece's pose (factories only bake it on update)
          pieces.push(v)
        } catch {
          // piece package not registered: the card shows what did build
        }
      }
      if (pieces.length === 0) return { pkg, object: visual.object, visuals: [visual] }
      const group = new Group()
      group.add(visual.object, ...pieces.map((v) => v.object))
      return { pkg, object: group as Object3D, visuals: [visual, ...pieces] }
    }),
  )

  // a rig's mesh links + GLBs load async before they render, so wait for them to settle before capturing or
  // the thumbnail is a partial rig. Two settle gates: customMeshesSettled covers embedded-base64 GLBs
  // (sdkPart.loadMeshAsset), modelsSettled covers shared app GLBs pulled via gltf.ts loadPartModel (without it a
  // rig built on one renders with parts missing). Two rounds
  // cover second-wave loads.
  try {
    await Promise.all([customMeshesSettled(), modelsSettled()])
    await nextMacrotask()
    await Promise.all([customMeshesSettled(), modelsSettled()])
    await nextMacrotask()
    await texturesLoaded(items.map((i) => i.object))

    for (const { pkg, object } of items) {
      result.set(pkg.id, await ctx.capture(object))
      // One card per task. A capture is a draw and a synchronous read back of its pixels, and a project with a few
      // dozen parts of its own held the page for two seconds in one go, as the loading cover lifted.
      await nextMacrotask()
    }
  } finally {
    // dispose in finally: a capture throw must not leak the GPU context - the caller
    // retries on the next state change, and leaked contexts pile up to the browser cap
    for (const { visuals } of items) for (const v of visuals) v.dispose()
    ctx.dispose()
  }
  return result
}

async function renderAll(): Promise<Map<PartType, string>> {
  const result = new Map<PartType, string>()
  const ctx = await makeContext()
  if (!ctx) return result // no GPU backend (headless test) - catalog falls back to label-only cards

  // a type that declares a glyph has no 3-D form: its render is an empty transform, and every view draws the glyph
  // instead (PartDef.glyph), so there is nothing to picture
  const types = (Object.keys(PART_DEFS) as PartType[]).filter((type) => !PART_DEFS[type].glyph)
  const items = runSpeculativeWarm(() =>
    types.map((type) => {
      // place at the natural drop height so conveyor legs span down to the floor
      const part = createPart(type, `__thumb_${type}`, [0, PART_DEFS[type].defaultY, 0], 0)
      const visual = createPartVisual(part)
      // by default render the visual's own object; overridden below for GLB-backed cargo
      return { type, part, visual, object: visual.object }
    }),
  )

  // GLB-backed visuals swap/tile their meshes in promise callbacks; let those
  // loads settle and their (micro)task continuations flush before we capture.
  // A second round covers second-wave loads kicked off during the first swap.
  try {
    await modelsSettled()
    await nextMacrotask()
    await modelsSettled()
    await nextMacrotask()
    await texturesLoaded(items.map((i) => i.object))

    for (const { type, object } of items) {
      result.set(type, await ctx.capture(object))
    }
  } finally {
    for (const { visual } of items) visual.dispose()
    ctx.dispose()
  }
  return result
}
