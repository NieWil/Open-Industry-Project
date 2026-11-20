// What the PLC panel's organizer tree lists, derived from the program's blocks. Kept out of the component so it can be
// tested without one.
//
// The tree is the shape tools built on IEC 61131-3 generally draw: the top-level code, the tasks and the programs they
// run, then the POUs by kind, the data types and the global variables. The words are plain ones (Programs, Function
// Blocks, Data Types) rather than abbreviations, which read as jargon to anyone who did not learn on them. Every entry
// is a view over the program text: the tree holds nothing of its own, so a program edited as text re-derives it.

import type { StBlock } from '../../plc'
import { lex } from '../../plc/lexer'
import { parse } from '../../plc/parser'
import type { LadderMarks } from './ladderMarks'

/** The language a POU is written in, as its row's tag says it: ladder when its whole body is one ladder, both when a
 *  ladder stands among statements, else Structured Text. */
export type PouLanguage = 'ST' | 'LD' | 'ST+LD'

export interface OrganizerRow {
  /** its index among the panel's blocks, which is what every block edit takes */
  index: number
  kind: StBlock['kind']
  /** the POU's declared name; empty for the top-level code, a TYPE block and a VAR_GLOBAL block */
  name: string
  /** what the row reads */
  label: string
  /** null for what is not code: data types, globals, a CONFIGURATION */
  language: PouLanguage | null
  /** a PROGRAM that the stored controller table does not run */
  unscheduled: boolean
}

export interface OrganizerGroups {
  /** the code outside every POU: the program's top-level variables, and its statements when it has any */
  top: OrganizerRow | null
  programs: OrganizerRow[]
  functionBlocks: OrganizerRow[]
  functions: OrganizerRow[]
  dataTypes: OrganizerRow[]
  globals: OrganizerRow[]
  /** a CONFIGURATION the program declares itself */
  configuration: OrganizerRow | null
}

/**
 * What a block is called in the tree.
 *
 * POUs carry their own name. A `TYPE` block declares as many types as it likes and a `VAR_GLOBAL` block as many
 * variables, so neither has one name: a TYPE block reads as the types it declares (`typeNames`, when they could be
 * read), else as a kind word, numbered when there is more than one of that kind, because two rows reading "Types" that
 * go to different places is worse than no row at all.
 *
 * The code outside every POU is `Main`: its top-level variables, and the statements the controller runs as its `Main`
 * row when it has any.
 */
export function blockLabel(b: StBlock, i: number, all: readonly StBlock[], typeNames?: readonly string[]): string {
  if (b.name !== '') return b.name
  if (b.kind === 'type' && typeNames && typeNames.length > 0) return typeNames.join(', ')
  const word = b.kind === 'program' ? 'Main' : b.kind === 'global' ? 'Globals' : 'Types'
  const sameKind = all.filter((o) => o.kind === b.kind && o.name === '')
  if (sameKind.length < 2) return word
  return `${word} ${sameKind.indexOf(all[i]!) + 1}`
}

/** The language of block `i`, from the panel's ladder marks. */
export function languageOf(marks: LadderMarks, i: number): PouLanguage {
  if (marks.whole.has(i)) return 'LD'
  return marks.has.has(i) ? 'ST+LD' : 'ST'
}

/**
 * The type names each TYPE block declares, in the order written, by block index. A block that does not parse yet (it
 * is being typed) has none, and its row falls back to "Types". Parses each TYPE block on its own, so it is for a quiet
 * period after an edit, not a keystroke.
 */
export function typeNamesOf(blocks: readonly StBlock[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  blocks.forEach((b, i) => {
    if (b.kind !== 'type') return
    try {
      const ast = parse(lex(b.text), [])
      const named = [...ast.typeDefs, ...ast.enumDefs, ...ast.subrangeDefs, ...ast.aliasDefs] as { name: string; pos?: { offset: number } }[]
      out.set(
        i,
        named.sort((a, z) => (a.pos?.offset ?? 0) - (z.pos?.offset ?? 0)).map((d) => d.name),
      )
    } catch {
      out.set(i, [])
    }
  })
  return out
}

export interface OrganizerFacts {
  marks: LadderMarks
  /** the code outside every POU has statements (`topLevelStatements`) */
  bodyRuns: boolean
  typeNames: ReadonlyMap<number, readonly string[]>
  /** the PROGRAM types the stored table runs, upper-cased; null with no table stored, when every PROGRAM runs (the
   *  default table) or the code's own CONFIGURATION decides, so nothing is marked unscheduled */
  scheduled: ReadonlySet<string> | null
}

/** The blocks sorted into the tree's groups, each group in the order the code declares it. */
export function organizerGroups(blocks: readonly StBlock[], facts: OrganizerFacts): OrganizerGroups {
  const groups: OrganizerGroups = { top: null, programs: [], functionBlocks: [], functions: [], dataTypes: [], globals: [], configuration: null }
  blocks.forEach((b, i) => {
    const code = b.kind === 'program' || b.kind === 'programPou' || b.kind === 'functionBlock' || b.kind === 'function'
    const row: OrganizerRow = {
      index: i,
      kind: b.kind,
      name: b.name,
      label: blockLabel(b, i, blocks, facts.typeNames.get(i)),
      language: code ? languageOf(facts.marks, i) : null,
      unscheduled: b.kind === 'programPou' && facts.scheduled !== null && !facts.scheduled.has(b.name.toUpperCase()),
    }
    switch (b.kind) {
      case 'program':
        groups.top = row
        break
      case 'programPou':
        groups.programs.push(row)
        break
      case 'functionBlock':
        groups.functionBlocks.push(row)
        break
      case 'function':
        groups.functions.push(row)
        break
      case 'type':
        groups.dataTypes.push(row)
        break
      case 'global':
        groups.globals.push(row)
        break
      case 'configuration':
        groups.configuration = row
        break
    }
  })
  return groups
}
