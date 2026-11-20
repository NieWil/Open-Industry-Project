// Project-test world probes: the pure half (docs/project-tests.md). A probe reads a number out of
// one simulation step's BoxFrame, so a check can assert on what physically happened (cargo reached a
// zone, a vehicle stopped where it should) instead of only on what a tag says about it.
//
// This is core and takes a plain {@link BoxFrame}, so every probe is unit-testable against a
// hand-built frame: no Jolt, no vite, no scene. The runner (editor/project/projectTestRunner.ts) merges
// what {@link ProbeSampler.values} returns into the same flat table as the tags, keyed by
// {@link probeKey}. The evaluator has no probe-specific code.
//
// Absence is a signal, not a zero. `count` always returns a value (0 legitimately means "nothing matched"),
// but `pose` returns undefined when the part isn't in the running scene. That leaves its key out
// of the sample table, and the evaluator's existing "never appeared" guard turns a mistyped part id
// into a failure instead of a coordinate of 0 that quietly satisfies a `max` bound. A colour filter
// is absent until cargo of that colour has existed, and `passed` until any cargo has entered its
// zone, for the same reason: a filter or a zone that matches nothing would pass every `max 0`.

import { cargoKindName } from '../frame'
import type { BoxFrame, CargoKindName } from '../frame'
import { quatToYXZ } from '../math'
import { isOperand, operandProbeKey, probeKey } from './projectTest'
import type { CargoColor, CargoColorName, CountProbe, JointProbe, LampProbe, MarkFilter, PassedProbe, PoseProbe, SquareProbe, TestCheck, TestProbe, TestValue, Zone } from './projectTest'

/** each frame row's marks (SimWorld.cargoMarks), index-aligned with the frame; null for a row with none */
export type RowMarks = readonly (Readonly<Record<string, number | boolean | string>> | null)[]

/** Does a body carrying `m` match a mark filter: the key truthy, or the key equal to the value given? */
function markMatches(filter: MarkFilter, m: Readonly<Record<string, number | boolean | string>> | null | undefined): boolean {
  if (typeof filter === 'string') {
    const v = m?.[filter]
    return v !== undefined && v !== false && v !== 0 && v !== ''
  }
  for (const [k, want] of Object.entries(filter)) if (m?.[k] !== want) return false
  return true
}

const AXIS_INDEX: Readonly<Record<'x' | 'y' | 'z', number>> = { x: 0, y: 1, z: 2 }

/** Inclusive on every axis: a body exactly on a zone face counts as inside. */
function inZone(z: Zone, x: number, y: number, w: number): boolean {
  return x >= z.min[0] && x <= z.max[0] && y >= z.min[1] && y <= z.max[1] && w >= z.min[2] && w <= z.max[2]
}

/** The body ids of the live cargo whose centre is inside `zone`, in frame order: what a `jam` fault picks its body
 *  from (the runner pins the first one that is free to pin). */
export function cargoInZone(zone: Zone, frame: BoxFrame): number[] {
  const out: number[] = []
  for (let i = 0; i < frame.count; i++) {
    const p = i * 3
    if (inZone(zone, frame.positions[p]!, frame.positions[p + 1]!, frame.positions[p + 2]!)) out.push(frame.ids[i]!)
  }
  return out
}

/** Does the segment a body's centre swept this step, `a` → `b`, touch `zone` (inclusive)? The slab test: what lets a
 *  `passed` zone thinner than one step's travel still catch a box thrown through it. */
function segmentHitsZone(z: Zone, a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  let t0 = 0
  let t1 = 1
  for (let k = 0; k < 3; k++) {
    const lo = z.min[k]!
    const hi = z.max[k]!
    const d = b[k]! - a[k]!
    if (Math.abs(d) < 1e-12) {
      if (a[k]! < lo || a[k]! > hi) return false
      continue
    }
    const u0 = (lo - a[k]!) / d
    const u1 = (hi - a[k]!) / d
    t0 = Math.max(t0, Math.min(u0, u1))
    t1 = Math.min(t1, Math.max(u0, u1))
    if (t0 > t1) return false
  }
  return true
}

/**
 * The colour name a tint is called by: `red` / `green` / `blue` for a saturated tint whose channel dominates,
 * `yellow` for red and green together over a low blue, else undefined (too dark, or washed out: white, grey, cyan,
 * magenta). A colour sensor matches its own list of colours instead; this is the test filter's fixed rule. `rgb` is
 * sRGB 0..1, as {@link BoxFrame.colors} carries it.
 */
export function cargoColorName(r: number, g: number, b: number): CargoColorName | undefined {
  const max = Math.max(r, g, b)
  if (max < 0.25) return undefined
  const min = Math.min(r, g, b)
  const mid = r + g + b - max - min
  if (mid <= max * 0.6) return max === r ? 'red' : max === g ? 'green' : 'blue'
  return min === b && b < mid * 0.5 ? 'yellow' : undefined
}

/** `#rrggbb` of an sRGB 0..1 tint. */
function toHex(r: number, g: number, b: number): string {
  const h = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** Does body `i` have colour `color`: by name, or an exact `#rrggbb` (the frame carries Float32, so to the nearest
 *  8-bit step). */
function colorMatches(color: CargoColor, frame: BoxFrame, i: number): boolean {
  const c = i * 3
  const r = frame.colors[c]!
  const g = frame.colors[c + 1]!
  const b = frame.colors[c + 2]!
  return color.startsWith('#') ? toHex(r, g, b) === color : cargoColorName(r, g, b) === color
}

/** Does body `i` match a count/passed probe's part, kind and colour filters (the zone aside)? Transient spawner boxes
 *  have a null partId, so a `part` filter naturally excludes them while an unfiltered count includes them. */
function matchesFilters(spec: CountProbe, frame: BoxFrame, i: number, marks?: RowMarks): boolean {
  if (spec.part !== undefined && frame.partIds[i] !== spec.part) return false
  if (spec.marked !== undefined && !markMatches(spec.marked, marks?.[i])) return false
  if (spec.kind !== undefined && cargoKindName(frame.kinds[i]!) !== spec.kind) return false
  if (spec.color !== undefined && !colorMatches(spec.color, frame, i)) return false
  return true
}

/** How far a heading is off square to `heading`, folded by 90 so any edge parallel counts: degrees in [0, 45]. */
export function offSquareDeg(yawDeg: number, heading: number): number {
  const d = (((yawDeg - heading) % 90) + 90) % 90
  return Math.min(d, 90 - d)
}

/** The worst {@link offSquareDeg} of the matching bodies inside the zone, or undefined when none is inside. */
function readSquare(spec: SquareProbe, frame: BoxFrame, marks?: RowMarks): number | undefined {
  let worst: number | undefined
  for (let i = 0; i < frame.count; i++) {
    const p = i * 3
    if (!inZone(spec.zone, frame.positions[p]!, frame.positions[p + 1]!, frame.positions[p + 2]!)) continue
    if (!matchesFilters(spec, frame, i, marks)) continue
    const off = offSquareDeg(cargoYawDeg(frame, i), spec.heading)
    if (worst === undefined || off > worst) worst = off
  }
  // to a tenth of a degree, so a failed check reads `became 7.6`
  return worst === undefined ? undefined : Math.round(worst * 10) / 10
}

/** How many live cargo bodies match every filter. */
function countCargo(spec: CountProbe, frame: BoxFrame, marks?: RowMarks): number {
  let n = 0
  for (let i = 0; i < frame.count; i++) {
    if (!matchesFilters(spec, frame, i, marks)) continue
    if (spec.zone) {
      const p = i * 3
      if (!inZone(spec.zone, frame.positions[p]!, frame.positions[p + 1]!, frame.positions[p + 2]!)) continue
    }
    n++
  }
  return n
}

/** One live cargo body, as `test-project --cargo` prints it: what it is and where its centre is. */
export interface CargoRow {
  id: number
  /** the scene part it is, or null for a transient (spawned) body */
  part: string | null
  kind: CargoKindName
  /** the cargo part it was made as (its package id), when the frame says (core/frame.ts BoxFrame.shapeRefs) */
  product?: string
  /** its tint, `#rrggbb` */
  color: string
  /** what a colour filter calls it, when it is a saturated primary */
  colorName?: CargoColorName
  /** centre, world metres, to the millimetre */
  pos: [number, number, number]
  /** how far it is tilted from upright, whole degrees (about 90 = on its side) */
  tiltDeg: number
  /** its heading about world +Y, whole degrees in (-180, 180]: for an upright body the angle a part's `rotationY`
   *  measures, and for a tilted one the plan direction of its more nearly level edge ({@link cargoYawDeg}). A box is
   *  symmetric, so 90 apart can be the same footprint */
  yawDeg: number
}

/** Body `i`'s heading about world +Y in degrees: the plan direction of its more nearly level edge, its local X (as a
 *  part's rotationY measures it) or else its local Z. For an upright body the two agree, and that is its rotationY. A
 *  case rolled on a cross slope (a chute falling away from a sorter) still reads the way its edges run in plan, where
 *  a YXZ yaw would read its rolled cross edge, several degrees off. */
export function cargoYawDeg(frame: Pick<BoxFrame, 'quats'>, i: number): number {
  const q = i * 4
  const x = frame.quats[q]!, y = frame.quats[q + 1]!, z = frame.quats[q + 2]!, w = frame.quats[q + 3]!
  // the body's local X and Z in world space
  const ex = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)]
  const ez = [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]
  const rad = Math.abs(ex[1]!) <= Math.abs(ez[1]!) ? Math.atan2(-ex[2]!, ex[0]!) : Math.atan2(ez[0]!, ez[2]!)
  const deg = (rad * 180) / Math.PI
  // -180 and 180 are one heading; `+ 0` turns a -0 into 0
  return deg <= -179.5 ? 180 : deg + 0
}

/** The angle between body `i`'s own up axis and world up, in degrees: its tilt from upright. */
export function cargoTiltDeg(frame: Pick<BoxFrame, 'quats'>, i: number): number {
  const qx = frame.quats[i * 4]!
  const qz = frame.quats[i * 4 + 2]!
  // the y component of the body's local +Y in world space
  const upY = 1 - 2 * (qx * qx + qz * qz)
  return (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI
}

/** Every live cargo body in a frame, in frame order: the headless answer to "where are the boxes". */
export function cargoRows(frame: BoxFrame): CargoRow[] {
  const mm = (v: number): number => Math.round(v * 1000) / 1000
  const out: CargoRow[] = []
  for (let i = 0; i < frame.count; i++) {
    const c = i * 3
    const r = frame.colors[c]!
    const g = frame.colors[c + 1]!
    const b = frame.colors[c + 2]!
    const name = cargoColorName(r, g, b)
    const key = frame.shapes?.[i]
    const product = key ? frame.shapeRefs?.[key]?.packageId : undefined
    out.push({
      id: frame.ids[i]!,
      part: frame.partIds[i] ?? null,
      kind: cargoKindName(frame.kinds[i]!),
      ...(product ? { product } : {}),
      color: toHex(r, g, b),
      ...(name ? { colorName: name } : {}),
      pos: [mm(frame.positions[c]!), mm(frame.positions[c + 1]!), mm(frame.positions[c + 2]!)],
      tiltDeg: Math.round(cargoTiltDeg(frame, i)),
      yawDeg: Math.round(cargoYawDeg(frame, i)),
    })
  }
  return out
}

/** A body in a {@link CargoSnapshot}: its row, and how fast it was moving. */
export interface CargoSnapshotRow extends CargoRow {
  /** velocity over the step before the snapshot, m/s to the millimetre per second; absent for a body that step spawned */
  vel?: [number, number, number]
  /** what its body had a contact with in that step: scene part ids, `cargo <id>`, `floor` (absent when the runner
   *  cannot say) */
  touching?: string[]
}

/** What a runner can tell {@link CargoSnapshots} beyond the frame, asked for only when a snapshot is taken. */
export interface FrameExtras {
  /** by frame id, what each cargo body touched in the step (sim/cargoContacts.ts) */
  contacts?: () => ReadonlyMap<number, readonly string[]>
}

/** The live cargo at one asked-for time: `at` is the time asked for, `t` the first step that reached it. */
export interface CargoSnapshot {
  at: number
  t: number
  bodies: CargoSnapshotRow[]
}

/** Where the cargo is at chosen sim times of a test run (`test-project --cargo`, run_test's `cargo`). Hand
 *  {@link onFrame} to the runner as its `onFrame`. */
export class CargoSnapshots {
  readonly snapshots: CargoSnapshot[] = []
  private readonly pending: number[]
  // the previous step's centres by body id, for each snapshot's velocities (a launched or teleported box shows as a
  // speed no conveyor gives)
  private prev = new Map<number, [number, number, number]>()
  private prevT = 0

  constructor(times: readonly number[]) {
    this.pending = [...times].sort((a, b) => a - b)
  }

  readonly onFrame = (frame: Readonly<BoxFrame>, extras?: FrameExtras): void => {
    if (this.pending.length === 0) return
    while (this.pending.length > 0 && frame.simTime + 1e-9 >= this.pending[0]!) {
      const contacts = extras?.contacts?.()
      const bodies = this.rowsWithVelocity(frame).map((row) => {
        const touching = contacts?.get(row.id)
        return touching ? { ...row, touching: [...touching] } : row
      })
      this.snapshots.push({ at: this.pending.shift()!, t: frame.simTime, bodies })
    }
    const prev = new Map<number, [number, number, number]>()
    for (let i = 0; i < frame.count; i++) prev.set(frame.ids[i]!, [frame.positions[i * 3]!, frame.positions[i * 3 + 1]!, frame.positions[i * 3 + 2]!])
    this.prev = prev
    this.prevT = frame.simTime
  }

  private rowsWithVelocity(frame: Readonly<BoxFrame>): CargoSnapshotRow[] {
    const dt = frame.simTime - this.prevT
    const mm = (v: number): number => Math.round(v * 1000) / 1000
    return cargoRows(frame).map((row, i) => {
      const was = this.prev.get(row.id)
      if (!was || !(dt > 0)) return row
      const at = [frame.positions[i * 3]!, frame.positions[i * 3 + 1]!, frame.positions[i * 3 + 2]!]
      return { ...row, vel: [mm((at[0]! - was[0]) / dt), mm((at[1]! - was[1]) / dt), mm((at[2]! - was[2]) / dt)] }
    })
  }

  /** the asked-for times the run ended before */
  missed(): number[] {
    return [...this.pending]
  }
}

/**
 * Evaluates a spec's probes step by step. One instance per run.
 *
 * Stateful for exactly one reason: {@link BoxFrame.basePoses} only carries a mobile part that drove
 * its base that step (ctx.drive), so an AGV that reaches its target and stops falls out of the
 * frame, which is exactly when an `at`-mode arrival check wants to read it. The last-known base pose is
 * therefore latched, the same way the runner holds PLC outputs between scans.
 */
export class ProbeSampler {
  private readonly probes: { key: string; probe: TestProbe }[] = []
  // `passed`, per probe: every body that has entered its zone, whatever its filters say (entry by any cargo is the
  // witness that the zone is on a path at all), and how many of those matched the filters. Frame ids are never reused
  private readonly passed = new Map<string, { entered: Set<number>; n: number }>()
  // each body's centre on the previous step, for the swept entry test
  private prevPos = new Map<number, [number, number, number]>()
  // the colours some live cargo has had so far in the run: a colour-filtered probe is absent until its colour has been
  // seen (colorWitnessed)
  private readonly colorsSeen = new Set<CargoColor>()
  private readonly lastBase = new Map<string, { pos: [number, number, number]; yaw: number }>()
  // joint commands are latched for the same reason: BoxFrame.joints carries only what a part commanded
  // this step, and a behavior that sets a joint once and holds it is still at that value
  private readonly lastJoint = new Map<string, number>()
  // lamps likewise: BoxFrame.lamps carries only what a part commanded this step
  private readonly lastLamp = new Map<string, boolean>()

  constructor(checks: readonly TestCheck[]) {
    checks.forEach((c, i) => {
      if (c.probe) this.probes.push({ key: probeKey(i), probe: c.probe })
      // a predicate's right-hand probe (`"equals": {"probe": ...}`) is read the same way, under its own key
      for (const v of [c.equals, c.notEquals, c.min, c.max, c.near]) {
        if (isOperand(v) && 'probe' in v) this.probes.push({ key: operandProbeKey(i), probe: v.probe })
      }
    })
    for (const { key, probe } of this.probes) if ('passed' in probe) this.passed.set(key, { entered: new Set(), n: 0 })
  }

  /** true when the spec has no probe checks: the runner can skip sampling entirely */
  get empty(): boolean {
    return this.probes.length === 0
  }

  /** Does a probe filter on marks, so the runner has to hand {@link values} each row's marks? */
  get needsMarks(): boolean {
    return this.probes.some(
      ({ probe }) =>
        ('count' in probe && probe.count.marked !== undefined) || ('passed' in probe && probe.passed.marked !== undefined) || ('square' in probe && probe.square.marked !== undefined),
    )
  }

  /** Read every probe against one step's frame, keyed for the evaluator's sample table. `marks` is each row's marks,
   *  which a `marked` filter reads (a spawned body's are not in the frame). */
  values(frame: BoxFrame, marks?: RowMarks): Record<string, TestValue> {
    const out: Record<string, TestValue> = {}
    if (this.probes.length === 0) return out
    for (const [id, bp] of Object.entries(frame.basePoses ?? {})) this.lastBase.set(id, bp)
    for (const [id, js] of Object.entries(frame.joints ?? {})) for (const [name, v] of Object.entries(js)) this.lastJoint.set(`${id}\u0000${name}`, v)
    for (const [id, ls] of Object.entries(frame.lamps ?? {})) for (const [name, v] of Object.entries(ls)) this.lastLamp.set(`${id}\u0000${name}`, v)
    this.trackColors(frame)
    if (this.passed.size > 0) this.trackPassed(frame, marks)
    for (const { key, probe } of this.probes) {
      let v: TestValue | undefined
      if ('count' in probe) v = this.colorWitnessed(probe.count.color) ? countCargo(probe.count, frame, marks) : undefined
      else if ('passed' in probe) v = this.readPassed(key, probe.passed)
      else if ('square' in probe) v = this.colorWitnessed(probe.square.color) ? readSquare(probe.square, frame, marks) : undefined
      else if ('joint' in probe) v = this.readJoint(probe.joint)
      else if ('lamp' in probe) v = this.readLamp(probe.lamp)
      else v = this.readPose(probe.pose, frame)
      if (v !== undefined) out[key] = v
    }
    return out
  }

  /** A colour filter's witness: has any live cargo had that colour yet? A filter naming a colour no cargo ever has (a
   *  typo, a tint off by one digit) would otherwise count 0 forever and pass every `max 0` check over it. */
  private colorWitnessed(color: CargoColor | undefined): boolean {
    return color === undefined || this.colorsSeen.has(color)
  }

  private trackColors(frame: BoxFrame): void {
    for (const { probe } of this.probes) {
      const color = 'count' in probe ? probe.count.color : 'passed' in probe ? probe.passed.color : 'square' in probe ? probe.square.color : undefined
      if (color === undefined || this.colorsSeen.has(color)) continue
      for (let i = 0; i < frame.count; i++) {
        if (!colorMatches(color, frame, i)) continue
        this.colorsSeen.add(color)
        break
      }
    }
  }

  /** Record each body that entered a `passed` zone this step: its centre is inside, or swept through it since the last
   *  step. */
  private trackPassed(frame: BoxFrame, marks?: RowMarks): void {
    const next = new Map<number, [number, number, number]>()
    for (let i = 0; i < frame.count; i++) {
      const id = frame.ids[i]!
      const p = i * 3
      const here: [number, number, number] = [frame.positions[p]!, frame.positions[p + 1]!, frame.positions[p + 2]!]
      const prev = this.prevPos.get(id)
      next.set(id, here)
      for (const { key, probe } of this.probes) {
        if (!('passed' in probe)) continue
        const t = this.passed.get(key)!
        if (t.entered.has(id)) continue
        const zone = probe.passed.zone
        if (!(prev ? segmentHitsZone(zone, prev, here) : inZone(zone, here[0], here[1], here[2]))) continue
        t.entered.add(id)
        if (matchesFilters(probe.passed, frame, i, marks)) t.n++
      }
    }
    this.prevPos = next
  }

  /** How many matching bodies have entered the zone; absent until any cargo has (a zone on no path would count 0
   *  forever) and, with a colour filter, until cargo of that colour has existed. */
  private readPassed(key: string, spec: PassedProbe): number | undefined {
    const t = this.passed.get(key)!
    if (t.entered.size === 0 || !this.colorWitnessed(spec.color)) return undefined
    return t.n
  }

  /** The part's last commanded value for that joint; undefined until it first commands it. */
  private readJoint(spec: JointProbe): number | undefined {
    return this.lastJoint.get(`${spec.part}\u0000${spec.joint}`)
  }

  /** Whether the part last commanded that lamp lit; undefined until it first commands it. */
  private readLamp(spec: LampProbe): boolean | undefined {
    return this.lastLamp.get(`${spec.part}\u0000${spec.lamp}`)
  }

  /** A driven mobile base first (latched), else an authored cargo body; undefined when neither. */
  private readPose(spec: PoseProbe, frame: BoxFrame): number | undefined {
    const base = this.lastBase.get(spec.part)
    if (base) return spec.axis === 'yaw' ? base.yaw : base.pos[AXIS_INDEX[spec.axis]]
    for (let i = 0; i < frame.count; i++) {
      if (frame.partIds[i] !== spec.part) continue
      if (spec.axis === 'yaw') {
        const q = i * 4
        return quatToYXZ(frame.quats[q]!, frame.quats[q + 1]!, frame.quats[q + 2]!, frame.quats[q + 3]!)[1]
      }
      return frame.positions[i * 3 + AXIS_INDEX[spec.axis]]!
    }
    return undefined
  }
}
