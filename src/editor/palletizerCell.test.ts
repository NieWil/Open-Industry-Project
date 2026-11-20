import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { instantiatePartScript, resolvePartParams } from '../core/parts/partScript'
import { createRobot, type RobotJoint } from '../core/robot/robotController'
import type { ParamValue } from '../core/parts/partApi'
import { ROBOT_JOINT_MAX, ROBOT_JOINT_MIN } from '../core/types'
import { robotForwardKinematics, segmentBoxDistance } from '../render/parts/robotKinematics'
import { CELL, createPlcDemoScene, LAYER_PATTERN, PALLETIZER, PALLET_STACK_PATTERN } from './demo/demoScenes'

// Guards the demo's layer-forming palletizer against the failure modes a tip-position check cannot see: an
// impossible bend (a joint jammed on its limit), a link driven through the conveyor line or the stack it is
// building, and - unique to a layer head - a plate aimed down the wrong axis, which would set all five cases of
// a course rotated. Every trained pose runs through the same forward kinematics the renderer animates.
//
// It also pins the pattern itself, because the cell's geometry is derived from it: the whole 3-course load is one
// layer laid at 0°, 180°, 0°; every row accumulating against a single blade stop is what puts cases at the x
// offsets that layer asks for; and the layer being assembled ON the forming lane is what makes one 0.5 m push put
// the two rows at its z offsets. If any of those stops being true, the line is building something the palletizer
// isn't stacking.

const DOWN = new Vector3(0, -1, 0)
const LIMIT_MARGIN = 5 // deg a joint must stay clear of its min/max
const LINK_RADIUS = 0.08 // m of clearance a link must keep from a surface
const PLATE_DOWN_MIN = 0.9999 // approach·down at the action poses (1 = straight down; the poses solve exact)

const fk = (pose: readonly number[]) =>
  robotForwardKinematics(pose, PALLETIZER.robotPosition, PALLETIZER.robotRotationY, PALLETIZER.robotScale)

const wp = (name: string) => {
  const found = PALLETIZER.waypoints.find((w) => w.name === name)
  if (!found) throw new Error(`no waypoint ${name}`)
  return found
}
/** a waypoint's row in the robot's table (row 0 is home, so 1-based) */
const cmdOf = (name: string) => PALLETIZER.waypoints.findIndex((w) => w.name === name) + 1

/** the robot's real behavior, and the params the demo places it with (speed, waypoints, blend points, tags) */
const ROBOT_SOURCE = readFileSync(new URL('../../examples/parts/six-axis-robot/behavior.ts', import.meta.url), 'utf8')
const ROBOT_JOINTS = (JSON.parse(readFileSync(new URL('../../examples/parts/six-axis-robot/rig.json', import.meta.url), 'utf8')) as { geometry: { joints: RobotJoint[] } }).geometry.joints
const ARM_PARAMS = createPlcDemoScene().parts.find(
  (p) => (p as { packageId?: string }).packageId === 'oip.six-axis-robot',
)!.params as Record<string, ParamValue>

const allPoses = [{ name: 'Home', pose: PALLETIZER.home }, ...PALLETIZER.waypoints]
const actionPoses = ['Pick', 'Place1', 'Place2', 'Place3']

// The conveyor line the layer is built on, as one slab (the layer standing on top of it is the thing being
// grabbed, not an obstacle), and the stack as it stands when a given course is laid - never the finished stack,
// since laying course 1 legitimately passes through the space course 3 will later occupy.
const tableMin = new Vector3(2.0, CELL.surface - 0.9, CELL.laneZ - 1.0)
const tableMax = new Vector3(4.5, CELL.surface, CELL.laneZ + 1.0)
// The load is built ON the pallet line's deck, not on the floor, so a pallet's top face is the deck plus its own
// 135 mm - and every course the arm lays sits that much higher than it would on the ground.
const PALLET_TOP = CELL.palletDeckH + 0.135
const stackTopWhenLaying = (course: number) => PALLET_TOP + course * 0.4

const minClearance = (chain: Vector3[], min: Vector3, max: Vector3): number => {
  let d = Infinity
  for (let i = 0; i < chain.length - 1; i++) d = Math.min(d, segmentBoxDistance(chain[i]!, chain[i + 1]!, min, max))
  return d
}

describe('palletizer cell waypoints', () => {
  it.each(allPoses)('$name: every joint stays off its limit (no impossible bend)', ({ pose }) => {
    pose.forEach((a, i) => {
      expect(a).toBeGreaterThan(ROBOT_JOINT_MIN[i]! + LIMIT_MARGIN)
      expect(a).toBeLessThan(ROBOT_JOINT_MAX[i]! - LIMIT_MARGIN)
    })
  })

  it.each(allPoses)('$name: no arm link clips the conveyor line', ({ pose }) => {
    expect(minClearance(fk(pose).chain, tableMin, tableMax)).toBeGreaterThan(LINK_RADIUS)
  })

  it.each(actionPoses)('%s: the plate points straight down', (name) => {
    expect(fk(wp(name).pose).approach.dot(DOWN)).toBeGreaterThan(PLATE_DOWN_MIN)
  })

  // The apexes are the poses the arm carries a layer through, and they are at the end of its reach: a tool-down
  // plate directly over a 3-course stack is where the wrist (j5, +/-120) runs out first. An iterative (CCD) solver
  // has no notion of "unreachable" and returns its least-bad compromise, reporting 11-13 degrees off level here as
  // if no layout could do better. The offline solver is closed-form, so the apexes come back exact and are held to
  // the same standard as the places: a carried layer stays flat the whole way.
  //
  // Half a degree, not zero, only because these are printed rounded to 3 decimal places.
  it.each(['PickHigh', 'PlaceHigh'])('%s: the plate is dead level, so a layer rides through flat', (name) => {
    const tiltDeg = (Math.acos(Math.min(1, fk(wp(name).pose).approach.dot(DOWN))) * 180) / Math.PI
    expect(tiltDeg).toBeLessThan(0.5)
  })

  it('Pick reaches the formed layer on the forming lane', () => {
    // the plate stops on the case tops, so the whole layer hangs flush below it
    const want = new Vector3(CELL.loadX, CELL.surface + 0.4, CELL.layerZ)
    expect(fk(wp('Pick').pose).gripper.distanceTo(want)).toBeLessThan(0.03)
  })

  it.each([0, 1, 2])('Place course %i lands the layer at the right height over the pallet', (course) => {
    // pallet deck + the courses already laid + half a case = the case centres; the plate sits a further half-case
    // up, on their tops
    const want = new Vector3(CELL.loadX, PALLET_TOP + course * 0.4 + 0.4, CELL.palletZ)
    expect(fk(wp(`Place${course + 1}`).pose).gripper.distanceTo(want)).toBeLessThan(0.03)
  })

  it.each([0, 1, 2])('no arm link clips the stack already standing when course %i is laid', (course) => {
    const min = new Vector3(CELL.loadX - 0.61, 0, CELL.palletZ - 0.51)
    const max = new Vector3(CELL.loadX + 0.61, stackTopWhenLaying(course), CELL.palletZ + 0.51)
    expect(minClearance(fk(wp(`Place${course + 1}`).pose).chain, min, max)).toBeGreaterThan(LINK_RADIUS)
  })

  // The legs, not just the poses. The arm interpolates in joint space between waypoints, so a leg is a curve in
  // world space and clear endpoints say nothing about the middle of it. The binding case is the carry from the
  // table apex to the pallet apex: the load leaves the table and has to be over 2.3 m up by the time it is over
  // a three-course stack, but a joint lerp does not climb and swing in the order a person would draw - it can
  // bring the layer across before it has risen, ploughing five cases through the stack. Every pose passing its
  // own check does not catch that, which is why this walks the path instead.
  //
  // And it walks the path as flown, through the part's own step(). An apex is a blend via-point: the part reports
  // the move done before it gets there, the program sends the next one, and the two moves overlap, so the arm
  // rounds the corner and never quite reaches the apex. Walking waypoint-to-waypoint credits the arm with height
  // it does not gain, and can pass while the third course is carried 34 mm through the second. A copy of the
  // blend in here would drift from the part, so this runs the real behavior with the demo arm's own params instead, and answers each hand-off on the very next tick: the
  // earliest follow-up is the most overlap, so the deepest corner cut the program can produce.
  //
  // The sequence is the one the program drives (DEMO_PROGRAM's arm steps: 1-2-1-3-(4+n)-3-0), and the stack is
  // the courses already laid when the arm arrives - the course being carried is the load, not an obstacle.
  const carryLegs = (course: number) => {
    const { def } = instantiatePartScript(ROBOT_SOURCE)
    if (!def?.step || !def.robot) throw new Error('six-axis robot behavior did not load')
    const params = resolvePartParams(def.params, ARM_PARAMS)
    const tags: Record<string, number | boolean> = { [params.enableTag as string]: true }
    const joints: Record<string, number> = {}
    const grips: Record<string, boolean> = {}
    let row = -1
    let exec = false
    let prevExec = false
    const ctx = {
      params, dt: 1 / 60, joints, grips, lamps: {},
      rising: () => exec && !prevExec,
      readNumber: (t: string) => Number(tags[t] ?? 0),
      readTag: (t: string) => tags[t] === true,
      // a tag the test sets stands for a program driving it (an enable tag counts only while driven)
      tagDriven: (t: string) => t in tags,
      writeTag: (t: string, v: number | boolean) => { tags[t] = v },
      report: (p: string, v: number | boolean) => { if (p === 'jobs') row = Number(v) },
      approach: (c: number, t: number, max: number) => (t - c > max ? c + max : t - c < -max ? c - max : t),
      robot: undefined as { step(): void } | undefined,
    }
    // the host's controller, over the rig's joints, as sim/embeddedBehavior.ts gives it to the part
    const controller = createRobot(def.robot === true ? {} : def.robot, ROBOT_JOINTS)
    ctx.robot = { step: () => controller.step(ctx) }
    const tick = () => {
      def.step!(ctx as never)
      prevExec = exec
      return ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((j) => (joints[j]! * 180) / Math.PI)
    }
    // Every tick of the two jobs, filed under the move the robot is on (the last Move step it reported) and whether
    // the layer is on the plate. Place course n is job 2 + n, run the tick Pick reports done: the earliest the program
    // could send it, so the deepest blend it can produce.
    const jobs = ARM_PARAMS['jobs'] as number[][]
    const waypointName = (i: number) => (i === 0 ? 'Home' : PALLETIZER.waypoints[i - 1]!.name)
    const legs: { poses: number[][]; carrying: boolean; descent: boolean; name: string }[] = []
    let moveTo = 'Home'
    for (const job of [1, 2 + course]) {
      tags[params.commandTag as string] = job
      exec = true
      for (let n = 0; n === 0 || tags[params.doneTag as string] !== true; n++) {
        const pose = tick()
        exec = false
        const step = jobs[row]
        if (step?.[1] === 1) moveTo = waypointName(step[2]!)
        const carrying = grips['gripper'] === true
        const last = legs.at(-1)
        if (last && last.name === moveTo && last.carrying === carrying) last.poses.push(pose)
        else legs.push({ poses: [pose], carrying, descent: moveTo === `Place${course + 1}`, name: moveTo })
        if (n > 60 * 60) throw new Error(`job ${job} never finished`)
      }
    }
    return legs
  }
  /** signed clearance of the carried 1.2 x 1.0 layer, hanging a case-height under the plate, vs the stack */
  const layerGap = (tip: Vector3, standing: number) => Math.max(
    (CELL.loadX - 0.61) - (tip.x + 0.6), (tip.x - 0.6) - (CELL.loadX + 0.61),
    0 - tip.y, (tip.y - 0.4) - standing,
    (CELL.palletZ - 0.51) - (tip.z + 0.5), (tip.z - 0.5) - (CELL.palletZ + 0.51),
  )

  // Zero is the pass mark for the cycle as a whole: the last instant of a placing leg IS the
  // layer touching down on the course below. Anything negative is it arriving through the side.
  it.each([0, 1, 2])('carrying course %i in never swings the layer through the stack', (course) => {
    const standing = PALLET_TOP + course * 0.4
    let worst = Infinity
    for (const leg of carryLegs(course)) {
      if (!leg.carrying) continue
      for (const pose of leg.poses) worst = Math.min(worst, layerGap(fk(pose).gripper, standing))
    }
    expect(worst).toBeGreaterThan(-0.001)
  })

  // ...and the swing across the cell is held to a real gap, because it is a different event from the placement.
  // Touching down is what a placing leg is for, so it legitimately reads zero; a layer being flown over a
  // finished stack has no business near it, and lumping the two together lets a carry that grazes hide behind
  // the placement's genuine zero. That is the shape of the bug this cell had - the failure was on the crossing,
  // and the only number watching it was one that had to tolerate contact.
  it.each([0, 1, 2])('carrying course %i keeps real daylight over the stack until it is over the pallet', (course) => {
    const standing = PALLET_TOP + course * 0.4
    let worst = Infinity
    for (const leg of carryLegs(course)) {
      if (!leg.carrying || leg.descent) continue
      for (const pose of leg.poses) worst = Math.min(worst, layerGap(fk(pose).gripper, standing))
    }
    expect(worst).toBeGreaterThan(0.05)
  })

  // Most of the lift has to survive the hand-off. This is the mechanism behind the two checks above, pinned on
  // its own because it regresses silently: shorten the apex, or change how the part blends a via-point, and the
  // arm stops gaining height before it swings, with every pose still exactly where it was authored and every
  // static check still green. If the part starts the next move from wherever the arm is, an uncapped hand-off
  // loses 83% of this lift.
  it('the arm actually gains the pick apex before it blends away toward the pallet', () => {
    const from = fk(wp('Pick').pose).gripper.y
    const apex = fk(wp('PickHigh').pose).gripper.y
    // how high the plate is as the swing carries it off the table
    let flown = -Infinity
    for (const pose of carryLegs(2).filter((l) => l.carrying).flatMap((l) => l.poses)) {
      const g = fk(pose).gripper
      if (g.x < tableMin.x || g.x > tableMax.x || g.z < tableMin.z || g.z > tableMax.z) break
      flown = g.y
    }
    expect(apex).toBeGreaterThan(CELL.surface + 1.0) // the apex is a real lift-off, not a nudge
    expect((flown - from) / (apex - from)).toBeGreaterThan(0.5) // ...and over half of it is actually flown
  })

  // The layer-head constraint a single-cup arm never has: the plate's long axis must lie along the layer's long
  // side (world X here) or all five cases land rotated 90° and the course is wrong.
  it.each(['Pick', 'Place1', 'Place3'])('%s: the plate long axis is on world X, so cases keep the layer pattern', (name) => {
    const ax = fk(wp(name).pose).plateAxis
    expect(Math.abs(ax.x)).toBeGreaterThan(0.99) // parallel to X either way - the plate is symmetric
    expect(Math.abs(ax.z)).toBeLessThan(0.02)
  })

  // The interlock is built by the line, not the wrist: the middle course is formed with its rows reversed, so every
  // course is laid with the same wrist. A half-turn here would set the leg duration by itself (180° of wrist
  // against ~12° of arm) and gain nothing the row order does not already give.
  it('lays every course with the same wrist - the line reverses the middle course instead', () => {
    const [j6a, j6b, j6c] = ['Place1', 'Place2', 'Place3'].map((n) => wp(n).pose[5]!) as [number, number, number]
    const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)
    expect(apart(j6b, j6a)).toBeLessThan(1)
    expect(apart(j6c, j6a)).toBeLessThan(1)
    // all three are the same station, so the base never re-aims between courses either
    for (const n of ['Place2', 'Place3']) expect(wp(n).pose[0]!).toBeCloseTo(wp('Place1').pose[0]!, 3)
  })

  it('the program runs job 1 to pick and job 2 + n to place course n (the ArmCmd := placeIdx + 2 it sends)', () => {
    const jobs = ARM_PARAMS['jobs'] as number[][]
    const movesOf = (job: number) => jobs.filter((r) => r[0] === job - 1 && r[1] === 1).map((r) => r[2])
    expect(movesOf(1)).toEqual([cmdOf('PickHigh'), cmdOf('Pick'), cmdOf('PickHigh')])
    for (const n of [1, 2, 3]) expect(movesOf(1 + n)).toEqual([cmdOf('PlaceHigh'), cmdOf(`Place${n}`), cmdOf('PlaceHigh'), 0])
    expect((ARM_PARAMS['jobNames'] as string).split('\n')).toEqual(['Pick layer', 'Place course 1', 'Place course 2', 'Place course 3'])
  })
})

describe('the load pattern the cell is built around', () => {
  it('is 5 cases per course covering 1.2 x 1.0 m - a full pallet face', () => {
    expect(LAYER_PATTERN).toHaveLength(5)
    const xs = LAYER_PATTERN.map((c) => [c.dx - (c.turned ? 0.2 : 0.3), c.dx + (c.turned ? 0.2 : 0.3)])
    const zs = LAYER_PATTERN.map((c) => [c.dz - (c.turned ? 0.3 : 0.2), c.dz + (c.turned ? 0.3 : 0.2)])
    expect(Math.min(...xs.map((r) => r[0]!))).toBeCloseTo(-0.6, 6)
    expect(Math.max(...xs.map((r) => r[1]!))).toBeCloseTo(0.6, 6)
    expect(Math.min(...zs.map((r) => r[0]!))).toBeCloseTo(-0.5, 6)
    expect(Math.max(...zs.map((r) => r[1]!))).toBeCloseTo(0.5, 6)
  })

  it('splits into the two rows the line actually forms: 2 straight cases, then 3 turned ones', () => {
    const straight = LAYER_PATTERN.filter((c) => !c.turned)
    const turned = LAYER_PATTERN.filter((c) => c.turned)
    expect(straight).toHaveLength(2)
    expect(turned).toHaveLength(3)
    // each row is one z band, and both are exactly 1.2 m long in x - which is why one blade stop forms both
    expect(new Set(straight.map((c) => c.dz)).size).toBe(1)
    expect(new Set(turned.map((c) => c.dz)).size).toBe(1)
  })

  // The reason the cell needs nothing to position a case: cases accumulate nose-to-tail against one stop, so a
  // 2-case row and a 3-case row both come to rest centred on the load line, at exactly the pattern's dx offsets.
  it.each([
    { row: 'straight', turned: false, len: 0.6 },
    { row: 'turned', turned: true, len: 0.4 },
  ])('the $row row accumulating against the stop lands on the pattern dx offsets', ({ turned, len }) => {
    const cases = LAYER_PATTERN.filter((c) => c.turned === turned)
    // pack them back from the stop face, leading case first
    const packed = cases.map((_, i) => CELL.rowStopX - len / 2 - i * len).sort((a, b) => a - b)
    const wanted = cases.map((c) => CELL.loadX + c.dx).sort((a, b) => a - b)
    expect(packed.length).toBe(wanted.length)
    packed.forEach((x, i) => expect(x).toBeCloseTo(wanted[i]!, 6))
  })

  // The layer is assembled ON the forming lane: the chain transfer pushes the first row aside to make room, and
  // the row formed after it never moves. So the last row's band must sit on the lane, and the pushed row's band
  // must land where the layer stop holds it - both at the pattern's own dz offsets, off one push.
  // Both rows are pushed: the first out to the stop, the second up against its back. So for either course the
  // far row's outer face lands on the stop and the layer closes to 1.0 m - and the stop's distance has to leave
  // the parked row clear of the arriving lane in both orders, which the mirrored course (parking the deeper 0.6 m
  // turned row) is the binding case for.
  it('lands both row orders on the pattern dz offsets, clear of the arriving lane', () => {
    const straightDz = LAYER_PATTERN.find((c) => !c.turned)!.dz
    const turnedDz = LAYER_PATTERN.find((c) => c.turned)!.dz
    // the two rows butt: half of each depth apart, so the layer is exactly 1.0 m deep
    expect(straightDz - turnedDz).toBeCloseTo(0.2 + 0.3, 6)

    // a course parks its far row against the stop; the mirrored course reverses which row that is
    const canonicalFar = CELL.layerZ + straightDz + 0.2 // 0.4 m straight row parked
    const mirroredFar = CELL.layerZ - turnedDz + 0.3 // 0.6 m turned row parked (the pattern, rotated)
    expect(canonicalFar).toBeCloseTo(CELL.layerStopZ, 6)
    expect(mirroredFar).toBeCloseTo(CELL.layerStopZ, 6)

    // and the parked row must stand clear of a case arriving in the lane, whichever row parked
    const canonicalClear = (CELL.layerStopZ - 0.4) - (CELL.laneZ + 0.3) // parked straight vs an arriving turned case
    const mirroredClear = (CELL.layerStopZ - 0.6) - (CELL.laneZ + 0.2) // parked turned vs an arriving straight case
    expect(canonicalClear).toBeGreaterThan(0)
    expect(mirroredClear).toBeGreaterThan(0)

    // each push deliberately over-travels - the stop (or the row already parked) is what ends it, not the distance
    expect(CELL.pushZ).toBeGreaterThanOrEqual(0.5)
  })

  it('stacks 3 courses of the same layer, the middle one rotated a half-turn (the interlock)', () => {
    expect(PALLET_STACK_PATTERN).toHaveLength(15)
    const course = (i: number) => PALLET_STACK_PATTERN.filter((b) => Math.abs(b.dy - (0.2675 + i * 0.4)) < 1e-9)
    for (const i of [0, 1, 2]) expect(course(i)).toHaveLength(5)
    // course 1 is course 0 mirrored through the load centre
    const c0 = course(0)
    const c1 = course(1)
    for (const b of c0) {
      const mirrored = c1.find((m) => Math.abs(m.dx - (2 * 0.013 - b.dx)) < 1e-9 && Math.abs(m.dz + b.dz) < 1e-9)
      expect(mirrored, `no mirrored case for dx=${b.dx} dz=${b.dz}`).toBeTruthy()
      // a half-turn leaves the footprint alone, so a course only ever needs the two orientations the turner makes
      expect(Math.abs(mirrored!.turns - b.turns) % 2).toBe(0)
    }
    // course 2 repeats course 0 exactly
    expect(course(2).map((b) => [b.dx, b.dz, b.turns])).toEqual(c0.map((b) => [b.dx, b.dz, b.turns]))
  })
})
