import { describe, expect, it } from 'vitest'
import { linkHalfExtents, rigWorldPoses } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { instantiatePartScript } from '../../core/parts/partScript'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type RigGeo } from './examplePart'
const { assets: BLADE_STOP_ASSETS, behavior: BLADE_STOP_BEHAVIOR, geometry: BLADE_STOP_RIG, materials: BLADE_STOP_MATS, head: BLADE_STOP_HEAD } = examplePart<RigGeo>('oip.blade-stop')

// The Blade Stop is a small rig whose visuals come from procedural geometry(). A `bladeRoot` frame on a
// prismatic `raise` joint carries the blade, its end posts, clamps, guide rods and bolts. The housing (pinned
// under the belt surface) and the pneumatic cylinders sit on the static root, the cylinders at the blade's rest
// frame, so the corner guide rods sit sheathed inside the never-moving cylinders and slide up through them on
// raise. The shapes are BladeStop.glb's, measured off it in native units and scaled by S = 0.45;
// a 0.06 raiseHeight reproduces the built-in's fixed stroke (0.24 native · S = 0.108 m) the rod length is
// authored for. Width reshapes the built-in way: the middle of every run is built to cornerZ = width/2 − 0.09
// and the corner hardware slides out with it, floored at the built-in's 0.01-native clamp. Collision is two
// hidden boxes (render nothing, sim body still built).

// the retired built-in's constants (its render/parts/bladeStop.ts, sim/world.ts and core BLADE_THICKNESS are gone,
// so these are the only copy): pinned values the SDK rig is asserted against
const S = 0.45 // MODEL_SCALE
const NATIVE_TOP = 0.2494
const NATIVE_BLADE_X = 0.1036
const LOWERED_TOP = -0.05
const HOUSING_TOP = -0.12
const BLADE_BOTTOM = -0.15 // sim raised-box bottom
const BLADE_THICKNESS = 0.03
// The fixed blade stroke: 0.24 native · S = 0.108 m - the travel the rod length is authored for
// (rest sheath depth ≈ 0.119 m, so a full raise leaves a rod tip ~0.011 m inside its cylinder)
const BLADE_STROKE = 0.108
const cornerZ = (width: number): number => Math.max(width / 2 - 0.2 * S, 0.01 * S)

const geo = BLADE_STOP_RIG
const byName = (n: string) => geo.links.find((l) => l.name === n)!
const DEF = { width: 1.524, raiseHeight: 0.06, airPressureHeight: 0.07 }
const realize = (params: Record<string, unknown> = {}): MeshPart[] => {
  const parts = evalPartGeometry(BLADE_STOP_BEHAVIOR, { ...DEF, ...params } as never)
  if (!parts) throw new Error('blade-stop geometry() returned no parts')
  return parts
}
const part = (parts: MeshPart[], material: string, link?: string): MeshPart => {
  const p = parts.find((x) => x.material === material && x.link === link)
  if (!p) throw new Error(`missing blade-stop submesh material=${material} link=${link}`)
  return p
}
type V3 = [number, number, number]
const verts = (p: MeshPart): V3[] => {
  const out: V3[] = []
  const a = p.desc.positions
  for (let i = 0; i + 2 < a.length; i += 3) out.push([a[i]!, a[i + 1]!, a[i + 2]!])
  return out
}
const range = (vs: V3[], k: 0 | 1 | 2): [number, number] => [Math.min(...vs.map((v) => v[k])), Math.max(...vs.map((v) => v[k]))]
// the cylinder cap + guide rod sit around native z ±1.0995; past the housing's own vertices (which are only at
// its ends, native |z| ≥ 1.148), so a band there picks out the corner hardware alone
const nearRod = (vs: V3[], width: number): V3[] => {
  const cz = cornerZ(width)
  return vs.filter((v) => Math.abs(v[2]) > cz + 0.05 * S && Math.abs(v[2]) < cz + 0.14 * S)
}

describe('Blade Stop custom-part rig - procedural geometry at built-in parity', () => {
  it('is a structurally valid package: a jointed frame + two hidden colliders, dressed by geometry(), no model asset', () => {
    expect(BLADE_STOP_ASSETS).toEqual([])
    expect(geo.links.map((l) => l.name).sort()).toEqual(['baseCollider', 'bladeRoot', 'collider'])
    expect(BLADE_STOP_MATS.map((m) => m.id).sort()).toEqual(['belt', 'blade', 'plate', 'steel'])
    expect(
      validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.blade-stop', name: 'Blade Stop', params: {}, behavior: BLADE_STOP_BEHAVIOR, geometry: geo, materials: BLADE_STOP_MATS }),
    ).toEqual([])
  })

  it('the blade hardware rides the raise joint; the housing + air cylinders stay on the static root', () => {
    expect(geo.joints).toHaveLength(1)
    // travel covers raiseHeight max 0.5 from the deepest mount (airPressureHeight 0 → rest top −0.12)
    expect(geo.joints[0]!).toMatchObject({ name: 'raise', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.62 })
    const parts = realize()
    expect(parts.filter((p) => p.link === 'bladeRoot').map((p) => p.material).sort()).toEqual(['blade', 'plate', 'steel'])
    expect(parts.filter((p) => p.link === undefined).map((p) => p.material).sort()).toEqual(['belt', 'plate', 'steel'])
    const up = rigWorldPoses(geo, { raise: 0.2 })
    const rest = rigWorldPoses(geo, { raise: 0 })
    expect(up.get('bladeRoot')!.pos[1]).toBeCloseTo(rest.get('bladeRoot')!.pos[1] + 0.2, 6)
    expect(byName('baseCollider').parent).toBeUndefined()
  })

  it('the corner guide rods stay sheathed in the static cylinders through the default stroke', () => {
    const parts = realize()
    const rodBottom = range(verts(part(parts, 'plate', 'bladeRoot')), 1)[0]
    const cylTop = range(nearRod(verts(part(parts, 'steel')), DEF.width), 1)[1]
    // the measured native pair: rod bottom −0.3271, cylinder top −0.0632
    expect(cylTop - rodBottom).toBeCloseTo(S * (0.3271 - 0.0632), 6)
    // default raiseHeight 0.06 → full-raise joint value 0.11, just past the full stroke with ~9 mm still sheathed
    for (const raise of [0, BLADE_STROKE / 2, BLADE_STROKE, 0.06 - LOWERED_TOP]) {
      const lift = rigWorldPoses(geo, { raise }).get('bladeRoot')!.pos[1]
      expect(cylTop - (rodBottom + lift)).toBeGreaterThan(0.008) // rod tip stays inside its cylinder
    }
  })

  it('a longer stroke lengthens the rods + cylinders so the blade never leaves them (the demo row stop raises 0.15)', () => {
    const sheathAtFullRaise = (params: { raiseHeight: number; airPressureHeight?: number }) => {
      const apH = params.airPressureHeight ?? DEF.airPressureHeight
      const parts = realize(params)
      const rodBottom = range(verts(part(parts, 'plate', 'bladeRoot')), 1)[0]
      const cyl = range(nearRod(verts(part(parts, 'steel')), DEF.width), 1)
      const travel = params.raiseHeight - (apH + HOUSING_TOP)
      const lift = rigWorldPoses(geo, { raise: travel }, undefined, 1, { airPressureHeight: apH }).get('bladeRoot')!.pos[1]
      const cylBottom = range(nearRod(verts(part(parts, 'belt')), DEF.width), 1)[0]
      const slabTop = HOUSING_TOP - S * (NATIVE_TOP + 0.6124) // the housing's floor slab, native top −0.6124
      return { sheath: cyl[1] - (rodBottom + lift), clearance: cylBottom - slabTop }
    }
    // up to ~0.24 at the default mount: past that the extra travel outgrows the room above the floor slab
    for (const raiseHeight of [0.06, 0.1, 0.15, 0.2, 0.24]) {
      const { sheath, clearance } = sheathAtFullRaise({ raiseHeight })
      expect(sheath).toBeGreaterThan(0.008) // same ~9 mm as the default stroke, however long the stroke
      expect(clearance).toBeGreaterThan(0.009) // the cylinder stops short of the floor slab
    }
    // the default stroke is the model's own geometry, untouched
    expect(realize({ raiseHeight: 0.06 })).toEqual(realize())
    // past what the housing can hold the cylinder stops at the slab rather than poking through it
    expect(sheathAtFullRaise({ raiseHeight: 0.5 }).clearance).toBeGreaterThan(0.009)
  })

  it('airPressureHeight re-mounts pistons + blade + rods together above the housing (air_pressure_height)', () => {
    // raising the mount 0.03 above the 0.07 default shifts the whole moving assembly; the housing stays put
    // and the rod↔cylinder sheath depth is untouched (they move together)
    const rest = rigWorldPoses(geo, {}, undefined, 1, { airPressureHeight: 0.07 })
    const up = rigWorldPoses(geo, {}, undefined, 1, { airPressureHeight: 0.1 })
    for (const n of ['bladeRoot', 'collider']) expect(up.get(n)!.pos[1]).toBeCloseTo(rest.get(n)!.pos[1] + 0.03, 6)
    expect(rigWorldPoses(geo, {}).get('bladeRoot')!.pos[1]).toBeCloseTo(rest.get('bladeRoot')!.pos[1], 6)
    const lo = realize({ airPressureHeight: 0.07 })
    const hi = realize({ airPressureHeight: 0.1 })
    const cyl = (p: MeshPart[]) => range(nearRod(verts(part(p, 'steel')), DEF.width), 1)
    expect(cyl(hi)[1]).toBeCloseTo(cyl(lo)[1] + 0.03, 6)
    // the housing does not move: its slab (the only steel that low; the cylinders bottom out ~0.2 m above it)
    const slab = (p: MeshPart[]) => verts(part(p, 'steel')).filter((v) => v[1] < -0.45)
    expect(slab(lo).length).toBeGreaterThan(0)
    expect(slab(hi)).toEqual(slab(lo))
    // and the blade's own geometry is mount-independent: the link carries the shift
    expect(part(hi, 'blade', 'bladeRoot').desc.positions).toEqual(part(lo, 'blade', 'bladeRoot').desc.positions)
  })

  it('sits where the built-in applyModel put it (blade centred on x, housing top pinned, blade top parked below the belt)', () => {
    const parts = realize()
    const blade = verts(part(parts, 'blade', 'bladeRoot'))
    const [bx0, bx1] = range(blade, 0)
    expect((bx0 + bx1) / 2).toBeCloseTo(0, 3) // the model's blade centreline (native x ≈ 0.1036) lands on x = 0
    expect(bx1 - bx0).toBeCloseTo(S * (0.1288 - 0.0786), 6)
    // the housing top (the black strip) is the model's top pinned at HOUSING_TOP
    expect(range(verts(part(parts, 'belt')), 1)[1]).toBeCloseTo(HOUSING_TOP, 6)
    // the blade's rest frame puts the model top at LOWERED_TOP; the blade itself stops 0.0033 native under it
    const bladeTop = range(blade, 1)[1] + rigWorldPoses(geo, {}).get('bladeRoot')!.pos[1]
    expect(bladeTop).toBeCloseTo(LOWERED_TOP - S * (NATIVE_TOP - 0.2461), 6)
    expect(-NATIVE_BLADE_X * S).toBeCloseTo(range(verts(part(parts, 'steel')), 0)[0], 6) // housing back face at the old model origin
  })

  it('reshapes to the lane width the built-in way (runs span to cornerZ, the corner hardware slides with it)', () => {
    for (const w of [0.5, 1.2, 1.524, 0.1]) {
      const parts = realize({ width: w })
      const cz = cornerZ(w)
      // housing: the run to ±cornerZ plus the rigid 0.2-native corner → exactly the lane at any width it can span
      expect(range(verts(part(parts, 'steel')), 2)).toEqual([expect.closeTo(-(cz + 0.2 * S), 6), expect.closeTo(cz + 0.2 * S, 6)])
      // blade: the run plus the 0.0843-native corner section
      expect(range(verts(part(parts, 'blade', 'bladeRoot')), 2)[1]).toBeCloseTo(cz + 0.0843 * S, 6)
      // the guide rod is rigid corner hardware: it keeps its native offset from cornerZ
      const rod = verts(part(parts, 'plate', 'bladeRoot')).filter((v) => v[1] < -0.2)
      const rz = range(rod.filter((v) => v[2] > 0), 2)
      expect((rz[0] + rz[1]) / 2).toBeCloseTo(cz + 0.09945 * S, 6)
    }
    // the built-in clamp: a lane narrower than the corners keeps them from crossing the centreline
    expect(cornerZ(0.1)).toBeCloseTo(0.01 * S, 9)
    expect(range(verts(part(realize({ width: 0.1 }), 'steel')), 2)[1]).toBeCloseTo(0.01 * S + 0.2 * S, 6)
  })

  it('collision mirrors the built-in sim boxes (blade box top −0.05 rest / raiseHeight raised, static base box)', () => {
    const params = { width: 0.5, raiseHeight: 0.15 }
    // geometry() is render-only; exactly the two hidden boxes carry collision (built-in: two addStaticBox)
    for (const p of realize(params)) expect(p.collision).toBeUndefined()
    const collider = byName('collider')
    const base = byName('baseCollider')
    expect(collider.hidden).toBe(true)
    expect(base.hidden).toBe(true)
    // blade box: BLADE_THICKNESS × (raiseHeight − BLADE_BOTTOM) × width, top at LOWERED_TOP when lowered…
    const he = linkHalfExtents(collider, params)
    expect(he[0]).toBeCloseTo(BLADE_THICKNESS / 2, 6)
    expect(he[1]).toBeCloseTo((params.raiseHeight - BLADE_BOTTOM) / 2, 6)
    expect(he[2]).toBeCloseTo(params.width / 2, 6)
    const restY = rigWorldPoses(geo, { raise: 0 }, undefined, 1, params).get('collider')!.pos[1]
    expect(restY + he[1]).toBeCloseTo(LOWERED_TOP, 6)
    // …and spanning exactly [BLADE_BOTTOM, raiseHeight] when raised (the built-in active box)
    const raisedY = rigWorldPoses(geo, { raise: params.raiseHeight - LOWERED_TOP }, undefined, 1, params).get('collider')!.pos[1]
    expect(raisedY + he[1]).toBeCloseTo(params.raiseHeight, 6)
    expect(raisedY - he[1]).toBeCloseTo(BLADE_BOTTOM, 6)
    // base box: the built-in addStaticBox(0.08, 0.05, width/2, y −0.1)
    expect(linkHalfExtents(base, params)).toEqual([0.08, 0.05, params.width / 2])
    expect(rigWorldPoses(geo, {}, undefined, 1, params).get('baseCollider')!.pos[1]).toBeCloseTo(-0.1, 6)
    expect(base.parent).toBeUndefined() // static: it never moves with the joint
  })

  it('is deterministic - identical params give byte-identical geometry', () => {
    expect(realize({ width: 0.8 })).toEqual(realize({ width: 0.8 }))
  })

  it('matches the built-in param spec and raises to an absolute blade top (raiseHeight − LOWERED_TOP travel)', () => {
    expect(BLADE_STOP_BEHAVIOR).toContain('interactive: true')
    expect(BLADE_STOP_BEHAVIOR).toContain('ctx.used()')
    expect(BLADE_STOP_BEHAVIOR).toContain("joints: ['raise']")
    expect(BLADE_STOP_BEHAVIOR).toContain('(ctx.params.raiseHeight - restTop) * raised')
    const params = instantiatePartScript(BLADE_STOP_BEHAVIOR).def!.params!
    // built-in range (0.02..0.5 step 0.01); the default is a real stop's 0.04 rise
    expect(params.raiseHeight).toMatchObject({ type: 'number', default: 0.04, min: 0.02, max: 0.5, step: 0.01 })
    // air_pressure_height: assembly mount height; 0.07 default = the built-in −0.05 rest top
    expect(params.airPressureHeight).toMatchObject({ type: 'number', default: 0.07, min: 0, max: 0.12, step: 0.005 })
    expect(BLADE_STOP_BEHAVIOR).toContain('const restTop = ctx.params.airPressureHeight + HOUSING_TOP')
    // the default width (scale.z 0.448 · SNAP_NATIVE_Z_WIDTH = the full 1.524 m belt); the max must be above
    // it. Range 0.1..2 keeps the narrow-lane clamp reachable.
    expect(params.width).toMatchObject({ type: 'number', default: 1.524, min: 0.1, max: 2, step: 0.05 })
    // the declarative track block: the SDK part seats onto a roller bed like the built-in blade_stop
    // (blade_anchor auto_fit_target_width), auto-fitting `width` to the host's usable bed width
    expect(BLADE_STOP_HEAD.snap?.track).toEqual({ fitWidthParam: 'width' })
  })
})
