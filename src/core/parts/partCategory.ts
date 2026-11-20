// A part's catalog category. `category` is a free string in a part's definition: the four standard names are
// matched whatever their case, and any other name is a category of its own. A category exists only because a
// part names it, so there is no list of categories to keep and no empty one to show.

import type { PartDef } from '../types'
import { editDistance } from '../editDistance'

/** The standard categories, in catalog order. Other categories follow them alphabetically. */
export const PART_CATEGORIES: readonly PartDef['category'][] = ['Equipment', 'Devices', 'Products', 'Structure']

/** True for one of the four standard categories, spelled as the app spells it. */
export function isStandardCategory(name: string): name is PartDef['category'] {
  return (PART_CATEGORIES as readonly string[]).includes(name)
}

/** One key per category, so spellings that differ only in case share a tab. */
export function categoryKey(name: string): string {
  return name.trim().toLowerCase()
}

/** True when two names are the same category. */
export function sameCategory(a: string, b: string): boolean {
  return categoryKey(a) === categoryKey(b)
}

/**
 * The category a part files under: a standard name in the app's spelling, else the part's own name trimmed, else
 * Equipment for a part that names none. The catalog tabs and the Scene dock's row glyphs both read it.
 */
export function packageCategory(pkg: { category?: string } | undefined): string {
  const declared = pkg?.category?.trim() ?? ''
  if (declared === '') return 'Equipment'
  return PART_CATEGORIES.find((c) => sameCategory(c, declared)) ?? declared
}

/**
 * The catalog's tabs for these names: the standard categories first in their order, then the others alphabetically,
 * one per category. Of the spellings of one category the first given is kept.
 */
export function categoryOrder(names: Iterable<string>): string[] {
  const byKey = new Map<string, string>()
  for (const n of names) {
    const name = n.trim()
    if (name !== '' && !byKey.has(categoryKey(name))) byKey.set(categoryKey(name), name)
  }
  const standard = PART_CATEGORIES.filter((c) => byKey.has(categoryKey(c)))
  const others = [...byKey.entries()]
    .filter(([key]) => !PART_CATEGORIES.some((c) => categoryKey(c) === key))
    .map(([, name]) => name)
    .sort((a, b) => a.localeCompare(b))
  return [...standard, ...others]
}

/**
 * A known category `name` is probably a misspelling of, or undefined. "Device" next to "Devices" would otherwise
 * make a tab of its own; this is a warning, never a refusal, since a near name can be meant. Names of four letters
 * or fewer are left alone, where one letter is too large a share of the word to call it a typo.
 */
export function nearCategory(name: string, known: Iterable<string>): string | undefined {
  const key = categoryKey(name)
  if (key.length <= 4) return undefined
  for (const k of known) {
    const other = categoryKey(k)
    if (other === key) return undefined
  }
  for (const k of known) {
    const other = categoryKey(k)
    if (other.length > 4 && editDistance(key, other) <= (Math.max(key.length, other.length) >= 9 ? 2 : 1)) return k.trim()
  }
  return undefined
}
