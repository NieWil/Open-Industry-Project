/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest'
import { create, destroy, stepDirect } from './embeddedBehavior'
import type { BehaviorOutput } from './embeddedBehavior'

// The committed AGV behavior (examples/parts/agv), driven directly through the embeddable runtime with a toy
// integrator standing in for the world's root motion. Pins the PLC handshake against two ways to strand a
// program:
//   - a move that finishes in the tick that accepted it must still drop `done`, or a handshake waiting to
//     see the truck go busy waits for ever;
//   - a fork change written in the same scan as the next move must latch at this row's height, or a release
//     carries the load away (and a grab closes at the next stop, not the pick).
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const SOURCE = BEHAVIORS['../../examples/parts/agv/behavior.ts']!.replace(/\r\n/g, '\n')

const DT = 1 / 60
const ROUTE = [
  [0, 0, 0, 0], // 0 home, forks down
  [0, 0, 0, 1], // 1 the same spot with the tines at 1 m: a lift, standing still
  [3, 0, 0, 1], // 2 three metres on at the same height
  [3, 0, 0, 0], // 3 lower there
  [1.5, 0.4, 0, 0], // 4 a back-out from row 2: 1.5 m behind, 0.4 m to one side, same heading, tines down
]
const POS_TOL = 0.06
const PARAMS = {
  commandTag: 'Cmd', executeTag: 'Exec', doneTag: 'Done', forkTag: 'Fork', waypoints: ROUTE,
}

describe('AGV behavior - the PLC handshake', () => {
  let h = 0
  let x = 0, z = 0, yaw = 0
  const tags: Record<string, number | boolean> = { Cmd: 0, Exec: false, Fork: false }
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })
  const boot = (): void => {
    h = create(SOURCE, JSON.stringify(PARAMS))
    x = 0; z = 0; yaw = 0
    Object.assign(tags, { Cmd: 0, Exec: false, Fork: false })
  }
  const tick = (): BehaviorOutput => {
    const out = stepDirect(h, { simTime: 0, position: [x, 0, z], forward: [Math.cos(yaw), 0, -Math.sin(yaw)], tags: { ...tags } }, DT)!
    if (out.drive) {
      yaw += out.drive.turn * DT
      x += out.drive.forward * Math.cos(yaw) * DT
      z -= out.drive.forward * Math.sin(yaw) * DT
    }
    return out
  }
  /** the demo's handshake: raise execute, drop it once done is seen low, wait for done high again */
  const move = (cmd: number): BehaviorOutput => {
    tags['Cmd'] = cmd; tags['Exec'] = true
    let out = tick()
    expect(out.tags['Done']).toBe(false)
    tags['Exec'] = false
    for (let i = 0; i < 1200 && !out.tags['Done']; i++) out = tick()
    expect(out.tags['Done']).toBe(true)
    return out
  }

  it('done drops for a move that finishes in the tick it was accepted, and comes back once execute is released', () => {
    boot()
    expect(tick().tags['Done']).toBe(true) // parked at home
    tags['Cmd'] = 0; tags['Exec'] = true // home again: nothing to do
    expect(tick().tags['Done']).toBe(false) // ...but the command was seen
    expect(tick().tags['Done']).toBe(false) // and stays seen while execute is held
    tags['Exec'] = false
    tick() // the release is read this tick
    expect(tick().tags['Done']).toBe(true)
  })

  it('a program that holds execute until done is not deadlocked by it', () => {
    boot()
    tick()
    tags['Cmd'] = 0; tags['Exec'] = true
    let ticks = 0
    let out = tick()
    while (!out.tags['Done'] && ticks < 600) { out = tick(); ticks++ }
    expect(out.tags['Done']).toBe(true)
    expect(ticks * DT).toBeLessThan(0.6) // the half-second acknowledgement, not a hang
  })

  it('a release written in the same scan as the next move lets go here, before the truck or the tines move', () => {
    boot()
    tick()
    tags['Fork'] = true
    const lifted = move(1) // tines up to 1 m, standing still, grabbing there
    expect(lifted.grips['gripper']).toBe(true)
    expect(lifted.joints['lift']).toBeCloseTo(1, 6)

    tags['Fork'] = false; tags['Cmd'] = 3; tags['Exec'] = true // "let go, then go lower somewhere else"
    const out = tick()
    expect(out.grips['gripper']).toBe(false)
    expect(out.joints['lift']).toBeCloseTo(1, 6) // released at the height it was holding
    expect(out.drive?.forward ?? 0).toBe(0)
    expect(out.drive?.turn ?? 0).toBe(0)
    expect(out.tags['Done']).toBe(false) // and the move itself was accepted
  })

  it('a grab written in the same scan as the next move closes here, at the pick height', () => {
    boot()
    tick()
    move(1) // tines at 1 m, empty
    tags['Fork'] = true; tags['Cmd'] = 2; tags['Exec'] = true // "take it, then drive"
    const out = tick()
    expect(out.grips['gripper']).toBe(true)
    expect(out.joints['lift']).toBeCloseTo(1, 6)
    expect(out.drive?.forward ?? 0).toBe(0)
    tags['Exec'] = false
    let o = out
    for (let i = 0; i < 1200 && !o.tags['Done']; i++) o = tick()
    expect(Math.abs(x - 3)).toBeLessThanOrEqual(POS_TOL) // it still made the trip
    expect(o.grips['gripper']).toBe(true) // carrying
  })
})

describe('AGV behavior - backing out of a bay', () => {
  let h = 0
  let x = 0, z = 0, yaw = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })
  const tick = (tags: Record<string, number | boolean>): BehaviorOutput => {
    const out = stepDirect(h, { simTime: 0, position: [x, 0, z], forward: [Math.cos(yaw), 0, -Math.sin(yaw)], tags }, DT)!
    if (out.drive) {
      yaw += out.drive.turn * DT
      x += out.drive.forward * Math.cos(yaw) * DT
      z -= out.drive.forward * Math.sin(yaw) * DT
    }
    return out
  }
  const run = (cmd: number, each?: (out: BehaviorOutput) => void): BehaviorOutput => {
    let out = tick({ Cmd: cmd, Exec: true, Fork: false })
    each?.(out)
    for (let i = 0; i < 2400 && !out.tags['Done']; i++) {
      out = tick({ Cmd: cmd, Exec: false, Fork: false })
      each?.(out)
    }
    expect(out.tags['Done']).toBe(true)
    return out
  }

  it('lowers first, reverses straight without turning, then ends on the target rather than beside it', () => {
    h = create(SOURCE, JSON.stringify(PARAMS))
    x = 0; z = 0; yaw = 0
    tick({ Cmd: 0, Exec: false, Fork: false })
    run(2) // into the "bay": x = 3, facing +x, tines at 1 m
    expect(Math.abs(x - 3)).toBeLessThanOrEqual(POS_TOL)

    let backing = true
    let movedBeforeLowered = false
    let turnedWhileBacking = false
    let reversed = false
    run(4, (out) => {
      const f = out.drive?.forward ?? 0, t = out.drive?.turn ?? 0
      if (out.joints['lift']! > 1e-3 && (f !== 0 || t !== 0)) movedBeforeLowered = true
      if (f < 0) reversed = true
      if (backing && f < 0 && t !== 0) turnedWhileBacking = true
      if (reversed && f >= 0) backing = false // the straight withdrawal is over
    })
    expect(reversed).toBe(true) // it backed out rather than turning round in the bay
    expect(movedBeforeLowered).toBe(false)
    expect(turnedWhileBacking).toBe(false)
    expect(Math.hypot(x - 1.5, z - 0.4)).toBeLessThanOrEqual(POS_TOL) // not 0.4 m to one side
    expect(Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw)))).toBeLessThanOrEqual(0.25 * Math.PI / 180 + 1e-9)
  })
})
