import { describe, expect, it } from 'vitest'
import { fitLoad, webCorner, wrapAnchor, wrapLoad } from './cargoWrap'
import type { WrapBody } from './cargoWrap'
import { qFromAxisAngle } from './rig/rigPose'

const flat: [number, number, number, number] = [0, 0, 0, 1]
const pallet = (x: number, y: number, z: number, yaw = 0): WrapBody => ({ pos: [x, y, z], quat: yaw ? qFromAxisAngle([0, 1, 0], yaw) : flat, half: [0.61, 0.0675, 0.51] })
const box = (x: number, y: number, z: number, half: [number, number, number] = [0.3, 0.2, 0.25]): WrapBody => ({ pos: [x, y, z], quat: flat, half })

describe('wrapLoad', () => {
  it('takes the stack on the pallet and draws the film from pallet mid-height to the top case', () => {
    const bodies = [
      pallet(0, 0.0675, 0),
      box(-0.3, 0.135 + 0.2, -0.25), box(0.3, 0.135 + 0.2, 0.25), // course 1
      box(-0.3, 0.135 + 0.6, 0.25), // course 2, resting on course 1
    ]
    const w = wrapLoad(0, bodies, true)!
    expect(w.members.sort()).toEqual([1, 2, 3])
    // pallet-local: its centre is y 0, so the film starts there and ends at the top case's top (+ standoff)
    expect(w.box.min[1]).toBeCloseTo(0)
    expect(w.box.max[1]).toBeCloseTo(0.135 + 0.8 - 0.0675 + 0.006, 5) // top case's top, pallet-local
    // the cases sit inside the pallet's footprint, so the film is the pallet's plan plus the standoff
    expect(w.box.min[0]).toBeCloseTo(-0.616)
    expect(w.box.max[2]).toBeCloseTo(0.516)
  })

  it('leaves out a case beside the pallet and a load on the rack level above', () => {
    const bodies = [
      pallet(0, 0.0675, 0),
      box(0, 0.335, 0), // on the pallet
      box(0.95, 0.335, 0), // beside it, on the next pallet over: centre past the footprint
      pallet(0, 1.6, 0), box(0, 1.87, 0), // the level above, with daylight between
    ]
    expect(wrapLoad(0, bodies, true)!.members).toEqual([1])
  })

  it('works in the pallet frame when the pallet is turned', () => {
    const yaw = Math.PI / 2
    const bodies = [pallet(5, 0.0675, 5, yaw), box(5, 0.335, 5.55)] // 0.55 along world z = pallet-local x
    const w = wrapLoad(0, bodies, true)!
    expect(w.members).toEqual([1])
    expect(w.box.max[0]).toBeCloseTo(0.61 + 0.006, 5) // inside the long side
  })

  it('is null for a bare pallet', () => {
    expect(wrapLoad(0, [pallet(0, 0.0675, 0)], true)).toBeNull()
  })
})

describe('wrapAnchor', () => {
  it('prefers the lowest pallet, else the lowest body', () => {
    expect(wrapAnchor([{ index: 4, y: 0.3, pallet: false }, { index: 7, y: 0.07, pallet: true }, { index: 2, y: 0.05, pallet: false }])).toBe(7)
    expect(wrapAnchor([{ index: 4, y: 0.3, pallet: false }, { index: 2, y: 0.05, pallet: false }])).toBe(2)
    expect(wrapAnchor([])).toBe(-1)
  })
})

describe('webCorner', () => {
  const box = { min: [-0.6, 0, -0.5] as [number, number, number], max: [0.6, 1, 0.5] as [number, number, number] }
  it('is the corner tangent to the roll on the side behind its travel', () => {
    // roll out on +x, travelling toward -z: the web trails back to the +z side, to the +x corner it last went round
    expect(webCorner(box, [1.1, 0], [0, -1])).toEqual([0.6, 0.5])
    // the same roll going the other way trails to the -z side
    expect(webCorner(box, [1.1, 0], [0, 1])).toEqual([0.6, -0.5])
    // round on +z travelling toward +x, the web trails to the -x side of that face
    expect(webCorner(box, [0, 1.1], [1, 0])).toEqual([-0.6, 0.5])
  })
})

describe('fitLoad', () => {
  it('fits the film over exactly the members it is given, not over what else stands on the pallet', () => {
    const bodies = [
      pallet(0, 0.0675, 0),
      box(-0.3, 0.135 + 0.2, -0.25), box(0.3, 0.135 + 0.2, 0.25), // members
      box(0, 0.135 + 0.6, 0), // standing on them, but not a member
    ]
    const fit = fitLoad(0, [1, 2], bodies, true)
    expect(fit.max[1]).toBeCloseTo(0.135 + 0.4 - 0.0675 + 0.006, 5) // the members' top, not the extra case's
    expect(fit.min[1]).toBeCloseTo(0)
    // a bare anchor still gets a box: its own
    expect(fitLoad(0, [], bodies, true).max[1]).toBeCloseTo(0.0675 + 0.006, 5)
  })
})
