import { getPackage } from '../parts/partRegistry'
import type { PartInstance } from '../types'

/**
 * Soft-parenting hierarchy helpers over the flat `parts` array. A part's `parent`
 * field holds its parent id (or is omitted for a root). These resolve children,
 * descendants, and tree order, and guard against the two ways a parent reference
 * can go wrong: dangling (parent id not present) and cyclic (a part reachable from
 * itself). Positions stay world-space; this is purely the relationship layer.
 */

/** map of parent id -> its direct children, in their `parts` array order */
function childrenByParent(parts: readonly PartInstance[]): Map<string, PartInstance[]> {
  const present = new Set(parts.map((p) => p.id))
  const byParent = new Map<string, PartInstance[]>()
  for (const p of parts) {
    const parent = p.parent
    if (parent === undefined || !present.has(parent)) continue
    const list = byParent.get(parent)
    if (list) list.push(p)
    else byParent.set(parent, [p])
  }
  return byParent
}

/** map of id -> part, for callers that walk many parent chains against one scene (later duplicates win) */
export function partsById(parts: readonly PartInstance[]): Map<string, PartInstance> {
  return new Map(parts.map((p) => [p.id, p]))
}

/** depth-first descendants of `id` (excluding `id`) appended to `out`, skipping ids already in `seen` */
function collectDescendants(byParent: Map<string, PartInstance[]>, id: string, seen: Set<string>, out: string[]): void {
  for (const child of byParent.get(id) ?? []) {
    if (seen.has(child.id)) continue // cyclic data: don't loop
    seen.add(child.id)
    out.push(child.id)
    collectDescendants(byParent, child.id, seen, out)
  }
}

/** direct children of `id`, in array order */
export function childIdsOf(parts: readonly PartInstance[], id: string): string[] {
  return parts.filter((p) => p.parent === id).map((p) => p.id)
}

/** every descendant id of `id` (depth-first, excluding `id` itself), cycle-safe */
export function descendantIds(parts: readonly PartInstance[], id: string): string[] {
  const out: string[] = []
  collectDescendants(childrenByParent(parts), id, new Set<string>([id]), out)
  return out
}

/**
 * Union of `ids` with all their descendants, deduped and returned in `parts` array
 * order. This is the rigid "moving set" for a transform (a parent carries its subtree)
 * and the set a delete/duplicate acts on.
 */
export function subtreeIds(parts: readonly PartInstance[], ids: Iterable<string>): string[] {
  // one children index and one seen set for every id: a drag calls this per frame, and a node already
  // seen has had its subtree collected, so skipping it loses nothing
  const byParent = childrenByParent(parts)
  const set = new Set<string>()
  const collected: string[] = []
  for (const id of ids) {
    if (set.has(id)) continue
    set.add(id)
    collectDescendants(byParent, id, set, collected)
  }
  return parts.filter((p) => set.has(p.id)).map((p) => p.id)
}

/**
 * Where a container node's origin belongs: the centroid of the parts filed under it.
 *
 * A `group` container has no geometry, but it is not purely organisational. It is a real transform
 * node, and `subtreeIds` makes its subtree the rigid moving set, so its origin is the pivot a
 * rotate/scale of the group turns about. An origin authored anywhere else is an invisible pivot
 * off in space that the user only discovers by surprise. Every container-creating path
 * should place the node here. Returns null for an empty member list (nothing to centre on).
 */
export function containerAnchor(members: readonly PartInstance[]): [number, number, number] | null {
  if (members.length === 0) return null
  let x = 0
  let y = 0
  let z = 0
  for (const p of members) {
    x += p.position[0]
    y += p.position[1]
    z += p.position[2]
  }
  const n = members.length
  return [x / n, y / n, z / n]
}

/**
 * Re-seat every container node in `parts` on the centroid of its direct children, deepest first so a
 * nested container is placed before the container holding it. Positions are world-space under soft
 * parenting, so re-seating a container moves nothing it contains, only the pivot. Cycle-safe;
 * containers with no children keep their authored position.
 *
 * This is the bulk form of {@link containerAnchor}, for scenes assembled members-after-container.
 */
export function reseatContainers(parts: readonly PartInstance[], isContainer: (p: PartInstance) => boolean): PartInstance[] {
  const byParent = childrenByParent(parts)
  const moved = new Map<string, [number, number, number]>()
  const byId = partsById(parts)
  // depth of a node from its root, so the walk below can go deepest-first (cycle-safe)
  const depthOf = (p: PartInstance): number => {
    const seen = new Set<string>()
    let d = 0
    let cur = p.parent
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      d++
      cur = byId.get(cur)?.parent
    }
    return d
  }
  const containers = parts.filter(isContainer).sort((a, b) => depthOf(b) - depthOf(a))
  for (const c of containers) {
    const kids = (byParent.get(c.id) ?? []).map((k) => {
      const at = moved.get(k.id)
      return at ? ({ ...k, position: at } as PartInstance) : k
    })
    const at = containerAnchor(kids)
    if (at) moved.set(c.id, at)
  }
  if (moved.size === 0) return parts.slice()
  return parts.map((p) => {
    const at = moved.get(p.id)
    return at ? ({ ...p, position: at } as PartInstance) : p
  })
}

/**
 * Ancestor ids of `nodeId`, nearest parent first, excluding `nodeId` itself. Walks up
 * the parent chain and is cycle-safe. Used to keep a focused part's containing groups
 * visible: hiding a part's ancestor would inherit-hide the part itself.
 */
export function ancestorIds(parts: readonly PartInstance[], nodeId: string): string[] {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const out: string[] = []
  const seen = new Set<string>([nodeId])
  let cur: string | undefined = byId.get(nodeId)?.parent
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = byId.get(cur)?.parent
  }
  return out
}

/**
 * is `ancestorId` an ancestor of (or equal to) `nodeId`? walks up the parent chain. A caller testing many
 * nodes against one scene passes `byId` ({@link partsById}) so the map is built once.
 */
export function isAncestor(
  parts: readonly PartInstance[],
  ancestorId: string,
  nodeId: string,
  byId: ReadonlyMap<string, PartInstance> = partsById(parts),
): boolean {
  const seen = new Set<string>()
  let cur: string | undefined = nodeId
  while (cur !== undefined) {
    if (cur === ancestorId) return true
    if (seen.has(cur)) return false // cyclic data guard
    seen.add(cur)
    cur = byId.get(cur)?.parent
  }
  return false
}

/**
 * Would re-parenting `childId` under `newParentId` create a cycle? True when the new
 * parent is the node itself or one of its own descendants (you can't drop a node into
 * its own subtree). A null/undefined target (move to root) never cycles. Pass `byId` ({@link partsById})
 * when checking many parts against one scene.
 */
export function wouldCreateCycle(
  parts: readonly PartInstance[],
  childId: string,
  newParentId: string | null,
  byId?: ReadonlyMap<string, PartInstance>,
): boolean {
  if (newParentId === null) return false
  return isAncestor(parts, childId, newParentId, byId)
}

/**
 * Return a copy of `parts` with invalid parent refs stripped to undefined: a parent
 * id that isn't present (dangling), or one that would make the part its own ancestor
 * (cyclic). Used on load so a hand-edited or stale scene degrades to a valid tree
 * (offenders become roots) rather than breaking the editor.
 */
export function sanitizeParents(parts: readonly PartInstance[]): PartInstance[] {
  const present = new Set(parts.map((p) => p.id))
  let changed = false
  const cleaned = parts.map((p) => {
    if (p.parent === undefined) return p
    const dangling = !present.has(p.parent)
    if (dangling) {
      changed = true
      const rest = { ...p }
      delete rest.parent
      return rest as PartInstance
    }
    return p
  })
  // second pass: break any remaining cycles (a part reachable from itself). Every check reads `cleaned`,
  // not the parts this pass has already cut loose, so one map serves them all.
  const cleanedById = partsById(cleaned)
  const final = cleaned.map((p) => {
    if (p.parent !== undefined && isAncestor(cleaned, p.id, p.parent, cleanedById)) {
      changed = true
      const rest = { ...p }
      delete rest.parent
      return rest as PartInstance
    }
    return p
  })
  return changed ? final : parts.slice()
}

/**
 * Grouped-subtree click redirect: walking from `id` up to the root, returns the topmost
 * ancestor (or `id` itself) that is flagged `grouped` or is a unit load. With none, `id` is returned
 * unchanged. So clicking a part inside a grouped subtree selects the group's root, and clicking a case of a unit
 * load selects the load. Pass `byId` ({@link partsById}) when redirecting many hits against one scene.
 */
export function groupRoot(
  parts: readonly PartInstance[],
  id: string,
  byId: ReadonlyMap<string, PartInstance> = partsById(parts),
): string {
  const seen = new Set<string>()
  let selected = id
  let cur: string | undefined = id
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur)
    const p = byId.get(cur)
    // a unit load (its package declares `unit`) is one product: it selects and drags as a group without asking
    if (p?.grouped || (p?.type === 'part' && getPackage(p.packageId)?.unit !== undefined)) selected = cur
    cur = p?.parent
  }
  return selected
}

/**
 * Set of part ids that are *effectively* hidden: a part with `visible === false`,
 * or any part with such an ancestor (visibility is inherited down the tree).
 * Cycle-safe. Visual/picking only; the sim is unaffected.
 */
export function effectivelyHiddenSet(parts: readonly PartInstance[]): Set<string> {
  const byId = new Map(parts.map((p) => [p.id, p]))
  const memo = new Map<string, boolean>()
  const hidden = (id: string, stack: Set<string>): boolean => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const p = byId.get(id)
    let result: boolean
    if (!p) result = false
    else if (p.visible === false) result = true
    else if (p.parent === undefined || stack.has(id)) result = false // root or cyclic
    else {
      stack.add(id)
      result = hidden(p.parent, stack)
      stack.delete(id)
    }
    memo.set(id, result)
    return result
  }
  const out = new Set<string>()
  for (const p of parts) if (hidden(p.id, new Set())) out.add(p.id)
  return out
}

export interface TreeRow {
  part: PartInstance
  depth: number
  hasChildren: boolean
}

/**
 * Pre-order walk of the forest for tree rendering: roots (no parent, or a parent that
 * isn't present) in array order, each immediately followed by its subtree, with depth.
 * Cycle-safe. `isCollapsed` prunes a row's subtree from the output (but the row still
 * reports hasChildren so a caret can show).
 */
export function orderedTree(
  parts: readonly PartInstance[],
  isCollapsed?: (id: string) => boolean,
): TreeRow[] {
  const byParent = childrenByParent(parts)
  const present = new Set(parts.map((p) => p.id))
  const isRoot = (p: PartInstance) => p.parent === undefined || !present.has(p.parent)
  // reachability from roots, ignoring collapse, so the leftover pass below can tell
  // a collapse-hidden node (reachable) apart from a cycle-orphaned one (unreachable)
  const reachable = new Set<string>()
  const mark = (id: string): void => {
    if (reachable.has(id)) return
    reachable.add(id)
    for (const child of byParent.get(id) ?? []) mark(child.id)
  }
  for (const p of parts) if (isRoot(p)) mark(p.id)

  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const emit = (part: PartInstance, depth: number): void => {
    if (seen.has(part.id)) return // cyclic data guard
    seen.add(part.id)
    const children = byParent.get(part.id) ?? []
    rows.push({ part, depth, hasChildren: children.length > 0 })
    if (isCollapsed?.(part.id)) return
    for (const child of children) emit(child, depth + 1)
  }
  for (const p of parts) if (isRoot(p)) emit(p, 0)
  // any part not reachable from a root (only possible with cyclic data, which
  // sanitizeParents normally prevents) still renders, so nothing vanishes
  for (const p of parts) if (!reachable.has(p.id)) emit(p, 0)
  return rows
}
