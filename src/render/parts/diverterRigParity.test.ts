import { describe, expect, it } from 'vitest'
import { rigWorldPoses } from '../../core/rig/rigPose'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { resolvedBounds } from '../../core/parts/partGeometry'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type RigGeo } from './examplePart'
const { behavior: DIVERTER_BEHAVIOR, geometry: DIVERTER_RIG, materials: DIVERTER_MATS, assets: DIVERTER_ASSETS, head: DIVERTER_HEAD } = examplePart<RigGeo>('oip.diverter')

// The pop-up Diverter (examples/parts/diverter) is a guided pusher drawn in code, sized by `divertDistance`: a bearing
// block that is the same for every stroke, and behind it what has to be as long as the stroke (the guide rods, the
// drive cylinder's barrel, the stand). Its interface, which the rest of the app is placed against, is fixed: the push along local −Z, the push collider and where its face sits at rest, the guard mount, the
// footprint, and the two panel lamps. Those are pinned here against the geometry as drawn; the lit states are in
// sim/diverterBehavior.test.ts.

const geo = DIVERTER_RIG
const BLADE_FACE = -1.103 // the blade's face at rest: where the push collider's front sits, for every stroke
const link = (name: string) => geo.links.find((l) => l.name === name)!
const parts = (divertDistance: number): MeshPart[] => evalPartGeometry(DIVERTER_BEHAVIOR, { divertDistance }) ?? []
const zRange = (ps: MeshPart[]): [number, number] => {
  const zs = ps.flatMap((p) => p.desc.positions.filter((_, i) => i % 3 === 2))
  return [Math.min(...zs), Math.max(...zs)]
}
const fixed = (ps: MeshPart[]) => ps.filter((p) => p.link === undefined)
// what moves with the blade, along Z in the part frame at extension `reach`
const movingZ = (ps: MeshPart[], material: string, reach: number): [number, number] => {
  const [z0, z1] = zRange(ps.filter((p) => p.link === 'partEnd' && p.material === material))
  const shift = link('partEnd').offset[2] - reach
  return [z0 + shift, z1 + shift]
}

describe('Diverter - a procedural guided pusher', () => {
  it('is a structurally valid package, drawn in code: no model file, every material declared', () => {
    const pkg = {
      format: PACKAGE_FORMAT,
      id: 'oip.diverter',
      name: 'Diverter',
      params: {},
      behavior: "definePart({ joints:['ext3'], lamps:['red','green'], step(){} })",
      geometry: geo,
      materials: DIVERTER_MATS,
      assets: DIVERTER_ASSETS,
    }
    expect(validatePartPackage(pkg)).toEqual([])
    // its only assets are textures (the brushed metal, the two decals), never a model
    expect(DIVERTER_ASSETS.length).toBeGreaterThan(0)
    for (const a of DIVERTER_ASSETS) expect(a.mime).toBe('image/webp')
    expect(geo.links.some((l) => l.shape.kind === 'mesh')).toBe(false)
    const ids = new Set(DIVERTER_MATS.map((m) => m.id))
    for (const p of parts(0.75)) expect(ids.has(p.material!)).toBe(true)
  })

  it('declares one prismatic joint: the blade, its rods and the tie bar move as one stage along local −Z', () => {
    expect(geo.joints).toEqual([{ name: 'ext3', link: 'partEnd', type: 'prismatic', axis: [0, 0, -1], min: 0, max: 1.5 }])
  })

  it('the push collider rides the moving stage, its face on the blade at rest', () => {
    // a hidden box child of partEnd: a hidden link hides what is drawn on it, so the blade's mesh rides partEnd itself
    const blade = link('blade')
    expect(blade.parent).toBe('partEnd')
    expect(blade.hidden).toBe(true)
    expect(blade.shape).toEqual({ kind: 'box', size: [0.47, 0.4, 0.5] })
    const rest = rigWorldPoses(geo, {}).get('blade')!.pos
    expect(rest[2] - 0.25).toBeCloseTo(BLADE_FACE, 4)
    // and the drawn blade's face (its rubber) is the collider's
    const drawn = parts(0.75).filter((p) => p.link === 'partEnd' && p.material !== 'rod')
    expect(zRange(drawn)[0] + link('partEnd').offset[2]).toBeCloseTo(BLADE_FACE, 4)
  })

  it.each([
    ['retracted', 0],
    ['half @ 0.75 m', 0.375],
    ['full @ 0.75 m', 0.75],
    ['full @ 1.50 m', 1.5],
  ])('the stage moves out by the reach, carrying the collider - %s', (_name, reach) => {
    const poses = rigWorldPoses(geo, { ext3: reach })
    expect(poses.get('partEnd')!.pos[2]).toBeCloseTo(link('partEnd').offset[2] - reach, 5)
    expect(poses.get('blade')!.pos[2] - 0.25).toBeCloseTo(BLADE_FACE - reach, 5)
  })

  it.each([0.1, 0.4, 0.75, 1.1, 1.5])('is built for its stroke (%s m): rods held in the block, the stop at the block, the barrel holds the travel', (S) => {
    const ps = parts(S)
    const [blockFront, blockRear] = zRange(fixed(ps).filter((p) => p.material === 'hood')) // the hood and the glands
    // the block's face is against the blade's back at rest and never moves, so neither does the mount
    expect(blockFront).toBeCloseTo(BLADE_FACE + 0.072, 4)
    // retracted, the guide rods stand out behind the block by the stroke: the stroke is visible at rest
    expect(movingZ(ps, 'rod', 0)[1] - blockRear).toBeGreaterThanOrEqual(S - 1e-6)
    // fully out, they still reach back through the block, and the tie bar across their ends is up against it
    expect(movingZ(ps, 'rod', S)[1]).toBeGreaterThanOrEqual(blockRear - 1e-6)
    expect(movingZ(ps, 'frame', S)[1]).toBeCloseTo(blockRear + 0.03, 4)
    // the barrel behind the block is long enough for the piston's whole travel
    const barrel = zRange(fixed(ps).filter((p) => p.material === 'barrel'))
    expect(barrel[1] - blockRear).toBeGreaterThanOrEqual(S)
  })

  // The footprint is the machine, at every stroke and stand height: its bounds tie width and centre to the stroke and
  // the bottom to the stand (PartBounds.params), so selection, snapping and drop-rest see what is drawn, not a fixed
  // box sized for the longest stroke.
  it.each([
    [0.1, 0.3847],
    [0.75, 0.3847],
    [1.5, 0.3847],
    [0.65, 0.79],
  ])('its footprint hugs the machine at rest - stroke %s m, stand %s m', (S, stand) => {
    const b = resolvedBounds(geo.bounds!, { divertDistance: S, standHeight: stand })
    const dz = link('partEnd').offset
    const ps = evalPartGeometry(DIVERTER_BEHAVIOR, { divertDistance: S, standHeight: stand }) ?? []
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const p of ps) {
      // at rest: what rides the blade is drawn in partEnd's frame
      const off = p.link === 'partEnd' ? dz : [0, 0, 0]
      const pos = p.desc.positions
      for (let i = 0; i < pos.length; i += 3) {
        x0 = Math.min(x0, pos[i]! + off[0]!); x1 = Math.max(x1, pos[i]! + off[0]!)
        y0 = Math.min(y0, pos[i + 1]! + off[1]!); y1 = Math.max(y1, pos[i + 1]! + off[1]!)
        z0 = Math.min(z0, pos[i + 2]! + off[2]!); z1 = Math.max(z1, pos[i + 2]! + off[2]!)
      }
    }
    // along Z the box IS the machine: the blade face to the barrel's end cap
    expect(b.centerZ - b.width / 2).toBeCloseTo(z0, 3)
    expect(b.centerZ + b.width / 2).toBeCloseTo(z1, 3)
    expect(z0).toBeCloseTo(BLADE_FACE, 4)
    // vertically: the feet on whatever the stand stands on, the hood's top
    expect(b.bottom).toBeCloseTo(-stand, 6)
    expect(y0).toBeCloseTo(b.bottom, 4)
    expect(y1).toBeLessThanOrEqual(b.top + 1e-6)
    // across: inside the 0.73 m the guard opening is cut to
    expect(Math.max(-x0, x1)).toBeLessThanOrEqual(b.length / 2 + 1e-6)
    expect(b.centerX).toBe(0)
  })

  it('a longer stroke is a longer machine', () => {
    const rears = [0.1, 0.75, 1.5].map((S) => zRange(fixed(parts(S)))[1])
    expect(rears[0]!).toBeLessThan(rears[1]!)
    expect(rears[1]!).toBeLessThan(rears[2]!)
  })

  it('keeps the guard mount at the blade, and the footprint across the lane the guard opening is cut to', () => {
    expect(DIVERTER_HEAD.snap?.mounts?.[0]).toMatchObject({ at: [0, 0, -1.0635], accepts: 'conveyorGuard', face: 'out', opens: true })
    expect(geo.bounds!.length).toBe(0.73)
    // the static fields are the default stroke and stand, for a host that reads bounds without params
    const resolved = resolvedBounds(geo.bounds!, { divertDistance: 0.75, standHeight: 0.3847 })
    const stat = resolvedBounds({ ...geo.bounds!, params: undefined }, {})
    for (const k of ['length', 'width', 'top', 'bottom', 'centerX', 'centerZ'] as const) expect(resolved[k], k).toBeCloseTo(stat[k], 9)
  })

  it('is interactive - a Use/click pushes the pusher across the lane', () => {
    expect(DIVERTER_BEHAVIOR).toContain('interactive: true') // the editor offers a Use prompt
    expect(DIVERTER_BEHAVIOR).toContain('ctx.used()') // the click toggles the runtime diverted state
  })

  it('carries the two panel lamps, each its own lens with its unlit colour as its material', () => {
    const lit = parts(0.75).filter((p) => p.lamps?.length)
    expect(lit.map((p) => p.lamps![0]!.name).sort()).toEqual(['green', 'red'])
    const base: Record<string, [number, number, number]> = { lampRed: [0.29182, 0.11443, 0.11192], lampGreen: [0.15295, 0.31398, 0.14995] }
    for (const p of lit) {
      const mat = DIVERTER_MATS.find((m) => m.id === p.material)!
      for (let i = 0; i < 3; i++) expect(mat.color![i]).toBeCloseTo(base[p.material!]![i]!, 4)
      expect(p.lamps![0]!.emissive.some((c) => c > 0)).toBe(true)
    }
    expect(DIVERTER_BEHAVIOR).toContain("lamps: ['red', 'green']")
  })
})
