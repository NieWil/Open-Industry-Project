import { Color } from 'three'
import type { MeshStandardMaterial, Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { abs, clamp, color, float, fract, fwidth, max, min, texture, uv, vec2 } from 'three/tsl'
import type { FloorMacro } from './building'

type Scalar = Node<'float'>

/** one axis of a saw-cut joint's coverage, box-filtered by the pixel's footprint (building.ts floorMaterial) */
function jointCoverage(p: Scalar, m: FloorMacro): Scalar {
  const d = abs(fract(p.div(m.jointSpacing).add(0.5)).sub(0.5)).mul(m.jointSpacing)
  const w = max(fwidth(p), float(1e-4))
  return clamp(float(m.jointWidth / 2).sub(d).div(w).add(0.5), 0, 1).mul(min(float(1), float(m.jointWidth).div(w)))
}

/**
 * WebGPU TSL twin of the building floor's material (floorMaterial in building.ts), which patches the
 * same math into GLSL on the WebGL path: the slab tile times its tint, times two samples of the macro cloud at
 * periods that share no common repeat, darkened along the saw-cut joints. Each sample is scaled 2x so the
 * texture's mid grey is neutral.
 * Scalars only off the samples: a chained swizzle of a sample hits a Tint lowering bug on some Dawn backends.
 */
export function createFloorNodeMaterial(map: Texture, macro: Texture, tint: number, m: FloorMacro): MeshStandardMaterial {
  const mat = new MeshStandardNodeMaterial()
  const p = uv().mul(m.metresPerUv)
  const cs = float(Math.cos(m.turn))
  const sn = float(Math.sin(m.turn))
  const turned = vec2(p.x.mul(cs).sub(p.y.mul(sn)), p.x.mul(sn).add(p.y.mul(cs)))
  const a = texture(macro, p.div(m.periodA)).x
  const b = texture(macro, turned.div(m.periodB)).x
  const j = max(jointCoverage(p.x, m), jointCoverage(p.y, m))
  const shade = a.mul(b).mul(4).mul(float(1).sub(j.mul(m.jointDarken)))
  mat.colorNode = texture(map, uv()).xyz.mul(color(new Color(tint))).mul(shade)
  return mat as unknown as MeshStandardMaterial
}
