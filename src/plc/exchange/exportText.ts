// The IEC-text export target: a program wrapped into a spec-legal source file.
//
// Dependency-free (no run-time imports), for two reasons:
//
//  1. scripts/oracle-matiec.mjs renders the conformance corpus through it under Node's bare TypeScript loader,
//     which resolves no extensionless specifiers, so CI renders through the product's exporter, not a copy.
//  2. The corpus has `rejects` cases the oracle must render too (to prove a real compiler refuses them), so this
//     target cannot type-check its input. Validation belongs in export.ts.
//
// The transform is purely syntactic: peel the POU definitions off the front and synthesise the configuration
// layer around the rest. The program's text is emitted verbatim (see the note above renderIecText) except for
// the punctuation `canonicalSyntax` adds. Anything needing the AST (PLCopen XML, export warnings) is in export.ts.

export interface IecTextOptions {
  /** name of the generated PROGRAM POU (IEC needs one; our program body is implicit) */
  programName?: string
  projectName?: string
  companyName?: string
  /** scan period of the generated TASK, in milliseconds */
  scanMs?: number
  /** false to omit the explanatory banner (the oracle writes its own) */
  banner?: boolean
}

export interface SplitProgram {
  /** TYPE ... END_TYPE blocks, verbatim */
  types: string[]
  /** VAR_GLOBAL ... END_VAR blocks, verbatim */
  globals: string[]
  /** FUNCTION_BLOCK / FUNCTION blocks, verbatim, in source order */
  pous: { kind: 'fb' | 'func'; text: string }[]
  /**
   * Every leading block in source order, so a renderer can put them back where the author had
   * them. The buckets above group by kind, which loses the interleaving: a `TYPE` declared
   * between two function blocks is ordinary ST that both this engine and a real compiler
   * accept, but emitting `types` then `pous` silently hoists it to the top of the exported
   * file. Nothing requires that regrouping - unlike the `VAR_GLOBAL` hoist, which IEC forces
   * by putting globals on the CONFIGURATION - so the order is kept and handed back.
   */
  blocks: { kind: 'type' | 'global' | 'fb' | 'interface' | 'func'; text: string }[]
  /** the main program: its VAR sections plus its statement body */
  program: string
}

/**
 * Mark every character that is comment or string-literal text.
 *
 * Both raw-source transforms below need it: a `(* ... *)` ahead of the first POU hid that POU from the peeler
 * (the whole file became the PROGRAM body, a FUNCTION_BLOCK nested inside), and a `STRING[16]` merely mentioned
 * in a comment got rewritten. The corpus never caught either because no case carries a comment.
 *
 * Follows the lexer's rules exactly (lexer.ts): `//` to end of line, `(* ... *)` to the first `*)` (not nested),
 * and a single-quoted literal with IEC's `$` escapes that never spans a line. export.ts `bodyOf` runs the real
 * lexer; this file can't, being import-free.
 *
 * Unterminated trivia runs to end of input rather than throwing: reporting is the compiler's job (the oracle
 * renders `rejects` cases through here), and this only must not make the damage worse.
 */
export function triviaMask(src: string): Uint8Array {
  // Kept for the last few texts requested. It is a pure function of the text and walks every character of it, and the
  // editor requests it for the same program on every render (which routine a rung is in, which tags it declares):
  // ten milliseconds a render on a large program, for an unchanged answer. What is handed out is shared: read only.
  if (src.length >= MASK_MEMO_MIN) {
    const at = maskMemo.findIndex((e) => e.src === src)
    if (at >= 0) return maskMemo[at]!.mask
    const mask = maskOf(src)
    maskMemo.unshift({ src, mask })
    if (maskMemo.length > 6) maskMemo.pop()
    return mask
  }
  return maskOf(src)
}
const MASK_MEMO_MIN = 4096
const maskMemo: { src: string; mask: Uint8Array }[] = []

function maskOf(src: string): Uint8Array {
  const mask = new Uint8Array(src.length)
  const fill = (from: number, to: number): void => {
    for (let k = from; k < Math.min(to, src.length); k++) mask[k] = 1
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl < 0 ? src.length : nl
      fill(i, end)
      i = end
      continue
    }
    if (ch === '(' && src[i + 1] === '*') {
      const close = src.indexOf('*)', i + 2)
      const end = close < 0 ? src.length : close + 2
      fill(i, end)
      i = end
      continue
    }
    if (ch === "'") {
      let k = i + 1
      while (k < src.length && src[k] !== '\n') {
        if (src[k] === '$') { k += 2; continue } // an escape, so `$'` does not close the literal
        if (src[k] === "'") { k++; break }
        k++
      }
      fill(i, k)
      i = k
      continue
    }
    i++
  }
  return mask
}

/** The first index at or after `from` that is neither whitespace nor trivia. */
function firstCode(src: string, mask: Uint8Array, from: number): number {
  let i = from
  while (i < src.length && (mask[i] === 1 || /\s/.test(src[i]!))) i++
  return i
}

/** The span of the first match of `re` at or after `from` that is not inside trivia - so a
 *  keyword named in a comment (`(* ...until END_FUNCTION_BLOCK *)`) cannot be mistaken for
 *  the real one. `null` when there is no such match. Shared with the importer, which has to
 *  find the same keywords in the same not-in-a-comment way. */
export function matchInCode(src: string, mask: Uint8Array, re: RegExp, from = 0): { start: number; end: number } | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  g.lastIndex = from
  for (let m = g.exec(src); m; m = g.exec(src)) {
    if (mask[m.index] !== 1) return { start: m.index, end: m.index + m[0].length }
  }
  return null
}

/**
 * The spelling every compiler reads, for the non-IEC input forms the parser tolerates (each one our own rule for
 * reading code written elsewhere; none of them is ever written out):
 *  - the `;` after END_IF, END_CASE, END_FOR, END_WHILE, END_REPEAT and END_STRUCT, and after the last declaration of
 *    a TYPE block (parserStmt.ts `blockEnd`, parserDecl.ts `typeEnd`), which strict IEC requires and MATIEC refuses a program without;
 *  - `Mode#Idle` for an enumeration's member written `Mode.Idle` (checkExpr.ts `inferType`, the `member` case);
 *  - nothing at all for an argument named and given nothing, `Q => ,` (parserExpr.ts `blockArgs`);
 *  - `STRING[80]` for `STRING(80)` (parserDecl.ts `stringLen`);
 *  - nothing for an interface's `__SYSTEM.<name>` base, or PUBLIC / ABSTRACT on an interface's method (parser.ts
 *    `interfaceDef`);
 *  - nothing for an enumeration's base type, `(Idle, Run) UINT`;
 *  - nothing for ` AT %I*`, an address an I/O configuration completes (types.ts `Decl.linked`);
 *  - RETAIN for PERSISTENT, in IEC text.
 * Lexical: the rest of the text is the author's to the character, and text already in this form returns unchanged.
 * Each rewrite only respells what the parser reads the same either way, so a `rejects` case is still refused for
 * the reason it was written for.
 */
export function canonicalSyntax(text: string, opts: { iecText?: boolean } = {}): string {
  // empty arguments first, a pass at a time: two side by side share the comma between them, and what is left of the
  // list after one pass is what says which comma the next one takes
  let src = text
  for (let next = dropEmptyArgs(src); next !== src; next = dropEmptyArgs(src)) src = next
  const mask = maskOf(src)
  const edits: { at: number; end: number; text: string }[] = []
  const inCode = (re: RegExp, each: (m: RegExpExecArray) => void): void => {
    for (let m = re.exec(src); m; m = re.exec(src)) if (mask[m.index] !== 1) each(m)
  }
  /** The last index before `i` that is neither whitespace nor trivia, or -1. */
  const lastCode = (i: number): number => {
    let p = i - 1
    while (p >= 0 && (mask[p] === 1 || /\s/.test(src[p]!))) p--
    return p
  }

  // the `;` a block statement's (or a struct's) END keyword takes
  const semis = new Set<number>()
  inCode(/\b(?:END_IF|END_CASE|END_FOR|END_WHILE|END_REPEAT|END_STRUCT)\b/gi, (m) => {
    const end = m.index + m[0].length
    if (src[firstCode(src, mask, end)] !== ';') semis.add(end)
  })
  // the `;` ending the last declaration of a TYPE block (`TYPE Mode : (Idle, Run) END_TYPE`); after END_STRUCT that
  // is the position above, and a Set makes it one `;`
  const typeBlocks: { start: number; end: number }[] = []
  inCode(/\bTYPE\b/gi, (m) => {
    const close = matchInCode(src, mask, /\bEND_TYPE\b/i, m.index)
    if (!close) return
    typeBlocks.push({ start: m.index, end: close.start })
    const p = lastCode(close.start)
    if (p > m.index + 3 && src[p] !== ';') semis.add(p + 1)
  })
  for (const p of semis) edits.push({ at: p, end: p, text: ';' })

  // `STRING(80)` -> `STRING[80]`: IEC writes a capacity in brackets (parserDecl.ts `stringLen` reads either)
  inCode(/\b(W?STRING)[ \t]*\([ \t]*(\d+)[ \t]*\)/gi, (m) => {
    if (src[m.index - 1] !== '.' && src[m.index - 1] !== '#') edits.push({ at: m.index, end: m.index + m[0].length, text: `${m[1]}[${m[2]}]` })
  })

  // ` AT %I*`: an address only an I/O configuration completes, which IEC writes in a VAR_CONFIG no target here
  // reads; the scene's wiring is this program's I/O configuration (types.ts Decl.linked), so the variable goes out plain
  inCode(/[ \t]*\bAT[ \t]+%[IQM][XBWDL]?\*/gi, (m) => {
    const word = m.index + m[0].search(/AT/i)
    if (mask[word] !== 1) edits.push({ at: m.index, end: m.index + m[0].length, text: '' })
  })

  // `VAR PERSISTENT`, in IEC text only (PLCopen says `persistent`): a non-IEC word for a value that survives a download
  // too; IEC has RETAIN, its nearest, and one RETAIN is enough when both are written (types.ts Decl.persistent)
  if (opts.iecText) inCode(/\bVAR(?:_GLOBAL|_INPUT|_OUTPUT)?((?:[ \t]+(?:CONSTANT|RETAIN|NON_RETAIN|PERSISTENT)\b)+)/gi, (m) => {
    const words = m[1]!.trim().split(/[ \t]+/)
    if (!words.some((w) => w.toUpperCase() === 'PERSISTENT')) return
    const kept = words.filter((w) => w.toUpperCase() !== 'PERSISTENT')
    if (!kept.some((w) => w.toUpperCase() === 'RETAIN')) kept.push('RETAIN')
    const at = m.index + m[0].length - m[1]!.length
    edits.push({ at, end: m.index + m[0].length, text: ` ${kept.join(' ')}` })
  })

  // what the parser reads in an interface as saying nothing (parser.ts `interfaceDef`): a base in the `__SYSTEM`
  // namespace (a runtime's own root interface), with the comma joining it to another base, and PUBLIC / ABSTRACT on a
  // method
  inCode(/\bINTERFACE[ \t]+[A-Za-z_]/gi, (m) => {
    const close = matchInCode(src, mask, /\bEND_INTERFACE\b/i, m.index)
    if (!close) return
    const head = matchInCode(src, mask, /\bEXTENDS\b/i, m.index)
    const firstMember = matchInCode(src, mask, /\b(?:METHOD)\b/i, m.index)
    const headEnd = Math.min(firstMember?.start ?? close.start, close.start)
    if (head && head.start < headEnd) {
      const sys = /(\s*,\s*)?\b__SYSTEM[ \t]*\.[ \t]*[A-Za-z_]\w*\b(\s*,\s*)?/gi
      sys.lastIndex = head.end
      for (let s = sys.exec(src); s && s.index < headEnd; s = sys.exec(src)) {
        if (mask[s.index + (s[1]?.length ?? 0)] === 1) continue
        // alone, EXTENDS goes with it; in a list, the comma joining it, or one comma for the two around it
        const lone = !s[1] && !s[2]
        let at = lone ? head.start : s.index
        while (lone && (src[at - 1] === ' ' || src[at - 1] === '\t')) at--
        edits.push({ at, end: s.index + s[0].length, text: s[1] && s[2] ? ', ' : '' })
      }
    }
    const mod = /\bMETHOD([ \t]+(?:PUBLIC|ABSTRACT)\b)+/gi
    mod.lastIndex = m.index
    for (let s = mod.exec(src); s && s.index < close.start; s = mod.exec(src)) {
      if (mask[s.index] !== 1) edits.push({ at: s.index + 'METHOD'.length, end: s.index + s[0].length, text: '' })
    }
  })

  // `(Idle, Run) UINT`: a base type for an enumeration's values (an input form), which IEC's 2nd edition has no place for (and
  // which the engine holds as INT anyway: types.ts EnumDef.base)
  for (const b of typeBlocks) {
    const based = /\)[ \t]*\b(?:SINT|INT|DINT|USINT|UINT|UDINT|BYTE|WORD|DWORD)\b(?=\s*(?:;|END_TYPE))/gi
    based.lastIndex = b.start
    for (let m = based.exec(src); m && m.index < b.end; m = based.exec(src)) {
      if (mask[m.index] !== 1) edits.push({ at: m.index + 1, end: m.index + m[0].length, text: '' })
    }
  }

  // `Mode.Idle` -> `Mode#Idle`, for every enumeration a TYPE block declares
  const enums = new Set<string>()
  for (const b of typeBlocks) {
    const decl = /\b([A-Za-z_]\w*)\s*:\s*\(/g
    decl.lastIndex = b.start
    for (let m = decl.exec(src); m && m.index < b.end; m = decl.exec(src)) if (mask[m.index] !== 1) enums.add(m[1]!.toUpperCase())
  }
  if (enums.size > 0) {
    inCode(/\b([A-Za-z_]\w*)[ \t]*\.[ \t]*([A-Za-z_]\w*)/g, (m) => {
      const before = src[m.index - 1]
      if (enums.has(m[1]!.toUpperCase()) && before !== '.' && before !== '#') edits.push({ at: m.index, end: m.index + m[0].length, text: `${m[1]}#${m[2]}` })
    })
  }

  return applyEdits(src, edits)
}

/** One pass of `Q => ,` / `IN := ,` / `, Q => )`: each argument given nothing, dropped with the comma separating it.
 *  Of two that would take the same comma only the first goes; the next pass sees the list without it. */
function dropEmptyArgs(src: string): string {
  const mask = maskOf(src)
  const edits: { at: number; end: number; text: string }[] = []
  const re = /\b[A-Za-z_]\w*[ \t]*(?::=|=>)/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (mask[m.index] === 1) continue
    const next = firstCode(src, mask, m.index + m[0].length)
    if (src[next] === ',') {
      let end = next + 1
      while (end < src.length && (src[end] === ' ' || src[end] === '\t')) end++
      edits.push({ at: m.index, end, text: '' })
    } else if (src[next] === ')') {
      let p = m.index - 1
      while (p >= 0 && (mask[p] === 1 || /\s/.test(src[p]!))) p--
      edits.push({ at: src[p] === ',' ? p : m.index, end: next, text: '' })
    }
  }
  return applyEdits(src, edits)
}

/** Text with each edit's span replaced; an edit overlapping one before it is left for another pass. */
function applyEdits(src: string, edits: { at: number; end: number; text: string }[]): string {
  if (edits.length === 0) return src
  edits.sort((a, b) => a.at - b.at || a.end - b.end)
  let out = ''
  let from = 0
  for (const e of edits) {
    if (e.at < from) continue
    out += src.slice(from, e.at) + e.text
    from = e.end
  }
  return out + src.slice(from)
}


/** Leading POU definitions, longest keyword first so END_FUNCTION_BLOCK is never mistaken
 *  for END_FUNCTION. The parser requires these before the program's own VAR sections, so
 *  peeling them off the front is exact rather than heuristic. The open patterns are tested
 *  at the first code character, so leading comments and blank lines are already behind us. */
const POU_BLOCKS = [
  { open: /^TYPE\b/i, close: /\bEND_TYPE\b/i, kind: 'type' as const },
  { open: /^VAR_GLOBAL\b/i, close: /\bEND_VAR\b/i, kind: 'global' as const },
  { open: /^FUNCTION_BLOCK\b/i, close: /\bEND_FUNCTION_BLOCK\b/i, kind: 'fb' as const },
  // (opened by its word and a name, so a statement about a variable called `interface` is never one)
  { open: /^INTERFACE\s+[A-Za-z_]/i, close: /\bEND_INTERFACE\b/i, kind: 'interface' as const },
  { open: /^FUNCTION\b/i, close: /\bEND_FUNCTION\b/i, kind: 'func' as const },
]

/** Split a program into its leading definitions and the main program text. */
export function splitProgram(src: string): SplitProgram {
  const mask = triviaMask(src)
  const types: string[] = []
  const globals: string[] = []
  const pous: { kind: 'fb' | 'func'; text: string }[] = []
  const blocks: SplitProgram['blocks'] = []
  let at = 0
  for (;;) {
    const start = firstCode(src, mask, at)
    const block = POU_BLOCKS.find((b) => b.open.test(src.slice(start)))
    if (!block) break
    const closed = matchInCode(src, mask, block.close, start)
    if (!closed) throw new Error(`unterminated block (expected ${block.close})`)
    const close = closed.end
    // sliced from `at`, not from `start`: a comment sitting above a POU documents it, so it
    // travels with the POU instead of being stranded in the program body
    const text = src.slice(at, close).trim()
    if (block.kind === 'type' || block.kind === 'interface') types.push(text)
    else if (block.kind === 'global') globals.push(text)
    else pous.push({ kind: block.kind, text })
    blocks.push({ kind: block.kind, text })
    at = close
  }
  return { types, globals, pous, blocks, program: src.slice(at).trim() }
}

/** A top-level block of a file that declares its own PROGRAMs or a CONFIGURATION. */
export interface LibraryBlock {
  kind: 'type' | 'global' | 'fb' | 'interface' | 'func' | 'program' | 'configuration'
  text: string
}

/** Every library element IEC puts at the top of a file. A PROGRAM or CONFIGURATION opens with its
 *  word and then a name, so a statement about a variable called `program` (`program := 1`) is never
 *  taken for one; inside a CONFIGURATION, `PROGRAM Inst WITH Fast : Merge;` is part of that block. */
const LIBRARY_BLOCKS = [
  ...POU_BLOCKS,
  { open: /^PROGRAM\s+[A-Za-z_]/i, close: /\bEND_PROGRAM\b/i, kind: 'program' as const },
  { open: /^CONFIGURATION\s+[A-Za-z_]/i, close: /\bEND_CONFIGURATION\b/i, kind: 'configuration' as const },
]

/**
 * Split a file into all of its top-level blocks, PROGRAM POUs and the CONFIGURATION among them, in
 * source order. `rest` is whatever follows the last block: the implicit program's body, which a file
 * with PROGRAMs must not have (the checker says so), handed back so nothing is dropped. The `;` IEC
 * tolerates after an END_ keyword travels with the block it closes rather than ending the split.
 */
export function splitLibrary(src: string): { blocks: LibraryBlock[]; rest: string } {
  const mask = triviaMask(src)
  const blocks: LibraryBlock[] = []
  let at = 0
  for (;;) {
    const start = firstCode(src, mask, at)
    const block = LIBRARY_BLOCKS.find((b) => b.open.test(src.slice(start)))
    if (!block) break
    const closed = matchInCode(src, mask, block.close, start)
    if (!closed) throw new Error(`unterminated block (expected ${block.close})`)
    // the `;` IEC tolerates after an END_ keyword belongs to the block it closes, so a document split
    // into blocks and joined again keeps it
    const next = firstCode(src, mask, closed.end)
    const end = src[next] === ';' ? next + 1 : closed.end
    blocks.push({ kind: block.kind, text: src.slice(at, end).trim() })
    at = end
  }
  return { blocks, rest: src.slice(at).trim() }
}

/** The name a PROGRAM or CONFIGURATION block declares, read past any comment written above it. */
export function declaredLibraryName(text: string, word: 'PROGRAM' | 'CONFIGURATION'): string {
  const re = new RegExp(`\\b${word}\\s+([A-Za-z_]\\w*)`, 'i')
  const m = matchInCode(text, triviaMask(text), re)
  return m ? re.exec(text.slice(m.start, m.end))![1]! : ''
}

/*
 * Why there is no `STRING[n]` → `TYPE StrN` hoist here. MATIEC's own grammar settles it:
 *
 *   - The sized form is the standard's: `var_init_decl` includes `string_var_declaration`, and
 *     `single_byte_string_spec: STRING '[' integer ']'`, reachable from every var section.
 *   - The hoisted form does not even parse: `simple_specification` accepts only elementary or
 *     `prev_declared_simple_type_name`, while a `string_type_declaration` name is registered under a different
 *     token class ("invalid specification in variable declaration" in all nine STRING cases).
 *
 * The sized form fails in MATIEC for its own reason: `search_base_type.cc` has no visitor for
 * `single_byte_string_spec_c`, so the datatype never resolves ("Variable not declared in this scope"). Neither
 * spelling compiles there, so the one corpus case that needs a capacity is withheld from the oracle with that
 * reason (conformanceCases.ts), and the export emits what the author wrote, in IEC's bracketed form (`STRING(n)`
 * and a constant capacity are respelled that way: `canonicalSyntax`, and export.ts `foldedCapacities`).
 */

/**
 * Wrap a program in the configuration layer the subset does not have.
 *
 * In the simulator the scan is driven by the sim clock and I/O binds through the scene's
 * tag model rather than `%I`/`%Q` - both by design (see docs/architecture.md). A
 * spec-complete toolchain needs both to exist, so they are synthesised here: one
 * CONFIGURATION, one RESOURCE, one periodic TASK, one PROGRAM instance. Nothing
 * vendor-specific is baked into the program itself, which is exactly why one body can be
 * wrapped for several targets.
 */
export function renderIecText(source: string, opts: IecTextOptions = {}): string {
  source = canonicalSyntax(source, { iecText: true })
  const outside = controllerBody(source)
  if (outside) return renderControllerBody(outside, opts)
  const library = splitLibrary(source)
  if (library.blocks.some((b) => b.kind === 'program' || b.kind === 'configuration')) return renderController(library, opts)
  const programName = opts.programName ?? 'Main'
  const scanMs = opts.scanMs ?? 100
  const { blocks, globals, program } = splitProgram(source)

  const banner = opts.banner === false
    ? []
    : [
        `(* Exported from ${opts.companyName ?? 'Open Industry Project'}${opts.projectName ? ` - project "${opts.projectName}"` : ''} *)`,
        `(* The CONFIGURATION/RESOURCE/TASK wrapper below is GENERATED: in the simulator the *)`,
        `(* scan is driven by the sim clock and I/O binds through scene tags, so a target's  *)`,
        `(* scheduling and addressing are supplied on export rather than authored.           *)`,
        ``,
      ]

  return [
    ...banner,
    // in the order they were authored, not regrouped by kind: a TYPE declared between two
    // function blocks is ordinary ST, and emitting all types before all POUs would hoist it to
    // the top of someone's file for no reason the standard asks for. VAR_GLOBAL is the one
    // exception, and it is a real one - IEC puts globals on the CONFIGURATION, below.
    ...blocks.filter((b) => b.kind !== 'global').flatMap((b) => [b.text, '']),
    `PROGRAM ${programName}`,
    program,
    `END_PROGRAM`,
    ``,
    `CONFIGURATION Config0`,
    // VAR_GLOBALs belong to the CONFIGURATION in IEC, not to file scope
    ...globals.map(indent),
    `  RESOURCE Res0 ON PLC`,
    `    TASK Tick(INTERVAL := T#${scanMs}ms, PRIORITY := 0);`,
    `    PROGRAM Inst0 WITH Tick : ${programName};`,
    `  END_RESOURCE`,
    `END_CONFIGURATION`,
    ``,
  ].join('\n')
}

const indent = (block: string): string => block.split('\n').map((l) => `  ${l}`).join('\n')

/**
 * A file that declares its own PROGRAMs. Its POUs go out as written, in their order; the one thing
 * moved is a file-level VAR_GLOBAL, which IEC puts on the CONFIGURATION. A file with a CONFIGURATION
 * keeps it, with those globals placed right after its name, where IEC's grammar has them. A lone
 * PROGRAM with none runs on the scan time, exactly like the implicit program, so it is wrapped the
 * same way.
 */
function renderController({ blocks, rest }: { blocks: LibraryBlock[]; rest: string }, opts: IecTextOptions): string {
  const globals = blocks.filter((b) => b.kind === 'global').map((b) => b.text)
  const config = blocks.find((b) => b.kind === 'configuration')
  const program = blocks.find((b) => b.kind === 'program')
  const banner = opts.banner === false
    ? []
    : [
        `(* Exported from ${opts.companyName ?? 'Open Industry Project'}${opts.projectName ? ` - project "${opts.projectName}"` : ''} *)`,
        ...(config
          ? []
          : [
              `(* The CONFIGURATION/RESOURCE/TASK wrapper below is GENERATED: in the simulator the *)`,
              `(* program runs on the scene's scan time, so the target's task is supplied here.    *)`,
            ]),
        ``,
      ]
  const out = [...banner, ...blocks.filter((b) => b.kind !== 'global' && b.kind !== 'configuration').flatMap((b) => [b.text, ''])]
  if (config) {
    out.push(withGlobals(config.text, globals), '')
  } else {
    out.push(
      `CONFIGURATION Config0`,
      ...globals.map(indent),
      `  RESOURCE Res0 ON PLC`,
      `    TASK Tick(INTERVAL := T#${opts.scanMs ?? 100}ms, PRIORITY := 0);`,
      `    PROGRAM Inst0 WITH Tick : ${program ? declaredLibraryName(program.text, 'PROGRAM') : (opts.programName ?? 'Main')};`,
      `  END_RESOURCE`,
      `END_CONFIGURATION`,
      ``,
    )
  }
  // not something a valid file has; carried verbatim so a compiler judges what was actually written
  if (rest !== '') out.push(rest, '')
  return out.join('\n')
}

/** A CONFIGURATION's text with file-level VAR_GLOBAL blocks placed after its name. */
function withGlobals(configText: string, globals: string[]): string {
  if (globals.length === 0) return configText
  const header = matchInCode(configText, triviaMask(configText), /\bCONFIGURATION\s+[A-Za-z_]\w*/i)
  if (!header) return configText
  return `${configText.slice(0, header.end)}\n${globals.map(indent).join('\n')}${configText.slice(header.end)}`
}

// ---- a CONFIGURATION that runs code outside every POU ----
//
// Beside a CONFIGURATION, this engine lets variables and statements stand outside every POU: the variables
// are the controller's tags, and a PROGRAM line that names no type runs the statements (`controllerTags` in
// program.ts). That is how a scene's program keeps its tags' bare names while PROGRAMs run beside it on
// tasks. Neither half is IEC, so an export writes that code as a PROGRAM of its own and gives the line that
// type. Its variables stay the PROGRAM's own unless another POU names one; then they are VAR_GLOBALs in the
// CONFIGURATION, reached through VAR_EXTERNAL, which is how IEC spells a variable two POUs share.

/** One VAR section outside every POU, as written. */
export interface BodySection {
  /** VAR, VAR_INPUT, VAR_OUTPUT, VAR_EXTERNAL, ... */
  keyword: string
  /** the section with any comment above it */
  text: string
  /** the same section declared VAR_GLOBAL */
  asGlobal: string
  constant: boolean
  /** each name it declares, with its type as written */
  decls: { name: string; type: string }[]
}

/** A file whose CONFIGURATION runs code outside every POU, in the pieces an export writes it from. */
export interface ControllerBody {
  /** the file's other top-level blocks, in order */
  blocks: LibraryBlock[]
  sections: BodySection[]
  /** the statements outside every POU */
  statements: string
  configuration: string
  /** the instances that name no type; a program that checks has at most one */
  runners: string[]
  /** the PROGRAM type the code is exported as: `<runner>Program`, past any name the file already spells */
  typeName: string
  /** another POU names one of its variables, so they go out as VAR_GLOBALs */
  shared: boolean
}

const SECTION_OPEN = /^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_EXTERNAL|VAR_TEMP|VAR)\b/i
/** a section's qualifiers; a variable may be called `retain`, which is followed by `:` or `,` */
const SECTION_QUALIFIERS = /^\s*(?:(?:CONSTANT|RETAIN|NON_RETAIN)\b(?!\s*[:,])\s*)*/i
/** `PROGRAM [RETAIN] Name [WITH Task];`: an instance line that names no type */
const RUNNER_LINE = /\bPROGRAM(?:\s+(?:RETAIN|NON_RETAIN))?\s+([A-Za-z_]\w*)(?:\s+WITH\s+[A-Za-z_]\w*)?\s*;/gi

/** `src` from `from` to `to` with comments and literals blanked, so a name or a type reads as code. */
function codeOnly(src: string, mask: Uint8Array, from: number, to: number): string {
  let out = ''
  for (let i = from; i < to; i++) out += mask[i] === 1 ? ' ' : src[i]
  return out
}

/** Every identifier `text` spells in code, upper-cased. */
function codeWords(text: string): Set<string> {
  const mask = triviaMask(text)
  const out = new Set<string>()
  const re = /[A-Za-z_]\w*/g
  for (let m = re.exec(text); m; m = re.exec(text)) if (mask[m.index] !== 1) out.add(m[0].toUpperCase())
  return out
}

/** `a, b AT %IX0.0 : TYPE := init;` ... from `from` to `to`: each name, with its type as written. */
function declarations(src: string, mask: Uint8Array, from: number, to: number): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = []
  for (let at = from; at < to; ) {
    const semi = matchInCode(src, mask, /;/, at)
    const end = semi && semi.start < to ? semi.start : to
    const colon = matchInCode(src, mask, /:(?!=)/, at)
    if (colon && colon.start < end) {
      const assign = matchInCode(src, mask, /:=/, colon.end)
      const type = codeOnly(src, mask, colon.end, assign && assign.start < end ? assign.start : end).replace(/\s+/g, ' ').trim()
      for (const name of codeOnly(src, mask, at, colon.start).split(/\bAT\b/i)[0]!.split(',')) {
        if (name.trim() !== '') out.push({ name: name.trim(), type })
      }
    }
    at = end + 1
  }
  return out
}

/** A CONFIGURATION written after the code outside every POU, where a controller table's generated one sits
 *  (plc/controller.ts). Its name is followed by what only a CONFIGURATION holds, which a statement about a
 *  variable called `configuration` never is.
 *
 *  Exported because {@link splitLibrary} cannot see it: that scan stops at the first text which is not a
 *  block, so everything from the code onwards - the CONFIGURATION included - comes back as `rest`. Callers
 *  that need the blocks a file really has (document.ts's model, and this file's own export path) split the
 *  remainder with this. */
export function trailingConfiguration(rest: string): { body: string; configuration: string } | null {
  const m = matchInCode(rest, triviaMask(rest), /\bCONFIGURATION\s+[A-Za-z_]\w*\s+(?:VAR_GLOBAL|RESOURCE|TASK|PROGRAM)\b/i)
  return m ? { body: rest.slice(0, m.start).trim(), configuration: rest.slice(m.start).trim() } : null
}

/** The instance lines in a CONFIGURATION that name no type: each name, and where its `;` is. */
function runnerLines(config: string): { name: string; semicolon: number }[] {
  const mask = triviaMask(config)
  const out: { name: string; semicolon: number }[] = []
  const re = new RegExp(RUNNER_LINE.source, 'gi')
  for (let m = re.exec(config); m; m = re.exec(config)) {
    if (mask[m.index] !== 1) out.push({ name: m[1]!, semicolon: m.index + m[0].length - 1 })
  }
  return out
}

/** A file whose CONFIGURATION runs code outside every POU, split for export; null for any other file. */
export function controllerBody(src: string): ControllerBody | null {
  let lib: { blocks: LibraryBlock[]; rest: string }
  try {
    lib = splitLibrary(src)
  } catch {
    // both callers run splitLibrary themselves, so an unterminated block still surfaces there
    return null
  }
  let body = lib.rest
  let configuration = lib.blocks.find((b) => b.kind === 'configuration')?.text
  if (configuration === undefined) {
    const trailing = trailingConfiguration(lib.rest)
    if (!trailing) return null
    body = trailing.body
    configuration = trailing.configuration
  }
  const runners = runnerLines(configuration).map((r) => r.name)
  const mask = triviaMask(body)
  if (firstCode(body, mask, 0) >= body.length && runners.length === 0) return null

  const sections: BodySection[] = []
  let at = 0
  for (;;) {
    const start = firstCode(body, mask, at)
    const open = SECTION_OPEN.exec(body.slice(start))
    if (!open) break
    const keywordEnd = start + open[0].length
    const close = matchInCode(body, mask, /\bEND_VAR\b/i, keywordEnd)
    if (!close) break
    const next = firstCode(body, mask, close.end)
    const end = body[next] === ';' ? next + 1 : close.end
    const qualifiers = SECTION_QUALIFIERS.exec(codeOnly(body, mask, keywordEnd, close.start))![0]
    sections.push({
      keyword: open[1]!.toUpperCase(),
      text: body.slice(at, end).trim(),
      asGlobal: `${body.slice(at, start)}VAR_GLOBAL${body.slice(keywordEnd, end)}`.trim(),
      constant: /\bCONSTANT\b/i.test(qualifiers),
      decls: declarations(body, mask, keywordEnd + qualifiers.length, close.start),
    })
    at = end
  }

  const tags = new Set(sections.filter((s) => s.keyword !== 'VAR_EXTERNAL').flatMap((s) => s.decls.map((d) => d.name.toUpperCase())))
  const pous = lib.blocks.filter((b) => b.kind === 'program' || b.kind === 'fb' || b.kind === 'func')
  const shared = pous.some((b) => [...codeWords(b.text)].some((w) => tags.has(w)))
  const used = codeWords(src)
  const base = `${runners[0] ?? 'Main'}Program`
  let typeName = base
  for (let n = 1; used.has(typeName.toUpperCase()); n++) typeName = `${base}${n}`
  return { blocks: lib.blocks.filter((b) => b.kind !== 'configuration'), sections, statements: body.slice(at).trim(), configuration, runners, typeName, shared }
}

/** The VAR_EXTERNAL blocks through which the exported PROGRAM reaches the tags it declared, CONSTANT ones apart. */
function externalsFor(sections: BodySection[]): string[] {
  const tags = sections.filter((s) => s.keyword !== 'VAR_EXTERNAL')
  const block = (constant: boolean): string[] => {
    const decls = tags.filter((s) => s.constant === constant).flatMap((s) => s.decls)
    return decls.length === 0 ? [] : [`VAR_EXTERNAL${constant ? ' CONSTANT' : ''}`, ...decls.map((d) => `  ${d.name} : ${d.type};`), 'END_VAR']
  }
  return [...block(false), ...block(true)]
}

/** A CONFIGURATION with each instance that names no type given `typeName`. */
function typedRunners(config: string, typeName: string): string {
  let out = config
  for (const r of runnerLines(config).reverse()) out = `${out.slice(0, r.semicolon)} : ${typeName}${out.slice(r.semicolon)}`
  return out
}

function renderControllerBody(b: ControllerBody, opts: IecTextOptions): string {
  const banner = opts.banner === false
    ? []
    : [
        `(* Exported from ${opts.companyName ?? 'Open Industry Project'}${opts.projectName ? ` - project "${opts.projectName}"` : ''} *)`,
        `(* The code outside every PROGRAM in the simulator is PROGRAM ${b.typeName} here, run by the CONFIGURATION. *)`,
        ``,
      ]
  // with nothing to run them, the variables are the controller's alone, so they are globals either way
  const asGlobals = b.shared || b.runners.length === 0
  const out = [...banner, ...b.blocks.filter((x) => x.kind !== 'global').flatMap((x) => [x.text, ''])]
  if (b.runners.length > 0) {
    out.push(
      `PROGRAM ${b.typeName}`,
      ...(asGlobals ? [...externalsFor(b.sections), ...b.sections.filter((s) => s.keyword === 'VAR_EXTERNAL').map((s) => s.text)] : b.sections.map((s) => s.text)),
      ...(b.statements !== '' ? [b.statements] : []),
      `END_PROGRAM`,
      ``,
    )
  }
  const globals = [
    ...b.blocks.filter((x) => x.kind === 'global').map((x) => x.text),
    ...(asGlobals ? b.sections.filter((s) => s.keyword !== 'VAR_EXTERNAL').map((s) => s.asGlobal) : []),
  ]
  out.push(withGlobals(typedRunners(b.configuration, b.typeName), globals), ``)
  return out.join('\n')
}
