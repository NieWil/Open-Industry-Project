import { describe, expect, it } from 'vitest'
import { Euler, Quaternion, Vector3 } from 'three'
import { qFromEulerXYZ } from '../../core/rig/rigPose'
import { nodeRotationAfterTurn } from './drag'

type Q = [number, number, number, number]
const quat = (axis: [number, number, number], angle: number): Q => {
  const q = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), angle)
  return [q.x, q.y, q.z, q.w]
}
// the node's world orientation, parent * rest, with the rest rotation read back the way the rig reads it
const world = (parent: Q, rest: [number, number, number]): Quaternion => new Quaternion(...parent).multiply(new Quaternion(...qFromEulerXYZ(rest)))
const same = (a: Quaternion, b: Quaternion): boolean => Math.abs(a.dot(b)) > 1 - 1e-9 // q and -q are one rotation

describe('nodeRotationAfterTurn (a gizmo ring on a rig node)', () => {
  it('under an unturned parent, a world Y turn is a turn of the rest rotation about Y', () => {
    const r = nodeRotationAfterTurn([0, 0, 0, 1], [0, 0, 0, 1], [0, 1, 0], Math.PI / 4)
    expect(r[0]).toBeCloseTo(0, 9)
    expect(r[1]).toBeCloseTo(Math.PI / 4, 9)
    expect(r[2]).toBeCloseTo(0, 9)
  })

  it('under a turned parent, the node still turns about the world axis the ring showed', () => {
    // a parent tipped 90 deg about X: the world's Y is the parent's -Z, so a naive "add to rest Y" would be wrong
    const parent = quat([1, 0, 0], Math.PI / 2)
    const start = quat([0, 0, 1], 0.3) // and the node already carries a rest rotation of its own
    const startEuler = new Euler().setFromQuaternion(new Quaternion(...start), 'XYZ')
    const turn = quat([0, 1, 0], 0.7)
    const r = nodeRotationAfterTurn(parent, start, [0, 1, 0], 0.7)
    const expected = new Quaternion(...turn).multiply(world(parent, [startEuler.x, startEuler.y, startEuler.z]))
    expect(same(world(parent, r), expected)).toBe(true)
  })

  it('a zero turn changes nothing', () => {
    const start = quat([0.3, 1, -0.2], 1.1)
    const startEuler = new Euler().setFromQuaternion(new Quaternion(...start), 'XYZ')
    const r = nodeRotationAfterTurn(quat([0, 0, 1], 0.5), start, [1, 0, 0], 0)
    expect(r[0]).toBeCloseTo(startEuler.x, 9)
    expect(r[1]).toBeCloseTo(startEuler.y, 9)
    expect(r[2]).toBeCloseTo(startEuler.z, 9)
  })
})
