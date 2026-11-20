import type { MeshStandardMaterial, Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { materialColor, texture, uniform, uv } from 'three/tsl'
import { tickUniformGroup } from './tickUniformGroup'

/**
 * WebGPU TSL scroll material - the node-material twin of a geometry() scroll channel's plain
 * MeshStandardMaterial (MeshPart.scroll: a chain's links, a belt's weave). Built by scrollMaterial
 * (common.ts) for the WebGPU path so a running scroll doesn't freeze. Same look: the channel's
 * texture × the material's colour, at the source material's metalness/roughness.
 *
 * Why a node material: a scroll channel animates by advancing its private texture copy's offset.x
 * each running frame (sdk/rigProcedural.ts procTick), exactly like the belt fabric. On WebGPU three's
 * NodeMaterialObserver never inspects texture.offset/matrix, so a plain material's uv transform is
 * not re-uploaded and the scroll freezes. Also, parts sharing one material share its single
 * observer, whose renderId gate then lets only the first mesh drawn each frame refresh.
 *
 * Like the belt (beltNodeMaterial.ts), the scroll samples through explicit offset/repeat uniforms
 * in the shared TICK group (tickUniformGroup.ts) wrapping the texture's own live Vector2s -
 * uv·repeat + offset, the composed uv matrix for rotation 0 / center 0 (a scroll channel only ever
 * moves offset.x). The advance is uploaded as one direct byte write per scroll material instead of a
 * per-object refresh walk.
 */
export function createScrollNodeMaterial(tex: Texture, metalness: number, roughness: number): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  mat.metalness = metalness
  mat.roughness = roughness
  const g = tickUniformGroup()
  const offset = uniform(tex.offset).setGroup(g) // live reference - procTick mutates tex.offset in place
  const repeat = uniform(tex.repeat).setGroup(g) // live reference - follows tex.repeat if it is re-tiled
  const texNode = texture(tex, uv().mul(repeat).add(offset))
  // × the material's diffuse colour so an in-place selection tint (material.color.set) still works
  mat.colorNode = texNode.xyz.mul(materialColor)
  // MeshStandardNodeMaterial carries every MeshStandardMaterial property but isn't nominally one
  // (no isMeshStandardMaterial flag); consumers only use it as a Material on a mesh + set .color
  return mat as unknown as MeshStandardMaterial
}
