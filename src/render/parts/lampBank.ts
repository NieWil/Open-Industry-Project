import { Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial } from 'three'
import type { BufferGeometry, Object3D } from 'three'
import { webgpuNodeFactory } from '../renderMode'
import { retireInstancedMesh } from '../gpuRetire'
import { tagBankMembers, writeSlotMatrices } from './linkBank'

/**
 * A rig's primitive lamp links drawn as one InstancedMesh (a stack light's lens tiers: 8 links, 8
 * materials, 8 draws, 5 of them zero-height slivers when the tower has 3 segments → 1 draw).
 *
 * What rigLamps.ts paintLamp changes per tick lives in per-instance data instead of a per-link material:
 *
 *   - `instanceColor`  - the albedo: the lit colour when on, the unlit `off` colour when off.
 *   - `lampGlow` (vec4) - rgb = emissive (the lit colour, or black), a = opacity (the lamp's
 *     `opacity` when lit, 1 when off).
 *
 * With a white, non-emissive material this reproduces paintLamp exactly. The material is permanently
 * `transparent`: an unlit instance at alpha 1 in the transparent pass is pixel-identical to opaque
 * (depth write stays on).
 *
 * Per part, never pooled (instancePool refuses `instanceColor`; a lamp's point is per-part state). The
 * material is shared scene-wide, a never-disposed module singleton, so it must not go in a rig's
 * `allMaterials`.
 *
 * WebGL: an onBeforeCompile patch; WebGPU: the TSL twin (lampBankNodeMaterial.ts, injected by
 * createRenderer) wires the attribute to emissiveNode + opacityNode.
 */

let lampNodeFactory: (() => MeshStandardMaterial) | null = null
export function setLampBankNodeFactory(factory: (() => MeshStandardMaterial) | null): void {
  lampNodeFactory = factory
  shared = null
}

let shared: MeshStandardMaterial | null = null
/** the one lamp-bank material (the lamp look paintLamp gave a link: metalness 0.1, roughness 0.5) */
export function lampBankMaterial(): MeshStandardMaterial {
  if (shared) return shared
  const nodeFactory = webgpuNodeFactory(lampNodeFactory, 'lampBank')
  let mat: MeshStandardMaterial
  if (nodeFactory) {
    mat = nodeFactory()
  } else {
    mat = new MeshStandardMaterial()
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 lampGlow;\nvarying vec4 vLampGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvLampGlow = lampGlow;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vLampGlow;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vLampGlow.a;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance = vLampGlow.rgb;')
    }
    mat.customProgramCacheKey = () => 'lampBank'
  }
  mat.color.set(0xffffff) // the albedo is instanceColor
  mat.emissive.set(0x000000) // the glow is lampGlow
  mat.metalness = 0.1
  mat.roughness = 0.5
  mat.transparent = true
  shared = mat
  return mat
}

/** one lamp in a bank: its behavior name, lit + unlit colours (linear), lit opacity, the link's group
 *  (placed under the bank mesh's parent) and its unit-primitive scale carrier - the Mesh the link would
 *  otherwise have drawn, kept out of the scene so refresh's param sizing still has something to scale */
export type LampSlot = { name: string; color: Color; off: Color; opacity?: number; node: Object3D; shape: Object3D }

const _black = new Color(0, 0, 0)

export class LampBank {
  readonly mesh: InstancedMesh
  readonly slots: readonly LampSlot[]
  private readonly glow: InstancedBufferAttribute
  private readonly lit: (boolean | null)[]

  /** `geometry` is a unit primitive shared with other links; the bank clones it, because `lampGlow` is a
   *  per-bank attribute and must never be set on the shared template. */
  constructor(geometry: BufferGeometry, slots: readonly LampSlot[]) {
    const geo = geometry.clone()
    this.glow = new InstancedBufferAttribute(new Float32Array(slots.length * 4), 4)
    this.glow.setUsage(DynamicDrawUsage)
    geo.setAttribute('lampGlow', this.glow)
    this.mesh = new InstancedMesh(geo, lampBankMaterial(), slots.length)
    // allocated up front: the per-instance colour path is compiled in only if instanceColor exists at
    // first compile (SimBoxes' note, boxes.ts)
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(slots.length * 3), 3)
    this.mesh.instanceColor.setUsage(DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.userData.lampBank = true
    this.slots = slots
    this.lit = slots.map(() => null)
    for (let i = 0; i < slots.length; i++) this.paint(i, false)
    tagBankMembers(this.mesh, slots)
  }

  /** Re-place every instance: its link group's transform relative to the bank mesh's parent (walked
   *  through local matrices, so it needs no world-matrix update) times its scale carrier's. Call after
   *  anything that moves or resizes a link (refresh's param offsets / sizes / incline). */
  writeMatrices(): void {
    writeSlotMatrices(this.mesh, this.slots)
  }

  /** Light / darken instance `i` - paintLamp's two states as per-instance data. No-op when unchanged, so
   *  the per-tick applyLamps uploads nothing on a steady pattern. */
  paint(i: number, on: boolean): void {
    if (this.lit[i] === on) return
    this.lit[i] = on
    const s = this.slots[i]!
    const c = on ? s.color : s.off
    this.mesh.setColorAt(i, c)
    const g = on ? s.color : _black
    const a = this.glow.array as Float32Array
    a[i * 4] = g.r
    a[i * 4 + 1] = g.g
    a[i * 4 + 2] = g.b
    a[i * 4 + 3] = on ? (s.opacity ?? 1) : 1
    this.glow.needsUpdate = true
    this.mesh.instanceColor!.needsUpdate = true
  }

  /** whether instance `i` is lit (false before its first paint) */
  isLit(i: number): boolean {
    return this.lit[i] === true
  }

  dispose(): void {
    // Retire, never dispose (gpuRetire.ts): a recorded render bundle holds these buffers. Frees the
    // per-instance buffers and the bank's cloned geometry; the material is the shared singleton and stays.
    retireInstancedMesh(this.mesh)
  }
}
