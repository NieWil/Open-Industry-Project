// The gestures of a ladder editor, as transforms on rungs: the rung core of the ladder.
//
// Here rather than in the view for the reason document.ts gives for its own edits: these are
// transforms on a model, not UI, so they are portable, deterministic and unit-testable without a
// browser. The view supplies the clicks and keeps nothing: every function takes the rungs and a
// selection and hands back new rungs and where the selection went, and the rungs are then printed
// into the program's text (ladderRungs.ts `writeLadder`). Nothing in it reads what an element is - a
// contact, coil or box - only series and branches, so it is generic over the leaf the rungs hold
// (`RungOf<L>`), and what touches a leaf lives beside the leaf (ladderRungs.ts `setField`).

/** A branch: two or more paths in parallel, each a series of elements. */
export interface RungBranchOf<L> {
  type: 'branch'
  paths: RungElementOf<L>[][]
}

/** What stands on a series: a family's leaf, or a branch of them. */
export type RungElementOf<L> = L | RungBranchOf<L>

export interface RungOf<L> {
  /** the comment written above the rung, as plain lines; `''` for none */
  comment: string
  elements: RungElementOf<L>[]
  /** the rung's label, where a jump lands (IEC: `Next: ...`) */
  label?: string
  /** how the rung ends after its elements: a jump to a label, or a RETURN (IEC: `>>Next`, `RETURN`) */
  exit?: { kind: 'jump'; label: string } | { kind: 'return' }
}

/** Is `el` a branch (and not a leaf)? A family's leaf never has the type 'branch'. */
export const isBranch = <L>(el: RungElementOf<L> | null | undefined): el is RungBranchOf<L> => !!el && (el as { type?: unknown }).type === 'branch'

/**
 * What is selected on a rung.
 *
 * `trail` walks down from the rung's own series: an element index, then (a path index, an element
 * index) for every branch entered. So `[2]` is the third element, `[2, 1]` the second path of the
 * branch standing there, `[2, 1, 0]` the first element on that path. Empty selects the rung itself.
 */
export interface LadderSel {
  rung: number
  trail: number[]
}

export interface LadderEdit<L> {
  rungs: RungOf<L>[]
  sel: LadderSel | null
}

export const selKind = (sel: LadderSel): 'rung' | 'element' | 'path' => (sel.trail.length === 0 ? 'rung' : sel.trail.length % 2 === 1 ? 'element' : 'path')

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The series a trail of even length ends in: `[]` is the rung's own, `[e, p]` a branch path. */
function seriesAt<L>(rung: RungOf<L>, trail: readonly number[]): RungElementOf<L>[] | null {
  let series = rung.elements
  for (let i = 0; i + 1 < trail.length; i += 2) {
    const el = series[trail[i]!]
    if (!isBranch(el)) return null
    const path = el.paths[trail[i + 1]!]
    if (!path) return null
    series = path
  }
  return series
}

/** Every element of a series that is not a branch, in reading order - left to right, and through a branch level by
 *  level - as trails. */
function instructionTrails<L>(series: readonly RungElementOf<L>[], home: readonly number[] = []): number[][] {
  return series.flatMap((el, i) => (!isBranch(el) ? [[...home, i]] : el.paths.flatMap((path, p) => instructionTrails(path, [...home, i, p]))))
}

/**
 * Where Left / Right goes from `sel`: the neighbouring instruction in reading order, through branches (their levels in
 * turn) and off the end of the rung onto the next one - Right from a rung's last instruction is the first instruction
 * of the rung below, Left from its first the last of the rung above. So the two keys alone walk a whole routine.
 *
 * A rung with no instruction on it is a stop of its own (the rung itself is selected there), or the keys would skip
 * the very rung being built. Null at either end of the routine, and for a selection the keys do not move.
 */
export function stepInstruction<L>(rungs: readonly RungOf<L>[], sel: LadderSel, by: -1 | 1): LadderSel | null {
  // every stop of the routine, in order: each rung's instructions, or the rung itself when it has none
  const stops: LadderSel[] = rungs.flatMap((rung, r) => {
    const trails = instructionTrails(rung.elements)
    return trails.length > 0 ? trails.map((trail) => ({ rung: r, trail })) : [{ rung: r, trail: [] }]
  })
  const same = (a: LadderSel): boolean => a.rung === sel.rung && a.trail.length === sel.trail.length && a.trail.every((n, i) => n === sel.trail[i])
  let at = stops.findIndex(same)
  if (at < 0) {
    // not on a stop (a rung with instructions selected as a whole, a branch, a level): enter from its near edge -
    // Right onto the first stop at or under the selection, Left onto the last one before it
    const under = (s: LadderSel): boolean => s.rung === sel.rung && sel.trail.every((n, i) => n === s.trail[i])
    const inside = stops.map((s, i) => (under(s) ? i : -1)).filter((i) => i >= 0)
    if (inside.length === 0) return null
    return by === 1 ? stops[inside[0]!]! : (stops[inside[0]! - 1] ?? null)
  }
  at += by
  return stops[at] ?? null
}

export function elementAt<L>(rungs: readonly RungOf<L>[], sel: LadderSel): RungElementOf<L> | null {
  const rung = rungs[sel.rung]
  if (!rung || selKind(sel) !== 'element') return null
  return seriesAt(rung, sel.trail.slice(0, -1))?.[sel.trail[sel.trail.length - 1]!] ?? null
}

/** Put `el` where the selection says: after a selected element; at the start of a selected rung or
 *  branch level (and the new element is then the selection, so the
 *  next one follows it). */
function place<L>(rungs: RungOf<L>[], sel: LadderSel, el: RungElementOf<L>): LadderSel | null {
  const rung = rungs[sel.rung]
  if (!rung) return null
  const onElement = selKind(sel) === 'element'
  const home = onElement ? sel.trail.slice(0, -1) : sel.trail
  const series = seriesAt(rung, home)
  if (!series) return null
  const at = onElement ? sel.trail[sel.trail.length - 1]! + 1 : 0
  series.splice(at, 0, el)
  return { rung: sel.rung, trail: [...home, at] }
}

/** A place to drop: a series (`home`, as a trail of even length) of rung `rung`, and an index in it. */
export interface DropSlot {
  rung: number
  home: number[]
  index: number
}

/** Whether `slot` lies inside the element at `from` (a branch cannot be dropped into itself). */
export function slotInside(from: LadderSel, slot: DropSlot): boolean {
  return from.rung === slot.rung && slot.home.length > from.trail.length && from.trail.every((n, i) => n === slot.home[i])
}

/** The selected element moved to `slot` (drag and drop), and selected there. */
export function moveElement<L>(rungs: readonly RungOf<L>[], from: LadderSel, slot: DropSlot): LadderEdit<L> {
  if (selKind(from) !== 'element' || slotInside(from, slot)) return { rungs: [...rungs], sel: from }
  const next = copy(rungs) as RungOf<L>[]
  const source = next[from.rung] && seriesAt(next[from.rung]!, from.trail.slice(0, -1))
  const target = next[slot.rung] && seriesAt(next[slot.rung]!, slot.home)
  if (!source || !target) return { rungs: [...rungs], sel: from }
  const i = from.trail[from.trail.length - 1]!
  let at = Math.max(0, Math.min(slot.index, target.length))
  // leaving its own series shifts what follows; landing where it stood is no move at all
  if (source === target) {
    if (at === i || at === i + 1) return { rungs: [...rungs], sel: from }
    if (at > i) at--
  }
  const [el] = source.splice(i, 1)
  target.splice(at, 0, el!)
  return { rungs: next, sel: { rung: slot.rung, trail: [...slot.home, at] } }
}

/** A new element where the selection says: after a selected element, at the start of a selected rung or level. */
export function insertItem<L>(rungs: readonly RungOf<L>[], sel: LadderSel, item: L): LadderEdit<L> {
  const next = copy(rungs) as RungOf<L>[]
  const at = place(next, sel, copy(item))
  return at ? { rungs: next, sel: at } : { rungs: [...rungs], sel }
}

/** Paste: `els` where the selection says (as {@link insertItem}), the last of them selected. */
export function insertElements<L>(rungs: readonly RungOf<L>[], sel: LadderSel, els: readonly RungElementOf<L>[]): LadderEdit<L> {
  const next = copy(rungs) as RungOf<L>[]
  let at: LadderSel | null = sel
  for (const el of copy(els)) {
    at = place(next, at, el)
    if (!at) return { rungs: [...rungs], sel }
  }
  return { rungs: next, sel: at }
}

/** Paste: whole rungs below rung `after` (-1 for the top), the last of them selected. */
export function insertRungs<L>(rungs: readonly RungOf<L>[], after: number, added: readonly RungOf<L>[]): LadderEdit<L> {
  if (added.length === 0) return { rungs: [...rungs], sel: null }
  const next = copy(rungs) as RungOf<L>[]
  const at = Math.max(0, Math.min(after + 1, next.length))
  next.splice(at, 0, ...copy(added))
  return { rungs: next, sel: { rung: at + added.length - 1, trail: [] } }
}

/** `count` whole rungs from `first` on, removed (a Shift-selected run of rungs). The rung that takes their place is selected. */
export function removeRungs<L>(rungs: readonly RungOf<L>[], first: number, count: number): LadderEdit<L> {
  const next = copy(rungs) as RungOf<L>[]
  next.splice(first, count)
  return { rungs: next, sel: next.length === 0 ? null : { rung: Math.min(first, next.length - 1), trail: [] } }
}

/** How many elements stand in the series `sel` is in (so a Shift+arrow knows where the series ends). */
export function seriesLength<L>(rungs: readonly RungOf<L>[], sel: LadderSel): number {
  const rung = rungs[sel.rung]
  if (!rung || selKind(sel) !== 'element') return 0
  return seriesAt(rung, sel.trail.slice(0, -1))?.length ?? 0
}

/** The `count` elements from the selected one on, in its series (a Shift-click range); `[]` off an element. */
export function elementRange<L>(rungs: readonly RungOf<L>[], sel: LadderSel, count: number): RungElementOf<L>[] {
  const rung = rungs[sel.rung]
  if (!rung || selKind(sel) !== 'element') return []
  const series = seriesAt(rung, sel.trail.slice(0, -1))
  const i = sel.trail[sel.trail.length - 1]!
  return series ? series.slice(i, i + count) : []
}

/** Rung `index` retyped as text: its elements replaced, its comment kept. */
export function replaceRung<L>(rungs: readonly RungOf<L>[], index: number, els: readonly RungElementOf<L>[], ends?: Pick<RungOf<L>, 'label' | 'exit'>): LadderEdit<L> {
  if (!rungs[index]) return { rungs: [...rungs], sel: null }
  const next = copy(rungs) as RungOf<L>[]
  const rung = next[index]!
  rung.elements = copy(els) as RungElementOf<L>[]
  // retyped whole, the rung's label and its jump or RETURN are what the text now says: gone when it no longer says them
  if (ends) {
    if (ends.label) rung.label = ends.label
    else delete rung.label
    if (ends.exit) rung.exit = { ...ends.exit }
    else delete rung.exit
  }
  return { rungs: next, sel: { rung: index, trail: [] } }
}

/** Delete the `count` elements from the selected one on. */
export function removeRange<L>(rungs: readonly RungOf<L>[], sel: LadderSel, count: number): LadderEdit<L> {
  if (selKind(sel) !== 'element' || count <= 1) return removeSelected(rungs, sel)
  const next = copy(rungs) as RungOf<L>[]
  const home = sel.trail.slice(0, -1)
  seriesAt(next[sel.rung]!, home)?.splice(sel.trail[sel.trail.length - 1]!, count)
  return { rungs: next, sel: { rung: sel.rung, trail: home } }
}

/**
 * An empty branch - two bare paths, a loop of wire - inserted after the selected
 * instruction, or at the start of the selected rung or path. Its lower path is selected, so the next
 * instruction picked goes in parallel; its span is then stretched over neighbours by dragging an end
 * ({@link resizeBranch}). Wrapping the selection was tried first and is not what a ladder author's
 * hands expect.
 */
export function addBranch<L>(rungs: readonly RungOf<L>[], sel: LadderSel): LadderEdit<L> {
  const next = copy(rungs) as RungOf<L>[]
  const rung = next[sel.rung]
  if (!rung) return { rungs: [...rungs], sel }
  const onElement = selKind(sel) === 'element'
  const home = onElement ? sel.trail.slice(0, -1) : sel.trail
  const series = seriesAt(rung, home)
  if (!series) return { rungs: [...rungs], sel }
  const at = onElement ? sel.trail[sel.trail.length - 1]! + 1 : 0
  const branch: RungBranchOf<L> = { type: 'branch', paths: [[], []] }
  series.splice(at, 0, branch)
  return { rungs: next, sel: { rung: sel.rung, trail: [...home, at, 1] } }
}

/** The branch the selection is on or in, as the trail of the branch element, or null. */
export function branchOf<L>(rungs: readonly RungOf<L>[], sel: LadderSel): number[] | null {
  return enclosingBranch(rungs, sel)
}

/**
 * Stretch or shrink a branch's span by dragging one of its ends across its neighbours, as a
 * branch handle does. The span is the branch's first path: `by` > 0 pulls that many neighbours on
 * `side` into it, `by` < 0 pushes that many of its own elements back out. The other paths stay as
 * they are - they are what runs in parallel with the span.
 */
export function resizeBranch<L>(rungs: readonly RungOf<L>[], branch: LadderSel, side: 'left' | 'right', by: number): LadderEdit<L> {
  const next = copy(rungs) as RungOf<L>[]
  const rung = next[branch.rung]
  const el = elementAt(next, branch)
  const series = rung && seriesAt(rung, branch.trail.slice(0, -1))
  if (!rung || !series || !isBranch(el) || by === 0) return { rungs: [...rungs], sel: branch }
  const i = branch.trail[branch.trail.length - 1]!
  const span = el.paths[0]!
  if (by > 0) {
    // neighbours into the span
    if (side === 'right') span.push(...series.splice(i + 1, Math.min(by, series.length - i - 1)))
    else {
      const n = Math.min(by, i)
      span.unshift(...series.splice(i - n, n))
      return { rungs: next, sel: { rung: branch.rung, trail: [...branch.trail.slice(0, -1), i - n] } }
    }
  } else {
    // the span's own elements back out
    const n = Math.min(-by, span.length)
    if (side === 'right') series.splice(i + 1, 0, ...span.splice(span.length - n, n))
    else {
      series.splice(i, 0, ...span.splice(0, n))
      return { rungs: next, sel: { rung: branch.rung, trail: [...branch.trail.slice(0, -1), i + n] } }
    }
  }
  return { rungs: next, sel: branch }
}

/** Rung `from` moved to position `to` (an index in the list as it is before the move). */
export function moveRungTo<L>(rungs: readonly RungOf<L>[], from: number, to: number): LadderEdit<L> {
  const dest = Math.max(0, Math.min(to, rungs.length - 1))
  if (from === dest || !rungs[from]) return { rungs: [...rungs], sel: { rung: from, trail: [] } }
  const next = copy(rungs) as RungOf<L>[]
  const [moved] = next.splice(from, 1)
  next.splice(dest, 0, moved!)
  return { rungs: next, sel: { rung: dest, trail: [] } }
}

/** The nearest branch at or around the selection, as the trail of the branch element. */
function enclosingBranch<L>(rungs: readonly RungOf<L>[], sel: LadderSel): number[] | null {
  if (isBranch(elementAt(rungs, sel))) return sel.trail
  const kind = selKind(sel)
  if (kind === 'path') return sel.trail.slice(0, -1)
  return kind === 'element' && sel.trail.length >= 3 ? sel.trail.slice(0, -2) : null
}

export function canAddPath<L>(rungs: readonly RungOf<L>[], sel: LadderSel): boolean {
  return enclosingBranch(rungs, sel) !== null
}

/** One more (empty, selected) path on the branch the selection is in. */
export function addPath<L>(rungs: readonly RungOf<L>[], sel: LadderSel): LadderEdit<L> {
  return addLevel(rungs, sel, [])
}

/**
 * A branch level holding `els`, right below the selected level (or last, when the branch itself or
 * something on it is selected) - what pasting a copied level does.
 */
export function addLevel<L>(rungs: readonly RungOf<L>[], sel: LadderSel, els: readonly RungElementOf<L>[]): LadderEdit<L> {
  const trail = enclosingBranch(rungs, sel)
  if (!trail) return { rungs: [...rungs], sel }
  const next = copy(rungs) as RungOf<L>[]
  const branch = elementAt(next, { rung: sel.rung, trail }) as RungBranchOf<L>
  const at = selKind(sel) === 'path' ? sel.trail[sel.trail.length - 1]! + 1 : branch.paths.length
  branch.paths.splice(at, 0, copy(els) as RungElementOf<L>[])
  return { rungs: next, sel: { rung: sel.rung, trail: [...trail, at] } }
}

/**
 * Delete what is selected: an element, a path, or the rung.
 *
 * A branch is two or more ways through. Deleting a path that leaves one is therefore not a branch
 * any more, and the elements of the path that remains rejoin the series in its place.
 */
export function removeSelected<L>(rungs: readonly RungOf<L>[], sel: LadderSel): LadderEdit<L> {
  const next = copy(rungs) as RungOf<L>[]
  const kind = selKind(sel)
  if (kind === 'rung') {
    next.splice(sel.rung, 1)
    return { rungs: next, sel: next.length === 0 ? null : { rung: Math.min(sel.rung, next.length - 1), trail: [] } }
  }
  const rung = next[sel.rung]!
  if (kind === 'element') {
    const home = sel.trail.slice(0, -1)
    seriesAt(rung, home)?.splice(sel.trail[sel.trail.length - 1]!, 1)
    return { rungs: next, sel: { rung: sel.rung, trail: home } }
  }
  const branchTrail = sel.trail.slice(0, -1)
  const branch = elementAt(next, { rung: sel.rung, trail: branchTrail })
  const series = seriesAt(rung, branchTrail.slice(0, -1))
  if (!series || !isBranch(branch)) return { rungs: [...rungs], sel }
  branch.paths.splice(sel.trail[sel.trail.length - 1]!, 1)
  if (branch.paths.length < 2) series.splice(branchTrail[branchTrail.length - 1]!, 1, ...(branch.paths[0] ?? []))
  return { rungs: next, sel: { rung: sel.rung, trail: branchTrail.slice(0, -1) } }
}

/** The leaf at `sel` changed by `edit` (in a copy of the rungs): what a family's own field and operand writers are
 *  made of. The rungs come back unchanged when no leaf is selected. */
export function updateLeaf<L>(rungs: readonly RungOf<L>[], sel: LadderSel, edit: (leaf: L) => void): RungOf<L>[] {
  const next = copy(rungs) as RungOf<L>[]
  const el = elementAt(next, sel)
  if (el && !isBranch(el)) edit(el)
  return next
}

/** A new empty rung below rung `after` (or first, for -1). */
export function addRung<L>(rungs: readonly RungOf<L>[], after: number): LadderEdit<L> {
  const next = copy(rungs) as RungOf<L>[]
  const at = Math.max(0, Math.min(after + 1, next.length))
  next.splice(at, 0, { comment: '', elements: [] })
  return { rungs: next, sel: { rung: at, trail: [] } }
}

export function moveRung<L>(rungs: readonly RungOf<L>[], index: number, delta: number): LadderEdit<L> {
  const to = index + delta
  if (to < 0 || to >= rungs.length || !rungs[index]) return { rungs: [...rungs], sel: { rung: index, trail: [] } }
  const next = copy(rungs) as RungOf<L>[]
  const [moved] = next.splice(index, 1)
  next.splice(to, 0, moved!)
  return { rungs: next, sel: { rung: to, trail: [] } }
}

export function setComment<L>(rungs: readonly RungOf<L>[], index: number, comment: string): RungOf<L>[] {
  const next = copy(rungs) as RungOf<L>[]
  if (next[index]) next[index]!.comment = comment.trim()
  return next
}
