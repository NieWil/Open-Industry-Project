// Flow facts: what physically happened to the cargo on a running line, reported as facts, never verdicts.
//
// An agent or an engineer building a line loses most of its time on physical problems nothing reports: a box falls
// off a belt, a pusher tips a box that is coasting to a stop, a tumbling box flickers a photo eye into a second edge
// (which slips a tracking queue), a box sits still while the belt under it runs. The tracker watches every step and
// says so, with the time, the place and the part. It never judges: an accumulating line holds boxes still on purpose,
// and that is still reported, as a fact, for whoever reads the run to weigh.
//
// Pure and deterministic: fed one step at a time from the same rows the frame carries (ids, poses, sizes, kinds), the
// sensor beams' raw hits, the parts' tag writes and the live conveyor speeds. The sim runs it after every step
// (sim/flowFacts.ts); the headless runner and check-flow read what it collected (docs/project-tests.md "Flow facts").
import { bedOf } from '../conveyor/conveyorBeds'
import { conveyorSpeedParams } from '../conveyor/conveyorDirection'
import { conveyingSurfaceAt } from '../conveyor/conveyorSurface'
import { CARGO_CAP_HEAVY, capsOfKind, cargoKindName } from '../frame'
import type { PartInstance } from '../types'

export type FlowFactKind = 'dropped' | 'tipped' | 'stalled' | 'flicker' | 'lost'

/** The kinds, in the order a report lists them. */
export const FLOW_FACT_KINDS: readonly FlowFactKind[] = ['dropped', 'lost', 'tipped', 'flicker', 'stalled']

/**
 * One physical fact about the run. `id` is the fact's own: a fact that is still unfolding (a stall) is reported when
 * it starts and again, under the same id, when it ends, so a reader keeps the latest record per id.
 */
export interface FlowFact {
  id: number
  kind: FlowFactKind
  /** sim time (s) the fact happened: a stall's start, a flicker's re-block, a drop's floor contact */
  t: number
  /** world position (m, rounded to mm) of the cargo, or of the beam's blocked point for a flicker */
  at: [number, number, number]
  /** the cargo body's frame id (BoxFrame.ids) */
  cargo?: number
  /** the cargo's own scene part id, for authored cargo */
  cargoPart?: string
  /** the part the fact is about: the conveyor a box was on or over, the sensor that flickered, or the part the box
   *  came from when it was over nothing */
  part?: string
  /** flicker: the beam's link name */
  link?: string
  /** flicker: how long the beam read clear (s) */
  gap?: number
  /** flicker: the sensor's BOOL tags that changed during the gap (what the program saw) */
  tags?: string[]
  /** flicker: how many flickers this record stands for (repeats on one beam close together are merged) */
  count?: number
  /** tipped: the box's up axis from vertical (degrees) when it passed the threshold */
  angle?: number
  /** dropped / lost: the height (m) the box's bottom was supported at before it fell */
  from?: number
  /** stalled: how long (s) it lasted; absent while it is still going */
  duration?: number
  /** stalled: true when the run ended with it still going */
  ongoing?: boolean
  /** stalled: the most boxes held still on the conveyor at once during it */
  boxes?: number
  /** stalled: the conveyor's live commanded speed (m/s, or rad/s for a curve) when it started */
  speed?: number
  message: string
}

/** One cargo row the tracker reads: a LiveBox satisfies it, and so does a plain object in a unit test. */
export interface FlowBody {
  readonly id: number
  readonly hx: number
  readonly hy: number
  readonly hz: number
  readonly kind: number
  /** CARGO_CAP_* bits; a body without them (a unit test's plain object) has its kind's */
  readonly caps?: number
  readonly partId: string | null
}

/** A beam's raw reading this step (FrameBeamHit, before any normally-closed inversion). */
export interface FlowBeamReading {
  readonly hit: boolean
  readonly distance: number
}

/** One step's worth of input. Everything is read, nothing is kept by reference past the call. */
export interface FlowStepInput {
  /** sim time (s) of the state these rows hold */
  t: number
  count: number
  bodies: ArrayLike<FlowBody>
  /** 7 per row, aligned with `bodies`: x y z qx qy qz qw */
  poses: ArrayLike<number>
  /** a body a holder (gripper, pin, the pilot) has: not falling, not tipping, not stalling on its own account */
  isHeld?: (id: number) => boolean
  /** raw beam hits by part id, then link */
  beamHits?: ReadonlyMap<string, Readonly<Record<string, FlowBeamReading>>>
  /** each part's tag writes this step, by part id (a fresh object per step, as the behavior runtime hands them) */
  partTags?: ReadonlyMap<string, Readonly<Record<string, number | boolean>>>
  /** live commanded conveyor speed by part id (m/s, or rad/s for a curve); 0 = stopped */
  speeds?: ReadonlyMap<string, number>
  /** where a beam is blocked, `distance` along it, and by which cargo body; asked only on a beam's edges. The body
   *  is what tells a gap between two boxes from a flicker of one */
  beamTarget?: (part: string, link: string, distance: number) => FlowBeamTarget | undefined
}

/** A blocked beam's point (world m) and the cargo body there, if one is. */
export interface FlowBeamTarget {
  cargo: number | undefined
  at: [number, number, number]
}

// ---- thresholds: each named, with why -------------------------------------------------------------------------

/** a body whose bottom is above this (m) is clear of the floor (a floor pallet's deck is ~0.14 m, a box on it above) */
export const ELEVATED = 0.08
/** a body whose bottom is below this (m) is on the floor (top of the ground at y 0, minus solver slop) */
export const FLOOR_TOUCH = 0.03
/** vertical speed (m/s) under which an elevated body counts as supported: a 30 degree incline at 1 m/s is 0.5, while
 *  free fall passes it within 0.05 s */
export const SUPPORTED_VY = 0.55
/** how long (s) a body must be supported above the floor before reaching the floor counts as a drop: a box let go
 *  just above the floor (a set-down) never arms */
export const ARM_TIME = 0.2
/** a body's trail above the floor: a point every SUPPORT_SAMPLE s, SUPPORT_SLOTS of them (half a second): a box tipping
 *  off a conveyor at line speed leaves the bed well within that */
const SUPPORT_SAMPLE = 0.1
const SUPPORT_SLOTS = 5
/** how long (s) a box must stay at the floor before its drop is reported: a sink on the floor that takes it within this
 *  is product leaving the line, and a body still falling past the floor is going off the world (a `lost` fact) */
export const DROP_CONFIRM = 0.25
/** a body whose bottom is below this (m) is no longer at the floor but past it (off the edge of the ground) */
const BELOW_FLOOR = -0.2
/** up axis from vertical (degrees) past which a box has tipped: well beyond an incline (<= 30) plus a wobble */
export const TIP_DEG = 40
/** ...and under which it has righted itself, so a second tip is a new fact */
export const RIGHT_DEG = 20
/** a body that stays within this distance (m) of where it settled is motionless: belt jitter, not travel */
export const STILL_DIST = 0.01
/** how long (s) a box must sit still on a running conveyor to be a stall (a stop that holds it less is a pause) */
export const STALL_TIME = 1
/** how long (s) after a body settles its support is looked up (cheaper than looking for every moving body) */
export const SUPPORT_LOOKUP_AFTER = 0.2
/** at most this many support lookups in one step: a scene that starts with a thousand cargo bodies settles in the same
 *  step, and looking them all up at once causes a visible hitch */
const SUPPORT_LOOKUPS_PER_STEP = 64
/** a box's bottom within this (m) of a conveying surface rests on it */
export const SUPPORT_TOL = 0.06
/** a conveyor's stalls closer together than this (s) are one stall: an accumulation releasing a box at a time is one
 *  fact, not one per box */
export const STALL_MERGE_GAP = 2
/** a beam clear for less than this (s) between two blocked periods by the same body is a flicker: a real gap between
 *  boxes at line speed lasts several times longer */
export const FLICKER_GAP = 0.1
/** flickers on one beam closer together than this (s) are one record, counted (a box rocking in front of an eye) */
export const FLICKER_MERGE = 1
/** the most facts kept; more are counted in `overflow`, never stored */
export const MAX_FACTS = 2000

const COS_TIP = Math.cos((TIP_DEG * Math.PI) / 180)
const COS_RIGHT = Math.cos((RIGHT_DEG * Math.PI) / 180)
const STILL_DIST2 = STILL_DIST * STILL_DIST

interface BodyState {
  id: number
  /** CARGO_KIND_*, for what a fact calls it */
  kind: number
  /** last step's x, z and w (with prevY: an unchanged pose is a sleeping body, and its step is skipped) */
  px: number
  pz: number
  pqw: number
  /** the step stamp this body was last seen at (a body not seen this step has left: its state goes) */
  seen: number
  prevY: number
  prevT: number
  /** armed: supported above the floor long enough that reaching it is a drop */
  armed: boolean
  supportedFor: number
  /** where it was last supported above the floor: x, z and its bottom's height */
  sx: number
  sz: number
  sBottom: number
  /** where it has been while clear of the floor, supported or tumbling: SUPPORT_SLOTS points (x, z, bottom), one every
   *  SUPPORT_SAMPLE s, newest at `trailAt`. A box tipping off a conveyor is past the bed by the time it goes, so the
   *  conveyor it was last over is found here */
  trail: Float32Array
  trailAt: number
  trailT: number
  tipped: boolean
  /** where and when it settled (the stillness anchor) */
  ax: number
  ay: number
  az: number
  at: number
  /** the conveyor it rests on while settled: undefined = not looked up yet, null = none */
  support: string | null | undefined
  /** when the conveyor under it was first seen running while it sat still (undefined = not running) */
  runFrom: number | undefined
  /** the stall this body is part of (its conveyor's) */
  stalling: StallEpisode | null
  /** the part it came from (a spawner), when known */
  origin: string | null
  /** a drop waiting out DROP_CONFIRM: the fact as it will read, unless a sink takes the box first */
  pending: Omit<FlowFact, 'id'> | null
}

interface StallEpisode {
  part: string
  fact: FlowFact
  bodies: Set<number>
  /** when its last body stopped stalling (undefined while one still is) */
  emptySince: number | undefined
}

interface BeamState {
  blocked: boolean
  /** the body blocking it when it went clear (undefined = unknown) */
  before: number | undefined
  clearAt: number
  lastDistance: number
  /** the sensor's tags as they were before the gap, and the BOOL ones that differed during it */
  baseline: Readonly<Record<string, number | boolean>> | undefined
  toggled: Set<string> | null
  /** the last flicker record on this beam, for merging repeats */
  last: FlowFact | null
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000
const fmt = (v: number, d = 2): string => v.toFixed(d)

/** a conveyor's reach from its origin (m), for a quick "could this point be over it" test; null = not a conveyor */
function conveyorReach(part: PartInstance): number | null {
  if (conveyorSpeedParams(part).speed === undefined) return null
  return bedOf(part)?.reach() ?? null
}

/**
 * The tracker. Construct it with the scene's parts, call {@link step} after every physics step, {@link lost} when a
 * body is culled below the world, {@link noteOrigin} when a part spawns one, and {@link finish} when the run ends.
 * Memory is bounded: state per live body and per beam only, and at most {@link MAX_FACTS} facts.
 */
export class FlowFactTracker {
  private readonly bodies = new Map<number, BodyState>()
  /** last step's state per row, so a step finds each body's without a lookup while the rows have not shifted */
  private readonly rowStates: (BodyState | undefined)[] = []
  private readonly beams = new Map<string, Map<string, BeamState>>()
  private readonly stalls = new Map<string, StallEpisode>()
  /** origins noted before the body's first step (the spawn happens mid-step, the row shows up the same step) */
  private readonly pendingOrigins = new Map<number, string>()
  /** the previous step's tag writes per sensor part (a fresh object per step, so holding it is free) */
  private readonly prevTags = new Map<string, Readonly<Record<string, number | boolean>>>()
  private conveyors: { part: PartInstance; reach2: number }[] = []
  private names = new Map<string, string>()
  /** each part's position, where a flicker is placed when the sim cannot say where its beam was blocked */
  private positions = new Map<string, [number, number, number]>()
  private readonly stored: FlowFact[] = []
  private readonly dirty = new Set<FlowFact>()
  private nextId = 1
  private stamp = 0
  private lastT = 0
  /** facts that happened past {@link MAX_FACTS}, counted and not kept */
  overflow = 0

  constructor(parts: readonly PartInstance[]) {
    this.setParts(parts)
  }

  /** the scene changed while running (a live edit): conveyors and names are read from the new parts */
  setParts(parts: readonly PartInstance[]): void {
    const conveyors: { part: PartInstance; reach2: number }[] = []
    const names = new Map<string, string>()
    const positions = new Map<string, [number, number, number]>()
    for (const p of parts) {
      if (p.name) names.set(p.id, p.name)
      positions.set(p.id, [round3(p.position[0]), round3(p.position[1]), round3(p.position[2])])
      const reach = conveyorReach(p)
      if (reach !== null) conveyors.push({ part: p, reach2: (reach + 0.05) * (reach + 0.05) })
    }
    this.conveyors = conveyors
    this.names = names
    this.positions = positions
  }

  /** every fact so far, in the order they happened (a stall's record is updated in place when it ends) */
  facts(): readonly FlowFact[] {
    return this.stored
  }

  /** the facts added or updated since the last call, as copies (for shipping across a thread) */
  drain(): FlowFact[] {
    if (this.dirty.size === 0) return []
    const out: FlowFact[] = []
    for (const f of this.dirty) out.push({ ...f, at: [...f.at], ...(f.tags ? { tags: [...f.tags] } : {}) })
    this.dirty.clear()
    return out
  }

  /** a part spawned this body (its row appears this step); the fact about it can then name where it came from */
  noteOrigin(id: number, part: string): void {
    const st = this.bodies.get(id)
    if (st) st.origin = part
    else this.pendingOrigins.set(id, part)
  }

  /** a body was culled below the world (it fell off the ground plane), at time `t` and position x y z */
  lost(id: number, t: number, x: number, y: number, z: number, cargoPart: string | null): void {
    const st = this.bodies.get(id)
    const over = st ? this.lastOn(st) : null
    const part = over ?? st?.origin ?? undefined
    this.emit({
      kind: 'lost',
      t,
      at: [round3(x), round3(y), round3(z)],
      cargo: id,
      ...(cargoPart ? { cargoPart } : {}),
      ...(part ? { part } : {}),
      ...(st && st.sBottom > ELEVATED ? { from: round3(st.sBottom) } : {}),
      message: `${st ? cargoKindName(st.kind) : 'cargo'} ${id} fell off the world (below the ground) at x ${fmt(x)} z ${fmt(z)}${over ? `, last over ${this.label(over)}` : part ? `, from ${this.label(part)}` : ''}`,
    })
    if (st) this.forget(id, st, t)
  }

  /** feed one step */
  step(input: FlowStepInput): void {
    const t = input.t
    const stamp = ++this.stamp
    const { count, bodies, poses } = input
    const isHeld = input.isHeld
    const speeds = input.speeds
    const rows = this.rowStates
    let lookups = 0
    for (let i = 0; i < count; i++) {
      const b = bodies[i]!
      const o = i * 7
      const x = poses[o]!
      const y = poses[o + 1]!
      const z = poses[o + 2]!
      const qw = poses[o + 6]!
      // the row's state from last step (rows only shift when cargo comes or goes), else by id
      let st = i < rows.length ? rows[i] : undefined
      if (st === undefined || st.id !== b.id) {
        st = this.bodies.get(b.id)
        if (i < rows.length) rows[i] = st
        else rows.push(st)
      }
      // a sleeping body (exactly where it was), with nothing pending on it and nothing under it to stall on: no news
      if (st !== undefined && x === st.px && y === st.prevY && z === st.pz && qw === st.pqw && st.pending === null && st.support === null && st.stalling === null) {
        st.seen = stamp
        st.prevT = t
        continue
      }
      const qx = poses[o + 3]!
      const qy = poses[o + 4]!
      const qz = poses[o + 5]!
      // the world-up component of the body's own up axis (rotation matrix row y), and its vertical half-size
      const r10 = 2 * (qx * qy + qw * qz)
      const r11 = 1 - 2 * (qx * qx + qz * qz)
      const r12 = 2 * (qy * qz - qw * qx)
      const bottom = y - (Math.abs(r10) * b.hx + Math.abs(r11) * b.hy + Math.abs(r12) * b.hz)
      const held = isHeld ? isHeld(b.id) : false
      if (!st) {
        // first sight: whatever it is now is where it starts (a box authored on the floor, or already on its side,
        // is not a fact); elevated and loose, it is armed from here, so a spawner dropping into thin air is caught
        const origin = this.pendingOrigins.get(b.id) ?? null
        if (origin !== null) this.pendingOrigins.delete(b.id)
        // a body that bears loads (a pallet) is set down and lifted by machines as a matter of course: never a drop
        const heavy = ((b.caps ?? capsOfKind(b.kind)) & CARGO_CAP_HEAVY) !== 0
        const armed = !held && bottom > ELEVATED && !heavy
        st = { id: b.id, kind: b.kind, px: x, pz: z, pqw: qw, seen: stamp, prevY: y, prevT: t, armed, supportedFor: 0, sx: x, sz: z, sBottom: bottom, trail: new Float32Array(SUPPORT_SLOTS * 3).fill(Number.NaN), trailAt: 0, trailT: -Infinity, tipped: r11 < COS_TIP, ax: x, ay: y, az: z, at: t, support: undefined, runFrom: undefined, stalling: null, origin, pending: null }
        this.bodies.set(b.id, st)
        rows[i] = st
        continue
      }
      st.seen = stamp
      const dtStep = t - st.prevT
      const vy = dtStep > 0 ? (y - st.prevY) / dtStep : 0
      st.prevY = y
      st.prevT = t
      st.px = x
      st.pz = z
      st.pqw = qw

      // ---- dropped: armed, then the bottom reaches the floor, and it is still there DROP_CONFIRM later
      if (st.pending && t - st.pending.t >= DROP_CONFIRM) {
        if (bottom > BELOW_FLOOR) this.emit(st.pending)
        st.pending = null
      }
      if (((b.caps ?? capsOfKind(b.kind)) & CARGO_CAP_HEAVY) === 0) {
        if (!held && bottom > ELEVATED && t - st.trailT >= SUPPORT_SAMPLE) {
          st.trailAt = (st.trailAt + 1) % SUPPORT_SLOTS
          const k = st.trailAt * 3
          st.trail[k] = x
          st.trail[k + 1] = z
          st.trail[k + 2] = bottom
          st.trailT = t
        }
        if (held) {
          st.armed = false
          st.supportedFor = 0
        } else if (bottom > ELEVATED && Math.abs(vy) < SUPPORTED_VY) {
          st.supportedFor += dtStep
          st.sx = x
          st.sz = z
          st.sBottom = bottom
          if (st.supportedFor >= ARM_TIME) st.armed = true
        } else {
          st.supportedFor = 0
          if (st.armed && bottom < FLOOR_TOUCH) {
            st.armed = false
            const over = this.lastOn(st)
            const part = over ?? st.origin ?? undefined
            st.pending = {
              kind: 'dropped',
              t,
              at: [round3(x), round3(y), round3(z)],
              cargo: b.id,
              ...(b.partId ? { cargoPart: b.partId } : {}),
              ...(part ? { part } : {}),
              from: round3(st.sBottom),
              message: `${cargoKindName(b.kind)} ${b.id} fell to the floor at x ${fmt(x)} z ${fmt(z)} from ${fmt(st.sBottom)} m${over ? `, last on ${this.label(over)}` : part ? `, from ${this.label(part)} (over no conveyor)` : ''}`,
            }
          }
        }
      }

      // ---- tipped: the up axis passes TIP_DEG from vertical (once, until it rights itself)
      if (!held) {
        if (!st.tipped && r11 < COS_TIP) {
          st.tipped = true
          const angle = (Math.acos(Math.max(-1, Math.min(1, r11))) * 180) / Math.PI
          const over = this.conveyorUnder(x, z, bottom, 0.5)
          const part = over ?? st.origin ?? undefined
          this.emit({
            kind: 'tipped',
            t,
            at: [round3(x), round3(y), round3(z)],
            cargo: b.id,
            ...(b.partId ? { cargoPart: b.partId } : {}),
            ...(part ? { part } : {}),
            angle: Math.round(angle),
            message: `${cargoKindName(b.kind)} ${b.id} tipped past ${TIP_DEG} degrees at x ${fmt(x)} z ${fmt(z)}${over ? ` on ${this.label(over)}` : ''}`,
          })
        } else if (st.tipped && r11 > COS_RIGHT) st.tipped = false
      }

      // ---- stalled: still for STALL_TIME on a conveyor running under it
      const dx = x - st.ax
      const dy = y - st.ay
      const dz = z - st.az
      if (held || dx * dx + dy * dy + dz * dz > STILL_DIST2) {
        st.ax = x
        st.ay = y
        st.az = z
        st.at = t
        st.support = undefined
        st.runFrom = undefined
        if (st.stalling) this.leaveStall(b.id, st, t)
        continue
      }
      if (t - st.at < SUPPORT_LOOKUP_AFTER) continue
      if (st.support === undefined) {
        if (lookups >= SUPPORT_LOOKUPS_PER_STEP) continue // the rest wait a step: a scene full of cargo settles at once
        lookups++
        st.support = this.conveyorUnder(x, z, bottom, SUPPORT_TOL)
      }
      if (st.support === null) continue
      const speed = speeds?.get(st.support) ?? 0
      if (speed === 0) {
        st.runFrom = undefined
        if (st.stalling) this.leaveStall(b.id, st, t)
        continue
      }
      if (st.runFrom === undefined) st.runFrom = Math.max(st.at, t)
      const from = Math.max(st.at, st.runFrom)
      if (!st.stalling && t - from >= STALL_TIME) this.joinStall(b, st, from, x, y, z, speed)
    }

    if (rows.length > count) rows.length = count
    // bodies that left without a word (a sink took them, a live edit removed them): their state goes with them
    if (this.bodies.size > count) {
      for (const [id, st] of this.bodies) if (st.seen !== stamp) this.forget(id, st, t)
    }
    // a conveyor's stall ends once it has held no box still for STALL_MERGE_GAP
    if (this.stalls.size > 0) {
      for (const ep of this.stalls.values()) {
        if (ep.emptySince !== undefined && t - ep.emptySince >= STALL_MERGE_GAP) this.closeStall(ep, ep.emptySince, false)
      }
    }
    if (input.beamHits) this.stepBeams(input, t)
    this.lastT = t
  }

  /** the run ended at `t`: a stall still going is reported with how long it lasted so far */
  finish(t: number = this.lastT): void {
    for (const ep of [...this.stalls.values()]) this.closeStall(ep, ep.emptySince ?? t, ep.emptySince === undefined)
    // a box that reached the floor just before the end is on it as far as this run knows
    for (const st of this.bodies.values()) {
      if (st.pending) this.emit(st.pending)
      st.pending = null
    }
  }

  // ---- beams ----------------------------------------------------------------------------------------------------

  private stepBeams(input: FlowStepInput, t: number): void {
    const tags = input.partTags
    for (const [part, links] of input.beamHits!) {
      let perPart = this.beams.get(part)
      if (!perPart) this.beams.set(part, (perPart = new Map()))
      const now = tags?.get(part)
      for (const link in links) {
        const r = links[link]!
        const s = perPart.get(link)
        if (!s) {
          perPart.set(link, { blocked: r.hit, before: undefined, clearAt: t, lastDistance: r.distance, baseline: undefined, toggled: null, last: null })
          continue
        }
        if (s.blocked && !r.hit) {
          // went clear: who was blocking it (from where it was blocked last step), and the tags as they stood before
          s.blocked = false
          s.clearAt = t
          s.before = input.beamTarget?.(part, link, s.lastDistance)?.cargo
          s.baseline = this.prevTags.get(part)
          s.toggled = null
          this.noteToggles(s, now)
        } else if (!s.blocked && r.hit) {
          s.blocked = true
          const gap = t - s.clearAt
          if (gap < FLICKER_GAP && s.baseline !== undefined) {
            this.noteToggles(s, now)
            const target = input.beamTarget?.(part, link, r.distance)
            const after = target?.cargo
            // a gap between two different boxes is just a gap; the same box (or one we cannot tell) is a flicker
            if (s.before === undefined || after === undefined || s.before === after) this.flicker(part, link, s, gap, t, target?.at, after ?? s.before)
          }
          s.baseline = undefined
          s.toggled = null
        } else if (!s.blocked && s.baseline !== undefined) {
          if (t - s.clearAt < FLICKER_GAP) this.noteToggles(s, now)
          else s.baseline = undefined // a real gap: stop watching its tags
        }
        if (r.hit) s.lastDistance = r.distance
      }
      if (now) this.prevTags.set(part, now)
    }
  }

  /** the sensor's BOOL tags that differ from what they were before the gap */
  private noteToggles(s: BeamState, now: Readonly<Record<string, number | boolean>> | undefined): void {
    const base = s.baseline
    if (!base || !now) return
    for (const k in now) {
      const v = now[k]
      if (typeof v === 'boolean' && typeof base[k] === 'boolean' && base[k] !== v) (s.toggled ??= new Set()).add(k)
    }
  }

  private flicker(part: string, link: string, s: BeamState, gap: number, t: number, at: [number, number, number] | undefined, cargo: number | undefined): void {
    const toggled = s.toggled ? [...s.toggled].sort() : []
    const last = s.last
    if (last && t - last.t < FLICKER_MERGE && last.cargo === cargo) {
      // the same box rocking in front of the same eye: one record, counted
      last.count = (last.count ?? 1) + 1
      last.gap = Math.max(last.gap ?? 0, round3(gap))
      const merged = new Set([...(last.tags ?? []), ...toggled])
      if (merged.size) last.tags = [...merged].sort()
      last.t = t
      last.message = this.flickerMessage(part, link, last.gap, last.tags ?? [], last.count, cargo)
      this.dirty.add(last)
      return
    }
    s.last = this.emit({
      kind: 'flicker',
      t,
      at: at ? [round3(at[0]), round3(at[1]), round3(at[2])] : (this.positions.get(part) ?? [0, 0, 0]),
      ...(cargo !== undefined ? { cargo } : {}),
      part,
      link,
      gap: round3(gap),
      ...(toggled.length ? { tags: toggled } : {}),
      message: this.flickerMessage(part, link, gap, toggled, 1, cargo),
    })
  }

  private flickerMessage(part: string, link: string, gap: number, tags: readonly string[], count: number, cargo: number | undefined): string {
    const what = tags.length ? `; ${tags.join(', ')} toggled` : '; no BOOL tag of the part toggled'
    return `${this.label(part)} beam '${link}' read clear for ${Math.round(gap * 1000)} ms between two blocked periods${cargo !== undefined ? ` by box ${cargo}` : ''}${count > 1 ? ` (${count} times)` : ''}${what}`
  }

  // ---- stalls ---------------------------------------------------------------------------------------------------

  private joinStall(b: FlowBody, st: BodyState, from: number, x: number, y: number, z: number, speed: number): void {
    const part = st.support!
    let ep = this.stalls.get(part)
    if (!ep) {
      const fact = this.emit({
        kind: 'stalled',
        t: from,
        at: [round3(x), round3(y), round3(z)],
        cargo: b.id,
        ...(b.partId ? { cargoPart: b.partId } : {}),
        part,
        boxes: 1,
        speed: round3(speed),
        message: '',
      })
      ep = { part, fact, bodies: new Set(), emptySince: undefined }
      this.stalls.set(part, ep)
    }
    ep.bodies.add(b.id)
    ep.emptySince = undefined
    st.stalling = ep
    if (ep.bodies.size > (ep.fact.boxes ?? 0)) ep.fact.boxes = ep.bodies.size
    ep.fact.message = this.stallMessage(ep.fact)
    this.dirty.add(ep.fact)
  }

  private leaveStall(id: number, st: BodyState, t: number): void {
    const ep = st.stalling!
    st.stalling = null
    ep.bodies.delete(id)
    if (ep.bodies.size === 0) ep.emptySince = t
  }

  private closeStall(ep: StallEpisode, end: number, ongoing: boolean): void {
    this.stalls.delete(ep.part)
    for (const id of ep.bodies) {
      const st = this.bodies.get(id)
      if (st && st.stalling === ep) st.stalling = null
    }
    const f = ep.fact
    f.duration = round3(Math.max(0, end - f.t))
    if (ongoing) f.ongoing = true
    f.message = this.stallMessage(f)
    this.dirty.add(f)
  }

  private stallMessage(f: FlowFact): string {
    const n = f.boxes ?? 1
    const who = n > 1 ? `${n} boxes (first box ${f.cargo})` : `box ${f.cargo}`
    const long = f.duration === undefined ? '' : f.ongoing ? ` for ${fmt(f.duration, 1)} s, still at the end of the run` : ` for ${fmt(f.duration, 1)} s`
    return `${who} sat still on ${this.label(f.part!)} while it ran (speed ${fmt(f.speed ?? 0)})${long}`
  }

  // ---- shared ---------------------------------------------------------------------------------------------------

  private forget(id: number, st: BodyState, t: number): void {
    if (st.stalling) this.leaveStall(id, st, t)
    this.bodies.delete(id)
  }

  /** the conveyor a body was last over before it fell: the newest point of its trail over one, else where it was last
   *  supported */
  private lastOn(st: BodyState): string | null {
    for (let i = 0; i < SUPPORT_SLOTS; i++) {
      const k = ((st.trailAt - i + SUPPORT_SLOTS) % SUPPORT_SLOTS) * 3
      const x = st.trail[k]!
      if (Number.isNaN(x)) break
      const on = this.conveyorUnder(x, st.trail[k + 1]!, st.trail[k + 2]!, 0.5)
      if (on) return on
    }
    return this.conveyorUnder(st.sx, st.sz, st.sBottom, 0.5)
  }

  /** the conveyor whose conveying surface is under (x, z) within `tol` of height `bottom`, else null */
  private conveyorUnder(x: number, z: number, bottom: number, tol: number): string | null {
    let best: string | null = null
    let bestGap = Infinity
    for (const c of this.conveyors) {
      const p = c.part
      const ox = x - p.position[0]
      const oz = z - p.position[2]
      if (ox * ox + oz * oz > c.reach2) continue
      const s = conveyingSurfaceAt(p, x, z)
      if (!s) continue
      const gap = Math.abs(bottom - s.y)
      if (gap <= tol && gap < bestGap) {
        best = p.id
        bestGap = gap
      }
    }
    return best
  }

  private label(partId: string): string {
    const name = this.names.get(partId)
    return name && name !== partId ? `'${name}' (${partId})` : `'${partId}'`
  }

  private emit(f: Omit<FlowFact, 'id'>): FlowFact {
    const fact: FlowFact = { id: this.nextId++, ...f }
    if (this.stored.length >= MAX_FACTS) {
      this.overflow++
      return fact // reported nowhere: counted, so a reader knows the list is not the whole run
    }
    this.stored.push(fact)
    this.dirty.add(fact)
    return fact
  }
}

/** Counts by kind, in report order: "2 tipped, 1 flicker" (or "none"). */
export function summarizeFlowFacts(facts: readonly FlowFact[], overflow = 0): string {
  const counts = new Map<FlowFactKind, number>()
  for (const f of facts) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
  const parts = FLOW_FACT_KINDS.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`)
  if (overflow > 0) parts.push(`${overflow} more not kept`)
  return parts.length ? parts.join(', ') : 'none'
}

/** One line per fact: `t=12.345s  tipped  box 7 tipped past 40 degrees ... [x, y, z]`. */
export function formatFlowFact(f: FlowFact): string {
  return `t=${f.t.toFixed(3)}s  ${f.kind.padEnd(7)}  ${f.message}  [${f.at.join(', ')}]`
}
