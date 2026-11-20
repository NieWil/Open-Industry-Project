// The view-only and sim-bound scenes the EditorController (../controller.ts) derives: the
// edit target, the walk session's doors and pulled flexes, part-scene isolation. The walk overlays' memos
// and the flex push throttle are this area's own state (WalkOverlays, held by the controller); everything
// else a function needs is passed in.

import { ancestorIds, subtreeIds } from '../../core/scene/hierarchy'
import { getPackage } from '../../core/parts/partRegistry'
import { definitionsUsedBy, rigJointsJson } from '../../core/parts/partPackage'
import { posableArraysJson } from '../../core/rig/rigPose'
import { settleIdlePose, withJointRests } from '../../sim/idlePose'
import { withFlexPose } from '../../core/parts/partGeometry'
import type { FlexPose } from '../../core/parts/partGeometry'
import type { SdkPart, PartInstance, SceneJSON } from '../../core/types'
import type { IRenderView } from '../../render/api'
import type { SimClient } from '../../sim/client'
import { editTarget, editTargetFocusId } from '../store/store'
import type { EditorState, EditorStore } from '../store/store'

// how often a flex the walking character pulls is re-handed to the running sim (each is a rebuild of the part there),
// per second; the drawn bed follows the hands every frame regardless (pushWalkFlexToSim)
const WALK_FLEX_SIM_HZ = 15

/** The walk session's view overlays and the pulled-flex sim push throttle: session state, never the document. */
export class WalkOverlays {
  // editTargetViewScene's walk-door overlay, memoized per building on (authored part, open leaves) so the
  // overlaid part keeps one identity across unrelated scene changes and the view doesn't re-update the
  // building on each of them
  readonly doorParts = new Map<string, { src: PartInstance; open: readonly string[]; out: PartInstance }>()
  readonly flexParts = new Map<string, { src: PartInstance; pose: FlexPose; out: PartInstance }>()
  /** when a pulled flex's new shape may next go to the running sim (each is a rebuild of the part there) */
  flexSimAt = 0
  flexSimTimer: ReturnType<typeof setTimeout> | null = null
}

/** what the sim-bound derivations read: the live state (focus, walk shapes) and the sim they push to */
export interface ViewSceneDeps {
  readonly store: EditorStore
  readonly sim: SimClient
}

export function editTargetViewScene(w: WalkOverlays, s: EditorState): SceneJSON {
  const target = editTarget(s)
  // the focused part the active target isolates (== s.focusedPartId for both part-focus and master;
  // null at base scene or a stranded master session) - keyed through the typed model, not the raw field.
  const focusId = target ? editTargetFocusId(target) : null
  const scene = withWalkFlex(w, withWalkDoors(w, s.scene, s.walkDoors), s.walkFlex)
  return focusId ? focusViewScene(scene, focusId) : scene
}

/**
 * Overlay the walk session's dock doors (EditorState.walkDoors) on the authored scene, for the view only:
 * each building the character has used a door on shows that session's open leaves in place of its authored
 * `openDoors`. Returns `scene` itself when there is nothing to overlay.
 */
export function withWalkDoors(w: WalkOverlays, scene: SceneJSON, walkDoors: EditorState['walkDoors']): SceneJSON {
  if (walkDoors === null) {
    w.doorParts.clear()
    return scene
  }
  let changed = false
  const parts = scene.parts.map((p) => {
    const open = p.type === 'building' ? walkDoors[p.id] : undefined
    if (!open) return p
    changed = true
    const memo = w.doorParts.get(p.id)
    if (memo && memo.src === p && memo.open === open) return memo.out
    const out = { ...p, params: { ...p.params, openDoors: [...open] } } as PartInstance
    w.doorParts.set(p.id, { src: p, open, out })
    return out
  })
  return changed ? { ...scene, parts } : scene
}

/**
 * While running, pose each flex the walking character has pulled from its walk shape, here, in the pass that rebuilt
 * it, and have the view ignore the sim's joint frames for it (setHandPosed). The shape changes every frame but the
 * sim is re-handed it only a few times a second (pushWalkFlexToSim), so its frames describe an older bed. Applied
 * to the one just rebuilt they would draw it stretched straight and then bent, a visible lurch each time.
 * The joints are the behavior's own settled pose for the shape (settleIdlePose, as the stopped preview does), so
 * they are what the sim arrives at too. Stopped, refreshIdlePoses poses it and nothing is hand-posed.
 */
export function poseWalkedFlexes(view: IRenderView, s: EditorState, scene: SceneJSON): void {
  const ids = s.running && s.walkFlex ? Object.keys(s.walkFlex) : []
  view.setHandPosed(ids)
  for (const id of ids) {
    const part = scene.parts.find((p) => p.id === id)
    const pkg = part?.type === 'part' ? getPackage((part as SdkPart).packageId) : undefined
    if (!part || !pkg || pkg.geometry.kind !== 'rig') continue
    const params = (part as SdkPart).params ?? {}
    const pose = withJointRests(settleIdlePose(pkg.behavior, params, 0, undefined, rigJointsJson(pkg.geometry), posableArraysJson(pkg.geometry)), pkg.geometry.joints, params)
    if (pose) view.applyIdlePose(id, pose)
  }
}

/**
 * Hand the running sim the walk's pulled flex shapes, at most WALK_FLEX_SIM_HZ times a second, the last one always
 * sent (a trailing push): the drawn bed follows the hands every frame (poseWalkedFlexes), and the sim, which
 * carries product along it, catches up at a walking pace.
 */
export function pushWalkFlexToSim(w: WalkOverlays, d: ViewSceneDeps): void {
  if (w.flexSimTimer !== null) return // a push is already due; it sends whatever the shape is then
  const wait = w.flexSimAt + 1000 / WALK_FLEX_SIM_HZ - performance.now()
  const push = (): void => {
    w.flexSimTimer = null
    const st = d.store.getState()
    if (!st.running) return
    w.flexSimAt = performance.now()
    d.sim.update(forSim(w, d.store, st.scene)) // = EditorController.commsScene
  }
  if (wait <= 0) push()
  else w.flexSimTimer = setTimeout(push, wait)
}

/**
 * Overlay the walk session's pulled flex conveyors (EditorState.walkFlex) on a scene: each one takes the shape the
 * character laid it in. Unlike the doors this reaches the sim as well as the view (forSim), since a flex carries
 * along its shape. Returns `scene` itself when there is nothing to overlay.
 */
export function withWalkFlex(w: WalkOverlays, scene: SceneJSON, walkFlex: EditorState['walkFlex']): SceneJSON {
  if (walkFlex === null) {
    w.flexParts.clear()
    return scene
  }
  let changed = false
  const parts = scene.parts.map((p) => {
    const pose = walkFlex[p.id]
    if (!pose) return p
    changed = true
    const memo = w.flexParts.get(p.id)
    if (memo && memo.src === p && memo.pose === pose) return memo.out
    const out = withFlexPose(p, pose)
    w.flexParts.set(p.id, { src: p, pose, out })
    return out
  })
  return changed ? { ...scene, parts } : scene
}

/**
 * The part-focus target's view-scene (see editTargetViewScene): the focused part (and its soft-parented
 * subtree) stays visible, as does the building - it's the stage, keeping the isolated part in real industrial
 * context (floor, scale, lighting) rather than a grey void. Every other part (sibling equipment clutter) is
 * forced hidden. Use the building-shell toggle to drop the roof/walls if they occlude. View-only - never
 * committed, persisted, or sent to the sim, so the authored scene is untouched. (A building-less scene still
 * gets a floor: the viewport backdrop shows whenever no building is present.)
 */
export function focusViewScene(scene: SceneJSON, focusId: string): SceneJSON {
  // keep = the focused part's subtree and its ancestor chain. Ancestors matter because
  // a focused part can live under a group container: hiding that group (it isn't in the
  // subtree) would inherit-hide the focused part itself (effectivelyHiddenSet).
  const keep = new Set([...subtreeIds(scene.parts, [focusId]), ...ancestorIds(scene.parts, focusId)])
  const parts = scene.parts.map((p) =>
    keep.has(p.id) || p.type === 'building' || p.visible === false ? p : ({ ...p, visible: false } as PartInstance),
  )
  return { ...scene, parts }
}

/**
 * The run-scene for an open part scene: only the focused part's subtree + the building stage, with every
 * other part removed (not just hidden, as focusViewScene does - the sim ignores `visible`). This is what
 * lets a part run "in its own scene": the factory's other parts, spawners especially, aren't in the scene
 * the sim sees, so they don't tick underneath the isolated view. The full scene stays untouched in the store.
 */
export function isolatedRunScene(scene: SceneJSON, focusId: string): SceneJSON {
  const keep = new Set([...subtreeIds(scene.parts, [focusId]), ...ancestorIds(scene.parts, focusId)])
  const parts = scene.parts.filter((p) => keep.has(p.id) || p.type === 'building')
  return { ...scene, parts }
}

/** Narrow a scene to what the sim should run: the full scene normally, or the isolated part scene while one
 *  is open (focusedPartId set). Applied at every sim push - folded into commsScene plus the raw turntable /
 *  PLC-detach pushes - so isolation can't leak through a forgotten path. Also swaps each embedded package
 *  for its live registry copy: `scene.packages` holds placement-day snapshots, and the registry is where a
 *  hot-reloaded bundle / edited part goes. Without this, Run would execute a snapshot the render no longer
 *  shows. A pure read of focus + scene + registry. */
export function forSim(w: WalkOverlays, store: EditorStore, scene: SceneJSON): SceneJSON {
  const { focusedPartId: focusId, walkFlex } = store.getState()
  const walked = withWalkFlex(w, scene, walkFlex)
  const base = focusId !== null ? isolatedRunScene(walked, focusId) : walked
  const pkgs = [...(base.packages ?? [])]
  const have = new Set(pkgs.map((p) => p.id))
  // The worker only knows the packages it is handed: every one the parts use, whether or not the scene embeds it. A
  // part whose package is missing there still draws, but the sim builds it with no bodies and cargo falls through it.
  // That covers the products a spawner makes and a unit load's pieces, which no placed part may embed.
  for (const pkg of definitionsUsedBy(base.parts, getPackage)) if (!have.has(pkg.id)) pkgs.push(pkg)
  if (pkgs.length === 0) return base
  return { ...base, packages: pkgs.map((p) => getPackage(p.id) ?? p) }
}
