import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type FuncGeo } from './examplePart'
const { behavior: CURVED_CONVEYOR_BEHAVIOR, geometry: CURVED_CONVEYOR_GEO } = examplePart<FuncGeo>('oip.curved-conveyor')

// The Curved Belt Conveyor, authored on the geometry-function tier (docs/procedural-geometry.md) to match the
// built-in curved belt. It exercises arc surface velocity (C-convey's rotational field). Its geometry() lofts
// the same belt cross-sections the straight belt uses (bed + L-frame rails + side guards) along a horizontal
// arc (SDK convention: entry at local +X, sweeping toward −Z), + yawed trestle legs. Realized here
// through core/geometry/geometryEval, render's in-layer evaluator (the same parts the sim builds collision from).

const geo = CURVED_CONVEYOR_GEO
const axis = (pos: number[], a: 0 | 1 | 2): number[] => pos.filter((_, i) => i % 3 === a)
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(CURVED_CONVEYOR_BEHAVIOR, params as never)
  if (!parts) throw new Error('curved geometry() returned no parts')
  return parts
}
const role = (parts: MeshPart[], r: string): MeshPart => {
  const p = parts.find((x) => x.finish === r)
  if (!p) throw new Error(`missing curved part: ${r}`)
  return p
}
const ARC = { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 }

describe('Curved Belt Conveyor (geometry-function tier - arc surface velocity, C-convey rotational field)', () => {
  it('is a valid function-geometry package whose behavior both conveys (arc field) and emits geometry', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.curved-conveyor', name: 'Curved Belt Conveyor', params: {}, behavior: CURVED_CONVEYOR_BEHAVIOR, geometry: geo })).toEqual([])
    expect(geo.kind).toBe('drawn')
    expect((geo as { conveys?: boolean }).conveys).toBe(true)
    expect(CURVED_CONVEYOR_BEHAVIOR).toContain('geometry(')
    expect(CURVED_CONVEYOR_BEHAVIOR).toContain('ctx.setArcSurfaceVelocity(')
  })

  it('realizes the full curve as multi-material parts: fabric bed + steel frame + guards + trestle legs + bolts', () => {
    const parts = realize(ARC)
    expect(parts.map((p) => p.finish).sort()).toEqual(['belt', 'bolt', 'frame', 'guard', 'leg'])
    for (const p of parts) expect(p.desc.positions.length).toBeGreaterThan(0) // every piece has geometry
  })

  it('the conveying bed sweeps a horizontal arc from the +X inlet to the −Z outlet (SDK arc convention)', () => {
    const bed = role(realize(ARC), 'belt').desc
    const x = axis(bed.positions, 0)
    const z = axis(bed.positions, 2)
    const ro = ARC.innerRadius + ARC.width // outer rim radius (~2.02)
    // the inlet ring lies on +X (z≈0), the outlet ring on −Z (x≈0): the bed occupies the +X/−Z quadrant only
    expect(Math.max(...x)).toBeCloseTo(ro, 1) // outer rim reaches +X at the inlet
    expect(Math.min(...z)).toBeCloseTo(-ro, 1) // and −Z at the outlet
    expect(Math.min(...x)).toBeGreaterThan(-0.3) // nothing sweeps into −X (only the tail-drum nose stub)
    expect(Math.max(...z)).toBeLessThan(0.3) // nor into +Z beyond the stub
    // top conveying surface sits at up=0; the belt band + drum nose wrap below
    expect(Math.max(...axis(bed.positions, 1))).toBeCloseTo(0, 4)
    expect(Math.min(...axis(bed.positions, 1))).toBeLessThan(-0.15)
  })

  it('bakes belt u along the travel - u grows inlet→outlet, the way the arc field carries cargo', () => {
    // The invariant the render side is calibrated against: u runs with the flow, exactly like a straight
    // bed's, so the curve samples the fabric unmirrored (repeat.x = +1/period) and scrolls the offset
    // backwards, the same pair functionMesh uses everywhere. Mirroring it points the
    // ARROWS weave against the flow, and mirroring without flipping the scroll trades that for a backwards
    // scroll. If this assertion ever fails, the geometry moved under those signs and both need re-deriving.
    const bed = role(realize(ARC), 'belt').desc
    const pos = bed.positions, uvs = bed.uvs ?? []
    const rc = ARC.innerRadius + ARC.width / 2
    const at = (a: readonly number[], i: number): number => a[i] ?? NaN
    // top-surface vertex nearest the inlet (t=0, on +X) / the outlet (t=sweep, on −Z)
    const nearest = (tx: number, tz: number): number => {
      let best = Infinity, hit = -1
      for (let i = 0; i < pos.length / 3; i++) {
        if (Math.abs(at(pos, i * 3 + 1)) > 1e-6) continue // conveying surface only (up=0)
        const d = Math.hypot(at(pos, i * 3) - tx, at(pos, i * 3 + 2) - tz)
        if (d < best) { best = d; hit = i }
      }
      return hit
    }
    const inlet = nearest(rc, 0)
    const outlet = nearest(0, -rc)
    expect(at(uvs, outlet * 2)).toBeGreaterThan(at(uvs, inlet * 2)) // u grows inlet → outlet
    // …and that IS the carry direction: the behavior's arc field (omega = speed/rc about the part origin)
    // expands to vx = omega·(z−cz), vz = −omega·(x−cx), so at the +X inlet a positive speed drives −Z - toward
    // the outlet. Same sense as the flow arrow, which samples increasing sweep angle (flowArrow.ts).
    const omega = ARC.speed / rc
    expect(omega * at(pos, inlet * 3 + 2)).toBeCloseTo(0, 2) // no +X/−X drift at the inlet…
    expect(-omega * at(pos, inlet * 3)).toBeLessThan(-0.1) // …just −Z carry, the direction the outlet lies in
  })

  it('reflows with innerRadius + width - the outer rim grows with both (rc = innerRadius + width/2)', () => {
    const outerX = (p: Record<string, unknown>): number => Math.max(...axis(role(realize(p), 'belt').desc.positions, 0))
    expect(outerX({ ...ARC, innerRadius: 1.5 })).toBeGreaterThan(outerX(ARC) + 0.9) // +1 m inner radius pushes the rim out
    expect(outerX({ ...ARC, width: 2.5 })).toBeGreaterThan(outerX(ARC) + 0.9) // a wider belt widens the ring
  })

  it('sweep angle drives how far the arc turns - a 180° curve reaches −X, a 90° one does not', () => {
    const quarter = axis(role(realize(ARC), 'belt').desc.positions, 0)
    const half = axis(role(realize({ ...ARC, sweepDeg: 180 }), 'belt').desc.positions, 0)
    expect(Math.min(...quarter)).toBeGreaterThan(-0.3) // 90°: the outlet is at −Z, still near x=0
    expect(Math.min(...half)).toBeLessThan(-1.5) // 180°: the outlet swings all the way around to −X
  })

  it('per-side guard toggles - innerGuard:false leaves only the outer rim guard', () => {
    const both = role(realize(ARC), 'guard').desc.positions.length
    const outerOnly = role(realize({ ...ARC, innerGuard: false }), 'guard').desc.positions.length
    expect(outerOnly).toBeLessThan(both) // dropping the inner rim guard removes its ribbon
    expect(realize({ ...ARC, innerGuard: false, outerGuard: false }).find((p) => p.finish === 'guard')).toBeUndefined()
  })

  it('guard is declared collision:"box" (the channel the host realizes as static guard walls)', () => {
    expect(role(realize(ARC), 'guard').collision).toBe('box')
  })

  it('is deterministic - identical params → byte-identical bed positions', () => {
    expect(role(realize(ARC), 'belt').desc.positions).toEqual(role(realize(ARC), 'belt').desc.positions)
  })
})
