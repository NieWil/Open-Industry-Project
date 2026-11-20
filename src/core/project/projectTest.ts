// Project tests, the pure half: the declarative test-spec shape, its validation, and the
// temporal/predicate evaluator (docs/project-tests.md). No sim, no PLC, no Jolt. You feed the
// evaluator a stream of {simTime, tags} samples and it decides pass/fail, so all the tricky logic
// (three temporal modes × the predicates, plus "tag never appeared") is unit-testable in core.
// The runner that produces those samples by stepping SimWorld + the ST engine lives in the editor
// layer, the only one that can import both sim and plc (editor/project/projectTestRunner.ts).

/** A tag value a check can assert on. Behavior/PLC tags are booleans or numbers. */
export type TestValue = number | boolean

/** A scheduled stimulus: set `tag` to `value` at simulated time `at` (persists until re-set). */
export interface TestInput {
  at: number
  tag: string
  value: TestValue
}

/**
 * What fails. Each kind is a real failure, applied where that failure happens on a real line:
 *  - `sensorStuck`: the device's BOOL outputs read `value` to the PLC whatever the device senses (a failed
 *    photo eye, a broken wire). The part itself still senses; only what reaches the program is stuck.
 *  - `actuatorDead`: the device never receives the PLC's commands (a tripped motor, a failed valve): its
 *    inputs read off (false / 0). The program still believes it commanded the device, which is exactly what
 *    a missing-feedback alarm has to catch.
 *  - `commsLoss`: the I/O connection drops, to one device (`part`) or to all of them. Both directions fail at
 *    once, each to the fault state real I/O is configured with (see {@link CommsFaultMode}).
 *  - `jam`: the first loose cargo body inside `zone` while the fault is in effect stops dead where it stands
 *    (pinned, as the Use key pins one), and everything behind it backs up against it under real physics.
 *    `until` clears the jam: the body is released and rides on. A physical fault, not a signal one: no tag is
 *    touched, so the program can only learn of it the way a real one does, from its sensors.
 */
export type FaultKind = 'sensorStuck' | 'actuatorDead' | 'commsLoss' | 'jam'

/**
 * What a signal reads while its connection is down: `off` (false / 0), or `hold` (the last value it had
 * before the loss). Real platforms differ. Remote outputs are usually configured to go off, while one controller
 * family holds its inputs at their last value and another zeroes them. So a test says which machine it models.
 */
export type CommsFaultMode = 'off' | 'hold'

/** When a fault is in effect: from simulated time `at`, until `until` (it clears) or the end of the run. */
interface FaultWindow {
  at: number
  until?: number
}

/**
 * A scheduled fault. A device fault names the device (`part`, a part id), not its tags: the runner resolves
 * which tags it touches from the tag params the part's package declares with a direction, so renaming a tag
 * does not break the test.
 */
export type TestFault =
  | (FaultWindow & { kind: 'actuatorDead'; part: string })
  | (FaultWindow & { kind: 'sensorStuck'; part: string; value: boolean })
  | (FaultWindow & {
      kind: 'commsLoss'
      /** the one device whose connection drops; omitted = every device (the network itself) */
      part?: string
      /** what the PLC reads from the lost devices (default `off`) */
      inputs?: CommsFaultMode
      /** what the lost devices receive (default `off`) */
      outputs?: CommsFaultMode
      /** a PLC input that reads true while the connection is down: the connection-fault bit a real controller
       *  gives the program, which is how it can tell a lost device from a quiet one */
      statusTag?: string
    })
  | (FaultWindow & {
      kind: 'jam'
      /** where it jams (world metres, inclusive): it catches the first loose body whose centre is in it */
      zone: Zone
    })

/** A fault's name in messages and traces: `actuatorDead(m1)`, `commsLoss(all)`, `jam([4, 0, -0.5]..[5, 1, 0.5])`. */
export function describeFault(f: TestFault): string {
  if (f.kind === 'jam') return `jam(${fmtVec(f.zone.min)}..${fmtVec(f.zone.max)})`
  return `${f.kind}(${f.part ?? 'all'})`
}

/** A fault resolved against a scene: the global tag keys it forces and what to, on which side of the PLC. One fault
 *  may resolve to several of these (a comms loss acts on both sides, and on its status bit). */
export interface ResolvedFault {
  fault: TestFault
  /** `toPlc`: what the program reads from the device (sensor side); `toPart`: what the device receives (actuator side) */
  side: 'toPlc' | 'toPart'
  /** the values forced while the fault is in effect; with {@link hold}, only the fallback for a key that had no
   *  value yet when the fault began */
  forced: Readonly<Record<string, TestValue>>
  /** the keys keep the values they had the moment the fault began */
  hold?: boolean
  /** the values forced while the fault is not in effect (a status bit reading false before and after) */
  idle?: Readonly<Record<string, TestValue>>
}

/** Is a fault in effect at `time`? From `at` (inclusive) to `until` (exclusive), the window `inputs` use. */
export function faultActive(f: TestFault, time: number): boolean {
  return f.at <= time + EPS && (f.until === undefined || time + EPS < f.until)
}

/**
 * The faults of one run, stepped forward in time. Stateful only for `hold`: a held key keeps what it read the
 * moment its fault began, which only the live table at that moment can say. One instance per run; ask each side
 * once per step, in time order.
 */
export class FaultInjector {
  private readonly held: (Record<string, TestValue> | null)[]

  constructor(private readonly faults: readonly ResolvedFault[]) {
    this.held = faults.map(() => null)
  }

  /** The tag values the faults force on one `side` at `time`. `live` is what that side would read without them (for
   *  `hold`). Idle values first, so a fault in effect outranks them. When two faults force one
   *  key, the later fault's value is used. */
  overrides(side: ResolvedFault['side'], time: number, live: Readonly<Record<string, TestValue>>): Record<string, TestValue> {
    const out: Record<string, TestValue> = {}
    this.faults.forEach((r) => {
      if (r.side === side && r.idle && !faultActive(r.fault, time)) Object.assign(out, r.idle)
    })
    this.faults.forEach((r, i) => {
      if (r.side !== side) return
      if (!faultActive(r.fault, time)) {
        this.held[i] = null
        return
      }
      if (!r.hold) {
        Object.assign(out, r.forced)
        return
      }
      let h = this.held[i]
      if (!h) {
        h = {}
        for (const k of Object.keys(r.forced)) h[k] = live[k] ?? r.forced[k]!
        this.held[i] = h
      }
      Object.assign(out, h)
    })
    return out
  }
}

/** An axis-aligned world-space box in metres. Bounds are inclusive on every axis. */
export interface Zone {
  min: [number, number, number]
  max: [number, number, number]
}

/** Which scalar of a part's pose a {@link PoseProbe} reads. `yaw` is radians about +Y. */
export type PoseAxis = 'x' | 'y' | 'z' | 'yaw'

/**
 * A cargo colour filter: `red` / `green` / `blue` / `yellow` (the dominant channel of a saturated tint, or red and
 * green together over a low blue; see projectProbe.ts `cargoColorName`), or an exact `#rrggbb` tint as the scene
 * authors it (a spawner's `boxColors`, a box's `color`).
 */
export type CargoColorName = 'red' | 'green' | 'blue' | 'yellow'
export type CargoColor = CargoColorName | `#${string}`
const COLOR_NAMES = ['red', 'green', 'blue', 'yellow'] as const

/** A mark a body must carry (ctx.mark / markHit, or a product attribute): a key whose value is truthy (`"sealed"`), or
 *  one key and the value it must have (`{ "code": 2 }`). */
export type MarkFilter = string | Record<string, number | boolean | string>

/** How many live cargo bodies match. Every filter is optional and a body must match all that are given; `{}`
 *  counts all live cargo in the scene. `part` narrows to one authored cargo id: 0 or 1, which is the
 *  idiom for "this pallet still exists" (see the `always` note in docs/project-tests.md). `marked` counts only the
 *  bodies carrying that mark: the cases a labeller labelled, those a scanner read with a given code. */
export interface CountProbe {
  zone?: Zone
  part?: string
  kind?: 'box' | 'pallet' | 'tote'
  color?: CargoColor
  marked?: MarkFilter
}

/**
 * How many cargo bodies have entered `zone` since the run began: cumulative, so it only grows, and a body counts
 * once however long it stays or whether it is despawned later. "Boxes that passed this point", independent of when
 * they arrived, which a zone snapshot (`count`) is not. Entry is tested on the path a body's centre swept between two
 * steps, so a box thrown through a thin zone still counts. The other filters (ANDed) are as {@link CountProbe}'s.
 */
export interface PassedProbe {
  zone: Zone
  part?: string
  kind?: 'box' | 'pallet' | 'tote'
  color?: CargoColor
  /** as {@link CountProbe.marked}, judged as the body enters the zone */
  marked?: MarkFilter
}

/**
 * How far the cargo in `zone` is turned off `heading`: the worst of the matching bodies inside it this step, in degrees
 * from 0 (square) to 45, to a tenth of a degree. The angle is folded by 90, so any edge parallel to the heading counts as square, which is what
 * "square to the spur" means for a rectangular case. `heading` is degrees about +Y as a part's `rotationY` measures it
 * (a spur's own rotationY, in degrees). Absent on a step with no matching body in the zone, so `always` + `max` holds
 * over the bodies that pass through, and a zone off their path fails as never appeared. The filters are `count`'s.
 */
export interface SquareProbe extends PassedProbe {
  heading: number
}

/** Where a part actually is: a mobile part's driven base (ctx.drive) or an authored cargo body. */
export interface PoseProbe {
  part: string
  axis: PoseAxis
}

/** A rig part's joint value (radians / metres): the last value its behavior commanded (ctx.setJoint), latched
 *  between commands; the host still clamps it to the joint's [min, max]. Absent until the part first commands
 *  it, so a mistyped part or joint name fails as "never appeared" rather than reading 0. The way to test a
 *  stroke's travel time or a blade's height without making the behavior publish a debug tag. */
export interface JointProbe {
  part: string
  joint: string
}

/**
 * A world probe: a number read out of the simulation step itself rather than off a tag, so a check
 * can assert on what physically happened (cargo arrived, a vehicle stopped where it should) instead
 * of only on what the control program believes. A source, not a new kind of check: a
 * probe substitutes for `tag`, and every temporal mode and predicate applies to it unchanged.
 * Evaluated by {@link ProbeSampler} in projectProbe.ts.
 */
/** A part's lamp: whether its behavior last commanded it lit (`ctx.lamps.<name>` / setEmissive), latched between
 *  commands; a boolean, so `equals: true` / `false`. Absent until the part first commands it, so a mistyped part or
 *  lamp name fails as "never appeared". The way to test an indicator without making the behavior publish a debug
 *  tag. It reads the command, not the pixels: a lamp lit at rest by its `param` and never commanded is absent. */
export interface LampProbe {
  part: string
  lamp: string
}

export type TestProbe = { count: CountProbe } | { passed: PassedProbe } | { square: SquareProbe } | { pose: PoseProbe } | { joint: JointProbe } | { lamp: LampProbe }

/**
 * The other side of a comparison, read at the same step as the check's source: another tag, or a probe. What lets a
 * check say "Sorted1 equals Lane1Out" (or "Sorted1 equals the red boxes that passed lane 1") instead of pinning both
 * to a number that any layout change moves. Absent like a source is: a step where it is missing is not compared,
 * and one that never appears fails the check.
 */
export type TestOperand = { tag: string } | { probe: TestProbe }

/**
 * One assertion, with exactly one of each:
 *  - source: `tag` (a PLC/behavior tag) or `probe` (a world reading);
 *  - temporal mode: `at` (sample once at time t), `always` (invariant), or `eventually` (holds at some step);
 *  - predicate: `equals` / `notEquals` (exact), `min`/`max` (numeric bound), or `near` (± `tolerance`), each
 *    against a literal or a {@link TestOperand}; or a range, `min` and `max` together, both numbers.
 * `always` and `eventually` hold over the window [`from`, `until`] (default: the whole run).
 */
export interface TestCheck {
  // source (exactly one)
  tag?: string
  probe?: TestProbe
  // temporal (exactly one)
  at?: number
  always?: boolean
  eventually?: boolean
  from?: number // window start for `always` / `eventually` (default 0)
  until?: number // window end for `always` / `eventually` (default: the run's end)
  within?: number // the older spelling of `until`, for `eventually` only
  // predicate (exactly one)
  equals?: TestValue | TestOperand
  notEquals?: TestValue | TestOperand
  min?: number | TestOperand
  max?: number | TestOperand
  near?: number | TestOperand
  tolerance?: number // modifier for `near` (defaults to 0)
}

/**
 * A declarative project test: run the project's scene for `duration` simulated seconds, poke `inputs`, assert
 * `checks`. (A spec from when a project held several scenes may still name one in `scene`; it is read only to route
 * the spec when such a project splits (core/project/project.ts validateProject), and is not kept.)
 */
export interface TestSpec {
  /** display name (defaults to the file name at the CLI) */
  name?: string
  /** simulated seconds to run */
  duration: number
  /** PLC scan period in ms (defaults to the project's scan time, as Play scans) */
  scanMs?: number
  inputs?: TestInput[]
  /** devices that fail during the run (sensor stuck, actuator dead), each from `at` until `until` */
  faults?: TestFault[]
  checks: TestCheck[]
}

export interface CheckResult {
  check: TestCheck
  ok: boolean
  /** human-readable outcome: what held, or what failed with the time + observed value */
  detail: string
  /** when a failed check failed, in sim seconds: an `at` check's time, the moment an `always` broke, the end of the
   *  window an `eventually` missed. What a trace of the run is centred on (projectTestRunner.ts `failureContext`) */
  failedAt?: number
  /** a passing check that proves less than it reads: an `eventually` over a window from the start of the run that
   *  already held on its first sample, so nothing had to happen for it to pass */
  warning?: string
}

export interface TestResult {
  ok: boolean
  checks: CheckResult[]
}

const TEMPORAL_KEYS = ['at', 'always', 'eventually'] as const
const PREDICATE_KEYS = ['equals', 'min', 'max', 'near', 'notEquals'] as const
type PredicateKey = (typeof PREDICATE_KEYS)[number]
const SOURCE_KEYS = ['tag', 'probe'] as const
const PROBE_KINDS = ['count', 'pose', 'joint', 'lamp', 'passed', 'square'] as const
const FAULT_KINDS: readonly FaultKind[] = ['sensorStuck', 'actuatorDead', 'commsLoss', 'jam']
const POSE_AXES: readonly PoseAxis[] = ['x', 'y', 'z', 'yaw']

/**
 * The sample-table key a probe check's value is stored under. NUL-prefixed so it can never collide with
 * an ST identifier or a part's tag name. The evaluator only ever sees one flat table, and a scene
 * must not be able to shadow a probe (or vice versa) by naming a tag cleverly.
 */
export const probeKey = (index: number): string => '\u0000probe' + index

/** The sample-table key of a check's probe operand (`"equals": {"probe": ...}`), NUL-prefixed like {@link probeKey}. */
export const operandProbeKey = (index: number): string => '\u0000operand' + index

const fmtVec = (v: readonly number[]): string => `[${v.join(', ')}]`

/** Human-readable form of a probe, for check details and error messages. */
export function describeProbe(p: TestProbe): string {
  if ('pose' in p) return `pose(${p.pose.part}.${p.pose.axis})`
  if ('joint' in p) return `joint(${p.joint.part}.${p.joint.joint})`
  if ('lamp' in p) return `lamp(${p.lamp.part}.${p.lamp.lamp})`
  const f: CountProbe = 'passed' in p ? p.passed : 'square' in p ? p.square : p.count
  const filters: string[] = []
  if ('square' in p) filters.push(`heading ${p.square.heading}°`)
  if (f.part !== undefined) filters.push(`part ${f.part}`)
  if (f.color !== undefined) filters.push(f.color)
  if (f.kind !== undefined) filters.push(f.kind)
  if (f.marked !== undefined) filters.push(typeof f.marked === 'string' ? `marked ${f.marked}` : `marked ${Object.entries(f.marked).map(([k, v]) => `${k}=${v}`).join('')}`)
  if (f.zone) filters.push(`zone ${fmtVec(f.zone.min)}..${fmtVec(f.zone.max)}`)
  return `${'passed' in p ? 'passed' : 'square' in p ? 'square' : 'count'}(${filters.length > 0 ? filters.join(', ') : 'all cargo'})`
}

/** Is a predicate's right-hand side another tag or a probe, rather than a literal? */
export function isOperand(v: unknown): v is TestOperand {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValue(v: unknown): v is TestValue {
  return typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
}

function validateVec3(raw: unknown, path: string, errors: string[]): [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    errors.push(`${path} must be 3 finite numbers [x, y, z]`)
    return undefined
  }
  return [raw[0] as number, raw[1] as number, raw[2] as number]
}

function validateZone(raw: unknown, path: string, errors: string[]): Zone | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${path} must be an object with min + max`)
    return undefined
  }
  const z = raw as Record<string, unknown>
  const min = validateVec3(z.min, `${path}.min`, errors)
  const max = validateVec3(z.max, `${path}.max`, errors)
  if (!min || !max) return undefined
  // A reversed bound matches nothing, so every check over it succeeds or fails vacuously. That is the
  // silent pass this harness exists to prevent (as with "tag never appeared"), so reject it.
  let ok = true
  for (let i = 0; i < 3; i++) {
    if (min[i]! > max[i]!) {
      errors.push(`${path} is reversed on ${'xyz'[i]} (min ${min[i]} > max ${max[i]}) - it would match nothing`)
      ok = false
    }
  }
  return ok ? { min, max } : undefined
}

/** Structural validation of one check's `probe`, returning the normalized probe or undefined. */
function validateProbe(raw: unknown, path: string, errors: string[]): TestProbe | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${path} must be an object with exactly one of ${PROBE_KINDS.join('/')}`)
    return undefined
  }
  const p = raw as Record<string, unknown>
  const kinds = PROBE_KINDS.filter((k) => p[k] !== undefined)
  if (kinds.length !== 1) {
    errors.push(`${path} must have exactly one of ${PROBE_KINDS.join('/')}`)
    return undefined
  }

  if (kinds[0] === 'count' || kinds[0] === 'passed' || kinds[0] === 'square') {
    const kind = kinds[0]
    const c = p[kind]
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      errors.push(
        kind === 'count'
          ? `${path}.count must be an object of filters (use {} to count all cargo)`
          : kind === 'passed'
            ? `${path}.passed must be an object with a zone (and optional filters)`
            : `${path}.square must be an object with a zone and a heading (and optional filters)`,
      )
      return undefined
    }
    const f = c as Record<string, unknown>
    const out: CountProbe = {}
    let ok = true
    for (const k of Object.keys(f)) {
      if (k === 'heading' && kind === 'square') continue
      if (k !== 'part' && k !== 'kind' && k !== 'zone' && k !== 'color' && k !== 'marked') {
        errors.push(`${path}.${kind}.${k} is not a filter (part/kind/color/marked/zone${kind === 'square' ? '/heading' : ''})`)
        ok = false
      }
    }
    let heading: number | undefined
    if (kind === 'square') {
      if (typeof f.heading !== 'number' || !Number.isFinite(f.heading)) {
        errors.push(`${path}.square.heading is required: the direction in degrees about +Y the cargo should be square to (a spur's rotationY, in degrees)`)
        ok = false
      } else heading = f.heading
    }
    if (f.part !== undefined) {
      if (typeof f.part !== 'string' || f.part === '') {
        errors.push(`${path}.${kind}.part must be a non-empty part id`)
        ok = false
      } else out.part = f.part
    }
    if (f.kind !== undefined) {
      if (f.kind !== 'box' && f.kind !== 'pallet' && f.kind !== 'tote') {
        errors.push(`${path}.${kind}.kind must be "box", "pallet" or "tote"`)
        ok = false
      } else out.kind = f.kind
    }
    if (f.color !== undefined) {
      const color = typeof f.color === 'string' ? f.color.toLowerCase() : undefined
      if (color === undefined || !((COLOR_NAMES as readonly string[]).includes(color) || /^#[0-9a-f]{6}$/.test(color))) {
        errors.push(`${path}.${kind}.color must be ${COLOR_NAMES.join('/')} or a "#rrggbb" tint`)
        ok = false
      } else out.color = color as CargoColor
    }
    if (f.marked !== undefined) {
      const m = f.marked
      const entries = typeof m === 'object' && m !== null && !Array.isArray(m) ? Object.entries(m) : null
      if (typeof m === 'string' && m !== '') out.marked = m
      else if (entries && entries.length === 1 && entries[0]![0] !== '' && ['number', 'boolean', 'string'].includes(typeof entries[0]![1])) out.marked = { [entries[0]![0]]: entries[0]![1] as number | boolean | string }
      else {
        errors.push(`${path}.${kind}.marked must be a mark key ("sealed": the mark is truthy) or one key and its value ({ "code": 2 })`)
        ok = false
      }
    }
    if (f.zone !== undefined) {
      const zone = validateZone(f.zone, `${path}.${kind}.zone`, errors)
      if (zone) out.zone = zone
      else ok = false
    } else if (kind === 'passed') {
      errors.push(`${path}.passed.zone is required: the place the cargo passes`)
      ok = false
    } else if (kind === 'square') {
      errors.push(`${path}.square.zone is required: the place the cargo should be square in`)
      ok = false
    }
    if (!ok) return undefined
    if (kind === 'square') return { square: { ...(out as PassedProbe), heading: heading! } }
    return kind === 'count' ? { count: out } : { passed: out as PassedProbe }
  }

  if (kinds[0] === 'joint') {
    const jo = p.joint
    if (typeof jo !== 'object' || jo === null || Array.isArray(jo)) {
      errors.push(`${path}.joint must be an object with part + joint`)
      return undefined
    }
    const j = jo as Record<string, unknown>
    let jok = true
    if (typeof j.part !== 'string' || j.part === '') {
      errors.push(`${path}.joint.part must be a non-empty part id`)
      jok = false
    }
    if (typeof j.joint !== 'string' || j.joint === '') {
      errors.push(`${path}.joint.joint must be the joint's name (from the part's rig)`)
      jok = false
    }
    return jok ? { joint: { part: j.part as string, joint: j.joint as string } } : undefined
  }

  if (kinds[0] === 'lamp') {
    const lo = p.lamp
    if (typeof lo !== 'object' || lo === null || Array.isArray(lo)) {
      errors.push(`${path}.lamp must be an object with part + lamp`)
      return undefined
    }
    const l = lo as Record<string, unknown>
    let lok = true
    if (typeof l.part !== 'string' || l.part === '') {
      errors.push(`${path}.lamp.part must be a non-empty part id`)
      lok = false
    }
    if (typeof l.lamp !== 'string' || l.lamp === '') {
      errors.push(`${path}.lamp.lamp must be the lamp's name (a \`ctx.lamps\` key)`)
      lok = false
    }
    return lok ? { lamp: { part: l.part as string, lamp: l.lamp as string } } : undefined
  }

  const po = p.pose
  if (typeof po !== 'object' || po === null || Array.isArray(po)) {
    errors.push(`${path}.pose must be an object with part + axis`)
    return undefined
  }
  const f = po as Record<string, unknown>
  let ok = true
  if (typeof f.part !== 'string' || f.part === '') {
    errors.push(`${path}.pose.part must be a non-empty part id`)
    ok = false
  }
  if (!POSE_AXES.includes(f.axis as PoseAxis)) {
    errors.push(`${path}.pose.axis must be one of ${POSE_AXES.join('/')}`)
    ok = false
  }
  return ok ? { pose: { part: f.part as string, axis: f.axis as PoseAxis } } : undefined
}

/** What a probe yields: a lamp is lit or dark, everything else a number. A tag's type is unknown until the run. */
const probeYields = (p: TestProbe): 'bool' | 'number' => ('lamp' in p ? 'bool' : 'number')

/** A predicate's `{"tag": ...}` / `{"probe": ...}` right-hand side, normalized, or undefined. */
function validateOperand(raw: TestOperand, path: string, errors: string[]): TestOperand | undefined {
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== 1 || (keys[0] !== 'tag' && keys[0] !== 'probe')) {
    errors.push(`${path} must be a literal, or an object with exactly one of tag/probe (what to compare with)`)
    return undefined
  }
  if (keys[0] === 'tag') {
    if (typeof o.tag !== 'string' || o.tag === '') {
      errors.push(`${path}.tag must be a non-empty tag name`)
      return undefined
    }
    return { tag: o.tag }
  }
  const probe = validateProbe(o.probe, `${path}.probe`, errors)
  return probe ? { probe } : undefined
}

/** A predicate whose sides can never be of one type could never hold: refuse it here, not as an every-step failure. */
function checkPredicateTypes(at: string, pk: PredicateKey, probe: TestProbe | undefined, rhs: unknown, operand: TestOperand | undefined, errors: string[]): void {
  const src = probe ? probeYields(probe) : undefined
  const other = operand ? ('probe' in operand ? probeYields(operand.probe) : undefined) : typeof rhs === 'boolean' ? 'bool' : 'number'
  const numeric = pk === 'min' || pk === 'max' || pk === 'near'
  if (src === 'bool' && (numeric || other === 'number')) {
    errors.push(`${at} must use equals: true or false (or notEquals) - ${describeProbe(probe!)} yields lit / dark, not a number`)
  } else if (numeric && other === 'bool') {
    errors.push(`${at}.${pk} compares with ${describeProbe((operand as { probe: TestProbe }).probe)}, which yields lit / dark, not a number`)
  } else if (src === 'number' && other === 'bool') {
    errors.push(
      operand
        ? `${at}.${pk} compares a count/coordinate with ${describeProbe((operand as { probe: TestProbe }).probe)}, which yields lit / dark`
        : `${at}.${pk} must be a number - ${describeProbe(probe!)} yields a count/coordinate, not a BOOL`,
    )
  }
}

/**
 * The window of an `always` / `eventually`: `from` and `until` (or, for `eventually`, the older `within`). A window
 * that starts or ends past the run, or ends before it starts, would hold over no step at all: refused, like a
 * reversed zone, because a check over nothing passes or fails for no reason.
 */
function validateWindow(c: Record<string, unknown>, at: string, duration: number, errors: string[]): void {
  if (c?.from === undefined && c?.until === undefined) return
  if (c.always === undefined && c.eventually === undefined) {
    errors.push(`${at}: from/until are only for always or eventually (an "at" check samples one moment)`)
    return
  }
  if (c.until !== undefined && c.within !== undefined) errors.push(`${at}: give until or within, not both (within is the older spelling of until)`)
  const from = c.from
  const until = c.until
  if (from !== undefined && (typeof from !== 'number' || !(from >= 0))) errors.push(`${at}.from must be a time ≥ 0`)
  else if (typeof from === 'number' && from >= duration) errors.push(`${at}.from (${from}s) is not before the end of the run (duration ${duration}s)`)
  if (until !== undefined && (typeof until !== 'number' || !(until > 0))) errors.push(`${at}.until must be a positive time`)
  else if (typeof until === 'number' && until > duration + EPS) errors.push(`${at}.until (${until}s) is past the end of the run (duration ${duration}s)`)
  const end = typeof until === 'number' ? until : c.within
  if (typeof from === 'number' && typeof end === 'number' && !(end > from)) errors.push(`${at}: the window ends (${end}s) before it starts (from ${from}s)`)
}

/**
 * The spec's `count` and `passed` probes checked against the scene: their `part` names one placed part by its id.
 * Anything else matches no cargo, and a count of nothing is 0, never "absent", so the check would fail or pass on
 * that 0 with no word why. The common slip is a part type (`oip.box`, what ctx.zone's `{ part }` filter takes), so
 * that error names the placed parts of the type. Returns one message per bad probe.
 */
export function probePartErrors(parts: readonly { id: string; packageId?: string }[], checks: readonly TestCheck[]): string[] {
  const ids = new Set(parts.map((p) => p.id))
  const errors: string[] = []
  checks.forEach((c, i) => {
    const operands = (['equals', 'notEquals', 'min', 'max', 'near'] as const).map((k) => c[k])
    const probes = [c.probe, ...operands.map((o) => (o !== null && typeof o === 'object' && 'probe' in o ? o.probe : undefined))]
    for (const p of probes) {
      const part = p && 'count' in p ? p.count.part : p && 'passed' in p ? p.passed.part : p && 'square' in p ? p.square.part : undefined
      if (part === undefined || ids.has(part)) continue
      const ofType = parts.filter((q) => q.packageId === part).map((q) => q.id)
      errors.push(
        ofType.length > 0
          ? `checks[${i}]: "part": "${part}" is a part type, and "part" takes one placed part's id (${ofType.slice(0, 4).join(', ')}${ofType.length > 4 ? ', ...' : ''}). To count every ${part}, leave "part" out, or filter by "kind"`
          : `checks[${i}]: "part": "${part}" is no placed part in the scene (it takes a placed part's id)`,
      )
    }
  })
  return errors
}

/** Structural validation of an untrusted test spec. Returns a normalized spec or a list of errors. */
export function validateTestSpec(data: unknown): { ok: true; spec: TestSpec } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['test must be a JSON object'] }
  }
  const d = data as Record<string, unknown>

  if (typeof d.duration !== 'number' || !(d.duration > 0)) errors.push('duration must be a positive number of seconds')
  if (d.scene !== undefined && typeof d.scene !== 'string') errors.push('scene must be a scene id string')
  if (d.scanMs !== undefined && (typeof d.scanMs !== 'number' || !(d.scanMs > 0))) errors.push('scanMs must be a positive number')

  const inputs: TestInput[] = []
  if (d.inputs !== undefined) {
    if (!Array.isArray(d.inputs)) errors.push('inputs must be an array')
    else
      d.inputs.forEach((raw, i) => {
        const r = raw as Record<string, unknown>
        if (typeof r?.at !== 'number' || r.at < 0) errors.push(`inputs[${i}].at must be a time ≥ 0`)
        if (typeof r?.tag !== 'string' || r.tag === '') errors.push(`inputs[${i}].tag must be a non-empty string`)
        if (!isValue(r?.value)) errors.push(`inputs[${i}].value must be a boolean or finite number`)
        if (errors.length === 0) inputs.push({ at: r.at as number, tag: r.tag as string, value: r.value as TestValue })
      })
  }

  const faults: TestFault[] = []
  if (d.faults !== undefined) {
    if (!Array.isArray(d.faults)) errors.push('faults must be an array')
    else
      d.faults.forEach((raw, i) => {
        const at = `faults[${i}]`
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          errors.push(`${at} must be an object { at, kind, ... }`)
          return
        }
        const r = raw as Record<string, unknown>
        const before = errors.length
        if (typeof r.at !== 'number' || !(r.at >= 0)) errors.push(`${at}.at must be a time ≥ 0`)
        if (r.until !== undefined && (typeof r.until !== 'number' || typeof r.at !== 'number' || !(r.until > r.at))) {
          errors.push(`${at}.until must be a time after at (when the fault clears)`)
        }
        if (!FAULT_KINDS.includes(r.kind as FaultKind)) {
          errors.push(`${at}.kind must be one of ${FAULT_KINDS.join('/')}`)
          return
        }
        const comms = r.kind === 'commsLoss'
        const jam = r.kind === 'jam'
        // a device fault names its device; a comms loss may (one device's connection) or not (the network); a jam
        // is a place, not a device
        if (jam) {
          if (r.part !== undefined) errors.push(`${at}.part is not for a jam: it catches whatever enters its zone`)
        } else if (r.part !== undefined || !comms) {
          if (typeof r.part !== 'string' || r.part === '') errors.push(`${at}.part must be a part id`)
        }
        const zone = jam ? validateZone(r.zone, `${at}.zone`, errors) : undefined
        if (!jam && r.zone !== undefined) errors.push(`${at}.zone is only for jam`)
        // a stuck sensor reads a value, and which way it sticks is what the test is about; nothing else has a value
        if (r.kind === 'sensorStuck' && typeof r.value !== 'boolean') errors.push(`${at}.value must be true or false: what the stuck sensor reads`)
        if (r.kind !== 'sensorStuck' && r.value !== undefined) errors.push(`${at}.value is only for sensorStuck`)
        for (const k of ['inputs', 'outputs'] as const) {
          if (r[k] === undefined) continue
          if (!comms) errors.push(`${at}.${k} is only for commsLoss`)
          else if (r[k] !== 'off' && r[k] !== 'hold') errors.push(`${at}.${k} must be "off" or "hold"`)
        }
        if (r.statusTag !== undefined) {
          if (!comms) errors.push(`${at}.statusTag is only for commsLoss`)
          else if (typeof r.statusTag !== 'string' || r.statusTag === '') errors.push(`${at}.statusTag must be a PLC input's name`)
        }
        if (errors.length > before) return
        const window = { at: r.at as number, ...(r.until !== undefined ? { until: r.until as number } : {}) }
        if (r.kind === 'sensorStuck') faults.push({ ...window, kind: 'sensorStuck', part: r.part as string, value: r.value as boolean })
        else if (r.kind === 'actuatorDead') faults.push({ ...window, kind: 'actuatorDead', part: r.part as string })
        else if (jam) faults.push({ ...window, kind: 'jam', zone: zone! })
        else
          faults.push({
            ...window,
            kind: 'commsLoss',
            ...(r.part !== undefined ? { part: r.part as string } : {}),
            ...(r.inputs !== undefined ? { inputs: r.inputs as CommsFaultMode } : {}),
            ...(r.outputs !== undefined ? { outputs: r.outputs as CommsFaultMode } : {}),
            ...(r.statusTag !== undefined ? { statusTag: r.statusTag as string } : {}),
          })
      })
  }

  if (!Array.isArray(d.checks) || d.checks.length === 0) {
    errors.push('checks must be a non-empty array')
    return { ok: false, errors }
  }
  const checks: TestCheck[] = []
  d.checks.forEach((raw, i) => {
    const c = raw as Record<string, unknown>
    const at = `checks[${i}]`
    // source: a tag or a world probe, never both, since everything downstream reads one value per step.
    const sources = SOURCE_KEYS.filter((k) => c?.[k] !== undefined)
    if (sources.length !== 1) errors.push(`${at} must have exactly one of ${SOURCE_KEYS.join('/')}`)
    if (c?.tag !== undefined && (typeof c.tag !== 'string' || c.tag === '')) errors.push(`${at}.tag must be a non-empty string`)
    const probe = c?.probe !== undefined ? validateProbe(c.probe, `${at}.probe`, errors) : undefined
    const temporal = TEMPORAL_KEYS.filter((k) => c?.[k] !== undefined)
    if (temporal.length !== 1) errors.push(`${at} must have exactly one of ${TEMPORAL_KEYS.join('/')}`)
    if (c?.at !== undefined && (typeof c.at !== 'number' || c.at < 0)) errors.push(`${at}.at must be a time ≥ 0`)
    if (c?.within !== undefined && (typeof c.within !== 'number' || c.within <= 0)) errors.push(`${at}.within must be a positive time`)
    validateWindow(c, at, typeof d.duration === 'number' ? d.duration : Infinity, errors)
    const given = PREDICATE_KEYS.filter((k) => c?.[k] !== undefined)
    // a range is `min` and `max` together, both numbers: checked here and then judged as one predicate
    const range = given.length === 2 && given.includes('min') && given.includes('max')
    if (range) {
      if (typeof c.min !== 'number' || typeof c.max !== 'number' || !Number.isFinite(c.min) || !Number.isFinite(c.max)) errors.push(`${at}: a range (min and max together) takes two numbers`)
      else if (c.min > c.max) errors.push(`${at}: the range's min (${c.min}) is above its max (${c.max})`)
    }
    const predicate = range ? [] : given
    if (!range && predicate.length !== 1) errors.push(`${at} must have exactly one of ${PREDICATE_KEYS.join('/')}, or min and max together for a range`)
    // the right-hand side: a literal, or another tag / a probe read at the same step
    let operand: TestOperand | undefined
    const pk = predicate.length === 1 ? predicate[0]! : undefined
    if (pk !== undefined) {
      const rhs = c[pk]
      if (isOperand(rhs)) operand = validateOperand(rhs, `${at}.${pk}`, errors)
      else if (pk === 'equals' || pk === 'notEquals') {
        if (!isValue(rhs)) errors.push(`${at}.${pk} must be a boolean, a finite number, or {"tag": ...} / {"probe": ...}`)
      } else if (typeof rhs !== 'number' || !Number.isFinite(rhs)) errors.push(`${at}.${pk} must be a number, or {"tag": ...} / {"probe": ...}`)
    }
    if (c?.tolerance !== undefined && (typeof c.tolerance !== 'number' || !(c.tolerance >= 0))) errors.push(`${at}.tolerance must be a number ≥ 0`)
    // A probe yields a count or a coordinate (a lamp: a BOOL), so a predicate of the other type can never hold.
    // Catch the type mismatch here instead of letting it read as a mysterious every-step failure. Same for an operand.
    if (pk !== undefined) checkPredicateTypes(at, pk, probe, c[pk], operand, errors)
    // keep the normalized probes (validated 3-vectors, lower-case colours), not the raw JSON they came from
    if (errors.length === 0) checks.push({ ...c, ...(probe ? { probe } : {}), ...(operand && pk ? { [pk]: operand } : {}) } as unknown as TestCheck)
  })

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    spec: {
      ...(typeof d.name === 'string' ? { name: d.name } : {}),
      duration: d.duration as number,
      ...(typeof d.scanMs === 'number' ? { scanMs: d.scanMs } : {}),
      ...(inputs.length > 0 ? { inputs } : {}),
      ...(faults.length > 0 ? { faults } : {}),
      checks,
    },
  }
}

/** A check's predicate, resolved once: which comparison, and its right-hand side (a literal, or a table key). */
interface Predicate {
  /** `range` is `min` and `max` together, judged against `lo`..`hi` */
  op: PredicateKey | 'range'
  lo?: number
  hi?: number
  /** the literal right-hand side, when it is one */
  literal?: TestValue
  /** the sample-table key of the right-hand side, when it is another tag or a probe */
  key?: string
  /** how the right-hand side reads in messages: `3`, `Lane1Out`, `passed(zone …)` */
  label: string
  /** the right-hand side's qualified name for absence messages */
  noun?: string
  tolerance: number
}

const PRED_SYMBOL: Readonly<Record<PredicateKey | 'range', string>> = { equals: '=', notEquals: '≠', min: '≥', max: '≤', near: '≈', range: 'in' }

function predicateOf(check: TestCheck, index: number): Predicate {
  if (typeof check.min === 'number' && typeof check.max === 'number') {
    return { op: 'range', lo: check.min, hi: check.max, literal: check.min, label: `${check.min}..${check.max}`, tolerance: 0 }
  }
  const op = PREDICATE_KEYS.find((k) => check[k] !== undefined) ?? 'equals'
  const rhs = check[op]
  const tolerance = check.tolerance ?? 0
  if (isOperand(rhs)) {
    if ('tag' in rhs) return { op, key: rhs.tag, label: rhs.tag, noun: `tag "${rhs.tag}"`, tolerance }
    return { op, key: operandProbeKey(index), label: describeProbe(rhs.probe), noun: `probe ${describeProbe(rhs.probe)}`, tolerance }
  }
  return { op, ...(rhs !== undefined ? { literal: rhs } : {}), label: String(rhs), tolerance }
}

/** Evaluate a predicate: the observed value against the right-hand side read at the same step. */
function predicateHolds(p: Predicate, value: TestValue, rhs: TestValue): boolean {
  switch (p.op) {
    case 'equals':
      return value === rhs
    case 'notEquals':
      return value !== rhs
    case 'min':
      return typeof value === 'number' && typeof rhs === 'number' && value >= rhs
    case 'max':
      return typeof value === 'number' && typeof rhs === 'number' && value <= rhs
    case 'near':
      return typeof value === 'number' && typeof rhs === 'number' && Math.abs(value - rhs) <= p.tolerance
    case 'range':
      return typeof value === 'number' && value >= p.lo! && value <= p.hi!
  }
}

/** `= 3`, `≥ Lane1Out`, `≈ 1.2 (±0.05)`; with `rhs`, an operand's value at that moment too: `= Lane1Out (8)`. */
function describePredicate(p: Predicate, rhs?: TestValue): string {
  const side = p.key !== undefined && rhs !== undefined ? `${p.label} (${rhs})` : p.label
  return `${PRED_SYMBOL[p.op]} ${side}${p.op === 'near' ? ` (±${p.tolerance})` : ''}`
}

const EPS = 1e-9

/** The span a check is judged over, in sim seconds: `at` is a point; `always` / `eventually` a window. */
function windowOf(check: TestCheck, duration: number): { from: number; to: number } {
  if (check.at !== undefined) return { from: check.at, to: check.at }
  const from = check.from ?? 0
  if (check.always) return { from, to: check.until ?? Infinity }
  return { from, to: check.until ?? check.within ?? duration }
}

/** ` between t=12s and t=19s`, ` from t=12s`, or nothing for the whole run. */
function describeWindow(check: TestCheck): string {
  if (check.from === undefined && check.until === undefined) return ''
  if (check.until === undefined) return ` from t=${check.from}s`
  return ` between t=${check.from ?? 0}s and t=${check.until}s`
}

/**
 * Consumes a run's {@link sample} stream and finalizes a verdict per check. One instance per run.
 * `at` fires once at the first sample whose time reaches the target; `always` fails on the first
 * violating sample inside its window; `eventually` passes on the first satisfying sample inside its
 * window. A check whose source (or right-hand tag / probe) never appears in any sample fails with
 * "never appeared" (catches typos), and an `always` that never once had both sides inside its window
 * fails too: it held over nothing.
 *
 * A check's source is resolved once, up front: a `tag` reads its own name out of the sample table,
 * a `probe` reads {@link probeKey}(i), which the runner fills in from the sim step. A right-hand
 * operand likewise (its tag name, or {@link operandProbeKey}(i)). Everything below is
 * source-agnostic, so probes reuse the whole temporal/predicate matrix.
 */
export class TestEvaluator {
  private readonly duration: number
  /** sample-table key per check */
  private readonly keys: string[]
  /** bare name for value messages ("Conv1_Run", "count(zone …)") */
  private readonly labels: string[]
  /** qualified name for absence messages ('tag "Conv1_Run"', "probe count(zone …)") */
  private readonly nouns: string[]
  private readonly preds: Predicate[]
  private readonly windows: { from: number; to: number }[]
  private readonly states: {
    sawTag: boolean
    /** the right-hand tag / probe appeared at some step (always true for a literal) */
    sawOperand: boolean
    /** some step inside the window had both sides to compare */
    compared: boolean
    // at
    fired: boolean
    // always
    violated: boolean
    violatedAt: number
    // eventually
    satisfied: boolean
    /** it held on the run's first sample */
    heldFirst: boolean
    outcome: boolean
    detail: string
  }[]

  /**
   * Every tag name the run actually produced (probe keys excluded: they are NUL-prefixed and are
   * this harness's own bookkeeping, not something an author can name).
   *
   * Collected so a missing tag can be reported against what exists rather than guessed at. A guess
   * like "typo, or not exposed by the scene" omits the cause that dominates an agent loop: no ST
   * program was loaded at all, so every program tag is absent at once. An agent cannot ask a follow-up
   * question, so a message that names the wrong cause wastes a whole debugging round. Naming the tags
   * that did appear gives it something checkable.
   */
  private readonly seenTags = new Set<string>()
  /** the time of the run's first sample, once there is one */
  private firstTime: number | null = null

  constructor(private readonly spec: TestSpec) {
    this.duration = spec.duration
    this.keys = spec.checks.map((c, i) => c.tag ?? probeKey(i))
    this.labels = spec.checks.map((c) => (c.probe ? describeProbe(c.probe) : (c.tag ?? '(no source)')))
    this.nouns = spec.checks.map((c) => (c.probe ? `probe ${describeProbe(c.probe)}` : `tag "${c.tag}"`))
    this.preds = spec.checks.map((c, i) => predicateOf(c, i))
    this.windows = spec.checks.map((c) => windowOf(c, spec.duration))
    this.states = this.preds.map((p) => ({
      sawTag: false,
      sawOperand: p.key === undefined,
      compared: false,
      fired: false,
      violated: false,
      violatedAt: 0,
      satisfied: false,
      heldFirst: false,
      outcome: false,
      detail: '',
    }))
  }

  /** Feed one sampled step: the sim time and the flat value table observed after that step. */
  sample(time: number, tags: Readonly<Record<string, TestValue>>): void {
    for (const key of Object.keys(tags)) {
      if (key.charCodeAt(0) !== 0) this.seenTags.add(key) // NUL-prefixed keys are probe bookkeeping
    }
    this.firstTime ??= time
    this.spec.checks.forEach((check, i) => {
      const st = this.states[i]!
      const key = this.keys[i]!
      const label = this.labels[i]!
      const pred = this.preds[i]!
      const win = this.windows[i]!
      const present = key in tags
      if (present) st.sawTag = true
      const value = tags[key]
      const rhsPresent = pred.key === undefined || pred.key in tags
      if (pred.key !== undefined && rhsPresent) st.sawOperand = true
      const rhs = pred.key === undefined ? pred.literal! : tags[pred.key]!
      const inWindow = time + EPS >= win.from && time <= win.to + EPS
      const both = present && rhsPresent
      if (both && inWindow) st.compared = true

      if (check.at !== undefined) {
        if (!st.fired && time + EPS >= check.at) {
          st.fired = true
          if (!present) {
            st.outcome = false
            st.detail = `${this.nouns[i]} not present at t=${check.at}s`
          } else if (!rhsPresent) {
            st.outcome = false
            st.detail = `${pred.noun} (the right-hand side) not present at t=${check.at}s`
          } else {
            st.outcome = predicateHolds(pred, value!, rhs)
            st.detail = st.outcome
              ? `${label} ${describePredicate(pred, rhs)} at t=${check.at}s`
              : `${label} was ${value} at t=${check.at}s, expected ${describePredicate(pred, rhs)}`
          }
        }
        return
      }

      if (check.always) {
        if (!st.violated && inWindow && both && !predicateHolds(pred, value!, rhs)) {
          st.violated = true
          st.violatedAt = time
          st.detail = `${label} became ${value} at t=${time.toFixed(2)}s (must always be ${describePredicate(pred, rhs)}${describeWindow(check)})`
        }
        return
      }

      if (check.eventually) {
        if (!st.satisfied && inWindow && both && predicateHolds(pred, value!, rhs)) {
          st.satisfied = true
          // the run's first sample, not the first one with a value: a probe such as `passed` has no value until the
          // thing it counts happens, and then it holds on its first value for a real reason
          st.heldFirst = time <= this.firstTime! + EPS
          st.detail = `${label} reached ${describePredicate(pred, rhs)} at t=${time.toFixed(2)}s`
        }
        return
      }
    })
  }

  /**
   * Why a named tag was absent, stated from what the run actually produced rather than guessed.
   *
   * The two cases are different and get different messages. Zero tags in the whole run means nothing
   * was publishing any: almost always the ST program did not load, which in a folder is usually a
   * `stProgram` the manifest never referenced. Some tags but not this one is a naming problem, and then
   * the useful thing is the list of names that do exist. An agent can act on that immediately, where
   * "typo, or not exposed by the scene" only tells it to go and look.
   */
  private whyNoTag(): string {
    if (this.seenTags.size === 0) {
      return 'no tags existed in this run at all - the scene published none, which usually means its ST program did not load (check the scene\'s "stProgram" in project.json)'
    }
    const names = [...this.seenTags].sort()
    const shown = names.slice(0, 8).join(', ')
    return `the run did publish: ${shown}${names.length > 8 ? `, +${names.length - 8} more` : ''}`
  }

  /** Why a probe never yielded a value, by kind. `count` with no colour always has a value, so it never gets here. */
  private static whyNoProbe(p: TestProbe): string {
    if ('joint' in p) return 'no such part, or it never commanded that joint'
    if ('lamp' in p) return 'no such part, or it never commanded that lamp'
    if ('pose' in p) return 'no such part in the running scene'
    if ('passed' in p) {
      const why = 'no cargo at all entered its zone in the whole run - is the zone on the cargo\'s path?'
      return p.passed.color !== undefined ? `${why} Or no ${p.passed.color} cargo existed in the run` : why
    }
    if ('square' in p) {
      const why = 'no matching cargo was ever inside its zone - is the zone on the cargo\'s path?'
      return p.square.color !== undefined ? `${why} Or no ${p.square.color} cargo existed in the run` : why
    }
    return `no ${p.count.color} cargo existed in the whole run - is the colour right?`
  }

  /** Produce the per-check verdicts. Call once after the last sample. */
  finalize(): TestResult {
    const results: CheckResult[] = this.spec.checks.map((check, i) => {
      const st = this.states[i]!
      const label = this.labels[i]!
      const pred = this.preds[i]!
      if (!st.sawTag) {
        if (check.probe) return { check, ok: false, detail: `${this.nouns[i]} never appeared (${TestEvaluator.whyNoProbe(check.probe)})` }
        return { check, ok: false, detail: `${this.nouns[i]} never appeared (${this.whyNoTag()})` }
      }
      if (!st.sawOperand) {
        const rhs = check[pred.op as PredicateKey] as TestOperand
        const why = 'probe' in rhs ? TestEvaluator.whyNoProbe(rhs.probe) : this.whyNoTag()
        return { check, ok: false, detail: `${pred.noun} (the right-hand side) never appeared (${why})` }
      }
      if (check.at !== undefined) {
        if (!st.fired) return { check, ok: false, detail: `run ended before t=${check.at}s (duration ${this.duration}s)` }
        return { check, ok: st.outcome, detail: st.detail, ...(st.outcome ? {} : { failedAt: check.at }) }
      }
      if (check.always) {
        if (st.violated) return { check, ok: false, detail: st.detail, failedAt: st.violatedAt }
        // an invariant over a window where its source was never there held over nothing: that is not a pass
        if (!st.compared) {
          const what = pred.key !== undefined ? `${label} and ${pred.label} were never both present` : `${label} was never present`
          return { check, ok: false, detail: `${what}${describeWindow(check) || ' during the run'}, so "always ${describePredicate(pred)}" held over nothing`, failedAt: Math.min(this.windows[i]!.to, this.duration) }
        }
        return { check, ok: true, detail: `${label} stayed ${describePredicate(pred)} ${describeWindow(check) ? describeWindow(check).trimStart() : 'for the whole run'}` }
      }
      // eventually
      const win = this.windows[i]!
      const span = check.from !== undefined ? `between t=${win.from}s and t=${win.to}s` : `within ${win.to}s`
      // held from the run's first sample: nothing had to happen for it to pass (a fresh output reads false, a sensor
      // starts clear), so it is likely to pass whatever the line does
      const vacuous = st.heldFirst && win.from <= EPS
      return st.satisfied
        ? { check, ok: true, detail: st.detail, ...(vacuous ? { warning: `already true at the start of the run, so it passes whatever the line does: check it with "at" after it has had time to happen, or check the opposite first` } : {}) }
        : { check, ok: false, detail: `${label} never reached ${describePredicate(pred)} ${span}`, failedAt: Math.min(win.to, this.duration) }
    })
    return { ok: results.every((r) => r.ok), checks: results }
  }
}

// ---------------------------------------------------------------------------
// Traces: what the run did, for whoever has to work out why a check failed
// ---------------------------------------------------------------------------
//
// A failed check says what was wrong ("Motor was false at t=3.2s"). The cause is in the other tags: Stop went on
// at 3.1 s, the eye saw a box at 3.0 s. An agent debugging a program cannot look at a running scene, but the run is
// deterministic, so it can be handed the run itself: every tag's value at the start of a window and each change
// inside it. That is small where a sample-per-step dump is not (an encoder changes every step, a stop button once).

/** One tag through a stretch of the run: its value at `from`, then each change, in sim seconds. */
export interface TagTrace {
  tag: string
  /** the value at the start of the window (absent: the tag did not exist yet) */
  start?: TestValue
  changes: { t: number; v: TestValue }[]
}

/** A stretch of the run to record: [from, to] in sim seconds. */
export interface TraceWindow {
  from: number
  to: number
}

/**
 * Records tag changes from the samples a run is fed (`sample`, the same table the evaluator sees). `tags`: the tags to
 * keep, or every one; `windows`: the stretches to keep them in, or the whole run. A value held from before a window
 * is its `start`, so a tag that did not move in the window still says what it was.
 */
export class TraceRecorder {
  private readonly last = new Map<string, TestValue>()
  private readonly traces: Map<string, TagTrace>[]
  private readonly want: ReadonlySet<string> | null

  constructor(
    tags: readonly string[] | 'all',
    private readonly windows: readonly TraceWindow[] = [{ from: 0, to: Infinity }],
  ) {
    this.want = tags === 'all' ? null : new Set(tags)
    this.traces = windows.map(() => new Map())
  }

  sample(time: number, tags: Readonly<Record<string, TestValue>>): void {
    for (const key of Object.keys(tags)) {
      if (key.charCodeAt(0) === 0) continue // probe bookkeeping, not a tag anyone can name
      if (this.want && !this.want.has(key)) continue
      const v = tags[key]!
      const before = this.last.get(key)
      this.windows.forEach((w, k) => {
        if (time < w.from - EPS || time > w.to + EPS) return
        const into = this.traces[k]!
        let tr = into.get(key)
        if (!tr) {
          // what it held coming into the window; a tag first seen here starts at what it first reads
          tr = { tag: key, start: before ?? v, changes: [] }
          into.set(key, tr)
          if (before === undefined) return
        }
        if (before !== v) tr.changes.push({ t: time, v })
      })
      this.last.set(key, v)
    }
  }

  /** The traces of window `k` (the only one, by default), by tag name. `changedOnly` leaves out tags that held. */
  result(k = 0, changedOnly = false): TagTrace[] {
    return [...(this.traces[k]?.values() ?? [])].filter((t) => !changedOnly || t.changes.length > 0).sort((a, b) => a.tag.localeCompare(b.tag))
  }
}

/** A trace as lines of text, for a terminal or a log: `Stop  FALSE -> 3.100s TRUE`. A tag that changes too often to
 *  read (an encoder, a position) is cut to its first and last few changes, with the count between. */
export function formatTrace(traces: readonly TagTrace[], maxChanges = 8): string[] {
  const show = (v: TestValue): string => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6))))
  const at = (c: { t: number; v: TestValue }): string => `${c.t.toFixed(3)}s ${show(c.v)}`
  const width = Math.max(0, ...traces.map((t) => t.tag.length))
  return traces.map((t) => {
    const head = t.start === undefined ? '(none)' : show(t.start)
    const cs = t.changes
    const shown = cs.length <= maxChanges ? cs.map(at) : [...cs.slice(0, maxChanges / 2).map(at), `... ${cs.length - maxChanges} more ...`, ...cs.slice(-maxChanges / 2).map(at)]
    return `${t.tag.padEnd(width)}  ${[head, ...shown].join(' -> ')}`
  })
}
