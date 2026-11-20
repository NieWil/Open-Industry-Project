// Custom rig parts in the running world: each rig's link bodies, driven every step to the FK pose of its behavior's
// latest joint commands (FK shared with the renderer via core/rig/rigPose) so the links push cargo where the visual shows
// them, and its grippers, which take hold of cargo through the holds and carry it rigidly. SimWorld builds each rig's
// bodies (rigBuild.ts), hands the instance over here and drives it once per step, after tickBehaviors.
import type Jolt from 'jolt-physics'
import { CARGO_CAP_FORK_POCKETS } from '../core/frame'
import { clamp } from '../core/math'
import { forkEntryProblem } from '../core/pallet'
import { reportPartDiagnostic } from '../core/parts/partDiagnostics'
import { arrayInstanceDeltas, composePartWorldInPlace, jointLimits, parseCopyGripName, posedInstanceInto, linkCollisionBox, POSE_STRIDE, qApply, qConjugate, qFromAxisAngle, qMul, resolvedGrabReach, resolvedGrabZone, rigLinkIndex, rigPoseBuffer, rigWorldPosesInto, shapeHalfExtents } from '../core/rig/rigPose'
import type { Quat, Vec3 } from '../core/rig/rigPose'
import type { BodyHolds } from './bodyHolds'
import type { CargoRegistry } from './cargoRegistry'
import { grabbableBoxesInReach, grabbableBoxesInZone } from './cargoSensing'
import { reportUnknownRigNames } from './rigBuild'
import type { SensorRegistry } from './sensorRegistry'
import { flatRecEq, snapshotRigInputs, subPosesEq } from './worldTypes'
import type { KinematicScratch, LiveBox, RigInstance } from './worldTypes'

/** scratch for one posable array instance's local pose (position + quaternion) */
const INST = new Float64Array(7)

export class RigDriver {
  // Custom rig parts: kinematic collision body per link, driven each step by the behavior's joint output
  // (FK shared with the renderer via core/rig/rigPose) so the links push cargo where the visual shows them.
  // Read anywhere (the frame's film web, bodyStats); added to only through add().
  readonly rigs: RigInstance[] = []

  /**
   * `dt` is the world's step (a kinematic move's dt); `boxes` + `cargo` are the live cargo a gripper searches;
   * `holds` takes and releases what a gripper holds; `sensors` keeps the beams a moving link re-aims;
   * `rigMsByPart` is the world's per-part rig cost table, written when drive() is asked to time.
   */
  constructor(
    private readonly bodyInterface: Jolt.BodyInterface,
    private readonly kin: KinematicScratch,
    private readonly dt: number,
    private readonly boxes: readonly LiveBox[],
    private readonly cargo: CargoRegistry,
    private readonly holds: BodyHolds,
    private readonly sensors: SensorRegistry,
    private readonly rigMsByPart: Map<string, number>,
  ) {}

  /** a rig built for a part: driven from the next step on */
  add(rig: RigInstance): void {
    this.rigs.push(rig)
  }

  // Drive each rig's link bodies to the FK pose for the latest joint commands (after tickBehaviors),
  // then resolve gripper commands so a closed gripper carries cargo. `perfParts` times each rig into rigMsByPart.
  drive(perfParts: boolean): void {
    if (this.rigs.length === 0) return
    const dt = this.dt
    const kinPos = this.kin.pos
    const kinQuat = this.kin.quat
    for (const rig of this.rigs) {
      const tr = perfParts ? performance.now() : 0
      const rec = rig.rec
      const rk = rec.partId ?? '#anon'
      // C-drive: a mobile part (one that called ctx.drive) has a live root pose on its behavior record that has
      // moved off the saved scene pose; compose the rig from it so the kinematic bodies follow as it navigates.
      const rootPos = rec.mobile ? rec.pos : rig.pos
      const rootYaw = rec.mobile ? Math.atan2(-rec.fwd[2], rec.fwd[0]) : rig.rotationY
      // Idle-rig skip: FK + the kinematic moves below are pure functions of (joints, subPoses, grips, root
      // pose). When none changed since the last apply, the rig gets one settle re-apply (its links have
      // arrived, so MoveKinematic computes ~zero velocities), then its bodies are put to sleep and the whole
      // rig is skipped until an input changes. A static platform/stairs rig then takes a value-compare at steady
      // state instead of full FK every step. Exception: a commanded-true gripper that isn't holding yet must
      // stay live, because handleGrips polls for grabbable cargo under it every step.
      const ap = rig.applied
      let clean =
        !!ap && ap.rx === rootPos[0] && ap.ry === rootPos[1] && ap.rz === rootPos[2] && ap.yaw === rootYaw &&
        flatRecEq(rec.joints, ap.joints) && flatRecEq(rec.grips, ap.grips) && subPosesEq(rec.subPoses, ap.subPoses)
      if (clean && rec.grips) {
        for (const g of Object.keys(rec.grips)) {
          if (rec.grips[g] === true && !rig.grips.has(g) && !rig.emptied.has(g)) {
            clean = false
            break
          }
        }
      }
      if (clean && rig.settleSteps === 2) {
        if (perfParts) this.rigMsByPart.set(rk, (this.rigMsByPart.get(rk) ?? 0) + (performance.now() - tr))
        continue
      }
      if (clean && rig.settleSteps === 1) {
        // park: a kinematic body integrates its last velocity forever, so sleep the links to stop any
        // residual epsilon velocity from drifting them while the rig idles (MoveKinematic re-wakes them)
        for (const { id } of rig.bodies) this.bodyInterface.DeactivateBody(id)
        rig.settleSteps = 2
        if (perfParts) this.rigMsByPart.set(rk, (this.rigMsByPart.get(rk) ?? 0) + (performance.now() - tr))
        continue
      }
      rig.settleSteps = clean ? 1 : 0
      if (!clean) rig.applied = snapshotRigInputs(rec, rootPos, rootYaw)
      reportUnknownRigNames(rig)
      // FK straight into a flat per-rig buffer (7 floats/link). A Map form allocates ~500 short-lived
      // objects per rig per step, which on the demo's 60-link robot measured costlier than the maths.
      const need = rig.geo.links.length * POSE_STRIDE
      if (!rig.poseBuf || rig.poseBuf.length !== need) rig.poseBuf = rigPoseBuffer(rig.geo)
      const poses = rig.poseBuf
      rigWorldPosesInto(poses, rig.geo, rig.rec.joints ?? {}, rig.rec.subPoses, rig.scale, rig.params, rig.inclineRad)
      // joint feedback: record the host-applied (clamped-to-limits) joint pose so the behavior reads it
      // next tick via ctx.measured.joints (the closed-loop read half). Mirrors the clamp FK applies
      // (rigPose.rigLocalPose); only joints the script commanded this tick update, the rest hold position.
      if (rig.rec.joints) {
        const measured = (rig.rec.measuredJoints ??= {})
        for (const j of rig.geo.joints) {
          const cmd = rig.rec.joints[j.name]
          if (cmd !== undefined) {
            const [lo, hi] = jointLimits(j, rig.params)
            measured[j.name] = clamp(cmd, lo, hi)
          }
        }
      }
      const partQuat = qFromAxisAngle([0, 1, 0], rootYaw)
      // world pose of every link (incl. transform-only 'frame' links like a gripper anchor, which have no
      // body): handleGrips locates the cargo by the gripper link's world pose, so it must be in the buffer.
      // Limited to bodied links, a frame gripper would be left out and its grab would never fire.
      composePartWorldInPlace(poses, rootPos, partQuat)
      const linkIdx = rigLinkIndex(rig.geo)
      for (const { name, id, offset, instance, rest } of rig.bodies) {
        const li = linkIdx.get(name)
        if (li === undefined) continue
        const o = li * POSE_STRIDE
        const qx = poses[o + 3]!
        const qy = poses[o + 4]!
        const qz = poses[o + 5]!
        const qw = poses[o + 6]!
        if (instance !== undefined) {
          // a posable array instance: its pose this tick (or its rest place) in the link's frame, composed onto the link
          // (rotation and product written out: a row of carriers poses ~100 bodies a step, so no temporaries)
          posedInstanceInto(INST, rig.geo, li, rig.rec.joints ?? {}, rig.rec.subPoses, rig.params, rig.inclineRad, rig.rec.subPoses?.[name]?.instances?.[instance], rest!)
          const vx = INST[0]! * rig.scale, vy = INST[1]! * rig.scale, vz = INST[2]! * rig.scale
          const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx)
          kinPos.Set(poses[o]! + vx + qw * tx + (qy * tz - qz * ty), poses[o + 1]! + vy + qw * ty + (qz * tx - qx * tz), poses[o + 2]! + vz + qw * tz + (qx * ty - qy * tx))
          const bx = INST[3]!, by = INST[4]!, bz = INST[5]!, bw = INST[6]!
          kinQuat.Set(qw * bx + qx * bw + qy * bz - qz * by, qw * by - qx * bz + qy * bw + qz * bx, qw * bz + qx * by - qy * bx + qz * bw, qw * bw - qx * bx - qy * by - qz * bz)
          this.bodyInterface.MoveKinematic(id, kinPos, kinQuat, dt)
          continue
        }
        // `offset` mounts a body at a link-local position instead of the link origin: the running-surface
        // split's slab/housing pair, which share one link but sit at different heights within it. Rotated by
        // the link's world orientation so both ride its pose (and the chain transfer's lift) exactly.
        if (offset) {
          const d = qApply([qx, qy, qz, qw], offset)
          kinPos.Set(poses[o]! + d[0], poses[o + 1]! + d[1], poses[o + 2]! + d[2])
        } else kinPos.Set(poses[o]!, poses[o + 1]!, poses[o + 2]!)
        kinQuat.Set(qx, qy, qz, qw)
        this.bodyInterface.MoveKinematic(id, kinPos, kinQuat, dt)
      }
      this.handleGrips(rig, poses, linkIdx)
      // a beam rides its link: re-aim this part's beams from the pose just applied (a static link re-aims to
      // where it already was, and an idle rig is skipped above, so at rest this does no work)
      const emitters = rec.partId ? this.sensors.beamsOf(rec.partId) : undefined
      if (emitters) {
        for (const e of emitters) {
          const li = linkIdx.get(e.name)
          if (li === undefined) continue
          const o = li * POSE_STRIDE
          e.origin = [poses[o]!, poses[o + 1]!, poses[o + 2]!]
          const d = qApply([poses[o + 3]!, poses[o + 4]!, poses[o + 5]!, poses[o + 6]!], e.axis)
          const len = Math.hypot(d[0], d[1], d[2]) || 1
          e.dir = [d[0] / len, d[1] / len, d[2] / len]
        }
      }
      if (perfParts) this.rigMsByPart.set(rk, (this.rigMsByPart.get(rk) ?? 0) + (performance.now() - tr))
    }
  }

  // where copy `index` of the posable array at link `li` stands in the world, its link standing at `link`; undefined
  // for a copy outside the row (its gripper then does nothing)
  private copyGripPose(rig: RigInstance, li: number, link: { pos: Vec3; quat: Quat }, index: number): { pos: Vec3; quat: Quat } | undefined {
    const l = rig.geo.links[li]!
    if (!l.array?.posable) return undefined
    const rest = arrayInstanceDeltas(l.array, rig.params, undefined, l.showParam)[index]
    if (!rest) return undefined
    posedInstanceInto(INST, rig.geo, li, rig.rec.joints ?? {}, rig.rec.subPoses, rig.params, rig.inclineRad, rig.rec.subPoses?.[l.name]?.instances?.[index], rest)
    const d = qApply(link.quat, [INST[0]! * rig.scale, INST[1]! * rig.scale, INST[2]! * rig.scale])
    return { pos: [link.pos[0] + d[0], link.pos[1] + d[1], link.pos[2] + d[2]], quat: qMul(link.quat, [INST[3]!, INST[4]!, INST[5]!, INST[6]!]) }
  }

  // Resolve a rig's gripper commands: close → grab the nearest cargo to the gripper link and ride it
  // rigidly; held → drive it to follow the gripper; open → release it back to dynamic. A gripper whose load
  // was taken (takeFromGripper) stays open until the command opens it.
  private handleGrips(rig: RigInstance, world: Float64Array, linkIdx: ReadonlyMap<string, number>): void {
    const cmds = rig.rec.grips ?? {}
    const names = new Set<string>([...Object.keys(cmds), ...rig.grips.keys(), ...rig.emptied])
    for (const name of names) {
      const on = cmds[name] === true
      if (!on) rig.emptied.delete(name)
      const held = rig.grips.get(name)
      // materialised per commanded gripper (usually none, at most a handful), not per link, which is why
      // the FK buffer stays flat. A copy of a posable array grips as `link#i`, from where that copy stands.
      const copy = linkIdx.has(name) ? null : parseCopyGripName(name)
      const linkName = copy ? copy.link : name
      const li = linkIdx.get(linkName)
      let gw = li === undefined ? undefined : { pos: [world[li * POSE_STRIDE]!, world[li * POSE_STRIDE + 1]!, world[li * POSE_STRIDE + 2]!] as Vec3, quat: [world[li * POSE_STRIDE + 3]!, world[li * POSE_STRIDE + 4]!, world[li * POSE_STRIDE + 5]!, world[li * POSE_STRIDE + 6]!] as Quat }
      if (copy && gw) gw = this.copyGripPose(rig, li!, gw, copy.index)
      if (on && !held && gw && !rig.emptied.has(name)) {
        const link = rig.geo.links.find((l) => l.name === linkName)
        if (!link) continue
        // C-multigrab: a gripper takes every cargo body in its volume, each with its own captured offset, so a
        // formed layer / a loaded pallet rides rigidly in formation. The count is not a mode; it follows from the
        // tool: a layer plate seals against five cases, a single cup fits over one. So the volume has to be the
        // tool's true volume, which is the link's `grabZone` oriented box (a vacuum plate's footprint by a shallow reach
        // past it).
        //
        // Both forms are authored in the rig's own units and scaled by the part's `scale`, exactly like the
        // geometry they describe. Without that a scaled-up arm would draw a tool one size and pick at another: a
        // scale-1.5 palletizer draws a 1.8 m plate but only seal over 1.2 m of it.
        const zone = resolvedGrabZone(link, rig.params)
        const s = rig.scale
        let picked: LiveBox[]
        if (zone) {
          const half: Vec3 = [zone.half[0] * s, zone.half[1] * s, zone.half[2] * s]
          const centre: Vec3 = [zone.offset[0] * s, zone.offset[1] * s, zone.offset[2] * s]
          picked = grabbableBoxesInZone(this.boxes, this.holds.holders, this.cargo.stepSnapshot(), gw.pos, gw.quat, half, centre)
        } else {
          // No zone: fall back to the grabRadius sphere beyond the link's max half-extent (0.2 m when the rig
          // doesn't say; grabParams grows it with instance params). Still every body it touches, measured to the
          // box surface so a cup that only brushes a case still seals. This is for custom parts authored before
          // zones existed. A shipped gripper should declare one, because a sphere wide enough to span a 1.2 m
          // plate also takes whatever stands beside the tool.
          const he = shapeHalfExtents(link.shape, linkCollisionBox(link))
          picked = grabbableBoxesInReach(this.boxes, this.holds.holders, this.cargo.stepSnapshot(), gw.pos, (Math.max(he[0], he[1], he[2]) + resolvedGrabReach(link, rig.params)) * s)
        }
        // a gripper that closes on any piece of a unit load takes the whole unit, held as the one body it is (by its
        // anchor piece, whose body is the unit's)
        if (picked.length) {
          const seen = new Set<number>()
          picked = picked.map((box) => (box.unit ? box.unit.members[0]! : box)).filter((box) => !seen.has(box.id) && !!seen.add(box.id))
        }
        if (picked.length) {
          const inv = qConjugate(gw.quat)
          const holds: { bodyId: number; offPos: Vec3; offQuat: Quat; reachX: number }[] = []
          for (const box of picked) {
            this.holds.claim(box, { kind: 'grip', rig, gripper: name })
            const bp = box.body.GetPosition()
            const bq = box.body.GetRotation()
            const offPos = qApply(inv, [bp.GetX() - gw.pos[0], bp.GetY() - gw.pos[1], bp.GetZ() - gw.pos[2]])
            const offQuat = qMul(inv, [bq.GetX(), bq.GetY(), bq.GetZ(), bq.GetW()])
            // how far the load reaches from the gripper along its X, either side, in the rig's own units (the world's
            // over its scale): its extent across X plus how far off centre it sits. A clamp's pads close to this. A
            // box's extent is its half extents through the rotation's first row; a unit load's (one body of several
            // pieces) is its world bounds' half size through the gripper's X axis
            let extentX: number
            if (box.unit) {
              const b = box.body.GetWorldSpaceBounds()
              const half: Vec3 = [(b.mMax.GetX() - b.mMin.GetX()) / 2, (b.mMax.GetY() - b.mMin.GetY()) / 2, (b.mMax.GetZ() - b.mMin.GetZ()) / 2]
              const ax = qApply(gw.quat, [1, 0, 0])
              const centre = qApply(inv, [(b.mMax.GetX() + b.mMin.GetX()) / 2 - gw.pos[0], (b.mMax.GetY() + b.mMin.GetY()) / 2 - gw.pos[1], (b.mMax.GetZ() + b.mMin.GetZ()) / 2 - gw.pos[2]])
              extentX = Math.abs(centre[0]) + Math.abs(ax[0]) * half[0] + Math.abs(ax[1]) * half[1] + Math.abs(ax[2]) * half[2]
            } else {
              const [qx, qy, qz, qw] = offQuat
              const r0 = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)]
              extentX = Math.abs(offPos[0]) + Math.abs(r0[0]!) * box.hx + Math.abs(r0[1]!) * box.hy + Math.abs(r0[2]!) * box.hz
            }
            holds.push({ bodyId: box.id, offPos, offQuat, reachX: extentX / rig.scale })
          }
          rig.grips.set(name, holds)
          this.checkForkFit(rig, link, picked, holds)
        }
      } else if (on && held && gw) {
        for (const h of held) {
          const wp = qApply(gw.quat, h.offPos)
          this.holds.setGrabbedPose(h.bodyId, [gw.pos[0] + wp[0], gw.pos[1] + wp[1], gw.pos[2] + wp[2]], qMul(gw.quat, h.offQuat))
        }
      } else if (!on && held) {
        rig.grips.delete(name)
        for (const h of held) this.holds.drop(h.bodyId)
      }
    }
    // grip feedback: record which grippers actually hold cargo now (after grab/release resolved) so the
    // behavior reads it next tick via ctx.measured.grips. `names` = commanded ∪ held ∪ emptied, so a just-released
    // gripper gets an explicit false - the merged feedback never goes stale.
    const heldNow: Record<string, boolean> = {}
    let widths: Record<string, number> | undefined
    for (const name of names) {
      const held = rig.grips.get(name)
      heldNow[name] = held !== undefined
      if (held?.length) (widths ??= {})[name] = held.reduce((w, h) => Math.max(w, h.reachX ?? 0), 0)
    }
    rig.rec.heldGrips = heldNow
    rig.rec.heldWidths = widths
  }

  /**
   * A gripper declared as forks (grip.forks) that has just taken a pallet: did its blades go in through a face whose
   * channels they fit? The pick itself is left alone (the physics already decided where the blades went); this only
   * says so on the part, with the spreads that would fit, because a truck shoving a pallet ahead of its blades looks
   * like a routing problem when it is a fork setting.
   */
  private checkForkFit(rig: RigInstance, link: { grip?: { forks?: { spread?: number; spreadParam?: string; bladeWidth: number; bladeThickness: number } } }, picked: readonly LiveBox[], holds: readonly { offQuat: Quat }[]): void {
    const forks = link.grip?.forks
    if (!forks) return
    const fromParam = forks.spreadParam !== undefined ? rig.params[forks.spreadParam] : undefined
    const spread = typeof fromParam === 'number' && Number.isFinite(fromParam) ? fromParam : forks.spread
    if (spread === undefined) return
    const s = rig.scale
    picked.forEach((box, i) => {
      if ((box.caps & CARGO_CAP_FORK_POCKETS) === 0) return
      // the pallet's length axis in the gripper's frame: along the blades (+X) means they went in through an end,
      // the short face; across them, the long face
      const ax = qApply(holds[i]!.offQuat, [1, 0, 0])
      const face = Math.abs(ax[0]) >= Math.abs(ax[2]) ? 'short' : 'long'
      const problem = forkEntryProblem(box.hx * 2, box.hz * 2, face, { spread: spread * s, bladeWidth: forks.bladeWidth * s, bladeThickness: forks.bladeThickness * s })
      if (problem) reportPartDiagnostic({ source: 'fit', partId: rig.rec.partId ?? '', message: problem })
    })
  }

  /** drop these rigs (their part is rebuilt or deleted; its group tears down the bodies) */
  remove(rigs: readonly RigInstance[]): void {
    const gone = new Set(rigs)
    let n = 0
    for (const r of this.rigs) if (!gone.has(r)) this.rigs[n++] = r
    this.rigs.length = n
  }

  /** drop every rig (their bodies are torn down via their part groups; these are just stale refs) */
  clear(): void {
    this.rigs.length = 0
  }
}
