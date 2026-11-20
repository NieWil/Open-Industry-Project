// The selection-outline membership for the view: selection subtree + active
// tier, the author-mode rig-link highlight, and the per-instance selection tiers.

import type { Object3D } from 'three'
import { subtreeIds } from '../../core/scene/hierarchy'
import type { RenderView } from './view'

/** the outline membership's own state (`view.outlineState`) */
export class ViewOutlineState {
  // Signature of the last outline membership refreshOutline computed (selection + order, rig
  // highlight, structureRev). null forces the first refresh; refreshPackage passes force to bypass.
  sig: string | null = null
  // author mode: a single internal rig link outlined for read-only inspection (the Scene-dock/viewport
  // rig-node selection). Separate from `selection`: it outlines one link group, not a whole part entry.
  rigHighlight: { partId: string; linkName: string } | null = null
}

/** what the outline membership reaches on the view beyond its own {@link ViewOutlineState} */
export type OutlineHost = Pick<
  RenderView,
  | 'boxes'
  | 'entries'
  | 'instancePool'
  | 'lastScene'
  | 'maskMerge'
  | 'outline'
  | 'outlineState'
  | 'selection'
  | 'structureRev'
  | 'warm'
>

export function refreshOutline(view: OutlineHost, force = false): void {
  // The outline set is a pure function of the selection (with order: the last id is the
  // active/hot tier), the author-mode rig highlight, and the scene's parent structure (which
  // decides subtree membership + whether a lone selection carries descendants). A transform
  // drag changes none of these: it moves parts under the same stable visual roots, which
  // OutlinePass re-traverses live every frame. So re-deriving the set each transient frame is
  // wasted work (subtreeIds rebuilds childrenByParent once per selected id, O(K×N)). Skip when
  // the membership signature is unchanged; refreshPackage forces past it (it rebuilds the rig's
  // internal meshes, which the rig-highlight tier holds by reference, without moving the sig).
  const sig = `${[...view.selection].join(',')}|${view.outlineState.rigHighlight?.partId ?? ''}:${view.outlineState.rigHighlight?.linkName ?? ''}|${view.structureRev}`
  if (!force && sig === view.outlineState.sig) return
  view.outlineState.sig = sig
  const objects: Object3D[] = []
  const active: Object3D[] = []
  // Soft parenting: selecting a parent selects the whole editing unit, so outline the entire
  // subtree (selection + descendants), so what is lit is exactly what a move/rotate/delete
  // carries. This also gives a mesh-less Group node visible feedback (its children light up).
  // No-op for a childless selection: subtreeIds returns just the selected ids.
  const selected = [...view.selection]
  const subtree = subtreeIds(view.lastScene?.parts ?? [], view.selection)
  // The "active" (hot, brighter) tier marks the node you actually clicked vs. nodes that are
  // merely carried: the last id in a multi-selection (the active node, the Shift+G pivot),
  // or, when a single selection drags descendants along, the selected root itself, so the
  // anchor stands out from its subtree. A lone childless selection keeps the regular orange.
  const carryingDescendants = subtree.length > selected.length
  const activeId =
    selected.length > 1 ? selected[selected.length - 1]
    : selected.length === 1 && carryingDescendants ? selected[0]
    : undefined
  for (const id of subtree) {
    const entry = view.entries.get(id)
    if (!entry) continue
    // a warming/budget-held part is root-invisible, but the outline mask pass un-hides its own
    // sources. Including a held clone here would force its whole first-draw codegen (main +
    // shadow + mask variants per instanced bank) onto the commit frame: the bulk-duplicate
    // freeze the reveal budget staggers. Skip while held; the reveal drain's forced
    // refreshOutline (drainRevealQueue) folds it in once it's actually visible.
    if (view.warm.warming.has(id)) continue
    if (id === activeId) active.push(entry.visual.object)
    else objects.push(entry.visual.object)
  }
  // author mode: outline the picked rig link on the active (brighter) tier, just its own meshes
  if (view.outlineState.rigHighlight) {
    const entry = view.entries.get(view.outlineState.rigHighlight.partId)
    const grp = entry ? findLinkGroup(entry.visual.object, view.outlineState.rigHighlight.linkName) : null
    if (grp) active.push(...linkOwnMeshes(grp))
  }
  view.outline?.select(objects, active)
  // Palette-merged mask: the selection's unique meshes bake into one merged mesh (drawn by the
  // outline twins). Same live root arrays the outline got; the merge classifies mergeable vs
  // leftover (InstancedMesh/skinned) itself. Gated on the same membership sig as everything here.
  view.maskMerge?.setMembership(objects, active)
  // Per-instance selection channel: a selected part's pooled hardware outlines via the pool
  // meshes' aSel rows (the consolidated mask discards unselected instances), so pool membership
  // never moves on selection. Same sig gate as the rest of this method.
  const tiers = new Map<string, number>()
  for (const id of subtree) tiers.set(id, 1)
  if (activeId !== undefined) tiers.set(activeId, 2)
  view.instancePool?.setSelectionTiers(tiers)
  // Same channel on the cargo batches: selected boxes/pallets outline via SimBoxes' aSel rows,
  // staying inside the instanced batch.
  view.boxes.setSelectionTiers(tiers)
}

/** find the link group (userData.linkName) for a name inside a part's visual object, or null */
export function findLinkGroup(root: Object3D, linkName: string): Object3D | null {
  let found: Object3D | null = null
  root.traverse((o) => {
    if (!found && o.userData.linkName === linkName) found = o
  })
  return found
}

/** a link's own renderables: every descendant up to (but not into) any child that begins another link. A
 *  banked link (linkBank.ts) has none of its own; it outlines the bank that draws it, siblings included. */
export function linkOwnMeshes(linkGroup: Object3D): Object3D[] {
  const out: Object3D[] = []
  const bank = linkGroup.userData.drawnBy as Object3D | undefined
  if (bank) out.push(bank)
  const walk = (o: Object3D): void => {
    for (const c of o.children) {
      if (typeof c.userData.linkName === 'string') continue // a child link starts its own node
      out.push(c)
      walk(c)
    }
  }
  walk(linkGroup)
  return out
}
