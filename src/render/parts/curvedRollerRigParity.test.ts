import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type FuncGeo } from './examplePart'
const { behavior: CURVED_ROLLER_BEHAVIOR, geometry: CURVED_ROLLER_GEO } = examplePart<FuncGeo>('oip.curved-roller-conveyor')

// The Curved Roller Conveyor, authored on the geometry-function tier (docs/procedural-geometry.md) to match
// the built-in curved roller; the roller counterpart of the SDK Curved Belt Conveyor. Its geometry() lofts the
// steel frame + side guards along a horizontal arc (SDK convention: entry at local +X, sweeping toward −Z),
// yaws trestle legs to the sweep, and draws its own roller banks (examples/parts/_shared/rollerBed.js): the roller tube
// as a lathe template instanced around the arc, plus its axle stubs, both spinning (MeshPart.spin on a bank).
// Realized here through core/geometry/geometryEval, render's in-layer evaluator.

const geo = CURVED_ROLLER_GEO
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(CURVED_ROLLER_BEHAVIOR, params as never)
  if (!parts) throw new Error('curved-roller geometry() returned no parts')
  return parts
}
const role = (parts: MeshPart[], r: string): MeshPart => {
  const p = parts.find((x) => x.finish === r)
  if (!p) throw new Error(`missing curved-roller part: ${r}`)
  return p
}
const ARC = { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 1 }
// the roller bodies: the kit emits the tubes first, then the axle stubs, both role 'roller' banks
const bodies = (parts: MeshPart[]): MeshPart => {
  const p = parts.find((x) => x.finish === 'roller' && x.instances)
  if (!p) throw new Error('missing curved-roller roller bank')
  return p
}
const centres = (parts: MeshPart[]): { x: number; z: number }[] => bodies(parts).instances!.map((i) => ({ x: i.position[0], z: i.position[2] }))
const ROLLER_TEMPLATE_BODY = 2 * 0.9371 // the kit's tube, rim to rim, in its native units

describe('Curved Roller Conveyor (geometry-function tier - arc rollers + arc surface velocity)', () => {
  it('is a valid function-geometry package whose behavior both conveys (arc field) and emits geometry', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.curved-roller-conveyor', name: 'Curved Roller Conveyor', params: {}, behavior: CURVED_ROLLER_BEHAVIOR, geometry: geo })).toEqual([])
    expect(geo.kind).toBe('drawn')
    expect((geo as { conveys?: boolean }).conveys).toBe(true)
    expect(CURVED_ROLLER_BEHAVIOR).toContain('geometry(')
    expect(CURVED_ROLLER_BEHAVIOR).toContain('ctx.setArcSurfaceVelocity(')
  })

  it('realizes the curve as steel frame + guards + trestle legs + bolts + a spinning roller bank (no belt bed)', () => {
    const parts = realize(ARC)
    expect([...new Set(parts.map((p) => p.finish))].sort()).toEqual(['bolt', 'frame', 'guard', 'leg', 'roller'])
    expect(parts.find((p) => p.finish === 'belt')).toBeUndefined() // rollers are the surface, no fabric bed
    for (const p of parts) expect(p.desc.positions.length).toBeGreaterThan(0)
  })

  it('the rollers are two spinning instanced banks (tubes + axle stubs), render-only, sized from the roller class', () => {
    const parts = realize(ARC)
    const banks = parts.filter((p) => p.finish === 'roller')
    expect(banks).toHaveLength(2)
    const [tubes, stubs] = banks as [MeshPart, MeshPart]
    for (const b of banks) {
      expect(b.spin).toEqual({ axis: [0, 0, -1], radius: 0.024 }) // ROLLER_CLASSES.light.radius sets the no-slip rate
      expect(b.collision).toBeUndefined() // the conveying deck is the real surface
    }
    expect(stubs.instances!.length).toBe(2 * tubes.instances!.length) // two stubs per roller
    expect(tubes.instances!.length).toBeGreaterThan(20) // ~pitch 0.075 over a 90° arc of rc≈1.26
    // each tube: the class radius across (template radius 0.12), the axle recessed just behind the frame walls
    const s = tubes.instances![0]!.scale!
    expect(s[0] * 0.12).toBeCloseTo(0.024, 6)
    expect(s[2] * ROLLER_TEMPLATE_BODY).toBeCloseTo(ARC.width - 0.004, 6)
    for (const it of tubes.instances!) expect(it.position[1]).toBeCloseTo(-0.024, 9) // tube tops on the deck plane
  })

  it('rollers span exactly the arc [0, sweep] in the +X/−Z quadrant - no tangent overhang past the ends', () => {
    const rc = ARC.innerRadius + ARC.width / 2 // centreline radius (~1.262)
    const insts = centres(realize(ARC))
    const xs = insts.map((i) => i.x)
    const zs = insts.map((i) => i.z)
    // the first roller is the inlet (on +X, z≈0), the last is the outlet (on −Z, x≈0): a clean quarter ring
    expect(Math.max(...xs)).toBeCloseTo(rc, 2) // reaches +X at the inlet, and no further (no +X overhang)
    expect(Math.min(...zs)).toBeCloseTo(-rc, 2) // reaches −Z at the outlet, and no further (no −Z overhang)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.01) // nothing sweeps into −X on a 90° curve
    expect(Math.max(...zs)).toBeLessThanOrEqual(0.01) // nor overhangs into +Z past the inlet
    // every roller yaw = its arc angle + π/2, so the axle points radially (across flow)
    for (const it of insts) expect(Math.hypot(it.x, it.z)).toBeCloseTo(rc, 6) // all on the centreline circle
  })

  it('frame + guards end at the flush snap end, not past it', () => {
    // A butted straight's rails and guard run to its own snap end, so rails that stop at the curve's snap end
    // (endGap 0.002) meet them end to end. An overhang of ARC_END_EXT (0.25) would lie on the neighbour's
    // guard: a bare stub past the last roller at a free end, and a guard (visual and, via curvedGuardWalls,
    // collider) put back over the neighbour's openings or switched-off side.
    // Each rail is swept along its own bed edge. Swept off the centreline, the first arc ring's tilt beside so
    // short a stub has a lever arm of half the width and folds the inner rail back past the stub (33 mm on
    // this bed, 45 mm on the tight wide one), hence the extreme case.
    for (const params of [ARC, { ...ARC, innerRadius: 0.2, width: 3 }]) {
      const parts = realize(params)
      const zsOf = (r: string): number[] => role(parts, r).desc.positions.filter((_, i) => i % 3 === 2)
      expect(Math.max(...zsOf('frame'))).toBeCloseTo(0.002, 6)
      expect(Math.max(...zsOf('guard'))).toBeCloseTo(0.002, 6)
    }
    const parts = realize(ARC)
    // contrast: the rollers themselves have no overhang (a roller curve butts flush), as verified above
    expect(Math.max(...centres(parts).map((i) => i.z))).toBeLessThan(0.05)
  })

  it('roller density + span grow with the sweep - a 180° curve has ~2× the rollers of a 90° one and reaches −X', () => {
    const q = centres(realize(ARC))
    const h = centres(realize({ ...ARC, sweepDeg: 180 }))
    expect(h.length).toBeGreaterThan(q.length * 1.7)
    expect(Math.min(...h.map((i) => i.x))).toBeLessThan(-1.0) // 180°: the outlet swings around to −X
  })

  it('per-side guard toggles - innerGuard:false leaves only the outer rim guard; both off ⇒ no guard part', () => {
    const both = role(realize(ARC), 'guard').desc.positions.length
    expect(role(realize({ ...ARC, innerGuard: false }), 'guard').desc.positions.length).toBeLessThan(both)
    expect(realize({ ...ARC, innerGuard: false, outerGuard: false }).find((p) => p.finish === 'guard')).toBeUndefined()
  })

  it('guard is declared collision:"box" (the channel the host realizes as the arc guard walls)', () => {
    expect(role(realize(ARC), 'guard').collision).toBe('box')
  })

  it('is deterministic - identical params → identical roller instances', () => {
    expect(bodies(realize(ARC)).instances).toEqual(bodies(realize(ARC)).instances)
  })
})
