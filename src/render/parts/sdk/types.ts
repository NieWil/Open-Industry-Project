// The shared Content contract every SDK geometry builder (deck / cargo / mesh / function / rig)
// implements and the factory in sdkPart.ts consumes.
import type { Material } from 'three'
import type { SubPose } from '../../../core/rig/rigPose'
import type { RollerGrid } from '../../../core/conveyor/rollerGrid'
import type { GuardOpenings } from '../../../core/guards/guardOpenings'
import type { GuardExtents } from '../../../core/guards/guardExtents'
import type { LegRestRows } from '../../../core/legRests'
import type { GuardHoles } from '../../../core/guards/guardHoles'
import type { PlatformCut } from '../../../core/structureCuts'
import type { PartPackage } from '../../../core/parts/partPackage'
import type { SdkPart } from '../../../core/types'
import type { RobotGizmoApi } from '../../api'
import type { BeamProbe } from '../sensor'

export interface Content {
  materials: Material[]
  /** per-update refresh (deck rescale); rig is static at rest until applyJoints drives it. Content that
   *  doesn't use an argument ignores it.
   *  - `openings`: the neighbour-derived side-guard gaps the host computed for this part (a butting
   *    conveyor). A belt-like function part cuts them into its guards.
   *  - `grid`: the host-resolved world-phase roller grid (roller beds). A rig folds its `anchor` into the
   *    array-distribution seam so a butted neighbour shares its roller grid, and reads `nudgeLo`/`nudgeHi`
   *    as "this end abuts a collinear roller neighbour", so a part can author end-of-bed geometry that
   *    meets that neighbour (GeometryContext; docs/seam-resolvers.md).
   *  - `extents`: the snap-derived spur end overrides. A spur-view function part extends its rails/guards
   *    out to the host wall it feeds (withSpurExtents).
   *  - `platformCut`: the stair→platform structure cut (railing gap + deck notches), which a rig platform
   *    lays out in place (split rails, skipped + framing posts, deck strips). It uses the same
   *    retained-mesh reconcile as the conveyor guard cut, so a snapped stair sliding along the deck edge
   *    never tears the rig down (a full rebuild per pointer-move lags the snap).
   *  - `legRests`: the host-derived per-leg footing rows for a legged bed crossing a platform
   *    (legRests.ts). A function belt folds them into its params (withLegRests); a rig lays its leg
   *    stations out on them.
   *  - `holes`: the sensor-beam holes through its side guards (guardHoles.ts). A function conveyor folds
   *    them into its `guardHoles` param; a rig splits its guard sheet around each and fills the gap with
   *    a holed panel. */
  refresh(p: SdkPart, openings?: GuardOpenings, grid?: RollerGrid, extents?: GuardExtents, platformCut?: PlatformCut, legRests?: LegRestRows, holes?: GuardHoles): void
  /** drive named joints (rig only); undefined for a deck */
  applyJoints?: (joints: Record<string, number>) => void
  /** apply free-form link pose overrides (rig setSubPose); undefined for a deck */
  applySubPoses?: (subPoses: Record<string, SubPose>) => void
  /** each conveying copy's belt speed (frame.copySpeeds), by posable array link; runs the copies' belt fabric */
  applyCopySpeeds?: (speeds: Record<string, number[]>) => void
  /** Stop: drop the run's joint values and subPoses and lay every link at rest (rig only); undefined for a deck */
  resetRunPose?: () => void
  /** light/darken emissive lamp links (rig setEmissive/ctx.lamps); undefined for a deck/no-lamp rig */
  applyLamps?: (lamps: Record<string, boolean>) => void
  /** paint the part's live display values (frame.displays: what ctx.display published this step) onto its
   *  `screen` panels + `textFrom` labels. Undefined for a rig with neither. Returns true when a panel's
   *  drawn content actually changed. The caller uses that to re-record the render bundle, so the comparison
   *  is against the drawn text, not the raw value: a readout at 0 decimals must not force a re-record
   *  every tick because its source changed in the third decimal place. */
  applyDisplays?: (displays: Record<string, number | boolean | string>) => boolean
  /** live effective conveyor speed from the running frame (frame.conveyorSpeeds: the tag-commanded/-gated
   *  speed the behavior actually drove; arc parts arrive as omega rad/s and are converted back to centreline
   *  m/s inside). While set, the belt-fabric scroll / roller spin follows it instead of the raw `speed`
   *  param, so a PLC-stopped belt stops scrolling; cleared when the sim stops. */
  applyConveyorSpeed?: (v: number) => void
  /** the behavior's reported param values from the running frame (frame.values: ctx.report, what the Inspector's
   *  live readout shows). A rig takes its chain speed from here, the effective `speed` the program commands:
   *  the chains move when their drive does, whatever the lift is doing. Undefined for a rig without chains. */
  applyValues?: (values: Record<string, number | boolean>) => void
  /** per-frame animation (the conveying mesh bed scrolls its belt fabric); the view calls it via userData.tick.
   *  Returns true when it mutated a rendered material/attribute this frame (scroll advanced, spin turned,
   *  bank attr written): the view's activity mark for the render-bundle replay refresh. A no-op tick
   *  (stopped, speed 0) must return false so the part's draws stop being refresh-walked. */
  tick?: (dt: number, running: boolean) => boolean
  /** per-frame sensor-beam cargo probe (rig links with a `beam`); the view calls it via userData.probeTick,
   *  exactly as it does the built-in sensors' - draws the beam line + publishes the guard-hole segment.
   *  Returns true when a beam visual changed (stretch/tint) - the same activity mark as `tick`. */
  probeTick?: (probe: BeamProbe) => boolean
  /** editor IK gizmo (rig with joints only); the view reads it via userData.robotGizmo and draws it in its
   *  RigGizmoOverlay for the editor's gizmo target, not by the part's selected flag. */
  gizmo?: RobotGizmoApi
  /** apply the authored idle pose (the `pose` numberList param) at rest; a gizmo drag overrides + persists over it */
  applyIdlePose?: (poseParam: unknown) => void
  /** rig only: reflow each link group to the current rest pose (offset + rest rotation) from a fresh geometry,
   *  without rebuilding - the fast path for an author-mode node-offset drag/undo (see geomSignature) */
  applyRestPose?: (geo: Extract<PartPackage['geometry'], { kind: 'rig' }>) => void
  dispose(): void
}
