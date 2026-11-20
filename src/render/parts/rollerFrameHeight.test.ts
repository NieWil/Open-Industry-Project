import { describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import type { RigBoxShape, RigLegShape } from '../../core/parts/partPackage'
import { legFrameDepth, resolvedBoxSize, resolvedOffset } from '../../core/rig/rigPose'
import { examplePart, type RigGeo } from './examplePart'

// Roller beds carry a `frameHeight` param so a bed butted to a belt conveyor can match the belt's frame: the belt's
// side frame is `height` deep (its wall runs from 5 mm under the deck down to -(height + 0.005)), and a roller bed
// set to the same number must put its frame bottom - and its leg tops - at exactly that y. A fixed 0.175-deep
// roller frame would meet a belt only at the belt's default height.

const BELT = examplePart('oip.belt-conveyor').behavior
const STRAIGHT = examplePart<RigGeo>('oip.roller-conveyor').geometry
const SPUR = examplePart('oip.spur-roller-conveyor').behavior
const CURVED = examplePart('oip.curved-roller-conveyor').behavior
const BELT_SPUR = examplePart('oip.spur-conveyor').behavior
const CURVED_BELT = examplePart('oip.curved-conveyor').behavior

const realize = (src: string, params: Record<string, unknown>): MeshPart[] => {
  const parts = evalPartGeometry(src, params as never)
  if (!parts) throw new Error('geometry() returned no parts')
  return parts
}
const minY = (p: MeshPart): number => {
  let m = Infinity
  for (let i = 1; i < p.desc.positions.length; i += 3) m = Math.min(m, p.desc.positions[i]!)
  return m
}
// the belt's frame bottom at this height: the lowest point of its straight side-rail template
const beltFrameBottom = (height: number): number => minY(realize(BELT, { segments: [[3, 0]], width: 1, height }).find((p) => p.finish === 'frame')!)

const HEIGHTS = [0.17, 0.25, 0.4]

describe('roller bed frameHeight matches a belt of the same height', () => {
  it('straight roller: the frame walls and the legs meet the belt frame bottom', () => {
    for (const h of HEIGHTS) {
      const fb = beltFrameBottom(h)
      for (const name of ['wallL', 'wallR']) {
        const wall = STRAIGHT.links.find((l) => l.name === name)!
        const shape = wall.shape as RigBoxShape
        const size = resolvedBoxSize(shape.size, shape.sizeParams, { frameHeight: h, length: 3, width: 1 })
        const offset = resolvedOffset(wall.offset, wall.offsetParams, { frameHeight: h, length: 3, width: 1 })
        expect(offset[1] + size[1] / 2).toBeCloseTo(-0.005, 9) // top stays hung from the rail top
        expect(offset[1] - size[1] / 2).toBeCloseTo(fb, 9)
      }
      const legs = STRAIGHT.links.find((l) => l.shape.kind === 'leg')!.shape as RigLegShape
      expect(-legFrameDepth(legs, { frameHeight: h })).toBeCloseTo(fb, 9)
    }
  })

  it('spur roller: its rail template is the belt rail at the same height (so the two still pool)', () => {
    for (const h of HEIGHTS) {
      const spur = realize(SPUR, { length: 2, width: 1.524, angleFrontDeg: 30, angleBackDeg: 0, rollerClass: 'light', frameHeight: h })
      const belt = realize(BELT, { segments: [[3, 0]], width: 1, height: h })
      expect(spur.find((p) => p.finish === 'frame')!.desc.positions).toEqual(belt.find((p) => p.finish === 'frame')!.desc.positions)
    }
  })

  it('belt spur: its `height` is the straight belt one - same rail template, loop depth and frame', () => {
    for (const h of [0.1, ...HEIGHTS]) {
      const spur = realize(BELT_SPUR, { length: 2, width: 1, angleFrontDeg: 30, angleBackDeg: 0, height: h })
      const belt = realize(BELT, { segments: [[3, 0]], width: 1, height: h })
      expect(spur.find((p) => p.finish === 'frame')!.desc.positions).toEqual(belt.find((p) => p.finish === 'frame')!.desc.positions)
      // the belt loop's bottom return run sits at -height
      const runs = spur.filter((p) => p.finish === 'belt' && p.instances).flatMap((p) => p.instances!.map((i) => i.position[1]))
      expect(Math.min(...runs)).toBeCloseTo(-h, 9)
    }
    // a spur saved before the param reads as the default
    expect(realize(BELT_SPUR, { length: 2, width: 1, height: 0.17 })).toEqual(realize(BELT_SPUR, { length: 2, width: 1 }))
  })

  it('curved belt: its `height` sets the frame, the loop depth and the drum stub past each arc end', () => {
    const CB = { innerRadius: 0.5, width: 1, sweepDeg: 90, standHeight: 1 }
    for (const h of [0.1, ...HEIGHTS]) {
      const parts = realize(CURVED_BELT, { ...CB, height: h })
      expect(minY(parts.find((p) => p.finish === 'frame')!)).toBeCloseTo(beltFrameBottom(h), 9)
      // the belt loop bottoms out at -height (the drum nose wraps down to -2 x stub)
      expect(minY(parts.find((p) => p.finish === 'belt')!)).toBeCloseTo(-h, 9)
      // the inlet's tangent stub: the frame reaches height / 2 past the arc start (+Z at t = 0)
      const frame = parts.find((p) => p.finish === 'frame')!
      let maxZ = -Infinity
      for (let i = 2; i < frame.desc.positions.length; i += 3) maxZ = Math.max(maxZ, frame.desc.positions[i]!)
      expect(maxZ).toBeCloseTo(h / 2, 9)
    }
    // a curve saved before the param reads as the default
    expect(realize(CURVED_BELT, { ...CB, height: 0.17 })).toEqual(realize(CURVED_BELT, CB))
  })

  it('curved roller: the swept frame bottoms out at the belt frame bottom', () => {
    for (const h of HEIGHTS) {
      const curved = realize(CURVED, { innerRadius: 0.5, width: 1.524, sweepDeg: 90, frameHeight: h })
      expect(minY(curved.find((p) => p.finish === 'frame')!)).toBeCloseTo(beltFrameBottom(h), 9)
    }
  })

  it('frame web-bolts stay inside the wall at any frame height (the pair closes up on a shallow one)', () => {
    // the web bolts are the bolt-bank instances on the frame's outer face (z = +-(hw + 0.013)); the leg bolts sit elsewhere
    const webBolts = (parts: MeshPart[], hw: number): { y: number; r: number }[] =>
      parts.find((p) => p.finish === 'bolt')!.instances!.filter((i) => Math.abs(Math.abs(i.position[2]) - (hw + 0.013)) < 1e-6).map((i) => ({ y: i.position[1], r: i.scale![0] }))
    for (const h of [0.1, 0.13, 0.17, 0.4]) {
      const fb = beltFrameBottom(h)
      const belt = webBolts(realize(BELT, { segments: [[3, 0]], width: 1, height: h }), 0.5)
      const spur = webBolts(realize(SPUR, { length: 2, width: 1, angleFrontDeg: 30, angleBackDeg: 0, rollerClass: 'light', frameHeight: h }), 0.5)
      const beltSpur = webBolts(realize(BELT_SPUR, { length: 2, width: 1, angleFrontDeg: 30, angleBackDeg: 0, height: h }), 0.5)
      for (const bolts of [belt, spur, beltSpur]) {
        expect(bolts.length).toBeGreaterThan(0)
        for (const b of bolts) {
          expect(b.y + b.r).toBeLessThanOrEqual(-0.005 - 0.003 + 1e-9) // under the rail top
          expect(b.y - b.r).toBeGreaterThanOrEqual(fb + 0.003 - 1e-9) // over the frame bottom
        }
      }
    }
    // a default belt keeps its 80 mm pair
    const ys = [...new Set(webBolts(realize(BELT, { segments: [[3, 0]], width: 1, height: 0.17 }), 0.5).map((b) => b.y.toFixed(6)))].map(Number)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.08, 9)
  })

  it('drawn beds regrow their legs to the moved frame bottom (the bracket climbs a fixed 0.127 up the web)', () => {
    // leg-part vertex tops: the mounting bracket is the highest leg piece, FB + 0.127 in part space
    const curvedLegTop = (h: number): number => {
      const legs = realize(CURVED, { innerRadius: 0.5, width: 1.524, sweepDeg: 90, standHeight: 1, frameHeight: h }).find((p) => p.finish === 'leg')!
      let m = -Infinity
      for (let i = 1; i < legs.desc.positions.length; i += 3) m = Math.max(m, legs.desc.positions[i]!)
      return m
    }
    const spurLegTop = (h: number): number => {
      const legs = realize(SPUR, { length: 2, width: 1.524, angleFrontDeg: 30, angleBackDeg: 0, rollerClass: 'light', standHeight: 1, frameHeight: h }).find((p) => p.finish === 'leg')!
      // unit-cube instances; skip the rotated knee braces, whose scale is not their vertical extent
      return Math.max(...legs.instances!.filter((i) => !i.quaternion).map((i) => i.position[1] + i.scale![1] / 2))
    }
    for (const h of HEIGHTS) {
      const fb = beltFrameBottom(h)
      expect(curvedLegTop(h)).toBeCloseTo(fb + 0.127, 6)
      expect(spurLegTop(h)).toBeCloseTo(fb + 0.127, 6)
    }
  })
})
