import { describe, expect, it } from 'vitest'
import type { RigJoint } from '../core/parts/partPackage'
import type { PackageManifest } from '../sim/buildPackage'
import { validatePart } from '../sim/validatePart'
import { create, destroy, step } from '../sim/embeddedBehavior'
import { canSpin, canTwoPositions, isReplaceableBehavior, jointPlcBehavior, jointPlcKeys, readJointPlcConfig } from './jointPlcControl'

const feed: RigJoint = { name: 'feed', link: 'head', type: 'prismatic', axis: [0, -1, 0], min: 0, max: 0.05 }
const arm: RigJoint = { name: 'Motors-joint', link: 'Motors', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }
const spin: RigJoint = { name: 'bit', link: 'Bit', type: 'revolute', axis: [0, 1, 0], min: 0, max: 2 * Math.PI, servo: { maxVelocity: 6, maxAccel: 12, modulo: 2 * Math.PI } }

const manifest = (joints: RigJoint[]): PackageManifest => ({
  id: 'test.drill',
  name: 'Drill',
  geometry: {
    kind: 'rig',
    links: [
      { name: 'body', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0, 0] },
      { name: 'head', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
      { name: 'Motors', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
      { name: 'Bit', parent: 'body', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
    ],
    joints,
  },
})

describe('jointPlcControl', () => {
  it('writes a script that builds, with the tags as Comms params', () => {
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 1.5 } }, [feed])
    const res = validatePart(manifest([feed]), source)
    expect(res.diagnostics).toEqual([])
    const params = res.package!.params
    expect(params.feedToB).toMatchObject({ type: 'tag', dir: 'in', stType: 'BOOL', label: 'Command (to B)', group: 'Comms' })
    expect(params.feedAtA).toMatchObject({ type: 'tag', dir: 'out', label: 'At A' })
    expect(params.feedAtB).toMatchObject({ type: 'tag', dir: 'out', label: 'At B' })
    expect(params.feedTime).toMatchObject({ type: 'number', default: 1.5 })
  })

  it('reads its config back, and an unrelated script has none', () => {
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 2 } }, [feed])
    expect(readJointPlcConfig(source)).toEqual({ feed: { mode: 'twoPositions', time: 2, key: 'feed' } })
    expect(readJointPlcConfig('definePart({ step(ctx) {} })')).toBeNull()
  })

  it('labels each joint once there are several, and keys hyphenated names as identifiers', () => {
    const config = { feed: { mode: 'twoPositions' as const, time: 1 }, 'Motors-joint': { mode: 'twoPositions' as const, time: 1 } }
    expect(jointPlcKeys(config)['Motors-joint']).toMatchObject({ toB: 'motorsJointToB', atA: 'motorsJointAtA', atB: 'motorsJointAtB', time: 'motorsJointTime' })
    const res = validatePart(manifest([feed, arm]), jointPlcBehavior('Drill', config, [feed, arm]))
    expect(res.diagnostics).toEqual([])
    expect(res.package!.params.motorsJointToB).toMatchObject({ label: 'Motors-joint: Command (to B)' })
  })

  it('drops a joint that is gone or spins, and gives the template back when none is left', () => {
    expect(canTwoPositions(spin)).toBe(false)
    const source = jointPlcBehavior('Drill', { gone: { mode: 'twoPositions', time: 1 }, bit: { mode: 'twoPositions', time: 1 } }, [feed, spin])
    expect(readJointPlcConfig(source)).toBeNull()
    expect(isReplaceableBehavior(source)).toBe(true)
  })

  it('keeps a joint\'s param keys when another joint whose name makes the same key is dropped', () => {
    const twin: RigJoint = { ...arm, name: 'motors_joint' }
    const both = { 'Motors-joint': { mode: 'twoPositions' as const, time: 1 }, motors_joint: { mode: 'twoPositions' as const, time: 1 } }
    const config = readJointPlcConfig(jointPlcBehavior('Drill', both, [arm, twin]))!
    expect(jointPlcKeys(config).motors_joint!.toB).toBe('motorsJoint2ToB')
    const { 'Motors-joint': _dropped, ...rest } = config
    const params = validatePart(manifest([arm, twin]), jointPlcBehavior('Drill', rest, [arm, twin])).package!.params
    expect(params.motorsJoint2ToB).toBeDefined()
    expect(params.motorsJointToB).toBeUndefined()
  })

  it('gives a script written before keys were kept the keys it was written with', () => {
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 1 }, 'Motors-joint': { mode: 'twoPositions', time: 1 } }, [feed, arm])
    const old = source.replace(/,"key":"[A-Za-z0-9]+"/g, '')
    expect(old).not.toContain('"key"')
    expect(jointPlcKeys(readJointPlcConfig(old)!)).toEqual(jointPlcKeys(readJointPlcConfig(source)!))
  })

  it('offers Two positions only to a joint whose limits are its own numbers', () => {
    expect(canTwoPositions(feed)).toBe(true)
    expect(canTwoPositions({ ...feed, maxParam: { param: 'stroke' } })).toBe(false)
  })

  it('keeps a line break in the part name out of the code', () => {
    const source = jointPlcBehavior('Drill\nctx.boom()', { feed: { mode: 'twoPositions', time: 1 } }, [feed])
    expect(validatePart(manifest([feed]), source).diagnostics).toEqual([])
    expect(source.split('\n').some((l) => l.startsWith('ctx.boom'))).toBe(false)
  })

  it('treats only the template and its own scripts as replaceable', () => {
    expect(isReplaceableBehavior(jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 1 } }, [feed]))).toBe(true)
    expect(isReplaceableBehavior("definePart({ params: {}, step(ctx) { ctx.setJoint('feed', 0.01) } })")).toBe(false)
  })

  it('ramps to B in the stroke time while the command is TRUE, reports the ends, and comes back', () => {
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 0.5 } }, [feed])
    const h = create(source, JSON.stringify({ feedToB: 'ToB', feedAtA: 'AtA', feedAtB: 'AtB', feedTime: 0.5 }))
    const tick = (toB: boolean): { joints: Record<string, number>; tags: Record<string, boolean> } =>
      JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { ToB: toB } }), 1 / 60))
    let out = tick(false)
    expect(out.joints.feed).toBe(0)
    expect(out.tags).toMatchObject({ AtA: true, AtB: false })
    const half = Array.from({ length: 15 }, () => tick(true)).pop()!
    expect(half.joints.feed).toBeCloseTo(0.025, 6)
    expect(half.tags).toMatchObject({ AtA: false, AtB: false })
    for (let i = 0; i < 15; i++) out = tick(true)
    expect(out.joints.feed).toBeCloseTo(0.05, 9)
    expect(out.tags).toMatchObject({ AtA: false, AtB: true })
    for (let i = 0; i < 30; i++) out = tick(false)
    expect(out.joints.feed).toBeCloseTo(0, 9)
    expect(out.tags).toMatchObject({ AtA: true, AtB: false })
    destroy(h)
  })
})

describe('jointPlcControl: Spin', () => {
  const turn = 2 * Math.PI
  const spindle: RigJoint = { name: 'Bit-joint', link: 'Bit', type: 'revolute', axis: [0, 1, 0], min: 0, max: turn, servo: { maxVelocity: turn, maxAccel: turn * 100, modulo: turn } }

  it('writes a script that builds, with a run, a speed and an at-speed tag, and the servo declared', () => {
    const source = jointPlcBehavior('Drill', { 'Bit-joint': { mode: 'spin' } }, [spindle])
    const res = validatePart(manifest([spindle]), source)
    expect(res.diagnostics).toEqual([])
    const params = res.package!.params
    expect(params.bitJointRun).toMatchObject({ type: 'tag', dir: 'in', stType: 'BOOL', label: 'Run', group: 'Comms' })
    expect(params.bitJointSpeed).toMatchObject({ type: 'tag', dir: 'in', stType: 'REAL', label: 'Speed (rpm)' })
    expect(params.bitJointAtSpeed).toMatchObject({ type: 'tag', dir: 'out', stType: 'BOOL', label: 'At speed' })
    // the joint's own speed (60 rpm) is the copy's default and its most
    expect(params.bitJointRpm).toMatchObject({ type: 'number', default: 60, max: 60 })
    expect(readJointPlcConfig(source)).toEqual({ 'Bit-joint': { mode: 'spin', key: 'bitJoint' } })
  })

  it('offers Spin only to a joint that spins endlessly, and drops it when the joint stops spinning', () => {
    expect(canSpin(spindle)).toBe(true)
    expect(canSpin(feed)).toBe(false)
    expect(readJointPlcConfig(jointPlcBehavior('Drill', { 'Bit-joint': { mode: 'spin' } }, [{ ...spindle, servo: undefined }]))).toBeNull()
  })

  it('writes Two positions and Spin into one script that builds', () => {
    const joints = [feed, spindle]
    const source = jointPlcBehavior('Drill', { feed: { mode: 'twoPositions', time: 1 }, 'Bit-joint': { mode: 'spin' } }, joints)
    const res = validatePart(manifest(joints), source)
    expect(res.diagnostics).toEqual([])
    expect(Object.keys(res.package!.params)).toEqual(expect.arrayContaining(['feedToB', 'bitJointRun', 'bitJointSpeed']))
  })

  it('spins at the copy\'s speed while Run is TRUE, at the PLC\'s speed when one is wired, and stops', () => {
    const source = jointPlcBehavior('Drill', { 'Bit-joint': { mode: 'spin' } }, [spindle])
    const run = (params: Record<string, unknown>, tags: (i: number) => Record<string, unknown>, ticks: number) => {
      const h = create(source, JSON.stringify({ bitJointRun: 'Run', bitJointAtSpeed: 'AtSpeed', bitJointRpm: 60, ...params }), JSON.stringify([spindle]))
      const out: { joints: Record<string, number>; tags: Record<string, unknown> }[] = []
      for (let i = 0; i < ticks; i++) out.push(JSON.parse(step(h, JSON.stringify({ simTime: i / 60, tags: tags(i) }), 1 / 60)))
      destroy(h)
      return out
    }
    // the angle a tick turns, wrapped into [0, 2pi)
    const per = (a: number, b: number) => (((b - a) % turn) + turn) % turn
    const full = run({}, () => ({ Run: true }), 30)
    expect(per(full[28]!.joints['Bit-joint']!, full[29]!.joints['Bit-joint']!)).toBeCloseTo(turn / 60, 3)
    expect(full[29]!.tags.AtSpeed).toBe(true)
    const half = run({ bitJointSpeed: 'Speed' }, () => ({ Run: true, Speed: 30 }), 30)
    expect(per(half[28]!.joints['Bit-joint']!, half[29]!.joints['Bit-joint']!)).toBeCloseTo(turn / 120, 3)
    const stopped = run({}, (i) => ({ Run: i < 10 }), 30)
    expect(per(stopped[28]!.joints['Bit-joint']!, stopped[29]!.joints['Bit-joint']!)).toBeCloseTo(0, 6)
    expect(stopped[29]!.tags.AtSpeed).toBe(false)
  })
})
