// Rig parts, the build side: which links get collision bodies and where (buildRigBodies), the link-pose helpers,
// and the unknown-name diagnostics. SimWorld hands in its own body constructors as a RigBodySink.
import type Jolt from 'jolt-physics'
import { guardColliderCrossSection } from '../core/geometry/collisionShapes'
import type { ConveyorEntry } from '../core/geometry/collisionShapes'
import { geometryLampNames, resolvePartParams } from '../core/geometry/geometryEval'
import type { ParamValue } from '../core/parts/partApi'
import { reportPartDiagnostic } from '../core/parts/partDiagnostics'
import { rigLampNames } from '../core/parts/partPackage'
import type { PartPackage } from '../core/parts/partPackage'
import { keptSegments, rigFrameSide, rigGuardSide } from '../core/guards/guardOpenings'
import type { GuardOpenings } from '../core/guards/guardOpenings'
import type { GuardExtents } from '../core/guards/guardExtents'
import type { GuardRun } from '../core/guards/guardRuns'
import { rigLinkEmitsBody } from '../core/rig/rigGuards'
import { arrayInstanceDeltas, linkHalfExtents, parseCopyGripName, qApply, qFromAxisAngle, qMul, rigWorldPoses } from '../core/rig/rigPose'
import type { LinkPose, Quat, RigParams, Vec3 } from '../core/rig/rigPose'
import { GROUND_FRICTION } from './bodyFactory'
import type { BehaviorRecord, RigBody } from './worldTypes'

/** how buildRigBodies makes the bodies it decides on: SimWorld's own constructors, which file each body under the
 *  part being built */
export interface RigBodySink {
  kinematicBoxQuat(hx: number, hy: number, hz: number, pos: Vec3, quat: Quat, friction: number): Jolt.Body
  staticBox(hx: number, hy: number, hz: number, x: number, y: number, z: number, rotationY: number, friction: number): Jolt.Body
  registerConveyor(body: Jolt.Body, entries: ConveyorEntry[]): void
}

/** cached valid-name sets per rig geometry, for the unknown-name diagnostics (reportUnknownRigNames) */
const rigNameSets = new WeakMap<object, { joints: Set<string>; links: Set<string>; lamps: Set<string> }>()

// True if a rig link is moved by a joint: the link itself, or any ancestor via `parent`, is a joint's driven
// link. A conveying deck under such a link (the chain transfer's `lift`) must track the joint, not sit static.
export function linkDrivenByJoint(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, linkName: string): boolean {
  const jointLinks = new Set(geo.joints.map((j) => j.link))
  const parentOf = new Map(geo.links.map((l) => [l.name, l.parent]))
  const seen = new Set<string>()
  let name: string | undefined = linkName
  while (name && !seen.has(name)) {
    seen.add(name)
    if (jointLinks.has(name)) return true
    name = parentOf.get(name)
  }
  return false
}

// True if a rig link moves while the sim runs: it, or an ancestor via `parent`, is a joint's driven link or is
// posed by the behavior's setSubPose (`subPosed`, the static scan of its script: a computed name counts every link).
// A conveying deck that moves must be a kinematic body that follows it, not a static one left at rest.
export function linkMovesAtRuntime(geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, linkName: string, subPosed: { names: Set<string>; unresolved: boolean }): boolean {
  if (linkDrivenByJoint(geo, linkName)) return true
  if (subPosed.unresolved) return true
  const parentOf = new Map(geo.links.map((l) => [l.name, l.parent]))
  const seen = new Set<string>()
  for (let name: string | undefined = linkName; name && !seen.has(name); name = parentOf.get(name)) {
    seen.add(name)
    if (subPosed.names.has(name)) return true
  }
  return false
}

// Compose a link's part-local pose with the part's world pose (position + yaw) into a world pose.
export function composeRigLink(partPos: readonly [number, number, number], partQuat: Quat, lp: LinkPose): { pos: Vec3; quat: Quat } {
  const wp = qApply(partQuat, lp.pos)
  return { pos: [partPos[0] + wp[0], partPos[1] + wp[1], partPos[2] + wp[2]], quat: qMul(partQuat, lp.quat) }
}

// One kinematic box (LAYER_MOVING) per link at its rest world pose; driven each step by RigDriver.drive.
// `params` resolves C-paramgeo box sizes (a width/length param reshaping a link) so the collision body is
// built at the same size the visual draws.
export function buildRigBodies(sink: RigBodySink, geo: Extract<PartPackage['geometry'], { kind: 'rig' }>, pos: [number, number, number], rotationY: number, scale = 1, params: RigParams = {}, paramSpecs?: PartPackage['params'], inclineRad = 0, openings?: GuardOpenings, extents?: GuardExtents, guardRun?: GuardRun): RigBody[] {
  const partQuat = qFromAxisAngle([0, 1, 0], rotationY)
  // inclineRad tilts every non-leg link's world pose (pos + quat) about the rig root - so a conveyor's
  // wall/guard kinematic bodies ride the grade automatically (they're built from the link quat below).
  const rest = rigWorldPoses(geo, {}, undefined, scale, params, inclineRad)
  const linkByName = new Map(geo.links.map((l) => [l.name, l]))
  // a conveying rig's 'frame' links join the conveyor ghost gates (see GHOST_* notes + the loop below)
  const rigConveys = geo.links.some((l) => l.conveys === true)
  // resolve params (with defaults) only for the showParam gate: a default-true guard toggle must keep its
  // body when the instance leaves the param unset. Sizing below stays on the raw params.
  const resolved = paramSpecs ? resolvePartParams(paramSpecs, params as Record<string, ParamValue>) : params
  const out: RigBody[] = []
  for (const [name, lp] of rest) {
    const link = linkByName.get(name)
    if (!link) continue
    // Which links get a body: one shared rule (core/rig/rigGuards.ts rigLinkEmitsBody). Transform-only 'frame'
    // pivots, render-only shapes (label/roller/leg/chain/cone), noCollision primitives, a showParam switched
    // off, a mesh link with no collision box, and `conveys` decks (built as static conveyor bodies by
    // attachRigConveyors instead) all get none. Shared because guardRuns.ts must agree exactly on the set of
    // guard walls a rig contributes: a wall the resolver counts but this loop never emits forms a run that
    // suppresses the real guard on the other side of the seam.
    if (!rigLinkEmitsBody(link, resolved as Record<string, unknown>)) continue
    const heRaw = linkHalfExtents(link, params)
    const worldRaw = composeRigLink(pos, partQuat, lp)
    // Guard collider normalization (core/geometry/collisionShapes.ts): a rig guard link carries the 0.005 sheet-metal
    // visual thickness, where belts/curves build theirs at GUARD_COLLISION_THICKNESS. Thicken the collider
    // outward from its inner face, visual untouched (this reshapes the body, not the link), so every
    // family presents one cross-section and guardRuns can merge a roller against a belt. Grown along the
    // guard's own local Z, away from the bed (the side its offset already encodes).
    const gSideForZ = rigGuardSide(link)
    const gx = gSideForZ ? guardColliderCrossSection(heRaw[2]) : null
    const he: Vec3 = gx ? [heRaw[0], heRaw[1], gx.hz] : heRaw
    // The grow direction is link-local +Z/−Z (the side the link's own offset encodes), carried as a
    // link-local `offset` rather than baked into the spawn pose. A body pushed to `out` is re-posed to its
    // FK link origin by RigDriver.drive every step, which would silently undo a spawn-time shift and leave the
    // collider thickened but centred, narrowing every bed by the growth. `offset` is the field that
    // survives the FK drive (it is what the running-surface slab/housing pair uses). The split-guard path
    // below is exempt: those segments are never pushed to `out`, so they keep their pose.
    const guardOffset: Vec3 | undefined = gx && gx.outwardShift > 0 ? [0, 0, (gSideForZ === 'left' ? -1 : 1) * gx.outwardShift] : undefined
    const world = guardOffset
      ? (() => {
          const dz = qApply(worldRaw.quat, guardOffset)
          return { pos: [worldRaw.pos[0] + dz[0], worldRaw.pos[1] + dz[1], worldRaw.pos[2] + dz[2]] as Vec3, quat: worldRaw.quat }
        })()
      : worldRaw
    // a remapped side guard/rail (sideGuard/sideRail on a straight roller/face-handle conveyor):
    // a butting neighbour cut a gap into the guard wall (host-computed openings), and/or the part's own
    // snap extents remap an end span (a flush side-merge retracts the mover's rails to the host's outer
    // wall plane: guardExtents; the host frame itself never opens). Build one body per
    // kept segment of the link span instead of the single full-length wall: the collision twin of the
    // render mesh split. Laid along the link's local +X from its centre; not pushed to `out`, so
    // RigDriver.drive never re-poses it (these don't move, and their incline is already baked into `world`).
    // classified unconditionally: a merged guard run overrides this side's spans even when the part has no
    // openings/extents of its own (two pristine beds butted end-to-end is the common case).
    const guardSide = rigGuardSide(link)
    // the link's own surface (RigLink.friction: a slide plate, a rubber pad), else the plain solid default
    const friction = link.friction ?? GROUND_FRICTION
    const guardOverride = guardSide ? guardRun?.walls[`rig:${link.name}`] : undefined
    const frameSide = !guardSide && extents ? rigFrameSide(link) : null
    const cutSide = guardSide ?? frameSide
    if (cutSide) {
      const backX = (cutSide === 'left' ? extents?.leftBack : extents?.rightBack) ?? -he[0]
      const frontX = (cutSide === 'left' ? extents?.leftFront : extents?.rightFront) ?? he[0]
      const open = guardSide ? ((guardSide === 'left' ? openings?.left : openings?.right) ?? []) : []
      // A guard merged into a collinear run (guardRuns.ts) takes its spans from the run, not from its own
      // bed: the run's owner carries the union of every member's spans (so its box reaches past its own bed
      // ends and the butt seam disappears), and every other member gets an empty list (no body), because the
      // owner's single box already covers it. Two separate bodies meeting at the seam is exactly what rams
      // cargo riding the wall (enhanced internal edge removal does not span separate bodies).
      const segments = guardOverride ?? (open.length > 0 || backX !== -he[0] || frontX !== he[0] ? keptSegments(backX, frontX, open) : null)
      if (segments) {
        for (const [lo, hi] of segments) {
          const d = qApply(world.quat, [(lo + hi) / 2, 0, 0])
          // guard segments keep friction 0 (cargo slides along them); frame segments keep the link's friction and
          // the ghost-gate admission the unsplit rail gets below (flush top edge must never snag cargo)
          const body = sink.kinematicBoxQuat((hi - lo) / 2, he[1], he[2], [world.pos[0] + d[0], world.pos[1] + d[1], world.pos[2] + d[2]], world.quat, guardSide ? 0 : friction)
          if (frameSide && rigConveys && link.bed) sink.registerConveyor(body, [])
        }
        continue
      }
    }
    if (link.array?.posable) {
      // a posable array: one kinematic body per instance, each carrying its index and rest place so
      // RigDriver.drive poses it from the behavior's setSubPose(link, pose, i) inside the link's frame
      arrayInstanceDeltas(link.array, params, undefined, link.showParam).forEach((delta, i) => {
        const d = qApply(world.quat, delta)
        const body = sink.kinematicBoxQuat(he[0], he[1], he[2], [world.pos[0] + d[0], world.pos[1] + d[1], world.pos[2] + d[2]], world.quat, friction)
        out.push({ name, body, id: body.GetID(), instance: i, rest: delta })
      })
      continue
    }
    if (link.array) {
    // array-links: N static instance bodies (legs/posts/rollers don't move), not added to `out` so the
    // FK-driver doesn't collapse the N copies (keyed by one link name) onto a single pose.
      // world-phase array-links (e.g. roller beds) need the part placement so copies land on the shared
      // world pitch grid; the centred default ignores the seam (docs/seam-resolvers.md).
      const seam = { worldPos: pos, worldRotY: rotationY }
      for (const delta of arrayInstanceDeltas(link.array, params, seam, link.showParam)) {
        const d = qApply(world.quat, delta) // instance offset (container-local) → world
        sink.staticBox(he[0], he[1], he[2], world.pos[0] + d[0], world.pos[1] + d[1], world.pos[2] + d[2], rotationY, friction)
      }
      continue
    }
    // a guard is friction 0 (same as the function-belt guards in
    // addScriptedBeltGuards): cargo squared against it by skew/merges must slide along, not wedge-stop.
    const body = sink.kinematicBoxQuat(he[0], he[1], he[2], world.pos, world.quat, link.sideGuard ? 0 : friction)
    // a conveying rig's frame rail (top at/under the deck plane): admit it to the conveyor ghost gates
    // with an empty entry list (plain collision, no surface velocity), so cargo sliding sideways off the
    // bed (a diverter kick onto a perpendicular takeaway) can't snag/pop on the rail's flush top edge.
    // Guards are not admitted: a guard must stop cargo (junction crossings open it for real).
    if (rigConveys && link.bed) {
      sink.registerConveyor(body, [])
    }
    out.push(guardOffset ? { name, body, id: body.GetID(), offset: guardOffset } : { name, body, id: body.GetID() })
  }
  return out
}

// A behavior commanding a rig name that doesn't exist (ctx.setJoint('sholder'), a lamp on a
// non-emissive link, a subPose on a missing link) is a silent no-op in the sim (the SDK contract),
// but the author gets a deduped 'unknown-name' diagnostic (one entry
// per name, count bumped per tick). Valid-name sets are cached per rig geometry (WeakMap - geometry
// objects are replaced wholesale on a package edit, so entries age out with them).
export function reportUnknownRigNames(rig: { rec: BehaviorRecord; geo: Extract<PartPackage['geometry'], { kind: 'rig' }>; pkg: PartPackage }): void {
  const rec = rig.rec
  if (!rec.partId) return
  let names = rigNameSets.get(rig.geo)
  if (!names) {
    names = {
      joints: new Set(rig.geo.joints.map((j) => j.name)),
      links: new Set(rig.geo.links.map((l) => l.name)),
      // + the lamps the part's geometry() draws (MeshPart.lamps): a code-built lamp is a real lamp
      lamps: rigLampNames(rig.geo, geometryLampNames(rig.pkg.behavior ?? '', rig.pkg.params)),
    }
    rigNameSets.set(rig.geo, names)
  }
  const partId = rec.partId
  for (const j of Object.keys(rec.joints ?? {})) {
    if (!names.joints.has(j)) reportPartDiagnostic({ source: 'unknown-name', partId, message: `commanded joint "${j}" is not a rig joint (setJoint/ctx.joints is a no-op)` })
  }
  for (const l of Object.keys(rec.lamps ?? {})) {
    if (!names.lamps.has(l)) reportPartDiagnostic({ source: 'unknown-name', partId, message: `commanded lamp "${l}" is not a rig lamp - an entry of a link's \`lamps\` (named, or taking the link's name), or a drawn submesh's \`lamp\` (setEmissive/ctx.lamps is a no-op)` })
  }
  for (const s of Object.keys(rec.subPoses ?? {})) {
    if (!names.links.has(s)) reportPartDiagnostic({ source: 'unknown-name', partId, message: `setSubPose link "${s}" is not a rig link (the pose is a no-op)` })
  }
  for (const g of Object.keys(rec.grips ?? {})) {
    if (!names.links.has(parseCopyGripName(g)?.link ?? g)) reportPartDiagnostic({ source: 'unknown-name', partId, message: `commanded gripper "${g}" is not a rig link (setGrip/ctx.grips is a no-op)` })
  }
}
