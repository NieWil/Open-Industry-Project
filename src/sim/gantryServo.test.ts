import { describe, expect, it } from 'vitest'
import { rigJointsJson, type PartPackageGeometry } from '../core/parts/partPackage'
import { create, destroy, stepDirect, type BehaviorOutput } from './embeddedBehavior'

// The shipped gantry on its three servo axes, driven the way a PLC drives it: tags in, tags out, one tick at a time.
// Waypoint mode (the command tag picks a taught row) and position control (X/Y/Z target tags), both coordinated.

const RIGS = import.meta.glob('../../examples/parts/gantry/rig.json', { eager: true, import: 'default' }) as Record<string, { geometry: PartPackageGeometry }>
const SOURCES = import.meta.glob('../../examples/parts/gantry/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const geometry = Object.values(RIGS)[0]!.geometry
const source = Object.values(SOURCES)[0]!

const DT = 1 / 60
const TAGS = { executeTag: 'Exe', commandTag: 'Cmd', doneTag: 'Done', faultTag: 'Fault', targetXTag: 'TX', targetYTag: 'TY', targetZTag: 'TZ', actualXTag: 'AX', actualYTag: 'AY', actualZTag: 'AZ' }

class Gantry {
  private h: number
  tags: Record<string, number | boolean> = { Exe: false }
  out!: BehaviorOutput
  trace: Array<[number, number, number]> = []
  constructor(params: Record<string, unknown>) {
    this.h = create(source, JSON.stringify(params), rigJointsJson(geometry))
    expect(this.h).toBeGreaterThan(0)
  }
  tick(n = 1): this {
    for (let i = 0; i < n; i++) {
      // every tag the test sets stands for a program driving it (an enable tag counts only while driven)
      const out = stepDirect(this.h, { tags: { ...this.tags }, driven: { ...this.tags } }, DT)
      expect(out).not.toBeNull()
      this.out = out!
      for (const [k, v] of Object.entries(out!.tags)) this.tags[k] = v
      this.trace.push([out!.joints.x!, out!.joints.y!, out!.joints.z!])
    }
    return this
  }
  get pose() { return this.trace.at(-1)! }
  /** raise Execute for a tick, drop it, and run until Done (or a cap) */
  execute(cap = 2000): number {
    this.tags.Exe = true
    this.tick()
    this.tags.Exe = false
    let n = 1
    while (n < cap && this.tags.Done !== true) { this.tick(); n++ }
    return n
  }
  dispose() { destroy(this.h) }
}

describe('gantry on servos', () => {
  it('with no tags named it holds home, on its authored idle vacuum', () => {
    const g = new Gantry({ vacuumOn: true }).tick(120)
    expect(g.pose).toEqual([0, 0, 0])
    expect(g.out.grips.gripper).toBe(true)
    expect(g.out.lamps.vacuumLamp).toBe(true)
    g.dispose()
  })

  it('waypoint mode: the command picks a row, the move is coordinated and lands exactly, Done hands back', () => {
    const g = new Gantry({ ...TAGS }).tick()
    expect(g.tags.Done).toBe(true)
    g.tags.Cmd = 1
    g.tags.Exe = true
    g.tick()
    expect(g.tags.Done).toBe(false) // busy from the first tick
    g.tags.Exe = false
    while (g.tags.Done !== true) g.tick()
    expect(g.pose).toEqual([-1.4, 0.6, 0.7])
    // a straight line: every sample on the segment from home to the row (each axis's share of the path equal)
    for (const [x, y, z] of g.trace) {
      const u = x / -1.4
      expect(y).toBeCloseTo(0.6 * u, 9)
      expect(z).toBeCloseTo(0.7 * u, 9)
    }
    expect(g.tags.AX).toBe(-1.4)
    expect(g.tags.Fault).toBe(false)
    g.dispose()
  })

  it('the profile honours the speed and accel params on the longest axis', () => {
    const g = new Gantry({ ...TAGS, speed: 0.8, accel: 2 }).tick()
    g.tags.Cmd = 2
    g.execute()
    let peakV = 0
    let peakA = 0
    const xs = g.trace.map((p) => p[0])
    for (let i = 1; i < xs.length; i++) {
      const v = (xs[i]! - xs[i - 1]!) / DT
      peakV = Math.max(peakV, Math.abs(v))
      if (i > 1) peakA = Math.max(peakA, Math.abs(v - (xs[i - 1]! - xs[i - 2]!) / DT) / DT)
    }
    expect(peakV).toBeCloseTo(0.8, 6)
    expect(peakA).toBeLessThanOrEqual(2 * (1 + 1e-6))
    // 1.4 m at 0.8 m/s with 2 m/s² ramps: 0.4 s each way plus 1.35 s cruising, about 2.15 s
    expect(g.trace.length * DT).toBeGreaterThan(2.1)
    expect(g.trace.length * DT).toBeLessThan(2.3)
    g.dispose()
  })

  it('a taught row outside the frame parks at the frame limit', () => {
    const g = new Gantry({ ...TAGS, waypoints: [[0, 0, 0], [9, 0, 0]] }).tick()
    g.tags.Cmd = 1
    g.execute()
    expect(g.pose[0]).toBeCloseTo((4 - 0.12) / 2, 12)
    expect(g.tags.Fault).toBe(false)
    g.dispose()
  })

  it('position control: X/Y/Z targets in metres, actual positions reported', () => {
    const g = new Gantry({ ...TAGS, mode: 'position' }).tick()
    Object.assign(g.tags, { TX: 1.25, TY: -0.5, TZ: 0.3 })
    g.execute()
    expect(g.pose).toEqual([1.25, -0.5, 0.3])
    expect([g.tags.AX, g.tags.AY, g.tags.AZ]).toEqual([1.25, -0.5, 0.3])
    expect(g.tags.Fault).toBe(false)
    g.dispose()
  })

  it('position control: a target past the frame drives toward its end and stops short in a fault; the other axes halt; Done hands back', () => {
    const g = new Gantry({ ...TAGS, mode: 'position' }).tick()
    Object.assign(g.tags, { TX: 0.5, TY: 0, TZ: 5 }) // the lift reaches 0.775 m on a 1 m frame
    g.execute()
    g.tick(60)
    const [x, , z] = g.pose
    expect(z).toBeGreaterThan(0.5)
    expect(Math.max(...g.trace.map((p) => p[2]))).toBeLessThan(0.775)
    expect(x).toBeLessThan(0.5) // X halted with it, short of its own target
    expect(g.tags.Fault).toBe(true)
    expect(g.tags.Done).toBe(true)
    // the next good move clears it
    g.tags.TZ = 0.5
    g.execute()
    expect(g.tags.Fault).toBe(false)
    expect(g.pose[0]).toBeCloseTo(0.5, 12)
    expect(g.pose[2]).toBeCloseTo(0.5, 12)
    g.dispose()
  })

  it('follow: with Execute held each axis tracks its streamed setpoint every tick; Done while on it; dropping Execute halts', () => {
    const g = new Gantry({ ...TAGS, mode: 'follow' }).tick()
    g.tags.Exe = true
    // a PLC-planned path: each axis on its own ramp, streamed one setpoint per scan
    for (let i = 1; i <= 60; i++) {
      Object.assign(g.tags, { TX: 0.01 * i, TY: -0.005 * i, TZ: 0.004 * i })
      g.tick()
      expect(g.pose[0]).toBeCloseTo(0.01 * i, 12)
      expect(g.pose[1]).toBeCloseTo(-0.005 * i, 12)
      expect(g.pose[2]).toBeCloseTo(0.004 * i, 12)
    }
    g.tick()
    expect(g.tags.Done).toBe(true) // the setpoints stopped changing and the axes sit on them
    expect([g.tags.AX, g.tags.AY, g.tags.AZ].map((v) => +(v as number).toFixed(9))).toEqual([0.6, -0.3, 0.24])
    expect(g.tags.Fault).toBe(false)
    // a setpoint that jumps is chased at the axis limits, not teleported to; Done drops while it catches up
    g.tags.TX = 1.5
    g.tick()
    expect(g.pose[0]).toBeGreaterThan(0.6)
    expect(g.pose[0]).toBeLessThan(1.5)
    g.tick()
    expect(g.tags.Done).toBe(false)
    // drop Execute mid-chase: the axis halts. It brakes from the speed it had, which may carry it past the
    // setpoint (a halt does not aim at anything), and then stays put
    g.tags.Exe = false
    g.tick(120)
    const stopped = g.pose[0]
    g.tick(30)
    expect(g.pose[0]).toBe(stopped)
    g.dispose()
  })

  it('follow: a setpoint past the frame parks that axis at the frame end, Done false; the others keep following', () => {
    const g = new Gantry({ ...TAGS, mode: 'follow' }).tick()
    g.tags.Exe = true
    for (let i = 1; i <= 200; i++) {
      Object.assign(g.tags, { TX: 0.005 * i, TY: 0, TZ: 0.006 * i }) // the lift reaches 0.775 m on a 1 m frame
      g.tick()
    }
    g.tick(60)
    expect(Math.max(...g.trace.map((p) => p[2]))).toBe(0.775) // parked at the end of travel, never past it
    expect(g.pose[0]).toBeCloseTo(1, 12) // X followed its own setpoint all the way
    expect(g.tags.Done).toBe(false) // the lift is not on its setpoint, which is how the program sees it
    expect(g.tags.Fault).toBe(false) // a faulting limit is the program's axis's, not the follower's
    // bring the setpoint back inside and it follows again
    g.tags.TZ = 0.5
    g.tick(60)
    expect(g.pose[2]).toBeCloseTo(0.5, 12)
    expect(g.tags.Done).toBe(true)
    g.dispose()
  })

  it('follow: with the drives off the setpoints are refused and Fault reads true; the next Execute with them on clears it', () => {
    const g = new Gantry({ ...TAGS, enableTag: 'En', mode: 'follow' })
    g.tags.En = false
    Object.assign(g.tags, { TX: 0.5, TY: 0, TZ: 0, Exe: true })
    g.tick(5)
    expect(g.pose).toEqual([0, 0, 0])
    expect(g.tags.Fault).toBe(true)
    g.tags.En = true
    g.tags.Exe = false
    g.tick()
    g.tags.Exe = true
    g.tick(60)
    expect(g.tags.Fault).toBe(false)
    expect(g.pose[0]).toBeCloseTo(0.5, 12)
    g.dispose()
  })

  it('dropping Enable stops it dead and abandons the move; it waits for the next Execute', () => {
    const g = new Gantry({ ...TAGS, enableTag: 'En', mode: 'position' })
    g.tags.En = true
    g.tick()
    Object.assign(g.tags, { TX: 1.5, TY: 0, TZ: 0 })
    g.tags.Exe = true
    g.tick()
    g.tags.Exe = false
    g.tick(40)
    g.tags.En = false
    g.tick()
    const stopped = g.pose[0]
    expect(stopped).toBeGreaterThan(0)
    expect(stopped).toBeLessThan(1.5)
    g.tick(60)
    expect(g.pose[0]).toBe(stopped)
    expect(g.tags.Done).toBe(true)
    g.tags.En = true
    g.tick(60)
    expect(g.pose[0]).toBe(stopped) // re-enabling does not resume the move
    g.execute()
    expect(g.pose[0]).toBe(1.5)
    g.dispose()
  })
})
