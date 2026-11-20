import { describe, expect, it } from 'vitest'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { legPieces, legStations } from './common'
import { examplePart } from './examplePart'

// The conveyor floor support is written twice: as the shared module every legged conveyor part draws with
// (examples/parts/_shared/legs.js) and in TS for the rig roller's kind:'leg' link (common.ts legPieces). This holds the
// two to the same pieces, end to end: the belt's own geometry() output against legPieces() placed at the same station.
// It also pins the stand's proportions (a typical formed-channel floor support), so a change to them fails here.

const { behavior: BELT } = examplePart('oip.belt-conveyor')
const W = 1.0, STAND = 1.6, H = 0.17
const LEG_HEIGHT = STAND - (H + 0.005) // stand height down from the deck, less the frame depth

const beltParts = (h: number): MeshPart[] => {
  const parts = evalPartGeometry(BELT, { segments: [[4, 0]], width: W, height: h, standHeight: STAND, middleLegs: false, headLeg: false } as never)
  if (!parts) throw new Error('belt geometry() returned no parts')
  return parts
}
const beltLegs = (h = H): { legs: MeshPart; bolts: MeshPart } => {
  const parts = beltParts(h)
  const find = (f: string): MeshPart => parts.find((p) => p.finish === f)!
  return { legs: find('leg'), bolts: find('bolt') }
}

describe('conveyor floor support', () => {
  // the default belt, and one shallow enough (a 0.1 m Frame height) that the mounting bracket is cut short
  it.each([H, 0.1])('the generated belt (Frame height %s) draws exactly the pieces common.ts legPieces() does, at the same station', (h) => {
    const { legs, bolts } = beltLegs(h)
    const x0 = 0.15, footY = -STAND // the tail station (LEG_END_INSET) and the floor, part-local
    const ref = legPieces(W, STAND - (h + 0.005), 1, h + 0.005)
    expect(legs.instances!.length).toBe(ref.boxes.length)
    ref.boxes.forEach((b, i) => {
      const inst = legs.instances![i]!
      expect(inst.position![0]).toBeCloseTo(b.px + x0, 9)
      expect(inst.position![1]).toBeCloseTo(b.py + footY, 9)
      expect(inst.position![2]).toBeCloseTo(b.pz, 9)
      expect(inst.scale).toEqual([b.sx, b.sy, b.sz])
      const rz = inst.quaternion ? 2 * Math.atan2(inst.quaternion[2]!, inst.quaternion[3]!) : 0
      expect(rz).toBeCloseTo(b.rz ?? 0, 9)
    })
    // the leg bolts come first in the shared bolt bank (the frame web-bolts follow)
    ref.bolts.forEach((b, i) => {
      const inst = bolts.instances![i]!
      expect(inst.position![0]).toBeCloseTo(b.px + x0, 9)
      expect(inst.position![1]).toBeCloseTo(b.py + footY, 9)
      expect(inst.position![2]).toBeCloseTo(b.pz, 9)
      expect(inst.quaternion !== undefined).toBe(b.up === true)
    })
  })

  it('is sized to a real floor support: 4" x 1-3/4" uprights, a 6" x 4" foot plate, knee braces only when tall', () => {
    const tall = legPieces(W, LEG_HEIGHT, 1)
    const upright = tall.boxes.find((b) => b.sy > LEG_HEIGHT * 0.8)!
    expect(upright.sx).toBeCloseTo(0.1016, 4)
    expect(upright.sz).toBeCloseTo(0.0445, 4)
    const plate = tall.boxes.find((b) => b.py < 0.01)!
    expect(plate.sx).toBeCloseTo(0.1524, 4)
    expect(plate.sz).toBeCloseTo(0.1016, 4)
    // two knee braces (one per upright), leaning toward the middle of the bed
    const knees = tall.boxes.filter((b) => b.rz !== undefined)
    expect(knees).toHaveLength(2)
    for (const k of knees) expect(k.px).toBeGreaterThan(0)
    expect(legPieces(W, LEG_HEIGHT, -1).boxes.filter((b) => b.rz !== undefined).every((k) => k.px < 0)).toBe(true)
    // a stand under a metre gets none, and dir 0 (an arc, an incline) gets none at any height
    expect(legPieces(W, 0.8, 1).boxes.some((b) => b.rz !== undefined)).toBe(false)
    expect(legPieces(W, 2.5, 0).boxes.some((b) => b.rz !== undefined)).toBe(false)
  })

  it('keeps the mounting bracket, and every bolt on it, under the deck on a shallow frame', () => {
    const top = (pc: { py: number; sy: number }): number => pc.py + pc.sy / 2
    for (const depth of [0.105, 0.12, 0.135, 0.175, 0.3]) {
      const legHeight = 1.2 // frame bottom above the floor, so the deck is at legHeight + depth
      const { boxes, bolts } = legPieces(W, legHeight, 1, depth)
      for (const b of boxes.filter((x) => x.rz === undefined)) expect(top(b)).toBeLessThanOrEqual(legHeight + depth - 0.01 + 1e-9)
      for (const b of bolts) expect(b.py + b.sy).toBeLessThanOrEqual(legHeight + depth - 0.01 + 1e-9)
    }
    // and in a real part: a 0.1 m belt's legs stop under its rail top (5 mm below the deck, part-local y 0)
    const { legs } = beltLegs(0.1)
    for (const i of legs.instances!.filter((x) => !x.quaternion)) expect(i.position[1] + i.scale![1] / 2).toBeLessThan(-0.005)
  })

  it('takes the full 0.127 bracket on a frame deep enough for it, so every default conveyor is unchanged', () => {
    expect(legPieces(W, LEG_HEIGHT, 1, H + 0.005)).toEqual(legPieces(W, LEG_HEIGHT, 1))
    expect(legPieces(W, LEG_HEIGHT, 1, 0.3)).toEqual(legPieces(W, LEG_HEIGHT, 1))
  })

  it('stands at the ends and on the 10 ft bed-joint pitch between, never crowding an end support', () => {
    expect(legStations(4)).toEqual([0.15, 3.85]) // a 4 m bed: its two ends, no middle leg 0.8 m from the head
    const long = legStations(12)
    expect(long[0]).toBeCloseTo(0.15, 9)
    expect(long[long.length - 1]).toBeCloseTo(11.85, 9)
    for (let i = 1; i < long.length; i++) {
      expect(long[i]! - long[i - 1]!).toBeGreaterThanOrEqual(1.0 - 1e-9)
      expect(long[i]! - long[i - 1]!).toBeLessThanOrEqual(3.05 + 1.0 + 1e-9)
    }
  })
})
