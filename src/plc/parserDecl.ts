// Declarations for the ST parser: VAR sections, data types (arrays, strings, references), initial values and
// TYPE blocks.

import type { AliasDef, ArrayDim, ArrayType, DataType, Decl, DeclType, EnumDef, EnumMember, Expr, Initializer, ScalarType, StructDef, StructField, StructInit, SubrangeDef, Token, VarSection } from './types'
import { DEFAULT_STRING_LEN, isArray, SCALAR_TYPES, StError } from './types'
import { VAR_SECTIONS } from './parserBase'
import { LadderParser } from './parserLadder'

const TYPE_KW = new Set<string>(SCALAR_TYPES) // FB names arrive as idents; the checker resolves them

/** What a VAR section's qualifiers ask of its values across a restart: nothing, RETAIN, or PERSISTENT (Decl.persistent). */
type Retention = boolean | 'persistent'

/** `%I*`, `%QX*`, `%M*`: an address a vendor's I/O configuration completes (Decl.linked). */
const INCOMPLETE_ADDRESS = /^%[IQM][XBWDL]?\*$/i

/** `REFERENCE TO`, a reference spelling that is not IEC's. */
export const REFERENCE_TO_NOT_IEC = 'REFERENCE TO is not IEC 61131-3; declare REF_TO and dereference with ^'

/** `TYPE B EXTENDS A : STRUCT`: inheritance between data types, which IEC 61131-3 does not have. */
export const STRUCT_EXTENDS_NOT_IEC = "a STRUCT cannot EXTEND another: IEC 61131-3 derives only function blocks and interfaces. Declare the base's fields in the struct, or hold the base as one field"

/** IEC's retention qualifiers, accepted between a `VAR...` keyword and the first
 *  declaration. Not reserved words here (a variable may legitimately be called `retain`),
 *  so they arrive as identifiers and are recognised by position - see storageQualifiers(). */
const STORAGE_QUALIFIERS = new Set<string>(['RETAIN', 'NON_RETAIN', 'PERSISTENT'])

export class DeclParser extends LadderParser {
  /** a VAR_GLOBAL ... END_VAR block: variables every POU in the program can see */
  protected globalSection(): Decl[] {
    this.eatKw('VAR_GLOBAL')
    let constant = false
    if (this.isKw('CONSTANT')) {
      this.next()
      constant = true
    }
    const retain = this.sectionQualifiers().retain
    const decls: Decl[] = []
    const block = this.blocks++
    while (!this.isKw('END_VAR')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_VAR', this.peek().pos)
      decls.push(...this.decl('VAR_GLOBAL', constant, retain, block))
    }
    this.eatKw('END_VAR')
    if (this.isOp(';')) this.next()
    return decls
  }

  /** a TYPE ... END_TYPE block holding struct, enumeration, subrange and named-type definitions */
  protected typeBlock(): { structs: StructDef[]; enums: EnumDef[]; subranges: SubrangeDef[]; aliases: AliasDef[] } {
    this.eatKw('TYPE')
    const structs: StructDef[] = []
    const enums: EnumDef[] = []
    const subranges: SubrangeDef[] = []
    const aliases: AliasDef[] = []
    while (!this.isKw('END_TYPE')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_TYPE', this.peek().pos)
      const nameTok = this.peek()
      if (nameTok.kind !== 'ident') throw new StError('expected a type name', nameTok.pos)
      this.next()
      // `Name EXTENDS Base : STRUCT`: IEC 61131-3 derives function blocks and interfaces, never a type
      if (this.isWord('EXTENDS') && this.peek(1).kind === 'ident') throw new StError(STRUCT_EXTENDS_NOT_IEC, this.peek().pos, 'EXTENDS'.length)
      this.eatOp(':')
      // `Name : STRUCT ...` is a record; `Name : (A, B, C)` is an enumeration; `Name : INT (0..100)`
      // is a subrange; anything else gives a type a name of its own: `Name : ARRAY [1..3] OF INT`,
      // `Name : INT`, `Name : STRING[20]`, `Name : Other`
      const next = this.peek()
      const parenAfter = this.peek(1).kind === 'op' && this.peek(1).value === '('
      if (this.isOp('(')) enums.push(this.enumDef(nameTok))
      else if (this.isKw('STRUCT')) structs.push(this.structDef(nameTok))
      else if (next.kind === 'kw' && TYPE_KW.has(next.value) && next.value !== 'STRING' && parenAfter) subranges.push(this.subrangeDef(nameTok))
      else aliases.push(this.aliasDef(nameTok))
    }
    this.eatKw('END_TYPE')
    if (this.isOp(';')) this.next()
    return { structs, enums, subranges, aliases }
  }

  /** `Name : <type>;`, an array, a scalar, a STRING with its capacity, or another named type, given
   *  a name of its own. The checker resolves what it names. */
  private aliasDef(nameTok: Token): AliasDef {
    const t = this.dataType()
    this.typeEnd()
    return { name: nameTok.value, type: t.type, maxLen: t.maxLen, pos: nameTok.pos }
  }

  /** `INT (0..100)` - a base type narrowed to an inclusive range. */
  private subrangeDef(nameTok: Token): SubrangeDef {
    const baseTok = this.next()
    this.eatOp('(')
    const lo = this.intLiteral()
    this.eatOp('..')
    const hiPos = this.peek().pos
    const hi = this.intLiteral()
    if (hi < lo) throw new StError('a subrange must be ascending (lo..hi)', hiPos)
    this.eatOp(')')
    this.typeEnd()
    return { name: nameTok.value, base: baseTok.value as ScalarType, lo, hi, pos: nameTok.pos }
  }

  /** `(Idle, Run := 10, Fault)` - members number from 0, or from the last explicit value. */
  private enumDef(nameTok: Token): EnumDef {
    const members = this.enumMembers(nameTok)
    // `(Idle, Run) UINT`: a base type for the values, an input form read and held as INT (EnumDef.base)
    let base: Token | undefined
    if (this.peek().kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(this.peek().value)) base = this.next()
    this.typeEnd()
    return { name: nameTok.value, members, pos: nameTok.pos, ...(base ? { base: base.value as ScalarType, basePos: base.pos } : {}) }
  }

  /** `(Idle, Run := 10, Stop)`: members number from 0, or from the last explicit value. */
  private enumMembers(at: Token): EnumMember[] {
    this.eatOp('(')
    const members: EnumMember[] = []
    let next = 0
    while (!this.isOp(')')) {
      const m = this.peek()
      if (m.kind !== 'ident') throw new StError('expected an enumeration member name', m.pos)
      this.next()
      if (this.isOp(':=')) {
        this.next()
        next = this.intLiteral()
      }
      members.push({ name: m.value, value: next, pos: m.pos })
      next++
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(')')
    if (members.length === 0) throw new StError('an enumeration needs at least one member', at.pos)
    return members
  }

  private structDef(nameTok: Token): StructDef {
    this.eatKw('STRUCT')
    const fields: StructField[] = []
    while (!this.isKw('END_STRUCT')) {
      if (this.peek().kind === 'eof') throw new StError('expected END_STRUCT', this.peek().pos)
      const fn = this.peek()
      if (fn.kind !== 'ident') throw new StError('expected a field name', fn.pos)
      this.next()
      // `bSensor AT %I* : BOOL;`: a field linked in a vendor's I/O configuration (Decl.linked). A full address
      // names one I/O point, and a struct is a type with any number of values, so that one is refused
      if (this.peek().kind === 'ident' && this.peek().value.toUpperCase() === 'AT' && this.peek(1).kind === 'addr') {
        const addr = this.peek(1)
        if (!INCOMPLETE_ADDRESS.test(addr.value)) throw new StError(`a struct field cannot be located at ${addr.raw ?? addr.value}: an address is one I/O point, and a struct has a value for every variable of its type (an incomplete address, AT %I*, is taken)`, addr.pos, (addr.raw ?? addr.value).length)
        this.next()
        this.next()
      }
      this.eatOp(':')
      const ft = this.dataType()
      // `Speed : REAL := 1.5;`: what the field starts at in every value of the type (checker.ts `impliedInit`)
      let init: Initializer | undefined
      if (this.isOp(':=')) {
        this.next()
        init = this.initValue()
      }
      this.eatOp(';')
      fields.push({ name: fn.value, type: ft.type, maxLen: ft.maxLen, pos: fn.pos, ...(init ? { init } : {}) })
    }
    this.eatKw('END_STRUCT')
    this.typeEnd()
    return { name: nameTok.value, fields, pos: nameTok.pos }
  }

  /**
   * The `;` that ends one declaration of a TYPE block. IEC requires it (MATIEC: "';' missing at end of data type
   * declaration"), but code written elsewhere often ends a data type `... END_STRUCT` / `)` straight before END_TYPE,
   * so before END_TYPE it may be left out (our rule for that input form); the exporters write it back (exportText.ts
   * `canonicalSyntax`). Between two declarations it stays required: nothing else would say where one ends.
   */
  private typeEnd(): void {
    if (this.isKw('END_TYPE') && !this.isOp(';')) return
    this.eatOp(';')
  }

  /** zero or more VAR / VAR_INPUT / VAR_OUTPUT / VAR_TEMP sections, each optionally CONSTANT */
  protected varSections(): Decl[] {
    const decls: Decl[] = []
    while (this.peek().kind === 'kw' && VAR_SECTIONS.has(this.peek().value)) {
      const section = this.next().value as VarSection
      const { constant, retain } = this.sectionQualifiers()
      const block = this.blocks++
      while (!this.isKw('END_VAR')) {
        if (this.peek().kind === 'eof') throw new StError('expected END_VAR', this.peek().pos)
        if (!this.sink) {
          decls.push(...this.decl(section, constant, retain, block))
          continue
        }
        const before = this.p
        try {
          decls.push(...this.decl(section, constant, retain, block))
        } catch (e) {
          this.note(e)
          if (this.p === before) this.next()
          this.recover(() => this.isKw('END_VAR'))
        }
      }
      this.eatKw('END_VAR')
      if (this.isOp(';')) this.next()
    }
    return decls
  }

  /** The `: Type` after a METHOD's name, as a FUNCTION's result is written. */
  protected resultType(): { type: DataType; maxLen?: number } {
    const t = this.peek()
    if (t.kind === 'kw' && t.value === 'ARRAY') return { type: this.arrayType() }
    if (t.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(t.value)) {
      this.next()
      return { type: t.value as ScalarType, ...(t.value === 'STRING' ? { maxLen: this.stringLen() } : {}) }
    }
    if (t.kind === 'ident' && t.value.toUpperCase() === 'REFERENCE') throw new StError(REFERENCE_TO_NOT_IEC, t.pos, t.value.length)
    if (t.kind === 'ident' && t.value.toUpperCase() === 'REF_TO') throw new StError('a METHOD returning a REF_TO is not implemented; return the value', t.pos, t.value.length)
    if (t.kind === 'ident') return { type: { fb: this.typeName().value } }
    throw new StError('expected a type', t.pos)
  }

  /**
   * One declaration line, which may name several variables of one type: `a, b, c : INT := 0;`.
   *
   * This is IEC's own `var1_list ':' simple_spec_init`, not a vendor extension: ordinary ST that
   * 8 of the 36 real files the import oracle reads use, including most of the standard's own
   * Annex F examples.
   *
   * Returns one `Decl` per name, so the checker, interpreter, emitter and both exporters see a
   * flat list. The AST shape is the same; only the number of entries one line can produce differs.
   * Each carries its own name token's position, so a diagnostic
   * points at the name it is about rather than at the head of the line. The type is shared (it is
   * never mutated), while an initialiser is cloned per name, because the checker annotates `Expr`
   * nodes in place - `arrayInitList` clones for exactly the same reason.
   */
  private decl(section: VarSection, constant = false, retain: Retention = false, block?: number): Decl[] {
    const nameToks: Token[] = []
    for (;;) {
      const tok = this.peek()
      if (tok.kind !== 'ident') throw new StError('expected variable name', tok.pos)
      this.next()
      nameToks.push(tok)
      if (!this.isOp(',')) break
      this.next()
    }
    // `Eye AT %IX100.0 : BOOL` - a LOCATED variable. `AT` is IEC's, but not reserved here, so it is
    // recognised only where a declaration can take an address: after the name, before the colon
    let location: Token | undefined
    let linked: string | undefined
    const at = this.peek()
    if (at.kind === 'ident' && at.value.toUpperCase() === 'AT' && this.peek(1).kind === 'addr' && INCOMPLETE_ADDRESS.test(this.peek(1).value)) {
      // `AT %I*`: linked in a vendor's I/O configuration, here by the scene's wiring (Decl.linked)
      this.next()
      linked = this.next().value
    } else if (at.kind === 'ident' && at.value.toUpperCase() === 'AT' && this.peek(1).kind === 'addr') {
      this.next()
      location = this.next()
      if (nameToks.length > 1) {
        throw new StError(`one address locates one variable: declare ${nameToks.map((t) => `'${t.value}'`).join(', ')} on lines of their own`, location.pos, location.raw?.length ?? location.value.length)
      }
    }
    this.eatOp(':')
    const typeTok = this.peek()
    let type: DeclType
    let maxLen: number | undefined
    if (typeTok.kind === 'kw' && typeTok.value === 'ARRAY') {
      type = this.arrayType()
    } else if (typeTok.kind === 'kw' && TYPE_KW.has(typeTok.value)) {
      this.next()
      type = typeTok.value as DeclType
      if (type === 'STRING') maxLen = this.stringLen()
    } else if (this.startsPointerType()) {
      const r = this.referenceType()
      type = r.type
      maxLen = r.maxLen
    } else if (typeTok.kind === 'op' && typeTok.value === '(') {
      // `m : (Idle, Run, Stop)`: an enumeration of the variable's own (IEC's enumerated_spec_init), which is an
      // enumeration type like any other, named for how it is spelled and marked inline (EnumDef.inline)
      const members = this.enumMembers(typeTok)
      // a value is spelled only where it is not the one before it plus one, as an author writes it
      const name = `(${members.map((m, i) => (m.value === (i === 0 ? 0 : members[i - 1]!.value + 1) ? m.name : `${m.name} := ${m.value}`)).join(', ')})`
      this.inlineEnums.push({ name, members, pos: typeTok.pos, inline: true })
      type = { fb: name }
    } else if (typeTok.kind === 'ident') {
      // a named type: a struct, an enumeration, a subrange, a user or standard function block, or an interface. The
      // parser cannot tell which, so the checker resolves the name
      type = { fb: this.typeName().value }
    } else {
      throw new StError('expected a type', typeTok.pos)
    }
    let init: Expr | null = null
    let arrayInit: Initializer[] | undefined
    let structInit: StructInit | undefined
    if (section === 'VAR_EXTERNAL' && this.isOp(':=')) {
      throw new StError('a VAR_EXTERNAL has no initial value of its own; the VAR_GLOBAL it names does', this.peek().pos, 2)
    }
    if (this.isOp(':=')) {
      this.next()
      // a `[...]` list gives an array its elements, whether its type is spelled out here or named;
      // a `(field := ...)` list gives a struct its fields
      if (isArray(type) || this.isOp('[')) arrayInit = this.arrayInitList()
      else if (this.startsStructInit()) structInit = this.structInit()
      else init = this.expr()
    }
    this.eatOp(';')
    return nameToks.map((tok, i) => ({
      name: tok.value,
      type,
      init: init === null || i === 0 ? init : structuredClone(init),
      arrayInit: arrayInit === undefined || i === 0 ? arrayInit : structuredClone(arrayInit),
      ...(structInit === undefined ? {} : { structInit: i === 0 ? structInit : structuredClone(structInit) }),
      constant,
      retain: retain !== false,
      ...(retain === 'persistent' ? { persistent: true as const } : {}),
      maxLen,
      ...(location ? { location: location.value, locationPos: location.pos, locationLength: location.raw?.length ?? location.value.length } : {}),
      ...(linked ? { linked } : {}),
      ...(block !== undefined ? { block } : {}),
      section,
      pos: tok.pos,
    }))
  }

  /** An array initialiser list: `[1, 2, 3]`, with IEC's `n(value)` repetition (`[3(0), 1]`).
   *  Flattened row-major, which is how the interpreter and the emitter both lay arrays out. */
  private arrayInitList(): Initializer[] {
    this.eatOp('[')
    const out: Initializer[] = []
    while (!this.isOp(']')) {
      // `3(0)` repeats the value three times; the count must be a literal, not an expression
      if (this.peek().kind === 'num' && this.peek(1).kind === 'op' && this.peek(1).value === '(') {
        const countTok = this.peek()
        if (countTok.real || countTok.num < 0) throw new StError('a repetition count must be a non-negative integer', countTok.pos)
        this.next()
        this.next()
        const value = this.initValue()
        this.eatOp(')')
        for (let k = 0; k < countTok.num; k++) out.push(structuredClone(value))
      } else {
        out.push(this.initValue())
      }
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(']')
    return out
  }

  /** One initial value inside a structured one: a `[...]` list, a `(field := ...)` list, or an expression. */
  private initValue(): Initializer {
    if (this.isOp('[')) {
      const pos = this.peek().pos
      return { node: 'arrayInit', items: this.arrayInitList(), pos }
    }
    if (this.startsStructInit()) return this.structInit()
    return this.expr()
  }

  /** `(name := ...` begins a struct's initializer; a parenthesised expression never has `:=` there. */
  private startsStructInit(): boolean {
    return this.isOp('(') && this.peek(1).kind === 'ident' && this.peek(2).kind === 'op' && this.peek(2).value === ':='
  }

  /** `(field := value, ...)`: a struct's initial value, naming the fields it sets; the rest stay zero. */
  private structInit(): StructInit {
    const pos = this.eatOp('(').pos
    const fields: StructInit['fields'] = []
    while (!this.isOp(')')) {
      const nameTok = this.peek()
      if (nameTok.kind !== 'ident') throw new StError('expected a field name', nameTok.pos)
      this.next()
      this.eatOp(':=')
      fields.push({ name: nameTok.value, value: this.initValue(), pos: nameTok.pos })
      if (this.isOp(',')) this.next()
      else break
    }
    this.eatOp(')')
    return { node: 'structInit', fields, pos }
  }

  protected arrayType(): ArrayType {
    this.eatKw('ARRAY')
    this.eatOp('[')
    const dims: ArrayDim[] = []
    for (;;) {
      const lo = this.arrayBound()
      this.eatOp('..')
      const hiPos = this.peek().pos
      const hi = this.arrayBound()
      // literal bounds are checked here; a bound written as a constant is the checker's to fold
      if (lo.expr === undefined && hi.expr === undefined && hi.value < lo.value) throw new StError('array bounds must be ascending (lo..hi)', hiPos)
      dims.push({ lo: lo.value, hi: hi.value, ...(lo.expr ? { loExpr: lo.expr } : {}), ...(hi.expr ? { hiExpr: hi.expr } : {}) })
      if (this.isOp(',')) {
        this.next()
        continue
      }
      break
    }
    this.eatOp(']')
    this.eatKw('OF')
    const elem = this.elemType()
    return { array: true, dims, elem: elem.type, elemMaxLen: elem.maxLen }
  }

  /** One array bound: an integer literal, the common case, or a constant expression over named
   *  CONSTANTs (`ZONES - 1`), kept whole for the checker to fold once the constants are known. */
  private arrayBound(): { value: number; expr?: Expr } {
    const t = this.peek()
    const lit = t.kind === 'num' ? 0 : t.kind === 'op' && t.value === '-' && this.peek(1).kind === 'num' ? 1 : -1
    const after = lit >= 0 ? this.peek(lit + 1) : undefined
    if (after && after.kind === 'op' && (after.value === '..' || after.value === ',' || after.value === ']')) return { value: this.intLiteral() }
    return { value: 0, expr: this.addExpr() }
  }

  /** The optional capacity on a STRING type, consumed after its keyword. IEC spells it
   *  `STRING[80]`; `STRING(80)` is read too (imported code uses both), and an export writes IEC's. */
  protected stringLen(): number {
    const open = this.isOp('[') ? '[' : this.isOp('(') ? '(' : null
    if (!open) return DEFAULT_STRING_LEN
    const pos = this.peek().pos
    this.next()
    const close = open === '[' ? ']' : ')'
    // `STRING(MAX_LEN)`: a capacity written as a constant expression, which IEC does not have (it writes an integer)
    // and which only the checker can fold (it knows the constants), so it stands here as a placeholder,
    // -(1 + its index in Ast.capacities). Where it is written is kept too: an export writes the folded integer there
    if (!(this.peek().kind === 'num' && this.peek(1).value === close) && !(this.isOp('-') && this.peek(1).kind === 'num')) {
      this.capacities.push(this.expr())
      const end = this.peek().pos.offset + 1
      this.eatOp(close)
      this.capacitySpans.push({ start: pos.offset, end })
      return -this.capacities.length
    }
    const n = this.intLiteral()
    if (n <= 0) throw new StError('a STRING capacity must be a positive integer', pos)
    this.eatOp(close)
    return n
  }

  /** an array element type: a scalar, or a named type - struct, enumeration or function block,
   *  which the checker resolves (use multiple dims for N-D, not nested arrays) */
  private elemType(): { type: DataType; maxLen?: number } {
    const t = this.peek()
    if (this.startsPointerType()) return this.referenceType()
    if (t.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(t.value)) {
      this.next()
      return { type: t.value as ScalarType, maxLen: t.value === 'STRING' ? this.stringLen() : undefined }
    }
    if (t.kind === 'ident') return { type: { struct: this.typeName().value } }
    throw new StError('array element type must be a scalar, a struct, an enumeration or a function block', t.pos)
  }

  /** `REF_TO` (or `REFERENCE TO` / `POINTER TO`, refused by name) opening a type */
  private startsPointerType(): boolean {
    const t = this.peek()
    if (t.kind !== 'ident') return false
    const w = t.value.toUpperCase()
    if (w === 'REF_TO') return this.peek(1).kind === 'ident' || this.peek(1).kind === 'kw'
    return (w === 'REFERENCE' || w === 'POINTER') && this.peek(1).kind === 'kw' && this.peek(1).value === 'TO'
  }

  /** `REF_TO <type>`: a scalar (a STRING with its capacity) or a named type. The checker says where one may stand. */
  private referenceType(): { type: DataType; maxLen?: number } {
    const t = this.next()
    const w = t.value.toUpperCase()
    if (w === 'REFERENCE') throw new StError(REFERENCE_TO_NOT_IEC, t.pos, t.value.length)
    if (w === 'POINTER') throw new StError('POINTER TO is not IEC 61131-3 and is not implemented; declare REF_TO, take a reference with REF() and dereference it with ^', t.pos, t.value.length)
    const target = this.peek()
    if (target.kind === 'kw' && target.value === 'ARRAY') return { type: { ref: this.arrayType() } }
    if (target.kind === 'kw' && TYPE_KW.has(target.value)) {
      this.next()
      if (target.value === 'STRING') {
        const maxLen = this.stringLen()
        return { type: { ref: 'STRING', maxLen }, maxLen }
      }
      return { type: { ref: target.value as ScalarType } }
    }
    if (this.startsPointerType()) throw new StError('a REF_TO a reference is not implemented: refer to the place itself', target.pos, target.value.length)
    if (target.kind === 'ident') return { type: { ref: { fb: this.typeName().value } } }
    throw new StError('expected the type a REF_TO refers to', target.pos)
  }

  /** a struct-field type: a scalar, an array, or a named type (struct, enumeration or function
   *  block) that the checker resolves */
  private dataType(): { type: DataType; maxLen?: number } {
    const t = this.peek()
    if (t.kind === 'kw' && t.value === 'ARRAY') return { type: this.arrayType() }
    if (this.startsPointerType()) return this.referenceType()
    if (t.kind === 'kw' && (SCALAR_TYPES as readonly string[]).includes(t.value)) {
      this.next()
      return { type: t.value as ScalarType, maxLen: t.value === 'STRING' ? this.stringLen() : undefined }
    }
    if (t.kind === 'ident') return { type: { struct: this.typeName().value } }
    throw new StError('expected a type', t.pos)
  }

  /**
   * `VAR RETAIN` / `VAR NON_RETAIN`: consumed, and reported back so the declaration can
   * carry the flag.
   *
   * accepted and ignored, rather than refused. RETAIN asks that a variable survive a warm
   * restart, and this simulator has no restart to survive - every run starts from the
   * declared initial value, which is exactly what a retentive variable is given on a cold
   * start. Honouring it and ignoring it are therefore the same behaviour here, while
   * refusing it made ordinary plant code, where RETAIN is everywhere, fail to load at all.
   *
   * The flag is still carried on the Decl, because a REAL target does have a restart and
   * dropping the word on export would change what the program means there.
   */
  protected storageQualifier(): 'RETAIN' | 'NON_RETAIN' | 'PERSISTENT' | null {
    const t = this.peek()
    if (t.kind !== 'ident') return null
    const key = t.value.toUpperCase()
    // A qualifier only ever precedes a declaration, so a variable of the same name (`retain :
    // BOOL;`) is untouched - its own declaration continues with `:` or `,`.
    if (!STORAGE_QUALIFIERS.has(key) || (this.peek(1).kind !== 'ident' && this.peek(1).kind !== 'kw')) return null
    this.next()
    return key as 'RETAIN' | 'NON_RETAIN' | 'PERSISTENT'
  }

  /** The qualifier run after a `VAR...` keyword. IEC writes `VAR RETAIN CONSTANT`, but the
   *  two are independent, so either order is taken rather than only the standard's. */
  // PERSISTENT (not IEC; read on input) asks a value to survive a restart and a download too; RETAIN AND PERSISTENT together
  // are the same thing. Read as retention (Decl.persistent), which this simulator, with no restart, carries and does not act on
  private sectionQualifiers(): { constant: boolean; retain: Retention } {
    let constant = false
    let retain: Retention = false
    for (;;) {
      if (this.isKw('CONSTANT')) {
        this.next()
        constant = true
        continue
      }
      const q = this.storageQualifier()
      if (q === null) return { constant, retain }
      retain = q === 'PERSISTENT' ? 'persistent' : retain === 'persistent' && q === 'RETAIN' ? 'persistent' : q === 'RETAIN'
    }
  }
}
