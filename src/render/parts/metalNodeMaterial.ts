import type { MeshStandardMaterial, Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { abs, cos, float, materialColor, normalize, normalLocal, normalWorld, positionLocal, positionWorld, sin, texture, uniform, vec3 } from 'three/tsl'
import type { MetalSpec } from './common'
import { tickUniformGroup } from './tickUniformGroup'

/**
 * TSL port of the triplanar metal in common.ts (the onBeforeCompile MeshStandardMaterial
 * that WebGPU ignores, leaving the hardware flat). Mirrors that shader. The surface is the
 * texture sampled triplanar in world space: projected on the zy/xz/xy planes, blended by
 * the normalised |normal|, × tint × boost. Standard PBR lighting applies on top, so shadows
 * and metalness/roughness still work. Registered as the metal node factory by createRenderer.
 *
 * Spin (rollers): like the GLSL, sample in object space rotated about local Z by a uniform,
 * which sweeps the brushed grain around the symmetric cylinder. The uniform is exposed on
 * userData.spinUniform as on the WebGL path, so rollerSpinTick drives it unchanged.
 *
 * (Sensor-beam holes through a side guard are geometry, core/guards/guardHoles.ts; this shader cuts nothing.)
 */
export function createMetalNodeMaterial(spec: MetalSpec, tex: Texture): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  mat.metalness = spec.metalness
  mat.roughness = spec.roughness

  const scale = float(spec.triScale)
  let pos = positionWorld
  let nrm = normalWorld
  if (spec.spin === true) {
    // shared TICK group: the per-frame spin advance is a direct byte upload instead of
    // the per-object refresh walk on every draw (see tickUniformGroup.ts)
    const a = uniform(0).setGroup(tickUniformGroup())
    mat.userData.spinUniform = a // rollerSpinTick sets a.value (radians)
    const cs = cos(a)
    const sn = sin(a)
    pos = vec3(
      positionLocal.x.mul(cs).sub(positionLocal.y.mul(sn)),
      positionLocal.x.mul(sn).add(positionLocal.y.mul(cs)),
      positionLocal.z,
    )
    nrm = vec3(
      normalLocal.x.mul(cs).sub(normalLocal.y.mul(sn)),
      normalLocal.x.mul(sn).add(normalLocal.y.mul(cs)),
      normalLocal.z,
    )
  }

  // triplanar blend weights from the (rotated) normal, normalised so they sum to 1
  const w = abs(normalize(nrm))
  const bw = w.div(w.x.add(w.y).add(w.z))
  const mx = texture(tex, pos.zy.mul(scale)).xyz
  const my = texture(tex, pos.xz.mul(scale)).xyz
  const mz = texture(tex, pos.xy.mul(scale)).xyz
  const mtex = mx.mul(bw.x).add(my.mul(bw.y)).add(mz.mul(bw.z))
  // × the material's own colour, like the GLSL's diffuseColor. A baked color(spec.color) constant would make an
  // in-place re-tint (a function part's colorParam on a metal finish, e.g. the bollards' paint) a no-op on WebGPU.
  // Start from the vec3 texture so .mul resolves to the vec3×vec3 overload.
  mat.color.set(spec.color)
  mat.colorNode = mtex.mul(materialColor).mul(spec.boost)

  // MeshStandardNodeMaterial carries every MeshStandardMaterial property but isn't nominally
  // one (no isMeshStandardMaterial flag); the consumers only use it as a Material on a mesh
  return mat as unknown as MeshStandardMaterial
}
