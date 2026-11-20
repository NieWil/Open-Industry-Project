import { describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { GUARD_HOLE_RADIUS } from '../../core/types'
import { examplePart } from './examplePart'

// Every function conveyor whose guard is a formed sheet draws a sensor-beam hole where the host hands it one (a
// `guardHoles` row [x, y, side], core/guards/guardHoles.ts): its guard sheet splits around the gap and a panel with a round
// hole through it fills it. This holds each family to that, through its real generated geometry(): somewhere in the
// drawn steel there is the hole's 20 mm circle, at the row's position, in the plane of that guard's sheet. And a
// conveyor with no holes draws exactly the parts it always did, so a scene without sensors is untouched.

type V3 = [number, number, number]
const W = 1.524, HW = W / 2, FACE = HW + 0.01 // a guard sheet's inner face, out from the bed centreline
const Y = 0.08

function qRotate(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = q as [number, number, number, number]
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0])
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]
}
/** every vertex of the drawn parts in part-local space, instances baked through their template */
function bake(parts: readonly MeshPart[]): V3[] {
  const out: V3[] = []
  for (const p of parts) {
    const pos = p.desc.positions
    const insts = p.instances ?? [{}]
    for (const inst of insts as { position?: number[]; quaternion?: number[]; scale?: number[] }[]) {
      for (let i = 0; i < pos.length; i += 3) {
        const s = inst.scale ?? [1, 1, 1]
        let v: V3 = [pos[i]! * s[0]!, pos[i + 1]! * s[1]!, pos[i + 2]! * s[2]!]
        if (inst.quaternion) v = qRotate(inst.quaternion, v)
        const t = inst.position ?? [0, 0, 0]
        out.push([v[0] + t[0]!, v[1] + t[1]!, v[2] + t[2]!])
      }
    }
  }
  return out
}

const realize = (id: string, params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(examplePart(id).behavior, params as never)
  if (!parts) throw new Error(`${id} geometry() returned no parts`)
  return parts
}

/** a vertex on the hole's rim: `local(v)` maps a vertex to (along the guard, height, out from the sheet's face) */
function hasRim(verts: V3[], local: (v: V3) => V3, along: number): boolean {
  return verts.some((v) => {
    const [u, h, n] = local(v)
    return Math.abs(Math.hypot(u - along, h - Y) - GUARD_HOLE_RADIUS) < 1e-4 && n > -1e-4 && n < 0.0051
  })
}

describe('sensor-beam hole panels in every sheet-guard conveyor', () => {
  // `lip`: whether the panel carries the guard's top return over the hole. The belt's guard sheet is its swept L
  // section, so the split takes the return with it and the panel must put it back; a spur's return is its own
  // continuous part, so a panel return there would sit face to face with it and z-fight.
  const straight = [
    { id: 'oip.belt-conveyor', params: { segments: [[4, 0]], width: W, height: 0.17 }, x: 2, lip: true },
    { id: 'oip.spur-conveyor', params: { width: W, length: 2 }, x: 0.3, lip: false },
    { id: 'oip.spur-roller-conveyor', params: { width: W, length: 2 }, x: 0.3, lip: false },
  ]
  for (const c of straight) {
    it(`${c.id}: a hole in each guard, at the row's position, in the sheet's plane`, () => {
      const plain = realize(c.id, c.params)
      const holed = realize(c.id, { ...c.params, guardHoles: [[c.x, Y, 1], [c.x, Y, -1]] })
      const verts = bake(holed)
      expect(hasRim(verts, (v) => [v[0], v[1], v[2] - FACE], c.x), 'right (+Z) guard').toBe(true)
      expect(hasRim(verts, (v) => [v[0], v[1], -v[2] - FACE], c.x), 'left (-Z) guard').toBe(true)
      expect(hasRim(bake(plain), (v) => [v[0], v[1], v[2] - FACE], c.x)).toBe(false)
      // the panels are appended after everything else, so every other part keeps its bank index
      expect(holed.slice(0, plain.length).map((p) => p.finish)).toEqual(plain.map((p) => p.finish))
      expect(holed.slice(plain.length).every((p) => p.finish === 'guard' && p.collision === undefined)).toBe(true)
      // the top return over the hole: a panel vertex out at the return's 25 mm reach, at the guard top
      const panelVerts = bake(holed.slice(plain.length))
      const hasReturn = panelVerts.some((v) => Math.abs(v[2] - (FACE + 0.025)) < 1e-4 && Math.abs(v[1] - 0.15) < 1e-4)
      expect(hasReturn, 'panel carries the top return').toBe(c.lip)
    })
  }

  for (const id of ['oip.curved-conveyor', 'oip.curved-roller-conveyor']) {
    it(`${id}: a hole in the inner and outer guard at the row's arc angle`, () => {
      const ir = 0.5, rc = ir + HW, t = Math.PI / 4
      const params = { innerRadius: ir, width: W, sweepDeg: 90 }
      const plain = realize(id, params)
      const holed = realize(id, { ...params, guardHoles: [[t, Y, 1], [t, Y, -1]] })
      const verts = bake(holed)
      // (along the tangent at t, height, radially out from the given face radius)
      const R: V3 = [Math.cos(t), 0, -Math.sin(t)], T: V3 = [-Math.sin(t), 0, -Math.cos(t)]
      const frame = (rFace: number, out: 1 | -1) => (v: V3): V3 => [
        v[0] * T[0] + v[2] * T[2],
        v[1],
        out * (v[0] * R[0] + v[2] * R[2] - rFace),
      ]
      expect(hasRim(verts, frame(rc + FACE, 1), 0), 'outer guard').toBe(true)
      expect(hasRim(verts, frame(rc - FACE, -1), 0), 'inner guard').toBe(true)
      expect(holed.slice(0, plain.length).map((p) => p.finish)).toEqual(plain.map((p) => p.finish))
    })
  }

  it('a hole that would straddle an end of the guard is not cut (the guard stays whole there)', () => {
    const params = { segments: [[4, 0]], width: W, height: 0.17 }
    const holed = realize('oip.belt-conveyor', { ...params, guardHoles: [[-0.2, Y, 1]] })
    expect(holed.length).toBe(realize('oip.belt-conveyor', params).length)
  })
})
