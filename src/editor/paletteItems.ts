/**
 * What the command palette can find, and how it ranks it.
 *
 * It finds scene parts and catalog packages as well as commands. Otherwise, in a 300-part scene, finding
 * "that diverter" or placing a spur means the Scene tree's filter box or the Parts catalog's tabs,
 * both with the mouse.
 *
 * Pure and DOM-free so the ranking is testable. With ~30 commands, ~300 scene parts and ~40 catalog
 * packages in one list, the ranking decides whether results are usable. A plain subsequence filter
 * matches "Delete" for the query "dt" and buries an exact "Diverter", so
 * every result set past a two-letter query reads as noise.
 *
 * The scoring is simple and predictable, since people stop using a palette they cannot predict.
 * An exact label ranks first, then a prefix, then a word-start, then a contiguous run, then a
 * scattered subsequence. Within a tier, shorter labels come first. Kind only breaks ties (commands,
 * then scene parts, then catalog) and never boosts a score: typing a part's exact name
 * must not lose to a command that merely contains those letters.
 */

/** where a row came from - drives the group chip, the tie-break, and what activating it does */
export type PaletteKind = 'command' | 'part' | 'catalog'

export interface PaletteItem {
  /** stable React key; unique across kinds */
  readonly key: string
  readonly kind: PaletteKind
  /** the chip on the left: a command's group, or 'Scene' / 'Parts' */
  readonly group: string
  readonly label: string
  /** the English label when the shown one is translated, so the name in the docs and tutorials still finds the row */
  readonly alias?: string
  /** right-hand column: a chord for a command, a part type for a scene row */
  readonly detail?: string
  /** greyed and unselectable (a command whose enablement says no) */
  readonly disabled?: boolean
  /** why it is greyed, when the command can explain itself (Command.disabledReason) - shown as a tooltip */
  readonly reason?: string
  /** what activating it targets - a command id, a part id, or a package/type to place */
  readonly target: PaletteTarget
}

export type PaletteTarget =
  | { readonly kind: 'command'; readonly id: string }
  | { readonly kind: 'part'; readonly id: string }
  | { readonly kind: 'catalog'; readonly type: string; readonly packageId?: string }

/** the English source as a row's alias, only when it differs from what the row shows */
export function englishAlias(shown: string, english: string | undefined): string | undefined {
  return english === undefined || english === shown ? undefined : english
}

/** Bigger is better. Null means no match at all. */
export function scoreMatch(haystack: string, needle: string): number | null {
  if (needle === '') return 0
  const hay = haystack.toLowerCase()
  const q = needle.toLowerCase()
  if (hay === q) return 1000
  if (hay.startsWith(q)) return 900
  // a word start: "sp" finds "Curved Spur", which a plain startsWith misses
  for (let i = 1; i < hay.length; i++) {
    const prev = hay.charCodeAt(i - 1)
    const isBoundary = prev === 32 || prev === 45 || prev === 46 || prev === 95 // space - . _
    if (isBoundary && hay.startsWith(q, i)) return 800
  }
  if (hay.includes(q)) return 700
  // scattered subsequence, always scored beneath a contiguous hit
  let i = 0
  let spread = 0
  for (const ch of q) {
    const at = hay.indexOf(ch, i)
    if (at < 0) return null
    spread += at - i
    i = at + 1
  }
  // a tighter scatter is a better guess than a wide one ("dt" over "Delete" scores worse than over "Duplicate")
  return Math.max(1, 500 - spread)
}

/** later tiers lose ties - see the header: kind is a tie-break, never a boost */
const KIND_RANK: Record<PaletteKind, number> = { command: 0, part: 1, catalog: 2 }

/**
 * Rank and cut. `perKindCap` keeps one populous kind from crowding the others out: a scene with 300
 * parts would otherwise fill every visible row with parts on a one-letter query and hide the
 * commands entirely.
 */
export function rankPaletteItems(items: readonly PaletteItem[], query: string, perKindCap = 8): PaletteItem[] {
  const q = query.trim()
  const scored: { item: PaletteItem; score: number }[] = []
  for (const item of items) {
    // the group is searchable too, so "view problems" finds the View command
    const score = Math.max(
      scoreMatch(item.label, q) ?? -1,
      q === '' ? -1 : (scoreMatch(`${item.group} ${item.label}`, q) ?? -1) - 50,
      // one point under the shown label's tier: an equal hit on the shown text wins the tie
      q === '' || item.alias === undefined ? -1 : (scoreMatch(item.alias, q) ?? 0) - 1,
    )
    if (score >= 0) scored.push({ item, score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.item.kind !== b.item.kind) return KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind]
    if (a.item.label.length !== b.item.label.length) return a.item.label.length - b.item.label.length
    return a.item.label.localeCompare(b.item.label)
  })
  // Commands are not capped: the list is small and fixed.
  // A disabled command stays visible and greyed. "Stop is there but not available right now"
  // answers a question that an absent row leaves open.
  const kept: PaletteItem[] = []
  const used: Record<string, number> = {}
  for (const { item } of scored) {
    if (item.kind !== 'command') {
      const n = used[item.kind] ?? 0
      if (n >= perKindCap) continue
      used[item.kind] = n + 1
    }
    kept.push(item)
  }
  return kept
}
