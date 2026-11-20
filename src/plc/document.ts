// A program as its blocks, rather than as one run of text.
//
// The engine compiles a single source string, and every store this program passes through holds
// one: the project file (`ProjectMachine.stProgram`), an exported scene, the localStorage autosave,
// and the collaborative `Y.Text`. This module does not change that.
//
// Why a model. The exporter already needs the structure twice: exportText.ts splits the POUs off
// raw source with a keyword scan, and export.ts pairs the result with the parsed AST. A caller that
// wants the blocks (to show them as separate documents, to name one in a diagnostic, to emit them
// in the order they were written) would otherwise re-derive them, and each copy can drift from the
// others. This is that derivation, in one place.
//
// Why the stored format stays a string. `flattenDocument(parseDocument(s))` is `s` for any source
// already in normal form, and reaches normal form in one pass for any other. So a caller can keep
// the flat string and still see blocks: parse on the way in, flatten on the way out. There is no
// project-format bump and no scene-file change, and the collaborative document stays one `Y.Text`,
// so two people typing in the same program need no schema migration. Per-block storage is still
// possible later, but nothing here depends on it.
//
// This is not a parse: `Ast` is that, and it type-checks. This is the file's shape: which blocks,
// in which order, spelled how. Half-written source still has a shape, which is why nothing here
// throws (an editor holds code that does not compile most of the time).

import { declaredLibraryName, splitLibrary, trailingConfiguration } from './exchange/exportText'
import type { LibraryBlock } from './exchange/exportText'
import { identKey } from './program'
import { KEYWORDS, lex } from './lexer'
import { sourceWords } from './sourceFacts'
import type { Token } from './types'

/** `program` is the implicit program's body (the remainder of a file with no PROGRAM header);
 *  `programPou` is a `PROGRAM Name ... END_PROGRAM` block, one of the POUs a controller runs. */
export type StBlockKind = 'type' | 'global' | 'functionBlock' | 'function' | 'program' | 'programPou' | 'configuration'

export interface StBlock {
  kind: StBlockKind
  /**
   * The POU's declared name. Empty for `type` and `global` blocks - one `TYPE ... END_TYPE`
   * declares as many types as it likes, so no single name identifies it - and for the program
   * body, which this subset leaves implicit (export.ts names it on the way out).
   */
  name: string
  /**
   * The block's source, verbatim, including any comment written above it: a note over a
   * function block documents that block, so it travels with it rather than being stranded at
   * the end of the one before.
   */
  text: string
}

export interface StDocument {
  blocks: StBlock[]
}

/** `splitProgram`'s kinds are the peeler's spelling; these are the model's. */
const KIND: Record<LibraryBlock['kind'], StBlockKind> = {
  type: 'type',
  global: 'global',
  fb: 'functionBlock',
  // an INTERFACE is a type: the organizer lists it among the data types
  interface: 'type',
  func: 'function',
  program: 'programPou',
  configuration: 'configuration',
}

/**
 * The name a POU block declares, or `''`.
 *
 * Through the lexer, never a regex over the text: a block carries the comment written above it,
 * so `(* like FUNCTION_BLOCK Latch, but latching *)` sits inside the very text being named and a
 * regex would read the comment's name instead of the declaration's.
 */
export function declaredName(text: string): string {
  try {
    let atName = false
    for (const t of lex(text)) {
      if (atName) return t.kind === 'ident' ? t.value : ''
      if (t.kind === 'kw' && (t.value === 'FUNCTION_BLOCK' || t.value === 'FUNCTION')) atName = true
    }
  } catch {
    // unlexable half-written source: it has no name yet, which is not an error
  }
  return ''
}

/**
 * The blocks a program is made of, in the order they were written.
 *
 * Never throws. An editor buffer spends most of its life not compiling (a block half typed, a
 * terminator not reached yet), and a model that refused those would be unusable while someone is
 * working. Source the splitter cannot split becomes a single `program` block holding all of it,
 * which is accurate (that is the only shape known about it) and lossless.
 */
export function parseDocument(source: string): StDocument {
  let split: ReturnType<typeof splitLibrary>
  try {
    split = splitLibrary(source)
  } catch {
    const text = source.trim()
    return { blocks: text === '' ? [] : [{ kind: 'program', name: '', text }] }
  }

  const blocks: StBlock[] = split.blocks.map((b) => ({
    kind: KIND[b.kind],
    name:
      b.kind === 'fb' || b.kind === 'func'
        ? declaredName(b.text)
        : b.kind === 'program'
          ? declaredLibraryName(b.text, 'PROGRAM')
          : b.kind === 'configuration'
            ? declaredLibraryName(b.text, 'CONFIGURATION')
            : '',
    text: b.text,
  }))
  // What follows the last block is the code outside every POU - and, when the file declares its own
  // CONFIGURATION after that code (the order the parser accepts, and the one a controller table's
  // generated text has), the CONFIGURATION too. The peeler's scan cannot reach it, because it stops at
  // the first text that is not a block, so the remainder is split here: otherwise a legal file's
  // CONFIGURATION is not a block of its own and the panel cannot show, rename or delete it. Order is
  // kept, so flattening still returns the file as it was written.
  if (split.rest !== '') {
    const trailing = trailingConfiguration(split.rest)
    if (trailing) {
      if (trailing.body !== '') blocks.push({ kind: 'program', name: '', text: trailing.body })
      blocks.push({ kind: 'configuration', name: declaredLibraryName(trailing.configuration, 'CONFIGURATION'), text: trailing.configuration })
    } else {
      blocks.push({ kind: 'program', name: '', text: split.rest })
    }
  }
  return { blocks }
}

/**
 * The blocks back as one source string, in order.
 *
 * A blank line between blocks is the normal form: `parseDocument` trims each block, so flattening
 * and re-parsing returns the same blocks - which is what lets a caller keep storing a string and
 * treat the split as a view rather than a migration.
 */
export function flattenDocument(doc: StDocument): string {
  return doc.blocks.map((b) => b.text.trim()).filter((t) => t !== '').join('\n\n')
}

// ---------------------------------------------------------------------------
// Structural edits: add / rename / delete / reorder a block.
//
// These are what turns the strip from an index into the POU list every PLC tool has - the thing
// a PLC author right-clicks. They live here rather than in the panel because
// they are text transforms on the document, not UI: portable, deterministic, and unit-testable
// without a browser. The panel supplies the gestures and nothing else.
//
// Each one returns the whole program. One string is what the project file, the autosave and the
// shared `Y.Text` hold, so a structural edit replicates and undoes exactly like typing does. An
// edit that cannot be made returns the source unchanged rather than throwing, because an editor
// calls these on half-written code all the time. `blockNameError` gives a caller a reason to show.
//
// One reflow to know about: everything except `renameBlock` goes out through `flattenDocument`,
// which trims each block and joins with a blank line. That is a no-op for a document already in
// normal form (the fixpoint the tests pin), but a hand-spaced file loses its extra blank lines
// between blocks the first time one is added, deleted or moved. Inside a block nothing moves.
// ---------------------------------------------------------------------------

/**
 * The kinds a new block can be created as.
 *
 * `program` is absent: the program body is not one more POU you add, it is the
 * remainder - whatever is not a leading declaration - so it comes into being by typing. A
 * `programPou` (PROGRAM ... END_PROGRAM) is one: it runs from a controller table, so the panel adds it
 * there too (controllerEdits.ts `addProgram`). `ladderProgram` is the same PROGRAM with a ladder for its
 * body - one LADDER section that is the whole of it, which is what makes the POU a ladder diagram
 * (`LdSection.whole`) - and it lands as a `programPou` block like any other.
 */
export type NewBlockKind = 'functionBlock' | 'function' | 'type' | 'global' | 'programPou' | 'ladderProgram'

/** A structural edit's result: the whole program back, and where the block it touched ended up
 *  (an index into `parseDocument(source).blocks`), so a caller can point the view at it. */
export interface DocumentEdit {
  source: string
  index: number
}

/** Legal ST identifier: a letter or `_`, then letters/digits/`_`. Matches the lexer's own rule. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A new block's starting text.
 *
 * These compile as written. The panel lints live and Run refuses a program that does not check,
 * so a "New function block" that reddens the editor the moment it lands is a command nobody uses
 * twice - `document.test.ts` puts every skeleton through the real checker to keep that true.
 */
function skeleton(kind: NewBlockKind, name: string): string {
  switch (kind) {
    case 'functionBlock':
      return `FUNCTION_BLOCK ${name}\nVAR_INPUT\n  In : BOOL;\nEND_VAR\nVAR_OUTPUT\n  Out : BOOL;\nEND_VAR\n\nOut := In;\nEND_FUNCTION_BLOCK`
    case 'function':
      // a FUNCTION needs a result type, and its result is assigned to its own name
      return `FUNCTION ${name} : BOOL\nVAR_INPUT\n  In : BOOL;\nEND_VAR\n\n${name} := In;\nEND_FUNCTION`
    case 'type':
      return `TYPE\n  ${name} : STRUCT\n    Field : INT;\n  END_STRUCT;\nEND_TYPE`
    case 'global':
      return `VAR_GLOBAL\n  ${name} : BOOL;\nEND_VAR`
    case 'programPou':
      return `PROGRAM ${name}\nVAR\n  Count : INT;\nEND_VAR\n\nCount := Count + 1;\nEND_PROGRAM`
    case 'ladderProgram':
      // one rung, the ladder's own "Out := In": a sheet with a rung on it shows where the next one goes
      return `PROGRAM ${name}\nVAR\n  In : BOOL;\n  Out : BOOL;\nEND_VAR\nLADDER\n  |In| (Out);\nEND_LADDER\nEND_PROGRAM`
  }
}

/** What a fresh block of each kind is called before anyone renames it. `type` and `global` blocks
 *  declare no name of their own, so the base names the first thing declared inside them. */
const NAME_BASE: Record<NewBlockKind, string> = {
  functionBlock: 'Block',
  function: 'Func',
  type: 'Type',
  global: 'Flag',
  programPou: 'Program',
  ladderProgram: 'Program',
}

/**
 * Every identifier the program already spells, folded to IEC's case-insensitive key.
 *
 * Used to keep a generated name from landing on one that exists, and to refuse a rename onto a
 * name already in use - a rename that merges two identifiers silently changes what the program
 * means, which is the one outcome worth being conservative about.
 *
 * Unlexable source (an unterminated comment or text literal) falls back to a word scan. That
 * over-reports, since it also sees words inside prose, and over-reporting is the safe direction:
 * it can only ever make this refuse a name, never accept a colliding one.
 */
function usedIdentifiers(source: string): ReadonlySet<string> {
  // (cached per text in sourceFacts.ts, because a rename box calls this on every keystroke)
  const spelled = sourceWords(source)
  if (spelled) return spelled.idents
  const out = new Set<string>()
  for (const w of source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) out.add(identKey(w))
  return out
}

/** Whether the whole document tokenizes. A rename walks the token stream, so it needs this. */
function lexable(source: string): boolean {
  return sourceWords(source) !== null
}

/** A name for a new block of `kind` that nothing in `source` already uses. */
export function defaultBlockName(source: string, kind: NewBlockKind): string {
  const used = usedIdentifiers(source)
  const base = NAME_BASE[kind]
  for (let n = 1; ; n++) {
    const name = `${base}${n}`
    if (!used.has(identKey(name))) return name
  }
}

/** `base` itself when nothing in `source` spells it, else the first free `base1`, `base2`, ... */
export function unusedName(source: string, base: string): string {
  const used = usedIdentifiers(source)
  if (!used.has(identKey(base))) return base
  for (let n = 1; ; n++) {
    if (!used.has(identKey(`${base}${n}`))) return `${base}${n}`
  }
}

/**
 * Why `name` cannot be block `index`'s name, in a sentence to show someone, or `null` if it can.
 *
 * Separate from `renameBlock` because the two questions are different: this one has a reason to
 * give, while the edit itself is total and silent. A caller asks this, shows what it says, and
 * only then applies.
 */
export function blockNameError(source: string, index: number, name: string): string | null {
  const current = parseDocument(source).blocks[index]?.name ?? ''
  const to = name.trim()
  if (to === '') return 'A name is required.'
  if (!IDENT.test(to)) return `"${to}" is not a valid name - letters, digits and _ only, starting with a letter or _.`
  if (KEYWORDS.has(to.toUpperCase())) return `${to.toUpperCase()} is a reserved word.`
  // IEC identifiers are case-insensitive, so re-spelling the same name (Latch -> LATCH) is a
  // rename of itself and always allowed; it must be tested before the in-use check below, which
  // would otherwise see the block's own references and refuse.
  if (identKey(to) === identKey(current)) return null
  if (!lexable(source)) return 'Fix the unterminated comment or text literal first - a rename has to tell code from prose.'
  if (usedIdentifiers(source).has(identKey(to))) return `"${to}" is already used in this program.`
  return null
}

/**
 * Add a block, immediately before the program body.
 *
 * Before, not after, because the subset's grammar requires it: the peeler takes leading
 * declarations and calls the remainder the program, so a POU written below the body is not a POU
 * at all. `name` defaults to the first free `Block1`/`Func1`/... .
 */
export function addBlock(source: string, kind: NewBlockKind, name?: string): DocumentEdit {
  const chosen = (name ?? defaultBlockName(source, kind)).trim()
  const blocks = parseDocument(source).blocks
  const body = blocks.findIndex((b) => b.kind === 'program')
  const index = body < 0 ? blocks.length : body
  const next = [...blocks]
  next.splice(index, 0, {
    // a ladder program is a PROGRAM like any other; only its body differs
    kind: kind === 'ladderProgram' ? 'programPou' : kind,
    // TYPE and VAR_GLOBAL blocks declare no name of their own (one block declares as many as it
    // likes), so the chosen name goes inside the skeleton and the block itself stays unnamed
    name: kind === 'functionBlock' || kind === 'function' || kind === 'programPou' || kind === 'ladderProgram' ? chosen : '',
    text: skeleton(kind, chosen),
  })
  return { source: flattenDocument({ blocks: next }), index }
}

/**
 * Rename POU `index`, and every reference to it.
 *
 * Through the lexer rather than a text replace, so a name mentioned in a comment or a text
 * literal is left alone - the block carries the comment written above it, which is exactly where
 * its own name tends to be written in prose.
 *
 * Known limit: it renames every identifier token with that name, without resolving scopes. A
 * local variable that shares a POU's name is renamed along with it. That program is already
 * asking for trouble, and the alternative - a scope-resolving rename - needs the checker's
 * symbol tables and stops working on the half-written code an editor spends its life in.
 *
 * Unlike the other three this does not reflow: only the name's own character ranges change, so a
 * hand-formatted program comes back formatted exactly as it was.
 */
export function renameBlock(source: string, index: number, name: string): DocumentEdit {
  const b = parseDocument(source).blocks[index]
  const to = name.trim()
  if (!b || b.name === '' || to === '' || to === b.name) return { source, index }
  let toks: Token[]
  try {
    toks = lex(source)
  } catch {
    return { source, index } // cannot tell a reference from prose; blockNameError says so
  }
  const from = identKey(b.name)
  let out = source
  // back to front, so an earlier replacement cannot move a later one's offsets
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i]!
    if (t.kind !== 'ident' || identKey(t.value) !== from) continue
    out = out.slice(0, t.pos.offset) + to + out.slice(t.pos.offset + t.value.length)
  }
  return { source: out, index }
}

/**
 * Delete block `index`, with the comment written above it.
 *
 * The program body is refused: it is not a POU among POUs but the remainder, so "delete" there
 * means selecting the code and pressing Delete, which the editor already does - and doing it from
 * a chip would silently throw away the part of the program that actually runs.
 */
export function deleteBlock(source: string, index: number): DocumentEdit {
  const blocks = parseDocument(source).blocks
  const b = blocks[index]
  if (!b || b.kind === 'program') return { source, index }
  const next = blocks.filter((_, i) => i !== index)
  return { source: flattenDocument({ blocks: next }), index: Math.max(0, Math.min(index, next.length - 1)) }
}

/**
 * Move block `from` to position `to`.
 *
 * Declarations may be reordered among themselves; the program body cannot move and nothing can
 * move below it, for the grammar reason in `addBlock`. Both ends are clamped rather than
 * rejected, so a drag that overshoots the end of the strip parks the block last instead of doing
 * nothing.
 */
export function moveBlock(source: string, from: number, to: number): DocumentEdit {
  const blocks = parseDocument(source).blocks
  const body = blocks.findIndex((b) => b.kind === 'program')
  const limit = (body < 0 ? blocks.length : body) - 1 // last position a declaration may occupy
  if (from < 0 || from > limit) return { source, index: from }
  const dest = Math.max(0, Math.min(to, limit))
  if (dest === from) return { source, index: from }
  const next = [...blocks]
  const [moved] = next.splice(from, 1)
  next.splice(dest, 0, moved!)
  return { source: flattenDocument({ blocks: next }), index: dest }
}
