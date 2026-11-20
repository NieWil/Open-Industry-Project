// Which POUs of a program hold ladder, and which POUs are one.
//
// The PLC panel's organizer draws these as its language tags, and opening a POU reads them to decide which face of
// the program to open (StEditor `onChipClick`): the language belongs to the POU, not to the panel, the way a vendor
// tool opens a routine in the language it was written in. Kept out of the component so it can be tested without one.
import type { Controller } from '../../core/controller'
import { controllerFor, extractController } from '../../plc/controller'
import { readLadder } from '../../plc/ladder/ladderRungs'
import type { StBlock } from '../../plc'
import { blockStarts } from './stReveal'

export interface LadderMarks {
  /** blocks holding at least one `LADDER ... END_LADDER` section */
  has: ReadonlySet<number>
  /** blocks whose whole body is one section, so the block is a ladder diagram (`LdSection.whole`) */
  whole: ReadonlySet<number>
}

/** A program with no ladder in it. Shared, so the common case allocates nothing and compares equal by identity. */
export const NO_LADDER: LadderMarks = { has: new Set(), whole: new Set() }

/**
 * The ladder marks of `source`, by index into `blocks`.
 *
 * A section belongs to the last block that starts at or before it (`blockStarts` is in source order), which is the
 * POU whose body holds it.
 *
 * Not cheap: it lexes and parses the whole program (6.5 ms on the demo program against 0.54 for the block split it
 * runs beside, measured), so a caller runs it on a quiet period rather than on a keystroke. The one shortcut taken
 * here is sound: a section must spell `LADDER`, so a program that does not contain the word anywhere cannot have
 * one and the parse is skipped. The word is not reserved (`ladder := 3;` is still a statement), so a hit only means
 * "parse to find out", never "there is a ladder here".
 */
export function ladderMarks(source: string, blocks: StBlock[]): LadderMarks {
  if (!/\bLADDER\b/i.test(source)) return NO_LADDER
  const sections = readLadder(source)
  if (sections.length === 0) return NO_LADDER
  const starts = blockStarts(source, blocks)
  const has = new Set<number>()
  const whole = new Set<number>()
  for (const s of sections) {
    let at = -1
    for (let i = 0; i < blocks.length; i++) if (starts[i]! <= s.start) at = i
    if (at < 0) continue
    has.add(at)
    if (s.whole) whole.add(at)
  }
  return { has, whole }
}

/**
 * True when some POU holds a LADDER section beside Structured Text. That is the one POU with two faces, so it is the
 * only case the panel's Text/Ladder switch is for: every other POU is one language, and its row opens it in that one.
 */
export function mixesLanguages(marks: LadderMarks): boolean {
  for (const i of marks.has) if (!marks.whole.has(i)) return true
  return false
}

/**
 * The ladder section block `i` is, as its index among `readLadder(source)` (what the Ladder view reveals), or null when
 * the block is not a ladder POU - including one that holds a section among statements, which opens as text so the
 * statements around the section stay on screen. Parses, so it is for a click or a load, never a keystroke.
 */
export function ladderRoutineOf(source: string, blocks: StBlock[], i: number): number | null {
  const starts = blockStarts(source, blocks)
  const from = starts[i]
  if (from === undefined) return null
  const to = starts[i + 1] ?? source.length
  const routine = readLadder(source).findIndex((r) => r.whole && r.start >= from && r.start < to)
  return routine >= 0 ? routine : null
}

/**
 * The face the PLC panel opens a program on. The POU is the PROGRAM the controller runs first, when this code has it,
 * the way a vendor tool opens a controller on its main routine; else the first block. It opens as rungs when that POU
 * is a ladder, else as text. `routine` is the section to bring the sheet to.
 *
 * The controller is the one the program runs from: its stored table; else the CONFIGURATION its text declares; else
 * the default table (`controllerFor`: MainTask running every PROGRAM in order), which is what the organizer shows and
 * the engine runs. Read off the stored table alone, a program that arrives without one (an imported .st file) would
 * open on its first block, which is a FUNCTION_BLOCK whenever the blocks are written before the program that calls them.
 */
export function openingFace(source: string, blocks: StBlock[], controller: Controller | null): { ladder: boolean; routine: number | null } {
  const runs = controller ?? extractController(source)?.controller ?? controllerFor(source, null, 10)
  const main = runs?.programs[0]?.type?.toUpperCase()
  const found = main === undefined ? -1 : blocks.findIndex((b) => b.kind === 'programPou' && b.name.toUpperCase() === main)
  const routine = ladderRoutineOf(source, blocks, found >= 0 ? found : 0)
  return { ladder: routine !== null, routine }
}

/** True when both mark the same blocks: a recompute that found no change can then keep the old object, so a quiet
 *  period of typing does not re-render the strip. */
export function sameLadderMarks(a: LadderMarks, b: LadderMarks): boolean {
  return sameSet(a.has, b.has) && sameSet(a.whole, b.whole)
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}
