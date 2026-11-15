// Shared types for the in-browser Structured Text (IEC 61131-3 subset) toolchain.
// The transpiler/interpreter consumes a plain ST *source string* - every authoring
// surface (Monaco buffer, fetched `.st` asset, inline literal) reduces to that.

import type { WatchLayout } from '../core/watchTable'

export interface SourcePos {
  /** 1-based line */
  line: number
  /** 1-based column */
  col: number
  /** 0-based byte offset into the source */
  offset: number
}

// TIME is a distinct type, not a number: `PT := 5` must not compile when the
// target expects a duration, and `T#1s + 1` must not silently mean 1001. Its runtime
// representation is milliseconds (IEC leaves the resolution open; milliseconds is this engine's rule, and the
// resolution PLC timers are commonly given in), so TIME_TO_DINT here is a count of milliseconds.
// Three distinct integer families: signed (SINT/INT/DINT), unsigned
// (USINT/UINT/UDINT) and bit-string (BYTE/WORD/DWORD). They share widths but not meaning,
// and IEC keeps them apart - crossing between families needs an explicit conversion.
// STRING is a distinct type too, and a bounded one: `STRING[20]` holds at most 20
// characters and a longer store truncates, which is what targets do (MATIEC cuts
// silently). The bound is a property of the declaration, not
// of the type - `maxLen` below - because IEC assignment compatibility ignores it: any
// STRING stores into any STRING place, it just may not survive the trip whole.
export const SCALAR_TYPES = [
  'BOOL',
  'SINT', 'INT', 'DINT',
  'USINT', 'UINT', 'UDINT',
  'BYTE', 'WORD', 'DWORD',
  'REAL', 'LREAL', 'TIME',
  'DATE', 'TOD', 'DT',
  'STRING',
] as const
export type ScalarType = (typeof SCALAR_TYPES)[number]

/**
 * The calendar types, by the names TC6 XML and every error message give them (`TOD`, `DT`); the long
 * spellings `TIME_OF_DAY` and `DATE_AND_TIME` name the same two. Unlike every other elementary type they
 * are not reserved words here: `dt` is the most ordinary name there is for a time step, and programs
 * written for this engine before it had the types use it. So they are recognised where a TYPE is
 * expected (the checker resolves them like a named type, which a user type of the same name shadows),
 * and a variable spelled like one draws an export warning rather than a refusal, as MATIEC reserves them.
 */
export const CALENDAR_TYPE_NAMES: Readonly<Record<string, 'DATE' | 'TOD' | 'DT'>> = {
  DATE: 'DATE',
  TOD: 'TOD',
  TIME_OF_DAY: 'TOD',
  DT: 'DT',
  DATE_AND_TIME: 'DT',
}

/** IEC's default `STRING` capacity when the declaration doesn't spell one (`s : STRING;`).
 *  80 is the standard's own default, and MATIEC's. */
export const DEFAULT_STRING_LEN = 80

// Builtin function blocks. These names are not reserved words - a user FUNCTION_BLOCK of
// the same name shadows the builtin, which is how IEC treats them and what keeps `SR` and
// `RS` usable as user POU names for anyone who already had one.
//
// AXIS_KERNEL is not a standard block: it is the motion kernel behind the PLCopen motion blocks (MC_Power,
// MC_MoveAbsolute, ...), which are ST function blocks written over it (plc/motionPrelude.ts) and hold it in their
// AXIS_REF. It is a builtin because its state (a motion plan) is the host's, like a timer's clock reading; nothing
// user-facing lists it (USER_FB_TYPES).
export const FB_TYPES = ['TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'CTU', 'CTD', 'CTUD', 'SR', 'RS', 'AXIS_KERNEL'] as const
export type FbType = (typeof FB_TYPES)[number]
/** The builtin blocks a person writes: every one but the motion blocks' kernel. What pickers, catalogs and the
 *  capability manifest list. */
export const USER_FB_TYPES = FB_TYPES.filter((t) => t !== 'AXIS_KERNEL')

/** A user-defined function-block instance type, named by its FUNCTION_BLOCK definition. */
export interface UserFbRef {
  fb: string
}

/** A user-defined STRUCT instance type, named by its TYPE definition. */
export interface StructRef {
  struct: string
}

/** A user-defined enumeration type, named by its TYPE definition. */
export interface EnumRef {
  enum: string
}

/** One member of an enumeration: a name bound to an integer value. */
export interface EnumMember {
  name: string
  value: number
  pos: SourcePos
}

/** A user-defined enumeration: `TYPE Mode : (Idle, Run := 10, Fault); END_TYPE`. */
export interface EnumDef {
  name: string
  /** merged in from the PLCopen motion library (plc/motionPrelude.ts), not written by the program: no exporter
   *  writes it out, since on a real controller it comes from the vendor's motion library */
  library?: true
  members: EnumMember[]
  /** `(Idle, Run) UINT`, a base type for the values (an input form IEC's 2nd edition does not have); its members are held as INT here all the same, so the
   *  checker refuses a value INT cannot hold (and an export leaves the word out: exportText.ts `canonicalSyntax`) */
  base?: ScalarType
  /** where the base type is written */
  basePos?: SourcePos
  /** declared in a variable's declaration, `m : (Idle, Run)`, and named for its spelling: what the exporters write as
   *  the variable's type, not as a type of its own */
  inline?: true
  pos: SourcePos
}

/** A named subrange: `TYPE Percent : INT (0..100); END_TYPE`. The base type does the
 *  arithmetic; the bounds are enforced on every store, as a runtime fault. */
export interface SubrangeDef {
  name: string
  base: ScalarType
  lo: number
  hi: number
  pos: SourcePos
}

/** A type given a name of its own: `TYPE Row : ARRAY [1..3] OF INT; END_TYPE`,
 *  `TYPE Count : INT; END_TYPE`, `TYPE Label : STRING[20]; END_TYPE`, or a new name for another
 *  named type. The checker resolves it to the type it names. */
export interface AliasDef {
  name: string
  type: DataType
  /** capacity when the named type is a `STRING[n]` */
  maxLen?: number
  pos: SourcePos
}

/** The inclusive bounds a subrange-typed place enforces on a store. */
export interface Range {
  lo: number
  hi: number
  /** the type name, so the fault can say which subrange was violated */
  name: string
}

/** One dimension of an array's index range (inclusive `lo..hi`). A bound may be written as a
 *  constant expression (`ARRAY [0..ZONES - 1] OF ...`): the parser keeps it in `loExpr`/`hiExpr`,
 *  and the checker, which knows the constants, folds it into `lo`/`hi`. */
export interface ArrayDim {
  lo: number
  hi: number
  loExpr?: Expr
  hiExpr?: Expr
}

/** A bounded array (1+ dimensions) of a scalar, struct, enumeration or function-block element type. */
export interface ArrayType {
  array: true
  dims: ArrayDim[]
  elem: DataType
  /** capacity of a `STRING[n]` element type - every element carries the same bound */
  elemMaxLen?: number
  /** set when the array is a named type (`TYPE Row : ARRAY [1..3] OF INT; END_TYPE`): arrays of one
   *  name are one type, and an array spelled out in place is never that type */
  named?: string
}

/**
 * `REF_TO T` (IEC 61131-3 3rd edition, 6.4.4.10): a variable holding a reference to another place, or NULL. It is given
 * one with `r := REF(place);` (or another reference, `r := r2;`, or `r := NULL;`), or by passing one to a block's or
 * method's REF_TO input, and the place is reached by dereferencing it, `r^`: `r^ := r^ + 1` changes the variable `r`
 * refers to. Dereferencing one that is NULL faults the scan. It holds no value of its own, so it is not a tag: the
 * watch never lists one.
 */
export interface RefType {
  ref: DataType
  /** capacity when the referenced type is `STRING[n]` */
  maxLen?: number
}

/** A variable of an INTERFACE type: it refers to an instance of a block that implements the interface (or holds 0),
 *  and a method called through it runs the implementation of the instance's own class. */
export interface InterfaceRef {
  iface: string
}

/**
 * The type of a value a variable / field / array element can hold.
 *
 * A function-block instance is one of them: data with a body attached, not a separate kind of
 * thing, so it can sit anywhere a struct can - an array element (`ARRAY [1..20] OF TON`), a
 * struct field, a VAR_GLOBAL. That is IEC's model, and real programs lean on timer arrays
 * constantly. Instances once lived in a side table beside
 * the variable image, which is why none of those shapes compiled then.
 *
 * A reference and an interface are the two that are not data: each designates an instance or a place held elsewhere.
 * Only a POU's own variables may be one (the checker), never a struct field or an array element.
 */
export type DataType = ScalarType | ArrayType | StructRef | EnumRef | FbType | UserFbRef | RefType | InterfaceRef

/** A declared type: the same set as {@link DataType}, kept under its own name for declarations. */
export type DeclType = DataType

/** True when a declared type is a user-defined function-block instance (vs a builtin). */
export function isUserFb(t: DeclType): t is UserFbRef {
  return typeof t === 'object' && 'fb' in t
}

/** True when a declared type is an array. */
export function isArray(t: DeclType): t is ArrayType {
  return typeof t === 'object' && 'array' in t
}

/** True when a declared type is a struct instance. */
export function isStruct(t: DeclType): t is StructRef {
  return typeof t === 'object' && 'struct' in t
}

/** True when a declared type is an enumeration. */
export function isEnum(t: DeclType): t is EnumRef {
  return typeof t === 'object' && 'enum' in t
}

/** True when a declared type is a `REF_TO`. */
export function isRef(t: DeclType): t is RefType {
  return typeof t === 'object' && 'ref' in t
}

/** True when a declared type is an INTERFACE. */
export function isInterface(t: DeclType): t is InterfaceRef {
  return typeof t === 'object' && 'iface' in t
}

/** `VAR_EXTERNAL` names a VAR_GLOBAL a POU uses. It declares no storage: the checker proves the
 *  global exists with the same type, and every read and write reaches the global itself. */
export type VarSection = 'VAR' | 'VAR_INPUT' | 'VAR_OUTPUT' | 'VAR_TEMP' | 'VAR_GLOBAL' | 'VAR_IN_OUT' | 'VAR_EXTERNAL'

export type BinOp =
  | 'AND' | 'OR' | 'XOR'
  | '=' | '<>' | '<' | '>' | '<=' | '>='
  | '+' | '-' | '*' | '/' | 'MOD'

export type UnOp = 'NOT' | 'NEG' | 'POS'

// `t` is filled in by the type checker and used by the interpreter/emitter to
// apply width-correct integer coercion. It is absent until a program is checked.
export type Expr =
  // `declared` is the type of a typed literal (`INT#5`); without it the checker types the
  // literal by magnitude. `value` is normalised to `t` by the checker (a REAL literal is
  // rounded to f32 there), so both backends read the same number.
  | { node: 'num'; value: number; real: boolean; declared?: ScalarType; pos: SourcePos; t?: ScalarType }
  | { node: 'bool'; value: boolean; pos: SourcePos; t?: ScalarType }
  // a single-quoted STRING literal, already unescaped by the lexer ('a$$b' -> `a$b`)
  | { node: 'str'; value: string; pos: SourcePos; t?: ScalarType }
  // `global` is set by the checker when the name resolved to a VAR_GLOBAL rather than a
  // POU local, so the emitter knows which storage object to reach into. `enum` carries the
  // enumeration a value belongs to: enum values are integers at runtime (so `t` is the
  // integer type and all the width machinery applies unchanged), but they are a distinct
  // type for assignment, which is what this tag tracks.
  // `maxLen` is the STRING capacity of the place, carried over from its declaration and
  // enforced (by truncation) on every store, the way `range` is for a subrange.
  // `qualifier` is the type written in `Mode#Idle`: a name spelled that way is always a member
  // A place lowered from a graphical dialect's element carries no field here: the dialect holds that
  // beside its own code, keyed by the node (ladder.ts `ladderRole`), so this AST stays language-free.
  // `ref` says the variable is a REF_TO dereferenced, `r^` (the parser sets it for the `^`, the checker refuses it on
  // anything but a REF_TO): the node then stands for the place it refers to. A REF_TO named without `^` is the
  // reference itself, which only an assignment to a REF_TO, a REF_TO argument and a comparison with NULL take
  | { node: 'var'; name: string; global?: boolean; pos: SourcePos; t?: ScalarType; enum?: string; constValue?: number; range?: Range; maxLen?: number; qualifier?: string; ref?: true }
  // `THIS` (IEC's spelling, THIS.x): the instance whose method or body is running; `SUPER^` the same instance seen as
  // its base class. `cls`, set by the checker: the class it is, as the code is written (for SUPER, the base).
  | { node: 'this'; super?: boolean; pos: SourcePos; t?: ScalarType; cls?: string }
  // A METHOD called on an instance (`m.Start(5)`, `THIS.Peek()`, `SUPER^.Run()`, `itf.Move(x := 1)`, `r^.Run()`).
  // The checker fills in:
  //   key       which of the class's callables (`START`; MethodDef.key)
  //   dispatch  where the implementation comes from: 'static', the class `cls` (an instance declared of that class,
  //             or SUPER^, whose cls is the base); 'self', the class of the instance running (THIS: an override in a
  //             derived class wins); 'dynamic', the class of the instance an interface or a reference designates
  //   body      SUPER^(): the base class's body, run on this instance (no method at all)
  // `args` are a block call's: inputs `:=`, outputs `=>`, in-outs bound to places.
  //   sig       the method as the checker found it (an interface's signature, for a call through one): its parameters
  //             and result are every implementation's
  | { node: 'mcall'; obj: Expr; method: string; args: FbArg[]; pos: SourcePos; t?: ScalarType; enum?: string; maxLen?: number; key?: string; dispatch?: 'static' | 'self' | 'dynamic'; cls?: string; body?: true; sig?: MethodDef }
  // Whether a reference or an interface designates anything: `r <> NULL`, `itf <> 0` (the checker makes one of either;
  // `r = NULL` is not of one). `nullFirst`: written NULL first, `NULL <> r` (export warns: OpenPLC builds only r <> NULL)
  | { node: 'isref'; obj: Expr; pos: SourcePos; t?: ScalarType; nullFirst?: true }
  // `fbOutput` is set by the checker when `obj` is a function-block instance, so this reads one
  // of its outputs - which only the block itself may write
  | { node: 'member'; obj: Expr; field: string; pos: SourcePos; t?: ScalarType; enum?: string; range?: Range; maxLen?: number; fbOutput?: boolean }
  | { node: 'index'; obj: Expr; indices: Expr[]; dims?: ArrayDim[]; pos: SourcePos; t?: ScalarType; enum?: string; range?: Range; maxLen?: number }
  // One bit of an integer place: `Status.%X3` (or `Status.3`), `Words[2].15`, `Motor.Faults.0`. It
  // reads as a BOOL and is a place (a coil / `:=` write it). `obj.t`, set by the checker, is the
  // integer the bit lives in, which is what a store needs to wrap the word back to its own width.
  | { node: 'bit'; obj: Expr; bit: number; pos: SourcePos; t?: ScalarType }
  | { node: 'unary'; op: UnOp; expr: Expr; pos: SourcePos; t?: ScalarType }
  // AND / OR evaluate both operands, which is this engine's rule, since IEC 61131-3 leaves it open (interpreter.ts)
  | { node: 'binary'; op: BinOp; left: Expr; right: Expr; pos: SourcePos; t?: ScalarType }
  // `enum` is set when a user FUNCTION returns an enumeration, the way it is on a place. `names`
  // holds the parameter each argument names in a formal call (`Scale(hi := 10, v := x)`); the
  // checker reorders the arguments into declaration order and drops it, so nothing past the
  // checker ever sees a formal call
  //
  // A formal call to a user FUNCTION may leave inputs out (they take their declared initial value). The
  // checker then keeps only the arguments given, in declaration order, and `slots` says which input each
  // one is: `slots[k]` is the input index of `args[k]`. Absent, every input is given, in order.
  // `reordered` is set when a formal call of a standard function named its arguments out of IEC's order: the
  // meaning is the same here, but STruC++ binds a standard function's arguments by position (export warns).
  | { node: 'call'; name: string; args: Expr[]; pos: SourcePos; t?: ScalarType; enum?: string; names?: string[]; slots?: number[]; reordered?: boolean }

/**
 * A structured initial value, found only in a declaration: `(id := 7, dest := 3)` for a struct, whose
 * fields not named keep their zero. A field's value is an expression, a nested structured value, or
 * an array's `[...]` list.
 */
export interface StructInit {
  node: 'structInit'
  /** `implied`: a field's value the program did not write here, the struct's own default for it (StructField.init),
   *  which the checker adds so every engine starts the field there. The exporters leave it out: the type says it */
  fields: { name: string; value: Initializer; pos: SourcePos; implied?: true }[]
  pos: SourcePos
  /** the whole value is the struct's defaults, put there by the checker where the program wrote none */
  implied?: true
}

/** An array's `[...]` list inside a structured initial value, row-major with repetitions expanded. */
export interface ArrayInitList {
  node: 'arrayInit'
  items: Initializer[]
  pos: SourcePos
}

/** What an initial value can be: a single expression, or a structured one. */
export type Initializer = Expr | StructInit | ArrayInitList

export interface FbArg {
  name: string
  /** the value for an input (`IN := x`), or the destination place for an output (`Q => y`) */
  value: Expr
  /** true for an output binding, which reads the member back after the call */
  out?: boolean
  /** true for a VAR_IN_OUT parameter: the argument is a place the block reads and writes */
  inout?: boolean
  /** true when the value is a whole ARRAY or STRUCT, which crosses by value: an input is copied
   *  into the block's own storage before the call, an output binding copied out after it */
  copy?: boolean
  /** true when the argument arrived without a parameter name - IEC's non-formal call,
   *  `CTU_1(CU, R, PV)`. `name` is empty until the checker fills it in from the block's
   *  declaration order, which is the only place the block's parameters are known. */
  positional?: boolean
  /** set by the checker when the parameter is a REF_TO ('ref': the argument is the place it is given a reference to,
   *  `REF(place)`, or a literal 0 for NULL) or an INTERFACE ('iface': the argument is the instance it refers to) */
  bind?: 'ref' | 'iface'
  /** with `bind: 'ref'`: the argument is another REF_TO variable (`p := r`), whose reference is passed on as it is,
   *  NULL included */
  alias?: true
  pos: SourcePos
}

/** One CASE label: an integer, an inclusive `lo..hi` range, or an enumeration member
 *  (resolved to its value by the checker, which is the only place the enum is known). */
export type CaseLabel =
  | { kind: 'single'; value: number }
  | { kind: 'range'; lo: number; hi: number }
  | { kind: 'name'; name: string; value?: number; pos: SourcePos; qualifier?: string }

export type Stmt =
  // target is a place expression: a var, a struct field (member), or an array element (index).
  // `copy` is set by the checker when the target is a whole ARRAY or STRUCT: the value is then
  // copied into the target's own storage, element by element, rather than stored as a scalar. It
  // says whether the type is named (a struct, or a TYPE ... : ARRAY) or an array spelled out in
  // place, because the toolchains disagree only about copying the latter.
  | { node: 'assign'; target: Expr; value: Expr; pos: SourcePos; copy?: 'named' | 'anonymous-array' }
  // `target` is the instance being called, and it is a place just like an assignment's target: a
  // variable, a struct field or an array element (`t(...)`, `line.gap(...)`, `zones[i](...)`)
  | { node: 'fbcall'; target: Expr; args: FbArg[]; pos: SourcePos }
  | { node: 'if'; branches: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null; pos: SourcePos }
  | { node: 'case'; selector: Expr; cases: { labels: CaseLabel[]; body: Stmt[] }[]; elseBody: Stmt[] | null; pos: SourcePos }
  // `vt` (the loop variable's declared type) is filled in by the checker, like Expr.t
  | { node: 'for'; varName: string; from: Expr; to: Expr; by: Expr | null; body: Stmt[]; pos: SourcePos; vt?: ScalarType; vGlobal?: boolean }
  | { node: 'while'; cond: Expr; body: Stmt[]; pos: SourcePos }
  | { node: 'repeat'; body: Stmt[]; cond: Expr; pos: SourcePos }
  | { node: 'exit'; pos: SourcePos }
  | { node: 'continue'; pos: SourcePos }
  | { node: 'return'; pos: SourcePos }
  // a METHOD (or SUPER^()) called for what it does, its result if any dropped: `m.Reset();`. The parser reads one as an
  // `fbcall`; the checker, which knows `m.Reset` is a method, turns it into this.
  | { node: 'invoke'; call: Extract<Expr, { node: 'mcall' }>; pos: SourcePos }
  // `r := REF(place);` gives a REF_TO a reference ('ref': `source` is the place); `itf := instance;` points an INTERFACE
  // at an instance ('iface'). The checker makes both of an assignment. A null `source` is `r := NULL` / `itf := 0`: it
  // refers to nothing. `alias`: `source` is another REF_TO variable (`r := r2`), whose reference is copied, NULL too.
  | { node: 'bind'; target: Expr; source: Expr | null; pos: SourcePos; kind?: 'ref' | 'iface'; alias?: true }

export interface Decl {
  name: string
  type: DeclType
  init: Expr | null
  /** element initialisers for an ARRAY declaration (`:= [1, 2, 3]`), row-major with repetitions
   *  expanded; an element of a struct array is a `(field := ...)` initializer */
  arrayInit?: Initializer[]
  /** a STRUCT declaration's `:= (field := value, ...)` initializer */
  structInit?: StructInit
  /** declared in a `VAR CONSTANT` block - readable everywhere, writable nowhere */
  constant?: boolean
  /** declared in a `VAR RETAIN` block. Carried, not acted on: this simulator has no warm
   *  restart for a value to survive, so retention has no observable effect here. It is kept
   *  so the exporters can write the word back out for a target that does restart. */
  retain?: boolean
  /** declared `PERSISTENT` (not IEC, read on input: kept across a restart AND a download), which `retain` also says. Carried
   *  for the exporters (PLCopen's `persistent`; RETAIN in IEC text, its nearest word) */
  persistent?: true
  /** bounds carried over from a subrange type, enforced on every store */
  range?: Range
  /** capacity of a `STRING[n]` declaration (defaulted to {@link DEFAULT_STRING_LEN}) */
  maxLen?: number
  /**
   * A LOCATED variable's direct address (`Eye AT %IX100.0 : BOOL`), in the canonical spelling of
   * core/io/iecAddress.ts. The address, not the name, is how the variable meets the scene and any
   * external controller: an %I variable is an input under that key, a %Q one an output.
   */
  location?: string
  /**
   * `AT %I*` / `%Q*` / `%M*`: an incomplete address, which a PLC project completes in its I/O
   * configuration (IEC: VAR_CONFIG). This simulator's I/O configuration is the scene's wiring, which binds a variable
   * by name, so the variable is an ordinary one and this is only what was written (exportText.ts `canonicalSyntax`
   * leaves it out).
   */
  linked?: string
  /** where the address is written, for a diagnostic about it */
  locationPos?: SourcePos
  /** its length as written */
  locationLength?: number
  /** which `VAR ... END_VAR` block of the file declared it (a running count), so a rule about a
   *  block, rather than a section kind, can tell two blocks apart */
  block?: number
  section: VarSection
  pos: SourcePos
  /** declared by the ladder lowering, not by the author: a rung condition held across a write, an edge's memory
   *  (ladder.ts). Kept out of what a scene can bind and out of the watch table. */
  hidden?: boolean
}

/** Who may call a METHOD: anyone (PUBLIC, the default, and INTERNAL, which only means more in a
 *  program split into libraries), the class itself (PRIVATE), or the class and the classes derived from it (PROTECTED). */
export type Access = 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'INTERNAL'

/**
 * A METHOD of a function block (or its signature in an INTERFACE): a function that runs on an instance. Its own
 * variables are temporary - they start from their declared values on every call, as a FUNCTION's do - and the
 * instance's variables are in scope beneath them. Its result, when it has one, is the variable named after it.
 */
export interface MethodDef {
  name: string
  /** null: the method returns nothing, and only a statement may call it */
  ret: DataType | null
  retMaxLen?: number
  retRange?: Range
  decls: Decl[]
  body: Stmt[]
  pos: SourcePos
  access?: Access
  abstract?: boolean
  final?: boolean
  /** written OVERRIDE: it replaces the base class's method of its name (which it would anyway; the word asserts it) */
  override?: boolean
  /** declared in an INTERFACE, or ABSTRACT: a signature with no implementation */
  bodyless?: boolean
  /** set by the checker: what a call names it by, its name upper-cased */
  key?: string
  /** set by the checker: the block or interface that declares it */
  owner?: string
  /** see {@link FbDef.bodyStart} */
  bodyStart?: number
  /** offset of the END_METHOD closing its statements: they are the source between the two */
  bodyEnd?: number
  /** the source it is written in, METHOD to END_METHOD */
  start?: number
  end?: number
}

/** `INTERFACE IDrive [EXTENDS IBase, ...] <method signatures> END_INTERFACE`. */
export interface InterfaceDef {
  name: string
  extends: { name: string; pos: SourcePos }[]
  methods: MethodDef[]
  pos: SourcePos
  /** set by the checker: every callable of the interface and of those it extends, by key */
  table?: Map<string, MethodDef>
}

/** A user-defined FUNCTION_BLOCK: its own VAR sections + a cyclic body. */
export interface FbDef {
  name: string
  /** merged in from the PLCopen motion library (plc/motionPrelude.ts), not written by the program: no exporter
   *  writes it out, since on a real controller it comes from the vendor's motion library */
  library?: true
  decls: Decl[]
  body: Stmt[]
  pos: SourcePos
  /** offset where the body begins, i.e. where one more VAR block could be written (plc/tags.ts) */
  bodyStart?: number
  /** offset of its END_FUNCTION_BLOCK */
  end?: number
  /** `EXTENDS Base`: the block this one is derived from */
  extends?: { name: string; pos: SourcePos }
  /** `IMPLEMENTS IDrive, ...` */
  implements?: { name: string; pos: SourcePos }[]
  methods?: MethodDef[]
  /** `FUNCTION_BLOCK ABSTRACT`: never instantiated, only derived from */
  abstract?: boolean
  /** `FUNCTION_BLOCK FINAL`: never derived from */
  final?: boolean
  /** set by the checker for a derived block: every variable it inherits, the root class's first (program.ts fbDecls) */
  inherited?: Decl[]
  /** set by the checker: every callable an instance of this block answers to (its own, then what it inherits and does
   *  not override), by key, each the MethodDef that implements it (whose `owner` says where it is written) */
  table?: Map<string, MethodDef>
}

/** A user-defined stateless FUNCTION: inputs + locals, returns one value - a scalar, an
 *  enumeration, or a whole struct. (An ARRAY parses here only so the checker can refuse it by name:
 *  a result type must be a type name, and this subset cannot name an array type yet.) */
export interface FuncDef {
  name: string
  /** merged in from the PLCopen motion library (plc/motionPrelude.ts), not written by the program: no exporter
   *  writes it out, since on a real controller it comes from the vendor's motion library */
  library?: true
  /** a named return type arrives unresolved from the parser, like a declaration's; the checker
   *  resolves it in place */
  ret: DataType
  /** capacity when the return type is `STRING[n]` */
  retMaxLen?: number
  /** bounds when the return type is a subrange, enforced on every store into the result */
  retRange?: Range
  /** set by the checker when some formal call leaves one of its inputs out (the call's `slots`), so the
   *  emitted function fills an input it was not handed with the input's start value */
  omittable?: boolean
  decls: Decl[]
  body: Stmt[]
  pos: SourcePos
  /** see {@link FbDef.bodyStart} */
  bodyStart?: number
}

/** One field of a struct (scalar, array, nested struct, enumeration or function-block instance). */
export interface StructField {
  name: string
  type: DataType
  /** capacity of a `STRING[n]` field, enforced on every store into it */
  maxLen?: number
  /** `Speed : REAL := 1.5;`: what the field starts at in every value of the struct. The checker folds it into the
   *  initializer of every declaration holding one (checker.ts `impliedInit`), so no engine reads it */
  init?: Initializer
  pos: SourcePos
}

/** A user-defined STRUCT type: a named record of scalar fields. */
export interface StructDef {
  name: string
  /** merged in from the PLCopen motion library (plc/motionPrelude.ts), not written by the program: no exporter
   *  writes it out, since on a real controller it comes from the vendor's motion library */
  library?: true
  fields: StructField[]
  pos: SourcePos
}

/** A PROGRAM POU: a TYPE of program, run by the instances a CONFIGURATION declares of it. */
export interface ProgramDef {
  name: string
  decls: Decl[]
  body: Stmt[]
  pos: SourcePos
  /** see {@link FbDef.bodyStart} */
  bodyStart?: number
}

/**
 * `TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);` - its arguments as written. The checker validates
 * them and fills in `periodMs` and `priority`, the only two this controller schedules on.
 */
export interface TaskDef {
  name: string
  args: { name: string; value: Expr; pos: SourcePos }[]
  pos: SourcePos
  periodMs?: number
  priority?: number
}

/** `PROGRAM Line1 WITH Fast : Merge;` - one running instance of a PROGRAM type. With no `WITH`, the
 *  instance runs continuously: IEC gives a program with no task the lowest priority. With no type
 *  (`PROGRAM Main WITH Fast;`, this engine's extension) it runs the code outside every POU, whose
 *  variables are the controller's own tags (see `controllerTags`). */
export interface ProgramInstanceDef {
  name: string
  task: string | null
  taskPos?: SourcePos
  type: string | null
  typePos?: SourcePos
  retain?: boolean
  pos: SourcePos
}

/** `RESOURCE Res0 ON PLC`: one processing unit of a configuration. */
export interface ResourceDef {
  name: string
  on: string
  pos: SourcePos
}

/**
 * `CONFIGURATION ... END_CONFIGURATION`: the controller. Tasks and program instances are collected
 * across its resources, which the checker then limits to one; its VAR_GLOBALs join the program-wide
 * globals, because one controller has one global namespace.
 */
export interface ConfigurationDef {
  name: string
  resources: ResourceDef[]
  tasks: TaskDef[]
  programs: ProgramInstanceDef[]
  pos: SourcePos
}

export interface Ast {
  /** user-defined STRUCT types, referenced by any POU */
  typeDefs: StructDef[]
  /** user-defined enumerations, referenced by any POU */
  enumDefs: EnumDef[]
  /** user-defined subrange types, referenced by any POU */
  subrangeDefs: SubrangeDef[]
  /** user-defined named types (a named array, a plain alias), referenced by any POU */
  aliasDefs: AliasDef[]
  /** user-defined function blocks, available to the main program and to each other */
  fbDefs: FbDef[]
  /** INTERFACEs the function blocks implement and variables are declared of */
  interfaceDefs: InterfaceDef[]
  /** user-defined stateless functions, callable from any expression */
  funcDefs: FuncDef[]
  /** VAR_GLOBAL declarations - one shared image every POU reads and writes. Includes the ones
   *  declared inside a CONFIGURATION or its RESOURCE. */
  globals: Decl[]
  /** PROGRAM POUs. A file with none has an implicit program: `decls` and `body` below */
  programDefs: ProgramDef[]
  /** the CONFIGURATION, when the file declares one */
  configuration: ConfigurationDef | null
  /** the code outside every POU: the implicit program's, or, beside a CONFIGURATION, the
   *  controller's own tags and the statements its instance with no type runs */
  decls: Decl[]
  body: Stmt[]
  /** every `LADDER ... END_LADDER` section, in source order. Their rungs are already lowered into the bodies
   *  above, so nothing that runs a program reads this: it is for whoever needs the rungs as rungs (the ladder
   *  view, the PLCopen LD writer) or their ST (the text exporters). See ladder.ts. */
  ladder: import('./ladder/ladder').LdSection[]
  /** where the code outside every POU begins (its VAR sections end): where a controller-scoped tag is
   *  declared (plc/tags.ts). The end of the file when there is no such code. */
  bodyStart: number
  /** source offset of the bit number in every `Tag.3` the program writes, in order. IEC spells the
   *  same access `Tag.%X3`, and the exporters work on text, so this is where they put the `%X`. */
  bitRefs: number[]
  /** the program addresses a bit of an integer somewhere, in either spelling */
  usesBits: boolean
  /** STRING capacities written as constant expressions (`STRING(MAX_LEN)`): a capacity of -(1 + k) anywhere in the AST
   *  stands for `capacities[k]`, which the checker folds against the global CONSTANTs and writes in its place */
  capacities?: Expr[]
  /** where each of `capacities` is written in the source (its brackets, `start` to just past the closing one), so an
   *  export can write the folded integer there: IEC's capacity is an integer, never an expression */
  capacitySpans?: { start: number; end: number }[]
  /** each of `capacities`, folded (set by the checker) */
  capacityValues?: number[]
}

export interface Diagnostic {
  message: string
  pos: SourcePos
  length: number
  /** absent: an error - the program does not compile. `'warning'`: it compiles and runs, and this is something to
   *  know about it (a number converted on the way into a narrower type). Nothing may treat a warning as a failure. */
  severity?: 'warning'
  /** raised by the CONFIGURATION check: when a controller table stands for that CONFIGURATION, the table is what fixes
   *  it, wherever in the text it points (plc/controller.ts) */
  origin?: 'configuration'
}

/** A compile/parse error carrying a source position so editors can place a marker. */
export class StError extends Error {
  /** see {@link Diagnostic.origin} */
  origin?: 'configuration'
  constructor(
    message: string,
    public pos: SourcePos,
    public length = 1,
  ) {
    super(message)
    this.name = 'StError'
  }
}

/** `addr` is a direct address (`%IX0.0`): `value` holds its canonical spelling, `raw` the source's */
export type TagKind = 'ident' | 'num' | 'str' | 'kw' | 'op' | 'addr' | 'eof'

export interface Token {
  kind: TagKind
  /** for a 'str' token this is the unescaped text; `raw` keeps the source spelling */
  value: string
  /** source spelling of a string literal, including quotes - for diagnostic lengths */
  raw?: string
  num: number
  real: boolean
  /** set on a typed literal (`INT#5`, `REAL#1.5`) - the type the author spelled out */
  type?: ScalarType
  /** set on an enumeration value spelled with its type (`Mode#Idle`): the type name, while
   *  `value` holds the member */
  qualifier?: string
  pos: SourcePos
}

/** A PLC tag value crossing the sim<->controller boundary. `string` is here for STRING
 *  variables: they show up in the watch table and the inline value overlay like any other
 *  scalar. Scene tag bindings remain numeric/boolean - nothing in the sim consumes a string
 *  tag - so a host reading these should treat a string as display-only. */
export type TagValue = boolean | number | string

/**
 * One task of a controller, as a scheduler sees it.
 *
 * A periodic task runs its programs every `periodSec` of sim time. The continuous task holds the
 * program instances a CONFIGURATION assigns to no task: IEC gives those the lowest priority and
 * re-runs them as soon as they finish, which on a sim clock means once per step, after every
 * periodic scan that step. It is listed last and its `priority` is Infinity.
 */
export interface TaskInfo {
  name: string
  kind: 'periodic' | 'continuous'
  periodSec: number
  /** IEC's convention: 0 is the highest priority */
  priority: number
  /** program instance names, in the order they run */
  programs: string[]
}

/** Result of compiling one ST program: a runnable cyclic-scan unit. */
/** A variable as {@link CompiledProgram.varInfo} describes it. */
export interface VarInfo {
  type: ScalarType | 'ENUM'
  constant: boolean
  /** `%IX100.0`, when the variable is located */
  location?: string
}

/** A variable's resolved read/write handle (CompiledProgram.port). */
export interface TagPort {
  set(value: TagValue): void
  get(): TagValue | undefined
}

/** The watch table as places in a program's memory ({@link CompiledProgram.watchPlan}): where each value is, and the
 *  buffer they are all in. The buffer is the running program's own, so a reader copies it before handing it on. */
export interface WatchPlan {
  layout: WatchLayout
  memory: ArrayBuffer
}

export interface CompiledProgram {
  /**
   * The controller's tasks, in declaration order, continuous last. Empty for a program with no
   * CONFIGURATION: its one program runs on whatever scan time the host gives it, via `scan`.
   * When a CONFIGURATION is declared, its program instances' variables are addressed as
   * `Instance.Name` everywhere below, and the globals by their bare names.
   */
  readonly tasks: readonly TaskInfo[]
  readonly inputs: string[]
  readonly outputs: string[]
  /**
   * The variables a scene part may bind by wiring, beyond the declared `inputs` / `outputs`: the
   * controller's own tags (a plain VAR of the code outside every PROGRAM, or of a CONFIGURATION), the
   * globals, and a program instance's own variables (`Main.Eye`). Not a constant, not a located
   * variable (its address is its binding), not a STRING or an aggregate. Which way each one goes is
   * the scene's to say - see plc/wiring.ts `wiredBindings`.
   */
  readonly bindable: string[]
  /** snapshot of every scalar variable's current value (for a watch table) */
  readonly watch: Readonly<Record<string, TagValue>>
  /**
   * The keys of `watch` that no program instance owns: the controller's tags and the globals. For a reader that needs
   * those names and not every instance's values, which on a large program is the whole cost of `watch`
   * (plc/link/plcLink.ts, the bare-name aliases). Absent from a program with no instances to tell them from.
   */
  sharedWatchKeys?(): string[]
  /**
   * Whether the variable a qualified name starts at is one its program instance declares, in any spelling:
   * `Line.Zone[3].Run` asks whether instance `Line` declares `Zone`. Every key `watch` lists under an instance
   * starts at one, so a name this refuses is no key of it. False for a name no instance leads.
   */
  instanceDeclares?(name: string): boolean
  /**
   * Everything the program holds, keyed as `watch` keys it - with no array left out for being large. The watch table
   * caps an array's size because it is built and posted many times a second; this is for what is asked once and must
   * be complete: saving the controller's values into the project, which may not skip a tag for being a big one.
   */
  readonly memory: Readonly<Record<string, TagValue>>
  /** the declared scalar type of each `memory` key it can tell (an enumeration is 'ENUM'): what the engines' oracle
   *  holds every stored value to (scanEngineOracle.ts) */
  readonly memoryTypes: Readonly<Record<string, string>>
  /** every scalar the controller holds, inside function block instances too (Pou.deepInto): what the engines' oracle
   *  compares, so state no surface lists - a block's own variables - is held to the walker as well. Test support. */
  readonly deepMemory: Readonly<Record<string, TagValue>>
  /** write an input before the next scan */
  setInput(name: string, value: TagValue): void
  /** read any variable (input / output / internal) */
  get(name: string): TagValue | undefined
  /**
   * One variable's handle, its name resolved once: `set` does what setInput does for that name and `get` what get
   * does, without looking the name up again. For a host that moves the same tags every scan (plcLink.ts
   * LocalPlcLink), where resolving each by name, every scan, was a large share of the PLC's whole cost. A name that
   * resolves to nothing gives a handle whose set does nothing and whose get is undefined, as setInput and get do.
   */
  port(name: string): TagPort
  /**
   * What a variable is, by the name the watch table keys it by: its declared type (an enumeration reads
   * `ENUM`), whether it is a constant, and its address when it is located. Undefined for a function block's
   * member (`T1.Q`) and for anything that is not a single bit, number or string. For a surface that publishes
   * the variables by name and has to say what each one holds (editor/links/opcUaServer.ts).
   */
  varInfo(name: string): VarInfo | undefined
  /**
   * Where `watch`'s values are in the program's memory, for a host that sends the table many times a second: the
   * bytes copy in a fraction of the time the table takes to build (core/watchTable.ts). Planned once. Null from an
   * engine whose memory is not one buffer (the walker), and absent from a program that is not compiled here.
   */
  watchPlan?(): WatchPlan | null
  /** execute one cyclic scan; `dt` = elapsed seconds since the previous scan, which moves the
   *  controller's clock on. Timers read that clock, so one the scan does not call (inside an IF,
   *  behind EN) still measures the time between its calls. Throws a
   *  positioned {@link StError} on a runtime fault (integer division/MOD by zero, array
   *  index out of bounds, a loop hitting its iteration cap) - the host should stop the
   *  program and surface the message, like a real PLC dropping into its fault state.
   *  With tasks, one pass: every periodic task by priority, then the continuous one, all with `dt`
   *  (a scheduler that honours the periods calls `scanTask` instead). */
  scan(dt: number): void
  /** one scan of task `index`: each of its program instances once, in order, with the task's reading of the clock moved on by `dt` */
  scanTask(index: number, dt: number): void
}
