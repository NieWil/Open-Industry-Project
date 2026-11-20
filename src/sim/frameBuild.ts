// The BoxFrame the worker posts: every live cargo row (pose, size, colour, owner) plus what each part's behavior
// produced this step - joints, lamps, tags, beam hits, speeds, displays, marks, dressings. Reads SimWorld's state only.
import type { BoxFrame, CargoShapeRef, FrameBeamHit, FrameDressing } from '../core/frame'
import type { CargoMarkValue } from '../core/parts/partPackage'
import type { SubPose } from '../core/rig/rigPose'
import { marksOf } from './worldTypes'
import type { BehaviorRecord, LiveBox, UnitLoad } from './worldTypes'

/** the frame for this step; `snap` is the batched pose rows (null = the stock build's getters, read per box here) */
export function buildFrame(
  boxes: readonly LiveBox[],
  snap: Float32Array | null,
  behaviors: readonly BehaviorRecord[],
  units: ReadonlySet<UnitLoad>,
  liveDressings: ReadonlyMap<number, ReadonlyMap<string, FrameDressing>>,
  liveSpeeds: ReadonlyMap<string, number>,
  simTime: number,
  shapeRefs: ReadonlyMap<string, CargoShapeRef> = new Map(),
): BoxFrame {
  const count = boxes.length
  const ids = new Uint32Array(count)
  const positions = new Float32Array(count * 3)
  const quats = new Float32Array(count * 4)
  const halfExtents = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const kinds = new Uint8Array(count)
  const caps = new Uint8Array(count)
  const partIds: (string | null)[] = new Array(count).fill(null) // filled, not holey (see core/geometry/geometryShapes transformDescription)
  for (const [i, box] of boxes.entries()) {
    ids[i] = box.id
    kinds[i] = box.kind
    caps[i] = box.caps
    partIds[i] = box.partId ?? box.ownerId
    colors[i * 3] = box.color[0]
    colors[i * 3 + 1] = box.color[1]
    colors[i * 3 + 2] = box.color[2]
    if (snap) {
      const o = i * 7
      positions[i * 3] = snap[o] as number
      positions[i * 3 + 1] = snap[o + 1] as number
      positions[i * 3 + 2] = snap[o + 2] as number
      quats[i * 4] = snap[o + 3] as number
      quats[i * 4 + 1] = snap[o + 4] as number
      quats[i * 4 + 2] = snap[o + 5] as number
      quats[i * 4 + 3] = snap[o + 6] as number
    } else {
      const p = box.body.GetPosition()
      positions[i * 3] = p.GetX()
      positions[i * 3 + 1] = p.GetY()
      positions[i * 3 + 2] = p.GetZ()
      const q = box.body.GetRotation()
      quats[i * 4] = q.GetX()
      quats[i * 4 + 1] = q.GetY()
      quats[i * 4 + 2] = q.GetZ()
      quats[i * 4 + 3] = q.GetW()
    }
    halfExtents[i * 3] = box.hx
    halfExtents[i * 3 + 1] = box.hy
    halfExtents[i * 3 + 2] = box.hz
  }
  // rig joint + setSubPose commands this step, keyed by part id, for the view to animate rig visuals;
  // plus any PLC tags behaviors wrote (the part→PLC half of the bus), keyed by part id for the controller.
  let joints: Record<string, Record<string, number>> | undefined
  let subPoses: Record<string, Record<string, SubPose>> | undefined
  let copySpeeds: Record<string, Record<string, number[]>> | undefined
  let lamps: Record<string, Record<string, boolean>> | undefined
  let tags: Record<string, Record<string, number | boolean>> | undefined
  // C-drive: the live root pose of any part that has driven its base (ctx.drive), keyed by part id, so the
  // view can move the part visual's root (the saved scene pose stays put - only the running pose moves).
  let basePoses: Record<string, { pos: [number, number, number]; yaw: number }> | undefined
  // C-convey visual follow: the effective (tag-gated / tag-commanded) speed each conveying behavior drove
  // this step (the same value tickBehaviors recorded for the spawner interlock: linear m/s; arc omega
  // rad/s), so the view scrolls the belt fabric / spins the rollers at the speed the PLC actually set.
  let conveyorSpeeds: Record<string, number> | undefined
  // C-sensing: each behavior's beam results this step (castBeam, the ctx.sense input), keyed by part id,
  // so the view draws beam lines from the sim's own answer instead of re-casting on the main thread.
  let beamHits: Record<string, Record<string, FrameBeamHit>> | undefined
  // each body's own shape (core/cargoBody.ts), when any body has one, and what every shape of the run is
  let shapes: (string | null)[] | undefined
  for (const [i, box] of boxes.entries()) {
    if (box.shapeKey === undefined) continue
    shapes ??= new Array<string | null>(count).fill(null)
    shapes[i] = box.shapeKey
  }
  const refs = shapes && shapeRefs.size > 0 ? Object.fromEntries(shapeRefs) : undefined
  // live product state on each authored product (the Inspector's readout of its attributes)
  let marks: Record<string, Record<string, CargoMarkValue>> | undefined
  for (const box of boxes) {
    if (!box.partId) continue
    const m = marksOf(box)
    if (m && Object.keys(m).length) (marks ??= {})[box.partId] = m
  }
  // ...and each authored unit load, whose own attributes are its unit's marks
  for (const u of units) if (u.partId && Object.keys(u.marks).length) (marks ??= {})[u.partId] = { ...u.marks }
  // dressings on loads, each riding its anchor (removeBox drops a dressing with its anchor)
  let dressings: FrameDressing[] | undefined
  if (liveDressings.size > 0) {
    dressings = []
    for (const m of liveDressings.values()) for (const d of m.values()) dressings.push(d)
  }
  // C-report: each behavior's effective param values this step (ctx.report), keyed by part id - the
  // Inspector's live readout source. Measured from the behavior's own output, never re-derived.
  let values: Record<string, Record<string, number | boolean>> | undefined
  // C-display: each behavior's named display values this step (ctx.display), keyed by part id - what the
  // view paints on that part's screens/labels. Same measured-not-re-derived rule as `values`: the number
  // on the panel is the one the step computed, not a host-side re-read of the tag it came from.
  let displays: Record<string, Record<string, number | boolean | string>> | undefined
  for (const b of behaviors) {
    if (!b.partId) continue
    if (b.joints && Object.keys(b.joints).length > 0) (joints ??= {})[b.partId] = b.joints
    if (b.subPoses && Object.keys(b.subPoses).length > 0) (subPoses ??= {})[b.partId] = b.subPoses
    if (b.copySpeeds) (copySpeeds ??= {})[b.partId] = b.copySpeeds
    if (b.lamps && Object.keys(b.lamps).length > 0) (lamps ??= {})[b.partId] = b.lamps
    if (b.values && Object.keys(b.values).length > 0) (values ??= {})[b.partId] = b.values
    if (b.displays && Object.keys(b.displays).length > 0) (displays ??= {})[b.partId] = b.displays
    if (b.tags && Object.keys(b.tags).length > 0) (tags ??= {})[b.partId] = b.tags
    if (b.beamHits && Object.keys(b.beamHits).length > 0) (beamHits ??= {})[b.partId] = b.beamHits
    if (b.mobile) (basePoses ??= {})[b.partId] = { pos: b.pos, yaw: Math.atan2(-b.fwd[2], b.fwd[0]) }
    if (b.entry || b.conveyorEntries) {
      const v = liveSpeeds.get(b.partId)
      if (v !== undefined) (conveyorSpeeds ??= {})[b.partId] = v
    }
  }
  return { count, ids, positions, quats, halfExtents, colors, kinds, caps, partIds, simTime, ...(joints ? { joints } : {}), ...(subPoses ? { subPoses } : {}), ...(copySpeeds ? { copySpeeds } : {}), ...(lamps ? { lamps } : {}), ...(values ? { values } : {}), ...(displays ? { displays } : {}), ...(tags ? { tags } : {}), ...(basePoses ? { basePoses } : {}), ...(conveyorSpeeds ? { conveyorSpeeds } : {}), ...(beamHits ? { beamHits } : {}), ...(dressings ? { dressings } : {}), ...(marks ? { marks } : {}), ...(shapes ? { shapes } : {}), ...(refs ? { shapeRefs: refs } : {}) }
}
