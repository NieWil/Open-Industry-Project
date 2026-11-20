import { describe, expect, it } from 'vitest'
import { rigWorldPoses } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { PALLET_STANDARDS, fittingSpreads } from '../../core/pallet'
import { instantiatePartScript } from '../../core/parts/partScript'
import { AGV_LOAD_AHEAD, AGV_TINE_HEEL, AGV_TINE_LENGTH, AGV_TINE_OFFSET, AGV_TINE_RISE, AGV_TINE_THICKNESS, AGV_TINE_WIDTH } from '../../core/types'
import { examplePart, type RigGeo } from './examplePart'
const { geometry: AGV_RIG, assets: AGV_ASSETS, behavior: AGV_BEHAVIOR } = examplePart<RigGeo>('oip.agv')

// The fork-lift AGV, authored as a custom part (examples/parts/agv), is the 3rd converged manipulator and the
// test of C-drive (root motion): a mobile chassis that navigates whole-body waypoints + a prismatic fork lift +
// a grab point. It renders from the real AGV.glb assembled like the built-in renderer (render/parts/agv.ts):
// per-node mesh links, the forks riding the 'lift' joint, the mast piston + four rolling wheels on cosmetic
// self-driven joints. This pins the rig's kinematics: the gripper rides up with 'lift' at the built-in's carry
// point (GRIPPER_OFFSET y 0.55, 1.25 toward the forks; reach AGV_PICKUP_REACH), the grab point is a body-less
// frame at the +X nose (the drive-forward direction - the one deliberate divergence from the built-in's
// forks-trail frame), and the beacon is emissive. The 180°-flipped GLB frame maps native (x, z) → part (−z, x).

const geo = AGV_RIG
// gripper = carriage[0.75, 0.1, 0] + lift(Y) → gripper[+0.5, +0.45], so world y = 0.55 + lift, x = 1.25 (nose)
const gripperAt = (lift: number): readonly number[] => rigWorldPoses(geo, { lift }, undefined, 1, {}).get('gripper')!.pos

describe('AGV custom-part rig - C-drive mobile manipulator on the real AGV.glb (lift FK + grab point + dressing joints)', () => {
  it('is a structurally valid package (rig + a dummy behavior declaring the joints/gripper/beacon)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'oip.agv', name: 'AGV', params: {}, behavior: "definePart({ joints:['lift','piston','wheelLF','wheelRF','wheelLR','wheelRR'], grippers:['gripper'], lamps:['beacon'], step(){} })", geometry: geo, assets: AGV_ASSETS })).toEqual([])
  })

  it('renders the real AGV.glb via per-node mesh links (body/mast/piston/forks/wheels)', () => {
    expect(AGV_ASSETS[0]?.url).toBe('/models/AGV.glb')
    const nodeOf = (name: string): string | undefined => {
      const s = geo.links.find((l) => l.name === name)?.shape
      return s?.kind === 'mesh' ? s.node : undefined
    }
    expect(nodeOf('body')).toBe('AGV_Body')
    expect(nodeOf('mast')).toBe('AGV_Mast')
    expect(nodeOf('piston')).toBe('AGV_Mast_02')
    expect(nodeOf('forks')).toBe('AGV_Forks')
    expect(['AGV_Wheel_LF', 'AGV_Wheel_RF', 'AGV_Wheel_LR', 'AGV_Wheel_RR'].map((n) => geo.links.some((l) => l.shape.kind === 'mesh' && l.shape.node === n))).toEqual([true, true, true, true])
  })

  it('the author-posable articulation is the single prismatic fork lift along +Y', () => {
    const posable = geo.joints.filter((j) => !j.cosmetic)
    expect(posable).toHaveLength(1)
    expect(posable[0]!.name).toBe('lift')
    expect(posable[0]!.type).toBe('prismatic')
    expect(posable[0]!.axis).toEqual([0, 1, 0])
  })

  it('the mast piston + four wheels are cosmetic self-driven joints (no gizmo ring, behavior-animated)', () => {
    const piston = geo.joints.find((j) => j.name === 'piston')!
    expect(piston.type).toBe('prismatic')
    expect(piston.cosmetic).toBe(true)
    // wheels: revolute about the wheel-local axle, the axis sign per side so one shared positive joint value
    // rolls every wheel forward (+X travel) in the same world sense (the built-in's spin-from-travel)
    for (const [name, sign] of [['wheelLF', -1], ['wheelLR', -1], ['wheelRF', 1], ['wheelRR', 1]] as const) {
      const j = geo.joints.find((x) => x.name === name)!
      expect(j.type).toBe('revolute')
      expect(j.cosmetic).toBe(true)
      expect(j.axis).toEqual([sign, 0, 0])
    }
  })

  it.each([0, 0.6, 1.2])('the gripper rides up with the lift command - lift %s m', (lift) => {
    const g = gripperAt(lift)
    expect(g[1]).toBeCloseTo(0.55 + lift, 6) // the built-in carry height (GRIPPER_OFFSET y 0.55) + the lift
    expect(g[0]).toBeCloseTo(1.25, 6) // at the +X nose (the built-in's 1.25 toward the forks), independent of lift
    expect(g[2]).toBeCloseTo(0, 6) // centred across the width
  })

  it('the piston link telescopes up on its own joint (the behavior drives it at 0.5× the lift)', () => {
    const at = (piston: number): number => rigWorldPoses(geo, { piston }, undefined, 1, {}).get('piston')!.pos[1]
    expect(at(0.6) - at(0)).toBeCloseTo(0.6, 6)
  })

  it('the grab point is a body-less frame at the nose with the built-in pickup reach; hidden tines carry cargo', () => {
    const gripper = geo.links.find((l) => l.name === 'gripper')!
    expect(gripper.shape.kind).toBe('frame') // grab point = frame (no body)
    // The pickup volume is the fork zone below. A grabRadius beside it would never be read (the sim uses the
    // zone whenever there is one), so it is not declared: a knob that does nothing invites tuning it.
    expect(gripper.grip?.zone).toBeTruthy()
    expect(gripper.grip?.radius).toBeUndefined()
    // C-multigrab: the fork volume lifts a pallet and its stack as one rigid load (boxes merely resting on a
    // kinematically-driven pallet slide off as it turns), since the volume spans the whole load.
    // Sized to a loaded EUR pallet 3 layers tall and centred on where a load rides. Pin the coverage rather than
    // the literals: capture is by body centre, so the zone must span the whole stack. A zone that clips its near
    // edge silently leaves those cases ungrabbed to slide off at the first turn.
    expect(gripper.grip?.zone?.size).toEqual([AGV_TINE_LENGTH, 2.4, 1.4])
    const [zx, half] = [gripper.grip!.zone!.offset![0]!, gripper.grip!.zone!.size[0] / 2]
    const GRIPPER_X = 1.25 // the gripper frame, in part-local x: carriage 0.75 + link 0.5
    // along the blade the zone matches the blade, heel to tip, which is exactly what a fork can be holding
    expect(zx - half + GRIPPER_X).toBeCloseTo(AGV_TINE_HEEL, 9)
    expect(zx + half + GRIPPER_X).toBeCloseTo(AGV_TINE_HEEL + AGV_TINE_LENGTH, 9)
    // ...which is enough to span a 3-layer stack riding at AGV_LOAD_AHEAD (outermost case centre ~0.31 m out)
    const loadAt = AGV_LOAD_AHEAD - GRIPPER_X
    expect(zx - half).toBeLessThan(loadAt - 0.35)
    expect(zx + half).toBeGreaterThan(loadAt + 0.35)
  })

  // The collision tine is the one link that cannot be a loose approximation of its mesh: it has to fit inside a
  // pallet's fork pocket. A 0.1-thick slab for a 0.051 blade would put its top face 46 mm above the real one,
  // so a pallet "on the forks" would float clear of them and no truck could enter a load.
  // core/types owns the numbers, the rig declares them, this pins the two
  // together, and core/palletForkFit.test.ts asserts they still fit the pocket.
  it('the hidden tines are the blade - core AGV_TINE_* geometry, sitting where AGV_Forks sits', () => {
    for (const [name, sign] of [['tineL', -1], ['tineR', 1]] as const) {
      const tine = geo.links.find((l) => l.name === name)!
      expect(tine.shape.kind).toBe('box') // a real collision tine (the GLB fork mesh is visual-only)
      expect(tine.hidden).toBe(true)
      expect(tine.parent).toBe('carriage') // rides the lift
      const size = (tine.shape as { size: [number, number, number] }).size
      expect(size[1]).toBeCloseTo(AGV_TINE_THICKNESS, 9)
      expect(size[2]).toBeCloseTo(AGV_TINE_WIDTH, 9)
      expect(tine.offset![2]).toBeCloseTo(sign * AGV_TINE_OFFSET, 9)
    }
  })

  // ...and the blade's underside is what `lift` means. The behavior writes fork heights straight into the lift
  // joint and the demo's routes are written as "hold the tines at this height", so if the blade floats above the
  // datum the routes silently mean something else. It sits AGV_TINE_RISE proud of it, as the GLB does.
  it.each([0, 0.9])('the blade underside tracks the lift datum - lift %s m', (lift) => {
    const tine = rigWorldPoses(geo, { lift }, undefined, 1, {}).get('tineL')!
    expect(tine.pos[1] - AGV_TINE_THICKNESS / 2).toBeCloseTo(lift + AGV_TINE_RISE, 6)
  })

  // The fork spread's description says which pallet faces each spread enters. It is written out in the part, so this
  // derives it from the pallets themselves (core/pallet.ts): a pallet change that moves a range fails here until the
  // sentence in examples/parts/agv/part.js is updated.
  it("the fork spread's description matches what core/pallet.ts says each spread fits", () => {
    const spread = instantiatePartScript(AGV_BEHAVIOR).def!.params!.forkSpread as { default: number; desc: string }
    const blade = { bladeWidth: AGV_TINE_WIDTH, bladeThickness: AGV_TINE_THICKNESS }
    const ranges = PALLET_STANDARDS.flatMap((std) => (['long', 'short'] as const).map((face) => fittingSpreads(std.length, std.width, face, blade)))
    const every = ranges.every((r) => r) ? [Math.max(...ranges.map((r) => r![0])), Math.min(...ranges.map((r) => r![1]))] : null
    const fitsAtDefault = (face: 'long' | 'short') =>
      PALLET_STANDARDS.filter((std) => {
        const r = fittingSpreads(std.length, std.width, face, blade)
        return r && r[0] <= spread.default + 1e-9 && spread.default <= r[1] + 1e-9
      })
    const sizes = (list: typeof PALLET_STANDARDS) => (list.length === PALLET_STANDARDS.length ? 'every size' : list.length ? list.map((s) => s.label).join(', ') : 'no size')
    const mm = (r: number[]) => `${Math.round(r[0]! * 1000)}-${Math.round(r[1]! * 1000)} mm`
    const want = [
      'Blade centre to centre, set the way a fork positioner is set for the pallets a site handles.',
      every && every[0]! <= every[1]! ? `Between ${mm(every)} the forks enter every face of every pallet size.` : '',
      `At the default ${Math.round(spread.default * 1000)} mm they enter the long face of ${sizes(fitsAtDefault('long'))} and the short face of ${sizes(fitsAtDefault('short'))}.`,
      'A short face is entered over the bottom runners, about 3 cm above what the pallet stands on.',
      'Taking a pallet through a face the blades do not fit is reported on the truck.',
    ].filter(Boolean).join(' ')
    expect(spread.desc).toBe(want)
    expect(spread.default).toBeCloseTo(2 * AGV_TINE_OFFSET, 9) // the model's own blade positions
  })

  it('has an emissive travel beacon the behavior lights while navigating', () => {
    expect(geo.links.find((l) => l.name === 'beacon')!.lamps?.[0]?.emissive).toBeTruthy()
  })

  it('the chassis is a hidden collision body that drives as one with the live root', () => {
    const chassis = geo.links.find((l) => l.name === 'chassis')!
    expect(chassis.shape.kind).toBe('box')
    expect(chassis.hidden).toBe(true) // the GLB body is the visual; the box only collides
    expect(chassis.parent).toBeUndefined() // a root link - moves with the part base (C-drive)
  })
})
