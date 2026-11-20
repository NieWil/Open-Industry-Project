// The token cursor the ST parser (parser.ts) is built on: reading and expecting tokens, error recovery, and
// the state one parse keeps. The parser is a chain of classes, one per layer of the language, each built on
// the one below: this cursor, then expressions, statements, ladder sections, declarations, and POUs on top.

import type { Decl, Diagnostic, EnumDef, Expr, Token } from './types'
import { StError } from './types'
import type { LdSection } from './ladder/ladder'

export const VAR_SECTIONS = new Set<string>(['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_TEMP', 'VAR_IN_OUT', 'VAR_EXTERNAL'])

/** 3rd-edition constructs this subset does not have, reported by name instead of as a syntax error - see
 *  `rejectUnsupported`. (Methods, interfaces and inheritance are implemented, on function blocks.) */
const OOP_CONSTRUCTS: Record<string, string> = {
  CLASS: 'a CLASS is not implemented; use a FUNCTION_BLOCK, which takes METHODs, EXTENDS and IMPLEMENTS here and is what a PLC instantiates',
  NAMESPACE: 'IEC 3rd-edition namespaces are not implemented; names are flat in this subset',
  USING: 'IEC 3rd-edition namespaces are not implemented; names are flat in this subset',
}

/** The object-oriented words, reported by name when they turn up where they cannot stand (in statement position). */
const OOP_PLACEMENT: Record<string, string> = {
  METHOD: 'a METHOD is declared inside a FUNCTION_BLOCK, after its variables (or inside an INTERFACE, as a signature)',
  INTERFACE: 'an INTERFACE is declared at the top level of a file, like a FUNCTION_BLOCK',
  EXTENDS: 'EXTENDS is written after the name of the block it derives: FUNCTION_BLOCK Pump EXTENDS Motor',
  IMPLEMENTS: 'IMPLEMENTS is written after the name of the block: FUNCTION_BLOCK Pump IMPLEMENTS IDrive',
  ABSTRACT: 'ABSTRACT is written after FUNCTION_BLOCK or METHOD: FUNCTION_BLOCK ABSTRACT Motor',
  VAR_STAT: 'VAR_STAT is not implemented; declare the variable in the function block, or as a VAR_GLOBAL',
}

/** Vendor words that are not IEC 61131-3, refused by name with the IEC form to write instead (`rejectUnsupported`). */
export const NOT_IEC: Record<string, string> = {
  PROPERTY: 'PROPERTY is not part of IEC 61131-3; use a METHOD (or a pair of methods) instead',
  VAR_INST: "VAR_INST is not part of IEC 61131-3; declare the variable in the FUNCTION_BLOCK's VAR instead, where it keeps its value between calls",
}
/**
 * The configuration layer, reported by name when it turns up where it cannot stand.
 *
 * PROGRAM and CONFIGURATION are declarations, taken at the top of a file (see parser.ts `parse`), so these
 * only fire in statement position: a PROGRAM written after an implicit program's statements, a TASK
 * outside any CONFIGURATION. Saying where the construct belongs beats "expected ':='", which is what
 * an author saw when they pasted a vendor file's pieces in the wrong order.
 */
const CONFIG_PLACEMENT: Record<string, string> = {
  CONFIGURATION: 'a CONFIGURATION is declared at the top level of a file, and a file that has one puts every variable and statement inside a PROGRAM',
  RESOURCE: 'a RESOURCE is declared inside a CONFIGURATION',
  TASK: 'a TASK is declared inside a CONFIGURATION, or inside its RESOURCE',
  PROGRAM: 'a PROGRAM is declared at the top level of a file, before any statement; a file that declares PROGRAMs puts every variable and statement inside one',
}

/** The parts of the configuration layer this subset does not have at all. */
const CONFIG_CONSTRUCTS: Record<string, string> = {
  VAR_ACCESS: 'VAR_ACCESS is not implemented; there are no access paths in this subset',
  VAR_CONFIG: 'VAR_CONFIG is not implemented; there are no instance-specific initial values in this subset',
}

/** Sequential Function Chart, reported by name through the same path. SFC is a separate
 *  IEC language, not part of ST: a step/transition graph with its own execution model,
 *  so there is nothing to add to the parser. The body would have to be run, not read.
 *  Naming it matters because an SFC program otherwise produces a long run of `expected ':='`
 *  errors (Annex F's own `gravel` example is one, and reads as a broken file rather than a
 *  different language). `.X` and `.T` on a step are SFC too, but they are ordinary member
 *  access and cannot be told apart from a struct field here, so only the headers are named. */
const SFC_CONSTRUCTS: Record<string, string> = {
  INITIAL_STEP: 'Sequential Function Chart is a separate IEC language, not implemented here; express the state machine in ST (a CASE on a state variable is the usual translation)',
  STEP: 'Sequential Function Chart is a separate IEC language, not implemented here; express the state machine in ST (a CASE on a state variable is the usual translation)',
  TRANSITION: 'Sequential Function Chart is a separate IEC language, not implemented here; a transition condition becomes the CASE branch guard that advances the state variable',
  ACTION: 'Sequential Function Chart is a separate IEC language, not implemented here; an action body becomes the work done inside that state\'s CASE branch',
}

/** Where a statement can plausibly begin - a resynchronisation point after a syntax error. */
const STMT_START = new Set<string>(['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'EXIT', 'CONTINUE', 'RETURN'])
/** Block terminators. Recovery stops at one rather than running past it into the parent. */
const BLOCK_END = new Set<string>([
  'END_IF', 'ELSIF', 'ELSE', 'END_CASE', 'END_FOR', 'END_WHILE', 'UNTIL', 'END_REPEAT',
  'END_VAR', 'END_TYPE', 'END_STRUCT', 'END_FUNCTION', 'END_FUNCTION_BLOCK',
])

export class ParserBase {
  protected p = 0
  /** the `VAR ... END_VAR` blocks read so far, which numbers each declaration's block */
  protected blocks = 0
  /** every `LADDER ... END_LADDER` read so far (ladder.ts), in source order */
  protected ladder: LdSection[] = []
  /** the temporaries the current POU's ladder needs declared; the POU takes them when its body ends (pouBody) */
  protected ladderTemps: Decl[] = []
  /** where the current POU's statements begin, i.e. the end of its VAR sections */
  protected declEnd = 0
  /** reading a FUNCTION's body, which keeps nothing between calls */
  protected inFunction = false
  /** every identifier the file spells, folded, so a ladder temporary never takes one */
  protected spelled: Set<string> | null = null
  /** statements read that were not ladder, since the current POU's body began: none means a lone section is the body */
  protected plain = 0
  protected bitRefs: number[] = []
  protected usesBits = false
  /** enumerations declared in a variable's declaration (`m : (Idle, Run)`), which join the program's enumerations */
  protected inlineEnums: EnumDef[] = []
  /** STRING capacities written as constant expressions (stringLen), for the checker to fold */
  protected capacities: Expr[] = []
  /** where each of `capacities` is written: its brackets, from the opening one to just past the closing one */
  protected capacitySpans: { start: number; end: number }[] = []
  /** When present, syntax errors are recorded and parsing resumes at the next statement
   *  instead of aborting. `compile()` passes null (fail fast - it is the execution path);
   *  `diagnostics()` passes an array, so an editor can show every error at once instead of
   *  making the author fix them one recompile at a time. */
  constructor(protected toks: Token[], protected sink: Diagnostic[] | null = null) {}

  protected note(e: unknown): void {
    if (!(e instanceof StError) || !this.sink) throw e
    this.sink.push({ message: e.message, pos: e.pos, length: e.length })
  }

  /** Skip forward to the next point a statement or declaration could start. */
  protected recover(atEnd: () => boolean): void {
    for (;;) {
      const t = this.peek()
      if (t.kind === 'eof' || atEnd()) return
      if (t.kind === 'op' && t.value === ';') {
        this.next() // the separator itself is consumed; the next statement starts after it
        return
      }
      if (t.kind === 'kw' && (STMT_START.has(t.value) || BLOCK_END.has(t.value))) return
      this.next()
    }
  }

  protected peek(k = 0): Token {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)]!
  }
  protected next(): Token {
    return this.toks[this.p++]!
  }
  protected isOp(v: string): boolean {
    const t = this.peek()
    return t.kind === 'op' && t.value === v
  }
  protected isKw(v: string): boolean {
    const t = this.peek()
    return t.kind === 'kw' && t.value === v
  }
  protected eatOp(v: string): Token {
    if (!this.isOp(v)) throw new StError(`expected '${v}'`, this.peek().pos)
    return this.next()
  }
  protected eatKw(v: string): Token {
    if (!this.isKw(v)) throw new StError(`expected ${v}`, this.peek().pos)
    return this.next()
  }

  /** An identifier spelled `word` (case-insensitive) at `k` tokens ahead. The configuration layer's
   *  words are not reserved (see KEYWORDS), so this is how the parser recognises them. */
  protected isWord(word: string, k = 0): boolean {
    const t = this.peek(k)
    return t.kind === 'ident' && t.value.toUpperCase() === word
  }
  protected eatWord(word: string): Token {
    if (!this.isWord(word)) throw new StError(`expected ${word}`, this.peek().pos)
    return this.next()
  }
  protected ident(what: string): Token {
    const t = this.peek()
    if (t.kind !== 'ident') throw new StError(`expected ${what}`, t.pos)
    return this.next()
  }
  /**
   * The name of a TYPE, where only a type can stand (a declaration, EXTENDS, IMPLEMENTS, ARRAY OF, REF_TO, a
   * result): `Pkg`, or `JsonLib.JsonParser`, a type with a namespace in front of it, which is dropped: here a dotted
   * name cannot be a place, so the name after the last dot is the type. The token returned is the last name's.
   */
  protected typeName(): Token {
    let t = this.next()
    while (this.isOp('.') && this.peek(1).kind === 'ident') {
      this.next()
      t = this.next()
    }
    return t
  }

  /**
   * Constructs that are valid ST but outside this subset: IEC 61131-3 third-edition object
   * orientation, and the CONFIGURATION layer.
   *
   * These are not reserved words here (reserving them would break a program that legitimately
   * has a variable called `Method`), so they arrive as ordinary identifiers and the parser
   * would otherwise fail on the next token: `FUNCTION_BLOCK Pump EXTENDS Base` would report
   * "expected ':='", a syntax error that isn't there. Naming the construct matches what the
   * type checker does for WSTRING and LINT: the program is valid ST, but outside the subset.
   * For the configuration layer, the message points to the path that does accept it (Import .st).
   */
  protected rejectUnsupported(): void {
    const t = this.peek()
    if (t.kind !== 'ident') return
    const key = t.value.toUpperCase()
    const placement = CONFIG_PLACEMENT[key] ?? OOP_PLACEMENT[key]
    const why = OOP_CONSTRUCTS[key] ?? CONFIG_CONSTRUCTS[key] ?? SFC_CONSTRUCTS[key]
    const notIec = NOT_IEC[key]
    if (!why && !placement && !notIec) return
    // Only when what follows is a name or a keyword - `CLASS Tank`, `EXTENDS Base`,
    // `ABSTRACT FUNCTION_BLOCK`, `CONFIGURATION Cell`. A 2nd-edition program may legitimately
    // have a variable called Class, Method or Task, and every statement about one continues
    // with `:=`, `(`, `.` or `[`, so this never steals a valid program's identifier.
    const next = this.peek(1)
    if (next.kind !== 'ident' && next.kind !== 'kw') return
    if (notIec) throw new StError(notIec, t.pos, t.value.length)
    if (key === 'VAR_STAT') throw new StError(`${key} is not supported: ${placement}`, t.pos, t.value.length)
    if (placement) throw new StError(`${key} cannot stand here: ${placement}`, t.pos, t.value.length)
    throw new StError(`${key} is not supported: ${why}`, t.pos, t.value.length)
  }

  protected intLiteral(): number {
    let neg = false
    if (this.isOp('-')) {
      this.next()
      neg = true
    }
    const t = this.peek()
    if (t.kind !== 'num' || t.real) throw new StError('expected an integer', t.pos)
    this.next()
    return neg ? -t.num : t.num
  }
}
