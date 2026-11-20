import { Group } from 'three'
import { getPackage } from '../../core/parts/partRegistry'
import type { RollerGrid } from '../../core/conveyor/rollerGrid'
import type { GuardOpenings } from '../../core/guards/guardOpenings'
import type { GuardExtents } from '../../core/guards/guardExtents'
import type { LegRestRows } from '../../core/legRests'
import type { GuardHoles } from '../../core/guards/guardHoles'
import type { StructureConnections } from '../../core/structureConnections'
import { applyStairLift } from '../../core/structureCuts'
import { linkFinishKey, resolveLinkFinishes } from '../../core/rig/rigFinish'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart, PartInstance } from '../../core/types'
import type { ResolvedContext } from '../../core/scene/sceneResolve'
import { applyPartRotation, setSelectedMaterials } from './common'
import { bumpStructureVersion } from './structureRev'
import { bumpPoseRev } from './poseRev'
import type { PartVisual } from './registry'
import type { Content } from './sdk/types'
import { buildDeck } from './sdk/deck'
import { buildCargo } from './sdk/cargo'
import { buildFunctionMesh } from './sdk/functionMesh'
import { buildRig } from './sdk/rig'

// Imported custom-part visual. Two geometry kinds (see core/parts/partPackage):
//  - 'deck': a textured powered slab (the conveyor primitive) with a discharge-end accent bar.
//  - 'rig':  a multi-body kinematic tree (robots/AGVs/gates) - a Group per link, parented per link.parent,
//            at its rest offset/rotation. The behavior's per-tick joint output (ctx.setJoint → the step
//            result's `joints`) is applied via group.userData.applyJoints, which the running frame loop
//            calls; idle, the rig sits at its rest pose.
// Geometry resolves from the package registry (getPackage), so a package edited on disk reflows on update.
// The per-kind geometry builders live under ./sdk/ (types/shared/deck/cargo/mesh/functionMesh/
// materials/rigGizmo/rig - a mechanical split of this module); this file keeps the factory and
// re-exports the public surface consumed elsewhere.

export { customMeshesSettled } from './sdk/materials'
export { rigRollerSpinRadius } from './sdk/rig'

// ---- factory -------------------------------------------------------------

// A package's geometry "signature": deck reflows in place (rescale, never rebuild), so its signature is
// constant. A rig must rebuild its tree whenever its structure changes (links/shapes/roles/params/joints).
// A link's rest pose (offset + rest rotation) is excluded: it reflows in place via the rig Content's
// applyRestPose. So an author-mode node drag streaming a new offset every pointer-move (or an undo/param
// nudge) repositions the existing groups instead of tearing down + rebuilding the whole rig tree
// (re-cloning GLB meshes, re-creating materials + gizmo) each frame. A true structural edit (resizing
// a box, adding a link, changing a shape) produces a new signature and rebuilds.
function geomSignature(pkg: PartPackage | undefined): string {
  const g = pkg?.geometry
  if (g?.kind === 'rig') {
    const struct = g.links.map((l) => {
      const rest: Record<string, unknown> = { ...l }
      delete rest.offset
      delete rest.rotation
      delete rest.quat
      return rest
    })
    return `rig:${JSON.stringify(struct)}:${JSON.stringify(g.joints)}`
  }
  // drawn geometry reflows in place per param change; only a behavior-source edit (a hot-reloaded geometry()
  // body) must rebuild the Content, so the source is part of the signature.
  if (g?.kind === 'drawn') return `function:${g.conveys ? 'c' : ''}:${g.material ?? ''}:${pkg!.behavior}`
  // cargo reflows in place per param change (box scale + tint); only the kind flips the mesh geometry
  if (g?.kind === 'cargo') return `cargo:${g.cargoKind}`
  return 'none'
}

export function createCustomVisual(part: PartInstance): PartVisual {
  const group = new Group()
  group.userData.partId = part.id
  let content: Content | null = null
  let signature = ' ' // force a build on the first apply

  const rebuild = (pkg: PartPackage | undefined, lift: number | undefined, params: Readonly<Record<string, unknown>>): void => {
    content?.dispose()
    for (let i = group.children.length - 1; i >= 0; i--) group.remove(group.children[i]!)
    content =
      pkg && pkg.geometry.kind === 'rig'
        ? buildRig(resolveLinkFinishes(lift !== undefined ? applyStairLift(pkg.geometry, lift) : pkg.geometry, params, pkg.params), group, pkg.assets ?? [], pkg.materials ?? [], pkg.params, pkg)
        : pkg && pkg.geometry.kind === 'drawn'
          ? buildFunctionMesh(pkg.geometry, pkg, group, pkg.assets ?? [], pkg.materials ?? [])
          : pkg && pkg.geometry.kind === 'cargo'
            ? buildCargo(pkg.geometry, group)
            : buildDeck(group)
    // expose joint articulation to the running frame loop + the editor IK gizmo (rig only)
    group.userData.applyJoints = content.applyJoints
    group.userData.applySubPoses = content.applySubPoses
    group.userData.applyCopySpeeds = content.applyCopySpeeds
    group.userData.resetRunPose = content.resetRunPose // the view's Stop reset (resetRunPoses)
    group.userData.applyLamps = content.applyLamps // the view routes frame.lamps here to light rig lamps
    group.userData.applyDisplays = content.applyDisplays // ...and frame.displays here, to paint live caption plates
    // the view reads this to draw/pick/drag the rig gizmo (RigGizmoOverlay) for whichever part the editor made
    // the gizmo target (view.setRobotGizmo), not by this part's selected flag: a rig reached through a group
    // selection is never itself the selection. A rebuild swaps the api; the overlay follows it by identity.
    group.userData.robotGizmo = content.gizmo
    group.userData.tick = content.tick // per-frame animation (the conveying mesh bed scrolls its belt fabric)
    group.userData.applyConveyorSpeed = content.applyConveyorSpeed // the view routes frame.conveyorSpeeds here
    group.userData.applyValues = content.applyValues // ...and frame.values (the behavior's reported params) here
    group.userData.probeTick = content.probeTick // sensor-beam probe (rig beam links), like the built-in sensors
    // every full rebuild (signature change, package edit/hot-reload) replaces the subtree, so bump the
    // structural counter the view polls (render bundles re-record, as for the async loads).
    // This rebuild also created new callbacks (tick/probeTick/appliers above); the bump tells the view's
    // tick-callback registries to re-collect them (refreshTickRegistries).
    bumpStructureVersion(group)
  }

  const apply = (p: SdkPart, openings?: GuardOpenings, grid?: RollerGrid, extents?: GuardExtents, structConn?: StructureConnections, legRests?: LegRestRows, holes?: GuardHoles): void => {
    group.position.set(p.position[0], p.position[1], p.position[2])
    applyPartRotation(group, p)
    // uniform rig scale (the `scale` param convention; matches the sim's rigWorldPoses scale so the grab point
    // tracks the scaled gripper). A deck/no-scale part keeps scale 1.
    const scale = typeof p.params.scale === 'number' && p.params.scale > 0 ? p.params.scale : 1
    group.scale.setScalar(scale)
    const pkg = getPackage(p.packageId)
    // A connected stair's whole-flight lift rewrites link offsets/foot boxes. It is rare (it only changes on a
    // height edit), so it may key a rebuild. The platform's cut (railing gap / deck notches) changes on every
    // slide of the snapped stair and is applied in place by the rig's refresh (the conveyor guard-merge cost
    // model). Putting it in the rebuild signature drops the FPS sharply while snapping.
    const lift = structConn?.stairTopConnected.get(p.id)
    // a link whose finish an enum param chooses (a platform's deck surface) is built with that finish's material,
    // so a new choice rebuilds: a rare Inspector edit, and the rebuild keeps pooling and render bundles correct
    const finishes = pkg?.geometry.kind === 'rig' ? linkFinishKey(pkg.geometry, p.params, pkg.params) : ''
    let sig = lift !== undefined ? `${geomSignature(pkg)}|lift:${lift}` : geomSignature(pkg)
    if (finishes) sig += `|finish:${finishes}`
    if (sig !== signature) {
      signature = sig
      rebuild(pkg, lift, p.params)
    } else if (pkg?.geometry.kind === 'rig') {
      // structure unchanged but a link's rest pose may have moved (author-mode node drag/undo, param nudge):
      // reflow the existing groups in place instead of a full teardown+buildRig, which drops frames mid-drag.
      // Reflow from the same (possibly lifted) geo the content was built from, so its link names line up.
      content?.applyRestPose?.(lift !== undefined ? applyStairLift(pkg.geometry, lift) : pkg.geometry)
    }
    content?.refresh(p, openings, grid, extents, structConn?.platform.get(p.id), legRests, holes)
    // pose the rig at its authored idle configuration (or hold a gizmo drag); the running sim overrides it
    // each frame via applyBoxFrame, and on stop this restores the posed arm
    content?.applyIdlePose?.(p.params.pose)
    // Transform-mutation tally for the matrix-freeze cache: apply() is the single entry point for every
    // change that can move a freezable part's transforms (reflow, refresh's param re-places, rebuild).
    // A frozen part's per-frame mutators (applyJoints/applySubPoses) can't reach it, since a rig with
    // joints or a subPose'd mesh link is never matrix-static. The view compares this against its baked
    // rev (ensureFreshPose) and re-bakes a frozen part's matrices instead of rendering them stale.
    // Through the chokepoint so it also advances the global pose epoch (poseRev.ts) the view's idle
    // frozen-walk skip gates on.
    bumpPoseRev(group)
  }
  if (part.type === 'part') apply(part)

  return {
    object: group,
    update(p: PartInstance, ctx?: ResolvedContext): void {
      // unpack the neighbour-derived bundle (resolveScene) into apply's inputs. The roller grid carries the
      // world-phase anchor a butted neighbour/curve set gives this bed and which of its ends abut one at all
      // (nudgeLo/nudgeHi). The rig needs both, so the whole grid is forwarded, not just the anchor
      // (seam resolver).
      if (p.type === 'part') apply(p, ctx?.openings, ctx?.grid, ctx?.extents, ctx?.structConn, ctx?.legRests, ctx?.holes)
    },
    setSelected(on: boolean): void {
      setSelectedMaterials(content?.materials ?? [], on)
      // not the gizmo: it follows the editor's gizmo target (view.setRobotGizmo), which is derived
      // from the selection but also resolves through a group (see the robotGizmo wiring above).
    },
    dispose(): void {
      content?.dispose()
    },
  }
}
