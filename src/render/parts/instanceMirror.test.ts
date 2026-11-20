import { describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { instantiatePartScript, resolvePartParams } from '../../core/parts/partScript'
import type { InstanceTransform, MeshPart, ParamValue } from '../../core/parts/partApi'
import { examplePart, examplePartIds } from './examplePart'

// No mirrored instances: a catalog-wide shading invariant.
//
// A MeshPart.instances bank is realized as one InstancedMesh (parts/instancedTemplate.ts), so placing the
// −Z copy of a symmetric piece with a negative scale component ("side in a z-mirror scale") looks like an
// easy way to get both sides from one template. It renders wrong. A negative-determinant instance matrix
// reverses that instance's triangle winding, so its outward faces rasterize as back faces. The steel roles
// are DoubleSide, so three then applies `normal *= faceDirection` (gl_FrontFacing) and the shading normal
// points into the piece. The mirrored side is lit as if seen from its inner face: same wall, same light,
// visibly different colour from its twin. three's fix for mirrored objects (WebGLRenderer's frontFaceCW,
// from object.matrixWorld.determinant()) is per-object and ignores instanceMatrix, so it doesn't help a
// bank. The failure is silent: no warning, no device error, just a differently shaded side.
//
// The belt conveyor's guards + rails and the two spurs' rails are the parts this applies to. Place the
// far-side copy as the same prism run backwards (anchor at the far end + a 180° yaw). For a constant
// cross-section extrusion that is the identical solid, with a positive determinant and still one pooled
// template. This test checks it across the whole committed catalog, including parts not yet written.
//
// A compose(position, quaternion, scale) matrix has determinant sx·sy·sz (a quaternion is always +1), so the
// invariant is exactly "the scale triple's product is positive".

const det = (it: InstanceTransform): number => {
  const [sx, sy, sz] = it.scale ?? [1, 1, 1]
  return sx * sy * sz
}

/** every template vertex baked through every instance transform (scale → quaternion → translate) */
const baked = (part: MeshPart): [number, number, number][] => {
  const insts: readonly InstanceTransform[] = part.instances ?? [{ position: [0, 0, 0] }]
  const out: [number, number, number][] = []
  for (const it of insts) {
    const [sx, sy, sz] = it.scale ?? [1, 1, 1]
    const [qx, qy, qz, qw] = it.quaternion ?? [0, 0, 0, 1]
    const pos = part.desc.positions
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]! * sx, y = pos[i + 1]! * sy, z = pos[i + 2]! * sz
      // v + 2q_v × (q_v × v + w·v)
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
      out.push([
        x + qw * tx + qy * tz - qz * ty + it.position[0],
        y + qw * ty + qz * tx - qx * tz + it.position[1],
        z + qw * tz + qx * ty - qy * tx + it.position[2],
      ])
    }
  }
  return out
}

const key = (p: [number, number, number]): string => p.map((v) => Math.round(v * 1e5)).join(',')

const realize = (id: string, overrides: Record<string, ParamValue> = {}): MeshPart[] => {
  const { behavior, geometry } = examplePart(id)
  if (geometry.kind !== 'drawn') return []
  const { def } = instantiatePartScript(behavior)
  return evalPartGeometry(behavior, resolvePartParams(def?.params, overrides)) ?? []
}

describe('no mirrored instance banks (negative-determinant transforms shade wrong)', () => {
  it('every committed function-geometry part places its instances with a positive determinant', () => {
    const offenders: string[] = []
    for (const id of examplePartIds()) {
      for (const part of realize(id)) {
        for (const [i, it] of (part.instances ?? []).entries()) {
          if (det(it) <= 0) offenders.push(`${id} ${part.finish ?? 'mesh'}[${i}] scale=${JSON.stringify(it.scale)}`)
        }
      }
    }
    expect(offenders, 'mirror the piece by running it backwards under a 180° turn, not with a negative scale').toEqual([])
  })

  // The belt's steel is placed by a shared helper (steelPiece), so exercise the paths that helper takes:
  // a bent multi-run path (fillet bends + several straight runs), a
  // guard split by an opening, and a host-fed extents retraction.
  it('the belt conveyor keeps positive determinants on bends, openings and retracted extents', () => {
    const cases: Record<string, ParamValue>[] = [
      { segments: [[2, 0], [3, 10], [2, 0]] },
      { guardOpenings: [[1, 2, -1]] },
      { guardExtents: [[-1, 0.5, 3.5]] },
      { segments: [[2, 0], [2, -8]], guardOpenings: [[0.5, 1.5, 0]], guardExtents: [[1, 0.2, 3.0]] },
    ]
    for (const overrides of cases) {
      for (const part of realize('oip.belt-conveyor', overrides)) {
        for (const it of part.instances ?? []) expect(det(it), `${JSON.stringify(overrides)} ${part.finish}`).toBeGreaterThan(0)
      }
    }
  })

  // The flip must still be a flip: dropping it would also satisfy "no negative scale" while leaving both
  // guards on one side. Baked through their instances, the two sides are each other's z-mirror image.
  it('the belt conveyor\'s guard + rail banks are still exact z-mirror twins across the bed', () => {
    for (const role of ['guard', 'frame']) {
      const part = realize('oip.belt-conveyor').find((p) => p.finish === role && p.instances?.length)
      expect(part, `belt ${role} bank`).toBeTruthy()
      const pts = baked(part!)
      const left = new Set(pts.filter((p) => p[2] < 0).map(key))
      const right = pts.filter((p) => p[2] > 0)
      expect(left.size, `${role}: nothing on the −Z side`).toBeGreaterThan(0)
      expect(right.length, `${role}: nothing on the +Z side`).toBeGreaterThan(0)
      const missing = right.filter((p) => !left.has(key([p[0], p[1], -p[2]])))
      expect(missing.length, `${role}: ${missing.length} +Z vertices have no −Z twin`).toBe(0)
    }
  })
})
