// Every body a part is built from, filed under its part so a live edit can tear down and rebuild just that part:
// the part groups (bodies, conveyor registrations, authored cargo ids), the ground bodies built outside any part,
// and the static / kinematic / compound-conveyor constructors the part builders call, which file each body under
// the part being built. SimWorld owns one and brackets each part's build with begin() / end().
import type Jolt from 'jolt-physics'
import type { ConveyorEntry, ConveyorSubShape } from '../core/geometry/collisionShapes'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import { compoundConveyorShape, createKinematicBoxQuat, createStaticBody, createStaticBoxQuat, destroyBody, makeBoxShape, makeHull } from './bodyFactory'
import type { FacetAxes } from './conveyorContacts'
import type { ConveyorFacets } from './conveyorFacets'
import { bodyKey } from './worldTypes'
import type { JoltModule, PartGroup } from './worldTypes'

/** Thrown when Jolt's body table (JoltSettings.mMaxBodies) is full: CreateBody returned a NULL body without throwing.
 *  SimWorld.buildPart catches it and tears the part down, so a part is never left half built. */
export class BodyTableFull extends Error {}

export class PartBodies {
  /** everything the sim created for each scene part, by part id; read anywhere, filed and dropped only here */
  readonly groups = new Map<string, PartGroup>()
  /** the part currently being built; add* helpers register their bodies into it */
  private current: PartGroup | null = null
  /** bodies built outside any part (the ground) */
  private groundBodies: Jolt.Body[] = []
  /** half the side of the ground slab now built (0 = none yet) */
  private groundHalf = 0

  constructor(
    private readonly J: JoltModule,
    private readonly bodyInterface: Jolt.BodyInterface,
    private readonly axisY: Jolt.Vec3,
    private readonly facets: ConveyorFacets,
  ) {}

  /** file `group` as part `partId`'s and build into it until end() */
  begin(partId: string, group: PartGroup): void {
    this.groups.set(partId, group)
    this.current = group
  }

  end(): void {
    this.current = null
  }

  /** the bodies built outside any part: the floor */
  get ground(): readonly Jolt.Body[] {
    return this.groundBodies
  }

  /** Size the square ground slab (its top at y = 0) to `half`. It is rebuilt only when the size changes, so a live
   *  edit that grows a building grows the floor under it. True when it was rebuilt. */
  fitGround(half: number, friction: number): boolean {
    if (half === this.groundHalf) return false
    for (const body of this.groundBodies) destroyBody(this.bodyInterface, body)
    this.groundBodies = []
    this.groundHalf = half
    const outer = this.current
    this.current = null
    this.addStaticBox(half, 0.5, half, 0, -0.5, 0, 0, friction)
    this.current = outer
    return true
  }

  /** File a body under the part being built, or the ground. A NULL body is never filed or handed back: its id is
   *  garbage, and a builder would register it with the rig driver or a behavior. */
  private file(body: Jolt.Body): void {
    if (this.J.getPointer(body) === 0) throw new BodyTableFull()
    ;(this.current ? this.current.bodies : this.groundBodies).push(body)
  }

  /** an authored cargo body built for the part being built */
  fileBox(boxId: number): void {
    this.current?.boxIds.push(boxId)
  }

  /** bind an existing live cargo body to part `partId` (SimWorld.adopt), filing a bodiless group if it has none */
  adoptBox(partId: string, boxId: number): void {
    const existing = this.groups.get(partId)
    if (existing) {
      if (!existing.boxIds.includes(boxId)) existing.boxIds.push(boxId)
    } else {
      this.groups.set(partId, {
        signature: '',
        bodies: [],
        conveyorKeys: [],
        boxIds: [boxId],
      })
    }
  }

  /** destroy a part's bodies and release its conveyor registrations; its group stays filed until forget() */
  destroyBodies(group: PartGroup): void {
    for (const body of group.bodies) destroyBody(this.bodyInterface, body)
    for (const key of group.conveyorKeys) this.facets.release(key)
  }

  forget(partId: string): void {
    this.groups.delete(partId)
  }

  /** the world is going: destroy the ground and every part's bodies */
  destroyAll(): void {
    for (const body of this.groundBodies) destroyBody(this.bodyInterface, body)
    this.groundBodies = []
    this.groundHalf = 0
    for (const group of this.groups.values()) {
      for (const body of group.bodies) destroyBody(this.bodyInterface, body)
    }
    this.groups.clear()
  }

  // Kinematic box on the moving layer (rig link colliders), with a full orientation - rig links can be
  // arbitrarily rotated, not just yawed. Driven each step by the behavior's joint output via MoveKinematic.
  addKinematicBoxQuat(hx: number, hy: number, hz: number, pos: Vec3, quat: Quat, friction: number): Jolt.Body {
    const body = createKinematicBoxQuat(this.J, this.bodyInterface, hx, hy, hz, pos, quat, friction)
    this.file(body)
    return body
  }

  /** register a conveyor body's surface-velocity entries with the facet table (ConveyorFacets.register), filed
   *  under the part being built so its teardown releases them */
  registerConveyorBody(body: Jolt.Body, entries: ConveyorEntry[], axes?: readonly (FacetAxes | null)[]): void {
    const key = bodyKey(body)
    this.current?.conveyorKeys.push(key)
    this.facets.register(body, key, entries, axes)
  }

  /**
   * Running-surface split: the housing facets (entry === null) are built as their own body, never as
   * sub-shapes of the conveyor. A registered conveyor body has the ghost gates applied to every contact it
   * makes (that is what "count 0 = ghost-gates only" means), and the shallow-ram gate would disable
   * a flank contact, letting cargo sink through the housing onto the conveying slab recessed behind it (the
   * rig path avoids this only because its housing is a separate, unregistered body). Kept separate and
   * unregistered, the housing is plain collision the gates never touch: a real wall.
   */
  addCompoundConveyor(
    subs: readonly ConveyorSubShape[],
    x: number,
    y: number,
    z: number,
    rotationY: number,
    friction: number,
  ): Jolt.Body {
    const conveying = subs.filter((s) => s.entry)
    if (conveying.length === 0) return this.buildCompound(subs, x, y, z, rotationY, friction, true)
    const plain = subs.filter((s) => !s.entry)
    // the housing shares the bed's friction: it is the same structure, cargo sliding along a flank must not
    // grip harder than the running surface, and it keeps "max friction over a part's bodies == its deck
    // friction" true (what the conveyor-parity tests probe with, since guards are friction 0).
    if (plain.length > 0) this.buildCompound(plain, x, y, z, rotationY, friction, false)
    return this.buildCompound(conveying, x, y, z, rotationY, friction, true)
  }

  /** Build one static compound body from facets; `register` publishes its surface-velocity entries. */
  buildCompound(
    subs: readonly ConveyorSubShape[],
    x: number,
    y: number,
    z: number,
    rotationY: number,
    friction: number,
    register: boolean,
  ): Jolt.Body {
    const made = compoundConveyorShape(this.J, subs)
    const body = this.addStaticShape(made.shape, x, y, z, rotationY, friction)
    void made.keepAlive // referenced until the compound (and now the body) hold their refs
    if (register && made.entries.length > 0) {
      this.registerConveyorBody(body, made.entries, made.axes)
    }
    return body
  }

  addStaticBox(
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
    rotationY: number,
    friction: number,
  ): Jolt.Body {
    return this.addStaticShape(makeBoxShape(this.J, hx, hy, hz), x, y, z, rotationY, friction)
  }

  addStaticShape(
    shape: Jolt.Shape,
    x: number,
    y: number,
    z: number,
    rotationY: number,
    friction: number,
  ): Jolt.Body {
    const body = createStaticBody(this.J, this.bodyInterface, this.axisY, shape, x, y, z, rotationY, friction)
    this.file(body)
    return body
  }

  /** static box with an arbitrary orientation quaternion (tilted belt run/guard) */
  addStaticBoxQuat(
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
    q: { x: number; y: number; z: number; w: number },
    friction: number,
  ): Jolt.Body {
    const body = createStaticBoxQuat(this.J, this.bodyInterface, hx, hy, hz, x, y, z, q, friction)
    this.file(body)
    return body
  }

  /** static convex hull from part-local points, placed at the part pose (spur deck) */
  addStaticHull(
    points: readonly { x: number; y: number; z: number }[],
    x: number,
    y: number,
    z: number,
    rotationY: number,
    friction: number,
  ): Jolt.Body {
    const { shape, result } = makeHull(this.J, points)
    const body = this.addStaticShape(shape, x, y, z, rotationY, friction)
    void result // kept referenced until the body's BodyCreationSettings took a ref
    return body
  }
}
