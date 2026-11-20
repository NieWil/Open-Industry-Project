// What the document is, as opposed to what the current run owns: the run-ownership reads behind the store's edit
// gate (documentOf / documentChanged), the designed-pose bookkeeping for placed boxes mid-run, and the live
// scene's package copies. Pure functions, and the RunOwnership the store holds them through (its live-cargo seam and
// designed poses).
import { carryCargoPose, carryingAncestor, cargoPoseOf, differOnlyInPose, isCargoPart, sameCargoPose, withCargoPose } from '../../core/frame'
import type { CargoPose } from '../../core/frame'
import { subtreeIds } from '../../core/scene/hierarchy'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart, PartInstance, SceneJSON } from '../../core/types'
import type { EditorState } from './storeState'

/**
 * The packages a live scene carries for `parts`: the registry's copy of each one they name (the open project's
 * library, the app's built-ins), plus any `kept` copy the registry has nothing for. A project scene stores none of
 * them (core/project/project.ts, format 3); this is how the scene on screen is whole again for the worker, a room, a file.
 */
export function livePackagesFor(parts: readonly PartInstance[], kept: readonly PartPackage[]): PartPackage[] {
  const out = new Map<string, PartPackage>()
  for (const p of parts) {
    if (p.type !== 'part' || out.has((p as SdkPart).packageId)) continue
    const pkg = getPackage((p as SdkPart).packageId)
    if (pkg) out.set(pkg.id, pkg)
  }
  for (const pkg of kept) if (!out.has(pkg.id)) out.set(pkg.id, getPackage(pkg.id) ?? pkg)
  return [...out.values()]
}

/**
 * The document's scene for this state: the one an open definition session parked (packageEdit.document), else the
 * live scene. Read it wherever "the scene" means what the user is building - an export, a count of placed copies -
 * and not what is on screen.
 */
export function documentSceneOf(state: Pick<EditorState, 'scene' | 'packageEdit'>): SceneJSON {
  return state.packageEdit?.document ?? state.scene
}

/** the run owns nothing (runOwnedIn) - shared, never mutated */
const NO_IDS: ReadonlySet<string> = new Set()

/** a running cargo body's live pose, as the part's own position + YXZ rotation fields */
export interface LiveCargoPose {
  position: [number, number, number]
  rotationX: number
  rotationY: number
  rotationZ: number
}

/**
 * The controller's live-cargo seam, installed once at wiring time (null headless / in tests, where
 * nothing runs and the authored pose is the truth). Physics owns a running cargo body, so a running
 * box's authored transform is a stale spawn pose. The store must ask the controller two things
 * before it copies one:
 *
 * - `pose` - where the body actually is, so a copy is placed on the box rather than where it was
 *   authored. Same rebasing the drag path does (controller/drag.ts `dragStartScene`).
 * - `runScoped` - cargo minted while the sim runs is live sim content, not the authored design, so
 *   Stop drops it (the rule placePart applies to cargo dropped onto a running line).
 */
export interface LiveCargoHost {
  pose(id: string): LiveCargoPose | null
  runScoped(ids: readonly string[]): void
  /** the ids the run owns right now - cargo the sim minted or the user picked up mid-run, all of which
   *  `stop()` deletes again. The store reads this to keep them out of the document (RunOwnership.documentOf):
   *  they are live sim state represented as parts, not authored design, so changing them is no edit. */
  runScopedIds(): ReadonlySet<string>
}

/** the pose of every cargo part in `scene` the run doesn't own (see designedPoses) */
export function cargoPosesIn(scene: SceneJSON, host: LiveCargoHost | null): Map<string, CargoPose> {
  const run = runOwnedIn(scene, host)
  const poses = new Map<string, CargoPose>()
  for (const p of scene.parts) if (!run.has(p.id) && isCargoPart(p)) poses.set(p.id, cargoPoseOf(p))
  return poses
}

/** `scene` with each part in `poses` set to its designed pose; `scene` itself when all already do */
export function withDesignedPoses(scene: SceneJSON, poses: ReadonlyMap<string, CargoPose>): SceneJSON {
  let changed = false
  const parts = scene.parts.map((p) => {
    const pose = poses.get(p.id)
    const q = pose ? withCargoPose(p, pose) : p
    if (q !== p) changed = true
    return q
  })
  return changed ? { ...scene, parts } : scene
}

/**
 * The document inside `scene`: everything except what the current run owns. Two things belong to the run:
 *
 * - Parts it owns. A box someone clicks, band-selects or picks up mid-run is promoted to a part so the editor can
 *   address it, and cargo dropped or copied onto a running line is minted as one, but `stop()` deletes all of
 *   it again (LiveCargoHost.runScopedIds). It is sim state represented as parts, not design, so it is dropped here.
 * - The pose of a placed box. Physics owns it mid-run, so a box the user moved, rotated or froze then has the
 *   gesture's pose, and the document keeps its designed one instead (designedPoses).
 *
 * Returns `scene` itself when the run owns neither. The one definition of "run-owned" in the store: the edit gate
 * (commit's documentChanged), the undo history and the autosave (sceneSansDraft) all read it, so no consumer
 * re-derives the rule. A consumer that re-derived it could, for example, let an undo after Stop restore a run's box
 * as authored, saved content.
 */
export function documentOf(scene: SceneJSON, host: LiveCargoHost | null, designedPoses: ReadonlyMap<string, CargoPose> | null): SceneJSON {
  const run = runOwnedIn(scene, host)
  const kept = run.size === 0 ? scene : { ...scene, parts: scene.parts.filter((p) => !run.has(p.id)) }
  return designedPoses ? withDesignedPoses(kept, designedPoses) : kept
}

/** the ids in `scene` the current run owns, their subtrees included (see documentOf) */
export function runOwnedIn(scene: SceneJSON, host: LiveCargoHost | null): ReadonlySet<string> {
  const run = host?.runScopedIds()
  return run && run.size > 0 ? new Set(subtreeIds(scene.parts, run)) : NO_IDS
}

/**
 * The edit gate's question: did `before` → `after` change the document (documentOf)? Only a change to the
 * document is an edit: an undo step, an autosave, a folder write, a demo fork. A change confined to what the run
 * owns (a promoted box moved, deleted or copied; a placed box moved, rotated or frozen mid-run) is run state, and
 * a re-commit of the same scene is nothing. Parts are immutable, so this compares references - the parts in
 * order, a placed box's pose aside while running, then the scene's other fields - and never serializes.
 */
export function documentChanged(before: SceneJSON, after: SceneJSON, host: LiveCargoHost | null, designedPoses: ReadonlyMap<string, CargoPose> | null, packageEdit: EditorState['packageEdit']): boolean {
  // an open definition session's scene is the session's (packageEdit): the document is parked, untouched by it
  if (before === after || packageEdit) return false
  const runB = runOwnedIn(before, host)
  const runA = runOwnedIn(after, host)
  const a = runB.size === 0 ? before.parts : before.parts.filter((p) => !runB.has(p.id))
  const b = runA.size === 0 ? after.parts : after.parts.filter((p) => !runA.has(p.id))
  if (a.length !== b.length) return true
  const designed = designedPoses
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!
    const pb = b[i]!
    if (pa === pb) continue
    if (pa.id === pb.id && designed?.has(pa.id) && differOnlyInPose(pa, pb)) continue
    return true
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof SceneJSON>
  for (const k of keys) if (k !== 'parts' && before[k] !== after[k]) return true
  return false
}

/**
 * An edit that moved a placed box's ancestor (a pallet-load group dragged mid-run) carried the box with it, and
 * that is layout authoring: the box's designed pose follows the ancestor's rigid motion, so Stop puts it back on
 * the moved group rather than at the group's old position. A box that moved with no moving ancestor moved on its
 * own (operating) and keeps its designed pose. Only an ancestor the document owns counts (not another placed
 * box, whose own move is operating too). Planar, like every group carry (core/transforms): translate + yaw.
 */
export function carryDesignedPoses(before: SceneJSON, after: SceneJSON, host: LiveCargoHost | null, designedPoses: Map<string, CargoPose> | null): void {
  const designed = designedPoses
  if (!designed || designed.size === 0) return
  const beforeById = new Map(before.parts.map((p) => [p.id, p]))
  const afterById = new Map(after.parts.map((p) => [p.id, p]))
  const run = runOwnedIn(after, host)
  const skip = (anc: string): boolean => designed.has(anc) || run.has(anc)
  for (const [id, pose] of designed) {
    const a = afterById.get(id)
    const b = beforeById.get(id)
    if (!a || !b || sameCargoPose(cargoPoseOf(a), cargoPoseOf(b))) continue
    const by = carryingAncestor(id, beforeById, afterById, skip)
    if (by) designed.set(id, carryCargoPose(pose, by.before, by.after))
  }
}

/**
 * The scene to show for a document (an undo/redo snapshot) applied mid-run. The run keeps what it owns: its parts
 * are put back, and each placed box stays where the run has it, so an undo can't delete a box out from under its
 * body or teleport it. The designed poses come from the document, though: that is where they live, and an undo
 * of a carry has to take the box's designed pose back with it. `doc` itself when the run owns nothing.
 */
export function adoptDocument(doc: SceneJSON, liveScene: SceneJSON, host: LiveCargoHost | null, designedPoses: Map<string, CargoPose> | null): SceneJSON {
  const cur = liveScene
  const run = runOwnedIn(cur, host)
  const designed = designedPoses
  if (run.size === 0 && !designed) return doc
  const curById = new Map(cur.parts.map((p) => [p.id, p]))
  let changed = false
  const parts = doc.parts.map((p) => {
    if (!designed?.has(p.id)) return p
    designed.set(p.id, cargoPoseOf(p))
    const live = curById.get(p.id)
    const q = live ? withCargoPose(p, cargoPoseOf(live)) : p
    if (q !== p) changed = true
    return q
  })
  const inDoc = new Set(doc.parts.map((p) => p.id))
  const extra = cur.parts.filter((p) => run.has(p.id) && !inDoc.has(p.id))
  if (extra.length > 0) changed = true
  return changed ? { ...doc, parts: [...parts, ...extra] } : doc
}

/**
 * What the current run owns, as the store owns it (EditorStore.run): the controller's live-cargo seam and, while the
 * sim runs, the designed pose of every placed box. Every read of "run-owned" in the store goes through here - the edit
 * gate (documentChanged), the undo history and the autosave (documentOf), a carry (carry), an undo applied mid-run
 * (adopt) - with the rules themselves in the functions above.
 */
export class RunOwnership {
  // the controller's live-cargo seam: live poses for running cargo + run-scoped adoption of cargo
  // minted mid-run. null headless (no sim → authored poses are the truth). See LiveCargoHost.
  private liveCargoHost: LiveCargoHost | null = null
  // While the sim runs: the designed pose of every placed (authored) cargo part, i.e. where the box starts, as opposed
  // to where physics has it. A box's pose belongs to physics mid-run (core/frame CargoPose): moving, rotating or
  // freezing a placed box then is operating, so its part may have any pose the gesture left, and this is the pose
  // the document keeps (documentOf) and Stop puts back (EditorStore.setRunning). It follows the box only when an edit
  // carries it (a pallet-load group moved mid-run - carry) and when an undo applies a document (adopt).
  // Snapshotted on the Play edge; null while stopped. See docs/document-and-run.md.
  private designedPoses: Map<string, CargoPose> | null = null

  /** the live-cargo seam, for the store modules that copy cargo (storeCopy) */
  get host(): LiveCargoHost | null {
    return this.liveCargoHost
  }

  setHost(host: LiveCargoHost | null): void {
    this.liveCargoHost = host
  }

  /**
   * The Play / Stop edge: Play snapshots where every placed box in `scene` starts; Stop drops the snapshot and returns
   * `scene` with each box put back there (`scene` itself when all already are, or on Play).
   */
  setRunning(running: boolean, scene: SceneJSON): SceneJSON {
    const designed = this.designedPoses
    this.designedPoses = running ? cargoPosesIn(scene, this.liveCargoHost) : null
    return !running && designed ? withDesignedPoses(scene, designed) : scene
  }

  /** a different scene loaded: while running, its own placed poses are the designed ones (ids can repeat across scenes) */
  rebase(running: boolean, scene: SceneJSON): void {
    this.designedPoses = running ? cargoPosesIn(scene, this.liveCargoHost) : null
  }

  /** The document inside `scene`: everything except what the current run owns (see the documentOf function). The one
   *  definition of "run-owned" in the store: the edit gate, the undo history and the autosave all read it. */
  documentOf(scene: SceneJSON): SceneJSON {
    return documentOf(scene, this.liveCargoHost, this.designedPoses)
  }

  /** The edit gate's question: did `before` → `after` change the document? Only a change to the document is an edit:
   *  an undo step, an autosave, a folder write, a demo fork (see the documentChanged function). */
  documentChanged(before: SceneJSON, after: SceneJSON, packageEdit: EditorState['packageEdit']): boolean {
    return documentChanged(before, after, this.liveCargoHost, this.designedPoses, packageEdit)
  }

  /** an edit that carried a placed box with its ancestor carries the box's designed pose too (carryDesignedPoses) */
  carry(before: SceneJSON, after: SceneJSON): void {
    carryDesignedPoses(before, after, this.liveCargoHost, this.designedPoses)
  }

  /** a document (an undo/redo snapshot) as the scene to show mid-run, beside the live scene (adoptDocument) */
  adopt(doc: SceneJSON, liveScene: SceneJSON): SceneJSON {
    return adoptDocument(doc, liveScene, this.liveCargoHost, this.designedPoses)
  }
}
