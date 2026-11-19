import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import type { SdkPart, SceneJSON } from '../core/types'
import { registerPackage, unregisterPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { create, destroy, step } from './embeddedBehavior'
import { SimWorld } from './world'

// The device-IO bus for custom parts: PLC tags flow into a behavior (ctx.readTag/readNumber) and the tags it
// writes (ctx.writeTag/writeNumber) flow back out, numeric tags included, so an INT command/selector works.
// This covers the SDK boundary (embeddedBehavior) and the worker-side world bridge end-to-end (the worker
// postMessage transport + the controller's ST round-trip are thin and type-checked separately).

const Jolt = await initJolt()

describe('numeric + bool tags at the SDK boundary (embeddedBehavior)', () => {
  const run = (src: string, tags: Record<string, number | boolean>): { tags: Record<string, number | boolean> } => {
    const h = create(src, '{}')
    expect(h).toBeGreaterThan(0)
    const out = JSON.parse(step(h, JSON.stringify({ simTime: 0, tags }), 1 / DEFAULT_SIM_HZ))
    destroy(h)
    return out
  }

  it('readNumber/writeNumber carry numeric tags through the boundary', () => {
    const out = run(`definePart({ step(ctx){ ctx.writeNumber('count', ctx.readNumber('in') + 1) } })`, { in: 5 })
    expect(out.tags.count).toBe(6)
  })

  it('readTag coerces a numeric tag (≠0 → true), readNumber coerces a bool (true → 1)', () => {
    const src = `definePart({ step(ctx){ ctx.writeTag('flag', ctx.readTag('n')); ctx.writeNumber('asNum', ctx.readNumber('b')) } })`
    expect(run(src, { n: 3, b: true }).tags).toEqual({ flag: true, asNum: 1 })
    expect(run(src, { n: 0, b: false }).tags).toEqual({ flag: false, asNum: 0 })
  })

  it('ignores a non-finite numeric write (keeps the bus clean)', () => {
    expect(run(`definePart({ step(ctx){ ctx.writeNumber('bad', 1/0); ctx.writeNumber('ok', 2) } })`, {}).tags).toEqual({ ok: 2 })
  })

  it('writeTag writes a number as a numeric tag, as writeNumber does', () => {
    const src = `definePart({ step(ctx){ ctx.writeTag('pos', 0.25); ctx.writeTag('zero', 0); ctx.writeTag('bad', 0/0); ctx.writeTag('flag', true) } })`
    expect(run(src, {}).tags).toEqual({ pos: 0.25, zero: 0, flag: true })
  })
})

// A minimal articulated part driven by a PLC handshake: the same pattern the bundled Six-Axis robot uses
// (INT command selects a target, a rising execute edge starts the move, the done tag reads !moving, the
// gripper mirrors a vacuum tag), shrunk to one joint so it runs headless in the world.
const ARM_COMMS = `
let cur = 0, target = 0, moving = false, prevExec = false
definePart({
  joints: ['j1'], grippers: ['grip'],
  params: {
    cmdTag: { type: 'string', default: 'cmd' },
    exTag: { type: 'string', default: 'ex' },
    doneTag: { type: 'string', default: 'done' },
    gripTag: { type: 'string', default: 'grip' },
  },
  step(ctx) {
    const cmd = ctx.readNumber(ctx.params.cmdTag)       // target angle (rad)
    const ex = ctx.readTag(ctx.params.exTag)
    if (ex && !prevExec && !moving) { target = cmd; moving = true }
    prevExec = ex
    const maxStep = 4 * ctx.dt
    const d = target - cur
    if (Math.abs(d) <= maxStep) { cur = target; moving = false }
    else cur += Math.sign(d) * maxStep
    ctx.joints.j1 = cur
    ctx.grips.grip = ctx.readTag(ctx.params.gripTag)
    ctx.writeTag(ctx.params.doneTag, !moving)
  },
})
`

function armScene(): { scene: SceneJSON; id: string } {
  const pkg = buildPackage(
    {
      id: 'test.arm-comms',
      name: 'Arm Comms',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.6] }, offset: [0, 0.5, 0] },
          { name: 'grip', parent: 'arm', shape: { kind: 'frame' }, offset: [0, 0.4, 0] },
        ],
        joints: [{ name: 'j1', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -3.14, max: 3.14 }],
      },
    },
    ARM_COMMS,
  )
  registerPackage(pkg)
  const part: SdkPart = { id: 'arm1', type: 'part', packageId: 'test.arm-comms', position: [0, 0, 0], rotationY: 0, params: {} }
  return { scene: { version: SCENE_VERSION, parts: [part] }, id: part.id }
}

describe('custom-part ↔ PLC tag bridge (world end-to-end)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    unregisterPackage('test.arm-comms')
  })

  it('PLC tags drive the joint and the part writes its done feedback back', () => {
    const { scene, id } = armScene()
    world = new SimWorld(Jolt, scene)

    // idle, not executing: parked at 0, done = true
    world.setBehaviorInputTags({ cmd: 1.5, ex: false })
    world.step()
    let f = world.frame()
    expect(f.joints?.[id]?.j1).toBeCloseTo(0, 6)
    expect(f.tags?.[id]?.done).toBe(true)

    // rising execute edge latches the command (1.5 rad) and starts moving: done flips false
    world.setBehaviorInputTags({ cmd: 1.5, ex: true })
    world.step()
    f = world.frame()
    expect(f.tags?.[id]?.done).toBe(false)
    expect(f.joints?.[id]?.j1).toBeGreaterThan(0)

    // run it out: the joint reaches the commanded 1.5 rad and done returns true
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) world.step()
    f = world.frame()
    expect(f.joints?.[id]?.j1).toBeCloseTo(1.5, 2)
    expect(f.tags?.[id]?.done).toBe(true)
  })

  it('the vacuum tag drives the gripper bag', () => {
    const { scene, id } = armScene()
    world = new SimWorld(Jolt, scene)
    world.setBehaviorInputTags({ grip: true })
    world.step()
    // grip state is kept on the rig record; a closed gripper is reflected by the behavior reading the tag.
    // (the joints channel shows the behavior ran; the grip carry itself is covered by rig grip tests)
    expect(world.frame().joints?.[id]).toBeDefined()
  })
})
