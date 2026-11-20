// A part's human-facing display name for the scene tree, breadcrumb, inspector and select menu.
//
// A part's `id` (e.g. `cp_1`) is an internal, unique, stable key - it keys physics bodies, PLC tags, view
// entries, joint routing and undo. It is not a label: showing it would make every freshly placed part read as
// "cp_1" in the tree. An unnamed part is labelled by its type (a custom part by its package name, "Belt Conveyor",
// a built-in by its PART_DEFS label), with a trailing number when several unnamed siblings share that base
// ("Belt Conveyor", "Belt Conveyor 2", "Belt Conveyor 3"). A user-given name always takes precedence.
//
// This is display-only: it never touches the id or the stored `name`, which stays absent until the user sets
// one (the Inspector still surfaces the id and offers this name as the Name field's placeholder).

import { getPackage } from './partRegistry'
import type { SdkPart, PartInstance } from '../types'
import { PART_DEFS } from '../types'

/** The type-derived base label for a part, with no disambiguation: a custom part's package name (or 'Part'
 *  when the package isn't registered), else the built-in PART_DEFS label. */
export function partTypeName(part: PartInstance): string {
  if (part.type === 'part') return getPackage((part as SdkPart).packageId)?.name ?? 'Part'
  return PART_DEFS[part.type].label
}

/** A display name unique within `used`: `desired` if it's free, else the smallest " N" suffix
 *  (N ≥ 2) not already taken - "Belt" → "Belt 2", "Belt 2" → "Belt 3". `used` holds the names already claimed
 *  by the parts we're deduping against. The primitive; callers pick the scope by what they put in `used`
 *  (see uniqueSiblingName for the sibling scope the rename rule uses). */
export function uniqueName(used: ReadonlySet<string>, desired: string): string {
  if (!used.has(desired)) return desired
  const m = /^(.*\S) (\d+)$/.exec(desired)
  const base = m ? m[1]! : desired
  let num = m ? parseInt(m[2]!, 10) + 1 : 2
  let candidate = `${base} ${num}`
  while (used.has(candidate)) candidate = `${base} ${++num}`
  return candidate
}

/** A name unique among a part's siblings: the other parts under the same `parent` (names must
 *  differ within a branch, but the same label may recur in different branches, so two cells can each hold a
 *  "Start"). `exceptId` skips the part being renamed itself. This is the dedupe the rename seam + the demo
 *  author apply; identity is still the `id`, this only shapes the display `name`. */
export function uniqueSiblingName(
  parts: readonly PartInstance[],
  parent: string | undefined,
  desired: string,
  exceptId?: string,
): string {
  const used = new Set<string>()
  for (const p of parts) {
    if (p.id === exceptId || p.parent !== parent) continue
    if (p.name) used.add(p.name)
  }
  return uniqueName(used, desired)
}

/** The label to show for a part. A non-empty user-given `name` is used; otherwise the type name, numbered when
 *  it collides with other unnamed siblings of the same type (in scene order; 1 = no suffix).
 *  `parts` is the set the number is scoped over - pass the whole scene so every call site agrees. */
export function partDisplayName(part: PartInstance, parts: readonly PartInstance[]): string {
  const explicit = part.name?.trim()
  if (explicit) return explicit
  const base = partTypeName(part)
  // number only among the unnamed same-type parts: a renamed sibling stops occupying the base label,
  // so the last remaining unnamed one reads cleanly as "Belt Conveyor" rather than "Belt Conveyor 2".
  const unnamed = parts.filter((p) => !p.name?.trim() && partTypeName(p) === base)
  if (unnamed.length <= 1) return base
  const idx = unnamed.findIndex((p) => p.id === part.id)
  return idx <= 0 ? base : `${base} ${idx + 1}`
}

/** {@link partDisplayName} for every part at once, id → label, in one pass. The single-part form scans
 *  the whole scene per call, so a caller labelling (or filtering) every part would take O(n²). */
export function partDisplayNames(parts: readonly PartInstance[]): Map<string, string> {
  const out = new Map<string, string>()
  const seen = new Map<string, number>() // type base → unnamed parts of that base so far
  for (const p of parts) {
    const explicit = p.name?.trim()
    let label: string
    if (explicit) label = explicit
    else {
      const base = partTypeName(p)
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      label = n === 1 ? base : `${base} ${n}`
    }
    // a duplicated id keeps its first occurrence's label (partDisplayName's findIndex) but still
    // occupies a number, exactly as it does in that scan
    if (!out.has(p.id)) out.set(p.id, label)
  }
  return out
}
