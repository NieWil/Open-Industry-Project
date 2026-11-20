import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, rigJointsJson, type RigJoint } from '../core/parts/partPackage'
import { validatePartPackage } from '../core/parts/partValidate'
import { upgradeStoredPackage } from '../core/parts/partUpgrade'
import type { PackageManifest } from './buildPackage'
import { create, destroy, stepDirect } from './embeddedBehavior'
import { validatePart } from './validatePart'

// A servo joint end to end through the behavior runtime: the manifest marks the joint `servo`, the part drives it
// through ctx.servos, and the host runs the profile (core/motionAxis.ts) and poses the joint every tick.

const DT = 1 / 60

const slide: RigJoint = { name: 'x', link: 'carriage', type: 'prismatic', axis: [1, 0, 0], min: -1, max: 1, servo: { maxVelocity: 0.5, maxAccel: 2 } }
const spin: RigJoint = { name: 'r', link: 'disc', type: 'revolute', axis: [0, 1, 0], min: 0, max: 2 * Math.PI, servo: { maxVelocity: Math.PI, maxAccel: 4 * Math.PI, modulo: 2 * Math.PI } }

const manifest = (joints: RigJoint[]): PackageManifest => ({
  id: 'acme.servo',
  name: 'Servo',
  geometry: {
    kind: 'rig',
    links: [
      { name: 'carriage', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0, 0] },
      { name: 'disc', shape: { kind: 'box', size: [0.2, 0.05, 0.2] }, offset: [0, 0.5, 0] },
    ],
    joints,
  },
})

const MOVER = `definePart({
  servos: ['x'],
  params: { target: { type: 'number', default: 0.8 } },
  step(ctx) {
    const x = ctx.servos.x
    if (!x.powered) { x.power(true); return }
    if (x.state === 'standstill' && !x.inPosition) return
    if (x.state === 'standstill' && Math.abs(x.position - ctx.params.target) > 1e-9) x.moveAbsolute(ctx.params.target, { velocity: 0.5 })
  },
})`

function runTicks(source: string, joints: RigJoint[], ticks: number, paramsJson = '{}'): number[] {
  const h = create(source, paramsJson, rigJointsJson(manifest(joints).geometry))
  expect(h).toBeGreaterThan(0)
  const xs: number[] = []
  for (let i = 0; i < ticks; i++) {
    const out = stepDirect(h, { simTime: i * DT }, DT)
    expect(out).not.toBeNull()
    xs.push(out!.joints.x ?? Number.NaN)
  }
  destroy(h)
  return xs
}

describe('servo joints (ctx.servos)', () => {
  it('a part powers a servo and sends it somewhere; the host profiles the move and poses the joint every tick', () => {
    const xs = runTicks(MOVER, [slide], 240)
    expect(xs[0]).toBe(0) // powered on the first tick, not yet moving: the joint is still posed
    expect(xs.at(-1)).toBe(0.8)
    // monotonic, capped at the servo's velocity and acceleration
    let peakV = 0
    let peakA = 0
    for (let i = 1; i < xs.length; i++) {
      const v = (xs[i]! - xs[i - 1]!) / DT
      expect(v).toBeGreaterThanOrEqual(-1e-12)
      peakV = Math.max(peakV, v)
      if (i > 1) peakA = Math.max(peakA, Math.abs(v - (xs[i - 1]! - xs[i - 2]!) / DT) / DT)
    }
    expect(peakV).toBeLessThanOrEqual(0.5 + 1e-9)
    expect(peakA).toBeLessThanOrEqual(2 * (1 + 1e-6))
  })

  it('is deterministic', () => {
    expect(runTicks(MOVER, [slide], 120)).toEqual(runTicks(MOVER, [slide], 120))
  })

  it('an unpowered servo holds its joint and refuses motion', () => {
    const h = create(`definePart({ servos: ['x'], step(ctx) { ctx.display('r', ctx.servos.x.moveAbsolute(0.5, { velocity: 1 })) } })`, '{}', rigJointsJson(manifest([slide]).geometry))
    const out = stepDirect(h, {}, DT)!
    destroy(h)
    expect(out.displays.r).toBe(-1) // not powered
    expect(out.joints.x).toBe(0)
  })

  it('a target past the joint limits narrowed by the params stops at or short of them, in a fault', () => {
    const narrowed: RigJoint = { ...slide, maxParam: { param: 'len', scale: 0.5 } }
    const src = `let id = 0
definePart({ servos: ['x'], params: { len: { type: 'number', default: 1 } }, step(ctx) {
  const x = ctx.servos.x
  if (!x.powered) { x.power(true); id = x.moveAbsolute(0.8, { velocity: 0.5, accel: 2 }) }
  ctx.display('id', id); ctx.display('state', x.state)
} })`
    const h = create(src, '{}', rigJointsJson(manifest([narrowed]).geometry))
    let out = stepDirect(h, {}, DT)!
    let peak = 0
    for (let i = 0; i < 300; i++) {
      out = stepDirect(h, {}, DT)!
      peak = Math.max(peak, out.joints.x!)
    }
    destroy(h)
    expect(out.displays.id).toBeGreaterThan(0) // accepted, as a real axis takes it
    expect(out.displays.state).toBe('errorStop')
    expect(peak).toBeLessThanOrEqual(0.5) // max is len * 0.5 = 0.5: never past it
    expect(peak).toBeGreaterThan(0.4)
  })

  it('a ctx.joints write to a servo joint is ignored: the servo owns its joint', () => {
    const h = create(`definePart({ step(ctx) { ctx.joints.x = 0.9 } })`, '{}', rigJointsJson(manifest([slide]).geometry))
    const out = stepDirect(h, {}, DT)!
    destroy(h)
    expect(out.joints.x).toBe(0)
  })

  it('a wrapping servo spins without end at a velocity', () => {
    const src = `definePart({ servos: ['r'], step(ctx) { const r = ctx.servos.r; if (!r.powered) { r.power(true); r.moveVelocity(Math.PI) } } })`
    const h = create(src, '{}', rigJointsJson(manifest([spin]).geometry))
    let last = 0
    for (let i = 0; i < 600; i++) last = stepDirect(h, {}, DT)!.joints.r!
    destroy(h)
    expect(last).toBeGreaterThanOrEqual(0)
    expect(last).toBeLessThan(2 * Math.PI)
  })

  it('a bad argument is refused, never handed to the kernel as something else', () => {
    const src = `definePart({ servos: ['x'], step(ctx) {
      const x = ctx.servos.x; x.power(true)
      let reads = 0
      const sneaky = { get velocity() { reads++; return reads === 1 ? 1 : NaN } }
      ctx.display('a', x.moveAbsolute('0.5', { velocity: 1 }))
      ctx.display('b', x.moveAbsolute(0.5, sneaky))
      ctx.display('reads', reads)
    } })`
    const h = create(src, '{}', rigJointsJson(manifest([slide]).geometry))
    const out = stepDirect(h, {}, DT)!
    destroy(h)
    expect(out.displays.a).toBe(-4) // a string target is not a number
    expect(out.displays.b).toBeGreaterThan(0) // the velocity was read once, as 1
    expect(out.displays.reads).toBe(1)
  })

  it('ctx.servo(name) reaches a servo by a computed name', () => {
    const h = create(`definePart({ step(ctx) { ctx.display('has', ctx.servo('x') !== undefined); ctx.display('none', ctx.servo('nope') === undefined) } })`, '{}', rigJointsJson(manifest([slide]).geometry))
    const out = stepDirect(h, {}, DT)!
    destroy(h)
    expect(out.displays).toEqual({ has: true, none: true })
  })
})

describe('servo declarations are validated', () => {
  const msgs = (joints: RigJoint[], src: string) => validatePart(manifest(joints), src).diagnostics.map((d) => d.message)

  it('accepts a declared servo that the manifest marks', () => {
    expect(validatePart(manifest([slide]), MOVER).ok).toBe(true)
  })

  it('reports a declared servo on a joint without `servo`, and one that is no joint at all', () => {
    const { servo: _s, ...plain } = slide
    expect(msgs([plain], MOVER).join('\n')).toMatch(/declared servo "x" is a rig joint without `servo`/)
    expect(msgs([slide], `definePart({ servos: ['y'], step() {} })`).join('\n')).toMatch(/declared servo "y" is not a rig joint/)
  })

  it('reports a servo declared as a plain joint', () => {
    expect(msgs([slide], `definePart({ joints: ['x'], step() {} })`).join('\n')).toMatch(/joint "x" is a servo: drive it through ctx.servos.x/)
  })

  it('the package validator checks the servo block', () => {
    const pkg = (j: RigJoint) => ({ format: PACKAGE_FORMAT, id: 'a.b', name: 'B', params: {}, behavior: 'definePart({ step() {} })', geometry: manifest([j]).geometry })
    const errs = (j: RigJoint) => validatePartPackage(pkg(j)).map((e) => e.field).join(' ')
    expect(errs(slide)).toBe('')
    expect(errs(spin)).toBe('')
    expect(errs({ ...slide, servo: { maxVelocity: 0, maxAccel: 1 } })).toMatch(/servo.maxVelocity/)
    expect(errs({ ...slide, servo: { maxVelocity: 1, maxAccel: 1, modulo: 1 } })).toMatch(/servo.modulo/) // prismatic cannot wrap
    expect(errs({ ...spin, max: 1 })).toMatch(/servo.modulo/) // limits must cover the wrap
    expect(errs({ ...slide, cosmetic: true })).toMatch(/servo/)
  })

  it('an older servo with ramp / maxJerk still loads, moves as the trapezoid, and a stored package loses them quietly', () => {
    const retired = { ...slide, servo: { maxVelocity: 0.5, maxAccel: 2, ramp: 'quadratic', maxJerk: 20 } } as unknown as RigJoint
    const pkg = { format: PACKAGE_FORMAT, id: 'a.b', name: 'B', params: {}, behavior: 'definePart({ step() {} })', geometry: manifest([retired]).geometry }
    expect(validatePartPackage(pkg)).toEqual([]) // not refused, so a part saved with one keeps loading
    const { pkg: up, repairs } = upgradeStoredPackage(pkg)
    expect(repairs).toEqual([])
    expect((up.geometry as { joints: RigJoint[] }).joints[0]!.servo).toEqual({ maxVelocity: 0.5, maxAccel: 2 })
    // a plain trapezoid servo has nothing to repair, and comes back as itself
    const plain = { ...pkg, geometry: manifest([slide]).geometry }
    expect(upgradeStoredPackage(plain)).toEqual({ pkg: plain, repairs: [] })
    // and run as it is, the joint moves exactly as the trapezoid servo does
    expect(runTicks(MOVER, [retired], 240)).toEqual(runTicks(MOVER, [slide], 240))
  })
})

describe('buffered servo moves', () => {
  it('a buffered move waits its turn (queued), then runs from where the one ahead stopped', () => {
    const src = `let a = 0, b = 0, c = 0
definePart({ servos: ['x'], step(ctx) {
  const x = ctx.servos.x
  if (!x.powered) { x.power(true); return }
  if (a === 0) {
    a = x.moveAbsolute(0.5, { velocity: 0.5, accel: 2 })
    b = x.moveAbsolute(-0.5, { velocity: 0.5, accel: 2, buffered: true })
    c = x.moveRelative(0.2, { velocity: 0.5, accel: 2, buffered: true })
  }
  ctx.display('s', [x.done(a), x.queued(b), x.done(b), x.queued(c), x.done(c), x.aborted(b)].map(Number).join(''))
} })`
    const h = create(src, '{}', rigJointsJson(manifest([slide]).geometry))
    const seen = new Set<string>()
    const xs: number[] = []
    for (let i = 0; i < 600; i++) {
      const out = stepDirect(h, {}, DT)!
      seen.add(String(out.displays.s))
      xs.push(out.joints.x!)
    }
    destroy(h)
    // first both wait; then a is done and b runs while c waits; then all done; nothing aborted
    expect(seen).toContain('010100')
    expect(seen).toContain('100100')
    expect(xs.at(-1)).toBeCloseTo(-0.3, 12) // -0.5, then 0.2 relative to it
    expect(Math.max(...xs)).toBeCloseTo(0.5, 12)
    expect(Math.min(...xs)).toBeCloseTo(-0.5, 12)
    expect([...seen].some((s) => s.endsWith('1'))).toBe(false)
  })
})
