import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type FuncGeo } from './examplePart'
const { behavior: SPUR_ROLLER_BEHAVIOR, geometry: SPUR_ROLLER_GEO } = examplePart<FuncGeo>('oip.spur-roller-conveyor')
const { behavior: BELT_BEHAVIOR } = examplePart('oip.belt-conveyor')

// The Spur Roller Conveyor on the geometry-function tier, the SDK twin of the belt spur. A splayed
// (parallelogram) roller bed: geometry() lays a grid of spinning rollers clipped to the independent front/back
// splay faces (each end roller is shortened to the bevel through its own instance length), framed by straight
// L-rails + toggleable guards + a tail leg. The rollers are the part's own instanced banks
// (examples/parts/_shared/rollerBed.js: tubes, axle stubs, drive bands). The steel is emitted as instanced templates
// (MeshPart.instances) byte-identical to the belt conveyor's unit rail/cube/hex templates, so every conveyor in a
// scene shares those pool buckets.

const geo = SPUR_ROLLER_GEO
const realize = (params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(SPUR_ROLLER_BEHAVIOR, params as never)
  if (!parts) throw new Error('spur roller geometry() returned no parts')
  return parts
}
// the roller layout read back off the tube bank (the kit emits the tubes first, then the stubs): each tube's centre,
// yaw and body length (its axle scale × the template's rim-to-rim 2 × 0.9371), and the spin radius
const ROLLER_TEMPLATE_BODY = 2 * 0.9371
const bank = (parts: MeshPart[]): { radius: number; instances: { x: number; z: number; yaw: number; length: number }[] } => {
  const rp = parts.find((x) => x.finish === 'roller' && x.instances)
  if (!rp || !rp.spin) throw new Error('missing spur roller bank')
  return {
    radius: rp.spin.radius,
    instances: rp.instances!.map((i) => ({ x: i.position[0], z: i.position[2], yaw: 2 * Math.atan2(i.quaternion![1], i.quaternion![3]), length: i.scale![2] * ROLLER_TEMPLATE_BODY })),
  }
}
// a guard side is two parts: the wall (collision:'box', which the host AABBs into the guard collider) and the
// formed top return (no collision, since it would widen that AABB beyond the shared guard cross-section)
const walls = (parts: MeshPart[]): MeshPart[] => parts.filter((p) => p.finish === 'guard' && p.collision === 'box')
const lips = (parts: MeshPart[]): MeshPart[] => parts.filter((p) => p.finish === 'guard' && p.collision === undefined)
const SPUR = { length: 2, width: 1.524, speed: 1, angleFrontDeg: 30, angleBackDeg: 0, rollerClass: 'light' }

describe('Spur Roller Conveyor (geometry-function tier - splay-clipped spinning roller bank)', () => {
  it('is a valid function-geometry package whose behavior conveys and emits a roller bank', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.spur-roller-conveyor', name: 'Spur Roller Conveyor', params: {}, behavior: SPUR_ROLLER_BEHAVIOR, geometry: geo })).toEqual([])
    expect(geo.kind).toBe('drawn')
    expect((geo as { conveys?: boolean }).conveys).toBe(true)
    expect(SPUR_ROLLER_BEHAVIOR).toContain('geometry(')
    expect(SPUR_ROLLER_BEHAVIOR).toContain('ctx.setSurfaceVelocity(')
  })

  it('realizes a roller bank + steel frame + two guards + trestle leg + bolts (no belt bed / gap fill)', () => {
    const parts = realize(SPUR)
    expect(parts.some((p) => p.finish === 'roller' && p.instances && p.spin)).toBe(true)
    expect(parts.filter((p) => p.material === 'band')).toHaveLength(2) // the drive bands: half-rings + strands
    expect(parts.some((p) => p.finish === 'frame')).toBe(true)
    expect(walls(parts)).toHaveLength(2)
    expect(lips(parts)).toHaveLength(2)
    expect(parts.some((p) => p.finish === 'leg')).toBe(true)
    expect(parts.some((p) => p.finish === 'bolt')).toBe(true)
    expect(parts.some((p) => p.finish === 'belt' || p.finish === 'gapfill')).toBe(false) // a roller bed, not a belt
  })

  it('steel is instance banks; only the collision guards stay plain (the host AABBs their desc)', () => {
    const parts = realize(SPUR)
    for (const r of ['frame', 'leg', 'bolt'] as const) {
      const p = parts.find((x) => x.finish === r)!
      expect(p.instances!.length).toBeGreaterThan(0)
    }
    expect(parts.find((p) => p.finish === 'frame')!.instances!.length).toBe(2) // one rail piece per side
    for (const gpart of parts.filter((p) => p.finish === 'guard')) expect(gpart.instances).toBeUndefined()
  })

  it('rail/leg/bolt templates are byte-identical to the belt conveyor’s (the cross-part pooling contract)', () => {
    const spur = realize(SPUR)
    const belt = evalPartGeometry(BELT_BEHAVIOR, { segments: [[3, 0]], width: 1.0, height: 0.17 } as never) // the belt's default height = the spur's fixed frame depth
    if (!belt) throw new Error('belt geometry() returned no parts')
    for (const r of ['frame', 'leg', 'bolt'] as const) {
      expect(spur.find((p) => p.finish === r)!.desc.positions).toEqual(belt.find((p) => p.finish === r)!.desc.positions)
    }
  })

  it('templates are param-independent - byte-identical across length/width/angles (the pooling contract)', () => {
    const a = realize(SPUR)
    const b = realize({ ...SPUR, length: 5, width: 2.2, angleFrontDeg: 45, angleBackDeg: -20, rollerClass: 'heavy' })
    for (const r of ['frame', 'leg', 'bolt'] as const) {
      expect(a.find((p) => p.finish === r)!.desc.positions).toEqual(b.find((p) => p.finish === r)!.desc.positions)
    }
  })

  it('lays many rollers across the bed, each with its own clipped length', () => {
    const rb = bank(realize(SPUR))
    expect(rb.instances.length).toBeGreaterThan(8) // a grid of rollers along the length
    expect(rb.instances.every((it) => typeof it.length === 'number' && it.length! > 0)).toBe(true)
    // the widest rollers span nearly the full width (minus rail insets); the splay-clipped ones are shorter
    const lens = rb.instances.map((it) => it.length!)
    expect(Math.max(...lens)).toBeGreaterThan(SPUR.width * 0.9)
    expect(Math.min(...lens)).toBeLessThan(Math.max(...lens) - 0.2) // the end rollers are clipped short by the splay
  })

  it('the splay clips the rollers nearest the +X (front) end shortest, mid-bed rollers full width', () => {
    const rb = bank(realize(SPUR))
    const frontMost = rb.instances.reduce((a, c) => (c.x > a.x ? c : a))
    const mid = rb.instances.reduce((a, c) => (Math.abs(c.x) < Math.abs(a.x) ? c : a))
    expect(frontMost.length!).toBeLessThan(mid.length!) // the 30° front splay bevels the leading rollers
  })

  it('rollerClass sizes the rollers - heavy rollers are larger radius + coarser pitch (fewer rollers)', () => {
    const light = bank(realize({ ...SPUR, rollerClass: 'light' }))
    const heavy = bank(realize({ ...SPUR, rollerClass: 'heavy' }))
    expect(heavy.radius).toBeGreaterThan(light.radius)
    expect(heavy.instances.length).toBeLessThan(light.instances.length) // coarser pitch = fewer rollers
  })

  it('per-side guard toggles - leftGuard:false drops one guard; both off ⇒ none', () => {
    const one = realize({ ...SPUR, leftGuard: false })
    expect(walls(one)).toHaveLength(1)
    expect(lips(one)).toHaveLength(1)
    expect(realize({ ...SPUR, leftGuard: false, rightGuard: false }).filter((p) => p.finish === 'guard')).toHaveLength(0)
  })

  it('guard walls are declared collision:"static"; their top returns never collide', () => {
    const parts = realize(SPUR)
    expect(walls(parts).length + lips(parts).length).toBe(parts.filter((p) => p.finish === 'guard').length)
    expect(walls(parts).length).toBeGreaterThan(0)
  })

  it('is deterministic - identical params → identical roller layout', () => {
    expect(bank(realize(SPUR)).instances).toEqual(bank(realize(SPUR)).instances)
  })

  it('host-fed guardExtents rows extend that side’s rail instance to the given ends (merge-junction reach)', () => {
    // rails are instances of a unit template; bake position + scale.x to get the realized span. The −Z rail
    // is the same prism run backwards under a 180° yaw (never a mirror scale, which would invert its
    // shading; see the builder), so its anchor is the front end and the span runs back from there.
    const railSpan = (parts: MeshPart[], sign: 1 | -1): [number, number] => {
      const frame = parts.find((p) => p.finish === 'frame')!
      const inst = frame.instances!.find((i) => Math.sign(i.position[2]) === sign)!
      const len = inst.scale?.[0] ?? 1
      const back = inst.quaternion?.[1] ? inst.position[0] - len : inst.position[0]
      return [back, back + len]
    }
    const hw = SPUR.width / 2
    const defFront = 1 + Math.tan(Math.PI / 6) * hw // +Z rail front ends at the splayed face by default
    expect(railSpan(realize(SPUR), 1)[1]).toBeCloseTo(defFront, 2)
    const extended = realize({ ...SPUR, guardExtents: [[1, -1, 2.0]] })
    expect(railSpan(extended, 1)).toEqual([-1, 2.0]) // the +Z rail takes the host-fed ends
    expect(railSpan(extended, -1)[1]).toBeCloseTo(1 - Math.tan(Math.PI / 6) * hw, 2) // −Z keeps its splayed face
  })
})
