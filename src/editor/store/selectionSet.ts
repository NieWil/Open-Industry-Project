// The selection as a Set, for "is this part selected" tests made once per part or per tree row. With
// `selectedIds.includes` each of those scans the whole selection, so a band-select of a few hundred parts made
// hover, tree rendering and the Inspector quadratic. The store replaces `selectedIds` with a new array on every
// change and never edits one in place, so a Set built once per array stays correct; the WeakMap lets an old
// selection's Set go with its array.
const cache = new WeakMap<readonly string[], ReadonlySet<string>>()

export function selectionSet(selectedIds: readonly string[]): ReadonlySet<string> {
  let set = cache.get(selectedIds)
  if (!set) {
    set = new Set(selectedIds)
    cache.set(selectedIds, set)
  }
  return set
}
