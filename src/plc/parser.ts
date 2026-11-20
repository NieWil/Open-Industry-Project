// Recursive-descent parser for the ST subset -> AST (with source positions).
// Expression precedence (low -> high): OR < XOR < AND < NOT < compare < add < mul < power < unary < primary.
// Logical/comparison operators keep their ST spelling in the AST; the checker
// decides logical-vs-bitwise by operand type, and the interpreter emits the rest.

import type { Access, AliasDef, Ast, ConfigurationDef, DataType, Decl, Diagnostic, EnumDef, FbDef, FuncDef, InterfaceDef, MethodDef, ProgramDef, ProgramInstanceDef, ResourceDef, ScalarType, SourcePos, StructDef, Stmt, SubrangeDef, TaskDef, Token } from './types'
import { SCALAR_TYPES, StError } from './types'
import { lex } from './lexer'
import { MOTION_LIBRARY_NAMES, MOTION_LIBRARY_SOURCE } from './motionPrelude'
import { NOT_IEC, VAR_SECTIONS } from './parserBase'
import { DeclParser } from './parserDecl'

/** The words a METHOD or a FUNCTION_BLOCK may carry between its keyword and its name. */
const ACCESS_WORDS = new Set(['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL'])
const MEMBER_MODIFIERS = new Set([...ACCESS_WORDS, 'ABSTRACT', 'FINAL', 'OVERRIDE'])

class Parser extends DeclParser {
  parse(): Ast {
    const typeDefs: StructDef[] = []
    const enumDefs: EnumDef[] = []
    const subrangeDefs: SubrangeDef[] = []
    const aliasDefs: AliasDef[] = []
    const fbDefs: FbDef[] = []
    const interfaceDefs: InterfaceDef[] = []
    const funcDefs: FuncDef[] = []
    const globals: Decl[] = []
    const programDefs: ProgramDef[] = []
    let configuration: ConfigurationDef | null = null
    for (;;) {
      if (this.isKw('TYPE')) {
        const block = this.typeBlock()
        typeDefs.push(...block.structs)
        enumDefs.push(...block.enums)
        subrangeDefs.push(...block.subranges)
        aliasDefs.push(...block.aliases)
      }
      else if (this.isKw('VAR_GLOBAL')) globals.push(...this.globalSection())
      else if (this.isKw('FUNCTION_BLOCK')) fbDefs.push(this.fbDef())
      else if (this.startsDeclaration('INTERFACE')) interfaceDefs.push(this.interfaceDef())
      else if (this.isKw('FUNCTION')) funcDefs.push(this.funcDef())
      else if (this.startsDeclaration('PROGRAM')) programDefs.push(this.programDef())
      else if (this.startsDeclaration('CONFIGURATION')) {
        const at = this.peek()
        const def = this.configurationDef(globals)
        if (configuration) throw new StError('a file declares one CONFIGURATION, and this is a second', at.pos, at.value.length)
        configuration = def
      }
      else break
    }
    // The code outside every POU. With no CONFIGURATION it is the implicit program, which a file that
    // declares a PROGRAM cannot also have. Beside a CONFIGURATION (before or after it) it is the
    // controller's own: its variables are tags every POU sees, and an instance with no type runs it.
    if (programDefs.length > 0 && !configuration && this.peek().kind !== 'eof' && !this.configurationAhead()) {
      const t = this.peek()
      const stray = new StError(
        `'${t.value}' is outside every POU: a file that declares a PROGRAM puts its variables and statements inside one, or runs them from a CONFIGURATION with a PROGRAM instance that names no type (PROGRAM Main WITH <task>;)`,
        t.pos,
        Math.max(1, t.value.length),
      )
      if (!this.sink) throw stray
      this.note(stray) // and read the code anyway, so a tolerant parse still knows what it says
    }
    const decls = this.varSections()
    const body = this.pouBody(decls, () => this.startsDeclaration('CONFIGURATION'), false, '')
    const bodyStart = this.declEnd
    if (this.startsDeclaration('CONFIGURATION')) {
      const at = this.peek()
      const def = this.configurationDef(globals)
      if (configuration) throw new StError('a file declares one CONFIGURATION, and this is a second', at.pos, at.value.length)
      configuration = def
    }
    if (this.peek().kind !== 'eof') {
      const stray = new StError(`unexpected '${this.peek().value}'`, this.peek().pos)
      if (!this.sink) throw stray
      this.note(stray)
    }
    enumDefs.push(...this.inlineEnums)
    return { typeDefs, enumDefs, subrangeDefs, aliasDefs, fbDefs, interfaceDefs, funcDefs, globals, programDefs, configuration, decls, body, bodyStart, ladder: this.ladder, bitRefs: this.bitRefs, usesBits: this.usesBits, ...(this.capacities.length ? { capacities: this.capacities, capacitySpans: this.capacitySpans } : {}) }
  }

  /** A POU's statements. Ladder among them may need temporaries, which are the POU's own variables, so they join
   *  `decls` here, where both are in hand. */
  private pouBody(decls: Decl[], atEnd: () => boolean, inFunction: boolean, pou: string): Stmt[] {
    this.declEnd = this.peek().pos.offset
    this.inFunction = inFunction
    const first = this.ladder.length
    this.plain = 0
    const body = this.stmtList(atEnd)
    decls.push(...this.ladderTemps.splice(0))
    this.inFunction = false
    const mine = this.ladder.slice(first)
    for (const s of mine) s.pou = pou
    if (mine.length === 1 && this.plain === 0) mine[0]!.whole = true
    return body
  }

  /** `PROGRAM Main`, `CONFIGURATION Cell`: the word followed by a name. A statement about a variable
   *  that happens to be called `program` continues with `:=`, `(`, `.` or `[`, never a name. */
  private startsDeclaration(word: string): boolean {
    return this.isWord(word) && this.peek(1).kind === 'ident'
  }

  /** Whether a CONFIGURATION is declared anywhere after this point, as a table's generated one is. */
  private configurationAhead(): boolean {
    for (let k = 0; this.peek(k).kind !== 'eof'; k++) {
      if (this.isWord('CONFIGURATION', k) && this.peek(k + 1).kind === 'ident') return true
    }
    return false
  }

  /** `PROGRAM Name <VAR sections> <statements> END_PROGRAM` */
  private programDef(): ProgramDef {
    const pos = this.next().pos
    const nameTok = this.ident('a program name')
    const decls = this.varSections()
    const body = this.pouBody(decls, () => this.isWord('END_PROGRAM'), false, nameTok.value)
    const bodyStart = this.declEnd
    this.eatWord('END_PROGRAM')
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, decls, body, pos, bodyStart }
  }

  /**
   * `CONFIGURATION Name [VAR_GLOBAL...] (RESOURCE Name ON Type [VAR_GLOBAL...] <tasks> <programs>
   * END_RESOURCE)+ END_CONFIGURATION`, or the single-resource form with the tasks and programs directly
   * inside. Globals are appended to the file's own, since a controller has one global namespace.
   */
  private configurationDef(globals: Decl[]): ConfigurationDef {
    const pos = this.next().pos
    const nameTok = this.ident('a configuration name')
    while (this.isKw('VAR_GLOBAL')) globals.push(...this.globalSection())
    const resources: ResourceDef[] = []
    const tasks: TaskDef[] = []
    const programs: ProgramInstanceDef[] = []
    if (this.isWord('RESOURCE')) {
      while (this.isWord('RESOURCE')) {
        this.next()
        const resTok = this.ident('a resource name')
        this.eatWord('ON')
        const onTok = this.ident('the resource type after ON')
        resources.push({ name: resTok.value, on: onTok.value, pos: resTok.pos })
        while (this.isKw('VAR_GLOBAL')) globals.push(...this.globalSection())
        this.resourceBody(tasks, programs, 'END_RESOURCE')
        this.eatWord('END_RESOURCE')
        if (this.isOp(';')) this.next()
      }
    } else {
      this.resourceBody(tasks, programs, 'END_CONFIGURATION')
    }
    this.rejectUnsupported() // VAR_ACCESS, VAR_CONFIG
    this.eatWord('END_CONFIGURATION')
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, resources, tasks, programs, pos }
  }

  /** IEC's order inside a resource: every TASK, then at least one PROGRAM instance. */
  private resourceBody(tasks: TaskDef[], programs: ProgramInstanceDef[], end: string): void {
    while (this.isWord('TASK')) tasks.push(this.taskDef())
    const first = programs.length
    while (this.isWord('PROGRAM')) programs.push(this.programInstance())
    if (this.isWord('TASK')) throw new StError('a TASK is declared before the PROGRAM instances that run in it', this.peek().pos, 4)
    if (programs.length === first && this.isWord(end)) {
      throw new StError(`a ${end === 'END_RESOURCE' ? 'RESOURCE' : 'CONFIGURATION'} runs at least one PROGRAM instance (PROGRAM <name> WITH <task> : <type>;)`, this.peek().pos, end.length)
    }
  }

  /** `TASK Name (SINGLE := ..., INTERVAL := ..., PRIORITY := ...);` - the checker validates the arguments. */
  private taskDef(): TaskDef {
    this.next()
    const nameTok = this.ident('a task name')
    const args: TaskDef['args'] = []
    this.eatOp('(')
    while (!this.isOp(')')) {
      const argTok = this.ident('SINGLE, INTERVAL or PRIORITY')
      this.eatOp(':=')
      args.push({ name: argTok.value.toUpperCase(), value: this.expr(), pos: argTok.pos })
      if (!this.isOp(',')) break
      this.next()
    }
    this.eatOp(')')
    this.eatOp(';')
    return { name: nameTok.value, args, pos: nameTok.pos }
  }

  /** `PROGRAM [RETAIN] Name [WITH Task] : Type;`, or with no `: Type` the instance that runs the code
   *  outside every POU (this engine's extension; an export writes that code as a PROGRAM of its own). */
  private programInstance(): ProgramInstanceDef {
    this.next()
    const retain = this.storageQualifier() === 'RETAIN'
    const nameTok = this.ident('a program instance name')
    let task: string | null = null
    let taskPos: SourcePos | undefined
    if (this.isWord('WITH')) {
      this.next()
      const taskTok = this.ident('a task name after WITH')
      task = taskTok.value
      taskPos = taskTok.pos
    }
    if (this.isOp(';')) {
      this.next()
      return { name: nameTok.value, task, ...(taskPos ? { taskPos } : {}), type: null, ...(retain ? { retain } : {}), pos: nameTok.pos }
    }
    this.eatOp(':')
    const typeTok = this.ident('the PROGRAM type')
    if (this.isOp('(')) {
      throw new StError(
        "wiring a PROGRAM instance's inputs and outputs in the CONFIGURATION is not implemented; the scene binds them by name, as Instance.Variable",
        this.peek().pos,
      )
    }
    this.eatOp(';')
    return { name: nameTok.value, task, ...(taskPos ? { taskPos } : {}), type: typeTok.value, typePos: typeTok.pos, ...(retain ? { retain } : {}), pos: nameTok.pos }
  }

  /**
   * `FUNCTION_BLOCK [ABSTRACT | FINAL] [PUBLIC | INTERNAL] Name [EXTENDS Base] [IMPLEMENTS I1, I2]`, its VAR sections,
   * its METHODs, and its body. IEC's grammar puts the methods between the variables and the body, which
   * is what STruC++ reads; they are taken after the body too, since a file pieced together from separately saved
   * objects often has them there.
   */
  private fbDef(): FbDef {
    const pos = this.eatKw('FUNCTION_BLOCK').pos
    const head = this.modifiers()
    const nameTok = this.peek()
    if (nameTok.kind !== 'ident') throw new StError('expected a function block name', nameTok.pos)
    this.next()
    let ext: FbDef['extends']
    let impl: FbDef['implements']
    for (;;) {
      if (this.isWord('EXTENDS') && this.peek(1).kind === 'ident') {
        if (ext) throw new StError('a function block EXTENDS one block (a block may IMPLEMENT several interfaces)', this.peek().pos, 7)
        this.next()
        const base = this.typeName()
        ext = { name: base.value, pos: base.pos }
        if (this.isOp(',')) throw new StError('a function block EXTENDS one block (a block may IMPLEMENT several interfaces)', this.peek().pos)
      } else if (this.isWord('IMPLEMENTS') && this.peek(1).kind === 'ident') {
        this.next()
        impl = [...(impl ?? []), ...this.nameList('an interface name')]
      } else break
    }
    for (const m of head.words) if (m.word !== 'ABSTRACT' && m.word !== 'FINAL' && m.word !== 'PUBLIC' && m.word !== 'INTERNAL') throw new StError(`a FUNCTION_BLOCK cannot be ${m.word}`, m.pos, m.word.length)
    const decls = this.varSections()
    const bodyStart = this.peek().pos.offset
    const methods: MethodDef[] = []
    const members = (): void => {
      while (this.startsMember()) methods.push(this.methodDef(nameTok.value, false))
    }
    members()
    const body = this.pouBody(decls, () => this.isKw('END_FUNCTION_BLOCK') || this.startsMember(), false, nameTok.value)
    members()
    if (this.startsMember() === false && !this.isKw('END_FUNCTION_BLOCK') && this.peek().kind !== 'eof') {
      throw new StError('the body of a function block is one run of statements: its METHODs come before it or after it, not inside it', this.peek().pos, Math.max(1, this.peek().value.length))
    }
    const end = this.eatKw('END_FUNCTION_BLOCK').pos.offset
    if (this.isOp(';')) this.next()
    return {
      name: nameTok.value,
      decls,
      body,
      pos,
      bodyStart,
      end,
      ...(ext ? { extends: ext } : {}),
      ...(impl ? { implements: impl } : {}),
      ...(methods.length ? { methods } : {}),
      ...(head.has('ABSTRACT') ? { abstract: true } : {}),
      ...(head.has('FINAL') ? { final: true } : {}),
    }
  }

  /** `METHOD` opening a member, rather than a statement about a variable of that name (which goes on with `:=`, `(`,
   *  `.` or `[`). A `PROPERTY` opening one is refused by name: it is not IEC 61131-3. */
  private startsMember(): boolean {
    const named = this.peek(1).kind === 'ident' || this.peek(1).kind === 'kw'
    if (this.isWord('PROPERTY') && named) throw new StError(NOT_IEC.PROPERTY!, this.peek().pos, 'PROPERTY'.length)
    return this.isWord('METHOD') && named
  }

  /** The modifier words before a member's or a block's name (`PUBLIC`, `ABSTRACT`, `OVERRIDE`...), any order. Not
   *  reserved: a word is a modifier only when a name still follows it. */
  private modifiers(): { words: { word: string; pos: SourcePos }[]; has(w: string): boolean; access?: Access } {
    const words: { word: string; pos: SourcePos }[] = []
    while (this.peek().kind === 'ident' && MEMBER_MODIFIERS.has(this.peek().value.toUpperCase()) && this.peek(1).kind === 'ident') {
      const t = this.next()
      const word = t.value.toUpperCase()
      if (words.some((w) => w.word === word)) throw new StError(`${word} is written twice`, t.pos, word.length)
      words.push({ word, pos: t.pos })
    }
    const access = words.filter((w) => ACCESS_WORDS.has(w.word))
    if (access.length > 1) throw new StError(`one access word only: ${access.map((w) => w.word).join(' and ')} contradict`, access[1]!.pos, access[1]!.word.length)
    const has = (w: string): boolean => words.some((x) => x.word === w)
    if (has('ABSTRACT') && has('FINAL')) throw new StError('ABSTRACT and FINAL contradict: one must be derived from (or overridden), the other cannot be', words.find((w) => w.word === 'FINAL')!.pos, 5)
    return { words, has, ...(access[0] ? { access: access[0].word as Access } : {}) }
  }

  /** `a, b, c`: names, as a declaration lists them */
  private nameList(what: string): { name: string; pos: SourcePos }[] {
    const out: { name: string; pos: SourcePos }[] = []
    for (;;) {
      if (this.peek().kind !== 'ident') this.ident(what) // throws, saying what was wanted
      const t = this.typeName()
      out.push({ name: t.value, pos: t.pos })
      if (!this.isOp(',')) return out
      this.next()
    }
  }

  /**
   * `METHOD [modifiers] Name [: Type] <VAR sections> <statements> END_METHOD`. In an INTERFACE (`signature`), and when
   * ABSTRACT, it has no statements. `fb` is the block's name, for the ladder view's POU name.
   */
  private methodDef(fb: string, signature: boolean): MethodDef {
    const pos = this.next().pos
    const mods = this.modifiers()
    const nameTok = this.ident('a method name')
    let ret: { type: DataType; maxLen?: number } | null = null
    if (this.isOp(':')) {
      this.next()
      ret = this.resultType()
    }
    if (this.isOp(';')) this.next()
    const decls = this.varSections()
    this.rejectUnsupported() // VAR_STAT, VAR_INST
    const bodyless = signature || mods.has('ABSTRACT')
    const bodyStart = this.peek().pos.offset
    const body = this.pouBody(decls, () => this.isWord('END_METHOD'), true, `${fb}.${nameTok.value}`)
    if (bodyless && body.length > 0) {
      throw new StError(signature ? `a method of an INTERFACE is a signature: '${nameTok.value}' has no statements` : `ABSTRACT method '${nameTok.value}' has no statements: a derived block implements it`, body[0]!.pos)
    }
    const closing = this.eatWord('END_METHOD')
    if (this.isOp(';')) this.next()
    // PUBLIC and ABSTRACT only say what every method of an interface is, so either is read, and says nothing
    const wrong = signature ? mods.words.find((w) => w.word !== 'PUBLIC' && w.word !== 'ABSTRACT') : undefined
    if (wrong) throw new StError(`a method of an INTERFACE takes no ${wrong.word}: every one is public and abstract`, wrong.pos, wrong.word.length)
    return {
      name: nameTok.value,
      ret: ret?.type ?? null,
      ...(ret?.maxLen !== undefined ? { retMaxLen: ret.maxLen } : {}),
      decls,
      body,
      pos: nameTok.pos,
      bodyStart,
      bodyEnd: closing.pos.offset,
      start: pos.offset,
      end: closing.pos.offset + closing.value.length,
      ...(mods.access ? { access: mods.access } : {}),
      ...(mods.has('ABSTRACT') ? { abstract: true } : {}),
      ...(mods.has('FINAL') ? { final: true } : {}),
      ...(mods.has('OVERRIDE') ? { override: true } : {}),
      ...(bodyless ? { bodyless: true } : {}),
    }
  }

  /** `INTERFACE Name [EXTENDS I1, I2] <METHOD signatures> END_INTERFACE` */
  private interfaceDef(): InterfaceDef {
    this.next()
    const nameTok = this.ident('an interface name')
    const ext: InterfaceDef['extends'] = []
    if (this.isWord('EXTENDS') && this.peek(1).kind === 'ident') {
      this.next()
      // a base in the `__SYSTEM` namespace (`__SYSTEM.<name>`) is a runtime's own root interface, which a program never
      // declares and which asks nothing of an implementation that this engine's casts need: read and dropped
      for (;;) {
        if (this.peek().kind !== 'ident') this.ident('an interface name') // throws, saying what was wanted
        if (this.peek().value.toUpperCase() === '__SYSTEM' && this.peek(1).value === '.' && this.peek(2).kind === 'ident') {
          this.next()
          this.next()
          this.next()
        } else {
          const t = this.typeName()
          ext.push({ name: t.value, pos: t.pos })
        }
        if (!this.isOp(',')) break
        this.next()
      }
    }
    const methods: MethodDef[] = []
    if (this.peek().kind === 'kw' && VAR_SECTIONS.has(this.peek().value)) throw new StError('an INTERFACE declares no variables: only METHOD signatures', this.peek().pos, this.peek().value.length)
    while (this.startsMember()) methods.push(this.methodDef(nameTok.value, true))
    if (!this.isWord('END_INTERFACE')) throw new StError('an INTERFACE holds METHOD signatures, then END_INTERFACE', this.peek().pos, Math.max(1, this.peek().value.length))
    this.next()
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, extends: ext, methods, pos: nameTok.pos }
  }

  private funcDef(): FuncDef {
    const pos = this.eatKw('FUNCTION').pos
    const nameTok = this.peek()
    if (nameTok.kind !== 'ident') throw new StError('expected a function name', nameTok.pos)
    this.next()
    this.eatOp(':')
    // a scalar or a named type (struct, enumeration, subrange) the checker resolves. An ARRAY
    // parses too, so the checker can refuse it by name instead of as a syntax error
    const retTok = this.peek()
    let ret: DataType
    let retMaxLen: number | undefined
    if (retTok.kind === 'kw' && retTok.value === 'ARRAY') {
      ret = this.arrayType()
    } else if (retTok.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(retTok.value)) {
      this.next()
      ret = retTok.value as ScalarType
      if (retTok.value === 'STRING') retMaxLen = this.stringLen()
    } else if (retTok.kind === 'ident') {
      ret = { fb: this.typeName().value }
    } else {
      throw new StError('expected a return type', retTok.pos)
    }
    const decls = this.varSections()
    const body = this.pouBody(decls, () => this.isKw('END_FUNCTION'), true, nameTok.value)
    const bodyStart = this.declEnd
    this.eatKw('END_FUNCTION')
    if (this.isOp(';')) this.next()
    return { name: nameTok.value, ret, retMaxLen, decls, body, pos, bodyStart }
  }
}

/** Parse to an AST. Pass `sink` to collect syntax errors and keep going (see Parser.sink);
 *  without it the first error throws, which is what the execution path wants. */
export function parse(toks: Token[], sink: Diagnostic[] | null = null): Ast {
  const ast = new Parser(toks, sink).parse()
  withMotionLibrary(ast, toks)
  return ast
}

/** The PLCopen motion library's names, upper case, for the quick test of whether a program uses it. */
const MOTION_NAMES: ReadonlySet<string> = new Set(MOTION_LIBRARY_NAMES)

/**
 * Merge the PLCopen motion library (plc/motionPrelude.ts) into a program that names any of it, without defining that
 * name itself: every definition the program does not have, marked `library`. The library is parsed again for every
 * program on purpose: the checker rewrites the nodes it checks, so a shared AST would carry one program's checking
 * into the next. A program that defines its own MC_Power keeps it (a user block shadows a library one).
 */
function withMotionLibrary(ast: Ast, toks: Token[]): void {
  if (!toks.some((t) => t.kind === 'ident' && t.value.length >= 6 && MOTION_NAMES.has(t.value.toUpperCase()))) return
  const own = new Set([...ast.fbDefs, ...ast.funcDefs, ...ast.typeDefs, ...ast.enumDefs].map((d) => d.name.toUpperCase()))
  const lib = new Parser(lex(MOTION_LIBRARY_SOURCE), null).parse()
  const take = <T extends { name: string; library?: true }>(from: T[], into: T[]): void => {
    for (const d of from) if (!own.has(d.name.toUpperCase())) into.push({ ...d, library: true })
  }
  take(lib.enumDefs, ast.enumDefs)
  take(lib.typeDefs, ast.typeDefs)
  take(lib.funcDefs, ast.funcDefs)
  take(lib.fbDefs, ast.fbDefs)
}

export type { SourcePos }
