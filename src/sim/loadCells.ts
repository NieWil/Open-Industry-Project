// Load cells (a rig link's `loadCell`, read by ctx.weight): the weight resting on a platform, measured from the physics
// each tick. A real load cell reads the force through the platform; here that force is Newton's law on what rests on
// it. A body pushes down with m (g + a), where `a` is its vertical acceleration over the last step, and a stack pushes
// down through the body it stands on. That is the solver's own contact impulse over the step, so a case landing or a
// lift starting reads high for a moment, as on a real scale.
//
// A stack whose base rests on the platform alone counts in full, wherever its weight sits, as a load cantilevered past
// the edge does on a real scale. A base that also rests on something else (a case crossing the seam onto a weigh belt,
// a pallet bridging two scales) shares its stack's weight between the two by the lever rule: the stack's centre of
// gravity, between where it bears on the platform and where it bears on the other support. That is the statics of a
// rigid body on two supports, so the reading ramps up as a case comes on.
//
// Contact comes from the solver (PhysicsSystem.WereBodiesInContact, last step). A body that went to sleep gets no
// contact, so a stack seen last tick whose bodies are all asleep now has not moved: it keeps what it was found as and
// its share.
import type Jolt from 'jolt-physics'
import { qApply, qConjugate } from '../core/rig/rigPose'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import type { BodyHolds } from './bodyHolds'
import type { CargoRegistry } from './cargoRegistry'
import { GRID_MIN_ROWS } from './cargoRegistry'
import type { JoltModule, LiveBox } from './worldTypes'

/** footprint samples per axis on a body's underside (4 x 4 = 16 points, at the centres of a 4 x 4 grid) */
const SAMPLES = [-0.75, -0.25, 0.25, 0.75]
/** how close to its unit's lowest piece a piece's underside must be to be part of the base the unit stands on, m */
const BASE_LAYER_TOL = 0.02
/** how far below the top of what it touches a body's underside may sit and still rest on it, not beside it, m */
const STACK_TOL = 0.03

/** a link with a load cell, on its part */
interface LoadCell {
  name: string
  body: Jolt.Body
  id: Jolt.BodyID
  /** the link's box half extents, m */
  he: Vec3
  /** what rested on it last tick, by body key: its vertical velocity then (for its acceleration now), the key of the
   *  base of its stack (its own when it stands on the platform) and that stack's share */
  resting: Map<number, { vy: number; base: number; share: number }>
}

/** one body found resting on a platform this tick */
interface Resting {
  box: LiveBox
  /** the rows of its pieces near the platform */
  rows: number[]
  /** the key of the base of its stack: its own when it stands on the platform */
  base: number
}

export class LoadCells {
  private readonly byPart = new Map<string, LoadCell[]>()
  /** g, m/s², from the world's gravity */
  private readonly g: number
  /** the broadphase hits of the other-support query, as BodyID keys (otherSupports) */
  private readonly hits: number[] = []
  private readonly collector: Jolt.CollideShapeBodyCollectorJS
  private readonly anyBroadPhase: Jolt.BroadPhaseLayerFilter
  private readonly anyObject: Jolt.ObjectLayerFilter

  constructor(
    private readonly J: JoltModule,
    private readonly system: Jolt.PhysicsSystem,
    private readonly bodyInterface: Jolt.BodyInterface,
    private readonly cargo: CargoRegistry,
    private readonly boxes: readonly LiveBox[],
    private readonly holds: BodyHolds,
    private readonly dt: number,
  ) {
    this.g = -system.GetGravity().GetY()
    const collector = new J.CollideShapeBodyCollectorJS()
    // a JS implementation must define every method; the hit list is cleared before each query instead
    collector.Reset = () => {}
    collector.AddHit = (ptr: number) => {
      this.hits.push(J.wrapPointer(ptr, J.BodyID).GetIndexAndSequenceNumber())
    }
    this.collector = collector
    this.anyBroadPhase = new J.BroadPhaseLayerFilter()
    this.anyObject = new J.ObjectLayerFilter()
  }

  /** a part's load-cell links, as built (replacing what it had; none clears it) */
  set(partId: string, cells: { name: string; body: Jolt.Body; he: Vec3 }[]): void {
    if (cells.length === 0) this.byPart.delete(partId)
    else this.byPart.set(partId, cells.map((c) => ({ name: c.name, body: c.body, id: c.body.GetID(), he: c.he, resting: new Map() })))
  }

  /** kg on each of a part's load-cell links this tick (ctx.weight), or undefined when it has none */
  readingsOf(partId: string): Record<string, number> | undefined {
    const cells = this.byPart.get(partId)
    if (!cells) return undefined
    const out: Record<string, number> = {}
    for (const c of cells) out[c.name] = this.measure(c)
    return out
  }

  clear(): void {
    this.byPart.clear()
  }

  /** free the query objects (the world is going) */
  dispose(): void {
    const J = this.J
    J.destroy(this.collector)
    J.destroy(this.anyBroadPhase)
    J.destroy(this.anyObject)
  }

  /**
   * The world XZ rectangles of the bodies other than `self` and `deck` that `self` touches and stands on: their tops
   * within STACK_TOL of its underside `bottom`. From the broadphase box under `self`'s underside samples.
   */
  private otherSupports(self: Jolt.Body, deck: number, under: Vec3[], bottom: number): { x0: number; z0: number; x1: number; z1: number }[] {
    const J = this.J
    let x0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let z1 = -Infinity
    for (const p of under) {
      x0 = Math.min(x0, p[0])
      z0 = Math.min(z0, p[2])
      x1 = Math.max(x1, p[0])
      z1 = Math.max(z1, p[2])
    }
    const lo = new J.Vec3(x0 - 0.05, bottom - STACK_TOL, z0 - 0.05)
    const hi = new J.Vec3(x1 + 0.05, bottom + STACK_TOL, z1 + 0.05)
    const box = new J.AABox(lo, hi)
    this.hits.length = 0
    this.system.GetBroadPhaseQuery().CollideAABox(box, this.collector, this.anyBroadPhase, this.anyObject)
    J.destroy(box)
    J.destroy(lo)
    J.destroy(hi)
    const selfKey = self.GetID().GetIndexAndSequenceNumber()
    const out: { x0: number; z0: number; x1: number; z1: number }[] = []
    for (const key of this.hits) {
      if (key === selfKey || key === deck) continue
      const id = new J.BodyID(key)
      if (this.system.WereBodiesInContact(self.GetID(), id)) {
        const b = this.bodyInterface.GetTransformedShape(id).GetWorldSpaceBounds()
        const top = b.mMax.GetY()
        // it holds the body up when its top is at the body's underside, not beside or above it
        if (Math.abs(top - bottom) <= STACK_TOL) out.push({ x0: b.mMin.GetX(), z0: b.mMin.GetZ(), x1: b.mMax.GetX(), z1: b.mMax.GetZ() })
      }
      J.destroy(id)
    }
    return out
  }

  private measure(cell: LoadCell): number {
    const boxes = this.boxes
    const snap = this.cargo.stepSnapshot()
    const p = cell.body.GetPosition()
    const r = cell.body.GetRotation()
    const dp: Vec3 = [p.GetX(), p.GetY(), p.GetZ()]
    const dqInv = qConjugate([r.GetX(), r.GetY(), r.GetZ(), r.GetW()])
    const [hx, hy, hz] = cell.he
    const deckKey = cell.id.GetIndexAndSequenceNumber()
    // candidates: the rows standing over the platform's footprint, widened by the largest body
    if (snap && boxes.length >= GRID_MIN_ROWS) this.cargo.ensureRowGrid(snap)
    const reach = Math.hypot(hx, hz) + this.cargo.maxRowRadius + 1e-6
    const nearShared = this.cargo.rowsNear(snap, dp[0] - reach, dp[2] - reach, dp[0] + reach, dp[2] + reach)
    const near = nearShared ? nearShared.slice() : boxes.map((_, i) => i)
    const pos = (i: number): Vec3 => {
      if (snap) {
        const o = i * 7
        return [snap[o] as number, snap[o + 1] as number, snap[o + 2] as number]
      }
      const bp = boxes[i]!.body.GetPosition()
      return [bp.GetX(), bp.GetY(), bp.GetZ()]
    }
    const quat = (i: number): Quat => {
      if (snap) {
        const o = i * 7
        return [snap[o + 3] as number, snap[o + 4] as number, snap[o + 5] as number, snap[o + 6] as number]
      }
      const q = boxes[i]!.body.GetRotation()
      return [q.GetX(), q.GetY(), q.GetZ(), q.GetW()]
    }
    const toLocal = (w: Vec3): Vec3 => qApply(dqInv, [w[0] - dp[0], w[1] - dp[1], w[2] - dp[2]])
    const onDeck = (w: Vec3): boolean => {
      const l = toLocal(w)
      return Math.abs(l[0]) <= hx && Math.abs(l[2]) <= hz
    }
    const bottom = (rows: number[]): number => Math.min(...rows.map((i) => pos(i)[1] - boxes[i]!.hy))
    const top = (rows: number[]): number => Math.max(...rows.map((i) => pos(i)[1] + boxes[i]!.hy))
    // the world points sampled over the underside of a body's base: a unit load's base layer, else the body's own
    const underside = (rows: number[]): Vec3[] => {
      const low = bottom(rows)
      const out: Vec3[] = []
      for (const i of rows) {
        const b = boxes[i]!
        const c = pos(i)
        if (c[1] - b.hy > low + BASE_LAYER_TOL) continue
        const q = quat(i)
        for (const sx of SAMPLES) {
          for (const sz of SAMPLES) {
            const d = qApply(q, [sx * b.hx, -b.hy, sz * b.hz])
            out.push([c[0] + d[0], c[1] + d[1], c[2] + d[2]])
          }
        }
      }
      return out
    }
    // one entry per body (a unit load's pieces share theirs), with the rows of its pieces near the platform
    const bodyRows = new Map<number, number[]>()
    for (const i of near) {
      const b = boxes[i]
      if (!b || this.holds.holders.has(b.id)) continue // carried by a gripper, a person or a pin: not resting on it
      let list = bodyRows.get(b.key)
      if (!list) bodyRows.set(b.key, (list = []))
      list.push(i)
    }
    const prev = cell.resting
    const asleep = (b: LiveBox): boolean => !this.bodyInterface.IsActive(b.body.GetID())
    const found = new Map<number, Resting>()
    // the bodies standing on the platform's top face. A sleeping one stands there if it did last tick: it has not moved
    for (const [key, rows] of bodyRows) {
      const b = boxes[rows[0]!]!
      const was = prev.get(key)
      const stands = was && asleep(b) ? was.base === key : rows.some((i) => toLocal(pos(i))[1] > hy) && this.system.WereBodiesInContact(cell.id, b.body.GetID())
      if (stands && underside(rows).some(onDeck)) found.set(key, { box: b, rows, base: key })
    }
    // everything stacked on them, course on course: its weight goes down through what it rests on. A body counts as
    // stacked when its underside is at or above the top of the body it touches, so a case queued against one on the
    // platform, side by side, is not
    let added = found.size > 0
    while (added) {
      added = false
      for (const [key, rows] of bodyRows) {
        if (found.has(key)) continue
        const b = boxes[rows[0]!]!
        const was = prev.get(key)
        if (was && asleep(b)) {
          // asleep: stacked on the same base as last tick, if that base is still found
          const base = found.get(was.base)
          if (was.base !== key && base && base.base === was.base) {
            found.set(key, { box: b, rows, base: was.base })
            added = true
          }
          continue
        }
        const under = bottom(rows)
        for (const s of found.values()) {
          if (under < top(s.rows) - STACK_TOL || !this.system.WereBodiesInContact(s.box.body.GetID(), b.body.GetID())) continue
          found.set(key, { box: b, rows, base: s.base })
          added = true
          break
        }
      }
    }
    // each body's mass and vertical acceleration, and the force it puts down: m (g + a)
    const g = this.g
    const dt = this.dt
    const bodies = new Map<number, { s: Resting; m: number; vy: number; f: number }>()
    for (const [key, s] of found) {
      const inv = s.box.body.GetMotionProperties().GetInverseMass()
      if (!(inv > 0)) continue
      const vy = s.box.body.GetLinearVelocity().GetY()
      const was = prev.get(key)
      const a = was === undefined ? 0 : (vy - was.vy) / dt
      bodies.set(key, { s, m: 1 / inv, vy, f: (g + a) / inv })
    }
    // each stack's share of its weight on the platform: whole on the platform alone, else by the lever rule
    const shares = new Map<number, number>()
    for (const [key, s] of found) {
      if (s.base !== key) continue
      const members = [...bodies.values()].filter((e) => e.s.base === key)
      const was = prev.get(key)
      if (was && was.base === key && members.every((e) => asleep(e.s.box))) {
        shares.set(key, was.share) // the whole stack is asleep: nothing moved
        continue
      }
      const under = underside(s.rows)
      const others = this.otherSupports(s.box.body, deckKey, under, bottom(s.rows))
      const inOther = (w: Vec3): boolean => others.some((o) => w[0] >= o.x0 && w[0] <= o.x1 && w[2] >= o.z0 && w[2] <= o.z1)
      const mine = under.filter(onDeck)
      const theirs = under.filter((w) => !onDeck(w) && inOther(w))
      if (theirs.length === 0 || mine.length === 0) {
        shares.set(key, mine.length > 0 ? 1 : 0)
        continue
      }
      // the stack's centre of gravity, from each body's own centre of mass
      let cx = 0
      let cz = 0
      let mass = 0
      for (const e of members) {
        const c = e.s.box.body.GetCenterOfMassPosition()
        cx += c.GetX() * e.m
        cz += c.GetZ() * e.m
        mass += e.m
      }
      cx /= mass
      cz /= mass
      const centroid = (ps: Vec3[]): [number, number] => [ps.reduce((t, w) => t + w[0], 0) / ps.length, ps.reduce((t, w) => t + w[2], 0) / ps.length]
      const [ax, az] = centroid(mine)
      const [bx, bz] = centroid(theirs)
      const vx = bx - ax
      const vz = bz - az
      const len2 = vx * vx + vz * vz
      // where the centre of gravity falls between the two bearing points: 0 over the platform's, 1 over the other's
      const t = len2 > 1e-12 ? ((cx - ax) * vx + (cz - az) * vz) / len2 : 0
      shares.set(key, Math.min(1, Math.max(0, 1 - t)))
    }
    let force = 0
    const next = new Map<number, { vy: number; base: number; share: number }>()
    for (const [key, e] of bodies) {
      const share = shares.get(e.s.base) ?? 0
      force += share * e.f
      next.set(key, { vy: e.vy, base: e.s.base, share })
    }
    cell.resting = next
    return g > 0 ? force / g : 0
  }
}
