// Where a tag is used - a Cross Reference, which every ladder has use for - and the double coil a checker warns
// about: two rungs energizing the same coil leave it with whichever ran last, which is almost never what was meant.
//
// Part of the shared rung core (ladderEdit.ts): it reads a family's leaf only through `LeafRefs` - which of its fields
// name tags, and how the element touches each - so every ladder family's editor has the same Cross Reference.

import { isBranch, type RungElementOf, type RungOf } from './ladder/ladderEdit'
import { lex } from './lexer'
import { identKey } from './program'

/** One field of an element that names a tag, and how the element touches it. */
export interface LeafUse {
  /** the field's index, as the family's view numbers its fields */
  field: number
  /** the field as written */
  text: string
  /** an expression (a source operand, a pin's value) mentions every name in it; any other field names only its root
   *  tag (`Line.Zone[2].Full` is a use of `Line`) */
  expression: boolean
  /** the element stores into it */
  write: boolean
  /** it writes it every scan, true or false (an IEC coil): two of those fight over the bit */
  destructive: boolean
}

/** How Cross Reference reads one family's leaf. */
export interface LeafRefs<L> {
  /** what a reference row calls the element: an IEC contact's or coil's symbol, a block's type */
  word(leaf: L): string
  /** its fields that name tags */
  uses(leaf: L): readonly LeafUse[]
}

export interface LadderRef {
  kind: 'ladder'
  routine: number
  routineName: string
  rung: number
  /** what the row calls the element ({@link LeafRefs.word}) */
  mnemonic: string
  /** `write` when the element stores into this tag, `read` otherwise */
  access: 'read' | 'write'
  /** it writes the tag every scan (a coil) */
  destructive: boolean
}

export interface TextRef {
  kind: 'text'
  line: number
  offset: number
  /** the line's text, trimmed */
  text: string
}

export type TagRef = LadderRef | TextRef

/** A section of ladder as Cross Reference reads it: its rungs, where it stands in the text, and its name - a named
 *  routine's (`name`), or the POU an IEC section is the body of (`pou`). */
export interface RefRoutine<L> {
  rungs: readonly RungOf<L>[]
  start: number
  end: number
  name?: string
  pou?: string
}

/** The root identifier of an operand: `Line.Zone[2].Full` is a use of `Line`; `Motor` of `Motor`. */
const rootOf = (operand: string): string | null => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(operand)?.[1] ?? null

/** Every identifier an operand mentions (an expression's tags too), not a member after a dot. */
function namesIn(operand: string): string[] {
  const out: string[] = []
  const re = /(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)/g
  for (let m = re.exec(operand); m; m = re.exec(operand)) out.push(m[1]!)
  return out
}

function walk<L>(els: readonly RungElementOf<L>[], visit: (leaf: L) => void): void {
  for (const el of els) {
    if (isBranch(el)) el.paths.forEach((p) => walk(p, visit))
    else visit(el)
  }
}

/** Every use of `name` in `source`: on rungs (with how the element touches it) and in the text outside ladder. */
export function crossReference<L>(source: string, name: string, routines: readonly RefRoutine<L>[], leaves: LeafRefs<L>): TagRef[] {
  const key = identKey(name)
  const refs: TagRef[] = []
  routines.forEach((r, ri) => {
    r.rungs.forEach((rung, i) => {
      walk(rung.elements, (el) => {
        for (const use of leaves.uses(el)) {
          const mentioned = use.expression ? namesIn(use.text).some((n) => identKey(n) === key) : rootOf(use.text) !== null && identKey(rootOf(use.text)!) === key
          if (!mentioned) continue
          refs.push({ kind: 'ladder', routine: ri, routineName: r.name ?? r.pou ?? '', rung: i, mnemonic: leaves.word(el), access: use.write ? 'write' : 'read', destructive: use.destructive })
        }
      })
    })
  })
  // the text, outside the ladder sections
  try {
    const inLadder = (offset: number): boolean => routines.some((r) => offset >= r.start && offset < r.end)
    const seenLines = new Set<number>()
    for (const t of lex(source)) {
      if (t.kind !== 'ident' || identKey(t.value) !== key || inLadder(t.pos.offset) || seenLines.has(t.pos.line)) continue
      seenLines.add(t.pos.line)
      const start = source.lastIndexOf('\n', t.pos.offset - 1) + 1
      const end = source.indexOf('\n', t.pos.offset)
      refs.push({ kind: 'text', line: t.pos.line, offset: t.pos.offset, text: source.slice(start, end < 0 ? undefined : end).trim() })
    }
  } catch {
    // unlexable text: the rung references still stand
  }
  return refs
}

export interface DuplicateDestructive {
  /** the tag, as first spelled */
  name: string
  /** every element that writes it every scan: [routine, rung] pairs */
  at: { routine: number; rung: number }[]
}

/** Tags more than one destructive write energizes - the double-coil warning. */
export function duplicateDestructive<L>(routines: readonly { rungs: readonly RungOf<L>[] }[], leaves: LeafRefs<L>): DuplicateDestructive[] {
  const byTag = new Map<string, DuplicateDestructive>()
  routines.forEach((r, ri) => {
    r.rungs.forEach((rung, i) => {
      walk(rung.elements, (el) => {
        for (const use of leaves.uses(el)) {
          if (!use.destructive || !rootOf(use.text)) continue
          const full = use.text.trim()
          const key = identKey(full)
          const d = byTag.get(key) ?? { name: full, at: [] }
          d.at.push({ routine: ri, rung: i })
          byTag.set(key, d)
        }
      })
    })
  })
  return [...byTag.values()].filter((d) => d.at.length > 1)
}
