// A program as files, one per top-level block: how a project folder keeps its program (core/project/projectFolder.ts,
// format 7). The program stays one string everywhere else (the store, a collab room, the engine). This split exists
// only on disk, so a diff, a merge or a folder conflict shows up on the POU that changed, and the file name says
// which grammar a file is in.
//
// Names. A POU, an INTERFACE or a CONFIGURATION is named for what it declares (`PalletTruck.st`). A block that declares
// no name is named for its keyword: `type.st` (a TYPE block), `var_global.st`, and `program.st`, the code outside every
// POU. A keyword is never an identifier, so these never collide with a POU's name. Identifiers are case-insensitive
// and so are some file systems, so a second file whose name differs only in case takes a `-2` suffix.
//
// Extension. `.ld` for a block holding a LADDER section (our text form for IEC's LD, docs/ladder.md), `.st` for the
// rest, so a `.st` file is plain Structured Text any ST tool can read.
//
// Order is the program's own, and the folder's manifest keeps it: PROGRAMs without a controller table run in the
// order they are written, and a global CONSTANT can only size an array with a constant written above it.
//
// One block, or source the block split cannot read (a POU half typed), is one file holding the source exactly.
// Several are written trimmed, and read back joined by a blank line (core/project/projectFolder.ts `joinProgramFiles`), which
// is the document model's normal form (plc/document.ts `flattenDocument`) with a closing newline.

import { parseDocument } from './document'
import type { StBlock } from './document'
import { matchInCode, triviaMask } from './exchange/exportText'
import { lex } from './lexer'

/** One file of a split program: a file name (no directory) and its text. */
export interface ProgramFile {
  name: string
  text: string
}

const KEYWORD: Record<StBlock['kind'], string> = {
  type: 'type',
  global: 'var_global',
  functionBlock: 'function_block',
  function: 'function',
  program: 'program',
  programPou: 'program',
  configuration: 'configuration',
}

/** The name an INTERFACE block declares, or `''` (through the lexer, so a comment above it is never read as one). */
function interfaceName(text: string): string {
  try {
    let atName = false
    for (const t of lex(text)) {
      if (atName) return t.kind === 'ident' ? t.value : ''
      if (t.value.toUpperCase() === 'INTERFACE') atName = true
      else if (t.value.toUpperCase() === 'TYPE') return ''
    }
  } catch {
    // unlexable: no name yet
  }
  return ''
}

/** True when `text` holds a LADDER section: an `END_LADDER` in code, outside comments and strings. */
export function holdsLadder(text: string): boolean {
  return /\bEND_LADDER\b/i.test(text) && matchInCode(text, triviaMask(text), /\bEND_LADDER\b/i) !== null
}

function stem(block: StBlock): string {
  if (block.name !== '') return block.name
  if (block.kind === 'type') return interfaceName(block.text) || KEYWORD.type
  return KEYWORD[block.kind]
}

/** The program `source` as files, in its own order. An empty program is no files. */
export function programFiles(source: string): ProgramFile[] {
  if (source.trim() === '') return []
  const blocks = parseDocument(source).blocks
  if (blocks.length <= 1) return [{ name: `${blocks[0] ? stem(blocks[0]) : KEYWORD.program}.${holdsLadder(source) ? 'ld' : 'st'}`, text: source }]
  const used = new Set<string>()
  return blocks.map((b) => {
    const base = stem(b)
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`
    used.add(name.toLowerCase())
    return { name: `${name}.${holdsLadder(b.text) ? 'ld' : 'st'}`, text: `${b.text}\n` }
  })
}
