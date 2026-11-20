import { describe, expect, it } from 'vitest'
import { arrayInstanceDeltas, qApply, resolvedGrabZone, rigWorldPoses } from '../../core/rig/rigPose'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { robotForwardKinematics } from './robotKinematics'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: SIX_AXIS_RIG, materials: SIX_AXIS_MATERIALS, assets: SIX_AXIS_ASSETS, behavior: SIX_AXIS_BEHAVIOR } = examplePart<RigGeo>('oip.six-axis-robot')

// The Six-Axis robot, authored as a custom part (examples/parts/six-axis-robot), must place its gripper
// at exactly the same spot the built-in robot does for the same joint angles. Otherwise the "convergence"
// (a first-party part rebuilt on the public SDK) would be only cosmetic. This pins the rig FK (frame links +
// quaternion rest rotations composed by core/rig/rigPose) to robotForwardKinematics, the built-in's source of
// truth. The rig comes from the committed rig.json (built from examples/parts/six-axis-robot/part.js); the GLB/
// textures it names are irrelevant to kinematics, so they're not needed here.

const geo = SIX_AXIS_RIG

// the EOAT, as the behavior's geometry() draws it, and the box round every submesh of one material
const P = (over: Record<string, number | boolean> = {}): Record<string, number | boolean> => ({
  toolSizeX: 0.5, toolSizeZ: 0.5, cupPitchX: 0.1, cupPitchZ: 0.1, cupMarginX: 0.05, cupMarginZ: 0.05, cupsEnabled: true, ...over,
})
const eoat = (p: Record<string, number | boolean>): MeshPart[] => evalPartGeometry(SIX_AXIS_BEHAVIOR, p) ?? []
/** the suction-cup bed: the instanced submesh */
const cupBed = (p: Record<string, number | boolean>): MeshPart | undefined => eoat(p).find((m) => m.material === 'eoatCup' && m.instances !== undefined)
const box = (parts: readonly MeshPart[], material: string): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const m of parts) {
    if (m.material !== material) continue
    const pos = m.desc.positions
    for (let i = 0; i < pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, pos[i + a]!)
        max[a] = Math.max(max[a]!, pos[i + a]!)
      }
    }
  }
  return { min, max }
}
const D2R = Math.PI / 180
const valuesOf = (deg: number[]): Record<string, number> => ({
  j1: deg[0]! * D2R, j2: deg[1]! * D2R, j3: deg[2]! * D2R, j4: deg[3]! * D2R, j5: deg[4]! * D2R, j6: deg[5]! * D2R,
})

const POSES: [string, number[]][] = [
  ['zero', [0, 0, 0, 0, 0, 0]],
  ['home', [0, -45, 90, 25, 75, 0]],
  ['pick', [0, -15, 55, 0, 80, 0]],
  ['place', [110, -15, 55, 0, 80, 0]],
  ['mixed', [-90, 30, -40, 120, -60, 200]],
]

describe('Six-Axis custom-part rig - kinematic parity with the built-in robot', () => {
  it('is a structurally valid package (rig + a dummy behavior + dummy assets/materials)', () => {
    const pkg = {
      format: PACKAGE_FORMAT, id: 'oip.six-axis-robot', name: 'Six-Axis Robot', params: {},
      behavior: 'definePart({ joints:["j1","j2","j3","j4","j5","j6"], grippers:["gripper"], step(){} })',
      geometry: geo,
      // the committed url-assets stand in as embedded blobs (same ids - the refs are what's validated)
      assets: SIX_AXIS_ASSETS.map((a) => ({ id: a.id, mime: a.mime, data: 'AAAA' })),
      materials: SIX_AXIS_MATERIALS,
    }
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it.each(POSES)('gripper world position matches robotForwardKinematics - %s pose', (_name, deg) => {
    const grip = rigWorldPoses(geo, valuesOf(deg)).get('gripper')!
    const ref = robotForwardKinematics(deg)
    expect(grip.pos[0]).toBeCloseTo(ref.gripper.x, 4)
    expect(grip.pos[1]).toBeCloseTo(ref.gripper.y, 4)
    expect(grip.pos[2]).toBeCloseTo(ref.gripper.z, 4)
  })

  // Grip + indicator surface: the pickup volume is the plate itself (the zone below; a sphere beside it
  // would never be read), and the at-a-glance indicator is a vacuum-status LED on the plate (a real vacuum
  // switch's lamp), leaving the cups physical: they compress off that LED's signal (squash.lamp) instead
  // of glowing.
  it('declares the pickup volume + a vacuum-status LED driving cup compression (not glowing cups)', () => {
    const gripper = geo.links.find((l) => l.name === 'gripper')!
    expect([gripper.grip?.radius, gripper.grip?.radiusParams]).toEqual([undefined, undefined])
    // C-multigrab: the pickup volume, whose footprint is the plate 1:1 - that is what makes "everything under the
    // plate, nothing beside it" true. It also decides how many cases the tool takes, with no mode to set:
    // sized to the layer it lifts the whole formed layer in one grip, sized to one case it picks one.
    expect(resolvedGrabZone(gripper, { toolSizeX: 1.2, toolSizeZ: 1.0 })?.half).toEqual([0.6, 0.35, 0.5])
    expect(resolvedGrabZone(gripper, { toolSizeX: 0.5, toolSizeZ: 0.5 })?.half).toEqual([0.25, 0.35, 0.25])
    // the vacuum indicator is a green LED on the tool, driven by the grip state. It is drawn, not a box link,
    // so it is no collider riding the arm (a box link would be a 35 mm solid cube cargo could strike)
    const led = eoat(P()).find((m) => m.lamps?.[0]?.name === 'vacuumLamp')!
    const ledLit = led.lamps![0]!.emissive
    expect(ledLit[1]).toBeGreaterThan(ledLit[0]) // green-dominant
    expect(geo.links.some((l) => l.name === 'vacuumLamp')).toBe(false)
    // the host's robot controller lights the lamp while its gripper holds (core/robot/robotController.ts)
    expect(SIX_AXIS_BEHAVIOR).toContain("robot: { gripper: 'gripper', lamp: 'vacuumLamp', tool: 'eoat'")
    // the cups do not glow - they physically compress 15% along their axis, off the LED's signal
    const cups = cupBed(P())!
    expect(cups.lamps).toBeUndefined()
    expect(cups.squash).toEqual({ amount: 0.15, lamp: 'vacuumLamp' })
  })

  // The LED sits at the +X/+Z plate corner, 0.07 m in, so a resized tool tracks it instead of stranding it off the
  // enlarged plate: seated on the back face, inside the frame and clear of the adapter at every size.
  it.each([[0.5, 0.5], [1.5, 0.75], [3, 3]] as const)('seats the vacuum LED on the plate, inside the frame - %s x %s m', (sx, sz) => {
    const parts = eoat(P({ toolSizeX: sx, toolSizeZ: sz }))
    const bezel = box(parts, 'eoatPlastic')
    expect(bezel.min[1]).toBeCloseTo(-0.0517, 6) // on the back face
    expect((bezel.min[0]! + bezel.max[0]!) / 2).toBeCloseTo(sx / 2 - 0.07, 3) // tracks the corner
    expect((bezel.min[2]! + bezel.max[2]!) / 2).toBeCloseTo(sz / 2 - 0.07, 3)
    expect(bezel.max[0]).toBeLessThan(sx / 2 - 0.012) // short of the rails' inner faces
    expect(bezel.max[2]).toBeLessThan(sz / 2 - 0.012)
    expect(bezel.min[0]! > 0.096 || bezel.min[2]! > 0.159).toBe(true) // clear of the 192 x 318 mm adapter plate
    // the lens sits in the bezel
    const lens = box(parts, 'eoatLens')
    expect(lens.min[1]).toBeCloseTo(bezel.max[1]!, 6)
    expect(lens.max[0]! - lens.min[0]!).toBeLessThan(bezel.max[0]! - bezel.min[0]!)
  })

  it('places every linkage mesh under a driven pivot (no orphaned links)', () => {
    const names = new Set(geo.links.map((l) => l.name))
    for (const l of geo.links) if (l.parent) expect(names.has(l.parent)).toBe(true)
    // base + 5 linkages + 2 hydraulics + tool plate; the EOAT is drawn by the app (core/robot/robotTools.ts), not
    // carried as model links
    expect(geo.links.filter((l) => l.shape.kind === 'mesh')).toHaveLength(9)
    // six arm joints, plus the clamp gripper's finger and the finger that follows it
    expect(geo.joints.map((j) => j.name)).toEqual(['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'grip', 'grip2'])
    expect(geo.joints.filter((j) => !j.cosmetic && !j.mimic)).toHaveLength(6)
  })

  // The EOAT (mounted flipped 180°-about-Z at the tool pivot + 0.009 on the robot) is the behavior's geometry(),
  // built at the size the params ask for: the plate and frame grow with toolSizeX/Z while the rail section and the
  // caps keep their size, the cup grid regenerates, and the vacuum pickup grows with the plate.
  describe('EOAT resizes (toolSizeX/Z, cup grid, cupsEnabled)', () => {
    const link = (name: string) => geo.links.find((l) => l.name === name)!

    it('mounts the tool flipped 180° about Z at the tool pivot + (0, 0.009, 0) - the EOAT mount transform', () => {
      const eoatLink = link('eoat')
      expect(eoatLink.parent).toBe('tool')
      expect(eoatLink.offset).toEqual([0, 0.009, 0])
      expect(eoatLink.quat).toEqual([0, 0, 1, 0])
      // every piece of the tool rides that link, and none of it needs a model or a texture
      for (const m of eoat(P())) expect(m.link).toBe('eoat')
      expect(SIX_AXIS_ASSETS.map((a) => a.id)).toEqual(['glb', 'albedo', 'orm'])
    })

    it('declares the resize gizmo (rigSize handles riding the eoat link at EOAT_FRAME_Y)', () => {
      // the robot gizmo's orange tool-size drag dots - declared on the params, drawn by the rig gizmo
      expect(SIX_AXIS_BEHAVIOR).toContain("handle: { kind: 'rigSize', link: 'eoat', axis: 'x', frameY: -0.075 }")
      expect(SIX_AXIS_BEHAVIOR).toContain("handle: { kind: 'rigSize', link: 'eoat', axis: 'z', frameY: -0.075 }")
    })

    it("frames the plate at its size: rails 3 mm outside ±size/2, centred on the handles' frameY", () => {
      for (const [sx, sz] of [[0.5, 0.5], [1.5, 0.75], [3, 2.5]] as const) {
        const parts = eoat(P({ toolSizeX: sx, toolSizeZ: sz }))
        const rails = box(parts, 'eoatRail')
        expect(rails.min[0]).toBeCloseTo(-sx / 2 - 0.003, 6)
        expect(rails.max[0]).toBeCloseTo(sx / 2 + 0.003, 6)
        expect(rails.min[2]).toBeCloseTo(-sz / 2 - 0.003, 6)
        expect(rails.max[2]).toBeCloseTo(sz / 2 + 0.003, 6)
        expect((rails.min[1]! + rails.max[1]!) / 2).toBeCloseTo(-0.075, 6)
        // the plate and its corner caps (2 mm proud of the rails), and the plate's back face the LED sits on
        const paint = box(parts, 'eoatPaint')
        expect(paint.max[0]).toBeCloseTo(sx / 2 + 0.005, 6)
        expect(paint.max[2]).toBeCloseTo(sz / 2 + 0.005, 6)
      }
    })

    it('keeps the rail section at its own size, however big the plate (no stretching)', () => {
      const small = eoat(P()).find((m) => m.material === 'eoatRail')!
      const big = eoat(P({ toolSizeX: 3, toolSizeZ: 3 })).find((m) => m.material === 'eoatRail')!
      // the same extrusions, longer: the vertex count is the section's, not the length's
      expect(big.desc.positions.length).toBe(small.desc.positions.length)
      const b = box([big], 'eoatRail')
      expect(b.max[1]! - b.min[1]!).toBeCloseTo(0.059, 6)
    })

    it('regenerates the cup grid by the host grid rule: floor(usable/pitch)+1 per axis, edge-to-edge', () => {
      const cupsAt = (p: Record<string, number | boolean>): number[][] => (cupBed(p)?.instances ?? []).map((i) => [...i.position])
      // default: usable = 0.5 − 2·0.05 = 0.4 → 5×5 cups from −0.2 to +0.2, mounted under the plate
      const cups = cupsAt(P())
      expect(cups).toHaveLength(25)
      const xs = [...new Set(cups.map((d) => d[0]!.toFixed(6)))].map(Number).sort((a, b) => a - b)
      expect(xs).toEqual([-0.2, -0.1, 0, 0.1, 0.2])
      for (const c of cups) expect(c[1]).toBeCloseTo(-0.1035, 10)
      // the same cells the rig's `grid` array lays, its 256-cup thinning included, so a bed reads the same whichever drew it
      const grid = {
        x: { sizeParam: 'toolSizeX', pitchParam: 'cupPitchX', marginParam: 'cupMarginX' },
        z: { sizeParam: 'toolSizeZ', pitchParam: 'cupPitchZ', marginParam: 'cupMarginZ' },
      }
      const key = (v: number[]): string => v.map((n) => n.toFixed(6)).join(',')
      const cases: Record<string, number>[] = [{}, { toolSizeX: 1.9 }, { toolSizeX: 2.2, toolSizeZ: 1.3, cupPitchX: 0.07, cupMarginZ: 0.12 }, { cupMarginX: 0.3 }, { toolSizeX: 3, toolSizeZ: 3 }]
      for (const over of cases) {
        const host = arrayInstanceDeltas({ grid }, P(over)).map((d) => [d[0], d[2]])
        const drawn = cupsAt(P(over)).map((c) => [c[0]!, c[2]!])
        expect(drawn.length).toBe(host.length)
        expect(new Set(drawn.map(key))).toEqual(new Set(host.map(key)))
      }
      // cupsEnabled=false → no cups
      expect(cupsAt(P({ cupsEnabled: false }))).toHaveLength(0)
    })
  })

  // The two hydraulic struts are a two-point look-at (C-aim):
  // each anchor aims its +Z at the other so the struts stay connected as J1/J2 bend the arm. The bug this
  // fixes had them frozen at a static rest quat, detaching the instant the arm moved.
  describe('hydraulic struts stay connected as the arm bends', () => {
    const fwd = (q: number[]): number[] => qApply([q[0]!, q[1]!, q[2]!, q[3]!], [0, 0, 1]) // world +Z (aim dir)
    const dirTo = (from: number[], to: number[]): number[] => {
      const v = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!]
      const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
      return [v[0]! / l, v[1]! / l, v[2]! / l]
    }
    const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

    it('declares the two anchors as mutual aim targets', () => {
      expect(geo.links.find((l) => l.name === 'hydBaseAnchor')?.aim?.target).toBe('hydRodAnchor')
      expect(geo.links.find((l) => l.name === 'hydRodAnchor')?.aim?.target).toBe('hydBaseAnchor')
    })

    it.each(POSES)('each anchor points its +Z at the other - %s pose', (_name, deg) => {
      const w = rigWorldPoses(geo, valuesOf(deg))
      const base = w.get('hydBaseAnchor')!
      const rod = w.get('hydRodAnchor')!
      expect(dot(fwd(base.quat), dirTo(base.pos, rod.pos))).toBeCloseTo(1, 5)
      expect(dot(fwd(rod.quat), dirTo(rod.pos, base.pos))).toBeCloseTo(1, 5)
      // the identity-child hydraulic meshes inherit the aimed orientation exactly
      expect(w.get('hyd1')!.quat).toEqual(base.quat)
      expect(w.get('hyd2')!.quat).toEqual(rod.quat)
    })

    it('re-aims as the arm moves (not frozen at the static rest quat)', () => {
      const a = rigWorldPoses(geo, valuesOf([0, 0, 0, 0, 0, 0])).get('hydRodAnchor')!.quat
      const b = rigWorldPoses(geo, valuesOf([0, -120, 0, 0, 0, 0])).get('hydRodAnchor')!.quat
      const cos = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!)
      expect(cos).toBeLessThan(0.999) // a real orientation change between two distinct poses
    })
  })
})
