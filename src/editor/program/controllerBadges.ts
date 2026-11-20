// Which Scene tree rows name a controller (`Cell2::%IX0.0`, core/io/controllerTag.ts), kept quiet: the default
// controller is never named, and a group whose tagged parts are all on one controller is named once, on the group's
// row, with nothing on the rows inside. A row inside is named only where it differs from its group, which is the part
// worth spotting: one wired to another PLC than the cell it sits in. A part whose own tags are on two controllers is
// always named, with every named controller it uses.

import type { PartInstance } from '../../core/types'
import { tagControllers } from './assignController'

/** The controllers a set holds, as one key: null for the default one. */
type Cs = (string | null)[]

const one = (cs: Cs): string | null | undefined => (cs.length === 1 ? cs[0] : undefined)

/**
 * The badge each part's row shows, by part id: the controller's name, or the named controllers of a part whose tags
 * disagree joined by ' · '. Rows with no badge are left out. `flat` is the filtered view, where rows have no group
 * to inherit from, so every row on a named controller is named.
 */
export function controllerBadges(parts: readonly PartInstance[], flat = false): Map<string, string> {
  const own = new Map<string, Cs>()
  for (const p of parts) own.set(p.id, tagControllers([p]))
  const out = new Map<string, string>()
  const named = (cs: Cs): string => cs.filter((c): c is string => c !== null).join(' · ')
  if (flat) {
    for (const [id, cs] of own) if (named(cs) !== '') out.set(id, named(cs))
    return out
  }
  // every subtree's controllers: its own tags' and every descendant's
  const children = new Map<string, string[]>()
  const ids = new Set(parts.map((p) => p.id))
  for (const p of parts) if (p.parent && ids.has(p.parent)) children.set(p.parent, [...(children.get(p.parent) ?? []), p.id])
  const sub = new Map<string, Cs>()
  const subOf = (id: string, seen: Set<string>): Cs => {
    const done = sub.get(id)
    if (done) return done
    const cs = [...own.get(id)!]
    // a parent loop is malformed and is not followed round again
    if (!seen.has(id)) {
      seen.add(id)
      for (const c of children.get(id) ?? []) for (const x of subOf(c, seen)) if (!cs.includes(x)) cs.push(x)
    }
    sub.set(id, cs)
    return cs
  }
  for (const p of parts) {
    const mine = own.get(p.id)!
    if (mine.length > 1 && named(mine) !== '') {
      out.set(p.id, named(mine))
      continue
    }
    const c = one(subOf(p.id, new Set()))
    if (typeof c !== 'string') continue
    const parent = p.parent && ids.has(p.parent) ? one(subOf(p.parent, new Set())) : undefined
    if (parent !== c) out.set(p.id, c)
  }
  return out
}
