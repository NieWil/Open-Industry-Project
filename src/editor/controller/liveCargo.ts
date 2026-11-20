// Running cargo as the EditorController (../controller.ts) sees it: live poses of selected
// bodies, and promoting a spawner's transient box into a run-scoped part. The live-pose cache and the run-scoped
// id set stay on the controller, because the drag, gizmo, pilot, placement and run edges read them too; every
// function here takes only the narrow slice it uses (LiveCargoDeps).

import type { BoxFrame } from '../../core/frame'
import { isCargoPart } from '../../core/frame'
import { quatToYXZ } from '../../core/math'
import { createSdkPart, idAllocator } from '../../core/scene/scene'
import { getPackage } from '../../core/parts/partRegistry'
import type { ParamValue, PartInstance } from '../../core/types'
import type { BoxPick } from '../../render/api'
import type { EditorState, LiveCargoPose } from '../store/store'
import type { EditorController } from '../controller'

/** what the live-cargo view reads and drives: the store, the sim, the latest frame, the live-pose cache, the
 *  run-scoped ids, the drag in flight (whose gizmo it re-pushes) and its own controller entry points */
export type LiveCargoDeps = Pick<
  EditorController,
  | 'store'
  | 'sim'
  | 'lastFrame'
  | 'liveCargo'
  | 'runPromotedBoxes'
  | 'drag'
  | 'pushGizmo'
  | 'refreshLiveCargo'
  | 'selectedLiveCargo'
  | 'selectedLiveCargoParts'
  | 'promoteCargoBox'
  | 'promoteCargoBoxes'
>

/**
 * The single selected running box/pallet, whose dynamic body is physics-owned.
 * Its gizmo follows the live body (see trackSelectedBox) and a gizmo drag
 * teleports that body; resize handles stay hidden (the authored mesh is gone).
 */
export function liveCargoSelected(ec: LiveCargoDeps, s: EditorState): boolean {
  return ec.selectedLiveCargo(s) !== null
}

export function selectedLiveCargo(ec: LiveCargoDeps, s: EditorState): PartInstance | null {
  if (s.selectedIds.length !== 1) return null
  return ec.selectedLiveCargoParts(s)[0] ?? null
}

export function selectedLiveCargoParts(ec: LiveCargoDeps, s: EditorState): PartInstance[] {
  if (!s.running || s.selectedIds.length === 0) return []
  const sel = new Set(s.selectedIds)
  // any cargo part, built-in or custom: one recognizer (core/frame cargoView)
  return s.scene.parts.filter((p) => sel.has(p.id) && isCargoPart(p))
}

/**
 * Where a running cargo part actually is, or null (stopped, not cargo, or no body yet). The store's
 * live-cargo seam: a copy gesture must start from the box, not from its stale authored spawn pose. Reads
 * the per-frame `liveCargo` cache when the part is selected (the common case - you copy what you
 * picked), else falls back to the latest frame, so an unselected cargo child dragged along in a
 * duplicated subtree is rebased too.
 */
export function liveCargoPose(ec: LiveCargoDeps, id: string): LiveCargoPose | null {
  const s = ec.store.getState()
  if (!s.running) return null
  const cached = ec.liveCargo.get(id)
  if (cached) return cached
  const part = s.scene.parts.find((p) => p.id === id)
  if (!part || !isCargoPart(part) || !ec.lastFrame) return null
  return liveBoxFrom(ec, ec.lastFrame, part)
}

/** re-read the selected cargo bodies' live poses out of `frame` - internal */
export function refreshLiveCargo(ec: LiveCargoDeps, frame: BoxFrame, s: EditorState): void {
  const prev = new Map(ec.liveCargo)
  ec.liveCargo.clear()
  for (const part of ec.selectedLiveCargoParts(s)) {
    // a body adopted since this frame was built isn't in partIds yet (promoteCargoBoxes seeds
    // its pose from the pick); keep what we have rather than dropping back to the authored pose
    const pose = liveBoxFrom(ec, frame, part) ?? prev.get(part.id)
    if (pose) ec.liveCargo.set(part.id, pose)
  }
}

/** the live pose of a cargo body in a sim frame, or null if it isn't in the frame */
export function liveBoxFrom(ec: LiveCargoDeps, frame: BoxFrame, part: PartInstance): LiveCargoPose | null {
  const idx = frame.partIds.indexOf(part.id)
  if (idx < 0) return null
  const q = idx * 4
  const [rx, ry, rz] = quatToYXZ(frame.quats[q]!, frame.quats[q + 1]!, frame.quats[q + 2]!, frame.quats[q + 3]!)
  return {
    position: [frame.positions[idx * 3]!, frame.positions[idx * 3 + 1]!, frame.positions[idx * 3 + 2]!],
    rotationX: rx,
    rotationY: ry,
    rotationZ: rz,
  }
}

/** refresh the selected boxes' live poses each frame and keep their gizmo on the bodies */
export function trackSelectedBox(ec: LiveCargoDeps, frame: BoxFrame): void {
  const s = ec.store.getState()
  ec.refreshLiveCargo(frame, s)
  // not mid-drag: follow the bodies; during a drag the transient scene drives the gizmo
  if (ec.liveCargo.size > 0 && !ec.drag) ec.pushGizmo(s)
}

export function promoteCargoBox(ec: LiveCargoDeps, box: BoxPick): string | null {
  return ec.promoteCargoBoxes([box])[0] ?? null
}

/**
 * The cargo part a spawner body is promoted to: the product it was made as (the frame says, sim/frameBuild.ts), at the
 * params it was made with and its live colour. A kind-only spawn's product is worked out where it is spawned
 * (core/frame.ts kindSpawnRef). Null for a body made as no product, which stays a transient body.
 */
export function promotedAs(box: BoxPick): { packageId: string; params: Record<string, ParamValue> } | null {
  if (!box.product) return null
  const colorParam = getPackage(box.product.packageId)?.cargo?.colorParam ?? 'color'
  return { packageId: box.product.packageId, params: { ...box.product.params, [colorParam]: box.color } }
}

export function promoteCargoBoxes(ec: LiveCargoDeps, boxes: readonly BoxPick[]): string[] {
  // the cargo part each body was made as (promotedAs), at its params and live colour. `adopt` runs before the commit's
  // updateScene so no duplicate body is built, and the package is embedded into scene.packages so the promoted parts
  // stay self-contained on save. A body whose part this registry does not hold stays transient.
  if (boxes.length === 0) return []
  const s = ec.store.getState()
  const allocId = idAllocator(s.scene)
  const added: PartInstance[] = []
  const ids: string[] = []
  const used = new Map<string, NonNullable<ReturnType<typeof getPackage>>>()
  for (const box of boxes) {
    const as = promotedAs(box)
    const pkg = as ? getPackage(as.packageId) : undefined
    if (!as || !pkg) continue
    used.set(pkg.id, pkg)
    const id = allocId('part')
    ec.sim.adopt(box.frameId, id)
    const part = createSdkPart(pkg, id, box.position, box.rotationY)
    Object.assign(part.params, as.params)
    added.push(part)
    ids.push(id)
    ec.runPromotedBoxes.add(id) // born this run, not authored: Stop drops it
    // seed the live pose from the pick: the adopt above only shows up in partIds on the next
    // sim frame, so without this the gizmo would anchor off the freshly-promoted boxes for a
    // frame (and indefinitely while paused, where no frame ever arrives)
    ec.liveCargo.set(id, { position: [...box.position], rotationX: 0, rotationY: box.rotationY, rotationZ: 0 })
  }
  if (added.length === 0) return []
  const own = s.scene.packages ?? []
  // the package is embedded even in a run scene: a promoted box that the user then duplicates or drags becomes a
  // real edit, and that commit must find the package already embedded to stay self-contained on save.
  const packages = [...own, ...[...used.values()].filter((pkg) => !own.some((p) => p.id === pkg.id))]
  ec.store.setRunScene({ ...s.scene, parts: [...s.scene.parts, ...added], packages })
  return ids
}

/**
 * Select a live sim box. Authored/promoted boxes already own a part; a transient
 * spawner box is promoted into the scene (see promoteCargoBox) bound to its existing body.
 */
export function selectBox(ec: LiveCargoDeps, box: BoxPick, shift: boolean): void {
  const partId = box.partId ?? ec.promoteCargoBox(box)
  if (partId === null) return
  if (shift) ec.store.toggleSelect(partId)
  else ec.store.select(partId)
}
