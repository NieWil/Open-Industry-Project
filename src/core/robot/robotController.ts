// The robot controller every robot part runs: waypoints, jobs, coordinated motion and the PLC handshake, for an arm of
// any number of joints. The host builds one per part that declares `robot` in definePart, and the part's step() runs
// it with `ctx.robot.step()` (sim/embeddedBehavior.ts). Being host code, a fix here reaches every robot in every
// project, where a controller copied into each part's script would stay as it was copied.
//
// The model is a real robot cell's. The robot owns its jobs: short programs of steps (move to a waypoint, grip on or
// off, wait, wait for an input, set an output) taught in the Inspector. The PLC picks a job by number on the command
// tag, raises Execute, and waits for Done; the robot runs the whole job and signals back on its outputs. A robot with
// no jobs falls back to single moves: the command is a waypoint row, Execute moves there, the gripper tag holds the
// grip. With no tags named the arm rests in its idle pose. Like a real robot, it moves only when commanded.
//
// It reads its settings from the part's params by fixed names (ROBOT_PARAMS), which the part declares in definePart
// like any other params. Positions are in the Inspector's units: degrees for a revolute joint, millimetres for a
// prismatic one, so `speed` and `accel` are degrees (or millimetres) per second along the dominant joint.
//
// Motion is one scalar per move driving every joint (coordinated: they start and arrive together) on a trapezoidal
// profile with tick-exact braking. A corner is blended by overlap: a move to a via point reports done early, the next
// move ramps up from the via pose while the old one runs on to its stop as a tail, and the arm sits at the sum. Each
// joint's speed hands over instead of jumping, which rounds the corner.

import { hostCopy } from '../hostCopy'
import type { RobotDeclaration } from '../parts/partPackage'

/** The job step vocabulary: a step is the row [job, op, a, b] of the `jobs` param. */
export const ROBOT_OP = { move: 1, grip: 2, wait: 3, waitFor: 4, setOutput: 5 } as const
/** robot inputs and outputs, as `in1Tag`..`in4Tag` and `out1Tag`..`out4Tag` */
export const ROBOT_IO_COUNT = 4

/** The params the controller reads, by name, with the type each must have. */
export const ROBOT_PARAMS = {
  speed: 'number',
  accel: 'number',
  blendDeg: 'number',
  waypoints: 'numberList',
  waypointNames: 'string',
  blendWaypoints: 'numberList',
  jobs: 'numberList',
  jobNames: 'string',
  pose: 'numberList',
  commandTag: 'tag',
  executeTag: 'tag',
  doneTag: 'tag',
  enableTag: 'tag',
  gripperTag: 'tag',
  ...Object.fromEntries(Array.from({ length: ROBOT_IO_COUNT }, (_, i) => [[`in${i + 1}Tag`, 'tag'], [`out${i + 1}Tag`, 'tag']]).flat()),
} as Readonly<Record<string, 'number' | 'numberList' | 'string' | 'tag'>>

/** What a part declares in definePart to be a robot (documented with the SDK type). */
export type RobotDecl = RobotDeclaration

/** A part's `robot` declaration, copied and checked field by field (it is part code's), or null when it has none. */
export function robotDeclOf(raw: unknown): RobotDecl | null {
  const copied: unknown = hostCopy(raw)
  if (copied === undefined || copied === null || copied === false) return null
  if (copied === true) return {}
  if (typeof copied !== 'object') throw new Error('robot must be true or { joints?, gripper?, lamp?, gripJoint?, tool?, hand? }')
  const v = copied as Record<string, unknown>
  const str = (k: string): string | undefined => {
    const x = v[k]
    if (x === undefined) return undefined
    if (typeof x !== 'string' || x === '') throw new Error(`robot.${k} must be a non-empty name`)
    return x
  }
  const decl: RobotDecl = {}
  if (v.joints !== undefined) {
    if (!Array.isArray(v.joints) || v.joints.some((j) => typeof j !== 'string')) throw new Error('robot.joints must be joint names')
    decl.joints = v.joints as string[]
  }
  const gripper = str('gripper')
  if (gripper) decl.gripper = gripper
  const lamp = str('lamp')
  if (lamp) decl.lamp = lamp
  const tool = str('tool')
  if (tool) decl.tool = tool
  const gripJointOf = (g: unknown, at: string): NonNullable<RobotDecl['gripJoint']> => {
    const j = g as { name?: unknown; open?: unknown; closed?: unknown } | null
    if (typeof j !== 'object' || j === null || typeof j.name !== 'string' || !Number.isFinite(j.open) || !Number.isFinite(j.closed)) {
      throw new Error(`${at} must be { name, open, closed }`)
    }
    return { name: j.name, open: j.open as number, closed: j.closed as number }
  }
  if (v.gripJoint !== undefined) decl.gripJoint = gripJointOf(v.gripJoint, 'robot.gripJoint')
  if (v.hand !== undefined) {
    const h = v.hand as { gripper?: unknown; gripJoint?: unknown } | null
    if (typeof h !== 'object' || h === null || typeof h.gripper !== 'string' || h.gripper === '') throw new Error('robot.hand must be { gripper, gripJoint }')
    decl.hand = { gripper: h.gripper, gripJoint: gripJointOf(h.gripJoint, 'robot.hand.gripJoint') }
  }
  return decl
}

/** Does the robot grip with its own hand (`decl.hand`) under these params, rather than the tool its `tool` param picks? */
export function robotUsesHand(decl: RobotDecl, params: Readonly<Record<string, unknown>> | undefined): boolean {
  return decl.hand !== undefined && (params?.tool ?? 'hand') === 'hand'
}

/** A rig joint as the controller needs it: limits in the joint's own units (rad, or m for prismatic). */
export interface RobotJoint {
  name: string
  type: 'revolute' | 'prismatic'
  min: number
  max: number
  servo?: unknown
  cosmetic?: boolean
  mimic?: unknown
}

type TagValue = number | boolean
/** The part context the controller drives: what it reads (params, tags) and writes (joints, grips, lamps, tags). */
export interface RobotIo {
  readonly params: Readonly<Record<string, unknown>>
  readonly dt: number
  joints: Record<string, number>
  grips: Record<string, boolean>
  lamps: Record<string, boolean>
  rising(tag: string): boolean
  readNumber(tag: string): number
  readTag(tag: string): boolean
  tagDriven(tag: string): boolean
  writeTag(tag: string, value: TagValue): void
  report(param: string, value: TagValue): void
  approach(current: number, target: number, maxDelta: number): number
}

/** What the host tells the controller beyond the part's ctx. */
export interface RobotHost {
  /** how far the load `gripper` holds reaches from it along its X, either side (m); undefined when it holds none */
  heldReach?(gripper: string): number | undefined
}

export interface Robot {
  /** the joints driven, in column order */
  readonly joints: readonly string[]
  /** one tick: take a command, run the job, move the arm, and write joints, grip and tags. `host` is what the sim knows
   *  that the part does not: how far a held load reaches across the gripper, which a clamp closes onto */
  step(io: RobotIo, host?: RobotHost): void
}

/** A command or job reports busy for at least this long, so the Execute/Done handshake can't miss it at any scan rate. */
const MIN_MOVE_SEC = 0.1
/** the most steps that complete in one tick (instant steps chain on in the same tick) */
const MAX_STEPS_PER_TICK = 64
/** how long the grip joint takes to open or close, in seconds */
const GRIP_SEC = 0.3

/** the joints a robot drives when its declaration names none */
export function defaultRobotJoints(joints: readonly RobotJoint[]): string[] {
  return joints.filter((j) => !j.servo && !j.cosmetic && !j.mimic).map((j) => j.name)
}

/** A joint's Inspector unit per native unit: degrees per radian, millimetres per metre. */
export const robotUnit = (type: RobotJoint['type']): number => (type === 'prismatic' ? 1000 : 180 / Math.PI)

// limits in Inspector units, rounded so a limit authored as 180° reads 180 and not 179.9999998 after its radian trip
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

const splitNames = (s: unknown): string[] => (typeof s === 'string' && s !== '' ? s.split('\n') : [])
const numberRows = (v: unknown): number[][] => (Array.isArray(v) ? (v as number[][]) : [])
const tagName = (v: unknown): string => (typeof v === 'string' ? v : '')

/** How many jobs there are: every one a step belongs to, and every one that has a name. */
export function robotJobCount(rows: readonly (readonly number[])[], names: unknown): number {
  return rows.reduce((n, r) => Math.max(n, r[0]! + 1), splitNames(names).length)
}

/** One move: its start pose, the signed change per joint, the dominant joint's distance, progress and path speed. */
interface Segment {
  from: number[]
  span: number[]
  len: number
  prog: number
  vel: number
}

/** Build the controller for `decl` over the rig's `rigJoints`. Throws when the declaration names a joint the rig lacks. */
export function createRobot(decl: RobotDecl, rigJoints: readonly RobotJoint[]): Robot {
  const byName = new Map(rigJoints.map((j) => [j.name, j]))
  const names = decl.joints ? [...decl.joints] : defaultRobotJoints(rigJoints)
  const spec = names.map((n) => {
    const j = byName.get(n)
    if (!j) throw new Error(`robot joint "${n}" is not a joint of the rig`)
    const unit = robotUnit(j.type)
    // back to native units by multiplying, as the six-axis script always did (deg * (PI / 180)), so poses match to the bit
    const toNative = j.type === 'prismatic' ? 0.001 : Math.PI / 180
    return { name: n, toNative, revolute: j.type !== 'prismatic', min: round6(j.min * unit), max: round6(j.max * unit) }
  })
  const n = spec.length
  const toolGrip = decl.gripJoint && byName.has(decl.gripJoint.name) ? decl.gripJoint : null
  const handGrip = decl.hand && byName.has(decl.hand.gripJoint.name) ? decl.hand.gripJoint : null

  let seeded = false
  let cur = new Array<number>(n).fill(0)
  let moving = false
  let gripClosed = false
  // each grip joint's position: the tool's and the arm's own hand's, the one not gripping standing open
  const gripAt = new Map<string, number>()
  const outputs = new Array<boolean>(ROBOT_IO_COUNT).fill(false)
  const segment = (start: readonly number[]): Segment => ({ from: start.slice(), span: new Array<number>(n).fill(0), len: 0, prog: 0, vel: 0 })
  let seg = segment(cur)
  // moves still finishing under the active one (a via-point move that handed off early)
  let tails: Segment[] = []
  // single-move mode: the waypoint row being moved to
  let target = 0
  // job mode: the job running (-1 = none), its steps with their row index, the next step, whether it has started,
  // and the seconds a Wait has left
  let job = -1
  let steps: { row: number; values: readonly number[] }[] = []
  let pc = 0
  let started = false
  let waitLeft = 0
  let busySec = 0

  // The landing angle nearest `from` that is congruent to `to` (mod 360°): a 350° command from 0 turns -10°.
  const shortestPath = (from: number, to: number): number => {
    let diff = ((to - from + 180) % 360) - 180
    if (diff < -180) diff += 360
    return from + diff
  }

  // Trapezoidal profile of one move: accel-limited, capped at vMax, always able to brake to a stop at its end. vStop
  // counts the braking limit in whole ticks: the continuous sqrt(2·a·remain) ignores the distance the tick itself
  // covers, so the arm reached the pose still moving and stopped dead on the last tick.
  const advance = (s: Segment, vMax: number, accel: number, dt: number, io: RobotIo): void => {
    const h = (accel * dt) / 2
    const vStop = Math.sqrt(h * h + 2 * accel * Math.max(s.len - s.prog, 0)) - h
    s.vel = io.approach(s.vel, Math.min(vMax, vStop), accel * dt)
    s.prog += s.vel * dt
    if (s.prog >= s.len) {
      s.prog = s.len
      s.vel = 0
    }
  }
  const fraction = (s: Segment): number => (s.len > 1e-6 ? s.prog / s.len : 1)

  // Start a move to `tgt`, planned from where the previous move ENDS: a move still running becomes a tail and covers
  // the difference.
  const startMove = (tgt: readonly number[]): void => {
    if (seg.prog < seg.len) tails.push(seg)
    const start = seg.from.map((f, i) => f + seg.span[i]!)
    seg = segment(start)
    for (let i = 0; i < n; i++) {
      const s = spec[i]!
      // a revolute joint takes the shortest-angle landing while it stays inside the limits; otherwise the raw target,
      // clamped: the host clamps the drawn joint anyway, and planning past a limit would time out on travel it lacks
      const raw = tgt[i] ?? start[i]!
      const wrapped = s.revolute ? shortestPath(start[i]!, raw) : raw
      const goal = wrapped >= s.min && wrapped <= s.max ? wrapped : Math.min(Math.max(raw, s.min), s.max)
      seg.span[i] = goal - start[i]!
      seg.len = Math.max(seg.len, Math.abs(seg.span[i]!))
    }
  }

  // A move is over at a via point once inside the blend window (capped at a third of the move, so a short via leg
  // can't hand off before it has begun), and at a stop once everything is still.
  const moveOver = (via: boolean, blend: number): boolean => {
    const remain = seg.len - seg.prog
    return via ? remain <= Math.min(blend, seg.len / 3) : remain <= 0 && tails.length === 0
  }

  // Run the active job's steps as far as this tick allows: instant steps (grip, set) chain on, a move, a wait or a
  // wait-for holds the job until it is done.
  const runJob = (io: RobotIo, poses: readonly (readonly number[])[], blend: number): void => {
    for (let guard = 0; guard < MAX_STEPS_PER_TICK && pc < steps.length; guard++) {
      const [, op, a = 0, b = 0] = steps[pc]!.values
      if (op === ROBOT_OP.move) {
        if (!started) {
          const pose = poses[a]
          // a step whose waypoint is gone ends the job there: the arm stays put rather than guessing a pose
          if (!Number.isInteger(a) || !pose) {
            pc = steps.length
            return
          }
          startMove(pose)
          started = true
        }
        if (!moveOver(b === 1, blend)) return
      } else if (op === ROBOT_OP.grip) {
        gripClosed = a === 1
      } else if (op === ROBOT_OP.wait) {
        if (!started) {
          waitLeft = a
          started = true
        }
        if (waitLeft > 1e-9) return
      } else if (op === ROBOT_OP.waitFor) {
        const tag = tagName(io.params[`in${a + 1}Tag`])
        if ((tag ? io.readTag(tag) : false) !== (b === 1)) return
      } else if (op === ROBOT_OP.setOutput) {
        if (a >= 0 && a < ROBOT_IO_COUNT) outputs[a] = b === 1
      }
      pc++
      started = false
    }
  }

  const step = (io: RobotIo, host?: RobotHost): void => {
    const P = io.params
    const num = (k: string, d: number): number => (typeof P[k] === 'number' && Number.isFinite(P[k]) ? (P[k] as number) : d)
    const poses = numberRows(P.waypoints)
    const jobRows = numberRows(P.jobs)
    const jobs = robotJobCount(jobRows, P.jobNames)
    const enableTag = tagName(P.enableTag)
    const enabled = !io.tagDriven(enableTag) || io.readTag(enableTag)
    const dt = io.dt
    const blend = num('blendDeg', 12)

    // the first tick seeds the arm at its idle pose, so a placed robot and one waiting for its first Execute rest
    // where the author set it
    if (!seeded) {
      seeded = true
      const idle = numberRows(P.pose)[0]
      if (idle && idle.length === n) cur = idle.slice()
      seg = segment(cur)
    }

    // io.rising diffs the begin-of-tick snapshot, so an edge held over the async tag bus can't be lost
    if (io.rising(tagName(P.executeTag)) && !moving) {
      const cmd = Math.round(io.readNumber(tagName(P.commandTag)))
      // a command with nothing behind it ignores the edge: stay put, Done stays true
      if (jobs > 0 && cmd >= 1 && cmd <= jobs) {
        job = cmd - 1
        steps = []
        jobRows.forEach((values, row) => {
          if (values[0] === job) steps.push({ row, values })
        })
        pc = 0
        started = false
        moving = true
        busySec = 0
      } else if (jobs === 0 && cmd >= 0 && cmd < poses.length) {
        target = cmd
        startMove(poses[target]!)
        moving = true
        busySec = 0
      }
    }
    if (jobs === 0) gripClosed = io.readTag(tagName(P.gripperTag))
    if (job >= 0 && enabled) runJob(io, poses, blend)

    // The tails' speeds come off the new move's cap, so no joint passes `speed` through a blend. Not enabled, every
    // move brakes to a stop where it is.
    const accel = num('accel', 720)
    const vMax = enabled ? num('speed', 120) : 0
    let tailVel = 0
    for (const t of tails) {
      advance(t, vMax, accel, dt, io)
      tailVel += t.vel
    }
    advance(seg, Math.max(vMax - tailVel, 0), accel, dt, io)
    const u = fraction(seg)
    for (let i = 0; i < n; i++) cur[i] = seg.from[i]! + seg.span[i]! * u
    for (const t of tails) {
      const tu = fraction(t)
      for (let i = 0; i < n; i++) cur[i] = cur[i]! + t.span[i]! * (tu - 1)
    }
    tails = tails.filter((t) => t.prog < t.len)

    if (moving) busySec += dt
    if (enabled && job >= 0) waitLeft -= dt

    // Done once the job has run its last step (a job ending on a pass-through move hands off as it rounds it), or the
    // single move is over. MIN_MOVE_SEC keeps one that would finish inside a PLC scan visible.
    const over = job >= 0 ? pc >= steps.length : moveOver(numberRows(P.blendWaypoints).some((r) => r[0] === target), blend)
    if (moving && over && busySec >= MIN_MOVE_SEC) {
      moving = false
      job = -1
    }

    for (let i = 0; i < n; i++) io.joints[spec[i]!.name] = cur[i]! * spec[i]!.toNative
    const ownHand = robotUsesHand(decl, P)
    const gripper = ownHand ? decl.hand!.gripper : decl.gripper
    for (const j of [toolGrip, handGrip]) {
      if (!j) continue
      const closing = gripClosed && (j === handGrip) === ownHand
      // a clamp closes onto what it holds: its pads stand `toolSizeX` apart at joint 0 and the joint moves each one
      // outward, so a load reaching `reach` either side wants reach - toolSizeX / 2. Holding nothing, it closes
      // fully, and so does a hand, whose fingers are not sized by toolSizeX
      const reach = closing && j === toolGrip && gripper ? host?.heldReach?.(gripper) : undefined
      const size = num('toolSizeX', Number.NaN)
      const onLoad = reach !== undefined && Number.isFinite(size) ? reach - size / 2 : undefined
      const lo = Math.min(j.open, j.closed)
      const hi = Math.max(j.open, j.closed)
      const goal = !closing ? j.open : onLoad !== undefined ? Math.min(hi, Math.max(lo, onLoad)) : j.closed
      const at = io.approach(gripAt.get(j.name) ?? j.open, goal, (Math.abs(j.open - j.closed) / GRIP_SEC) * dt)
      gripAt.set(j.name, at)
      io.joints[j.name] = at
    }
    if (decl.gripper) io.grips[decl.gripper] = gripClosed && !ownHand
    if (decl.hand) io.grips[decl.hand.gripper] = gripClosed && ownHand
    // the lamp is the tool's: a hand gripping leaves it dark
    if (decl.lamp) io.lamps[decl.lamp] = gripClosed && !ownHand
    const doneTag = tagName(P.doneTag)
    if (doneTag) io.writeTag(doneTag, !moving)
    for (let i = 0; i < ROBOT_IO_COUNT; i++) {
      const tag = tagName(P[`out${i + 1}Tag`])
      if (tag) io.writeTag(tag, outputs[i]!)
    }
    // the job row being run, for the Inspector to highlight (-1 = none)
    if ('jobs' in P) io.report('jobs', job >= 0 && pc < steps.length ? steps[pc]!.row : -1)
  }

  return { joints: names, step }
}
