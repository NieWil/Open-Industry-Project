// Who holds each live cargo body - a rig gripper, the walking pilot's carry, or a pin - and the per-step steering of
// what the pilot carries. Every hold goes through claim() / letGo() here. SimWorld owns one; the cargo registry asks
// it to let go of a piece before a unit is taken apart and to forget a body leaving the world.
import type Jolt from 'jolt-physics'
import type { BodyHolder, JoltModule, KinematicScratch, LiveBox, PartGroup, PlaceBody } from './worldTypes'

// Pilot carry: a held box stays dynamic (gravity off) and is velocity-driven
// toward the hold point each step, so conveyor/wall contacts resolve it instead of
// it teleporting through them. GAIN is an 8/s ease; the speed clamp keeps a
// far hold-point jump from flinging the box (CCD would still sweep it, but a
// 10 m/s cap reads as "carried", not "launched").
const HOLD_FOLLOW_GAIN = 8
const HOLD_MAX_SPEED = 10

/** a rig gripper as a holder sees it (BodyHolder's `grip` rig) */
type GripRig = NonNullable<Extract<BodyHolder, { kind: 'grip' }>['rig']>

export class BodyHolds {
  /**
   * Who holds each live cargo body (by frame body id): one holder at a time, and every hold goes through
   * claim / letGo. Without one table, the rig gripper, the pilot's carry and the pin/drag freeze would each flip
   * a body's motion type on their own, blind to the others: the pilot "picking up" a box an AGV carries would get
   * the Drop prompt while the gripper kept teleporting it, and unpinning a gripped box would turn it dynamic under
   * the gripper. A claim transfers: the previous holder lets go first, by its own rule (takeFromGripper for a rig).
   * A body with no entry is plain dynamic cargo. Read anywhere; written only by this class.
   */
  readonly holders = new Map<number, BodyHolder>()
  /** cargo parts held by the pilot: part id -> world-space target pose the body chases each step */
  private readonly pilotHeld = new Map<string, { x: number; y: number; z: number; yaw: number }>()

  /** `boxes` and `partGroups` are the world's live cargo list and part groups, read (never written) here; `placeBody`
   *  is how a hold sets a body's pose (CargoRegistry.placeBody) */
  constructor(
    private readonly J: JoltModule,
    private readonly bodyInterface: Jolt.BodyInterface,
    private readonly axisY: Jolt.Vec3,
    private readonly kin: KinematicScratch,
    private readonly boxes: readonly LiveBox[],
    private readonly partGroups: ReadonlyMap<string, PartGroup>,
    private readonly placeBody: PlaceBody,
  ) {}

  /** cargo the walking pilot is carrying: in a person's hands, not on the line. Zones never count or despawn it,
   *  so walking one over a sink does not take it out of their hands. (Beams still see it: a carried box blocks a
   *  photo-eye as it would on a real line.) */
  personHeld(box: LiveBox): boolean {
    return this.holders.get(box.id)?.kind === 'pilot'
  }

  /**
   * Make `holder` the only holder of `box` (see holders) and set the body up for it: a gripper or a pin takes it
   * kinematic, at rest, and sets its pose itself; the pilot keeps it dynamic with gravity off for drive()
   * to steer. Whoever held it before lets go first (letGo), by its own rule.
   */
  claim(box: LiveBox, holder: BodyHolder): void {
    // a unit load is held whole: every piece is the holder's, and the body (the unit's) is set up once
    const pieces = box.unit ? box.unit.members : [box]
    for (const p of pieces) this.letGo(p.id)
    for (const p of pieces) this.holders.set(p.id, holder)
    const J = this.J
    const id = box.body.GetID()
    if (holder.kind === 'pilot') {
      this.bodyInterface.SetGravityFactor(id, 0)
      this.bodyInterface.ActivateBody(id)
      return
    }
    const zero = new J.Vec3(0, 0, 0)
    this.bodyInterface.SetMotionType(id, J.EMotionType_Kinematic, J.EActivation_Activate)
    this.bodyInterface.SetLinearAndAngularVelocity(id, zero, zero)
    J.destroy(zero)
  }

  /** Whoever holds body `boxId` lets go of it, by its own rule: a rig gripper lets go of its whole load
   *  (takeFromGripper), the pilot of its whole part, a pin of just this body. No-op for an unheld body. */
  letGo(boxId: number): void {
    const h = this.holders.get(boxId)
    if (!h) return
    if (h.kind === 'grip' && h.rig) this.takeFromGripper(h.rig, h.gripper)
    else if (h.kind === 'pilot') this.dropPilotPart(h.partId)
    // whatever the rule, this body ends up unheld (a gripper list that had lost track of it included)
    if (this.holders.get(boxId) === h) this.drop(boxId)
  }

  /**
   * Something else claimed a body out of a rig gripper: the pilot lifted it off an AGV's forks, or a drag or a pin
   * took it off a robot's plate. The gripper lets go of its whole load, not just that body. The rest are held at
   * offsets that assumed the taken one was still there, so keeping them kinematic would leave a stack floating
   * over the gap (and wall the taken box in while it's pulled out). Released, they settle under physics and ride
   * the tines/plate on friction from then on. The gripper then latches open (`emptied`) until its behavior opens
   * it - otherwise the next step re-grabs the load where it hangs, before it has fallen at all. The behavior is
   * told only through ctx.measured.grips going false, which is what a real cell's part-present check would see.
   */
  private takeFromGripper(rig: GripRig, gripper: string): void {
    const load = rig.grips.get(gripper) ?? []
    rig.grips.delete(gripper)
    rig.emptied.add(gripper)
    for (const h of load) this.drop(h.bodyId)
  }

  /** a rig leaving the world lets go of everything its grippers hold, so the load falls as dynamic cargo
   *  instead of staying kinematic under a holder that no longer exists */
  releaseRig(rig: GripRig): void {
    const loads = [...rig.grips.values()]
    rig.grips.clear()
    for (const load of loads) for (const h of load) this.drop(h.bodyId)
  }

  /** the pilot lets go of a carried part: every body of it the pilot holds, and its hold target */
  dropPilotPart(partId: string): void {
    this.pilotHeld.delete(partId)
    for (const boxId of [...(this.partGroups.get(partId)?.boxIds ?? [])]) {
      if (this.holders.get(boxId)?.kind === 'pilot') this.drop(boxId)
    }
  }

  /** end body `boxId`'s hold and hand it back to physics as plain dynamic cargo: full gravity, at rest */
  drop(boxId: number): void {
    const h = this.holders.get(boxId)
    if (!h) return
    const box = this.boxes.find((b) => b.id === boxId)
    // a unit load is let go whole, the way it was claimed
    if (box?.unit) {
      for (const p of box.unit.members) if (this.holders.get(p.id) === h) this.holders.delete(p.id)
    } else this.holders.delete(boxId)
    if (!box) return
    const J = this.J
    const id = box.body.GetID()
    const zero = new J.Vec3(0, 0, 0)
    if (h.kind === 'pilot') this.bodyInterface.SetGravityFactor(id, 1)
    else this.bodyInterface.SetMotionType(id, J.EMotionType_Dynamic, J.EActivation_Activate)
    this.bodyInterface.SetLinearAndAngularVelocity(id, zero, zero)
    this.bodyInterface.ActivateBody(id)
    J.destroy(zero)
  }

  /** a body leaving the world leaves its holder too: a gripper just stops carrying that one (no latch -
   *  nothing was taken out of it, the body is gone) */
  forget(boxId: number): void {
    const holder = this.holders.get(boxId)
    if (holder) {
      this.holders.delete(boxId)
      if (holder.kind === 'grip' && holder.rig) {
        const rest = holder.rig.grips.get(holder.gripper)?.filter((h) => h.bodyId !== boxId) ?? []
        if (rest.length) holder.rig.grips.set(holder.gripper, rest)
        else holder.rig.grips.delete(holder.gripper)
      }
    }
  }

  /** set a grabbed body's full kinematic pose (gripper transform) each step; only a body a grip holds */
  setGrabbedPose(bodyId: number, position: [number, number, number], quat: [number, number, number, number]): void {
    if (this.holders.get(bodyId)?.kind !== 'grip') return
    const box = this.boxes.find((b) => b.id === bodyId)
    if (!box) return
    this.kin.pos.Set(position[0], position[1], position[2])
    this.kin.quat.Set(quat[0], quat[1], quat[2], quat[3])
    this.placeBody(box.body.GetID(), this.kin.pos, this.kin.quat)
  }

  /** start (or restart) the pilot's carry of `partId` with its hold target at a pose */
  holdTarget(partId: string, x: number, y: number, z: number): void {
    this.pilotHeld.set(partId, { x, y, z, yaw: 0 })
  }

  /** update where a pilot-held part should chase to (its hold point in front of the camera) */
  setHoldTarget(partId: string, position: [number, number, number], rotationY: number): void {
    const t = this.pilotHeld.get(partId)
    if (!t) return
    t.x = position[0]
    t.y = position[1]
    t.z = position[2]
    t.yaw = rotationY
  }

  /** a part that no longer exists has no hold target */
  forgetPart(partId: string): void {
    this.pilotHeld.delete(partId)
  }

  /**
   * Each step, steer every pilot-held body toward its hold point: linear velocity
   * eases it in (so contacts resolve and it can't pass through a belt/guard), yaw
   * snaps to the look direction with spin and gravity zeroed so it rides level.
   */
  drive(): void {
    if (this.pilotHeld.size === 0) return
    const J = this.J
    for (const [partId, t] of this.pilotHeld) {
      const group = this.partGroups.get(partId)
      if (!group) continue
      for (const boxId of group.boxIds) {
        const box = this.boxes.find((b) => b.id === boxId)
        if (!box) continue
        const id = box.body.GetID()
        const p = box.body.GetPosition()
        let vx = (t.x - p.GetX()) * HOLD_FOLLOW_GAIN
        let vy = (t.y - p.GetY()) * HOLD_FOLLOW_GAIN
        let vz = (t.z - p.GetZ()) * HOLD_FOLLOW_GAIN
        const speed = Math.hypot(vx, vy, vz)
        if (speed > HOLD_MAX_SPEED) {
          const k = HOLD_MAX_SPEED / speed
          vx *= k
          vy *= k
          vz *= k
        }
        const v = new J.Vec3(vx, vy, vz)
        const zero = new J.Vec3(0, 0, 0)
        const rot = J.Quat.prototype.sRotation(this.axisY, t.yaw)
        this.bodyInterface.SetLinearVelocity(id, v)
        this.bodyInterface.SetAngularVelocity(id, zero)
        this.placeBody(id, null, rot)
        J.destroy(v)
        J.destroy(zero)
        J.destroy(rot)
      }
    }
  }
}
