import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { InstanceTransform, MeshPart } from '../../core/parts/partApi'
import { examplePart } from './examplePart'
import { beltSegmentFrames } from '../../core/conveyor/beltPath'
import { createGeometryBuilder } from '../../core/geometry/geometryBuilder'
const { behavior: BELT_CONVEYOR_BEHAVIOR, geometry: BELT_CONVEYOR_RIG } = examplePart('oip.belt-conveyor')

// The Belt Conveyor, authored on the geometry-function tier (docs/procedural-geometry.md) to match the
// built-in: its geometry() emits the full belt as multi-material MeshPart[] (a scrolling fabric bed + steel
// side frame rails + steel side guards + steel support legs) along a bent multi-segment belt path.
//
// The steel is emitted as instanced templates (MeshPart.instances, the unitBox discipline): straight-run
// rails/guards are per-instance scaled copies of a 1 m unit template, the trestle boxes copies of a unit
// cube, the bolts copies of a unit hex prism. So every belt in a scene shares the same four template
// geometries and merges in the scene-global instance pool. Only the fabric bed (per-belt scroll) and the
// fillet-bend arcs of a multi-segment belt are per-belt swept meshes. Assertions about steel extents
// therefore bake the instances through the template. (The filename keeps the older *RigParity name.)

const geo = BELT_CONVEYOR_RIG
const axis = (pos: number[], a: 0 | 1 | 2): number[] => pos.filter((_, i) => i % 3 === a)
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(BELT_CONVEYOR_BEHAVIOR, params as never)
  if (!parts) throw new Error('belt geometry() returned no parts')
  return parts
}
const role = (parts: MeshPart[], r: string): MeshPart => {
  const p = parts.find((x) => x.finish === r)
  if (!p) throw new Error(`missing belt part: ${r}`)
  return p
}
// every template vertex baked through every instance transform (scale ∘ quaternion ∘ translate), one axis
const bakedAxis = (part: MeshPart, a: 0 | 1 | 2): number[] => {
  const insts: readonly InstanceTransform[] = part.instances ?? [{ position: [0, 0, 0] }]
  const out: number[] = []
  for (const it of insts) {
    const [sx, sy, sz] = it.scale ?? [1, 1, 1]
    const [qx, qy, qz, qw] = it.quaternion ?? [0, 0, 0, 1]
    const pos = part.desc.positions
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]! * sx, y = pos[i + 1]! * sy, z = pos[i + 2]! * sz
      // v' = q v q*  (expanded)
      const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z
      const iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z
      const rx = ix * qw + iw * -qx + iy * -qz - iz * -qy
      const ry = iy * qw + iw * -qy + iz * -qx - ix * -qz
      const rz = iz * qw + iw * -qz + ix * -qy - iy * -qx
      out.push([rx + it.position[0], ry + it.position[1], rz + it.position[2]][a]!)
    }
  }
  return out
}
const STRAIGHT = { segments: [[3, 0]], width: 1.0, height: 0.28 }
const ZFRAME = { segments: [[1, 0], [2, 20], [1, -20]], width: 1.0, height: 0.28 }

describe('Belt Conveyor (geometry-function tier - full multi-material belt with legs)', () => {
  it('is a valid function-geometry package whose behavior both conveys and emits geometry', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.belt-conveyor', name: 'Belt Conveyor', params: {}, behavior: BELT_CONVEYOR_BEHAVIOR, geometry: geo })).toEqual([])
    expect(geo.kind).toBe('drawn')
    expect((geo as { conveys?: boolean }).conveys).toBe(true)
    expect(BELT_CONVEYOR_BEHAVIOR).toContain('geometry(')
    expect(BELT_CONVEYOR_BEHAVIOR).toContain('ctx.setSurfaceVelocity(')
  })

  it('realizes the full belt as multi-material parts: fabric bed banks + steel frame + guards + trestle legs + bolts', () => {
    const parts = realize(STRAIGHT)
    // a straight bed is two 'belt' banks (band strip + drum wrap) - see the bed-bank tests below
    expect(parts.map((p) => p.finish).sort()).toEqual(['belt', 'belt', 'bolt', 'frame', 'guard', 'leg'])
    for (const p of parts) expect(p.desc.positions.length).toBeGreaterThan(0) // every piece has geometry
  })

  it('a straight belt emits its steel purely as instance banks (no swept bend parts)', () => {
    const parts = realize(STRAIGHT)
    for (const r of ['frame', 'guard', 'leg', 'bolt']) {
      const withRole = parts.filter((p) => p.finish === r)
      expect(withRole.length).toBe(1) // no extra swept-bend part
      expect(withRole[0]!.instances!.length).toBeGreaterThan(0)
    }
    expect(role(parts, 'frame').instances!.length).toBe(2) // one rail piece per side
    expect(role(parts, 'guard').instances!.length).toBe(2) // one uncut guard span per side
  })

  it('steel templates are param-independent across length/width; only the frame rail follows height (the pooling contract)', () => {
    const a = realize(STRAIGHT)
    const b = realize({ segments: [[7, 0]], width: 2.0, height: STRAIGHT.height })
    const c = realize({ segments: [[7, 0]], width: 2.0, height: 0.4 })
    for (const r of ['frame', 'guard', 'leg', 'bolt']) {
      expect(role(a, r).desc.positions).toEqual(role(b, r).desc.positions)
    }
    // the rail is exactly as deep as the belt loop, so every same-height belt shares one rail geometry (like the
    // drum wraps); the guard, leg and bolt templates stay shared across heights too
    expect(role(a, 'frame').desc.positions).not.toEqual(role(c, 'frame').desc.positions)
    expect(Math.min(...axis(role(c, 'frame').desc.positions, 1))).toBeCloseTo(-0.405, 6)
    for (const r of ['guard', 'leg', 'bolt']) {
      expect(role(a, r).desc.positions).toEqual(role(c, r).desc.positions)
    }
  })

  it('the conveying fabric bed (role "belt") wraps the end drums: top surface at up=0, bottom return below', () => {
    const beds = realize(STRAIGHT).filter((p) => p.finish === 'belt')
    const y = beds.flatMap((p) => bakedAxis(p, 1))
    expect(Math.max(...y)).toBeCloseTo(0, 4) // the top conveying surface sits at up = 0
    expect(Math.min(...y)).toBeLessThan(-0.25) // bottom return ~belt-height (0.28) below - the loop wraps under
    expect(Math.min(...y)).toBeGreaterThan(-0.32)
    const x = beds.flatMap((p) => bakedAxis(p, 0))
    const span = Math.max(...x) - Math.min(...x)
    expect(span).toBeGreaterThan(3) // the loop extends past the 3 m run by ~drum radius (h/2) at each end
    expect(span).toBeLessThan(3.4)
  })

  it('a straight bed is two instance banks (band strip + drum wrap) whose data chains the loop arc-length', () => {
    const beds = realize(STRAIGHT).filter((p) => p.finish === 'belt')
    expect(beds.length).toBe(2)
    const [band, wrap] = beds
    expect(band!.instances!.length).toBe(2) // top run + bottom return
    expect(wrap!.instances!.length).toBe(2) // head + tail drum
    // data = [uMul, uAdd] metres: u·uMul + uAdd rebuilds the loop arc-length, chained in loop order
    // top → head wrap → bottom return → tail wrap, so the weave tiles continuously across the pieces
    const L = 3, piR = Math.PI * (0.28 / 2)
    expect(band!.instances![0]!.data).toEqual([L, 0])
    expect(wrap!.instances![0]!.data![0]).toBe(1) // wrap u is baked in real metres (0..πr)
    expect(wrap!.instances![0]!.data![1]).toBeCloseTo(L, 6)
    expect(band!.instances![1]!.data![1]).toBeCloseTo(L + piR, 6)
    expect(wrap!.instances![1]!.data![1]).toBeCloseTo(2 * L + piR, 6)
  })

  it('bed templates are param-independent across length/width (the pooling contract; the wrap tracks height only)', () => {
    const a = realize(STRAIGHT).filter((p) => p.finish === 'belt')
    const b = realize({ segments: [[7, 0]], width: 2.0, height: 0.28 }).filter((p) => p.finish === 'belt')
    expect(a[0]!.desc.positions).toEqual(b[0]!.desc.positions) // band strip
    expect(a[1]!.desc.positions).toEqual(b[1]!.desc.positions) // drum wrap (same height ⇒ same template)
  })

  it('a bent bed stays one swept per-belt band (a fillet bend cannot share a template)', () => {
    const beds = realize(ZFRAME).filter((p) => p.finish === 'belt')
    expect(beds.length).toBe(1)
    expect(beds[0]!.instances).toBeUndefined()
  })

  it('bends - a Z-frame override lifts the bed, and the fillet arcs emit as swept bend parts beside the banks', () => {
    const flatY = axis(role(realize(STRAIGHT), 'belt').desc.positions, 1)
    const bent = realize(ZFRAME)
    const bentY = axis(role(bent, 'belt').desc.positions, 1)
    const flatSpan = Math.max(...flatY) - Math.min(...flatY)
    const bentSpan = Math.max(...bentY) - Math.min(...bentY)
    expect(bentSpan).toBeGreaterThan(flatSpan + 0.3) // the +20° incline run lifts the bed
    // 3 straight runs → 6 rail instances, plus a swept frame part covering the two fillet arcs
    const frames = bent.filter((p) => p.finish === 'frame')
    expect(frames.find((p) => p.instances)!.instances!.length).toBe(6)
    expect(frames.find((p) => !p.instances)).toBeDefined()
    // the instanced run rails follow the incline: some rail instances carry a Z-rotation
    expect(frames.find((p) => p.instances)!.instances!.some((i) => i.quaternion !== undefined)).toBe(true)
  })

  it('reflows width - the steel guards widen with the belt (just outside ±width/2, at the rail)', () => {
    const z = bakedAxis(role(realize({ segments: [[3, 0]], width: 2.0, height: 0.28 }), 'guard'), 2)
    // the guard sits just outside the half-width (over the frame rail: hw + wall ≈ width/2 + 0.01..0.015)
    expect(Math.max(...z)).toBeGreaterThan(1.0)
    expect(Math.max(...z)).toBeLessThan(1.05)
    expect(Math.min(...z)).toBeLessThan(-1.0)
    expect(Math.min(...z)).toBeGreaterThan(-1.05)
  })

  it('support legs scale with belt length (a longer belt gets more posts)', () => {
    const shortLegs = role(realize(STRAIGHT), 'leg').instances!.length
    const longLegs = role(realize({ segments: [[9, 0]], width: 1.0, height: 0.28 }), 'leg').instances!.length
    expect(longLegs).toBeGreaterThan(shortLegs)
  })

  it('is deterministic - identical params → byte-identical bed positions + identical steel instances', () => {
    expect(role(realize(STRAIGHT), 'belt').desc.positions).toEqual(role(realize(STRAIGHT), 'belt').desc.positions)
    expect(role(realize(STRAIGHT), 'leg').instances).toEqual(role(realize(STRAIGHT), 'leg').instances)
  })

  // ---- structure toggles + guard openings + collision channel (built-in BeltConveyor parity) -------------
  it('frameRails:false drops the steel frame (and its web-bolts) but keeps the bed + legs', () => {
    const parts = realize({ ...STRAIGHT, frameRails: false })
    expect(parts.find((p) => p.finish === 'frame')).toBeUndefined()
    expect(parts.find((p) => p.finish === 'belt')).toBeDefined()
    expect(parts.find((p) => p.finish === 'leg')).toBeDefined()
  })

  it('per-side guard toggles - leftGuard:false leaves only the +Z (right) guard wall', () => {
    const z = bakedAxis(role(realize({ ...STRAIGHT, leftGuard: false }), 'guard'), 2)
    expect(Math.min(...z)).toBeGreaterThan(0) // nothing on the −Z (left) side
    expect(Math.max(...z)).toBeGreaterThan(0.5)
  })

  it('guardExtents rows retract one side\'s rail + guard end (the flush side-merge fold, host-fed)', () => {
    // baked max X of a role's vertices on one side (right = +Z, left = −Z)
    const maxOn = (parts: MeshPart[], r: string, sideSign: 1 | -1): number => {
      const p = role(parts, r)
      const xs = bakedAxis(p, 0)
      const zs = bakedAxis(p, 2)
      let max = -Infinity
      for (let i = 0; i < xs.length; i++) if (zs[i]! * sideSign > 0.4 && xs[i]! > max) max = xs[i]!
      return max
    }
    // STRAIGHT (3 m, height 0.28): drum-overhang faces at −0.14 / 3.14. Retract the right front to 3.13
    // (what the host folds in when this end merges flush onto another conveyor's side).
    const cut = realize({ ...STRAIGHT, guardExtents: [[1, -0.14, 3.13]] })
    expect(maxOn(cut, 'frame', 1)).toBeCloseTo(3.13, 3)
    expect(maxOn(cut, 'guard', 1)).toBeCloseTo(3.13, 3)
    // the untouched left side keeps the full drum-overhang face
    expect(maxOn(cut, 'frame', -1)).toBeCloseTo(3.14, 3)
    expect(maxOn(cut, 'guard', -1)).toBeCloseTo(3.14, 3)
    // and with no rows the steel is untouched end to end
    const base = realize(STRAIGHT)
    expect(maxOn(base, 'frame', 1)).toBeCloseTo(3.14, 3)
  })

  it('legs:false / middleLegs:false thin out the trestles', () => {
    expect(realize({ ...STRAIGHT, legs: false }).find((p) => p.finish === 'leg')).toBeUndefined()
    const all = role(realize({ segments: [[9, 0]], width: 1.0, height: 0.28 }), 'leg').instances!.length
    const ends = role(realize({ segments: [[9, 0]], width: 1.0, height: 0.28, middleLegs: false }), 'leg').instances!.length
    expect(ends).toBeLessThan(all) // dropping the middle legs leaves only the two inset end posts
  })

  it('leg exclusion zone drops legs whose arc-length falls inside [start, end]', () => {
    const long = { segments: [[9, 0]], width: 1.0, height: 0.28 }
    const full = role(realize(long), 'leg').instances!.length
    const excl = role(realize({ ...long, exclusionStart: 3, exclusionEnd: 6 }), 'leg').instances!.length
    expect(excl).toBeLessThan(full) // the ~4 m and ~6 m middle posts fall inside the zone and are removed
    // excluding the whole belt removes every post (the 'leg' role disappears)
    expect(realize({ ...long, exclusionStart: 0, exclusionEnd: 9 }).find((p) => p.finish === 'leg')).toBeUndefined()
  })

  it('per-end leg offset insets each drum independently (built-in tail/head attachment_offset)', () => {
    // isolate the tail post (no head/middle legs); a larger tailLegOffset pushes its min-X vertices inboard.
    const base = { segments: [[9, 0]], width: 1.0, height: 0.28, headLeg: false, middleLegs: false }
    const tailMinX = (tailLegOffset: number): number =>
      Math.min(...bakedAxis(role(realize({ ...base, tailLegOffset }), 'leg'), 0))
    expect(tailMinX(2.0)).toBeGreaterThan(tailMinX(0.45) + 1.0) // ~1.55 m of extra inset shows in the geometry
  })

  it('guard is declared collision:"box" (the channel the host realizes as static guard walls)', () => {
    expect(role(realize(STRAIGHT), 'guard').collision).toBe('box')
  })

  it('manual guardOpenings split the guard into shorter run instances (a gap for a sensor / transfer)', () => {
    // a continuous straight guard = 1 instance per side; one both-sides opening splits each into 2.
    expect(role(realize(STRAIGHT), 'guard').instances!.length).toBe(2)
    const cut = role(realize({ ...STRAIGHT, guardOpenings: [[1, 2, 0]] }), 'guard')
    expect(cut.instances!.length).toBe(4)
    // and the gap is real: no baked guard vertex lies inside the opening (1..2 m along the belt)
    const xs = bakedAxis(cut, 0)
    expect(xs.some((x) => x > 1.05 && x < 1.95)).toBe(false)
  })
})

// The host simulates, guards and snaps to core/conveyor/beltPath.ts; the part draws its own corners and fillets them. The drawn
// top surface must be g.fillet over the host's corners, including rows that turn past vertical (both clamp the
// running tilt to ±89°) and a segment too short for full-height bends (both tighten the bend the same way).
describe('Belt Conveyor draws the path the host simulates', () => {
  const cases: [string, number[][], number][] = [
    ['rows turning past vertical', [[2, 0], [2, 60], [2, 60]], 0.17],
    ['short segment between two bends', [[2, 0], [0.1, 45], [2, -45]], 0.17],
  ]
  for (const [name, rows, height] of cases) {
    it(name, () => {
      const corners = beltSegmentFrames(rows.map(([length, tiltDeg]) => ({ length: length!, tiltDeg: tiltDeg! }))).corners
      const top = createGeometryBuilder().fillet(corners.map((c) => [c.x, c.y, 0] as const), height)
      // a bent bed is one swept loop whose first stations are the top surface, two vertices (−z, +z) per station
      const pos = role(realize({ segments: rows, width: 1.0, height }), 'belt').desc.positions
      for (let i = 0; i < top.length; i++) {
        expect(pos[i * 6]!).toBeCloseTo(top[i]![0], 9)
        expect(pos[i * 6 + 1]!).toBeCloseTo(top[i]![1], 9)
      }
    })
  }
})
