// A drawn conveyor's rails and guards are built twice: by its own geometry() in part.js (where it draws them), and by
// the host from its bed (where the snap ends sit, where a merge or a beam meets a guard). The two must agree, or the
// guard a user sees and the one the host reasons about part company: a hole cut where no guard is drawn, a merge
// that stops short of a rail. Nothing ties them together but this test, across the shipped parts and their params.

import { beforeAll, describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../core/geometry/geometryEval'
import { bedOf } from '../core/parts/partGeometry'
import type { InstanceTransform, MeshPart } from '../core/parts/partApi'
import { clearPackages, getPackage } from '../core/parts/partRegistry'
import { resolvePartParams } from '../core/parts/partScript'
import { createSdkPart } from '../core/scene/scene'
import type { PartInstance } from '../core/types'
import { registerBundledPackages } from './parts/bundledExamples'

beforeAll(() => {
  clearPackages()
  registerBundledPackages()
})

/** a template vertex through one instance's scale, rotation and position */
function place(x: number, y: number, z: number, t: InstanceTransform): [number, number, number] {
  const s = t.scale ?? [1, 1, 1]
  const [qx, qy, qz, qw] = t.quaternion ?? [0, 0, 0, 1]
  const px = x * s[0], py = y * s[1], pz = z * s[2]
  const tx = 2 * (qy * pz - qz * py), ty = 2 * (qz * px - qx * pz), tz = 2 * (qx * py - qy * px)
  return [px + qw * tx + (qy * tz - qz * ty) + t.position[0], py + qw * ty + (qz * tx - qx * tz) + t.position[1], pz + qw * tz + (qx * ty - qy * tx) + t.position[2]]
}

const IDENTITY: InstanceTransform = { position: [0, 0, 0] }

/** the local X span of what `finish` draws on one side (sign of local Z), instances placed */
function drawnSpan(meshes: readonly MeshPart[], finish: 'guard' | 'frame', sign: 1 | -1): [number, number] | null {
  let lo = Infinity, hi = -Infinity
  for (const m of meshes) {
    if (m.finish !== finish) continue
    const p = m.desc.positions
    for (const t of m.instances ?? [IDENTITY]) {
      for (let i = 0; i < p.length; i += 3) {
        const [x, , z] = place(p[i]!, p[i + 1]!, p[i + 2]!, t)
        if (Math.sign(z) !== sign) continue
        lo = Math.min(lo, x)
        hi = Math.max(hi, x)
      }
    }
  }
  return lo < Infinity ? [lo, hi] : null
}

function shipped(id: string, params: Record<string, unknown>): { part: PartInstance; meshes: MeshPart[] } {
  const pkg = getPackage(id)!
  const part = createSdkPart(pkg, 'p', [0, 0, 0]) as PartInstance
  const placed = { ...part, params: { ...part.params, ...params } } as PartInstance
  return { part: placed, meshes: evalPartGeometry(pkg.behavior, resolvePartParams(pkg.params, placed.params as never)) ?? [] }
}

describe("a drawn conveyor's own rails and guards agree with its bed", () => {
  const SPURS = ['oip.spur-conveyor', 'oip.spur-roller-conveyor']
  const SPUR_PARAMS = [{}, { length: 3.2, width: 0.8 }, { angleFrontDeg: 45, angleBackDeg: -20 }, { angleFrontDeg: -30, angleBackDeg: 15, width: 1.1 }]
  for (const id of SPURS) {
    it.each(SPUR_PARAMS)(`${id}: each side's guard and rail run between that edge's own end faces (%o)`, (params) => {
      const { part, meshes } = shipped(id, params)
      const bed = bedOf(part)!
      const host = bed.guardHost(part)!
      const faces = bed.mergeFaces(part)!
      for (const [sign, run] of [[-1, host.sides.left], [1, host.sides.right]] as const) {
        const z = (sign * faces.width) / 2
        // the host's own two numbers for this edge agree...
        expect(run[0]).toBeCloseTo(faces.faceX(-1, z), 6)
        expect(run[1]).toBeCloseTo(faces.faceX(1, z), 6)
        // ...and the part draws its guard and its rail exactly there
        for (const finish of ['guard', 'frame'] as const) {
          const span = drawnSpan(meshes, finish, sign)!
          expect(span[0], `${finish} ${sign}`).toBeCloseTo(run[0], 4)
          expect(span[1], `${finish} ${sign}`).toBeCloseTo(run[1], 4)
        }
      }
    })
  }

  const BELT_PARAMS = [{}, { segments: [[2.5, 0]] }, { segments: [[3, 0]], height: 0.3 }, { width: 0.9 }]
  it.each(BELT_PARAMS)("oip.belt-conveyor: its guards and rails reach its drum faces, where its ends mate (%o)", (params) => {
    const { part, meshes } = shipped('oip.belt-conveyor', params)
    const bed = bedOf(part)!
    const faces = bed.mergeFaces(part)!
    const host = bed.guardHost(part)!
    for (const sign of [-1, 1] as const) {
      // where the host holes its guards is where they run
      const run = sign < 0 ? host.sides.left : host.sides.right
      expect(run[0]).toBeCloseTo(faces.faceX(-1, 0), 6)
      expect(run[1]).toBeCloseTo(faces.faceX(1, 0), 6)
      for (const finish of ['guard', 'frame'] as const) {
        const span = drawnSpan(meshes, finish, sign)!
        expect(span[0], `${finish} ${sign}`).toBeCloseTo(faces.faceX(-1, 0), 4)
        expect(span[1], `${finish} ${sign}`).toBeCloseTo(faces.faceX(1, 0), 4)
      }
    }
  })
})
