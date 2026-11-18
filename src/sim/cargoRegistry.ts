// The live cargo: every dynamic cargo body (SimWorld's `boxes`), the unit loads joined from them, the dressings on
// loads, and the per-step caches read over them - the batched pose snapshot and the rows-by-floor-cell grid. Cargo
// is created, removed, joined and split only here, and every add/remove bumps `boxesRev`, which is what keys the
// caches: nothing outside can change the list behind them. SimWorld owns one.
import type Jolt from 'jolt-physics'
import { CARGO_CAP_HEAVY, CARGO_CAP_SEPARATE_CONTACTS, CARGO_KIND_PALLET, CARGO_KIND_TOTE, capsOfKind, cargoKindProduct } from '../core/frame'
import type { CargoShapeRef, FrameDressing } from '../core/frame'
import type { ParamValue } from '../core/parts/partApi'
import type { WrapBody } from '../core/cargoWrap'
import { qApply, qConjugate, qMul } from '../core/rig/rigPose'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import { buildPalletShape, buildPartCargoShape, buildToteShape, destroyBody, makeCargoBody } from './bodyFactory'
import type { CargoPiece } from '../core/cargoBody'
import type { BodyHolds } from './bodyHolds'
import { composeUnitRows, wrapBodies } from './cargoLoads'
import { bodyKey } from './worldTypes'
import type { JoltModule, LiveBox, PartGroup, StepClock, UnitLoad } from './worldTypes'

/** rowsNear's floor cell (m), and the sizes below which / above which the plain row scan runs instead */
const GRID_CELL = 2
export const GRID_MIN_ROWS = 64
const GRID_MAX_CELLS = 256
const gridKey = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768)
const ascending = (a: number, b: number): number => a - b

export class CargoRegistry {
  /** every live cargo body, in creation order (the frame's row order); read anywhere, written only here */
  readonly boxes: LiveBox[]
  /** bumped on every boxes add/remove so a cached beam snapshot can't outlive the list it indexes */
  private boxesRev = 0
  private nextBoxId = 1
  /** every live unit load (ctx.join) */
  readonly units = new Set<UnitLoad>()
  /**
   * Dressings on loads (ctx.dress), by the frame id of the anchor body (the pallet the load stands on) and then by
   * the dressing's id. A machine grows one (CargoFlow.fulfillCargoOps); an authored unit load gets its own at the first
   * step (CargoFlow.seedAuthoredUnits). It is the load's from then on, so it goes where the anchor goes, and
   * removeBox drops it with the anchor. Run state, like the cargo it is on.
   */
  readonly dressings = new Map<number, Map<string, FrameDressing>>()
  /** forked build's batched pos/quat reader for the frame walk + beam casts (null = stock build) */
  private bodySnapshot: Jolt.BodySnapshot | null = null
  private snapIds: Uint32Array | null = null
  private snapOut: Float32Array | null = null
  /** the stock-build snapshot buffer (see snapshotBoxes) */
  private snapJs: Float32Array | null = null
  /** (step, boxesRev) the cached step snapshot was taken at - see stepSnapshot() */
  private stepSnapStep = -1
  private stepSnapRev = -1
  private stepSnap: Float32Array | null = null
  /** a step is running (beginStep..endStep): a pose write then leaves the step's snapshot as it is (placeBody) */
  private stepping = false
  /** the pallet colliders (bodyFactory buildPalletShape), built once per footprint (mm) and shared by every pallet body
   *  of that size */
  private readonly palletShapes = new Map<string, Jolt.Shape>()
  /** the tote colliders (bodyFactory buildToteShape), built once per size (half-mm) and shared the same way */
  private readonly toteShapes = new Map<string, Jolt.Shape>()
  /** a part's own body shape per shape key (core/cargoBody.ts), built on its first body and shared like the pallet's */
  private readonly partShapes = new Map<string, Jolt.Shape>()
  /** what each body is (its product and params) by key, for the frame: the view draws a part's own visual from it, and
   *  the editor makes a selected spawned body that part */
  readonly shapeRefs = new Map<string, CargoShapeRef>()
  /** set by removeAll: a disposing world lets go of each unit's body with its last piece instead of splitting it */
  private disposing = false

  // Cargo rows by floor cell, so a zone count or beam run (per behavior per tick) need not scan every row. A scene
  // with hundreds of cargo rows (a stocked rack line, unit loads at a dock) would otherwise cost rows x queries.
  // Built from the batched snapshot on first use in a step and kept while the step / boxesRev key holds. A query
  // returns ascending row indices, so it visits rows in the scan's own order: every sum, count and
  // tie-break comes out exactly as the full scan's (the golden trace does not move). Below GRID_MIN_ROWS, or for a
  // query spanning more than GRID_MAX_CELLS, the plain scan is cheaper and is what runs.
  private rowGrid = new Map<number, number[]>()
  private rowGridStep = -1
  private rowGridRev = -1
  /** the largest bounding radius of any row this step: how far a beam can reach into a neighbouring cell */
  private rowGridMaxR = 0
  private readonly nearRows: number[] = []

  /**
   * `boxes` is the list this registry fills (the holds read it too); `clock` + `hz` stamp spawn times and key the
   * caches by step; `holds` lets go of a piece before its unit is taken apart and forgets a body that leaves;
   * `partGroups` is the world's, kept accurate when a part's cargo body is removed.
   */
  constructor(
    private readonly J: JoltModule,
    private readonly system: Jolt.PhysicsSystem,
    private readonly bodyInterface: Jolt.BodyInterface,
    private readonly axisY: Jolt.Vec3,
    private readonly clock: StepClock,
    private readonly hz: number,
    boxes: LiveBox[],
    private readonly holds: BodyHolds,
    private readonly partGroups: ReadonlyMap<string, PartGroup>,
  ) {
    this.boxes = boxes
  }

  /** how many cargo bodies this world has created (measurements' spawnedTotal) */
  get spawnedTotal(): number {
    return this.nextBoxId - 1
  }

  /** the new box's frame id, or -1 when the physics system has no room left for another body */
  createDynamicBox(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    rotation: number | [number, number, number, number], // yaw, or a full orientation quat (tilted authored cargo)
    mass: number,
    friction: number,
    kind: number,
    partId: string | null,
    color: [number, number, number] = [1, 1, 1],
    // what the body is (its product and params, keyed for the frame), and for a part with its own body its pieces
    own?: { key: string; pieces?: readonly CargoPiece[]; product: string; params: Readonly<Record<string, ParamValue>> },
    // CARGO_CAP_* bits; a body that declares none has its kind's (a box, pallet or tote as it always was)
    caps: number = capsOfKind(kind),
  ): number {
    if (own && !this.shapeRefs.has(own.key)) {
      if (own.pieces) this.partShapes.set(own.key, this.keep(buildPartCargoShape(this.J, own.pieces)))
      this.shapeRefs.set(own.key, { packageId: own.product, params: own.params })
    }
    const body = makeCargoBody(this.J, this.bodyInterface, this.axisY, this.cargoShape(kind, hx, hy, hz, own?.key), x, y, z, rotation, mass, friction, (caps & CARGO_CAP_HEAVY) !== 0, (caps & CARGO_CAP_SEPARATE_CONTACTS) !== 0)
    if (!body) return -1
    const id = this.nextBoxId++
    this.boxesRev++
    this.boxes.push({ id, body, key: bodyKey(body), hx, hy, hz, kind, partId, color, spawnTime: this.clock.step / this.hz, mass, friction, unit: null, local: null, marks: null, attrTypes: null, ownerId: null, product: own?.product ?? cargoKindProduct(kind), ...(own ? { shapeKey: own.key } : {}), caps })
    return id
  }

  /** Take a reference for the cache on a shape it is about to share. Jolt frees a shape with the last body that
   *  uses it. Without a reference of its own the cache would hand the freed shape to the next body once every
   *  body of that shape had been removed, and that body is then built on memory Jolt has given to something else. */
  private keep(shape: Jolt.Shape): Jolt.Shape {
    shape.AddRef()
    return shape
  }

  private palletShape(hx: number, hz: number): Jolt.Shape {
    const key = `${Math.round(hx * 2000)}x${Math.round(hz * 2000)}`
    let shape = this.palletShapes.get(key)
    if (!shape) {
      shape = this.keep(buildPalletShape(this.J, hx * 2, hz * 2))
      this.palletShapes.set(key, shape)
    }
    return shape
  }

  private toteShape(hx: number, hy: number, hz: number): Jolt.Shape {
    const key = `${Math.round(hx * 2000)}x${Math.round(hy * 2000)}x${Math.round(hz * 2000)}`
    let shape = this.toteShapes.get(key)
    if (!shape) {
      shape = this.keep(buildToteShape(this.J, hx * 2, hy * 2, hz * 2))
      this.toteShapes.set(key, shape)
    }
    return shape
  }

  /** a cargo piece's collider. A pallet's and a tote's are not their bounding boxes: a pallet carries its fork pockets,
   *  so a truck can put its blades in it (see palletShape), and a tote is open at the top, so cargo can go in it and it
   *  stacks on its foot (toteShape). A part with its own body is its shape by key (partShapes). Every other cargo body
   *  is the box it looks like. */
  private cargoShape(kind: number, hx: number, hy: number, hz: number, shapeKey?: string): Jolt.Shape {
    const own = shapeKey !== undefined ? this.partShapes.get(shapeKey) : undefined
    if (own) return own
    if (kind === CARGO_KIND_PALLET) return this.palletShape(hx, hz)
    if (kind === CARGO_KIND_TOTE) return this.toteShape(hx, hy, hz)
    const J = this.J
    const halfExtent = new J.Vec3(hx, hy, hz)
    const shape = new J.BoxShape(halfExtent, Math.min(0.02, 0.4 * Math.min(hx, hy, hz)))
    J.destroy(halfExtent)
    return shape
  }

  removeBox(index: number): void {
    const box = this.boxes[index]
    if (!box) return
    // a piece of a unit load leaves it first: taken apart into loose pieces (a disposing world just lets go of the
    // unit's body with its last piece), so the body removed below is this piece's own
    if (box.unit) {
      if (this.disposing) this.detachFromUnit(box)
      else this.splitUnit(box.unit)
    }
    this.boxesRev++
    this.boxes.splice(index, 1)
    this.dressings.delete(box.id) // a dressing goes with the pallet it was on
    this.holds.forget(box.id)
    // keep the owning part group's boxIds accurate when a cargo body is culled/despawned
    if (box.partId) {
      const group = this.partGroups.get(box.partId)
      const at = group?.boxIds.indexOf(box.id) ?? -1
      if (group && at >= 0) group.boxIds.splice(at, 1)
    }
    if (this.disposing && box.local) return // the unit's body went with its last piece (detachFromUnit)
    destroyBody(this.bodyInterface, box.body)
  }

  /** the world is going: remove every cargo body, last first */
  removeAll(): void {
    this.disposing = true
    while (this.boxes.length > 0) this.removeBox(this.boxes.length - 1)
  }

  /**
   * ctx.join: make the pieces at `rows` (anchor first) one unit load. The unit's body is a static compound of each
   * piece's own collider at its offset from the anchor, placed where the anchor stands and carrying on at its
   * speed; the pieces' own bodies go, and each piece rides the unit's from here (LiveBox.unit / local). Refused
   * (null) while something holds a piece, or when Jolt cannot build it. A load already joined as exactly these
   * pieces is returned as it is; pieces of other units are taken apart first, so a load re-joined with more on it
   * becomes one unit.
   */
  joinRows(rows: number[]): UnitLoad | null {
    const pieces = rows.map((i) => this.boxes[i]!)
    if (pieces.some((p) => this.holds.holders.has(p.id))) return null
    const already = new Set<UnitLoad>()
    for (const p of pieces) if (p.unit) already.add(p.unit)
    if (already.size === 1 && pieces.every((p) => p.unit) && [...already][0]!.members.length === pieces.length) return [...already][0]!
    for (const u of already) this.splitUnit(u)
    const J = this.J
    const bodies = this.wrapBodies()
    const a = bodies[rows[0]!]!
    const anchor = pieces[0]!
    const inv = qConjugate(a.quat)
    const settings = new J.StaticCompoundShapeSettings()
    const locals: { p: Vec3; q: Quat }[] = []
    let mass = 0
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k]!
      const b = bodies[rows[k]!]!
      const lp = qApply(inv, [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]])
      const lq = qMul(inv, b.quat)
      locals.push({ p: lp, q: lq })
      const pos = new J.Vec3(lp[0], lp[1], lp[2])
      const rot = new J.Quat(lq[0], lq[1], lq[2], lq[3])
      settings.AddShapeShape(pos, rot, this.cargoShape(piece.kind, piece.hx, piece.hy, piece.hz, piece.shapeKey), 0)
      J.destroy(pos)
      J.destroy(rot)
      mass += piece.mass
    }
    const result = settings.Create()
    if (result.HasError()) {
      J.destroy(settings)
      return null
    }
    const shape = result.Get()
    J.destroy(settings)
    const lv = anchor.body.GetLinearVelocity()
    const vel: Vec3 = [lv.GetX(), lv.GetY(), lv.GetZ()]
    const av = anchor.body.GetAngularVelocity()
    const spin: Vec3 = [av.GetX(), av.GetY(), av.GetZ()]
    // the loose bodies go before the unit is added, or it would be created overlapping all of them
    for (const p of pieces) destroyBody(this.bodyInterface, p.body)
    const body = makeCargoBody(this.J, this.bodyInterface, this.axisY, shape, a.pos[0], a.pos[1], a.pos[2], a.quat, mass, anchor.friction, true)
    if (!body) {
      // Jolt's body table is full: put the pieces back as they were rather than lose them
      for (let k = 0; k < pieces.length; k++) {
        const piece = pieces[k]!
        const b = bodies[rows[k]!]!
        const own = makeCargoBody(this.J, this.bodyInterface, this.axisY, this.cargoShape(piece.kind, piece.hx, piece.hy, piece.hz, piece.shapeKey), b.pos[0], b.pos[1], b.pos[2], b.quat, piece.mass, piece.friction, (piece.caps & CARGO_CAP_HEAVY) !== 0, (piece.caps & CARGO_CAP_SEPARATE_CONTACTS) !== 0)
        if (own) {
          piece.body = own
          piece.key = bodyKey(own)
        }
      }
      this.boxesRev++
      return null
    }
    this.setBodyVelocity(body, vel, spin)
    const unit: UnitLoad = { body, key: bodyKey(body), members: pieces, marks: {} }
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k]!
      piece.body = body
      piece.key = unit.key
      piece.unit = unit
      piece.local = locals[k]!
    }
    this.units.add(unit)
    this.boxesRev++
    return unit
  }

  /**
   * Take a unit load apart (a piece removed from it, a hand taking hold of one): every piece gets its own body back,
   * where it stands and at the unit's speed. The unit's marks are left on each piece,
   * so a split load is still known to have been wrapped; a machine that cuts the film marks it otherwise.
   */
  splitUnit(unit: UnitLoad): void {
    if (!this.units.has(unit)) return
    for (const m of unit.members) if (this.holds.holders.has(m.id)) this.holds.letGo(m.id)
    const bodies = this.wrapBodies()
    const rowOf = new Map(this.boxes.map((b, i) => [b.id, i]))
    const lv = unit.body.GetLinearVelocity()
    const vel: Vec3 = [lv.GetX(), lv.GetY(), lv.GetZ()]
    const poses = unit.members.map((m) => bodies[rowOf.get(m.id) ?? -1])
    // the unit goes before the pieces are added, or each would be created inside it
    this.units.delete(unit)
    destroyBody(this.bodyInterface, unit.body)
    for (let k = 0; k < unit.members.length; k++) {
      const m = unit.members[k]!
      const pose = poses[k]
      m.unit = null
      m.local = null
      if (Object.keys(unit.marks).length) m.marks = { ...(m.marks ?? {}), ...unit.marks }
      if (!pose) continue
      const own = makeCargoBody(this.J, this.bodyInterface, this.axisY, this.cargoShape(m.kind, m.hx, m.hy, m.hz, m.shapeKey), pose.pos[0], pose.pos[1], pose.pos[2], pose.quat, m.mass, m.friction, (m.caps & CARGO_CAP_HEAVY) !== 0, (m.caps & CARGO_CAP_SEPARATE_CONTACTS) !== 0)
      if (!own) continue
      m.body = own
      m.key = bodyKey(own)
      this.setBodyVelocity(own, vel, [0, 0, 0])
    }
    this.boxesRev++
  }

  /** a disposing world lets go of a unit piece by piece: its body goes with its last piece (see removeBox) */
  private detachFromUnit(box: LiveBox): void {
    const u = box.unit
    if (!u) return
    u.members = u.members.filter((m) => m !== box)
    if (u.members.length === 0 && this.units.delete(u)) destroyBody(this.bodyInterface, u.body)
  }

  private setBodyVelocity(body: Jolt.Body, v: Vec3, w: Vec3): void {
    const J = this.J
    const lv = new J.Vec3(v[0], v[1], v[2])
    const av = new J.Vec3(w[0], w[1], w[2])
    this.bodyInterface.SetLinearAndAngularVelocity(body.GetID(), lv, av)
    J.destroy(lv)
    J.destroy(av)
  }

  setDressing(d: FrameDressing): void {
    let m = this.dressings.get(d.anchor)
    if (!m) this.dressings.set(d.anchor, (m = new Map()))
    m.set(d.id, d)
  }

  /** every live cargo body as the load measure sees it (core/cargoWrap), row for row with this.boxes */
  wrapBodies(): WrapBody[] {
    return wrapBodies(this.boxes, this.stepSnapshot())
  }

  /**
   * Set a cargo body's position, rotation or both, and wake it: a gizmo drag, a gripper carrying its load, the pilot
   * turning what it holds. Every cargo pose write outside the solver goes through here (eslint bans the raw calls
   * elsewhere in src/sim). A write between steps makes the cached snapshot stale, so the next step fills afresh (see
   * frameSnapshot). A write during a step leaves it as it is: the step's consumers all read the poses the step began
   * with.
   */
  placeBody(id: Jolt.BodyID, pos: Jolt.RVec3 | null, rot: Jolt.Quat | null): void {
    const J = this.J
    if (pos && rot) this.bodyInterface.SetPositionAndRotation(id, pos, rot, J.EActivation_Activate)
    else if (pos) this.bodyInterface.SetPosition(id, pos, J.EActivation_Activate)
    else if (rot) this.bodyInterface.SetRotation(id, rot, J.EActivation_Activate)
    if (!this.stepping) this.stepSnapStep = -1
  }

  /** SimWorld.step brackets the step with these, so placeBody knows which side of one a write is on */
  beginStep(): void {
    this.stepping = true
  }

  endStep(): void {
    this.stepping = false
  }

  /** grow-on-demand accessors for the native snapshot's shared buffers; null on a stock build */
  private ensureSnapshot(count: number): { ids: Uint32Array; out: Float32Array } | null {
    const J = this.J
    const Snapshot = (J as { BodySnapshot?: new (cap: number) => Jolt.BodySnapshot }).BodySnapshot
    if (typeof Snapshot !== 'function') return null
    if (!this.bodySnapshot || this.bodySnapshot.GetCapacity() < count) {
      if (this.bodySnapshot) J.destroy(this.bodySnapshot)
      let cap = 4096
      while (cap < count) cap *= 2
      this.bodySnapshot = new Snapshot(cap)
      const heap = J as unknown as { HEAPU32: Uint32Array; HEAPF32: Float32Array }
      this.snapIds = new Uint32Array(heap.HEAPU32.buffer, this.bodySnapshot.GetIdsPtr(), cap)
      this.snapOut = new Float32Array(heap.HEAPF32.buffer, this.bodySnapshot.GetOutPtr(), cap * 7)
    }
    return { ids: this.snapIds as Uint32Array, out: this.snapOut as Float32Array }
  }

  /** One WASM call reads every live box's pos+quat (7 floats each, box-list order). It replaces the
   *  ~9 getter crossings per box the frame walk / beam casts would otherwise make (~1 µs per box). */
  snapshotBoxes(): Float32Array | null {
    const n = this.boxes.length
    const s = this.ensureSnapshot(n)
    let out: Float32Array
    if (s && this.bodySnapshot) {
      for (let i = 0; i < n; i++) s.ids[i] = (this.boxes[i] as LiveBox).key
      this.bodySnapshot.Fill(this.system, n)
      out = s.out
    } else {
      // stock build, no native snapshot: the same rows through the getters. Only needed once a unit load exists
      // (its pieces' rows must be composed, below); until then the callers' own getter fallbacks are exact.
      if (this.units.size === 0) return null
      if (!this.snapJs || this.snapJs.length < n * 7) this.snapJs = new Float32Array(Math.max(64, n * 2) * 7)
      out = this.snapJs
      for (let i = 0; i < n; i++) {
        const b = (this.boxes[i] as LiveBox).body
        const p = b.GetPosition()
        const q = b.GetRotation()
        out.set([p.GetX(), p.GetY(), p.GetZ(), q.GetX(), q.GetY(), q.GetZ(), q.GetW()], i * 7)
      }
    }
    // a unit load's pieces all read the unit's pose above; compose each with its fixed offset in the unit
    if (this.units.size) composeUnitRows(this.boxes, out, n)
    return out
  }

  /**
   * The snapshot every per-box consumer before the solver shares in one step: cull, beam casts, zone counts and
   * despawns, load cells, cargo ops, flow facts, the gripper's grab search. Keyed by (step, boxesRev), so a spawn or
   * despawn mid-step re-reads rows for the shifted list, and a pose written between steps re-reads them (placeBody).
   */
  stepSnapshot(): Float32Array | null {
    if (this.stepSnapStep !== this.clock.step || this.stepSnapRev !== this.boxesRev) this.keepAsStepSnapshot(this.snapshotBoxes())
    return this.stepSnap
  }

  /**
   * The frame's snapshot, taken after the solver. The step counter has already moved on, so these are the poses the
   * next step begins with, unless something moves a body (placeBody) or changes the list (boxesRev) first. Kept as
   * that step's snapshot, which saves the next step a second fill of every body.
   */
  frameSnapshot(): Float32Array | null {
    return this.keepAsStepSnapshot(this.snapshotBoxes())
  }

  private keepAsStepSnapshot(snap: Float32Array | null): Float32Array | null {
    this.stepSnap = snap
    this.stepSnapStep = this.clock.step
    this.stepSnapRev = this.boxesRev
    return snap
  }

  ensureRowGrid(snap: Float32Array): void {
    if (this.rowGridStep === this.clock.step && this.rowGridRev === this.boxesRev) return
    this.rowGridStep = this.clock.step
    this.rowGridRev = this.boxesRev
    for (const list of this.rowGrid.values()) list.length = 0
    let maxRSq = 0
    for (let i = 0; i < this.boxes.length; i++) {
      const box = this.boxes[i]!
      const o = i * 7
      const key = gridKey(Math.floor((snap[o] as number) / GRID_CELL), Math.floor((snap[o + 2] as number) / GRID_CELL))
      let list = this.rowGrid.get(key)
      if (!list) this.rowGrid.set(key, (list = []))
      list.push(i)
      const rSq = box.hx * box.hx + box.hy * box.hy + box.hz * box.hz
      if (rSq > maxRSq) maxRSq = rSq
    }
    this.rowGridMaxR = Math.sqrt(maxRSq)
  }

  /** the largest bounding radius of any row, as of the last ensureRowGrid */
  get maxRowRadius(): number {
    return this.rowGridMaxR
  }

  /** the rows whose centre may lie in world XZ box [x0, x1] x [z0, z1], ascending; null = scan every row */
  rowsNear(snap: Float32Array | null, x0: number, z0: number, x1: number, z1: number): number[] | null {
    if (!snap || this.boxes.length < GRID_MIN_ROWS) return null
    const ix0 = Math.floor(x0 / GRID_CELL)
    const ix1 = Math.floor(x1 / GRID_CELL)
    const iz0 = Math.floor(z0 / GRID_CELL)
    const iz1 = Math.floor(z1 / GRID_CELL)
    if (!((ix1 - ix0 + 1) * (iz1 - iz0 + 1) <= GRID_MAX_CELLS)) return null // huge, or not finite
    this.ensureRowGrid(snap)
    const out = this.nearRows
    out.length = 0
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.rowGrid.get(gridKey(ix, iz))
        if (list) for (const i of list) out.push(i)
      }
    }
    return out.sort(ascending)
  }

  /** free the snapshot reader; after the world's JoltInterface is gone */
  dispose(): void {
    // the cache's own references (keep): the bodies are gone, so this frees the shapes
    for (const shapes of [this.palletShapes, this.toteShapes, this.partShapes]) {
      for (const shape of shapes.values()) shape.Release()
      shapes.clear()
    }
    if (this.bodySnapshot) {
      this.J.destroy(this.bodySnapshot)
      this.bodySnapshot = null
      this.snapIds = this.snapOut = this.stepSnap = null
    }
  }
}
