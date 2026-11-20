import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three'
import type { Material, Object3D, PerspectiveCamera, Texture } from 'three'
import { wallRuleAt } from '../../core/building/buildingDocks'
import { INTERIOR_COLUMN_SIZE, interiorColumnHeight, interiorColumns } from '../../core/building/buildingColumns'
import { clamp } from '../../core/math'
import { DEG } from '../../core/parts/partGeometry'
import type { BuildingPart, PartInstance, WallVariant } from '../../core/types'
import {
  BUILDING_FULL_WALL_HEIGHT,
  BUILDING_HALF_WALL_HEIGHT,
  BUILDING_SECTION_SIZE,
  BUILDING_WALL_THICKNESS,
  ROOF_HIDE_PITCH_DEG,
  buildingEaveHeight,
} from '../../core/types'
import type { PartVisual } from './registry'
import { loadPartModel, gateBuildingLoad, loadTextureBitmap } from '../gltf'
import { foldStaticGroup } from '../staticFold'
import { retireGeometry, retireInstancedMeshOnly } from '../gpuRetire'
import { setSelectedMaterials, unitBox, applyPartRotation } from './common'
import { applyDockMaterial, createDockDoorBay, loadDockDoorAssets, prefetchDockDoorTextures } from './dockDoor'
import { bakedWallMaterial, prefetchWallLightmaps } from './wallLightmaps'
import type { DockDoorAssets, DockDoorBay } from './dockDoor'
import { notifyBundleStructureChanged } from '../bundleGroups'
import { webgpuNodeFactory } from '../renderMode'
import { bucketCapacity } from './instanceCapacity'
import { bumpStructureVersion } from './structureRev'
import { bumpPoseRev } from './poseRev'
import { dressGlass } from '../metalEnvironment'
import { TRIM_END, TRIM_START, trimmedEnds } from './buildingCorners'
import { WALL_SIDES, WALL_SIDES_NONE_HIDDEN, wallAutoHide, wallSidesDiffer, wantsWallAutoHide } from './wallAutoHide'
import type { WallSide, WallSidesHidden } from './wallAutoHide'

const SECTION = BUILDING_SECTION_SIZE
// The floor should take no ambient light, lit by the key+fill directionals only - no sky ambient - so it reads
// ~20% darker and warmer than the (ambient-lit) walls. three.js has no per-material ambient toggle, so approximate
// it by knocking the floor albedo down with a faintly warm grey. This restores the wall-over-floor contrast the flat
// web look loses, putting the lit floor (~99) below the walls (~120).
const FLOOR_TINT = 0xe6e2db
const ROOF_THICKNESS = 0.08
const BASE_HEIGHT = 0.4
const COLUMN_WIDTH = 0.3
const COLUMN_PROUD = 0.04
const BASE_PROUD = 0.02
const COLUMN_SPACING = 5
const COLUMN_CAPACITY = 80
// interior grid columns (core/building/buildingColumns.ts): an I-section of two flanges and a web, over a yellow
// base guard of the kind real warehouse columns wear against forklift and cargo strikes
const INTERIOR_FLANGE = 0.025
const INTERIOR_WEB = 0.015
const INTERIOR_GUARD_WIDTH = 0.5
const INTERIOR_GUARD_HEIGHT = 1.2
// dock-door open/close rate in units of the 0..1 amount per second (door
// speed ~4 m/s over the 3.1 m travel, dockDoor.ts DOOR_TRAVEL, ≈ 1.3). Scale it
// with the travel: the door's linear speed is what should stay fast
const DOCK_OPEN_SPEED = 1.3

// the GLBs ship placeholder colors; the look comes from material remaps -
// apply the BaseColor sets by glTF material name
const TEXTURE_SETS: Record<string, string> = {
  Wall_01: 'Wall_01',
  Wall_02: 'Wall_02',
  Framing_01: 'Framing_01',
  Framing_02: 'Framing_02',
  // the ribbon window's panes, split off Framing_01 by scripts/bake-wall-lighting.mjs
  Window_Glass: 'Framing_01',
  Roof_01: 'Roof_01',
  Mat_Fan: 'Fan_A',
  Mat_Light: 'Light_A',
}

const textureCache = new Map<string, Texture>()

export function buildingTexture(set: string, channel: 'BaseColor' | 'Emissive' = 'BaseColor'): Texture {
  const key = channel === 'BaseColor' ? set : `${set}_${channel}`
  let tex = textureCache.get(key)
  if (!tex) {
    // register the fetch with the building-first gate so other parts wait for
    // textures too (settle fires whether the decode succeeds or fails, so a
    // missing/failed texture can't strand the gate)
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    tex = loadTextureBitmap(
      `/models/building/textures/BuildingPart_${set}_${channel}.webp`,
      () => settle(),
      channel === 'Emissive' ? 'emissive' : 'albedo',
    )
    tex.colorSpace = SRGBColorSpace // flipY off is handled by loadTextureBitmap
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    tex.anisotropy = 4
    textureCache.set(key, tex)
    void gateBuildingLoad(done)
  }
  return tex
}

function applyDesktopMaterial(mat: Material): void {
  const set = TEXTURE_SETS[mat.name]
  if (!set || !(mat instanceof MeshStandardMaterial)) return
  mat.map = buildingTexture(set)
  mat.color.set(0xffffff)
  mat.roughness = 0.85
  mat.metalness = 0.15
  if (mat.name === 'Window_Glass') {
    mat.color.setScalar(WINDOW_GRIME)
    mat.roughness = 0.15
    mat.metalness = 0
    mat.transparent = true
    mat.opacity = WINDOW_OPACITY
    mat.depthWrite = false
  }
  if (set === 'Light_A') {
    // emission is driven off a texture so only the lamp strip glows (the housing
    // stays dark + textured); a flat emissive color would wash the whole fixture into a slab.
    mat.emissive.set(0xffffff)
    mat.emissiveMap = buildingTexture('Light_A', 'Emissive')
    mat.emissiveIntensity = 1
  }
  mat.needsUpdate = true
}

/** How the floor lays its macro cloud and saw-cut joints over the slab tile. */
export interface FloorMacro {
  /** floor uv runs one unit per cell */
  metresPerUv: number
  /** the two samples' periods in metres: they share no common repeat, so their product never visibly tiles */
  periodA: number
  periodB: number
  /** the second sample's rotation, radians, so the two clouds' lattices don't align either */
  turn: number
  /** saw-cut joints: spacing and width in metres, and how much a joint darkens the slab */
  jointSpacing: number
  jointWidth: number
  jointDarken: number
}

// Joints fall on the cell edges (the column lines) and halfway between them. A bare saw cut is ~5 mm, but sealant
// and worn edges make a real joint read wider. 16 mm shows up close and fades by mid-hall; at 20 mm the empty hall
// read as a grid of panels.
const FLOOR_MACRO: FloorMacro = {
  metresPerUv: SECTION,
  periodA: 37,
  periodB: 23,
  turn: 0.52,
  jointSpacing: SECTION / 2,
  jointWidth: 0.016,
  jointDarken: 0.5,
}

type FloorNodeFactory = (map: Texture, macro: Texture, tint: number, m: FloorMacro) => MeshStandardMaterial

// the WebGPU TSL twin of floorMaterial (floorNodeMaterial.ts), injected by createRenderer
let floorNodeFactory: FloorNodeFactory | null = null
export function setFloorNodeFactory(factory: FloorNodeFactory | null): void {
  floorNodeFactory = factory
}

function floorMacroTexture(): Texture {
  let tex = textureCache.get('FloorMacro')
  if (!tex) {
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    // data, not colour: left linear, and the loader's #808080 fallback samples as the neutral 0.5
    tex = loadTextureBitmap('/models/building/textures/BuildingPart_FloorMacro_BaseColor.webp', () => settle())
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    textureCache.set('FloorMacro', tex)
    void gateBuildingLoad(done)
  }
  return tex
}

/**
 * The floor's material: a fine-grained slab tile (Floor_A, one per 10 m cell) under a broad cloud that doesn't
 * repeat (FloorMacro), both from scripts/build-deck-textures.mjs, cut by saw joints every 5 m. In the tile, broad variation repeats as a visible
 * 10 m grid. Roughness and metalness are the building's other textured surfaces' (applyDesktopMaterial).
 */
function floorMaterial(): MeshStandardMaterial {
  const map = buildingTexture('Floor_A')
  const macro = floorMacroTexture()
  const nodeFactory = webgpuNodeFactory(floorNodeFactory, 'floor')
  const mat = nodeFactory ? nodeFactory(map, macro, FLOOR_TINT, FLOOR_MACRO) : new MeshStandardMaterial({ map, color: FLOOR_TINT })
  // e2e/verify-texture-fail-fallback.mjs finds the floor by this name, and reads its slab tile from userData, since
  // the WebGPU material samples the tile in its colorNode and has no `map`
  mat.name = 'Floor_01'
  mat.userData.floorMap = map
  mat.side = DoubleSide
  mat.roughness = 0.85
  mat.metalness = 0.15
  if (nodeFactory) return mat
  const { metresPerUv, periodA, periodB, turn, jointSpacing, jointWidth, jointDarken } = FLOOR_MACRO
  const f = (n: number): string => n.toFixed(6)
  // a joint's coverage of the pixel, box-filtered by the pixel's footprint so it thins out with distance
  // instead of aliasing (floorNodeMaterial.ts jointCoverage is the same math)
  const joints = `
\tvec2 floorD = abs(fract(floorP / ${f(jointSpacing)} + 0.5) - 0.5) * ${f(jointSpacing)};
\tvec2 floorW = max(fwidth(floorP), vec2(1e-4));
\tvec2 floorJ = clamp((${f(jointWidth / 2)} - floorD) / floorW + 0.5, 0.0, 1.0) * min(vec2(1.0), ${f(jointWidth)} / floorW);
\tdiffuseColor.rgb *= 1.0 - ${f(jointDarken)} * max(floorJ.x, floorJ.y);`
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uFloorMacro'] = { value: macro }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uFloorMacro;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
\tvec2 floorP = vMapUv * ${f(metresPerUv)};
\tvec2 floorQ = mat2(${f(Math.cos(turn))}, ${f(Math.sin(turn))}, ${f(-Math.sin(turn))}, ${f(Math.cos(turn))}) * floorP;
\tdiffuseColor.rgb *= 4.0 * texture2D(uFloorMacro, floorP / ${f(periodA)}).r * texture2D(uFloorMacro, floorQ / ${f(periodB)}).r;${joints}`,
      )
  }
  mat.customProgramCacheKey = () => 'buildingFloor'
  return mat
}

const tmpMat = new Matrix4()
const tmpMat2 = new Matrix4()
const tmpPos = new Vector3()
const tmpQuat = new Quaternion()
const tmpScale = new Vector3()

const noRaycast = (): void => {}

interface ModuleChild {
  geometry: BufferGeometry
  material: Material | Material[]
  local: Matrix4
  /** a wall's framing without its corner half-columns, by trim mask (buildingCorners.ts); absent = nothing to trim */
  trimmed?: (BufferGeometry | null)[] | null
}

interface ModuleTemplate {
  children: ModuleChild[]
  anchor: Vector3
  scale: number
}

interface ModuleSet {
  wallA: ModuleTemplate
  wallB: ModuleTemplate
  wallC: ModuleTemplate
  wallD: ModuleTemplate
  /** Roof_A minus its wall band: the eave-edge deck, trusses and fixtures */
  roofA: ModuleTemplate
  /** Roof_A's wall band - the same cladding + framing as Wall_C, which the GLB bakes into the
   *  eave-edge roof module. It is a wall: it joins its perimeter run (the near-wall auto-hide drops it
   *  with the run, and it takes the baked wall light) instead of hanging off the roof as a grey slab
   *  when the run below it is hidden. Drawn from Roof_A_Wall.glb, the band with its lightmap uvs */
  roofAWall: ModuleTemplate
  roofB: ModuleTemplate
  /** the dock-door surrounds (one opening / two), the cladding a dock bay replaces its wall cell with */
  dockA: ModuleTemplate
  dockB: ModuleTemplate
  /** the exit door a `personnel_door` cell draws over its Wall_D: frame, leaf, hardware, EXIT sign and the fire
   *  extinguisher and pull station beside it, no wall of its own (scripts/build-personnel-door.mjs) */
  personnelDoor: ModuleTemplate
}

/** materials drawn unlit rather than with the baked wall light: the lit EXIT sign reads as its own light source */
const SELF_LIT = new Set(['Exit_Sign', 'Exit_Text'])
/** materials lit live rather than baked: glass is mostly reflection, which the diffuse-only lightmap can't draw */
const LIVE_LIT = new Set(['Door_Glass', 'Window_Glass'])
/**
 * The window glass is see-through dirty glass: the sky shows behind lit streaks. Each of its two sheets is 40%
 * opaque, so the sky shows at (1 - 0.4)^2 = 36%. The pane texture is grime at ~0.03 linear, too dark to show when
 * lit, so its colour is scaled up 12x to bring the streaks to ~0.1-0.5. Compared side by side: clean glass (0.2,
 * no scale) or a tint read as empty holes, a lit opaque pane as frosted glass, and a 20x scale washed out.
 */
const WINDOW_OPACITY = 0.4
const WINDOW_GRIME = 12

const snap = (v: number, step: number): number => Math.round(v / step) * step


/**
 * The perimeter run a wall cell belongs to, by the edge it sits on: the near-wall auto-hide's unit
 * (wallAutoHide.ts), and, turned by the building's own yaw, the facing that picks its baked light.
 */
const wallSide = (yaw: number): WallSide =>
  yaw === 0 ? 'nz' : yaw === Math.PI ? 'pz' : yaw === Math.PI / 2 ? 'nx' : 'px'

/** the sides in yaw order (0, +90°, 180°, -90°), so a quarter turn of the building is a step through it */
const SIDES_BY_YAW: readonly WallSide[] = ['nz', 'nx', 'pz', 'px']
/** the building's yaw in whole quarter turns (0..3), rounded: the lightmaps exist per quarter */
const quarterTurns = (rotationY: number): number => (((Math.round(rotationY / (Math.PI / 2)) % 4) + 4) % 4)
/**
 * The world facing of a run on `side` of a building turned `quarters` quarter turns: the lightmap it
 * takes. The wall light is world-fixed, like the sun (scripts/bake-wall-lighting.mjs bakes one atlas
 * per world facing), so the run facing world -Z draws the `nz` atlas whichever building side it is.
 */
const litSide = (side: WallSide, quarters: number): WallSide => SIDES_BY_YAW[(SIDES_BY_YAW.indexOf(side) + quarters) % 4]!
const emptySides = <T,>(make: () => T): Record<WallSide, T> => ({ nz: make(), pz: make(), nx: make(), px: make() })

// wall-rule matching (which module paints a perimeter cell) is core/building/buildingDocks.ts wallRuleAt: the sim cuts its
// open dock openings from the same answer
const ruleAt = wallRuleAt

/**
 * The building modules are authored corner-anchored for 10 m cells: run along
 * +X in [0, cell], base at y=0, exterior face on z=0 with structure extending
 * inward (+z). Pivots are derived, not hardcoded: snap the measured bbox min
 * to the cell grid (panels/fascia overhang the origin by ~0.25 m, and Roof_B
 * floats ~1.5 m above its base plane, so bbox min alone is not the anchor).
 */
function analyzeTemplate(root: Group | null, wall = false): ModuleTemplate | null {
  if (!root) return null
  root.updateMatrixWorld(true)
  const bbox = new Box3().setFromObject(root)
  const cell = bbox.max.x - bbox.min.x
  if (!Number.isFinite(cell) || cell <= 0) return null
  const yStep = cell * (BUILDING_HALF_WALL_HEIGHT / BUILDING_SECTION_SIZE)
  const anchor = new Vector3(snap(bbox.min.x, cell), snap(bbox.min.y, yStep), snap(bbox.min.z, cell))
  const children: ModuleChild[] = []
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    const local = mesh.matrixWorld.clone()
    const framing = wall && !Array.isArray(mesh.material) && /^Framing/.test(mesh.material.name)
    const trimmed = framing ? trimmedEnds(mesh.geometry, local, anchor.x, anchor.x + cell) : null
    children.push({ geometry: mesh.geometry, material: mesh.material, local, trimmed })
  })
  if (children.length === 0) return null
  return { children, anchor, scale: BUILDING_SECTION_SIZE / cell }
}

// Prefetch the building textures at module import (instead of lazily, on the
// first material apply after the GLBs parse) and gate other parts behind them,
// so the building appears fully textured before boxes/robots compete for bandwidth.
for (const set of new Set(Object.values(TEXTURE_SETS))) buildingTexture(set)
buildingTexture('Light_A', 'Emissive')
// and the floor's two, which floorMaterial dresses rather than applyDesktopMaterial
buildingTexture('Floor_A')
floorMacroTexture()
prefetchWallLightmaps()

const templates: Promise<ModuleSet | null> = Promise.all([
  loadPartModel('building/Wall_A'),
  loadPartModel('building/Wall_B'),
  loadPartModel('building/Wall_C'),
  loadPartModel('building/Wall_D'),
  loadPartModel('building/Roof_A'),
  loadPartModel('building/Roof_B'),
  loadPartModel('building/Roof_A_Wall'),
  loadPartModel('building/Dock_Wall_A'),
  loadPartModel('building/Dock_Wall_B'),
  loadPartModel('building/Personnel_Door'),
]).then(([a, b, c, d, ra, rb, band, da, db, pd]) => {
  const wallA = analyzeTemplate(a, true)
  const wallB = analyzeTemplate(b, true)
  const wallC = analyzeTemplate(c, true)
  const wallD = analyzeTemplate(d, true)
  const roofA = analyzeTemplate(ra)
  const roofB = analyzeTemplate(rb)
  const bandTpl = analyzeTemplate(band)
  const dockA = analyzeTemplate(da)
  const dockB = analyzeTemplate(db)
  const doorTpl = analyzeTemplate(pd)
  if (!wallA || !wallB || !wallC || !wallD || !roofA || !roofB || !bandTpl || !dockA || !dockB || !doorTpl) return null
  // Roof_A's own wall band is identified by Wall_C's materials (Wall_01 + Framing_01) and left out of the
  // deck; the band itself is drawn from Roof_A_Wall.glb (the same geometry with lightmap uvs, written in
  // Roof_A's module space). Both keep the whole module's anchor + scale, so they sit exactly where the
  // unsplit module would
  const matNames = (c: ModuleChild): string[] => (Array.isArray(c.material) ? c.material : [c.material]).map((m) => m.name)
  const bandMats = new Set(wallC.children.flatMap(matNames))
  const isBand = (c: ModuleChild): boolean => matNames(c).every((n) => bandMats.has(n))
  const roofAWall = { ...roofA, children: bandTpl.children }
  const roofADeck = { ...roofA, children: roofA.children.filter((c) => !isBand(c)) }
  // the door is authored in Wall_D's module space but spans only its own metre, so it takes Wall_D's anchor and
  // scale: measured off its own bounds it would read as a 1 m cell and be drawn ten times over-size
  const personnelDoor = { ...wallD, children: doorTpl.children }
  return { wallA, wallB, wallC, wallD, roofA: roofADeck, roofAWall, roofB, dockA, dockB, personnelDoor }
})

// Dock-door / leveler / trailer GLBs (gated behind the building shell). Loaded
// once and shared; bays clone them per warehouse with their own materials.
const dockDoorAssets: Promise<DockDoorAssets | null> = loadDockDoorAssets()
// ...and their BaseColor maps in the same breath. Their URLs are static, so leaving them to be
// discovered when a bay is first constructed only pushed 1.6 MB of the building's own scenery
// past the loading cover (see prefetchDockDoorTextures).
prefetchDockDoorTextures()

/** map a module's anchor onto a cell corner: T(target) * R(yaw) * S * T(-anchor) */
function placeModule(tpl: ModuleTemplate, x: number, y: number, z: number, yaw: number): Matrix4 {
  const m = new Matrix4().makeTranslation(x, y, z)
  m.multiply(tmpMat.makeRotationY(yaw))
  m.multiply(tmpMat.makeScale(tpl.scale, tpl.scale, tpl.scale))
  m.multiply(tmpMat.makeTranslation(-tpl.anchor.x, -tpl.anchor.y, -tpl.anchor.z))
  return m
}

/**
 * The floor: one plane at y=0 (the part-rest plane) over the whole footprint, `lengthSections` x
 * `widthSections` cells, centred. The texture repeats once per cell in the orientation the floor tile
 * model used (u runs along -Z, v along +X from the cell corner), so it reads the same as the tiles did.
 */
function floorGeometry(lengthSections: number, widthSections: number): BufferGeometry {
  const x0 = (-lengthSections * SECTION) / 2
  const z0 = (-widthSections * SECTION) / 2
  const x1 = -x0
  const z1 = -z0
  const g = new BufferGeometry()
  // corners (x1,z1) (x1,z0) (x0,z1) (x0,z0), wound to face +Y
  g.setAttribute('position', new BufferAttribute(new Float32Array([x1, 0, z1, x1, 0, z0, x0, 0, z1, x0, 0, z0]), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array([-widthSections, lengthSections, 0, lengthSections, -widthSections, 0, 0, 0]), 2))
  g.setIndex([0, 1, 3, 0, 3, 2])
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

export function createBuildingVisual(part: PartInstance): PartVisual {
  // The perimeter walls carry their light, self-shadows included, in baked lightmaps (wallLightmaps.ts)
  // and draw in the main pass. They never cast into the sun's shadow map: their columns and braces would
  // stripe the whole interior floor.
  const floorMat = floorMaterial()
  const wallMat = new MeshStandardMaterial({ color: 0xb7bdc4, metalness: 0.15, roughness: 0.7 })
  const columnMat = new MeshStandardMaterial({ color: 0x848b94, metalness: 0.15, roughness: 0.7 })
  const baseMat = new MeshStandardMaterial({ color: 0x3c4148, metalness: 0.1, roughness: 0.8 })
  const roofMat = new MeshStandardMaterial({ color: 0xa8adb3, metalness: 0.05, roughness: 0.85 })

  const group = new Group()
  group.userData.partId = part.id

  // built here rather than loaded: it is a flat textured plane, the same one before and after the modules load
  let floorKey = ''
  const floor = new Mesh(new BufferGeometry(), floorMat)
  floor.name = 'Floor'
  floor.receiveShadow = true
  floor.raycast = noRaycast
  group.add(floor)

  const walls = new Group()
  // capacities go through bucketCapacity so these three declare the same WGSL instance-array size as every
  // other bank (exact sizes would mint three more shaders, see instanceCapacity.ts). layoutProcedural
  // sets each mesh's live `count` below, so the extra slots are never drawn.
  const cladding = new InstancedMesh(unitBox, wallMat, bucketCapacity(4))
  const columns = new InstancedMesh(unitBox, columnMat, bucketCapacity(COLUMN_CAPACITY))
  const bases = new InstancedMesh(unitBox, baseMat, bucketCapacity(4))
  for (const m of [cladding, columns, bases]) {
    m.count = 0
    // the procedural preview (pre-GLB) is lit live like any part, and never casts (see above)
    m.castShadow = false
    m.receiveShadow = true
    m.instanceMatrix.setUsage(DynamicDrawUsage)
    walls.add(m)
  }
  group.add(walls)

  const roof = new Mesh(unitBox, roofMat)
  roof.castShadow = false
  roof.receiveShadow = true
  roof.raycast = noRaycast
  group.add(roof)

  // The interior column grid. Lit live and casting: the columns stand inside the plant, so they shadow
  // the floor like the steel they are.
  // Left raycastable because the walking pilot's rays read render meshes (view.pilotCollidersNear), so
  // that is what makes it stop at the same column the sim's static box stops cargo at.
  const interiorSteelMat = new MeshStandardMaterial({ color: 0x7a818a, metalness: 0.3, roughness: 0.6 })
  const interiorGuardMat = new MeshStandardMaterial({ color: 0xe0b020, metalness: 0.05, roughness: 0.6 })
  let interiorSteel: InstancedMesh | null = null
  let interiorGuard: InstancedMesh | null = null
  let interiorKey = ''

  /** the bank to write `n` instances into: the current one while it fits, else a bigger one (retired, not
   *  disposed, because a recorded render bundle may still hold the old buffer - gpuRetire.ts) */
  const interiorBank = (prev: InstancedMesh | null, mat: Material, n: number, name: string): InstancedMesh | null => {
    if (prev ? prev.instanceMatrix.count >= n : n === 0) return prev
    if (prev) {
      group.remove(prev)
      retireInstancedMeshOnly(prev)
    }
    const mesh = new InstancedMesh(unitBox, mat, bucketCapacity(n))
    mesh.name = name
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }

  const layoutInterior = (p: BuildingPart): void => {
    const cols = interiorColumns(p)
    // up to the tiled roof's deck; the procedural stand-in's flat roof sits at the eave, so for the second
    // before the modules load the columns stop there instead of poking through it
    const h = modules ? interiorColumnHeight(p) : buildingEaveHeight(p.params.heightSections)
    interiorSteel = interiorBank(interiorSteel, interiorSteelMat, cols.length * 3, 'InteriorColumns')
    interiorGuard = interiorBank(interiorGuard, interiorGuardMat, cols.length, 'InteriorColumnGuards')
    const S = INTERIOR_COLUMN_SIZE
    const put = (mesh: InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
      tmpPos.set(x, y, z)
      tmpScale.set(sx, sy, sz)
      tmpMat.compose(tmpPos, tmpQuat.identity(), tmpScale)
      mesh.setMatrixAt(i, tmpMat)
    }
    let steel = 0
    let guard = 0
    for (const { x, z } of cols) {
      if (interiorSteel) {
        put(interiorSteel, steel++, x - S / 2 + INTERIOR_FLANGE / 2, h / 2, z, INTERIOR_FLANGE, h, S)
        put(interiorSteel, steel++, x + S / 2 - INTERIOR_FLANGE / 2, h / 2, z, INTERIOR_FLANGE, h, S)
        put(interiorSteel, steel++, x, h / 2, z, S - 2 * INTERIOR_FLANGE, h, INTERIOR_WEB)
      }
      if (interiorGuard) {
        put(interiorGuard, guard++, x, INTERIOR_GUARD_HEIGHT / 2, z, INTERIOR_GUARD_WIDTH, INTERIOR_GUARD_HEIGHT, INTERIOR_GUARD_WIDTH)
      }
    }
    for (const [mesh, count] of [[interiorSteel, steel], [interiorGuard, guard]] as const) {
      if (!mesh) continue
      mesh.count = count
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.computeBoundingBox()
    }
    if (selected) setSelectedMaterials([interiorSteelMat, interiorGuardMat], true)
    notifyBundleStructureChanged()
    bumpStructureVersion(group)
  }

  let wallsObj: Object3D = walls
  let roofObj: Object3D = roof
  // last camera-driven roof auto-hide decision (owned by viewTick). apply() folds it into the
  // roof's visibility so a param edit doesn't flip an auto-hidden roof back on for a frame -
  // which would also spend two re-records per edit fighting viewTick.
  let roofAutoHidden = false

  let modules: ModuleSet | null = null
  let tiledWalls: Group | null = null
  // One container per perimeter run inside the tiled walls group. They exist so a single run can
  // be hidden as a unit by the near-wall auto-hide (viewTick below), and each is its own
  // static-fold root, the only visibility seam the fold treats as live. Hiding a non-root
  // container instead would drop its sources from the fold's eligible set and leave the baked
  // signature stale, which auditMergeCoherence reports as merged meshes that no longer match the
  // scene. The fold buckets per root, so four roots make four sets of merged wall meshes where
  // one group would make one. That is the draw cost of per-side hiding, budgeted in
  // BUDGET_DEMO_DRAWS in e2e/verify-draw-budget.mjs.
  let wallSideGroups: Record<WallSide, Group> | null = null
  let tiledRoof: Group | null = null
  let tiledDockDoors: Group | null = null
  // ...and the same split for the dock-door bays, which are not cladding and so live outside the
  // walls group (they render in the main pass, not the wall pass). A bay belongs to the run its
  // cell was cut into; hiding a run without it would leave the door leaves and leveler
  // standing in the gap where the wall was.
  let dockSideGroups: Record<WallSide, Group> | null = null
  // ...except the parked trailers, which stand outside the wall line and so are never in the way
  // of the plant: they get their own static-fold root that the auto-hide never touches. Grouped with
  // their run, a trailer would vanish as soon as a camera flew into it (that puts the camera outside
  // the footprint, behind the run).
  let dockTrailers: Group | null = null
  let dockAssets: DockDoorAssets | null = null
  let bays: DockDoorBay[] = []
  // per-leaf dock-door open state: leafKey -> the bay + leaf it drives (rebuilt
  // with the bays) and leafKey -> eased 0..1 amount (persists across rebuilds so
  // a layout edit doesn't snap open doors shut). Each leaf eases independently.
  const leafTargets = new Map<string, { bay: DockDoorBay; leafIndex: number }>()
  const leafAmount = new Map<string, number>()
  // the openDoors array every leaf last reached its target for (null = not settled): the tick has nothing
  // to ease until the param or the leaf set changes, so it skips instead of rebuilding the open set per frame
  let settledFor: readonly string[] | undefined | null = null
  // keyed by material name when the GLB names it: every wall/roof template GLB ships its
  // own instance of e.g. "Wall_01", but they're one material (applyDesktopMaterial
  // maps by name) - one clone per name lets the static fold merge across template variants
  // and keeps the material count at one-per-look. Unnamed materials fall back to identity.
  const matClones = new Map<string | Material, Material>()
  // one material per glTF name across every bay (dockDoor.ts materialCache), so the
  // static fold merges trailer/leveler/surround pieces across bays; disposed here
  const dockMats = new Map<string, Material>()
  const glbMats: Material[] = []
  let tintMats: Material[] = [wallMat, columnMat, baseMat]

  // the baked-light wall materials, one per (glTF material name, perimeter side): a side has its own
  // lightmap. Stable across rebuilds, so a material's uuid (its warm pipeline, its static-fold bucket)
  // survives layout edits
  const bakedMats = new Map<string, Material>()

  let current = part as BuildingPart
  let builtKey = ''
  let selected = false
  let disposed = false

  const layoutFloor = (lengthSections: number, widthSections: number): void => {
    const key = `${lengthSections}|${widthSections}`
    if (key === floorKey) return
    floorKey = key
    // retired, not disposed: a recorded render bundle may still hold the old buffers (gpuRetire.ts)
    retireGeometry(floor.geometry)
    floor.geometry = floorGeometry(lengthSections, widthSections)
    notifyBundleStructureChanged()
  }

  const rebuildProcedural = (length: number, width: number, height: number): void => {
    const t = BUILDING_WALL_THICKNESS

    roof.scale.set(length + t, ROOF_THICKNESS, width + t)
    roof.position.y = height + ROOF_THICKNESS / 2

    tmpQuat.identity()
    let claddingCount = 0
    let columnCount = 0
    let baseCount = 0
    const putCladding = (x: number, z: number, sx: number, sz: number): void => {
      tmpPos.set(x, height / 2, z)
      tmpScale.set(sx, height, sz)
      tmpMat.compose(tmpPos, tmpQuat, tmpScale)
      cladding.setMatrixAt(claddingCount++, tmpMat)
    }
    const putBase = (x: number, z: number, sx: number, sz: number): void => {
      tmpPos.set(x, BASE_HEIGHT / 2, z)
      tmpScale.set(sx, BASE_HEIGHT, sz)
      tmpMat.compose(tmpPos, tmpQuat, tmpScale)
      bases.setMatrixAt(baseCount++, tmpMat)
    }
    const putColumn = (x: number, z: number, sx: number, sz: number): void => {
      if (columnCount >= COLUMN_CAPACITY) return
      tmpPos.set(x, height / 2, z)
      tmpScale.set(sx, height, sz)
      tmpMat.compose(tmpPos, tmpQuat, tmpScale)
      columns.setMatrixAt(columnCount++, tmpMat)
    }
    const columnStations = (sideLen: number): number[] => {
      const n = Math.max(1, Math.ceil(sideLen / COLUMN_SPACING))
      const step = sideLen / n
      const out: number[] = []
      for (let k = 0; k <= n; k++) out.push(-sideLen / 2 + k * step)
      return out
    }

    for (const sz of [-1, 1]) {
      const z = (sz * width) / 2
      putCladding(0, z, length + t, t)
      putBase(0, z, length + t, t + BASE_PROUD * 2)
      for (const s of columnStations(length)) putColumn(s, z, COLUMN_WIDTH, t + COLUMN_PROUD * 2)
    }
    for (const sx of [-1, 1]) {
      const x = (sx * length) / 2
      putCladding(x, 0, t, width + t)
      putBase(x, 0, t + BASE_PROUD * 2, width + t)
      for (const s of columnStations(width)) putColumn(x, s, t + COLUMN_PROUD * 2, COLUMN_WIDTH)
    }

    cladding.count = claddingCount
    bases.count = baseCount
    columns.count = columnCount
    for (const m of [cladding, columns, bases]) {
      m.instanceMatrix.needsUpdate = true
      m.computeBoundingSphere()
    }
  }

  const clearInstanced = (g: Group): void => {
    for (const child of [...g.children]) {
      g.remove(child)
      // Retire, never dispose: this clears a live building (the async procedural→tiled assembly,
      // a wall/roof param edit) whose meshes a recorded render bundle still holds by handle
      // (gpuRetire.ts)
      if ((child as InstancedMesh).isInstancedMesh) retireInstancedMeshOnly(child as InstancedMesh)
      // a static-fold output owns its merged geometry (staticFold.ts); sources share templates
      else if (child.userData.staticFold) retireGeometry((child as Mesh).geometry)
    }
  }

  const cloneMaterial = (src: Material, tint: boolean): Material => {
    const key = src.name || src
    let clone = matClones.get(key)
    if (!clone) {
      clone = src.clone()
      clone.name = src.name
      applyDesktopMaterial(clone)
      // the dock surround's own trim (DockDoor) takes its map from the dock-door set
      if (!(clone as MeshStandardMaterial).map) applyDockMaterial(clone)
      matClones.set(key, clone)
      glbMats.push(clone)
      if (tint) tintMats.push(clone)
    }
    return clone
  }

  /** the baked-light copy of a wall material for the walls on `side` (wallLightmaps.ts) */
  const bakedMaterial = (src: Material, side: WallSide, tint: boolean): Material => {
    const dressed = cloneMaterial(src, tint)
    if (LIVE_LIT.has(dressed.name)) {
      dressGlass(dressed as MeshStandardMaterial)
      return dressed
    }
    const selfLit = SELF_LIT.has(dressed.name)
    const key = selfLit ? dressed.name : `${dressed.name}|${side}`
    let mat = bakedMats.get(key)
    if (!mat) {
      mat = selfLit
        ? new MeshBasicMaterial({ name: dressed.name, color: (dressed as MeshStandardMaterial).color })
        : bakedWallMaterial(dressed, side)
      bakedMats.set(key, mat)
    }
    return mat
  }

  const addModule = (
    parent: Group,
    tpl: ModuleTemplate,
    placements: Matrix4[],
    /** `wall`: the world facing whose baked light the module takes (litSide); false = roof / floor, lit live */
    opts: { pickable: boolean; receive: boolean; tint: boolean; wall: false | WallSide },
    /** per placement, the corner half-columns it leaves out (TRIM_START / TRIM_END; absent = none) */
    trims?: readonly number[],
  ): void => {
    if (placements.length === 0) return
    for (const child of tpl.children) {
      // a trimmed placement draws its framing from that variant's geometry, so it needs a bank of its own; everything
      // else (the cladding, and every placement that isn't at a corner) stays in the one bank it always had
      const byGeometry = new Map<BufferGeometry, Matrix4[]>()
      for (let k = 0; k < placements.length; k++) {
        const geometry = child.trimmed?.[trims?.[k] ?? 0] ?? child.geometry
        const list = byGeometry.get(geometry)
        if (list) list.push(placements[k]!)
        else byGeometry.set(geometry, [placements[k]!])
      }
      for (const [geometry, list] of byGeometry) addBank(parent, child, geometry, list, opts)
    }
  }

  const addBank = (
    parent: Group,
    child: ModuleChild,
    geometry: BufferGeometry,
    placements: Matrix4[],
    opts: { pickable: boolean; receive: boolean; tint: boolean; wall: false | WallSide },
  ): void => {
    const side = opts.wall
    const dress = (m: Material): Material => (side ? bakedMaterial(m, side, opts.tint) : cloneMaterial(m, opts.tint))
    const material = Array.isArray(child.material) ? child.material.map(dress) : dress(child.material)
    // bucketed, not exact-fit: an exact `placements.length` gives non-power-of-two instance capacities
    // (5, 10, 13, 20 …), and three bakes the capacity into the generated WGSL. Every distinct run length
    // would then need its own shader and its own cold pipeline compile, inside compileStaged's phase 1
    // (the GPU-bound phase). See instanceCapacity.ts.
    const im = new InstancedMesh(geometry, material, bucketCapacity(placements.length))
    im.count = placements.length // constructor sets count = capacity; bounds + raycast iterate count
    // nothing here casts into the sun: walls carry their own baked shadows, the roof and floor never
    // cast. A baked wall takes no scene light at all, so it has no use for a shadow map either
    im.castShadow = false
    im.receiveShadow = side ? false : opts.receive
    if (!opts.pickable) im.raycast = noRaycast
    for (let k = 0; k < placements.length; k++) {
      tmpMat2.multiplyMatrices(placements[k]!, child.local)
      im.setMatrixAt(k, tmpMat2)
    }
    im.instanceMatrix.needsUpdate = true
    im.computeBoundingSphere()
    parent.add(im)
  }

  // tiling: corner-anchored 10 m cells, modules face
  // inward (-Z edge yaw 0, +Z yaw PI, -X yaw +PI/2, +X yaw -PI/2); targets are
  // chosen so the rotated run still spans its cell and z=0 hugs the footprint
  const rebuildTiled = (mods: ModuleSet, L: number, W: number, H: number): void => {
    if (!tiledWalls || !tiledRoof || !wallSideGroups) return
    const eave = buildingEaveHeight(H)
    const quarters = quarterTurns(current.rotationY)
    const lit = (side: WallSide): WallSide => litSide(side, quarters)
    const x0 = (-L * SECTION) / 2
    const z0 = (-W * SECTION) / 2
    const x1 = x0 + L * SECTION
    const z1 = z0 + W * SECTION

    // the side groups hold every wall drawable; clearing tiledWalls itself would unparent
    // them without retiring what is inside them
    const sides = wallSideGroups
    for (const side of WALL_SIDES) clearInstanced(sides[side])
    clearInstanced(tiledRoof)

    // One column per corner: the ±Z runs keep theirs (the eave band above them is Roof_A's, which keeps its own), so
    // the ±X runs leave out the half-column each corner cell would have added beside it (buildingCorners.ts). The
    // left run's modules run toward -Z, so its cell 0 meets the z0 corner with its end; the right run's with its start
    const cornerTrim = (side: WallSide, j: number): number => {
      if (side !== 'nx' && side !== 'px') return 0
      let mask = 0
      if (j === 0) mask |= side === 'nx' ? TRIM_END : TRIM_START
      if (j === W - 1) mask |= side === 'nx' ? TRIM_START : TRIM_END
      return mask
    }

    // the gable runs along the ±X edges (the ±Z edges get Roof_A's own band); each run is bucketed by the edge it
    // sits on, which is both the auto-hide's unit and the side whose baked light it takes
    const gables = (out: Record<WallSide, Matrix4[]>, trims: Record<WallSide, number[]>, tpl: ModuleTemplate, y: number): void => {
      for (let j = 0; j < W; j++) {
        out.nx.push(placeModule(tpl, x0, y, z0 + (j + 1) * SECTION, Math.PI / 2)) // left −X
        trims.nx.push(cornerTrim('nx', j))
        out.px.push(placeModule(tpl, x1, y, z0 + j * SECTION, -Math.PI / 2)) // right +X
        trims.px.push(cornerTrim('px', j))
      }
    }

    // perimeter cells in rule order (front -Z, back +Z, left -X, right +X),
    // each tagged with the placeModule target + yaw the wall ring would use, so a
    // wall rule indexed by perimeter position always resolves to the same cell
    const perimeter = 2 * L + 2 * W
    interface Cell { idx: number; x: number; z: number; yaw: number; trim: number }
    const cells: Cell[] = []
    for (let i = 0; i < L; i++) cells.push({ idx: i, x: x0 + i * SECTION, z: z0, yaw: 0, trim: 0 })
    for (let i = 0; i < L; i++) cells.push({ idx: L + i, x: x0 + (i + 1) * SECTION, z: z1, yaw: Math.PI, trim: 0 })
    for (let j = 0; j < W; j++) cells.push({ idx: 2 * L + j, x: x0, z: z0 + (j + 1) * SECTION, yaw: Math.PI / 2, trim: cornerTrim('nx', j) })
    for (let j = 0; j < W; j++) cells.push({ idx: 2 * L + W + j, x: x1, z: z0 + j * SECTION, yaw: -Math.PI / 2, trim: cornerTrim('px', j) })

    const rules = current.params.rules ?? []
    const modOf = (v: WallVariant): ModuleTemplate =>
      v === 'A' ? mods.wallA : v === 'B' ? mods.wallB : v === 'C' ? mods.wallC : mods.wallD
    // per wall variant, split by perimeter run: the run picks the baked lightmap, and is the auto-hide's unit
    const placements: Record<'A' | 'B' | 'C' | 'D', Record<WallSide, Matrix4[]>> = {
      A: emptySides<Matrix4[]>(() => []),
      B: emptySides<Matrix4[]>(() => []),
      C: emptySides<Matrix4[]>(() => []),
      D: emptySides<Matrix4[]>(() => []),
    }
    const trims: Record<'A' | 'B' | 'C' | 'D', Record<WallSide, number[]>> = {
      A: emptySides<number[]>(() => []),
      B: emptySides<number[]>(() => []),
      C: emptySides<number[]>(() => []),
      D: emptySides<number[]>(() => []),
    }
    const dockCells: { x: number; z: number; yaw: number; doorCount: 1 | 2; trailer: boolean; idx: number }[] = []
    /** the exit doors, by run: each over a Wall_D cell on the ground floor */
    const doors: Record<WallSide, Matrix4[]> = emptySides<Matrix4[]>(() => [])

    // paint the rule pattern over every full-wall layer; a dock-door rule cuts a
    // bay at the ground floor and falls back to Wall_A above
    for (let h = 0; h < H; h++) {
      const ground = h === 0
      const y = h * BUILDING_FULL_WALL_HEIGHT
      for (const cell of cells) {
        const rule = ruleAt(rules, cell.idx, perimeter)
        let variant: WallVariant = rule ? rule.wall : 'D'
        if (variant === 'dock_door') {
          if (ground && dockAssets) {
            dockCells.push({ x: cell.x, z: cell.z, yaw: cell.yaw, doorCount: rule!.doorCount === 2 ? 2 : 1, trailer: rule!.trailer, idx: cell.idx })
            continue // the bay fills this cell (placeholder Wall_A until assets load)
          }
          variant = 'A'
        }
        // a personnel door is a Wall_D cell with the door drawn over it on the ground floor, and plain Wall_D above
        if (variant === 'personnel_door') {
          if (ground) doors[wallSide(cell.yaw)].push(placeModule(mods.personnelDoor, cell.x, y, cell.z, cell.yaw))
          variant = 'D'
        }
        const vk = variant === 'A' || variant === 'B' || variant === 'C' ? variant : 'D'
        placements[vk][wallSide(cell.yaw)].push(placeModule(modOf(variant), cell.x, y, cell.z, cell.yaw))
        trims[vk][wallSide(cell.yaw)].push(cell.trim)
      }
    }
    // one InstancedMesh per (variant, run), parented into the run's own group, lit by that run's lightmap
    for (const side of WALL_SIDES) {
      const into = sides[side]
      addModule(into, mods.wallA, placements.A[side], { pickable: true, receive: true, tint: true, wall: lit(side) }, trims.A[side])
      addModule(into, mods.wallB, placements.B[side], { pickable: true, receive: true, tint: true, wall: lit(side) }, trims.B[side])
      addModule(into, mods.wallD, placements.D[side], { pickable: true, receive: true, tint: true, wall: lit(side) }, trims.D[side])
      addModule(into, mods.personnelDoor, doors[side], { pickable: true, receive: true, tint: true, wall: lit(side) })
    }

    // gable ends + any C-variant full-wall cells (all Wall_C); the roof sits straight on the top full-wall layer
    const wallC: Record<WallSide, Matrix4[]> = emptySides<Matrix4[]>(() => [])
    const wallCTrims: Record<WallSide, number[]> = emptySides<number[]>(() => [])
    for (const side of WALL_SIDES) {
      wallC[side].push(...placements.C[side])
      wallCTrims[side].push(...trims.C[side])
    }
    gables(wallC, wallCTrims, mods.wallC, eave)
    for (const side of WALL_SIDES) {
      addModule(sides[side], mods.wallC, wallC[side], { pickable: true, receive: true, tint: true, wall: lit(side) }, wallCTrims[side])
    }

    // (re)build the dock-door bays for this layout
    if (tiledDockDoors && dockSideGroups && dockTrailers) {
      const dockSides = dockSideGroups
      const trailerRoot = dockTrailers
      for (const bay of bays) bay.dispose()
      bays = []
      leafTargets.clear()
      settledFor = null
      // the run groups hold the bays; clearing tiledDockDoors would unparent them instead
      for (const side of WALL_SIDES) clearInstanced(dockSides[side]) // also disposes prior fold output
      clearInstanced(trailerRoot)
      // the surround is cladding: a baked wall module in the cell's run, like the wall it replaces
      const surrounds = { A: emptySides<Matrix4[]>(() => []), B: emptySides<Matrix4[]>(() => []) }
      for (const cell of dockCells) {
        const tpl = cell.doorCount === 2 ? mods.dockB : mods.dockA
        surrounds[cell.doorCount === 2 ? 'B' : 'A'][wallSide(cell.yaw)].push(placeModule(tpl, cell.x, 0, cell.z, cell.yaw))
      }
      for (const side of WALL_SIDES) {
        addModule(sides[side], mods.dockA, surrounds.A[side], { pickable: true, receive: true, tint: true, wall: lit(side) })
        addModule(sides[side], mods.dockB, surrounds.B[side], { pickable: true, receive: true, tint: true, wall: lit(side) })
      }
      for (const cell of dockCells) {
        const bay = createDockDoorBay(dockAssets!, {
          doorCount: cell.doorCount,
          trailers: cell.trailer,
          position: [cell.x, 0, cell.z],
          yaw: cell.yaw,
          cellIndex: cell.idx,
          materialCache: dockMats,
        })
        dockSides[wallSide(cell.yaw)].add(bay.object)
        if (bay.trailers) trailerRoot.add(bay.trailers)
        bays.push(bay)
        bay.leafKeys.forEach((key, leafIndex) => leafTargets.set(key, { bay, leafIndex }))
      }
      // pose each (fresh) leaf at its retained eased amount, or snap to its
      // open/closed target on first build; the tick eases from here
      const open = new Set(current.params.openDoors ?? [])
      for (const [key, { bay, leafIndex }] of leafTargets) {
        const amount = leafAmount.get(key) ?? (open.has(key) ? 1 : 0)
        leafAmount.set(key, amount)
        bay.setLeafOpen(leafIndex, amount)
      }
    }

    const roofA: Matrix4[] = []
    const roofABand = emptySides<Matrix4[]>(() => [])
    for (let i = 0; i < L; i++) {
      const front = placeModule(mods.roofA, x0 + i * SECTION, eave, z0, 0)
      const back = placeModule(mods.roofA, x0 + (i + 1) * SECTION, eave, z1, Math.PI)
      roofA.push(front, back)
      roofABand.nz.push(front)
      roofABand.pz.push(back)
    }
    // the eave-edge wall band belongs to the run below it, not the roof (ModuleSet.roofAWall)
    for (const side of ['nz', 'pz'] as const) {
      addModule(sides[side], mods.roofAWall, roofABand[side], { pickable: true, receive: true, tint: true, wall: lit(side) })
    }
    const roofB: Matrix4[] = []
    for (let i = 0; i < L; i++) {
      for (let j = 1; j < W - 1; j++) {
        roofB.push(placeModule(mods.roofB, x0 + i * SECTION, eave, z0 + j * SECTION, 0))
      }
    }
    addModule(tiledRoof, mods.roofA, roofA, { pickable: false, receive: false, tint: false, wall: false })
    addModule(tiledRoof, mods.roofB, roofB, { pickable: false, receive: false, tint: false, wall: false })

    // Static fold: collapse the small static meshes (wall skins, trailers, leveler
    // surrounds) into one draw per material/layer/shadow bucket - a JS-issued draw
    // costs ~10-25 µs/frame, so for never-moving content N is pure overhead. Folded
    // per subtree root so each merged mesh stays inside the group whose visibility
    // seams it must follow (roof auto-hide, the per-run
    // near-wall auto-hide, wallsVisible param). Animated nodes opt out via
    // staticFoldExclude (dock-door slides, leveler pivots); heavy instanced framing
    // stays instanced (see staticFold.ts rules).
    const foldRoots = [
      ...WALL_SIDES.map((side) => wallSideGroups?.[side]),
      ...WALL_SIDES.map((side) => dockSideGroups?.[side]),
      dockTrailers,
      tiledRoof,
    ]
    for (const g of foldRoots) if (g) foldStaticGroup(g)

    if (selected) setSelectedMaterials(tintMats, true)
    bumpStructureVersion(group)
  }

  const apply = (p: BuildingPart): void => {
    // settledFor says the leaves reached their targets for that array; any new one voids it. Leaving walk mode hands
    // back the very array settled for before the session, so an identity match there would freeze a leaf mid-ease.
    if (p.params.openDoors !== current.params.openDoors) settledFor = null
    current = p
    group.position.set(p.position[0], p.position[1], p.position[2])
    applyPartRotation(group, p)
    const { lengthSections, widthSections, heightSections, floorVisible, wallsVisible, roofVisible } = p.params
    // the wall rules change the tiling (variants + dock-door bays), so fold them
    // into the rebuild key; the open state animates via tick instead
    // ...and the yaw's quarter turn, which picks each run's world-facing lightmap (litSide)
    layoutFloor(lengthSections, widthSections)
    const key = `${lengthSections}|${widthSections}|${heightSections}|${quarterTurns(p.rotationY)}|${JSON.stringify(p.params.rules ?? [])}`
    if (key !== builtKey) {
      builtKey = key
      if (modules) rebuildTiled(modules, lengthSections, widthSections, heightSections)
      else {
        rebuildProcedural(
          lengthSections * SECTION,
          widthSections * SECTION,
          buildingEaveHeight(heightSections),
        )
      }
    }
    // the column grid is independent of the shell's tiling, so it has its own key (and survives the
    // procedural -> tiled swap untouched)
    const colKey = `${lengthSections}|${widthSections}|${heightSections}|${p.params.columnSpacing ?? 0}`
    if (colKey !== interiorKey) {
      interiorKey = colKey
      layoutInterior(p)
    }
    // The visibility params are a draw-list change, so every retained layer that bakes visibility
    // must be told: the WebGPU render bundle (a recorded encode replays the hidden meshes) and the
    // overlay/mask sub-pass projection cache (subPassCache, keyed on bundleStructureEpoch; a stale
    // list keeps drawing hidden meshes even with ?nobundle). Without this, toggling Floor/Walls/Roof flips
    // the flags and changes nothing on screen. The roof auto-hide path notifies on its own (viewTick).
    const roofVis = roofVisible && !roofAutoHidden
    const visChanged =
      floor.visible !== floorVisible || wallsObj.visible !== wallsVisible || roofObj.visible !== roofVis
    floor.visible = floorVisible
    wallsObj.visible = wallsVisible
    roofObj.visible = roofVis
    if (visChanged) {
      notifyBundleStructureChanged()
      // ...and the instance pool, which the bundle notify does not reach. The pool prunes hidden
      // subtrees (collectEligible), so a flip moves meshes in and out of its eligible set. Hiding
      // is caught as a side effect: a hidden recorded member fails tryUpdateParts' validation,
      // which falls back to a full rebuild. Showing is not: that validation is one-directional by
      // design (instancePool.ts), so a re-shown roof would stay unpooled while the pool's bake
      // signature claims otherwise, and auditMergeCoherence fails ("after building roof shown").
      // structureVersion is the documented signal for a draw-list change, and
      // view.poolRebuildOnStructureSettled re-pools once the epoch settles, so the re-shown meshes
      // rejoin the merge on the next frame.
      bumpStructureVersion(group)
    }
  }

  // ease each dock-door leaf toward its own open/closed target every frame
  // (a per-frame ease, per leaf); levelers deploy as the
  // leaf finishes. Leaves are toggled independently via openDoors (pilot Use).
  group.userData.tick = (dt: number): boolean => {
    if (leafTargets.size === 0) return false
    if (settledFor !== null && settledFor === current.params.openDoors) return false
    const open = new Set(current.params.openDoors ?? [])
    const step = DOCK_OPEN_SPEED * dt
    let moved = false
    for (const [key, { bay, leafIndex }] of leafTargets) {
      const target = open.has(key) ? 1 : 0
      const amount = leafAmount.get(key) ?? 0
      if (amount === target) continue
      const next = target > amount ? Math.min(target, amount + step) : Math.max(target, amount - step)
      leafAmount.set(key, next)
      bay.setLeafOpen(leafIndex, next)
      moved = true
    }
    // A leaf/leveler eased this frame: plain-mesh matrix writes inside the bundled parts container,
    // which a recorded bundle replays stale on r185 unless its draws are refreshed. Returning true
    // is the tick's activity mark (view marks the part), so the replay refreshes just this part's
    // draws. A re-record here instead (notifyBundleStructureChanged) would render every frame of the
    // ease unbundled, a visible frame-rate dip on each door. The pose bump is for the key light's
    // frozen shadow map, which the slide and leveler cast into (refreshKeyShadowIfDirty).
    if (moved) {
      bumpPoseRev(group)
      return true
    }
    settledFor = current.params.openDoors
    return false
  }

  // the roof auto-hides while the camera is
  // above the ceiling and pitched down steeply. Returns whether the roof flipped this frame -
  // the view marks the part dirty on true (bundleReplayRefresh part 1 consumes marks even on
  // parked frames), which is what lets classifyBundleObject keep viewTick subtrees out of the
  // bundle always-active bucket. The flip itself is also a draw-list change, so it re-records.
  const camDir = new Vector3()
  const camLocal = new Vector3()
  const invRot = new Quaternion()
  let wallsAutoHidden: WallSidesHidden = { nz: false, pz: false, nx: false, px: false }
  group.userData.viewTick = (camera: PerspectiveCamera, firstPerson: boolean): boolean => {
    camera.getWorldDirection(camDir)
    const pitchDeg = Math.asin(clamp(-camDir.y, -1, 1)) / DEG
    // an orthographic view (EditorCamera flips this flag) has no meaningful camera position:
    // above the eaves it loses the roof at any pitch, and its walls ignore distance
    // (wallAutoHide.ts), because its camera distance is only zoom
    const ortho = (camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true
    const autoHide =
      camera.position.y > current.position[1] + buildingEaveHeight(current.params.heightSections) &&
      (ortho || pitchDeg >= ROOF_HIDE_PITCH_DEG)
    roofAutoHidden = autoHide // apply() folds this in, so a param edit can't flip the roof back on
    const vis = current.params.roofVisible && !autoHide
    // A draw-list change: a recorded bundle bakes visibility, so re-record. Bump the instance pool
    // too, for the same reason as the param path in apply(): the pool prunes hidden subtrees, so
    // these meshes leave and re-enter its eligible set here. Without the bump, flying back down so
    // the roof auto-shows leaves auditMergeCoherence failing on instancePool for good, because
    // tryUpdateParts' validation is one-directional (e2e/probes/roof-autohide-coherence.mjs).
    // Edge-triggered, not per-frame: this runs only when something flips, so it is one pool rebuild
    // per threshold crossing, not one per frame of flying.
    let changed = false
    if (roofObj.visible !== vis) {
      roofObj.visible = vis
      changed = true
    }
    // Near-wall auto-hide: the perimeter runs the camera is actually behind stop standing between
    // it and the plant inside, and the whole shell comes back once the camera is far enough out to
    // be looking at the building rather than clipped into it (wallAutoHide.ts).
    // Composed with wallsVisible the same way the roof composes with roofVisible, except the
    // param is on the parent walls group, so a hidden parent overrides these flags and
    // "Walls off" cannot be undone from here. The procedural pre-GLB preview has no side groups
    // and is left alone: it exists for the second before the modules load.
    if (wallSideGroups && wantsWallAutoHide()) {
      // the part's own transform, not matrixWorld: a viewTick runs before the frame's world-matrix
      // walk for anything that is not a registered frozen entry
      camLocal.copy(camera.position).sub(group.position).applyQuaternion(invRot.copy(group.quaternion).invert())
      // a person walking the plant (pilot, VR) always gets the whole shell. First person sets every
      // side shown instead of skipping the update, so entering pilot with runs already dropped puts them back
      const hidden = firstPerson
        ? WALL_SIDES_NONE_HIDDEN
        : wallAutoHide(
            camLocal.x,
            camLocal.z,
            (current.params.lengthSections * SECTION) / 2,
            (current.params.widthSections * SECTION) / 2,
            WALL_SIDES.some((side) => wallsAutoHidden[side]),
            ortho,
          )
      if (wallSidesDiffer(hidden, wallsAutoHidden)) {
        wallsAutoHidden = hidden
        for (const side of WALL_SIDES) {
          wallSideGroups[side].visible = !hidden[side]
          if (dockSideGroups) dockSideGroups[side].visible = !hidden[side]
        }
        changed = true
      }
    }
    if (changed) {
      notifyBundleStructureChanged()
      bumpStructureVersion(group)
    }
    return changed
  }

  if (part.type === 'building') apply(part)

  void templates.then((mods) => {
    if (!mods || disposed) return
    // ghost visuals (partId stripped) keep the procedural preview
    if (group.userData.partId === undefined) return
    modules = mods
    group.remove(walls, roof)
    // retired, not disposed: this swap runs live, under recordings that drew the procedural shell
    // (gpuRetire.ts). Mesh-only: all three draw the module-shared unitBox.
    retireInstancedMeshOnly(cladding)
    retireInstancedMeshOnly(columns)
    retireInstancedMeshOnly(bases)
    tiledWalls = new Group()
    wallSideGroups = emptySides<Group>(() => new Group())
    for (const side of WALL_SIDES) {
      // named for e2e/verify-wall-autohide.mjs, which reads their visibility back
      wallSideGroups[side].name = `WallSide_${side}`
      tiledWalls.add(wallSideGroups[side])
    }
    tiledRoof = new Group()
    tiledDockDoors = new Group()
    dockSideGroups = emptySides<Group>(() => new Group())
    for (const side of WALL_SIDES) {
      dockSideGroups[side].name = `DockSide_${side}`
      tiledDockDoors.add(dockSideGroups[side])
    }
    dockTrailers = new Group()
    dockTrailers.name = 'DockTrailers'
    tiledDockDoors.add(dockTrailers)
    group.add(tiledWalls, tiledRoof, tiledDockDoors)
    wallsObj = tiledWalls
    roofObj = tiledRoof
    tintMats = []
    builtKey = ''
    interiorKey = '' // the columns grow from the stand-in roof to the real deck
    apply(current)
  }).catch((e: unknown) => console.warn('[oip] building wall modules failed to load', e))

  // bays stream in after the shell (gated): once the dock-door GLBs load, force
  // a rebuild so any configured dock doors appear
  void dockDoorAssets.then((assets) => {
    if (!assets || disposed || group.userData.partId === undefined) return
    dockAssets = assets
    builtKey = ''
    apply(current)
  }).catch((e: unknown) => console.warn('[oip] dock door models failed to load', e))

  return {
    object: group,
    update(p: PartInstance): void {
      if (p.type === 'building') apply(p)
    },
    setSelected(on: boolean): void {
      selected = on
      setSelectedMaterials(tintMats, on)
      setSelectedMaterials([interiorSteelMat, interiorGuardMat], on)
    },
    dispose(): void {
      disposed = true
      for (const mat of [floorMat, wallMat, columnMat, baseMat, roofMat, interiorSteelMat, interiorGuardMat, ...glbMats]) mat.dispose()
      for (const mat of dockMats.values()) mat.dispose() // bay materials are cache-owned here
      for (const mat of bakedMats.values()) mat.dispose()
      // mesh-only retire: the banks draw module-shared geometry (gpuRetire.ts)
      retireInstancedMeshOnly(cladding)
      retireInstancedMeshOnly(columns)
      retireInstancedMeshOnly(bases)
      retireInstancedMeshOnly(interiorSteel)
      retireInstancedMeshOnly(interiorGuard)
      for (const bay of bays) bay.dispose()
      retireGeometry(floor.geometry)
      const groups = [
        ...WALL_SIDES.map((side) => wallSideGroups?.[side]),
        ...WALL_SIDES.map((side) => dockSideGroups?.[side]),
        dockTrailers,
        tiledWalls,
        tiledRoof,
        tiledDockDoors,
      ]
      for (const g of groups) if (g) clearInstanced(g)
    },
  }
}
