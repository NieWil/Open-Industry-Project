import { describe, expect, it } from 'vitest'
import { lookAtQuat, qApply, rigWorldPoses } from './rigPose'
import type { Quat, Vec3 } from './rigPose'
import type { PartPackageGeometry } from '../parts/partPackage'

// C-aim (two-point look-at): a link continuously orients its local +Z (glTF model front) at a target link.
// These pin the primitive (lookAtQuat) and its FK integration
// (rigWorldPoses). The Six-Axis robot's hydraulic-strut connection (the bug this fixes) is verified against
// the generated robot rig in render/parts/sixAxisRigParity.test.ts (src/core can't import from src/render).

type Rig = Extract<PartPackageGeometry, { kind: 'rig' }>

/** the world +Z axis a quaternion points to (the aimed model-front direction) */
const fwd = (q: Quat): Vec3 => qApply(q, [0, 0, 1])
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('lookAtQuat - model-front look-at', () => {
  it('aims local +Z straight at the target', () => {
    const q = lookAtQuat([0, 0, 0], [3, 0, 0], [0, 1, 0])
    expect(fwd(q)[0]).toBeCloseTo(1, 6)
    expect(fwd(q)[1]).toBeCloseTo(0, 6)
    expect(fwd(q)[2]).toBeCloseTo(0, 6)
  })

  it('produces an orthonormal, right-handed basis (unit quaternion)', () => {
    const q = lookAtQuat([1, 2, 3], [-2, 5, 1], [0, 1, 0])
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 6)
    // +Z points at the target regardless of where it is
    expect(dot(fwd(q), norm(sub([-2, 5, 1], [1, 2, 3])))).toBeCloseTo(1, 6)
  })

  it('falls back when the aim is degenerate (eye ≈ target)', () => {
    const fb: Quat = [0, 0.7071068, 0, 0.7071068]
    expect(lookAtQuat([1, 1, 1], [1, 1, 1.0000001], [0, 1, 0], fb)).toEqual(fb)
  })

  it('falls back when up is parallel to the forward axis', () => {
    const fb: Quat = [0.1, 0.2, 0.3, 0.9]
    expect(lookAtQuat([0, 0, 0], [0, 5, 0], [0, 1, 0], fb)).toEqual(fb)
  })
})

describe('rigWorldPoses - aim resolution', () => {
  const twoLink: Rig = {
    kind: 'rig',
    links: [
      { name: 'a', shape: { kind: 'frame' }, offset: [0, 0, 0], aim: { target: 'b' } },
      { name: 'b', shape: { kind: 'frame' }, offset: [2, 0, 0], aim: { target: 'a' } },
    ],
    joints: [],
  }

  it('two mutually-aimed links point their +Z at each other', () => {
    const w = rigWorldPoses(twoLink, {})
    expect(dot(fwd(w.get('a')!.quat), [1, 0, 0])).toBeCloseTo(1, 6) // a → b (+X)
    expect(dot(fwd(w.get('b')!.quat), [-1, 0, 0])).toBeCloseTo(1, 6) // b → a (−X)
  })

  it('an aimed child inherits the aimed orientation (strut mesh follows its anchor)', () => {
    const rig: Rig = {
      kind: 'rig',
      links: [
        { name: 'anchor', shape: { kind: 'frame' }, offset: [0, 0, 0], aim: { target: 'tgt' } },
        { name: 'mesh', shape: { kind: 'frame' }, offset: [0, 0, 0], parent: 'anchor' },
        { name: 'tgt', shape: { kind: 'frame' }, offset: [0, 0, 5] },
      ],
      joints: [],
    }
    const w = rigWorldPoses(rig, {})
    // the identity-child mesh ends up with the same world quat as its aimed anchor
    expect(w.get('mesh')!.quat).toEqual(w.get('anchor')!.quat)
    expect(dot(fwd(w.get('mesh')!.quat), [0, 0, 1])).toBeCloseTo(1, 6)
  })
})
