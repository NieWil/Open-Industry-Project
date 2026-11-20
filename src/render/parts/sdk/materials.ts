import { Color, Matrix4, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, TextureLoader } from 'three'
import type { Group, Material, Mesh, Object3D, Texture } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { versionedAssetUrl } from '../../../core/assetVersions'
import type { PartAsset, PartMaterial, RigShape } from '../../../core/parts/partPackage'

/** A mesh link's shape with the nodes other links of its asset draw (core/glbBox.ts drawnElsewhere). */
export type CarvedMeshShape = Extract<RigShape, { kind: 'mesh' }> & { readonly drawnElsewhere?: readonly string[] }
import { shippedFetchUrl } from '../../../core/shippedAssets'
import { computeColliderBVH } from '../../bvh'
import { dracoLoader } from '../../dracoDecoder'
import { beginAssetLoad, isSpeculativeWarm, loadTextureBitmap, noteSpeculativeFetch } from '../../gltf'
import type { TextureFallback } from '../../gltf'
import { notifyBundleStructureChanged } from '../../bundleGroups'
import { triplanarMetalMaterial } from '../common'
import { patternKey, patternTexture } from './patternTexture'
import { fitToHeight } from '../deviceModel'
import { bumpStructureVersion } from '../structureRev'

// ---- GLB / texture asset caches + package materials ------------------------
// Module-lived caches (meshCache / texCache) so an asset shared across links, parts and instances
// loads/decodes exactly once. Every consumer must go through this module (customMeshesSettled
// tracks the same meshCache the loads go through).

// Parsed GLB scenes, content-addressed by their base64 data so an asset shared across links/instances
// loads once; clones share geometry+materials (never disposed - module-lived, like the other GLB caches).
const meshLoader = new GLTFLoader()
// the project's GLBs are meshopt-compressed (EXT_meshopt_compression); the decoder must be set or parse
// throws "setMeshoptDecoder must be called before loading compressed files" (shared singleton w/ gltf.ts)
meshLoader.setMeshoptDecoder(MeshoptDecoder)
// The rig GLBs (robot/gantry/AGV/diverter…) are Draco-compressed instead. meshopt is not used for
// them because its quantization bakes node transforms this rig path resets. Shared singleton so
// both parsers use one decoder worker pool (render/dracoDecoder.ts).
meshLoader.setDRACOLoader(dracoLoader)
const meshCache = new Map<string, Promise<Object3D>>()
export function loadMeshAsset(asset: PartAsset): Promise<Object3D> {
  // an older copy's source path is fetched from the baked file the app shipped for it (shippedFetchUrl)
  const url = asset.url !== undefined ? shippedFetchUrl(asset.url) : undefined
  const key = url ?? asset.data ?? ''
  let p = meshCache.get(key)
  if (!p) {
    // BVH the template's dense geometry once, as gltf.ts fetchScene does for shared app GLBs.
    // prepareMeshInstance clones share geometry, so one tree serves every placed copy. Without
    // this a custom rig (the Six-Axis robot: 53 meshes, ~60k tris) tests every triangle per ray:
    // the pilot's crosshair cast measured 0.35→5 ms when aimed at it.
    const withBVH = (scene: Object3D): Object3D => {
      computeColliderBVH(scene)
      replaceTransmission(scene)
      return scene
    }
    p = new Promise<Object3D>((resolve, reject) => {
      if (url) {
        // A referenced GLB is a real network fetch, and for an SDK-part scene most of the bytes:
        // every rig in the demo (robot, AGV, chain transfer…) loads this way. So it counts toward
        // the assets-quiet signal the idle catalog warm yields to, like the url-backed textures
        // below. Without it, on a scene made of custom parts the sweep could declare the scene
        // quiet and start speculating while the scene's own rigs are still loading.
        // Speculative loads stay off it and go on the ledger instead (gltf.ts).
        noteSpeculativeFetch(url)
        const endAsset = isSpeculativeWarm() ? () => {} : beginAssetLoad()
        // referenced (app-served) GLB - load straight from the URL
        meshLoader.load(
          versionedAssetUrl(url),
          (gltf) => {
            endAsset()
            resolve(withBVH(gltf.scene))
          },
          undefined,
          (err) => {
            endAsset()
            reject(err)
          },
        )
      } else {
        const bin = atob(asset.data ?? '')
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        meshLoader.parse(bytes.buffer, '', (gltf) => resolve(withBVH(gltf.scene)), reject)
      }
    })
    meshCache.set(key, p)
  }
  return p
}

/**
 * Swap every transmission material (an exporter's glass: KHR_materials_transmission, which GLTFLoader loads as a
 * MeshPhysicalMaterial) for a translucent MeshStandardMaterial of the same name and finish. three renders
 * transmission by copying the framebuffer mid-pass, which a WebGPU render-bundle encoder cannot do: recording the
 * parts group would throw `currentPass.end is not a function` every frame, the bundle would never finish, and the
 * viewport would drop to ~9 fps (e2e/verify-glb-glass.mjs). Plain alpha blending reads as glass and needs no copy. The name is
 * kept because a link's per-material remap and the Inspector's material list key by it.
 */
export function replaceTransmission(scene: Object3D): void {
  const swapped = new Map<Material, Material>()
  const swap = (mat: Material): Material => {
    const phys = mat as MeshStandardMaterial & { transmission?: number }
    if (!(phys.transmission && phys.transmission > 0)) return mat
    let out = swapped.get(mat)
    if (!out) {
      const glass = new MeshStandardMaterial().copy(phys)
      // full transmission → ~25% opaque, the look of a light glass pane over the scene behind it
      glass.opacity = Math.max(0.15, Math.min(phys.opacity, 1 - 0.75 * phys.transmission))
      glass.transparent = true
      glass.depthWrite = false
      swapped.set(mat, (out = glass))
    }
    return out
  }
  scene.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
  })
}

/** Resolve once every custom-part mesh asset requested so far has settled (for offscreen thumbnail capture).
 * Custom rig GLBs load through meshCache here, not gltf.ts's tracked cache, so render/thumbnails.ts can't rely
 * on modelsSettled() to know a rig's meshes are in before it captures. */
export function customMeshesSettled(): Promise<void> {
  return Promise.allSettled([...meshCache.values()]).then(() => undefined)
}

// A package material's textures, content-addressed by url/base64 so one shared across materials, links
// and instances loads once (module-lived, like meshCache). flipY off matches the glTF UV convention the
// meshes were authored with.
//
// A url-backed asset is a real network fetch (the robot's ORM map, the gantry's trim set, the gripper's
// normal maps - a couple of MB across a rig), and it goes through the app's own texture path
// (gltf.ts loadTextureBitmap) rather than a bare TextureLoader, for three things that path provides:
//   - One retry, then a neutral fallback image. An image-less Texture is not "no map": three binds its
//     empty default and the surface samples black. A package material multiplies its albedo in (the
//     triplanar branch below is `diffuse *= sampled`), so without the fallback one dropped request would
//     render the Diverter's pusher arms flat black for the rest of the session, a failure that shows for
//     one user and not others.
//   - the bundle re-record when the image arrives. A texture that decodes after its mesh was recorded into
//     a WebGPU render bundle would stay black on replay: the recorded bind group still holds that empty
//     texture, and a needsUpdate version bump alone never reaches a replayed draw (bundleGroups.ts).
//   - the assets-quiet accounting (beginAssetLoad + the speculative-warm exclusion).
// Base64 assets are already in the bundle (no fetch, nothing to retry or yield for), but their decode is
// still async, so they take the same re-record notify.
const texCache = new Map<string, Texture>()
function texFromAsset(asset: PartAsset, srgb: boolean, fallback: TextureFallback = 'albedo'): Texture {
  const url = asset.url !== undefined ? shippedFetchUrl(asset.url) : undefined
  const key = url ?? asset.data ?? ''
  let tex = texCache.get(key)
  if (!tex) {
    tex = url
      ? loadTextureBitmap(url, undefined, fallback)
      : new TextureLoader().load(`data:${asset.mime};base64,${asset.data}`, () => notifyBundleStructureChanged())
    tex.flipY = false
    tex.wrapS = RepeatWrapping
    tex.wrapT = RepeatWrapping
    tex.anisotropy = 4
    if (srgb) tex.colorSpace = SRGBColorSpace
    texCache.set(key, tex)
  }
  return tex
}

// Build a PBR material from a package material spec: albedo (sRGB) + packed ORM (G=roughness, B=metalness,
// same texture to both maps, like manipulatorModel.ormMaterial) + optional normal map, each an embedded
// asset; scalar color/metalness/roughness cover the textureless case. Caller disposes the returned material.
export function buildMaterial(mat: PartMaterial, assets: readonly PartAsset[]): MeshStandardMaterial {
  // `fallback` is what this texture samples as if its fetch never succeeds - pass the channel it feeds,
  // since the mid-grey albedo default would make a failed normal map worse than no map at all (gltf.ts).
  const tex = (id: string | undefined, srgb: boolean, fallback: TextureFallback = 'albedo'): Texture | null => {
    if (!id) return null
    const a = assets.find((x) => x.id === id)
    return a ? texFromAsset(a, srgb, fallback) : null
  }
  // Triplanar metal (PartMaterial.triplanar): sample the albedo by world/object position, not the mesh UVs.
  // This fixes an imported GLB whose UVs smear a baked texture along a long axis (the Diverter arms' brushed
  // metal). Delegates to the same shader the built-in diverterArmMaterial uses (common.ts / metalNodeMaterial.ts);
  // sampled linear (srgb=false) like the built-in's loadMetalTexture, since the raw texels are multiplied in.
  // A pattern (PartMaterial.pattern) is a painted albedo the host draws itself (patternTexture.ts); it takes the
  // albedo's place on both paths below, defaulting to a painted finish rather than the metal an albedo implies.
  const pattern = mat.pattern ? patternTexture(mat.pattern) : null
  if (mat.triplanar) {
    const albedoAsset = mat.albedo ? assets.find((a) => a.id === mat.albedo) : undefined
    const armTex = pattern ?? (albedoAsset ? texFromAsset(albedoAsset, false) : null)
    if (armTex) {
      const c = mat.color
      return triplanarMetalMaterial(
        {
          // program-cache key only (the texture is supplied above); the shared node materials are keyed by it too,
          // so a pattern names its whole spec
          url: mat.pattern ? `pattern:${patternKey(mat.pattern)}` : (albedoAsset!.url ?? mat.id),
          color: c ? (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255) : 0xffffff,
          boost: mat.triplanar.boost ?? 1,
          metalness: mat.metalness ?? (pattern ? 0 : 0.9),
          roughness: mat.roughness ?? (pattern ? 0.6 : 0.35),
          triScale: mat.triplanar.scale,
          spin: mat.triplanar.space === 'object', // object-space projection (static; uSpin stays 0)
        },
        armTex,
      )
    }
  }
  const orm = tex(mat.orm, false)
  const out = new MeshStandardMaterial({
    metalness: mat.metalness ?? (orm ? 1 : 0),
    roughness: mat.roughness ?? (orm ? 1 : 0.6),
  })
  const albedo = pattern ?? tex(mat.albedo, true)
  if (albedo) out.map = albedo
  else if (mat.color) out.color = new Color(mat.color[0], mat.color[1], mat.color[2])
  if (orm) {
    out.roughnessMap = orm
    out.metalnessMap = orm
  }
  const normal = tex(mat.normal, false, 'normal')
  if (normal) out.normalMap = normal
  return out
}

// Attach an embedded GLB to a link group (async; visual-only). Unresolved/bad asset → nothing (the link
// just has no visual, which validation already guards against for declared asset ids). `visualRoot` is the
// part's top-level visual group (buildRig's `root`); its structureVersion is bumped once the mesh lands.
// Prepare one loaded GLB scene as a mesh link's visual instance: node selection, transform normalisation,
// GLB carving (hideNodes/keepNode), then the material remap/override + shadow flags. Returns null when a
// named node isn't in the GLB (the link stays visual-empty). Shared by attachMesh (one instance under the
// link group) and the arrayed-mesh path (the instance becomes a template cloned per array delta - the EOAT
// suction-cup grid).
export function prepareMeshInstance(scene: Object3D, shape: CarvedMeshShape, material: Material | undefined, perMaterial: Map<string, Material> | undefined, siblingNodes: Set<string>): Object3D | null {
  // `node` selects one node of an articulated GLB; else the whole scene. A named node that isn't in the
  // GLB → nothing (the link stays visual-empty).
  const source = shape.node ? scene.getObjectByName(shape.node) : scene
  if (!source) return null
  const inst = source.clone()
  // A per-node ref takes the node's geometry in its mesh-local frame: reset the authored node transform
  // so the rig link's offset/quat is the sole placement (the manifest owns the assembly), and drop only the
  // children that are other rig nodes (rendered by their own links): a housing node that parents articulated
  // sub-nodes in the GLB (e.g. the Diverter's `Pusher` parents `part1`/`part2`/`partEnd`) would otherwise
  // double-render them. Keep unnamed/primitive children: a multi-material glTF node loads as a Group of
  // per-primitive meshes (e.g. the Blade Stop's sections), and dropping those would render nothing. A
  // whole-scene ref keeps the model as is.
  if (shape.node) {
    for (const child of inst.children.slice()) if (child.name && siblingNodes.has(child.name)) inst.remove(child)
    inst.position.set(0, 0, 0)
    inst.quaternion.set(0, 0, 0, 1)
    inst.scale.setScalar(1)
  }
  // fitHeight (whole-scene refs only) normalises a raw import - scale to height, centre XZ, rest on y=0 -
  // the same fitToHeight the built-in device parts use; otherwise honor an explicit uniform `scale`.
  if (!shape.node && shape.fitHeight) fitToHeight(inst, shape.fitHeight)
  else if (shape.scale && shape.scale !== 1) inst.scale.multiplyScalar(shape.scale)
  // hideNodes / keepNode carve the GLB after fitHeight (so a sibling link splitting the same GLB normalises
  // identically). Done before the material traverse so a removed mesh's material isn't recoloured here.
  // hideNodes: remove the named nodes and their subtrees (a housing keeping everything but a movable cap).
  if (shape.hideNodes) {
    for (const name of shape.hideNodes) inst.getObjectByName(name)?.removeFromParent()
  }
  // keepNode: keep only the named node's subtree, re-based into the fitted frame; works even when the kept
  // node is nested under a multi-primitive housing node (the movable cap = just the GLB's 'Button' node).
  if (shape.keepNode) {
    const n = inst.getObjectByName(shape.keepNode)
    if (n) {
      inst.updateMatrixWorld(true) // inst carries the fitHeight transform; n.matrixWorld is relative to it
      const rel = new Matrix4().copy(inst.matrixWorld).invert().multiply(n.matrixWorld)
      for (const c of inst.children.slice()) inst.remove(c) // detach the whole tree (n is held by reference)
      rel.decompose(n.position, n.quaternion, n.scale)
      inst.add(n) // n now sits in the fitted frame, alone
    }
  }
  // nodes another link of this asset keeps are drawn by that link (core/glbBox.ts drawnElsewhere)
  for (const name of shape.drawnElsewhere ?? []) {
    const o = inst.getObjectByName(name)
    if (o && o.name !== shape.keepNode) o.removeFromParent()
  }
  const remap = (mat: Material): Material => (mat.name && perMaterial?.get(mat.name)) || mat
  inst.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = true
    // the authored GLB material name, kept for anything keyed by it after the remap replaces the material (tileUv)
    if (!Array.isArray(m.material) && m.material.name) m.userData.glbMaterial = m.material.name
    if (perMaterial) m.material = Array.isArray(m.material) ? m.material.map(remap) : remap(m.material)
    else if (material) m.material = material // override the GLB's own material with the package material
    // else the GLB keeps its own materials. They aren't de-metalled here: metals reflect the sky
    // (metalEnvironment.ts), so an untextured metal doesn't render near-black
  })
  return inst
}

// `material` overrides every mesh with one package material; `perMaterial` remaps individual GLB materials by
// name (the data-driven form of a built-in's per-material recolour). `perMaterial` wins when both are present.
// `onPrepared` sees the finished instance just before it is attached: the seam the caller uses to tag the
// loaded subtree (rig.ts pool opt-in), which can't be done at call time because the GLB resolves later.
export function attachMesh(group: Group, visualRoot: Group, shape: CarvedMeshShape, assets: readonly PartAsset[], material: Material | undefined, perMaterial: Map<string, Material> | undefined, siblingNodes: Set<string>, onPrepared?: (inst: Object3D) => void): void {
  const asset = assets.find((a) => a.id === shape.asset)
  if (!asset) return
  void loadMeshAsset(asset)
    .then((scene) => {
      const inst = prepareMeshInstance(scene, shape, material, perMaterial, siblingNodes)
      if (!inst) return
      onPrepared?.(inst)
      group.add(inst)
      // Bump the visual root's structureVersion so the view picks up these just-loaded meshes (render bundles
      // re-record, registries re-collect). A rig is built before its GLBs resolve, so without this its
      // mesh-shape links would be missing from the recorded pass (e.g. the Six-Axis robot, whose every link
      // is a mesh).
      bumpStructureVersion(visualRoot)
    })
    .catch((e) => console.error('[oip] custom-part mesh load failed', e))
}
