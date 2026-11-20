import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  Sphere,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
} from 'three'
import type { Material, Object3D } from 'three'
import { versionedAssetUrl } from '../../core/assetVersions'
import type { PartInstance } from '../../core/types'
import {
  FLOOR_SURFACE_Y,
  FRAME_WALL_THICKNESS,
  GUARD_THICKNESS,
} from '../../core/types'
import { beginAssetLoad, isSpeculativeWarm, loadTextureBitmap, noteSpeculativeFetch } from '../gltf'
import { notifyBundleStructureChanged } from '../bundleGroups'
import { retireInstancedMeshOnly } from '../gpuRetire'
import { webgpuNodeFactory } from '../renderMode'
import { growBank, InstanceBank } from './instanceBank'
import { syncBankEmptyVisibility } from './instancedTemplate'

export const RAIL_TOP_Y = -0.005

/**
 * Apply a part's full orientation to its root object. Composes yaw with the
 * optional pitch/roll (rotationX/Z) in YXZ Euler order (yaw first, then the
 * tilt in the yawed frame). Absent tilt = pure yaw (every flat part).
 */
export function applyPartRotation(obj: Object3D, part: PartInstance): void {
  obj.rotation.order = 'YXZ'
  obj.rotation.set(part.rotationX ?? 0, part.rotationY, part.rotationZ ?? 0)
}

/**
 * Frame/belt height (conveyor size.y). Width-independent:
 * size.y is its own parameter, never derived from the width - and like all the
 * other conveyor hardware (flanges, bolts, legs), it keeps its fixed dimension
 * at any conveyor width.
 */
const FRAME_HEIGHT = 0.17 // a 6-1/2 in formed-steel side channel; the conveyor parts' frameHeight default
export function frameRailHeight(): number {
  return FRAME_HEIGHT
}
export function frameBottomY(): number {
  return RAIL_TOP_Y - frameRailHeight()
}
/** belt fabric period: m of travel per texture repeat (~1 tile per metre, scaled by the loop length) */
export const BELT_TEX_PERIOD = 1.0

/** native radius of a roller model (0.12): the spin radius a 'roller'-role mesh
 *  link keeps, since the host cannot know what radius an imported model draws at */
export const ROLLER_MODEL_RADIUS = 0.12

// The conveyor floor support: a typical unit-handling conveyor stand (an H-stand), the TS twin of legPieces() in
// examples/parts/_shared/legs.js, which every legged conveyor part draws with. conveyorLegs.test.ts holds the two to
// the same pieces, so edit both together. Formed-channel uprights 4" x 1-3/4" under the side frames, a support
// channel across under the bed, a 1-1/2" x 8" mounting bracket bolted to each frame web, a 6" x 4" x 1/4" foot plate
// with two anchor bolts, a telescoping inner leg, horizontal cross braces, and knee braces once it is tall.
const LEG_FRAME_WALL = 0.01 // the side frame's wall: the uprights stand flush under its outer face
const LEG_UPRIGHT_HALF_X = 0.0508
const LEG_UPRIGHT_DEPTH = 0.0445
const LEG_PLATE_TOP = 0.009
const LEG_CHANNEL_DEPTH = 0.076
const LEG_FOOT_HALF_X = 0.0762
const LEG_BRACKET_RISE = 0.127 // up the frame web from its bottom, on a frame deep enough to take it
const LEG_BRACKET_TOP_CLEAR = 0.01 // ...else it stops this far under the deck (5 mm under the 5 mm-down rail top)
const LEG_KNEE_MAX = 0.6
const LEG_BOLT_R = 0.009
const LEG_BOLT_DEPTH = 0.007
/** station inset from each end: the upright's half-width plus clearance for the foot plate */
export const LEG_TAIL_OFFSET = 0.15
/** a real run is supported at every 10 ft bed joint */
export const LEG_SPACING = 3.05
/** a third of the pitch: no middle support lands within a metre of an end one */
export const LEG_CLEARANCE = 1.0
export const LEG_MIN_HEIGHT = 0.05
export const LEG_STATION_CAPACITY = 8

export const unitBox = new BoxGeometry(1, 1, 1)

/**
 * An InstancedMesh whose instance buffer regrows on demand - the structural shape of an {@link InstanceBank}.
 * The buffer is a fixed-size allocation, so anything that scales with conveyor length (rollers, frame bolts)
 * would otherwise clip at its starting capacity on a long bed; ensureInstanceCapacity grows it (keeping
 * geometry, material, shadow flags, layer mask, visibility and the ghost tag) and swaps it into the parent
 * group. The initial capacity is just a preallocation to avoid early regrows. The capacity policy and the WebGPU
 * mint-on-grow are in parts/instanceBank.ts; createInstancePool / ensureInstanceCapacity are thin facades over it.
 */
export type InstancePool = InstanceBank

export function createInstancePool(
  parent: Group,
  geometry: BufferGeometry,
  material: Material,
  capacity: number,
  cast = true,
): InstancePool {
  return new InstanceBank(parent, geometry, material, capacity, cast)
}

/** Ensure the instance buffer can hold `n`, growing (and, on WebGPU, minting a fresh mesh that carries the old
 *  one's render state) when it can't. Facade over instanceBank.growBank - see there for the capacity policy
 *  and why the layer mask / ghost tag must be carried across a regrow. */
export function ensureInstanceCapacity(p: InstancePool, n: number): void {
  growBank(p, n)
}

/**
 * Build a `group.userData.tick` that spins a spin-enabled roller material (see
 * `rollerMaterial`/`MetalSpec.spin`). While the sim runs, the brushed-metal grain
 * sweeps around the rollers at the no-slip surface rate (ω = speed / radius rad/s) -
 * a UV-offset scroll in effect. `read`
 * returns the live { speed (m/s, signed), radius (m) } each frame so param edits
 * (speed/duty class) take effect without rebinding. Holds the angle when stopped.
 */
export function rollerSpinTick(
  mat: MeshStandardMaterial,
  read: () => { speed: number; radius: number },
): (dt: number, running: boolean) => boolean {
  const uniform = mat.userData.spinUniform as { value: number } | undefined
  let angle = 0
  // Always returns false: the spin uniform is in the shared tick group (tickUniformGroup.ts), so the
  // new angle is uploaded directly as bytes. There is no per-object bundle walk, so no dirty mark.
  // markTickUniformsAdvanced keeps the stock (non-replay) paths' version gate open.
  return (dt, running) => {
    if (!running || !uniform) return false
    const { speed, radius } = read()
    if (speed === 0 || radius <= 0) return false
    angle = (angle + (speed / radius) * dt) % (Math.PI * 2)
    uniform.value = angle
    markTickUniformsAdvanced()
    return false
  }
}

/** unit hex prism, axis along local Z; scale (r, r, height); r = centre to corner */
export const hexBoltGeo = new CylinderGeometry(1, 1, 1, 6)
hexBoltGeo.rotateX(Math.PI / 2)

const textureCache = new Map<string, Texture>()
function loadMetalTexture(url: string): Texture {
  let tex = textureCache.get(url)
  if (!tex) {
    tex = loadTextureBitmap(url)
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    textureCache.set(url, tex)
  }
  return tex
}

export interface MetalSpec {
  url: string
  /** base tint multiplied onto the sampled texture (HEX) */
  color: number
  /** albedo gain; >1 brightens (the side-guard tint) */
  boost: number
  metalness: number
  roughness: number
  /** world tiles per metre for the triplanar projection */
  triScale: number
  /**
   * spin the triplanar sample around the local Z axis by a `uSpin` uniform (rollers).
   * The cylinder is rotationally symmetric and UV-less, so a geometry rotation would be
   * invisible; instead we rotate the world-space sampling coordinate about the roller
   * axis, which sweeps the brushed-metal grain around the circumference, like a
   * UV-offset scroll. The material exposes the uniform on
   * `userData.spinUniform` so each conveyor can drive it from its own speed.
   */
  spin?: boolean
}

/**
 * Texture-driven metal: the part's surface IS the sampled texture (× tint × boost),
 * sampled triplanar in world space so it tiles at a fixed scale regardless of how
 * each box/cylinder is stretched (the procedural frame/leg boxes and the UV-less
 * roller GLB have no usable UVs). Used for the frame, leg, roller and side-guard metals.
 *
 * customProgramCacheKey is keyed on the texture spec so materials that share a spec
 * share one compiled program (and identical custom uniforms); distinct specs get
 * their own program. Clones (ghost/selection) drop onBeforeCompile and fall to flat.
 */
/**
 * Name of the shared uniform group the WebGPU node materials put their per-frame-ticking
 * uniforms in (spin angle, belt/chain scroll offset+repeat) - see tickUniformGroup.ts for
 * why. bundleReplayRefresh identifies the captured tick bindings by this name.
 */
export const TICK_UNIFORM_GROUP = 'oipTick'

// The tick-group version bump, injected by createRenderer (WebGPU path only - WebGL has no
// uniform groups; this stays a no-op there). The tick seams (rollerSpinTick, the belt/chain
// scroll ticks) call markTickUniformsAdvanced whenever they wrote a tick uniform, so stock
// render paths (`?nobundle`, bundle re-records, overlay passes, XR) pass the shared-group
// version gate (Bindings._update) and upload the fresh bytes. Bundled replay frames don't
// need the bump - bundleReplayRefresh uploads the captured tick bindings directly.
let tickUniformBump: (() => void) | null = null
export function setTickUniformBump(bump: (() => void) | null): void {
  tickUniformBump = bump
}
export function markTickUniformsAdvanced(): void {
  tickUniformBump?.()
}

// the WebGPU TSL version of the triplanar metal (metalNodeMaterial.ts), injected by
// createRenderer once three/webgpu is loaded. null on the WebGL path. WebGPU ignores the
// onBeforeCompile hook below, so without this the metal would render as flat base colour.
let metalNodeFactory: ((spec: MetalSpec, tex: Texture) => MeshStandardMaterial) | null = null
export function setMetalNodeFactory(factory: ((spec: MetalSpec, tex: Texture) => MeshStandardMaterial) | null): void {
  metalNodeFactory = factory
}

// the WebGPU TSL belt fabric (beltNodeMaterial.ts), injected by createRenderer. On WebGPU a plain
// belt material freezes: three's NodeMaterialObserver skips its uv-transform uniform refresh, and
// identical belts share one observer whose per-frame renderId gate lets only the first belt drawn
// each frame scroll. The node material reports hasNode → always refreshed. null on the WebGL path
// (where the plain MeshStandardMaterial below scrolls fine).
let beltNodeFactory: ((tex: Texture, uv: BeltUvTransform) => BeltNodeMaterial) | null = null
export function setBeltNodeFactory(factory: ((tex: Texture, uv: BeltUvTransform) => BeltNodeMaterial) | null): void {
  beltNodeFactory = factory
}

// the WebGPU TSL deck surface (deckNodeMaterial.ts), injected by createRenderer. A deck's tiling
// is a material uniform rather than the texture's own `repeat` so every deck shares one texture
// pair (see deckSurfaceMaterial); WebGPU ignores the onBeforeCompile that does it on the WebGL
// path, so without this factory a deck would render one stretched crop per slab.
let deckNodeFactory: ((map: Texture, nrm: Texture, repeat: Vector2, look: WalkLook) => MeshStandardMaterial) | null = null
export function setDeckNodeFactory(factory: ((map: Texture, nrm: Texture, repeat: Vector2, look: WalkLook) => MeshStandardMaterial) | null): void {
  deckNodeFactory = factory
}

/**
 * What the WebGPU belt factory hands back: the material plus a rebind hook, because the sampled fabric
 * changes over a belt's life (the weave swap) and the node material owns the TextureNode it's bound to.
 */
export interface BeltNodeMaterial {
  material: MeshStandardMaterial
  /** point the material at another fabric Texture - no material/pipeline rebuild (beltNodeMaterial.ts) */
  setTexture(tex: Texture): void
}

// the WebGPU TSL scroll material (scrollNodeMaterial.ts), injected by createRenderer. A geometry() scroll channel
// (MeshPart.scroll: a chain's links, a belt's weave) moves its texture.offset each running frame (sdk/rigProcedural.ts
// procTick); on WebGPU a plain material's uv transform never refreshes (the same NodeMaterialObserver gap as the
// belt above), so the WebGPU path swaps in this node material. null on the WebGL path (a plain clone scrolls fine there).
let scrollNodeFactory: ((tex: Texture, metalness: number, roughness: number) => MeshStandardMaterial) | null = null
export function setScrollNodeFactory(factory: ((tex: Texture, metalness: number, roughness: number) => MeshStandardMaterial) | null): void {
  scrollNodeFactory = factory
}

/**
 * Build a scrolling material carrying the private (scrollable) texture copy `tex`: on WebGPU the TSL node
 * material (so the procTick offset scroll refreshes - see scrollNodeMaterial.ts), else a clone of `template`
 * (which scrolls its uv transform fine on WebGL). `template` is the submesh's source material - its
 * colour/metalness/roughness carry over so both paths read identically, and the caller still owns `tex`
 * (disposal + offset).
 */
export function scrollMaterial(template: MeshStandardMaterial, tex: Texture): MeshStandardMaterial {
  const nodeFactory = webgpuNodeFactory(scrollNodeFactory, 'scroll')
  if (nodeFactory) {
    const mat = nodeFactory(tex, template.metalness, template.roughness)
    mat.color.copy(template.color)
    return mat
  }
  const clone = template.clone()
  clone.map = tex
  return clone
}


// WebGPU node materials have no `customProgramCacheKey` (the WebGL dedup a few lines down), so each
// `new MeshStandardNodeMaterial` compiles its own GPU render pipeline: N identical conveyors → N
// pipelines, and the cold-load compileAsync pre-warm compiles every one (measured ~19s across 365
// near-duplicate materials on the demo scene; see e2e/perf-webgpu-load.mjs). Mirror the WebGL
// cache-key dedup by handing every consumer of the same static spec one shared node material, so the
// renderer compiles that pipeline once.
//
// Excluded (kept per-instance): `spin` specs - rollers/diverter arms drive a per-instance spinUniform,
// so sharing would couple their rotation - and caller-supplied textures (an SDK part's own albedo; the
// url-based key can't tell two different textures apart). Shared instances are module singletons: their
// dispose() is neutered so the many per-part `mat.dispose()` teardown loops leave them intact, exactly
// like the module-shared geometries (unitBox) in this file. A caller that will
// re-tint its material in place (`owned`: a function part's colorParam) gets its own, or the tint would
// repaint every same-role part in the scene.
const sharedNodeMetals = new Map<string, MeshStandardMaterial>()
function sharedNodeMetal(
  spec: MetalSpec,
  tex: Texture,
  cacheable: boolean,
  factory: (spec: MetalSpec, tex: Texture) => MeshStandardMaterial,
): MeshStandardMaterial {
  if (!cacheable || spec.spin === true) return factory(spec, tex)
  const key = `${spec.url}|${spec.color}|${spec.boost}|${spec.metalness}|${spec.roughness}|${spec.triScale}`
  let mat = sharedNodeMetals.get(key)
  if (!mat) {
    mat = factory(spec, tex)
    mat.dispose = () => {} // module singleton - must survive per-part teardown loops
    sharedNodeMetals.set(key, mat)
  }
  return mat
}

function metalMaterial(spec: MetalSpec, texOverride?: Texture, owned = false): MeshStandardMaterial {
  // texOverride: an already-loaded texture (an SDK part's imported albedo) instead of a vendored URL; spec.url
  // is then used only for the shader-program cache key. Default: load the vendored texture by URL.
  const tex = texOverride ?? loadMetalTexture(spec.url)
  // WebGPU can't run the onBeforeCompile GLSL below; use the TSL NodeMaterial port instead. Static node
  // materials are shared per-spec (sharedNodeMetal) so identical conveyor hardware compiles one pipeline.
  const nodeFactory = webgpuNodeFactory(metalNodeFactory, 'metal')
  if (nodeFactory) return sharedNodeMetal(spec, tex, texOverride === undefined && !owned, nodeFactory)
  const mat = new MeshStandardMaterial({ color: spec.color, metalness: spec.metalness, roughness: spec.roughness })
  const spin = spec.spin === true
  // shared across this material's lifetime; the conveyor's tick drives `.value` (radians)
  const spinUniform = { value: 0 }
  if (spin) mat.userData.spinUniform = spinUniform
  const key = `oipMetal:${spec.url}:${spec.boost}:${spec.triScale}${spin ? ':spin' : ''}`
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMetalTex = { value: tex }
    shader.uniforms.uTriScale = { value: spec.triScale }
    shader.uniforms.uTexBoost = { value: spec.boost }
    if (spin) shader.uniforms.uSpin = spinUniform
    // Spin samples in OBJECT space (the shared base cylinder, axis = local Z) so the
    // spin rotation about Z is correct for every roller regardless of part yaw, the
    // turntable deck rotation, or a curved roller's per-instance yaw. Everything else
    // samples in world space so the metal tiles at a fixed scale across parts.
    // World sampling must fold in instanceMatrix (three applies it later, in project_vertex):
    // without it every instance of a bank samples the template-local crop - a scaled steel piece
    // (belt rail/guard) smears the grain. mat3(instanceMatrix) on the normal is exact for the banks we emit (rigid rotation +
    // axis-aligned scale, and the triplanar blend renormalizes) - not a general inverse-transpose.
    const triVarying = spin
      ? 'vTriPos = transformed;\nvTriNrm = objectNormal;\n#include <project_vertex>'
      : `#ifdef USE_INSTANCING
      vTriPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      vTriNrm = mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal;
      #else
      vTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vTriNrm = mat3(modelMatrix) * objectNormal;
      #endif
      #include <project_vertex>`
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      .replace('#include <project_vertex>', triVarying)
    let fragCommon =
      '#include <common>\nuniform sampler2D uMetalTex;\nuniform float uTriScale;\nuniform float uTexBoost;\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;'
    if (spin) fragCommon += '\nuniform float uSpin;'
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragCommon)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          ${spin
            ? `float cs = cos(uSpin), sn = sin(uSpin);
               mat2 rot = mat2(cs, sn, -sn, cs);
               vec3 tp = vec3(rot * vTriPos.xy, vTriPos.z);
               vec3 tn = vec3(rot * vTriNrm.xy, vTriNrm.z);`
            : `vec3 tp = vTriPos; vec3 tn = vTriNrm;`}
          vec3 bw = abs(normalize(tn));
          bw /= (bw.x + bw.y + bw.z);
          vec3 mx = texture2D(uMetalTex, tp.zy * uTriScale).rgb;
          vec3 my = texture2D(uMetalTex, tp.xz * uTriScale).rgb;
          vec3 mz = texture2D(uMetalTex, tp.xy * uTriScale).rgb;
          vec3 mtex = mx * bw.x + my * bw.y + mz * bw.z;
          diffuseColor.rgb *= mtex * uTexBoost;
        }`,
      )
  }
  mat.customProgramCacheKey = () => key
  return mat
}

const METAL_URL = '/textures/Metal.webp'
const ROLLER_URL = '/textures/RollerMetal.webp'

// A conveyor frame is powder-coated steel: the surface is paint, a dielectric, so it shows its albedo rather
// than mirroring the environment. At metalness 0.85 the diffuse term all but vanishes and a declared
// light blue (86,167,200) renders as near-black teal (4,43,56).
export const railMaterial = (owned = false): MeshStandardMaterial =>
  metalMaterial({ url: METAL_URL, color: 0x56a7c8, boost: 1.5, metalness: 0.35, roughness: 0.45, triScale: 1.4 }, undefined, owned)

// spur-conveyor gap fill = the same painted frame steel tinted white
export const gapFillMaterial = (owned = false): MeshStandardMaterial =>
  metalMaterial({ url: METAL_URL, color: 0xffffff, boost: 1.5, metalness: 0.35, roughness: 0.45, triScale: 1.4 }, undefined, owned)

export const rollerMaterial = (): MeshStandardMaterial =>
  metalMaterial({ url: ROLLER_URL, color: 0xffffff, boost: 1.15, metalness: 0.8, roughness: 0.34, triScale: 3.0, spin: true })

/**
 * Object/world-space triplanar metal from an already-loaded texture (an SDK part's imported albedo) rather
 * than a vendored URL. Fixes UV smear on a GLB whose meshes have no usable UVs along their length (the texture
 * pins to one line and smears, e.g. the SDK Diverter's telescoping arms), driveable from a custom part's
 * manifest. `spec.spin: true` selects the object-space projection (grain locked to the geometry as an arm
 * telescopes, so it doesn't swim); `spec.url` keys the shader program only (the texture is supplied), so pass
 * the asset's url/id.
 */
export function triplanarMetalMaterial(spec: MetalSpec, tex: Texture): MeshStandardMaterial {
  return metalMaterial(spec, tex)
}

// legs read as matte galvanised grey: low metalness so the albedo (and the thin
// foot plates) stay lit instead of going black under the bed's shadow
export const legMaterial = (owned = false): MeshStandardMaterial =>
  metalMaterial({ url: METAL_URL, color: 0xbcc1c7, boost: 1.55, metalness: 0.4, roughness: 0.62, triScale: 1.4 }, undefined, owned)

export const boltMaterial = (owned = false): MeshStandardMaterial =>
  metalMaterial({ url: METAL_URL, color: 0xeceef2, boost: 1.4, metalness: 0.85, roughness: 0.28, triScale: 2.0 }, undefined, owned)

export const guardMaterial = (owned = false): MeshStandardMaterial =>
  // bare sheet steel, so it keeps a metallic sheen, but at 0.9 a near-white albedo renders mid grey (77,76,75)
  metalMaterial({ url: METAL_URL, color: 0xeef1f5, boost: 1.7, metalness: 0.5, roughness: 0.4, triScale: 1.6 }, undefined, owned)

// The two walking surfaces, finish 'tread' (steel tread plate: stairs, access platforms) and finish 'deck' (a solid
// concrete deck: an equipment platform). Each is an albedo + normal map pair under /textures: the tread plate and
// both normal maps are generated by scripts/build-deck-textures.mjs, the concrete albedo is the warehouse floor's.
// UV-mapped (not triplanar) so they survive on instanced box pools, where world-space triplanar collapses to one
// uniform crop across every instance. Shared, never disposed: one Texture pair app-wide per surface, for every
// deck in the scene.
//
// Tiling is a per-material uniform (deckSurfaceMaterial below), never the texture's own `repeat`: a
// Texture is where three keeps the uv transform, so per-deck tiling would mean a Texture per deck, one
// GPU allocation each on WebGPU (~10.7 MB of VRAM per platform/stairs placement for the same two 1024²
// images). The belt bank makes the same move with its fabric uv. Gated by e2e/verify-texture-residency.mjs.
//
// DECK_TINT multiplies the albedo on both paths (deckNodeMaterial.ts reads it too). The map is a pale concrete,
// and untinted every platform and stair reads as a white sheet, the brightest surface in the scene, next to a
// warehouse floor it should match. A mid grey keeps the texture's grain and brings it back into range.
export const DECK_TINT = 0x9a9ea3

/** A walking-surface finish: the rig finishes whose material tiles per metre of the surface. */
export type WalkFinish = 'deck' | 'tread'
/** How one walking surface looks, read by both backends (deckNodeMaterial.ts is the WebGPU half). */
export interface WalkLook {
  map: string
  normalMap: string
  /** multiplies the albedo */
  tint: number
  metalness: number
  roughness: number
}
// The tread plate's albedo carries its own steel grey, so it is untinted; a little metal and a mid roughness let
// the lugs' crowns catch the light the way worn plate does, without the surface going dark the way a fully
// metallic one does under a dim environment.
export const WALK_LOOKS: Readonly<Record<WalkFinish, WalkLook>> = {
  deck: { map: '/textures/BuildingFloor.webp', normalMap: '/textures/DeckSolidNormal.webp', tint: DECK_TINT, metalness: 0, roughness: 0.85 },
  tread: { map: '/textures/TreadPlate.webp', normalMap: '/textures/TreadPlateNormal.webp', tint: 0xffffff, metalness: 0.3, roughness: 0.55 },
}
const walkTextures = new Map<WalkFinish, { map: Texture; normalMap: Texture }>()
function deckTextures(kind: WalkFinish): { map: Texture; normalMap: Texture } {
  let maps = walkTextures.get(kind)
  if (!maps) {
    const look = WALK_LOOKS[kind]
    // identity uv transform: the repeat is the material's, not the texture's
    const map = loadTextureBitmap(look.map)
    map.wrapS = map.wrapT = RepeatWrapping
    map.colorSpace = SRGBColorSpace
    const normalMap = loadTextureBitmap(look.normalMap, undefined, 'normal')
    normalMap.wrapS = normalMap.wrapT = RepeatWrapping
    maps = { map, normalMap }
    walkTextures.set(kind, maps)
  }
  return maps
}

/**
 * A walking-surface material that tiles its shared maps `repeat` times across the mesh's 0..1 UVs.
 * `repeat` is live: setExtent writes into that Vector2 and both backends read it through a uniform,
 * so a resize needs no rebind and no new texture.
 */
function deckSurfaceMaterial(repeat: Vector2, kind: WalkFinish): MeshStandardMaterial {
  const maps = deckTextures(kind)
  const { map, normalMap } = maps
  const look = WALK_LOOKS[kind]
  const nodeFactory = webgpuNodeFactory(deckNodeFactory, 'deck')
  // Two test seams, identical on both paths. userData.deckRepeat is the live tiling; with no
  // texture.repeat to inspect, a gate reads it to prove setExtent reaches the shader.
  // userData.deckMaps is the shared pair every deck must sample. One object identity across the
  // scene is the residency invariant, checkable without counting bytes.
  if (nodeFactory) {
    const nodeMat = nodeFactory(map, normalMap, repeat, look)
    nodeMat.userData.deckRepeat = repeat
    nodeMat.userData.deckMaps = maps
    return nodeMat
  }
  const mat = new MeshStandardMaterial({ map, normalMap, color: look.tint, metalness: look.metalness, roughness: look.roughness })
  mat.userData.deckRepeat = repeat
  mat.userData.deckMaps = maps
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uDeckRepeat'] = { value: repeat }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uDeckRepeat;')
      // both varyings are assigned in <uv_vertex> from the (identity) texture transforms; scaling
      // them here is the tiling a texture repeat would apply, without a Texture per deck
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv *= uDeckRepeat;\n\tvNormalMapUv *= uDeckRepeat;')
  }
  // one program for every deck of either surface: the shader text is identical, only uniforms and maps differ
  mat.customProgramCacheKey = () => 'deck'
  return mat
}

export const deckMaterial = (): MeshStandardMaterial => deckSurfaceMaterial(new Vector2(2, 2), 'deck')

/**
 * The deck map tiles 2× per metre: the deck is UV'd in world metres and
 * scaled by 2, so the floor crop stays a fixed ~0.5 m square at every deck size.
 */
export const DECK_TILES_PER_M = 2

/** A walking-surface finish on a drawn submesh: its texture sampled triplanar in world space at the deck density, so
 *  a swept or lofted shape reads as the same floor (a drawn shape has no box size to tile by, the way a deck link's
 *  material does). Albedo only: the link's normal map needs UVs. */
export const deckTriplanarMaterial = (kind: WalkFinish = 'deck'): MeshStandardMaterial => {
  const look = WALK_LOOKS[kind]
  return metalMaterial({ url: look.map, color: look.tint, boost: 1, metalness: look.metalness, roughness: look.roughness, triScale: DECK_TILES_PER_M })
}

/**
 * A deck surface whose floor texture tiles at the fixed world density above rather
 * than smearing one 0..1 box crop across the whole slab. The shared deckMaterial()
 * bakes a constant 0..1 UV, so a large or non-square deck stretches the texture (the
 * reported "stretched" platform/stairs floor). This owns its tiling, so each part, or each uniform-size pool
 * within a part (a stairs flight's treads/risers/landing), sets its own repeat from its metre dimensions via
 * setExtent. Plain UV-mapped, so it works on both the WebGL and WebGPU renderers. Dispose it with the part.
 */
export interface DeckSurface {
  material: MeshStandardMaterial
  setExtent(uMeters: number, vMeters: number): void
  /** Tile a unit-box mesh scaled to `size` metres by its broad face, the one across its thinnest side: a slab's top
   *  (a tread, a deck), a plate's front (a riser). Its other faces are edges too thin to show the pattern. */
  setBoxExtent(size: readonly [number, number, number]): void
  dispose(): void
}

/** The broad face of a box, as the (u, v) metres its UVs span: three's BoxGeometry maps the ±Y faces U→X, V→Z,
 *  the ±X faces U→Z, V→Y and the ±Z faces U→X, V→Y. */
export function boxFaceExtent(size: readonly [number, number, number]): [number, number] {
  const [x, y, z] = size
  if (y <= x && y <= z) return [x, z]
  if (x <= z) return [z, y]
  return [x, y]
}

export function createDeckSurface(kind: WalkFinish = 'deck'): DeckSurface {
  // the deck's own tiling, and the only per-instance state here: the maps behind it are
  // shared app-wide (deckTextures) and this Vector2 is what the material's uniform reads
  const repeat = new Vector2(DECK_TILES_PER_M, DECK_TILES_PER_M)
  const material = deckSurfaceMaterial(repeat, kind)
  // u/v metres are the textured face's extents along the box UV axes: a top/deck
  // face maps U→local X, V→local Z; a riser front face maps U→local Z, V→local Y
  const setExtent = (uMeters: number, vMeters: number): void => {
    repeat.set(Math.max(uMeters, 0.01) * DECK_TILES_PER_M, Math.max(vMeters, 0.01) * DECK_TILES_PER_M)
  }
  return {
    material,
    setExtent,
    setBoxExtent(size: readonly [number, number, number]): void {
      const [u, v] = boxFaceExtent(size)
      setExtent(u, v)
    },
    dispose(): void {
      // Nothing to retire: the floor maps live for the app and are shared by every deck, so a deleted
      // platform/stairs frees no texture. The material is safe to dispose: its dispose routes through
      // bindings.deleteForRender, which the stale-recording guard counts and acts on the same frame.
      material.dispose()
    },
  }
}

/**
 * The belt weaves are plain `<img>` elements (three wraps them in a Texture directly, with no
 * ImageBitmap decode), so they need this wrapper. Every other asset path reaches the network
 * through gltf.ts and so goes through the asset seam; a raw `new Image()` would bypass it.
 * Both halves of that seam matter:
 *   - non-speculative: 183 KB the belts on screen are waiting for, so it counts toward the
 *     assets-quiet signal the idle catalog sweep yields to (beginAssetLoad).
 *   - speculative: prefetchConveyorTextures is the first thing controller.warmCatalog does.
 *     Unrecorded, the sweep's opening fetch looks like one of the user's own assets, arriving
 *     after everything else. e2e/verify-first-load.mjs then fails locally with "the warm fetched
 *     before the scene settled" (the warm's own byte is the late scene byte), and on a slow CI
 *     runner with "the warm never ran" (the ledger stays empty because the sweep gets no further
 *     than this call inside the window).
 */
function loadWeaveImage(url: string): HTMLImageElement {
  const img = new Image()
  noteSpeculativeFetch(url)
  const endAsset = isSpeculativeWarm() ? () => {} : beginAssetLoad()
  img.addEventListener('load', endAsset, { once: true })
  img.addEventListener('error', endAsset, { once: true }) // a 404 must release the signal too
  img.src = versionedAssetUrl(url) // after the listeners: nothing here may outrun them
  return img
}

let beltFabric: HTMLImageElement | null = null

/** belt fabric (a 4K fabric diffuse map, downscaled), shared across belts */
export function getBeltFabricImage(): HTMLImageElement {
  if (beltFabric) return beltFabric
  beltFabric = loadWeaveImage('/textures/BeltFabric.jpg')
  return beltFabric
}

let beltFabricAlt: HTMLImageElement | null = null

/**
 * Alternate belt weave: the directional-arrows fabric (the alternate
 * belt texture). The asset is pre-rotated 90° so the chevrons run along the belt-travel (u) axis. The geometry
 * bakes u = along-travel / v = across-width, so a straight sample of the source image would point the arrows
 * across the belt. Rotating the image instead of the UVs keeps repeat/offset scroll identical to
 * the plain weave. Shared across belts.
 */
export function getBeltFabricAltImage(): HTMLImageElement {
  if (beltFabricAlt) return beltFabricAlt
  beltFabricAlt = loadWeaveImage('/textures/BeltFabricArrows.jpg')
  return beltFabricAlt
}

/** belt-texture styles: 'standard' plain weave vs 'alternate' directional-arrows weave */
export type BeltTextureVariant = 'standard' | 'alternate'

/**
 * One fabric Texture per weave variant, app-wide. Every belt in the scene samples these, and so do
 * the instanced banks (beltFabricBank.ts takes them from here). Their uv transform stays identity:
 * a belt's tiling and scroll are on its own material (createBeltSurface below), never the texture.
 *
 * Why: a Texture is where three keeps offset/repeat, so scrolling one per belt would force a Texture
 * per belt, one GPU allocation each on WebGPU (5.3 MB of the same 1024² weave per curved bed). Straight
 * beds bank and carry per-belt state in vertex attributes; a curved bed is a swept ribbon and can't
 * bank (see createBeltSurface's weave-swap note). Gated by e2e/verify-texture-residency.mjs.
 */
const weaveTextures = new Map<BeltTextureVariant, Texture>()
export function beltWeaveTexture(variant: BeltTextureVariant): Texture {
  const hit = weaveTextures.get(variant)
  if (hit) return hit
  const img = variant === 'alternate' ? getBeltFabricAltImage() : getBeltFabricImage()
  const tex = new Texture(img)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.colorSpace = SRGBColorSpace
  // The belt is the flattest, most-viewed surface and its whole point is to show motion (the
  // scrolling fabric weave). Without anisotropic filtering, at grazing angles the weave mip-blurs
  // into a flat band along the travel axis and the scroll becomes invisible - the belt "stops
  // moving" depending on the camera angle. Match the 4x used on the other grazing-angle surfaces.
  tex.anisotropy = 4
  if (img.complete) tex.needsUpdate = true
  else img.addEventListener('load', () => { tex.needsUpdate = true }, { once: true })
  weaveTextures.set(variant, tex)
  return tex
}

/**
 * A belt's own uv transform over the shared weave: `repeat` tiles the fabric along the bed
 * (refresh sets it from the length) and `offset.x` is the scroll accumulator the tick advances.
 * Callers mutate it in place. Both backends read these Vector2s through a material uniform, so nothing
 * rebinds when they change.
 */
export interface BeltUvTransform {
  readonly offset: Vector2
  readonly repeat: Vector2
}

export interface BeltSurface {
  material: MeshStandardMaterial
  /** this belt's tiling + scroll (the weave Texture itself is shared and stays identity) */
  readonly uv: BeltUvTransform
  /** swap the sampled fabric between the plain weave and the arrows weave (the belt-texture param) */
  setVariant(variant: BeltTextureVariant): void
  /** teardown hook (call at teardown, never mid-frame) */
  dispose(): void
}

/**
 * Belt surface: albedo = fabric texture × white, roughness 0.85. Each belt has its own uv transform
 * (independent repeat + scroll offset) over the shared, sRGB-decoded weave textures.
 *
 * One texture per weave variant, minted lazily and never disposed. A weave swap rebinds; it never
 * mutates or disposes a live texture. The instanced bank (beltFabricBank.ts) keeps variants as
 * separate textures the same way.
 *
 * Why not swap the image in place on one Texture: the weaves differ in pixel size (plain 1024², arrows
 * 512²), and three's WebGPU backend allocates a sampled texture's GPUTexture once (Textures.updateTexture
 * gates createTexture on isDefaultTexture). A bare needsUpdate would keep sampling the old-sized
 * allocation, so the swap would only show after a reload. Forcing it with texture.dispose() would destroy
 * the GPUTexture synchronously, mid-frame, while already-recorded command buffers still reference it:
 * "Destroyed texture used in a submit". A rejected submit drops the whole command buffer, so every pass in
 * that frame would draw nothing and the scene would go black for a moment. With separate textures nothing is resized and nothing is
 * destroyed while in flight, so neither failure can happen.
 */
export function createBeltSurface(): BeltSurface {
  // The belt's uv transform. It is kept here, not on a texture: the weave textures are app-wide
  // singletons (beltWeaveTexture), so tiling and scroll have to be on the material or every belt would
  // need its own Texture. The scroll tick mutates offset in place and both backends bind these Vector2s
  // as live uniforms. A weave swap keeps the accumulated scroll because the pair is never re-created;
  // only the sampled texture changes.
  const uv: BeltUvTransform = { offset: new Vector2(0, 0), repeat: new Vector2(1, 1) }
  let variant: BeltTextureVariant = 'standard'
  let active = beltWeaveTexture(variant)
  // WebGPU: use the TSL node material so the scroll doesn't freeze (see setBeltNodeFactory). WebGL:
  // a plain MeshStandardMaterial whose uv patch applies the same transform in the vertex shader.
  const nodeFactory = webgpuNodeFactory(beltNodeFactory, 'belt')
  const node = nodeFactory ? nodeFactory(active, uv) : null
  const material = node ? node.material : beltWebglMaterial(active, uv)
  // Test seam, identical on both paths (cf. the deck surface's userData.deckRepeat): this belt's live
  // tiling + scroll. With the weave textures shared there is no per-belt texture.offset to read. A gate
  // asserts that two belts at different speeds hold different phases; a shared transform would move
  // the whole scene's fabric as one.
  material.userData.beltUv = uv
  return {
    material,
    uv,
    // Bind the variant's own texture. The old one stays allocated and bound until the (lazily fetched)
    // new image has decoded, so there's never a frame with nothing to sample - the no-black-flash
    // guarantee the first switch to the arrows weave depends on. On WebGL reassigning material.map is
    // enough (same program key - map present before and after - so no recompile); on WebGPU the node
    // material rebinds its TextureNode.
    setVariant(next: BeltTextureVariant): void {
      if (next === variant) return
      variant = next
      const tex = beltWeaveTexture(next)
      const img = tex.image as HTMLImageElement
      const commit = (): void => {
        if (variant !== next) return // a later switch superseded this one before the image decoded
        active = tex
        if (node) node.setTexture(tex)
        else material.map = tex
        // A rebind alone never reaches a replayed draw: a recorded WebGPU bundle holds the bind group
        // built from the previous texture, so on an otherwise-idle scene the belt keeps showing the old
        // weave indefinitely. This is the "data changed, pixels didn't" class (bundleGroups.ts), as with a
        // late-decoding texture (gltf.ts). One structural notify re-records with the new binding. Under
        // WebGL or with bundles off it is a no-op counter bump. texture.dispose() would also drop the
        // cached bind groups, but only by destroying the GPUTexture, which blacks out the frame.
        notifyBundleStructureChanged()
      }
      if (img.complete && img.naturalWidth > 0) commit()
      else img.addEventListener('load', commit, { once: true })
    },
    dispose(): void {
      // Nothing to free. The weave textures are app-wide singletons shared with every other belt and
      // with the instanced banks, so a deleted belt owns no GPU texture and the black-frame hazard
      // above cannot occur. The material is disposed by its owner: functionMesh/mesh push it onto the
      // part's material list.
    },
  }
}

/**
 * WebGL belt fabric: the shared weave sampled through this belt's uv transform. The texture's own
 * offset/repeat would be composed into a per-texture mapTransform uniform, hence a texture per belt;
 * two vec2 uniforms in the vertex shader do the same job over shared pixels. The deck surface does
 * the same for its tiling, and the instanced bank does it with per-instance attributes. Its WebGPU twin is beltNodeMaterial.ts.
 */
function beltWebglMaterial(tex: Texture, uv: BeltUvTransform): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ color: 0xffffff, map: tex, metalness: 0, roughness: 0.85 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uBeltOffset'] = { value: uv.offset }
    shader.uniforms['uBeltRepeat'] = { value: uv.repeat }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uBeltOffset;\nuniform vec2 uBeltRepeat;')
      // vMapUv is assigned in <uv_vertex> from the (identity) map transform; this is the belt's own
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv = vMapUv * uBeltRepeat + uBeltOffset;')
  }
  // one program for every belt: identical shader text, only the uniforms differ
  mat.customProgramCacheKey = () => 'belt'
  return mat
}

/**
 * Warm the loose conveyor textures (belt fabric + the triplanar metal/roller
 * maps) so the first belt/frame spawn binds an already-decoded image instead of
 * flashing black while a cold network fetch resolves. The belt fabric especially:
 * it's the big flat visible surface and the only texture left on the lazy
 * `new Image()` path with no other warm-up, so over a real network its fetch
 * (started on first spawn) leaves the belt black for a second or two - invisible
 * in dev where it streams off localhost. Idempotent: both loaders are
 * singleton-cached, so an early call just moves the fetch ahead of first spawn
 * (free if a belt is later placed, harmless waste if not). Call from app idle
 * time, never on the critical path.
 */
export function prefetchConveyorTextures(): void {
  getBeltFabricImage()
  loadMetalTexture(METAL_URL)
  loadMetalTexture(ROLLER_URL)
}

// Selection is drawn by the screen-space selection outline, so parts don't tint.
// Kept (and clears any emissive on deselect) so every part's setSelected stays uniform.
export function setSelectedMaterials(materials: readonly Material[], on: boolean): void {
  if (on) return
  for (const mat of materials) {
    const std = mat as MeshStandardMaterial
    if (std.isMeshStandardMaterial) std.emissive.setHex(0x000000)
  }
}

export function shadowMesh(geometry: BufferGeometry, material: Material, castShadow = true): Mesh {
  const mesh = new Mesh(geometry, material)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  return mesh
}

const tmpMat = new Matrix4()
const tmpPos = new Vector3()
const tmpQuat = new Quaternion()
const tmpScale = new Vector3()

export interface BoxPlacement {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  /** optional orientation; identity when absent */
  q?: { x: number; y: number; z: number; w: number }
}

/**
 * Fill an InstancePool with a list of axis-aligned (or quat-oriented) boxes,
 * growing the buffer to fit. Shared by the procedural structural parts
 * (platform/stairs/rack) whose piece count scales with their size.
 */
export function fillInstances(pool: InstancePool, placements: readonly BoxPlacement[]): void {
  ensureInstanceCapacity(pool, Math.max(placements.length, 1))
  const mesh = pool.mesh
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!
    tmpPos.set(p.x, p.y, p.z)
    if (p.q) tmpQuat.set(p.q.x, p.q.y, p.q.z, p.q.w)
    else tmpQuat.identity()
    tmpScale.set(Math.max(p.sx, 1e-4), Math.max(p.sy, 1e-4), Math.max(p.sz, 1e-4))
    tmpMat.compose(tmpPos, tmpQuat, tmpScale)
    mesh.setMatrixAt(i, tmpMat)
  }
  mesh.count = placements.length
  mesh.instanceMatrix.needsUpdate = true
  if (placements.length > 0) mesh.computeBoundingSphere()
  syncBankEmptyVisibility(mesh) // gate-empty bank (all segments cut / toggle off) ⇒ invisible, not a no-op draw that still costs codegen
}

/** guard wall centre z for a bed of halfWidth */
export function guardZ(halfWidth: number): number {
  return halfWidth + FRAME_WALL_THICKNESS + GUARD_THICKNESS / 2
}

/**
 * One piece of a leg assembly in leg-local space (origin at the floor): a unit-box
 * (posts/collars/feet/sleeves/clamps/braces) or a hex bolt, scaled + placed. `up`
 * tilts a bolt's axis from local Z to Y (the foot bolts stand vertical).
 */
export interface LegPiece {
  /** a box's turn about leg-local z (a knee brace); absent = axis-aligned */
  rz?: number
  px: number
  py: number
  pz: number
  sx: number
  sy: number
  sz: number
  up?: boolean
}

/** push a min/max box as a centered+scaled LegPiece */
function boxPiece(out: LegPiece[], mnx: number, mny: number, mnz: number, mxx: number, mxy: number, mxz: number): void {
  out.push({
    px: (mnx + mxx) / 2,
    py: (mny + mxy) / 2,
    pz: (mnz + mxz) / 2,
    sx: Math.max(mxx - mnx, 1e-4),
    sy: Math.max(mxy - mny, 1e-4),
    sz: Math.max(mxz - mnz, 1e-4),
  })
}

/**
 * The floor support as instance transforms in leg-local space (floor at y 0, x along travel, z across): box pieces
 * (uprights, inner legs, foot plates, brackets, support channel, cross braces, knee braces turned `rz` about z) and
 * hex bolts. `dir` is the way the knee braces lean along x (+1 / -1, toward the middle of the bed; 0 = none).
 * `frameDepth` (deck → frame bottom) caps the mounting bracket so a shallow frame keeps it under the deck, dropping
 * any bolt it no longer reaches; omitted, the bracket takes its full rise. Same arithmetic, in the same order, as
 * examples/parts/_shared/legs.js, so the two agree to the bit.
 */
export function legPieces(width: number, height: number, dir = 0, frameDepth?: number): { boxes: LegPiece[]; bolts: LegPiece[] } {
  const boxes: LegPiece[] = []
  const bolts: LegPiece[] = []
  const hw = width / 2
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => boxPiece(boxes, x0, y0, z0, x1, y1, z1)
  const bolt = (x: number, y: number, z: number, axis: 'y' | 'z'): void => {
    bolts.push({ px: x, py: y, pz: z, sx: LEG_BOLT_R, sy: LEG_BOLT_R, sz: LEG_BOLT_DEPTH, ...(axis === 'y' ? { up: true } : {}) })
  }
  const FACE = hw + LEG_FRAME_WALL
  const LW = LEG_UPRIGHT_HALF_X
  const LD = Math.min(LEG_UPRIGHT_DEPTH, Math.max(hw - 0.02, 0.02))
  const PT = LEG_PLATE_TOP
  const CH = LEG_CHANNEL_DEPTH
  const TELE = height > 0.45 ? 0.3 : 0
  const RISE = typeof frameDepth === 'number' ? Math.max(0, Math.min(LEG_BRACKET_RISE, frameDepth - LEG_BRACKET_TOP_CLEAR)) : LEG_BRACKET_RISE
  for (let sg = 0; sg < 2; sg++) {
    const s = sg === 0 ? 1 : -1
    const zo = s * FACE, zi = s * (FACE - LD), zc = s * (FACE - LD / 2)
    const lo = Math.min(zo, zi), hi = Math.max(zo, zi)
    if (TELE > 0) {
      box(-0.042, PT, lo + 0.004, 0.042, TELE, hi - 0.004) // inner leg
      box(-LW, TELE - 0.05, lo, LW, height, hi) // outer leg, sleeved over it
      bolt(-0.025, TELE - 0.025, zo + s * 0.0035, 'z'); bolt(0.025, TELE - 0.025, zo + s * 0.0035, 'z') // adjustment bolts
    } else box(-LW, PT, lo, LW, height, hi)
    box(-LEG_FOOT_HALF_X, 0.003, zc - 0.0508, LEG_FOOT_HALF_X, PT, zc + 0.0508) // foot plate
    bolt(-0.055, PT + 0.0035, zc, 'y'); bolt(0.055, PT + 0.0035, zc, 'y') // anchor bolts
    const bo = zo + s * 0.006
    box(-0.019, height - CH, Math.min(zo, bo), 0.019, height + RISE, Math.max(zo, bo)) // mounting bracket
    for (const up of [0.04, 0.1]) if (up + LEG_BOLT_R <= RISE) bolt(0, height + up, bo + s * 0.0035, 'z') // the web bolts it still reaches
    bolt(0, height - CH / 2, bo + s * 0.0035, 'z')
    if (dir !== 0 && height > 1.0) { // knee brace: 1-1/4" angle from the upright up to the frame web, outside both
      const d = Math.min(LEG_KNEE_MAX, 0.45 * height), ax = 0, ay = height - d, bx = dir * d, by = height + 0.04
      const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, kz = s * (FACE + 0.016 + 0.006)
      boxes.push({ px: (ax + bx) / 2, py: (ay + by) / 2, pz: kz, sx: L, sy: 0.032, sz: 0.032, rz: Math.atan2(by - ay, bx - ax) })
      bolt(ax + ux * 0.03, ay + uy * 0.03, kz + s * 0.0195, 'z'); bolt(bx - ux * 0.03, by - uy * 0.03, kz + s * 0.0195, 'z')
    }
  }
  const zin = FACE - LD + 0.005 // the uprights' inner faces, lapped 5 mm
  box(-0.0222, height - CH, -zin, 0.0222, height, zin) // support channel across under the bed
  if (height >= 0.6) { // horizontal cross braces, clear of the telescoping joint
    const n = Math.min(Math.max(Math.floor(height / 0.9), 1), 3), y0 = TELE + 0.1, y1 = height - CH - 0.1
    for (let k = 0; k < n && y1 > y0; k++) { const y = y0 + ((k + 1) * (y1 - y0)) / (n + 1); box(-0.0222, y - 0.019, -zin, 0.0222, y + 0.019, zin) }
  }
  return { boxes, bolts }
}

/**
 * Per-conveyor leg hardware as two InstancedMeshes - every leg's box pieces share
 * `boxes`, every leg's bolts share `bolts` - so an N-leg conveyor draws its trestles
 * in 2 calls (+2 shadow) instead of ~28·N separate meshes. writeLegs() fills them
 * each layout; both pools share the conveyor's `material`/`boltMat`, so the
 * selection/ghost material swaps stay transparent.
 */
export interface LegPool {
  boxes: InstancePool
  bolts: InstancePool
  parent: Group
  material: Material
  boltMat: Material
}

export function createLegSet(parent: Group, material: Material, boltMat: Material): LegPool {
  // seed near one full-height leg's piece count × the default station count; grows on demand
  const boxes = createInstancePool(parent, unitBox, material, LEG_STATION_CAPACITY * 16)
  // leg-trestle bolts are tiny hex studs - no visible self-shadow, so skip the shadow pass
  const bolts = createInstancePool(parent, hexBoltGeo, boltMat, LEG_STATION_CAPACITY * 16, false)
  return { boxes, bolts, parent, material, boltMat }
}

/** free the two instance buffers when a conveyor visual is torn down */
export function disposeLegSet(pool: LegPool): void {
  // retired, not disposed: a recording may still hold these instance buffers (gpuRetire.ts).
  // Mesh-only: unitBox / hexBoltGeo are module-shared.
  retireInstancedMeshOnly(pool.boxes.mesh)
  retireInstancedMeshOnly(pool.bolts.mesh)
}

const legPieceMat = new Matrix4()
const legInstMat = new Matrix4()
const legPos = new Vector3()
const legScale = new Vector3()
const legQuatId = new Quaternion()
const legQuatUp = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)
const legQuatRz = new Quaternion()
const legAxisZ = new Vector3(0, 0, 1)
const legBoundsBox = new Box3()

// Widest leg-local reach of any piece, for the analytic bounds below: along X a knee brace's full lean (plus half
// its section), past width/2 the knee brace outside the bracket plus its bolt, above the frame bottom the bracket.
// Keep in sync with legPieces if a piece grows past these.
const LEG_REACH_X = LEG_KNEE_MAX + 0.03
const LEG_REACH_OVER_HW = LEG_FRAME_WALL + 0.016 + 0.006 + 0.016 + 0.0195 + LEG_BOLT_DEPTH
const LEG_TOP_RISE = LEG_BRACKET_RISE

/**
 * Write every leg's instance matrices into the pool. Each entry is a base transform
 * (station translate, plus a yaw for curved beds) and that leg's own height (belt
 * paths incline, so height is per-leg). Legs below LEG_MIN_HEIGHT are dropped. Box
 * pieces fill pool.boxes, bolts fill pool.bolts; both grow to fit. The per-leg
 * instance = base ∘ (piece translate · [bolt tilt] · piece scale). `frameDepth` is the
 * bed's deck → frame bottom, which caps the mounting brackets (legPieces).
 */
export function writeLegs(
  pool: LegPool,
  width: number,
  legs: readonly { base: Matrix4; height: number; dir?: number }[],
  frameDepth?: number,
): void {
  const built = legs
    .filter((l) => l.height >= LEG_MIN_HEIGHT)
    .map((l) => ({ base: l.base, height: l.height, ...legPieces(width, l.height, l.dir ?? 0, frameDepth) }))
  ensureInstanceCapacity(pool.boxes, built.reduce((s, l) => s + l.boxes.length, 0))
  ensureInstanceCapacity(pool.bolts, built.reduce((s, l) => s + l.bolts.length, 0))
  // ensureInstanceCapacity may have swapped in a larger mesh, so read after
  const boxMesh = pool.boxes.mesh
  const boltMesh = pool.bolts.mesh
  let nb = 0
  let nt = 0
  for (const { base, boxes, bolts } of built) {
    for (const pc of boxes) {
      legPieceMat.compose(legPos.set(pc.px, pc.py, pc.pz), pc.rz ? legQuatRz.setFromAxisAngle(legAxisZ, pc.rz) : legQuatId, legScale.set(pc.sx, pc.sy, pc.sz))
      legInstMat.multiplyMatrices(base, legPieceMat)
      boxMesh.setMatrixAt(nb++, legInstMat)
    }
    for (const pc of bolts) {
      legPieceMat.compose(legPos.set(pc.px, pc.py, pc.pz), pc.up ? legQuatUp : legQuatId, legScale.set(pc.sx, pc.sy, pc.sz))
      legInstMat.multiplyMatrices(base, legPieceMat)
      boltMesh.setMatrixAt(nt++, legInstMat)
    }
  }
  boxMesh.count = nb
  boltMesh.count = nt
  boxMesh.instanceMatrix.needsUpdate = true
  boltMesh.instanceMatrix.needsUpdate = true
  // Analytic bounds instead of computeBoundingSphere(): iterating every instance per
  // relayout measured ~40% of writeLegs while raising N conveyors (legs re-lay every
  // frame of a vertical drag). Every base is yaw+translation (straight stations, arc
  // and circular custom layouts alike), so a yaw-proof cylinder of the widest piece
  // reach over 0..height+rise bounds each leg exactly enough for culling + raycast
  // broadphase. Also keeps boundingBox fresh: compute-on-first-read would leave it stale
  // after legs grow.
  const reach = Math.hypot(LEG_REACH_X, width / 2 + LEG_REACH_OVER_HW)
  legBoundsBox.makeEmpty()
  for (const { base, height } of built) {
    const e = base.elements
    legPos.set(e[12]! - reach, e[13]! - 1e-3, e[14]! - reach)
    legBoundsBox.expandByPoint(legPos)
    legPos.set(e[12]! + reach, e[13]! + height + LEG_TOP_RISE, e[14]! + reach)
    legBoundsBox.expandByPoint(legPos)
  }
  for (const mesh of [boxMesh, boltMesh]) {
    mesh.boundingBox ??= new Box3()
    mesh.boundingSphere ??= new Sphere()
    if (built.length === 0) {
      mesh.boundingBox.makeEmpty()
      mesh.boundingSphere.center.set(0, 0, 0)
      mesh.boundingSphere.radius = 0
    } else {
      mesh.boundingBox.copy(legBoundsBox)
      legBoundsBox.getBoundingSphere(mesh.boundingSphere)
    }
    syncBankEmptyVisibility(mesh) // legless (floor-level bed) ⇒ invisible, not a no-op draw that still costs codegen
  }
}

/**
 * Per-leg horizontal station, foot Y, and length for a (possibly inclined) bed.
 * Legs rest on the floor surface (FLOOR_SURFACE_Y), spanning up to the frame bottom.
 * On an incline (`tiltRad` != 0) the bed rises `x*sin` along its run, so a leg at
 * arc-length `x` sits at horizontal `x*cos` and grows by `x*sin` to keep its foot on
 * the floor while reaching the raised underside. Pure + exported for tests.
 */
export function computeLegPlacements(
  stations: readonly number[],
  partY: number,
  tiltRad = 0,
): { x: number; baseY: number; height: number }[] {
  const baseY = -partY + FLOOR_SURFACE_Y
  const flat = partY + frameBottomY() - FLOOR_SURFACE_Y
  const cos = Math.cos(tiltRad)
  const sin = Math.sin(tiltRad)
  return stations.map((x) => ({ x: x * cos, baseY, height: flat + x * sin }))
}

/**
 * Leg placement: tail/head stations LEG_TAIL_OFFSET in from each end,
 * middles on the LEG_SPACING grid between clearances. Returns local x values in
 * `center`..`center`+span (tail-origin; `center` defaults to the part origin 0).
 */
export function legStations(span: number, center = 0): number[] {
  if (span <= 0) return []
  const sMin = LEG_TAIL_OFFSET
  const sMax = span - LEG_TAIL_OFFSET
  const out: number[] = []
  if (sMin <= span) out.push(sMin)
  const first = Math.ceil((sMin + LEG_CLEARANCE) / LEG_SPACING) * LEG_SPACING
  const last = Math.floor((sMax - LEG_CLEARANCE) / LEG_SPACING) * LEG_SPACING
  for (let s = first; s <= last + 1e-6; s += LEG_SPACING) out.push(s)
  if (sMax >= 0 && sMax <= span && Math.abs(sMax - sMin) > 1e-6) out.push(sMax)
  // tail-origin: stations run 0..span from the part origin (no centring)
  return out.map((s) => center + s)
}
