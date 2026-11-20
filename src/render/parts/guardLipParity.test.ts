import { describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { resolvedBoxSize, resolvedOffset } from '../../core/rig/rigPose'
import { GUARD_HEIGHT } from '../../core/types'
import { examplePart, type RigGeo } from './examplePart'

// Every conveyor guard has a formed top return: its top edge turned outward, away from the bed, so the sheet
// looks like folded steel rather than card. Five families draw it five different ways (a rig box link, a swept
// L-section on straight, belt-path and arc guards, a plain box beside a spur's colliding guard), so pin the one
// shape they must agree on, the way guardRunMerge.test.ts pins the one collider profile: the return spans the
// guard's top 5 mm and reaches 35 mm outside the bed edge (10 mm wall + 5 mm sheet + a 20 mm return). A butt
// between two families then shows one continuous top edge, not a step.

const TOP = GUARD_HEIGHT // guard top above the running surface
const RETURN_T = 0.005
const REACH = 0.035 // bed edge -> outer edge of the return

const W = 1
const hw = W / 2
const fn = (id: string, params: Record<string, unknown>): MeshPart[] => {
  const { behavior } = examplePart(id)
  const parts = evalPartGeometry(behavior, params as never)
  if (!parts) throw new Error(`${id} geometry() returned no parts`)
  return parts
}
const pts = (p: MeshPart): [number, number, number][] => {
  const out: [number, number, number][] = []
  for (let i = 0; i < p.desc.positions.length; i += 3) out.push([p.desc.positions[i]!, p.desc.positions[i + 1]!, p.desc.positions[i + 2]!])
  return out
}
const round = (v: number): number => Math.round(v * 1e6) / 1e6

describe('every conveyor guard carries the same outward top return', () => {
  it('straight roller (rig): a non-colliding guard link per side, on the guard top, reaching bed edge + 35 mm', () => {
    const geo = examplePart<RigGeo>('oip.roller-conveyor').geometry
    for (const [name, sign] of [['lipL', -1], ['lipR', 1]] as const) {
      const link = geo.links.find((l) => l.name === name)!
      expect(link.finish).toBe('guard') // so it splits around openings and follows snap extents with its guard
      expect(link.collision).toBe('none')
      if (link.shape.kind !== 'box') throw new Error('lip is a box link')
      const size = resolvedBoxSize(link.shape.size, link.shape.sizeParams, { width: W, length: 3 })
      const off = resolvedOffset(link.offset, link.offsetParams, { width: W, length: 3 })
      expect(round(off[1] + size[1] / 2)).toBe(TOP)
      expect(round(size[1])).toBe(RETURN_T)
      expect(round(sign * off[2] + size[2] / 2)).toBe(round(hw + REACH))
    }
  })

  it('belt: the swept guard section turns out at its top (template z is measured off the guard face)', () => {
    const guard = fn('oip.belt-conveyor', { width: W, segments: [[3, 0]], height: 0.5, leftGuard: true, rightGuard: true }).find((p) => p.finish === 'guard')!
    const p = pts(guard)
    // the template's z = 0 is the guard's inner face at bed edge + 10 mm
    expect(round(Math.max(...p.map((v) => v[2])) + 0.01)).toBe(REACH)
    expect(round(Math.max(...p.map((v) => v[1])))).toBe(TOP)
    // the outermost points are all in the top 5 mm: a return, not a thicker sheet
    for (const v of p) if (v[2] > 0.006) expect(v[1]).toBeGreaterThanOrEqual(TOP - RETURN_T - 1e-9)
  })

  for (const id of ['oip.curved-conveyor', 'oip.curved-roller-conveyor']) {
    it(`curve ${id}: both arc guards turn out at their top, away from the bed`, () => {
      const IR = 0.8
      const guard = fn(id, { innerRadius: IR, width: W, sweepDeg: 90, innerGuard: true, outerGuard: true }).find((p) => p.finish === 'guard')!
      // on the arc only (a 90 deg sweep lies in x >= 0, z <= 0): the straight tangent stubs past each end sit
      // further from the centre than the arc radius by construction
      const r = pts(guard)
        .filter((v) => v[0] >= -1e-9 && v[2] <= 1e-9)
        .map((v) => ({ r: Math.hypot(v[0], v[2]), y: v[1] }))
      expect(round(Math.max(...r.map((q) => q.r)))).toBe(round(IR + W + REACH))
      expect(round(Math.min(...r.map((q) => q.r)))).toBe(round(IR - REACH))
      for (const q of r) if (q.r > IR + W + 0.016 || q.r < IR - 0.016) expect(q.y).toBeGreaterThanOrEqual(TOP - RETURN_T - 1e-9)
    })
  }

  for (const id of ['oip.spur-conveyor', 'oip.spur-roller-conveyor']) {
    it(`spur ${id}: a non-colliding return beside each colliding guard wall`, () => {
      const parts = fn(id, { length: 2, width: W, angleFrontDeg: 0, angleBackDeg: 0, leftGuard: true, rightGuard: true })
      const returns = parts.filter((p) => p.finish === 'guard' && p.collision === undefined)
      expect(returns).toHaveLength(2)
      for (const ret of returns) {
        const p = pts(ret)
        const zs = p.map((v) => Math.abs(v[2]))
        expect(round(Math.max(...zs))).toBe(round(hw + REACH))
        expect(round(Math.max(...p.map((v) => v[1])))).toBe(TOP)
        expect(round(Math.min(...p.map((v) => v[1])))).toBe(round(TOP - RETURN_T))
      }
    })
  }
})
