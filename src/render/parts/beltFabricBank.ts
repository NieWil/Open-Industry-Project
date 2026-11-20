import { DoubleSide, InstancedBufferAttribute, MeshStandardMaterial, Texture } from 'three'
import type { InstancedMesh, Material } from 'three'
import type { InstanceTransform } from '../../core/parts/partApi'
import { webgpuNodeFactory } from '../renderMode'
import { BELT_TEX_PERIOD, beltWeaveTexture } from './common'
import { animClockEpoch, animClockUniform, rebaseAnim, rebaseAnimForWrap } from './animClock'
import type { BeltTextureVariant } from './common'

/**
 * Shared materials for instanced belt-fabric banks (a straight belt conveyor's bed). The per-belt
 * path (createBeltSurface) carries its scroll in its material: one material and one draw per bed.
 * Banks share one material per (weave variant, belt colour) and move per-belt state into per-instance
 * attributes, so every same-look bed in the scene merges in the instance pool:
 *
 *   - `fabricUv` (vec4, static): [uMul, uAdd, vMul, vAdd]. The template bakes u in local metres, and the
 *     shader rebuilds belt-loop arc-length as `u·uMul + uAdd`, so the weave tiles continuously across
 *     a bed's pieces regardless of scale.x stretch. v is remapped so instances that are slices of the
 *     belt width (a spur's strips) sample their slice. A full-width bed keeps the identity [1, 0].
 *   - `fabricScroll` (vec2, near-static): [base, rate] in texture periods. The shader evaluates
 *     `base + rate·beltClock`, so a running belt writes nothing per frame, and belts in one bank
 *     scroll at their own rates.
 *
 * Sampled u = uv.x·fabricUv.x + fabricUv.y + (fabricScroll.x + fabricScroll.y·uBeltClock),
 * v = uv.y·fabricUv.z + fabricUv.w, the same math as the per-belt path. The u-sign is always +1: straight
 * beds bake u along +X, and curved parts (the arc-mirror rule) never bank.
 *
 * WebGL: MeshStandardMaterial + an onBeforeCompile uv patch. WebGPU: the TSL twin
 * (beltFabricBankNodeMaterial.ts, injected by createRenderer). The textures are module-level singletons,
 * never disposed. A material is shared while any bank holds it: each bank acquires its material and
 * releases it when it switches or is dropped, and the last release disposes it. A colour drag commits
 * on every slider move, so a material kept for the session would pile up one per colour the drag passed.
 */

// the WebGPU TSL twin, injected by createRenderer (see renderMode.webgpuNodeFactory for the contract)
let bankNodeFactory: ((tex: Texture) => MeshStandardMaterial) | null = null
export function setBeltBankNodeFactory(factory: ((tex: Texture) => MeshStandardMaterial) | null): void {
  bankNodeFactory = factory
}

/**
 * Belt scroll uses the shared sim-animation clock (animClock.ts). Its header explains why the shader
 * integrates the accumulator instead of the CPU re-deriving it per frame. These are the belt wrappers:
 * scroll is periodic over one texture period, so that is the fold.
 */
export const beltClockEpoch = animClockEpoch
export function rebaseBeltScroll(base: number, rate: number, nextRate: number): number {
  return rebaseAnim(base, rate, nextRate, 1)
}
export function rebaseBeltScrollForWrap(base: number, rate: number, wraps: number): number {
  return rebaseAnimForWrap(base, rate, wraps, 1)
}

// One shared Texture per weave variant, with an identity transform; the shader does tiling + scroll.
// These are the app-wide singletons (common.ts beltWeaveTexture), the same objects the per-belt surfaces
// sample, so a scene of straight beds and curved ribbons holds one fabric texture per variant in total.
// This is safe because the per-belt path never mutates a texture's uv transform. Variants stay separate
// textures (never an image swap on one), so the WebGPU same-GPUTexture-size trap never applies.
const bankTexture = beltWeaveTexture

const bankMaterials = new Map<string, { mat: MeshStandardMaterial; refs: number }>()
/** the key of each live bank material, so a release can find its entry */
const bankMaterialKeys = new WeakMap<Material, string>()

/** Acquire the shared fabric material for a (weave variant, belt colour), with the same look as the per-belt
 *  createBeltSurface material (fabric × colour, metalness 0 / roughness 0.85, double-sided). Each call takes a
 *  reference; pair it with one {@link releaseBeltBankMaterial}. */
export function acquireBeltBankMaterial(variant: BeltTextureVariant, colorHex: string): MeshStandardMaterial {
  const key = `${variant}|${colorHex}`
  const held = bankMaterials.get(key)
  if (held) {
    held.refs++
    return held.mat
  }
  let mat: MeshStandardMaterial
  const tex = bankTexture(variant)
  const nodeFactory = webgpuNodeFactory(bankNodeFactory, 'beltBank')
  if (nodeFactory) {
    mat = nodeFactory(tex)
  } else {
    mat = new MeshStandardMaterial({ color: 0xffffff, map: tex, metalness: 0, roughness: 0.85 })
    mat.onBeforeCompile = (shader) => {
      // the one shared clock object (not a per-material uniform): every bank program samples the
      // same value, so advanceBeltClock moves the whole scene's belts with a single write
      shader.uniforms['uBeltClock'] = animClockUniform
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 fabricUv;\nattribute vec2 fabricScroll;\nuniform float uBeltClock;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv = vec2( uv.x * fabricUv.x + fabricUv.y + fabricScroll.x + fabricScroll.y * uBeltClock, uv.y * fabricUv.z + fabricUv.w );')
    }
    mat.customProgramCacheKey = () => 'beltFabricBank'
  }
  mat.color.set(colorHex)
  mat.side = DoubleSide
  bankMaterials.set(key, { mat, refs: 1 })
  bankMaterialKeys.set(mat, key)
  return mat
}

/**
 * Drop one reference to a bank material; the last one disposes it. Disposing a material is safe under a
 * recorded render bundle (gpuRetire.ts header). Any other material is ignored, so a caller can pass whatever
 * its bank held.
 */
export function releaseBeltBankMaterial(mat: Material | null | undefined): void {
  const key = mat ? bankMaterialKeys.get(mat) : undefined
  if (key === undefined) return
  const entry = bankMaterials.get(key)!
  if (--entry.refs > 0) return
  bankMaterials.delete(key)
  bankMaterialKeys.delete(entry.mat)
  entry.mat.dispose()
}

/** live bank material count, for tests */
export function beltBankMaterialCount(): number {
  return bankMaterials.size
}

/**
 * Attach/refresh a fabric bank's per-instance attributes on its own geometry. Each per-part bank
 * realizes its own BufferGeometry, so per-part attributes never collide across the shared template
 * content. Sized to the mesh's bucketed capacity like instanceMatrix, so a length-resize that stays
 * under capacity rewrites values in place, with no realloc and no stale WebGPU captured buffer. Call
 * after writeInstanceMatrices and before the scene-global pool first sees the mesh (the geometry
 * content key caches attribute names on first sight).
 */
export function writeFabricBankAttributes(mesh: InstancedMesh, instances: readonly InstanceTransform[], base: number, rate: number): void {
  const cap = mesh.instanceMatrix.count
  const geo = mesh.geometry
  let fUv = geo.getAttribute('fabricUv') as InstancedBufferAttribute | undefined
  if (!fUv || fUv.count < cap || fUv.itemSize !== 4) {
    fUv = new InstancedBufferAttribute(new Float32Array(cap * 4), 4)
    geo.setAttribute('fabricUv', fUv)
  }
  const uvArr = fUv.array as Float32Array
  for (let i = 0; i < instances.length; i++) {
    const d = instances[i]!.data
    uvArr[i * 4] = (d?.[0] ?? 1) / BELT_TEX_PERIOD
    uvArr[i * 4 + 1] = (d?.[1] ?? 0) / BELT_TEX_PERIOD
    uvArr[i * 4 + 2] = d?.[2] ?? 1
    uvArr[i * 4 + 3] = d?.[3] ?? 0
  }
  fUv.needsUpdate = true
  mesh.userData.beltFabricBank = true
  writeFabricBankScroll(mesh, base, rate)
}

/**
 * Write a bank's scroll state with a pair per instance: a posable conveying array's copies, each running its belt at
 * its own speed. Like writeFabricBankScroll, a call only when a rate changes or the clock wraps, never per frame.
 */
export function writeFabricBankScrolls(mesh: InstancedMesh, base: ArrayLike<number>, rate: ArrayLike<number>): void {
  const geo = mesh.geometry
  let fScroll = geo.getAttribute('fabricScroll') as InstancedBufferAttribute | undefined
  if (!fScroll || fScroll.count < mesh.instanceMatrix.count || fScroll.itemSize !== 2) {
    fScroll = new InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 2), 2)
    geo.setAttribute('fabricScroll', fScroll)
  }
  const arr = fScroll.array as Float32Array
  const n = Math.min(base.length, fScroll.count)
  for (let i = 0; i < n; i++) {
    arr[i * 2] = base[i]!
    arr[i * 2 + 1] = rate[i]!
  }
  fScroll.needsUpdate = true
}

/**
 * Write a bank's scroll state: [base, rate] per instance, the same pair on every instance of one
 * part's bank. Not a per-frame call. The shader integrates `base + rate·beltClock` itself, so the
 * conveyor tick calls this only when the rate changed or the clock wrapped.
 * Version-bumped via needsUpdate so the pool's merged copy syncs (syncInstancedAttrs) on exactly
 * those frames and copies nothing on the rest.
 */
export function writeFabricBankScroll(mesh: InstancedMesh, base: number, rate: number): void {
  const geo = mesh.geometry
  let fScroll = geo.getAttribute('fabricScroll') as InstancedBufferAttribute | undefined
  if (!fScroll || fScroll.count < mesh.instanceMatrix.count || fScroll.itemSize !== 2) {
    fScroll = new InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 2), 2)
    geo.setAttribute('fabricScroll', fScroll)
  }
  const arr = fScroll.array as Float32Array
  for (let i = 0; i < arr.length; i += 2) {
    arr[i] = base
    arr[i + 1] = rate
  }
  fScroll.needsUpdate = true
}
