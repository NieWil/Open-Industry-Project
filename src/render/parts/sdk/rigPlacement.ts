// Link placement for a rig (buildRig in rig.ts): every link group's pose, written back from core's rig FK, and the
// per-frame paths that re-pose only the links a joint or a sub-pose moves.

import { Group } from 'three'
import { POSE_STRIDE, posedInstanceInto, rigLinkLocalPoseInto, rigPoseBuffer, rigWorldPosesInto } from '../../../core/rig/rigPose'
import type { InstancePose, RigParams, SubPose } from '../../../core/rig/rigPose'
import { rigInclineRad } from '../../../core/parts/partGeometry'
import type { PartPackage, RigLink } from '../../../core/parts/partPackage'
import { bumpStructureVersion } from '../structureRev'

/** What placement needs from the rig it poses. */
export interface RigPlacementDeps {
  geo: Extract<PartPackage['geometry'], { kind: 'rig' }>
  root: Group
  linkGroups: ReadonlyMap<string, Group>
  /** the links by name; a rest-pose edit replaces entries in it */
  linkByName: Map<string, RigLink>
  hasLinkBanks: boolean
  /** re-place the link banks after their members moved outside a refresh */
  replaceLinkBanks: () => void
  bumpPoseRev: () => void
}

export interface RigPlacement {
  /** re-pose every link with these params (a refresh); the joint and sub-pose paths reuse them */
  place(params: RigParams): void
  applyJoints(values: Record<string, number>): void
  applyRestPose(g2: Extract<PartPackage['geometry'], { kind: 'rig' }>): void
  applySubPoses(subPoses: Record<string, SubPose>): void
  /** Stop: forget the run's joint values and setSubPose overrides and lay every link at rest */
  resetRunPose(): void
  /** a posable array instance's place in its link's frame (core posedInstanceInto), with the pose state last placed */
  instancePoseInto(out: Float64Array, link: string, pose: InstancePose | null | undefined, rest: readonly number[]): void
}

export function createRigPlacement(deps: RigPlacementDeps): RigPlacement {
  const { geo, root, linkGroups, linkByName, hasLinkBanks, replaceLinkBanks, bumpPoseRev } = deps
  let lastParams: RigParams = {} // the params the last refresh placed with
  // ---- link placement: one resolver --------------------------------------------------------------------------
  // Every link group's pose comes from core's rig FK (rigWorldPosesInto) - the function the sim builds its bodies
  // from - run on the current geometry with the current joints, sub-poses, params and whole-bed incline, and
  // written back as each group's local transform (its parent's world pose inverted, times its own). Every layer
  // is in that one call: the authored rest pose, a param-driven offset (C-paramgeo), a joint, a setSubPose
  // override, an aim constraint (C-aim), the incline (legs excepted, as in core).
  //
  // Never re-derive a layer here from a copy of the rest pose taken at build time: an author edit to a node
  // would change the data while the next refresh puts the node back, and the visual could drift from the
  // sim's colliders. A new pose, from any source, is one call.
  const aimLinks = geo.links.filter((l) => l.aim)
  let poseGeo: Extract<PartPackage['geometry'], { kind: 'rig' }> = geo // what the groups are posed from
  let poseBuf = rigPoseBuffer(geo)
  // parent index per link (by position in links); structure is fixed for this build - applyRestPose only swaps poses
  const poseParent = Int32Array.from(geo.links.map((l) => (l.parent ? geo.links.findIndex((x) => x.name === l.parent) : -1)))
  let lastJoints: Record<string, number> = {} // the last-applied joint values (a refresh re-places with them)
  let lastSubPoses: Record<string, SubPose> = {} // every setSubPose override seen; a link keeps its last one
  let lastIncline = 0 // the whole-bed incline the last placeLinks resolved (params change only through a refresh)
  const placeLinks = (): void => {
    lastIncline = rigInclineRad(poseGeo, lastParams)
    rigWorldPosesInto(poseBuf, poseGeo, lastJoints, lastSubPoses, 1, lastParams, lastIncline)
    const b = poseBuf
    const links = poseGeo.links
    for (let i = 0; i < links.length; i++) {
      const grp = linkGroups.get(links[i]!.name)
      if (!grp) continue
      const o = i * POSE_STRIDE
      const pi = poseParent[i]!
      if (pi < 0) {
        grp.position.set(b[o]!, b[o + 1]!, b[o + 2]!)
        grp.quaternion.set(b[o + 3]!, b[o + 4]!, b[o + 5]!, b[o + 6]!)
        continue
      }
      // local = parent^-1 * world: rotate (world pos - parent pos) by the parent's conjugate, and conj(parent) * q
      const po = pi * POSE_STRIDE
      const cx = -b[po + 3]!, cy = -b[po + 4]!, cz = -b[po + 5]!, cw = b[po + 6]!
      const dx = b[o]! - b[po]!, dy = b[o + 1]! - b[po + 1]!, dz = b[o + 2]! - b[po + 2]!
      const tx = 2 * (cy * dz - cz * dy), ty = 2 * (cz * dx - cx * dz), tz = 2 * (cx * dy - cy * dx)
      grp.position.set(dx + cw * tx + (cy * tz - cz * ty), dy + cw * ty + (cz * tx - cx * tz), dz + cw * tz + (cx * ty - cy * tx))
      const qx = b[o + 3]!, qy = b[o + 4]!, qz = b[o + 5]!, qw = b[o + 6]!
      grp.quaternion.set(cw * qx + cx * qw + cy * qz - cz * qy, cw * qy + cy * qw + cz * qx - cx * qz, cw * qz + cz * qw + cx * qy - cy * qx, cw * qw - cx * qx - cy * qy - cz * qz)
    }
  }
  placeLinks() // the rest pose, with aim links connected, in case the rig is never driven (no gizmo/idle pose)

  // The per-frame paths (a joint tick, a sub-pose) can only change the local transform of the links they name, and
  // the scene graph carries every child along. So they re-pose just those, by core's own per-link rule
  // (rigLinkLocalPoseInto, the same math the full composition uses) on the current geometry. Placing all 57 links
  // of a one-joint turntable every frame costs ~60x what the joint itself does. A rig with aim links composes the
  // whole tree instead, since an aimed strut's rotation hangs on another link's world position.
  const localScratch = new Float64Array(POSE_STRIDE)
  const linkIndex = new Map(geo.links.map((l, i) => [l.name, i]))
  const jointedIdx = geo.joints.map((j) => linkIndex.get(j.link)).filter((i): i is number => i !== undefined)
  const placeOnly = (indices: Iterable<number>): void => {
    if (aimLinks.length > 0) {
      placeLinks()
      return
    }
    for (const i of indices) {
      const grp = linkGroups.get(poseGeo.links[i]!.name)
      if (!grp) continue
      const b = rigLinkLocalPoseInto(localScratch, poseGeo, i, lastJoints, lastSubPoses, lastParams, lastIncline)
      grp.position.set(b[0]!, b[1]!, b[2]!)
      grp.quaternion.set(b[3]!, b[4]!, b[5]!, b[6]!)
    }
  }

  const applyJoints = (values: Record<string, number>): void => {
    // command every declared joint each call; an un-commanded joint returns to rest (position control).
    lastJoints = values
    // a rig with nothing a joint value can move: nothing to place (and no pose bump)
    if (geo.joints.length === 0 && aimLinks.length === 0) return
    placeOnly(jointedIdx)
    // repeat-value spam is gated upstream (the view's frame routing); a call that reached here moved links
    bumpPoseRev()
  }

  // An author edit moved a link's rest pose (a node drag, an Inspector field, an undo) without changing the rig's
  // structure, so the groups are re-posed in place rather than rebuilt: the edited geometry becomes the one
  // placeLinks resolves from, and the refresh that follows in `apply` lays it out with the params.
  const applyRestPose = (g2: Extract<PartPackage['geometry'], { kind: 'rig' }>): void => {
    poseGeo = g2
    if (poseBuf.length < g2.links.length * POSE_STRIDE) poseBuf = rigPoseBuffer(g2)
    for (const link of g2.links) linkByName.set(link.name, link)
    placeLinks()
    replaceLinkBanks()
  }

  // Runtime backstop to the static setSubPose read (poolableLink): a link this actually moves must not
  // be pooled, whatever the source scan concluded. The scan is a whole-string-literal match - the same
  // best-effort convention as the rename cascade - so an obfuscated/computed name can slip it; here the
  // move is a fact. Untag the subtree, hand back anything the pool had hidden (so the moving link draws
  // live from this tick), and bump structureVersion, which is the async-attach signal the view already
  // re-pools on. Once per link: after the first move nothing is left tagged.
  const unpooled = new Set<string>()
  const unpoolSubtree = (name: string, g: Group): void => {
    if (unpooled.has(name)) return
    unpooled.add(name)
    let found = false
    // the group tag is what keeps the link's instanced banks out (they need no opt-in to be ingested,
    // so untagging poolUnit alone would leave them merged - and frozen); the pool prunes the subtree
    g.userData.poolMobile = true
    g.traverse((o) => {
      if (o.userData.poolUnit === true) delete o.userData.poolUnit
      else if (o.userData.poolHidden !== true) return
      if (o.userData.poolHidden === true) {
        delete o.userData.poolHidden
        o.visible = true
      }
      found = true
    })
    if (found) bumpStructureVersion(root)
  }

  const applySubPoses = (subPoses: Record<string, SubPose>): void => {
    // free-form pose overrides: a subPose overrides the link's rest + joint pose (core's rule); one placeLinks
    let moved = false
    for (const name in subPoses) {
      const g = linkGroups.get(name)
      if (!g || !linkByName.has(name)) continue
      unpoolSubtree(name, g)
      moved = true
    }
    if (!moved) return
    lastSubPoses = { ...lastSubPoses, ...subPoses }
    placeOnly(Object.keys(subPoses).map((n) => linkIndex.get(n)).filter((i): i is number => i !== undefined))
    if (hasLinkBanks) replaceLinkBanks()
    bumpPoseRev()
  }

  // A link keeps its last subPose (lastSubPoses), and applyJoints({}) only clears joints, so a part moved by
  // setSubPose alone (a sorter's shoes) stayed where the run left it after Stop.
  const resetRunPose = (): void => {
    lastJoints = {}
    lastSubPoses = {}
    placeLinks()
    if (hasLinkBanks) replaceLinkBanks()
    bumpPoseRev()
  }

  return {
    place: (params) => {
      lastParams = params
      placeLinks()
    },
    applyJoints,
    applyRestPose,
    applySubPoses,
    resetRunPose,
    instancePoseInto: (out, link, pose, rest) => {
      const i = linkIndex.get(link)
      if (i === undefined) return
      posedInstanceInto(out, poseGeo, i, lastJoints, lastSubPoses, lastParams, lastIncline, pose, rest)
    },
  }
}
