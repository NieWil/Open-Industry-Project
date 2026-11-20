import {
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three'
import type { BufferGeometry, Material, Object3D, Texture } from 'three'
import { DEG } from '../../core/parts/partGeometry'
import { clonePartModel, gateBuildingLoad, loadPartModel, loadTextureBitmap } from '../gltf'
import { buildingTexture } from './building'

// Dock-door assembly, rendered as a building wall feature.
// A "bay" replaces one ground-floor wall section with the loading-dock surround,
// a sliding door per opening, an auto leveler in the opening, and (optionally) a
// container trailer backed up outside. Authored in the same corner-anchored 10 m
// cell space as the Wall modules: run along +X in [0, 10], base at y=0, exterior
// face at z=0, structure extending inward (+z). The owning building places the
// bay group at the wall cell, so everything here is in cell-local meters.

/** opening centres along the cell's local +X */
const OPENINGS_1 = [5.0]
const OPENINGS_2 = [2.75, 7.25]
/**
 * door panel rise when open, m. The opening is a real 10 ft (3.05 m) dock door: the panel is 3.11 m tall
 * and its head trim's underside is at 3.08 m, so 3.1 lifts the bottom bar just clear of the opening.
 * Mirrored by core/building/buildingDocks.ts DOCK_OPENING_HEIGHT.
 */
const DOOR_TRAVEL = 3.1
/** container trailer placement behind a bay */
const TRAILER_REAR_OFFSET = 6.16
// Drop the trailer so its bed lines up with the dock floor.
// There is no ground plane (see env.ts), so the wheels hang below y=0 into
// the drive lane - without this the bed floats ~1.4 m above the threshold.
const TRAILER_Y_OFFSET = 1.62
/** auto-leveler hinge geometry: main pivots at its inner edge */
const LEVELER_MAIN_HINGE_Z = 2.4
/** leveler deploy pose, deg */
const LEVELER_MAIN_DEPLOY_DEG = 3
const LEVELER_LIP_STOWED_DEG = -85
/** bollard offsets either side of the opening */
const BOLLARD_X = 1.75
const BOLLARD_Z = 0.25

// the GLBs ship placeholder solid colors; reapply the BaseColor maps by
// glTF material name (mirrors building.ts). Wall_02 + Framing_01 are the building
// surfaces the surround shares, so reuse the already-loaded building textures.
const dockTextureCache = new Map<string, Texture>()
function dockDoorTexture(name: string): Texture {
  let tex = dockTextureCache.get(name)
  if (!tex) {
    // Register with the building-first gate exactly like buildingTexture does. The dock bay is
    // building scenery (building.ts loads its GLBs at module scope), so the loading cover, which
    // exists so the first building the user sees is the finished, textured one, must wait for
    // these too. Ungated and requested only once a bay is constructed (measured on a throttled prod
    // build), the GLBs would arrive by 6.2 s but their textures would not be requested until ~12.2 s,
    // after the cover lifts at ~11 s, so the dock doors and parked trailer would texture visibly after
    // the loading screen.
    // settle fires on success or failure, so a missing texture can't block the gate.
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    tex = loadTextureBitmap(`/models/dockDoor/textures/${name}_BaseColor.webp`, () => settle())
    // coverOnly: the reveal waits for these, but scene parts must not queue behind them (they are
    // scenery, not the shell; gating both signals would delay every part by ~1.4 s).
    void gateBuildingLoad(done, { coverOnly: true })
    tex.colorSpace = SRGBColorSpace
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    tex.anisotropy = 4
    dockTextureCache.set(name, tex)
  }
  return tex
}

/**
 * Request every dock texture now, next to the bay's GLBs, instead of on first bay construction.
 * Same approach as the building's own preload links in app/index.html: the URLs are known
 * statically, so waiting to discover them through a parsed GLB just serialises the download
 * behind a parse it does not depend on. Idempotent (the cache is the dedupe).
 */
export function prefetchDockDoorTextures(): void {
  for (const entry of Object.values(MATERIAL_TEX)) if (entry.dock) dockDoorTexture(entry.dock)
}

/** glTF material name -> BaseColor source (building texture set, or dock webp) */
const MATERIAL_TEX: Record<string, { building?: string; dock?: string }> = {
  Wall_02: { building: 'Wall_02' },
  Framing_01: { building: 'Framing_01' },
  DockDoor: { dock: 'DockDoor_Door' },
  'AutoLeveler.001': { dock: 'AutoLeveler' },
  Container: { dock: 'Container' },
  Interior: { dock: 'Interior' },
  Chassis: { dock: 'Chassis' },
}

export function applyDockMaterial(mat: Material): void {
  const tex = MATERIAL_TEX[mat.name]
  if (!tex || !(mat instanceof MeshStandardMaterial)) return
  mat.map = tex.building ? buildingTexture(tex.building) : dockDoorTexture(tex.dock!)
  mat.color.set(0xffffff)
  mat.roughness = 0.85
  mat.metalness = 0.15
  mat.needsUpdate = true
}

interface MeshPart {
  geometry: BufferGeometry
  matrix: Matrix4
}

export interface DockDoorAssets {
  /** door template (DockDoor.glb), cloned per bay. Its surround meshes are unused: the building draws
   *  the baked copies (Dock_Wall_A/B.glb, scripts/bake-wall-lighting.mjs) as wall modules */
  dockDoor: Group
  /** leveler sub-meshes with their authored world matrices (AutoLeveler.glb) */
  leveler: { surrounds: MeshPart; bollard: MeshPart; main: MeshPart; lip: MeshPart }
  /** container trailer template (ContainerTrailer.glb), cloned per bay */
  trailer: Group
}

let assetsPromise: Promise<DockDoorAssets | null> | null = null

/** read a named mesh's geometry + baked world matrix from a loaded template */
function meshPart(root: Object3D, name: string): MeshPart | null {
  const obj = root.getObjectByName(name) as Mesh | undefined
  if (!obj || !obj.isMesh) return null
  return { geometry: obj.geometry, matrix: obj.matrixWorld.clone() }
}

/**
 * Load the dock-door / leveler / trailer GLBs once. Gated behind the building
 * like any other part (loadPartModel), so the warehouse shell loads first and
 * the bays stream in just after.
 */
export function loadDockDoorAssets(): Promise<DockDoorAssets | null> {
  if (!assetsPromise) {
    assetsPromise = Promise.all([
      loadPartModel('dockDoor/DockDoor'),
      loadPartModel('dockDoor/AutoLeveler'),
      loadPartModel('dockDoor/ContainerTrailer'),
    ]).then(([dockDoor, leveler, trailer]) => {
      if (!dockDoor || !leveler || !trailer) return null
      leveler.updateMatrixWorld(true)
      const surrounds = meshPart(leveler, 'Surrounds')
      const bollard = meshPart(leveler, 'Bollard')
      const main = meshPart(leveler, 'Lift_Main')
      const lip = meshPart(leveler, 'Lift_Lip')
      if (!surrounds || !bollard || !main || !lip) return null
      return { dockDoor, leveler: { surrounds, bollard, main, lip }, trailer }
    })
  }
  return assetsPromise
}

interface LevelerHandle {
  object: Object3D
  /** 0 = stowed, 1 = fully deployed */
  setDeploy(amount: number): void
}

/** fresh-mesh leveler with main + lip pivots, so prod meshopt can't distort it */
function buildLeveler(parts: DockDoorAssets['leveler'], cache: Map<string, Material>): LevelerHandle {
  let mat = cache.get('__AutoLeveler')
  if (!mat) {
    mat = new MeshStandardMaterial({ roughness: 0.85, metalness: 0.15 })
    ;(mat as MeshStandardMaterial).map = dockDoorTexture('AutoLeveler')
    mat.needsUpdate = true
    cache.set('__AutoLeveler', mat)
  }

  const fixedMesh = (part: MeshPart, local?: Matrix4): Mesh => {
    const m = new Mesh(part.geometry, mat)
    m.matrixAutoUpdate = false
    m.matrix.copy(local ? local.clone().multiply(part.matrix) : part.matrix)
    m.castShadow = true
    m.receiveShadow = true
    return m
  }

  const root = new Group()
  root.add(fixedMesh(parts.surrounds))
  for (const sx of [-1, 1]) {
    root.add(fixedMesh(parts.bollard, new Matrix4().makeTranslation(sx * BOLLARD_X, 0, BOLLARD_Z)))
  }

  // main ramp hinges at its inner edge (z = LEVELER_MAIN_HINGE_Z)
  const mainPivot = new Group()
  mainPivot.userData.staticFoldExclude = true // ramp + lip animate (setDeploy) - never fold them
  mainPivot.position.set(0, 0, LEVELER_MAIN_HINGE_Z)
  mainPivot.add(fixedMesh(parts.main, new Matrix4().makeTranslation(0, 0, -LEVELER_MAIN_HINGE_Z)))
  // lip hinges at the main's front edge (cell z = 0), riding on the main pivot
  const lipPivot = new Group()
  lipPivot.position.set(0, 0, -LEVELER_MAIN_HINGE_Z)
  lipPivot.add(fixedMesh(parts.lip))
  mainPivot.add(lipPivot)
  root.add(mainPivot)

  return {
    object: root,
    setDeploy(amount: number): void {
      mainPivot.rotation.x = amount * LEVELER_MAIN_DEPLOY_DEG * DEG
      lipPivot.rotation.x = (LEVELER_LIP_STOWED_DEG * (1 - amount)) * DEG
    },
  }
}

export interface DockDoorBay {
  object: Object3D
  /**
   * The bay's parked trailers, pre-posed in building-local space (null when the
   * bay has none). Kept out of `object` because they stand outside the wall line: the building's
   * near-wall auto-hide drops a run's bay with its wall, so a trailer inside `object` would vanish the
   * moment a camera flies into it (the camera is then outside the footprint, behind that run).
   */
  trailers: Object3D | null
  /** stable `"<cellIdx>:<leafIdx>"` keys, index-aligned with the bay's leaves */
  leafKeys: string[]
  /** pose one leaf: 0 = closed / stowed, 1 = raised + leveler deployed */
  setLeafOpen(leafIndex: number, amount: number): void
  dispose(): void
}

export interface DockDoorBayOptions {
  /** openings in this bay (1 = Wall_A surround, 2 = Wall_B) */
  doorCount: 1 | 2
  trailers: boolean
  /** building-local cell origin (the wall-cell corner the bay sits on) */
  position: [number, number, number]
  /** building-local yaw of the cell (matches the wall ring placement) */
  yaw: number
  /** perimeter cell index, the prefix of each leaf key (per-leaf Use picking) */
  cellIndex: number
  /**
   * Shared per-building material cache (glTF material name → prepared clone).
   * clonePartModel clones a material per mesh, which splits the static fold's
   * per-material buckets (staticFold.ts). With a shared cache every bay's trailer /
   * leveler / surround piece uses one material instance, so the fold can merge
   * across meshes, leaves and bays. When provided, the cache owner disposes the cached
   * materials (bay.dispose() then only drops what it created without the cache).
   */
  materialCache?: Map<string, Material>
}

export function createDockDoorBay(assets: DockDoorAssets, opts: DockDoorBayOptions): DockDoorBay {
  const group = new Group()
  group.position.set(opts.position[0], opts.position[1], opts.position[2])
  group.rotation.y = opts.yaw

  const openings = opts.doorCount === 2 ? OPENINGS_2 : OPENINGS_1
  const cache = opts.materialCache ?? new Map<string, Material>()
  const ownsCache = !opts.materialCache
  const doorSlides: Object3D[] = []
  const levelers: LevelerHandle[] = []
  const leafKeys: string[] = []

  // route a fresh clone's materials through the shared cache: first sight of a name
  // prepares + caches that clone, later meshes drop their redundant clone for the
  // cached one - one material instance per name across the whole building
  const shareMaterials = (obj: Object3D): void => {
    obj.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      const adopt = (m: Material): Material => {
        const cached = cache.get(m.name)
        if (cached) {
          if (cached !== m) m.dispose()
          return cached
        }
        applyDockMaterial(m)
        cache.set(m.name, m)
        return m
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(adopt) : adopt(mesh.material)
    })
  }

  // the door panel, cloned per opening below (the surround is the building's: see DockDoorAssets)
  const dock = clonePartModel(assets.dockDoor)
  shareMaterials(dock.object)
  // the door is a wall piece: like the building walls it never casts, so it can't darken the bay
  const noCast = (obj: Object3D): void =>
    obj.traverse((o) => {
      ;(o as Mesh).castShadow = false
    })

  const doorProto = dock.object.getObjectByName('Door') as Mesh | undefined
  let trailers: Group | null = null
  if (opts.trailers) {
    trailers = new Group()
    trailers.position.copy(group.position)
    trailers.rotation.y = opts.yaw
  }

  openings.forEach((cx, leafIdx) => {
    // door: authored centred at x≈0; the pivot carries it to the opening, the
    // slide raises it (translate a fresh parent only - never the GLB node - so
    // prod meshopt's baked node transforms stay intact)
    const pivot = new Group()
    pivot.position.set(cx, 0, 0)
    const slide = new Group()
    slide.userData.staticFoldExclude = true // the panel rises when the leaf opens - never fold it
    // the panel is the per-leaf interact target: tag it so the pilot crosshair can toggle this one leaf alone
    const key = `${opts.cellIndex}:${leafIdx}`
    slide.userData.dockLeaf = key
    leafKeys.push(key)
    if (doorProto) {
      const door = doorProto.clone(true)
      noCast(door)
      slide.add(door)
      // The slide rises DOOR_TRAVEL (3.1 m) when open, above the crosshair line and
      // outside the pilot's reach, so the raised panel itself can't be re-targeted to
      // close the door. A separate, stationary interact target stays fixed at the opening:
      // an invisible door clone under the (non-moving) pivot, tagged with the same leaf key.
      // Raycasting ignores `visible`, so it stays pickable while the panel is raised.
      const interact = doorProto.clone(true)
      interact.visible = false
      interact.userData.dockLeaf = key
      pivot.add(interact)
    }
    pivot.add(slide)
    group.add(pivot)
    doorSlides.push(slide)

    const lev = buildLeveler(assets.leveler, cache)
    lev.object.position.set(cx, 0, 0)
    group.add(lev.object)
    levelers.push(lev)

    if (trailers) {
      const tr = clonePartModel(assets.trailer)
      shareMaterials(tr.object)
      tr.object.position.set(cx, -TRAILER_Y_OFFSET, -TRAILER_REAR_OFFSET)
      tr.object.rotation.y = Math.PI // back the rear doors up to the dock
      trailers.add(tr.object)
    }
  })

  return {
    object: group,
    trailers,
    leafKeys,
    setLeafOpen(leafIndex: number, amount: number): void {
      const a = Math.min(1, Math.max(0, amount))
      doorSlides[leafIndex]?.position.set(0, a * DOOR_TRAVEL, 0)
      levelers[leafIndex]?.setDeploy(a)
    },
    dispose(): void {
      // with a shared cache the owner (the building visual) disposes the materials -
      // bays come and go on every layout rebuild while the cache outlives them
      if (ownsCache) for (const mat of cache.values()) mat.dispose()
    },
  }
}
