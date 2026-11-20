// Routes a worker box frame onto the scene's visuals (extracted from view.ts): cargo, mobile-part base
// poses, rig joints and subPoses, lamps, displays, conveyor speeds and reported values, change-gated.

import type { BoxFrame } from '../../core/frame'
import { subPoseEq } from '../../core/rig/rigPose'
import type { SubPose } from '../../core/rig/rigPose'
import { markBundleDirtyPart } from '../bundleGroups'
import type { SubPoseMap } from './viewTypes'
import type { RenderView } from './view'

/** frame routing's own state (`view.routing`): the repeat gates, and the rigs it drives or stands aside for */
export class FrameRoutingState {
  /**
   * Frame-routing repeat gates: the worker re-sends every driven part's joints/subPoses each
   * step whether they moved or not, and each applier call moves transforms + bumps poseRev
   * (re-baking a frozen subtree). Skip the call when the values and the part's poseRev both
   * match the last routing. The rev guard re-routes after anything else re-posed the rig
   * (reflow, idle pose, gizmo drag; a rebuild replaces the applier so the WeakMap misses).
   * Because a routed applyJoints bumps poseRev, an unchanged subPose override still re-applies
   * right after it, so subPose takes precedence within the tick. Keyed by applier identity: a
   * rebuild mints new appliers, so stale last-values can't suppress the first routing to a fresh rig.
   */
  lastRoutedJoints = new WeakMap<object, { rev: number; values: Record<string, number> }>()
  // the last-routed maps are the frame's own objects: a frame payload is a fresh structured clone that
  // nothing mutates, so holding it and comparing by value replaces a per-part JSON.stringify per frame
  lastRoutedSubPoses = new WeakMap<object, { rev: number; poses: SubPoseMap }>()
  lastRoutedLamps = new WeakMap<object, Record<string, boolean>>()
  lastRoutedDisplays = new WeakMap<object, Record<string, number | boolean | string>>()
  // parts whose visual root a frame basePose moved this run (a driven AGV); resetRunPoses returns
  // them to the authored transform on stop, even if the part exposes no rig appliers
  readonly baseDriven = new Set<string>()
  /** A run has started since the last stop. A stop with none before it has no run pose to undo: the editor says
   *  "not running" as it mounts, and resetting then built every jointed part's visual a second time and merged the
   *  pool again, a quarter of a second on a 420-part line before the first frame. */
  ranSinceStop = false
  /**
   * Rigs whose joints the editor poses even while the sim runs (applyIdlePose), with the sim's joint frames for them
   * ignored: a flex conveyor the walking character is pulling. Its shape changes every frame and the sim receives it
   * only a few times a second, so the sim's frames always describe an older shape. Routed onto the rig just rebuilt
   * for the new shape, they would draw it stretched straight and then bent a frame later, repeatedly, so the bed
   * would appear to shake.
   */
  handPosed = new Set<string>()
}

/** what frame routing reaches on the view beyond its own {@link FrameRoutingState} */
export type FrameRoutingHost = Pick<
  RenderView,
  | 'boxes'
  | 'entries'
  | 'lastBeamHits'
  | 'lastFrameSimTime'
  | 'poolRebuild'
  | 'routing'
  | 'simHasFrame'
>

/** shallow numeric-record equality for the frame-routing joint gate (same keys, same values) */
function sameJointValues(a: Record<string, number>, b: Record<string, number>): boolean {
  return sameFlatValues(a, b)
}

/** same keys, same primitive values (a lamp map, a display bag, a joint table) */
function sameFlatValues<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  for (const k in b) if (a[k] !== b[k]) return false
  for (const k in a) if (!(k in b)) return false
  return true
}

/** same link names, each with the same position, rotation and instance poses */
function sameSubPoses(a: SubPoseMap, b: SubPoseMap): boolean {
  for (const k in b) {
    const x = a[k]
    if (!x || !subPoseEq(x, b[k])) return false
  }
  for (const k in a) if (!(k in b)) return false
  return true
}

export function applyBoxFrame(view: FrameRoutingHost, frame: BoxFrame): void {
  view.boxes.apply(frame)
  view.simHasFrame = true
  // (a frame drives poses whoever sent it: a stop after one has them to undo)
  view.routing.ranSinceStop = true
  // the worker's per-sensor beam results this step - probeBeam serves these while running
  view.lastBeamHits = frame.beamHits
  // the belt/roller/chain scroll advances by the delta of this clock (computed in tick), so a paused
  // worker (simTime frozen, no new frame) freezes them - the same sim-slaving as the PLC/turntables
  view.lastFrameSimTime = frame.simTime
  // C-drive: move a mobile part's whole visual root to its live running pose (an AGV navigating). The child
  // rig links keep animating relative to this root (joints/subPoses below), so the part drives as one body.
  if (frame.basePoses) {
    let newlyDriven = false
    for (const partId in frame.basePoses) {
      const obj = view.entries.get(partId)?.visual.object
      if (!obj) continue
      const bp = frame.basePoses[partId]!
      // a parked mobile part re-sends the same pose each step; only a real move dirties the freeze
      if (obj.position.x === bp.pos[0] && obj.position.y === bp.pos[1] && obj.position.z === bp.pos[2] && obj.rotation.y === bp.yaw) continue
      // stop returns this root to the authored transform (resetRunPoses), and until then it is pool-
      // exempt (poolExempt): the pool bakes world matrices, so its static links would stay parked
      if (!view.routing.baseDriven.has(partId)) {
        view.routing.baseDriven.add(partId)
        newlyDriven = true
      }
      obj.position.set(bp.pos[0], bp.pos[1], bp.pos[2])
      obj.rotation.y = bp.yaw
      obj.userData.poseRev = ((obj.userData.poseRev as number) ?? 0) + 1
    }
    // once per part per run, the first frame it actually moves; resetRunPoses re-pools it on stop
    if (newlyDriven) view.poolRebuild()
  }
  // animate rig custom parts: route each part's commanded joints (then setSubPose overrides) to its visual
  if (frame.joints) {
    for (const partId in frame.joints) {
      // a hand-posed rig takes its joints from the view's owner, not from these (older) frames
      if (view.routing.handPosed.has(partId)) continue
      const obj = view.entries.get(partId)?.visual.object
      const applyJoints = obj?.userData.applyJoints as ((j: Record<string, number>) => void) | undefined
      if (!obj || !applyJoints) continue
      const values = frame.joints[partId]!
      const rev = (obj.userData.poseRev as number | undefined) ?? 0
      const prev = view.routing.lastRoutedJoints.get(applyJoints)
      if (prev && prev.rev === rev && sameJointValues(prev.values, values)) continue
      applyJoints(values)
      view.routing.lastRoutedJoints.set(applyJoints, { rev: (obj.userData.poseRev as number | undefined) ?? 0, values })
    }
  }
  if (frame.subPoses) {
    for (const partId in frame.subPoses) {
      const obj = view.entries.get(partId)?.visual.object
      const applySubPoses = obj?.userData.applySubPoses as ((p: Record<string, SubPose>) => void) | undefined
      if (!obj || !applySubPoses) continue
      const sp = frame.subPoses[partId]!
      const rev = (obj.userData.poseRev as number | undefined) ?? 0
      const prev = view.routing.lastRoutedSubPoses.get(applySubPoses)
      if (prev && prev.rev === rev && sameSubPoses(prev.poses, sp)) continue
      applySubPoses(sp)
      view.routing.lastRoutedSubPoses.set(applySubPoses, { rev: (obj.userData.poseRev as number | undefined) ?? 0, poses: sp })
    }
  }
  if (frame.copySpeeds) {
    // conveying copies' belt speeds: the rig rewrites a copy's scroll only when its speed changed
    for (const partId in frame.copySpeeds) {
      const apply = view.entries.get(partId)?.visual.object.userData.applyCopySpeeds as ((s: Record<string, number[]>) => void) | undefined
      apply?.(frame.copySpeeds[partId]!)
    }
  }
  if (frame.lamps) {
    for (const partId in frame.lamps) {
      const applyLamps = view.entries.get(partId)?.visual.object.userData.applyLamps as ((l: Record<string, boolean>) => void) | undefined
      if (applyLamps) {
        // behaviors re-command lamps every tick, so route + mark only when the commanded map
        // changed for this applier (same keying as lastRoutedJoints: a rebuild mints a fresh
        // applier, so a fresh rig always gets its first paint). applyLamps paints emissives
        // unconditionally and sets squash targets. Skipping an unchanged map leaves both at their
        // correct values (the squash ease reads targets per frame either way). The bundle mark
        // happens only with a paint, so lamp parts aren't re-walked every running frame.
        const lamps = frame.lamps[partId]!
        const prev = view.routing.lastRoutedLamps.get(applyLamps)
        if (!prev || !sameFlatValues(prev, lamps)) {
          applyLamps(lamps)
          markBundleDirtyPart(partId)
          view.routing.lastRoutedLamps.set(applyLamps, lamps)
        }
      }
    }
  }
  // C-display: the values each behavior published this step (ctx.display) paint that part's live
  // (`textFrom`) caption plates. Same change-gate as lamps: a behavior republishes every tick, so routing
  // an unchanged bag would repaint a canvas and re-record a bundle sixty times a second. The applier also
  // reports whether the drawn text changed, which is the signal for the bundle mark: a caption rounded to
  // whole units whose source moved by 0.001 changed nothing on screen.
  if (frame.displays) {
    for (const partId in frame.displays) {
      const applyDisplays = view.entries.get(partId)?.visual.object.userData.applyDisplays as ((d: Record<string, number | boolean | string>) => boolean) | undefined
      if (!applyDisplays) continue
      const values = frame.displays[partId]!
      const prev = view.routing.lastRoutedDisplays.get(applyDisplays)
      if (prev && sameFlatValues(prev, values)) continue
      view.routing.lastRoutedDisplays.set(applyDisplays, values)
      if (applyDisplays(values)) markBundleDirtyPart(partId)
    }
  }
  // effective conveyor speed (tag-commanded/-gated) → the belt-fabric scroll / roller spin follows the PLC
  if (frame.conveyorSpeeds) {
    for (const partId in frame.conveyorSpeeds) {
      const applySpeed = view.entries.get(partId)?.visual.object.userData.applyConveyorSpeed as ((v: number) => void) | undefined
      applySpeed?.(frame.conveyorSpeeds[partId]!)
    }
  }
  // reported param values (ctx.report) → the few visuals that animate from one (a chain transfer's chain speed).
  // Only a visual that exposes the hook is looked at, and it only stores numbers: its own tick does the work.
  if (frame.values) {
    for (const partId in frame.values) {
      const applyValues = view.entries.get(partId)?.visual.object.userData.applyValues as ((v: Record<string, number | boolean>) => void) | undefined
      applyValues?.(frame.values[partId]!)
    }
  }
}
