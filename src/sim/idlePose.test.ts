import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { IdleUseSession, settleIdlePose, withJointRests } from './idlePose'
import type { IdlePose } from './idlePose'

// A blade-stop-shaped device: a single prismatic joint that tweens toward the `active` param (so the
// settle loop must run several steps, not just read the first) and holds there. Mirrors the real blade
// stop's approach-to-target motion (examples/parts/blade-stop/behavior.ts) in miniature.
const TWEENING_DEVICE = `
let r = 0
definePart({
  joints: ['raise'],
  params: { active: { type: 'boolean', default: false } },
  step(ctx) {
    const want = ctx.params.active ? 1 : 0
    r = ctx.approach(r, want, ctx.dt / 0.15)
    ctx.joints.raise = r * 0.1
  },
})
`

// A turntable-shaped device: a revolute joint that integrates a speed every tick, so it never settles.
const CONTINUOUS_DEVICE = `
let a = 0
definePart({
  joints: ['deck'],
  params: { speed: { type: 'number', default: 90 } },
  step(ctx) {
    a += (ctx.params.speed * Math.PI / 180) * ctx.dt
    ctx.joints.deck = a
  },
})
`

// An interactive device that latches on ctx.used() (the blade stop's getBladeStopSignal handoff in miniature):
// each press flips its internal `active`, seeded from the `active` param. Used to exercise the stopped-scene Use pulse path.
const INTERACTIVE_DEVICE = `
let active, last, r = 0
definePart({
  interactive: true,
  joints: ['raise'],
  params: { active: { type: 'boolean', default: false } },
  step(ctx) {
    if (ctx.params.active !== last) { active = ctx.params.active; last = ctx.params.active }
    if (ctx.used()) active = !active
    r = ctx.approach(r, active ? 1 : 0, ctx.dt / 0.15)
    ctx.joints.raise = r * 0.1
  },
})
`

// The real diverter/blade-stop handoff: the tag decides only while a controller drives it (ctx.tagDriven:
// the tag is an attached program's output); otherwise the hand latch decides. The preview harness never sets
// a driven table, so a comms-enabled device still hand-poses at idle - the plant is in program mode.
const COMMS_GATED_DEVICE = `
let manual, last, r = 0
definePart({
  interactive: true,
  joints: ['raise'],
  params: {
    active: { type: 'boolean', default: false },
    enableComms: { type: 'boolean', default: true },
    tag: { type: 'tag', default: 'Cmd' },
  },
  step(ctx) {
    if (ctx.params.active !== last) { manual = ctx.params.active; last = ctx.params.active }
    if (ctx.used()) manual = !manual
    const auto = ctx.params.enableComms && ctx.tagDriven(ctx.params.tag)
    r = ctx.approach(r, (auto ? ctx.readTag(ctx.params.tag) : manual) ? 1 : 0, ctx.dt / 0.15)
    ctx.joints.raise = r * 0.1
  },
})
`

describe('settleIdlePose', () => {
  it('a comms-enabled device still hand-poses at idle - nothing is driven while stopped', () => {
    // one hand press extends it (without the tagDriven gate, comms-on would pin it to the dead tag: stuck at rest)
    expect(settleIdlePose(COMMS_GATED_DEVICE, { enableComms: true }, 1)!.joints.raise!).toBeCloseTo(0.1, 5)
    expect(settleIdlePose(COMMS_GATED_DEVICE, { enableComms: true }, 2)!.joints.raise!).toBeCloseTo(0, 5)
  })

  it('settles a tweening device to its actuated pose when the param is on', () => {
    const pose = settleIdlePose(TWEENING_DEVICE, { active: true })
    expect(pose).not.toBeNull()
    expect(pose!.joints.raise!).toBeCloseTo(0.1, 5) // tweened all the way up and held
  })

  it('settles the same device to rest when the param is off', () => {
    const pose = settleIdlePose(TWEENING_DEVICE, { active: false })
    expect(pose!.joints.raise!).toBeCloseTo(0, 5)
  })

  it('is derived from params only - no separate idle pose to author', () => {
    // the same source produces different settled poses purely from the authored param
    const up = settleIdlePose(TWEENING_DEVICE, { active: true })!.joints.raise!
    const down = settleIdlePose(TWEENING_DEVICE, { active: false })!.joints.raise!
    expect(up).toBeGreaterThan(down)
  })

  it('drops a continuous-motion joint (never settles) so it falls back to rest', () => {
    // a spinning turntable has no static actuated pose → nothing to preview → null (rig stays at rest)
    expect(settleIdlePose(CONTINUOUS_DEVICE, { speed: 90 })).toBeNull()
  })

  it('previews the settled angle when the continuous joint is stopped (speed 0)', () => {
    const pose = settleIdlePose(CONTINUOUS_DEVICE, { speed: 0 })
    expect(pose!.joints.deck!).toBeCloseTo(0, 5)
  })

  it('returns null for a part that commands no joints/subposes (a plain conveyor)', () => {
    const conveyor = `definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: 1, y: 0, z: 0 }) } })`
    expect(settleIdlePose(conveyor, {})).toBeNull()
  })

  it('returns null for a source that fails to instantiate', () => {
    expect(settleIdlePose('this is not valid js {{{', {})).toBeNull()
  })

  // a stopped-scene Use (the walking character's E) → usePulses: one press actuates a latching device, two cancel out.
  it('one use pulse toggles a latching device on (a stopped-sim Use press)', () => {
    expect(settleIdlePose(INTERACTIVE_DEVICE, { active: false }, 0)!.joints.raise!).toBeCloseTo(0, 5)
    expect(settleIdlePose(INTERACTIVE_DEVICE, { active: false }, 1)!.joints.raise!).toBeCloseTo(0.1, 5)
  })

  it('two use pulses cancel back to rest (press twice)', () => {
    expect(settleIdlePose(INTERACTIVE_DEVICE, { active: false }, 2)!.joints.raise!).toBeCloseTo(0, 5)
  })

  it('a use pulse toggles relative to the authored param (param on + one press → off)', () => {
    expect(settleIdlePose(INTERACTIVE_DEVICE, { active: true }, 0)!.joints.raise!).toBeCloseTo(0.1, 5)
    expect(settleIdlePose(INTERACTIVE_DEVICE, { active: true }, 1)!.joints.raise!).toBeCloseTo(0, 5)
  })
})

// A push-button-shaped device with no joints: the cap is a subPose slide and the light a lamp. Momentary mode
// holds pressed for a 0.3 s pulse window (an 18-tick zero-motion hold the convergence logic must out-wait);
// maintained mode latches. Mirrors examples/parts/push-button/behavior.ts in miniature.
const BUTTON_DEVICE = `
let pressed = false, ticks = 0
definePart({
  interactive: true,
  lamps: ['cap'],
  params: { momentary: { type: 'boolean', default: true } },
  step(ctx) {
    if (ctx.params.momentary) {
      if (ctx.used()) ticks = Math.ceil(0.3 / ctx.dt)
      pressed = ticks > 0
      if (ticks > 0) ticks--
    } else if (ctx.used()) pressed = !pressed
    ctx.lamps.cap = pressed
    ctx.setSubPose('cap', { position: [0, 0, pressed ? -0.02 : 0] })
  },
})
`

describe('settleIdlePose (subPose + lamp devices)', () => {
  it('a momentary button settles released after a press - the pulse-window hold is out-waited', () => {
    const pose = settleIdlePose(BUTTON_DEVICE, { momentary: true }, 1)
    expect(pose).not.toBeNull()
    expect(pose!.subPoses.cap!.position![2]).toBeCloseTo(0, 6) // sprang back, not frozen mid-hold
    expect(pose!.lamps?.cap).toBe(false)
  })

  it('a maintained button settles pressed with its cap lamp lit', () => {
    const pose = settleIdlePose(BUTTON_DEVICE, { momentary: false }, 1)
    expect(pose!.subPoses.cap!.position![2]).toBeCloseTo(-0.02, 6)
    expect(pose!.lamps?.cap).toBe(true)
  })
})

// A stopped-scene Use (the editor's C and the walking character's E, one model): a live session of the device's
// behavior, opened at its authored state, pressed, and stepped frame by frame. It must behave the way the device
// does in a run, stay where a press leaves it, and say when it is back at its design (atRest: nothing held).
describe('settleIdlePose (a posable array that never settles)', () => {
  // a chain of copies that keeps running while stopped (a sorter whose slats move until a program says otherwise),
  // with one whole link that also never settles
  const CHAIN = `
let t = 0
definePart({
  params: { length: { type: 'number', default: 2 } },
  step(ctx) {
    t += ctx.dt
    const n = ctx.arrayCount('slat')
    for (let i = 0; i < n; i++) ctx.setSubPose('slat', { position: [(i * 0.5 + t) % 2, 0, 0] }, i)
    ctx.setSubPose('arm', { rotation: [0, t, 0] })
  },
})`
  const arrays = JSON.stringify([{ name: 'slat', array: { pitch: { axis: 0, spanParam: 'length', pitch: 0.5 }, posable: true } }])

  it('keeps where its copies stood, not their rest row, and drops the whole-link pose that never settled', () => {
    const pose = settleIdlePose(CHAIN, {}, 0, undefined, undefined, arrays)
    expect(pose?.subPoses.slat?.instances).toHaveLength(4)
    expect(pose?.subPoses.slat?.instances?.every((p) => p?.position !== undefined)).toBe(true)
    expect(pose?.subPoses.arm).toBeUndefined()
  })
})

describe('IdleUseSession', () => {
  const FRAME = 1 / 60
  /** step `seconds` of frames, returning every pose along the way */
  const play = (u: IdleUseSession, seconds: number): IdlePose[] => {
    const out: IdlePose[] = []
    for (let t = 0; t < seconds; t += FRAME) {
      u.advance(FRAME)
      out.push(u.pose)
    }
    return out
  }
  const raise = (f: IdlePose) => f.joints.raise ?? 0
  const cap = (f: IdlePose) => f.subPoses.cap?.position?.[2] ?? 0

  it('a latching device sweeps out on a press and stays out; a second press brings it home, and that ends it', () => {
    const u = IdleUseSession.open(INTERACTIVE_DEVICE, { active: false })!
    expect(raise(u.pose)).toBeCloseTo(0, 5) // opened at the authored state: what was on screen
    u.press()
    const out = play(u, 1).map(raise)
    const rising = out.filter((r) => r > 0.01 && r < 0.09).length
    expect(rising).toBeGreaterThan(3) // a sweep, not a teleport
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!)
    expect(out[out.length - 1]!).toBeCloseTo(0.1, 5)
    play(u, 2)
    expect(raise(u.pose)).toBeCloseTo(0.1, 5) // it stays where the press left it
    expect(u.settled).toBe(true)
    expect(u.atRest).toBe(false) // ...which is not the design: the press is holding it
    u.press()
    play(u, 1)
    expect(raise(u.pose)).toBeCloseTo(0, 5)
    play(u, 1.5)
    expect(u.atRest).toBe(true) // back at the design, and quiet: nothing left to hold
    u.dispose()
  })

  it('opens at the authored state, whichever it is (param on: a press lowers it)', () => {
    const u = IdleUseSession.open(INTERACTIVE_DEVICE, { active: true })!
    expect(raise(u.pose)).toBeCloseTo(0.1, 5)
    expect(u.atRest).toBe(true)
    u.press()
    play(u, 1.5)
    expect(raise(u.pose)).toBeCloseTo(0, 5)
    expect(u.atRest).toBe(false)
    u.dispose()
  })

  it('a momentary button dips, holds its pulse, springs back lit-then-dark, and is at rest again by itself', () => {
    const u = IdleUseSession.open(BUTTON_DEVICE, { momentary: true })!
    u.press()
    const frames = play(u, 2.5)
    expect(Math.min(...frames.map(cap))).toBeCloseTo(-0.02, 6)
    expect(frames.filter((f) => cap(f) < -0.019).length).toBeGreaterThan(15) // the 0.3 s hold is played, not skipped
    expect(frames.some((f) => f.lamps?.cap === true)).toBe(true)
    expect(cap(u.pose)).toBeCloseTo(0, 6)
    expect(u.pose.lamps?.cap ?? false).toBe(false)
    expect(u.atRest).toBe(true)
    u.dispose()
  })

  it('a maintained button stays pressed and lit until pressed again', () => {
    const u = IdleUseSession.open(BUTTON_DEVICE, { momentary: false })!
    u.press()
    play(u, 1)
    expect(cap(u.pose)).toBeCloseTo(-0.02, 6)
    expect(u.pose.lamps?.cap).toBe(true)
    expect(u.atRest).toBe(false)
    u.press()
    play(u, 2.5)
    expect(cap(u.pose)).toBeCloseTo(0, 6)
    expect(u.atRest).toBe(true)
    u.dispose()
  })

  it('a continuous device keeps moving and never settles (a spun turntable is never "at rest")', () => {
    const u = IdleUseSession.open(CONTINUOUS_DEVICE, { speed: 90 })!
    u.press()
    const a = play(u, 3)
    expect(u.settled).toBe(false)
    expect(u.atRest).toBe(false)
    expect(a[a.length - 1]!.joints.deck!).toBeGreaterThan(a[0]!.joints.deck!)
    u.dispose()
  })

  it('a press that moves nothing leaves nothing held (a plain conveyor)', () => {
    const conveyor = `definePart({ interactive: true, step(ctx) { ctx.setSurfaceVelocity({ x: 1, y: 0, z: 0 }) } })`
    const u = IdleUseSession.open(conveyor, {})!
    u.press()
    play(u, 2)
    expect(u.atRest).toBe(true)
    u.dispose()
  })

  it('a stalled frame does not fast-forward the device (at most a tenth of a second per frame)', () => {
    const u = IdleUseSession.open(INTERACTIVE_DEVICE, { active: false })!
    u.press()
    u.advance(5) // a 5 s hitch
    expect(raise(u.pose)).toBeGreaterThan(0)
    expect(raise(u.pose)).toBeLessThan(0.1) // mid-sweep, not finished: the hitch was clamped
    u.dispose()
  })
})


// The real emergency stop, whose timing is the point: it latches in when struck, is released by a twist, and ignores
// a press that arrives mid-twist: the device that showed a replayed count of presses cannot stand in for a live one.
describe('the emergency stop, operated while stopped', () => {
  const pushButton = readFileSync(new URL('../../examples/parts/push-button/behavior.ts', import.meta.url), 'utf8')
  const params = { emergencyStop: true, enableComms: false }
  const FRAME = 1 / 60
  const depth = (u: IdleUseSession) => u.pose.subPoses['cap']?.position?.[2] ?? 0
  const turn = (u: IdleUseSession) => u.pose.subPoses['cap']?.rotation?.[2] ?? 0

  it('is struck in and stays in; the next press twists it out, promptly, and that ends the session', () => {
    const u = IdleUseSession.open(pushButton, params)!
    u.press()
    for (let i = 0; i < 90; i++) u.advance(FRAME)
    expect(depth(u)).toBeCloseTo(-0.007, 6) // far enough in to see it come back out
    expect(u.atRest).toBe(false)
    u.press()
    let turned = 0
    let outAt = -1
    for (let i = 0; i < 200; i++) {
      u.advance(FRAME)
      turned = Math.min(turned, turn(u))
      if (outAt < 0 && depth(u) > -0.0069) outAt = i
    }
    expect(turned).toBeLessThan(-0.5) // it visibly twisted
    expect(outAt * FRAME).toBeLessThanOrEqual(0.6) // and was on its way out within 0.6 s of the press
    expect(depth(u)).toBeCloseTo(0, 6)
    expect(turn(u)).toBeCloseTo(0, 6)
    expect(u.atRest).toBe(true)
    u.dispose()
  })

  it('a press that lands mid-twist is the device\'s to ignore, as in a run: it still comes out', () => {
    const u = IdleUseSession.open(pushButton, params)!
    u.press()
    for (let i = 0; i < 90; i++) u.advance(FRAME)
    u.press() // twist...
    for (let i = 0; i < 10; i++) u.advance(FRAME)
    u.press() // ...and press again mid-twist
    for (let i = 0; i < 200; i++) u.advance(FRAME)
    expect(depth(u)).toBeCloseTo(0, 6)
    expect(u.atRest).toBe(true)
    u.dispose()
  })

  it('settleIdlePose spaces its replayed presses, so it agrees: odd counts struck, even counts out', () => {
    for (let n = 0; n <= 6; n++) {
      const d = settleIdlePose(pushButton, params, n)?.subPoses['cap']?.position?.[2] ?? 0
      expect(d, `after ${n} presses`).toBeCloseTo(n % 2 === 1 ? -0.007 : 0, 6)
    }
    for (let n = 0; n <= 5; n++) {
      const d = settleIdlePose(pushButton, { momentary: false }, n)?.subPoses['cap']?.position?.[2] ?? 0
      expect(d, `maintained, after ${n} presses`).toBeCloseTo(n % 2 === 1 ? -0.01 : 0, 6)
    }
  })
})

// A device can hold still mid-cycle and then carry on: a session must not freeze it in the first quiet spell.
describe('IdleUseSession keeps stepping through a quiet spell', () => {
  it('a device that waits a second before it moves still moves (and is not taken for "back at rest" meanwhile)', () => {
    const DELAYED = `
      let t = -1, r = 0
      definePart({
        interactive: true,
        joints: ['raise'],
        step(ctx) {
          if (ctx.used()) t = 0
          if (t >= 0) t += ctx.dt
          const want = t >= 1 ? 1 : 0
          r = ctx.approach(r, want, ctx.dt / 0.15)
          ctx.joints.raise = r * 0.1
        },
      })
    `
    const u = IdleUseSession.open(DELAYED, {})!
    u.press()
    for (let i = 0; i < 55; i++) u.advance(1 / 60)
    expect(u.pose.joints.raise ?? 0).toBeCloseTo(0, 6) // still waiting...
    expect(u.atRest).toBe(false) // ...which is not the end of it: ending here would lose the press
    for (let i = 0; i < 90; i++) u.advance(1 / 60)
    expect(u.pose.joints.raise ?? 0).toBeCloseTo(0.1, 5) // ...and then it went
    u.dispose()
  })
})

// The push button's authored starting states: what the Inspector sets, and so what a stopped scene shows and a
// stopped Use starts from.
describe('push button starting states', () => {
  const pushButton = readFileSync(new URL('../../examples/parts/push-button/behavior.ts', import.meta.url), 'utf8')
  const depthOf = (p: IdlePose | null) => p?.subPoses['cap']?.position?.[2] ?? 0

  it('an E-stop set to start struck is shown struck, and a Use twists it out (away from the design)', () => {
    const params = { emergencyStop: true, startStruck: true }
    expect(depthOf(settleIdlePose(pushButton, params))).toBeCloseTo(-0.007, 6)
    const u = IdleUseSession.open(pushButton, params)!
    expect(depthOf(u.pose)).toBeCloseTo(-0.007, 6)
    expect(u.atRest).toBe(true) // struck is its design
    u.press()
    for (let i = 0; i < 200; i++) u.advance(1 / 60)
    expect(depthOf(u.pose)).toBeCloseTo(0, 6)
    expect(u.atRest).toBe(false) // out is what the press is holding
    u.dispose()
  })

  it('a maintained button can start pressed; a momentary one ignores it', () => {
    expect(depthOf(settleIdlePose(pushButton, { momentary: false, startPressed: true }))).toBeCloseTo(-0.01, 6)
    expect(depthOf(settleIdlePose(pushButton, { momentary: true, startPressed: true }))).toBeCloseTo(0, 6)
    expect(depthOf(settleIdlePose(pushButton, { momentary: false }))).toBeCloseTo(0, 6)
  })
})


describe('withJointRests', () => {
  // a turntable-shaped slow slew: 20 deg/s toward `deckAngleDeg`, so a 150 deg move outlasts the settle cap
  const SLOW_SLEW = `
let a = 0
definePart({
  joints: ['rotate'],
  params: { deckAngleDeg: { type: 'number', default: 0 } },
  step(ctx) {
    const d = ctx.params.deckAngleDeg - a
    a += Math.sign(d) * Math.min(Math.abs(d), 20 * ctx.dt)
    ctx.joints.rotate = a * Math.PI / 180
  },
})
`
  const JOINTS = [{ name: 'rotate', rest: { param: 'deckAngleDeg', scale: Math.PI / 180 } }]

  it('a slow discrete move the settle cap drops lands on the declared rest binding, not 0', () => {
    const settled = settleIdlePose(SLOW_SLEW, { deckAngleDeg: 150 })
    expect(settled?.joints.rotate).toBeUndefined() // the premise: still moving at the cap
    expect(withJointRests(settled, JOINTS, { deckAngleDeg: 150 })?.joints.rotate).toBeCloseTo((150 * Math.PI) / 180)
  })

  it('a joint the behavior did settle keeps the behavior value', () => {
    const pose = { joints: { rotate: 0.5 }, subPoses: {} }
    expect(withJointRests(pose, JOINTS, { deckAngleDeg: 150 })?.joints.rotate).toBe(0.5)
  })

  it('leaves a joint without a rest binding (or a missing param) alone', () => {
    expect(withJointRests(null, [{ name: 'rotate' }], { deckAngleDeg: 150 })).toBeNull()
    expect(withJointRests(null, JOINTS, {})).toBeNull()
  })
})
