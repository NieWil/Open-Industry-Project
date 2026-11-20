import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { instantiatePartScript, resolvePartParams } from '../core/parts/partScript'
import { createRobot, type RobotJoint } from '../core/robot/robotController'
import type { ParamValue } from '../core/parts/partApi'

// The six-axis robot's jobs, run through its real behavior (examples/parts/six-axis-robot/behavior.ts) with the
// PLC side played by hand: a command number, an Execute edge, and whatever the job's inputs read. What is pinned
// is the contract a PLC programmer relies on: the job runs its steps in order by itself, Done drops for the job
// and comes back when it is over, the vacuum and outputs follow the steps, a Wait for holds on its input, and
// Enable holds the arm where it is.

const SOURCE = readFileSync(new URL('../../examples/parts/six-axis-robot/behavior.ts', import.meta.url), 'utf8')
const JOINTS = (JSON.parse(readFileSync(new URL('../../examples/parts/six-axis-robot/rig.json', import.meta.url), 'utf8')) as { geometry: { joints: RobotJoint[] } }).geometry.joints
const DT = 1 / 60
const R2D = 180 / Math.PI
const MOVE = 1
const VACUUM = 2
const WAIT = 3
const WAIT_FOR = 4
const SET_OUT = 5

const WAYPOINTS = [
  [0, -45, 90, 25, 75, 0], // 0 home
  [0, -15, 55, 0, 80, 0], // 1 above pick
  [0, -5, 55, 0, 80, 0], // 2 pick
  [90, -15, 55, 0, 80, 0], // 3 above place
]

function robot(overrides: Record<string, ParamValue> = {}) {
  const { def } = instantiatePartScript(SOURCE)
  if (!def?.step || !def.robot) throw new Error('robot behavior did not load')
  const params = resolvePartParams(def.params, {
    commandTag: 'Cmd',
    executeTag: 'Exec',
    doneTag: 'Done',
    waypoints: WAYPOINTS,
    ...overrides,
  })
  const tags: Record<string, number | boolean> = {}
  const reported: Record<string, number | boolean> = {}
  const joints: Record<string, number> = {}
  const grips: Record<string, boolean> = {}
  let exec = false
  let prevExec = false
  const ctx = {
    params, dt: DT, joints, grips, lamps: {},
    rising: () => exec && !prevExec,
    readNumber: (t: string) => Number(tags[t] ?? 0),
    readTag: (t: string) => tags[t] === true,
    // a tag the test sets stands for a program driving it (an enable tag counts only while driven)
    tagDriven: (t: string) => t in tags,
    writeTag: (t: string, v: number | boolean) => { tags[t] = v },
    report: (p: string, v: number | boolean) => { reported[p] = v },
    approach: (c: number, t: number, max: number) => (t - c > max ? c + max : t - c < -max ? c - max : t),
    robot: undefined as { step(): void } | undefined,
  }
  // the host's controller, over the rig's joints, as sim/embeddedBehavior.ts gives it to the part
  const controller = createRobot(def.robot === true ? {} : def.robot, JOINTS)
  ctx.robot = { step: () => controller.step(ctx) }
  const tick = (): number[] => {
    def.step!(ctx as never)
    prevExec = exec
    return ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((j) => joints[j]! * R2D)
  }
  tick()
  return {
    tags, reported, grips, tick,
    /** set the command, pulse Execute for one tick, and return the poses of that tick */
    run(cmd: number): number[] {
      tags['Cmd'] = cmd
      exec = true
      const q = tick()
      exec = false
      return q
    },
    /** tick until Done, returning every pose on the way (throws if it never comes) */
    untilDone(limit = 60 * 60): number[][] {
      const poses: number[][] = []
      do {
        poses.push(tick())
        if (poses.length > limit) throw new Error('the job never finished')
      } while (tags['Done'] !== true)
      return poses
    },
  }
}

const near = (q: readonly number[], pose: readonly number[], tol = 0.01) => q.every((v, i) => Math.abs(v - pose[i]!) < tol)

describe('six-axis robot jobs', () => {
  it('runs a job by number, all of its moves, and reports Done only when it is over', () => {
    const r = robot({ jobs: [[0, MOVE, 1, 0], [0, MOVE, 3, 0]], jobNames: 'Swing' })
    expect(r.tags['Done']).toBe(true)
    r.run(1)
    expect(r.tags['Done']).toBe(false)
    const poses = r.untilDone()
    expect(poses.some((q) => near(q, WAYPOINTS[1]!, 0.05))).toBe(true) // it stopped on the first move's pose
    expect(near(poses.at(-1)!, WAYPOINTS[3]!)).toBe(true)
  })

  it('ignores a command with no job behind it, and a waypoint number once it has jobs', () => {
    const r = robot({ jobs: [[0, MOVE, 3, 0]] })
    for (const cmd of [0, 2, -1]) {
      r.run(cmd)
      expect(r.tags['Done']).toBe(true)
    }
    expect(near(r.tick(), WAYPOINTS[0]!)).toBe(true)
  })

  it('switches its own vacuum on its steps, and ignores the vacuum tag while it has jobs', () => {
    const r = robot({ gripperTag: 'Vac', jobs: [[0, MOVE, 2, 0], [0, VACUUM, 1, 0], [0, MOVE, 1, 0], [0, VACUUM, 0, 0]] })
    r.tags['Vac'] = true
    r.tick()
    expect(r.grips['gripper']).toBe(false)
    r.run(1)
    let heldWhileLifting = false
    let tick = 0
    do {
      const q = r.tick()
      if (r.grips['gripper'] && !near(q, WAYPOINTS[2]!, 0.05)) heldWhileLifting = true
      if (++tick > 3600) throw new Error('never finished')
    } while (r.tags['Done'] !== true)
    expect(heldWhileLifting).toBe(true)
    expect(r.grips['gripper']).toBe(false) // released by the last step
  })

  it('waits the time a Wait step says, and only then moves on', () => {
    const r = robot({ jobs: [[0, WAIT, 0.5, 0], [0, MOVE, 1, 0]] })
    r.run(1)
    const poses = r.untilDone()
    const firstMoved = poses.findIndex((q) => !near(q, WAYPOINTS[0]!, 1e-6))
    expect(firstMoved * DT).toBeGreaterThanOrEqual(0.5 - DT)
    expect(firstMoved * DT).toBeLessThan(0.5 + 3 * DT)
  })

  it('holds on a Wait for until its input reads the state it wants, and sets its outputs', () => {
    const r = robot({
      in2Tag: 'PalletIn',
      out1Tag: 'TableClear',
      jobs: [[0, SET_OUT, 0, 1], [0, WAIT_FOR, 1, 1], [0, MOVE, 1, 0], [0, SET_OUT, 0, 0]],
    })
    r.run(1)
    for (let i = 0; i < 60; i++) r.tick()
    expect(r.tags['TableClear']).toBe(true)
    expect(near(r.tick(), WAYPOINTS[0]!)).toBe(true) // still waiting: nothing moved
    expect(r.tags['Done']).toBe(false)
    r.tags['PalletIn'] = true
    r.untilDone()
    expect(r.tags['TableClear']).toBe(false)
  })

  it('brakes to a stop and holds while not enabled, then carries on from there', () => {
    const r = robot({ enableTag: 'Safe', jobs: [[0, MOVE, 3, 0]] })
    r.tags['Safe'] = true
    r.run(1)
    for (let i = 0; i < 40; i++) r.tick() // under way
    r.tags['Safe'] = false
    let prev = r.tick()
    let still = 0
    for (let i = 0; i < 120; i++) {
      const q = r.tick()
      still = q.every((v, j) => v === prev[j]) ? still + 1 : 0
      prev = q
    }
    expect(still).toBeGreaterThan(30) // it came to rest...
    expect(near(prev, WAYPOINTS[3]!, 1)).toBe(false) // ...short of the pose
    expect(r.tags['Done']).toBe(false)
    r.tags['Safe'] = true
    expect(near(r.untilDone().at(-1)!, WAYPOINTS[3]!)).toBe(true)
  })

  it('blends a pass-through move into the next without stopping, within the joints speed and accel budget', () => {
    const accel = 240
    const r = robot({ accel, speed: 60, jobs: [[0, MOVE, 1, 1], [0, MOVE, 3, 0]] })
    r.run(1)
    const poses = r.untilDone()
    // never at rest between the two moves: a stop would show as a tick with no motion at all
    const firstMoving = poses.findIndex((q, i) => i > 0 && q.some((v, j) => v !== poses[i - 1]![j]))
    const stoppedMidway = poses.slice(firstMoving + 1, -1).some((q, i) => q.every((v, j) => Math.abs(v - poses[firstMoving + i]![j]!) < 1e-9))
    expect(stoppedMidway).toBe(false)
    // no joint jumps: the speed hands over (each move stays within accel; overlapped, at most twice that), and the
    // speed limit holds through the corner
    let peakV = 0
    let peakA = 0
    for (let i = 2; i < poses.length; i++) {
      for (let j = 0; j < 6; j++) {
        const v1 = (poses[i]![j]! - poses[i - 1]![j]!) / DT
        const v0 = (poses[i - 1]![j]! - poses[i - 2]![j]!) / DT
        peakV = Math.max(peakV, Math.abs(v1))
        if (i < poses.length - 2) peakA = Math.max(peakA, Math.abs(v1 - v0) / DT)
      }
    }
    expect(peakV).toBeLessThanOrEqual(60 + 1e-6)
    expect(peakA).toBeLessThanOrEqual(2 * accel + 1)
  })

  it('reports the job row being run, and -1 when idle', () => {
    const r = robot({ jobs: [[0, MOVE, 1, 0], [1, WAIT, 1, 0], [0, WAIT, 0.3, 0]] })
    expect(r.reported['jobs']).toBe(-1)
    r.run(1)
    expect(r.reported['jobs']).toBe(0)
    let sawWait = false
    do {
      r.tick()
      if (r.reported['jobs'] === 2) sawWait = true // job 0's second step is table row 2, past job 1's row
    } while (r.tags['Done'] !== true)
    expect(sawWait).toBe(true)
    expect(r.reported['jobs']).toBe(-1)
  })

  it('ends a job at a step whose waypoint is gone, rather than guessing a pose', () => {
    const r = robot({ jobs: [[0, MOVE, -1, 0], [0, MOVE, 3, 0]] })
    r.run(1)
    r.untilDone()
    expect(near(r.tick(), WAYPOINTS[0]!)).toBe(true)
  })

  it('without jobs, still takes a waypoint number and the vacuum tag (single-move mode)', () => {
    const r = robot({ gripperTag: 'Vac' })
    r.tags['Vac'] = true
    r.run(3)
    expect(near(r.untilDone().at(-1)!, WAYPOINTS[3]!)).toBe(true)
    expect(r.grips['gripper']).toBe(true)
  })
})
