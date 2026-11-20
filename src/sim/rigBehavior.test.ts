import { describe, expect, it } from 'vitest'
import { create, destroy, step } from './embeddedBehavior'

// The rig/joint substrate at the behavior layer: a custom part's portable script can command named joints
// each tick via ctx.setJoint, and the runtime emits them in the step output for the host to apply. Pure
// behavior layer (no render/sim). Mirrors how setSurfaceVelocity/tags flow.

const ARM = `
definePart({
  params: { rate: { type: 'number', default: 1 } },
  step(ctx) {
    ctx.setJoint('shoulder', Math.sin(ctx.simTime * ctx.params.rate))
    ctx.setJoint('elbow', ctx.simTime * 0.5)
  },
})
`

function run(source: string, simTime: number, paramsJson = '{}'): { surfaceVelocity: number[]; tags: Record<string, boolean>; joints: Record<string, number> } {
  const h = create(source, paramsJson)
  expect(h).toBeGreaterThan(0)
  const out = JSON.parse(step(h, JSON.stringify({ simTime, position: [0, 0, 0], forward: [1, 0, 0], tags: {} }), 1 / 60))
  destroy(h)
  return out
}

describe('rig joint commands (ctx.setJoint)', () => {
  it('emits commanded joint values in the step output', () => {
    const out = run(ARM, 2)
    expect(out.joints.shoulder).toBeCloseTo(Math.sin(2), 10)
    expect(out.joints.elbow).toBeCloseTo(1, 10)
  })

  it('is deterministic and param-driven', () => {
    expect(run(ARM, 1.5, JSON.stringify({ rate: 2 }))).toEqual(run(ARM, 1.5, JSON.stringify({ rate: 2 })))
    // a different rate changes the shoulder angle
    const fast = run(ARM, 1.5, JSON.stringify({ rate: 2 })).joints.shoulder ?? NaN
    const slow = run(ARM, 1.5, JSON.stringify({ rate: 1 })).joints.shoulder ?? NaN
    expect(fast).not.toBeCloseTo(slow, 6)
  })

  it('resets joints each tick (only what step() commands is emitted)', () => {
    const src = `definePart({ step(ctx){ if (ctx.readTag('go')) ctx.setJoint('j', 1) } })`
    const h = create(src, '{}')
    const withGo = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { go: true } }), 1 / 60))
    const without = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { go: false } }), 1 / 60))
    destroy(h)
    expect(withGo.joints).toEqual({ j: 1 })
    expect(without.joints).toEqual({}) // not carried over from the previous tick
  })

  it('ignores a non-finite joint value (keeps the output clean for the host)', () => {
    const src = `definePart({ step(ctx){ ctx.setJoint('bad', 0/0); ctx.setJoint('ok', 0.5) } })`
    const out = run(src, 0)
    expect(out.joints).toEqual({ ok: 0.5 })
  })

  it('object-style ctx.joints / ctx.grips write the same commands as setJoint / setGrip', () => {
    const h = create(`definePart({ step(ctx){ ctx.joints.shoulder = 0.5; ctx.grips.hand = true } })`, '{}')
    const out = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { joints: Record<string, number>; grips: Record<string, boolean> }
    destroy(h)
    expect(out.joints).toEqual({ shoulder: 0.5 })
    expect(out.grips).toEqual({ hand: true })
  })

  it('the property bag reads back the last-commanded state (no silent undefined)', () => {
    // write then read in the same tick; reading must return what was commanded, not undefined
    const src = `definePart({
      joints: ['shoulder'], grippers: ['hand'],
      step(ctx){
        ctx.joints.shoulder = 0.5
        ctx.grips.hand = true
        // command a SECOND joint from the first's read-back value - proves get works
        ctx.joints.elbow = ctx.joints.shoulder * 2
        if (ctx.grips.hand) ctx.writeTag('holding', true)
      },
    })`
    const out = JSON.parse(step(create(src, '{}'), JSON.stringify({ simTime: 0 }), 1 / 60)) as {
      joints: Record<string, number>
      grips: Record<string, boolean>
      tags: Record<string, boolean>
    }
    expect(out.joints).toEqual({ shoulder: 0.5, elbow: 1 })
    expect(out.grips).toEqual({ hand: true })
    expect(out.tags).toEqual({ holding: true })
  })

  it('ctx.lamps / setEmissive emit lamp states, reset each tick, read back, and declare a rest (off) state', () => {
    // emit + read-back + a second lamp driven from the first's read-back value
    const src = `definePart({
      lamps: ['red', 'green'],
      step(ctx){
        ctx.lamps.red = ctx.readTag('fault')
        ctx.setEmissive('green', !ctx.readTag('fault'))
        ctx.writeTag('greenReadBack', ctx.lamps.green)
      },
    })`
    const h = create(src, '{}')
    const fault = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { fault: true } }), 1 / 60)) as { lamps: Record<string, boolean>; tags: Record<string, boolean> }
    const clear = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { fault: false } }), 1 / 60)) as { lamps: Record<string, boolean> }
    destroy(h)
    expect(fault.lamps).toEqual({ red: true, green: false })
    expect(fault.tags).toEqual({ greenReadBack: false })
    expect(clear.lamps).toEqual({ red: false, green: true }) // reset + recomputed each tick
  })

  it('ctx.sense reads a beam hit handed in by the host (C-sensing), clear by default', () => {
    const src = `definePart({ step(ctx){ const s = ctx.sense('lens'); ctx.writeTag('present', s.hit); ctx.writeNumber('dist', s.distance) } })`
    const h = create(src, '{}')
    const hit = JSON.parse(step(h, JSON.stringify({ simTime: 0, beams: { lens: { hit: true, distance: 0.42, color: [1, 0, 0] } } }), 1 / 60)) as { tags: Record<string, number | boolean> }
    const clear = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { tags: Record<string, number | boolean> }
    destroy(h)
    expect(hit.tags).toEqual({ present: true, dist: 0.42 })
    expect(clear.tags).toEqual({ present: false, dist: 0 }) // unknown beam → clear (reset each tick)
  })

  it('ctx.used() reads the per-tick interaction pulse (C-interaction)', () => {
    const src = `definePart({ interactive: true, step(ctx){ ctx.writeTag('pressed', ctx.used()) } })`
    const h = create(src, '{}')
    const used = JSON.parse(step(h, JSON.stringify({ simTime: 0, used: true }), 1 / 60)) as { tags: Record<string, boolean> }
    const notUsed = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { tags: Record<string, boolean> }
    destroy(h)
    expect(used.tags).toEqual({ pressed: true })
    expect(notUsed.tags).toEqual({ pressed: false }) // edge-shaped: only the tick after the click
  })

  it('ctx.conveyorRunning reads the scene conveyor-speed map (spawner interlock)', () => {
    const src = `definePart({ params:{ target:{ type:'partRef', default:'' } }, step(ctx){ ctx.writeTag('run', ctx.conveyorRunning(ctx.params.target)) } })`
    const h = create(src, JSON.stringify({ target: 'belt1' }))
    const stopped = JSON.parse(step(h, JSON.stringify({ simTime: 0, conveyorSpeeds: { belt1: 0 } }), 1 / 60)) as { tags: Record<string, boolean> }
    const running = JSON.parse(step(h, JSON.stringify({ simTime: 0, conveyorSpeeds: { belt1: 1.5 } }), 1 / 60)) as { tags: Record<string, boolean> }
    const dangling = JSON.parse(step(h, JSON.stringify({ simTime: 0, conveyorSpeeds: { other: 1 } }), 1 / 60)) as { tags: Record<string, boolean> }
    destroy(h)
    expect(stopped.tags).toEqual({ run: false }) // a real stopped conveyor (speed 0) → interlock holds
    expect(running.tags).toEqual({ run: true }) // running → free
    expect(dangling.tags).toEqual({ run: true }) // unknown/dangling id → inert (reads as running)

    // an unset partRef ('') is never an interlock: always runs
    const h2 = create(src, JSON.stringify({ target: '' }))
    const unset = JSON.parse(step(h2, JSON.stringify({ simTime: 0, conveyorSpeeds: { belt1: 0 } }), 1 / 60)) as { tags: Record<string, boolean> }
    destroy(h2)
    expect(unset.tags).toEqual({ run: true })
  })

  it('ctx.spawn emits cargo-spawn requests (C-spawn), reset each tick and capped', () => {
    const h = create(`definePart({ step(ctx){ ctx.spawn({ size:[0.6,0.4,0.4], color:[1,0,0], mass:5, offset:[0,-0.2,0] }) } })`, '{}')
    const out = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { spawns: unknown[] }
    const next = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { spawns: unknown[] }
    destroy(h)
    expect(out.spawns).toEqual([{ size: [0.6, 0.4, 0.4], color: [1, 0, 0], offset: [0, -0.2, 0], mass: 5 }])
    expect(next.spawns).toEqual([{ size: [0.6, 0.4, 0.4], color: [1, 0, 0], offset: [0, -0.2, 0], mass: 5 }]) // re-emitted, not accumulated

    // a flood is capped at 8 per tick; non-finite/invalid opts are dropped
    const h2 = create(`definePart({ step(ctx){ for(let i=0;i<20;i++) ctx.spawn(); ctx.spawn({ size:[1,0/0,1] }) } })`, '{}')
    const out2 = JSON.parse(step(h2, JSON.stringify({ simTime: 0 }), 1 / 60)) as { spawns: unknown[] }
    destroy(h2)
    expect(out2.spawns).toHaveLength(8)
    expect(out2.spawns[0]).toEqual({}) // ctx.spawn() with no opts → defaults applied by the host
  })

  it('ctx.zone reads the cargo count + ctx.despawn requests removal (C-despawn)', () => {
    const src = `definePart({ step(ctx){ const n = ctx.zone('exit'); ctx.writeNumber('count', n); if(n>0) ctx.despawn('exit') } })`
    const h = create(src, '{}')
    const inZone = JSON.parse(step(h, JSON.stringify({ simTime: 0, zones: { exit: 3 } }), 1 / 60)) as { tags: Record<string, number>; despawns: string[] }
    const empty = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { tags: Record<string, number>; despawns: string[] }
    destroy(h)
    expect(inZone.tags).toEqual({ count: 3 })
    expect(inZone.despawns).toEqual(['exit'])
    expect(empty.tags).toEqual({ count: 0 }) // unknown zone reads 0
    expect(empty.despawns).toEqual([]) // reset each tick
  })

  it('ctx.spawn carries a pallet kind (C-spawn kind)', () => {
    const h = create(`definePart({ step(ctx){ ctx.spawn({ kind:'pallet', color:[0.5,0.3,0.1] }); ctx.spawn({ size:[0.6,0.4,0.4] }) } })`, '{}')
    const out = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { spawns: { kind?: string }[] }
    destroy(h)
    expect(out.spawns[0]).toEqual({ kind: 'pallet', color: [0.5, 0.3, 0.1] }) // pallet kind preserved
    expect(out.spawns[1]).toEqual({ size: [0.6, 0.4, 0.4] }) // a plain box has no kind
  })

  it('ctx.setSubPose emits a free-form link pose override', () => {
    const h = create(`definePart({ step(ctx){ ctx.setSubPose('hand', { position: [0, ctx.simTime, 0], rotation: [0, 0, 0] }) } })`, '{}')
    const out = JSON.parse(step(h, JSON.stringify({ simTime: 2 }), 1 / 60)) as { subPoses: Record<string, { position?: number[]; rotation?: number[] }> }
    destroy(h)
    expect(out.subPoses).toEqual({ hand: { position: [0, 2, 0], rotation: [0, 0, 0] } })
  })

  it('ctx.setSubPose takes a quat, normalised, in place of the Euler rotation; a zero quat is dropped', () => {
    const h = create(`definePart({ step(ctx){ ctx.setSubPose('tray', { quat: [0, 0, 2, 0], rotation: [1, 2, 3] }); ctx.setSubPose('bad', { quat: [0, 0, 0, 0], rotation: [0, 1, 0] }) } })`, '{}')
    const out = JSON.parse(step(h, JSON.stringify({ simTime: 0 }), 1 / 60)) as { subPoses: Record<string, { rotation?: number[]; quat?: number[] }> }
    destroy(h)
    expect(out.subPoses).toEqual({ tray: { quat: [0, 0, 1, 0] }, bad: { rotation: [0, 1, 0] } })
  })

  it('ctx.drive emits a base velocity command (C-drive), reset each tick, finite-guarded', () => {
    // a navigator commands forward speed + yaw rate; absent when not commanded
    const src = `definePart({ step(ctx){ if (ctx.readTag('go')) ctx.drive(1.5, 0.3) } })`
    const h = create(src, '{}')
    const moving = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { go: true } }), 1 / 60)) as { drive?: { forward: number; turn: number } }
    const idle = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { go: false } }), 1 / 60)) as { drive?: { forward: number; turn: number } }
    destroy(h)
    expect(moving.drive).toEqual({ forward: 1.5, turn: 0.3 })
    expect(idle.drive).toBeUndefined() // not commanded → no drive channel (reset each tick)

    // a non-finite command is dropped (keeps the integration clean)
    const h2 = create(`definePart({ step(ctx){ ctx.drive(0/0, 1) } })`, '{}')
    const bad = JSON.parse(step(h2, JSON.stringify({ simTime: 0 }), 1 / 60)) as { drive?: unknown }
    destroy(h2)
    expect(bad.drive).toBeUndefined()
  })

  it('ctx.setArcSurfaceVelocity emits an arc field (C-convey rotational), reset each tick, finite-guarded', () => {
    const src = `definePart({ step(ctx){ if (ctx.readTag('go')) ctx.setArcSurfaceVelocity({ center: { x: 2, z: -3 }, omega: 0.5 }) } })`
    const h = create(src, '{}')
    const on = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { go: true } }), 1 / 60)) as { arc?: { cx: number; cz: number; omega: number } }
    const off = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags: { go: false } }), 1 / 60)) as { arc?: unknown }
    destroy(h)
    expect(on.arc).toEqual({ cx: 2, cz: -3, omega: 0.5 })
    expect(off.arc).toBeUndefined() // not commanded → no arc channel (reset each tick)

    // a non-finite centre/omega is dropped
    const h2 = create(`definePart({ step(ctx){ ctx.setArcSurfaceVelocity({ center: { x: 0/0, z: 0 }, omega: 1 }) } })`, '{}')
    const bad = JSON.parse(step(h2, JSON.stringify({ simTime: 0 }), 1 / 60)) as { arc?: unknown }
    destroy(h2)
    expect(bad.arc).toBeUndefined()
  })

  it('declared joints/grippers read their rest state (0 / open) before being commanded', () => {
    const src = `definePart({
      joints: ['shoulder'], grippers: ['hand'],
      step(ctx){
        ctx.writeTag('atRest', ctx.joints.shoulder === 0 && ctx.grips.hand === false)
      },
    })`
    const out = JSON.parse(step(create(src, '{}'), JSON.stringify({ simTime: 0 }), 1 / 60)) as { tags: Record<string, boolean> }
    expect(out.tags).toEqual({ atRest: true })
  })

  it('ctx.measured.joints feeds back the host-applied pose, separate from the command bag (closed-loop read)', () => {
    // The script commands `lift` but reads its feedback; we echo the feedback onto a tag to observe it.
    const src = `definePart({
      joints: ['lift'],
      step(ctx){
        ctx.joints.lift = 2.0 // command - must NOT change what measured reads back
        ctx.writeNumber('pos', ctx.measured.joints.lift)
      },
    })`
    const h = create(src, '{}')
    const numOf = (json: string) => (JSON.parse(json) as { tags: Record<string, number> }).tags.pos
    const inWith = (joints?: Record<string, number>) => JSON.stringify({ simTime: 0, joints })
    // first tick: no feedback yet → declared joint reads its rest value (0), not the commanded 2.0
    expect(numOf(step(h, inWith(), 1 / 60))).toBe(0)
    // host feeds back the applied (clamped) pose → measured reflects it next tick (still not the command)
    expect(numOf(step(h, inWith({ lift: 0.5 }), 1 / 60))).toBe(0.5)
    // merge, not replace: a tick that reports no feedback for `lift` holds its last measured value
    expect(numOf(step(h, inWith({}), 1 / 60))).toBe(0.5)
    destroy(h)
  })

  it('ctx.measured.grips feeds back the host held-state, separate from the command bag (closed-loop read)', () => {
    // The script always commands the gripper shut but reads whether it actually holds cargo.
    const src = `definePart({
      grippers: ['hand'],
      step(ctx){
        ctx.grips.hand = true // command - must NOT change what the feedback reads back
        ctx.writeTag('holding', ctx.measured.grips.hand)
      },
    })`
    const h = create(src, '{}')
    const boolOf = (json: string) => (JSON.parse(json) as { tags: Record<string, boolean> }).tags.holding
    const inWith = (grips?: Record<string, boolean>) => JSON.stringify({ simTime: 0, grips })
    // first tick: no feedback yet → declared gripper reads its rest state (false), not the commanded true
    expect(boolOf(step(h, inWith(), 1 / 60))).toBe(false)
    // host reports an actual catch → measured reflects it next tick (still not just the command)
    expect(boolOf(step(h, inWith({ hand: true }), 1 / 60))).toBe(true)
    // host reports a release → measured goes back to false
    expect(boolOf(step(h, inWith({ hand: false }), 1 / 60))).toBe(false)
    destroy(h)
  })
})
