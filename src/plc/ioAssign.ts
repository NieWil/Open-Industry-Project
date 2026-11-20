// Giving the controller's tags I/O addresses: the program half of "Assign I/O" and "Import I/O list"
// (editor/program/ioAssign.ts is the scene half).
//
// A PLC on the network sees points, not names, so each tag a part is wired to becomes a LOCATED variable
// (`Eye AT %IX100.0 : BOOL`) and the part is wired to that address. Only declarations change; the Inspector
// shows the name beside the address.
//
// Which tags. The controller's own: declared outside every POU (the VAR blocks of code outside every PROGRAM,
// or VAR_GLOBAL), not CONSTANT. IEC lets neither a PROGRAM's inputs/outputs (`Main.Run`) nor a function block's
// variables sit at an address. An undeclared tag is declared, located, so its name survives as the point's
// symbol: in a VAR block when the file is code outside every PROGRAM, in VAR_GLOBAL when it declares PROGRAMs.
//
// How the text changes. An all-located block is edited in place. A block that keeps ordinary variables moves the
// located ones to the all-located block of the same kind right after it (or a new one), because MATIEC refuses a
// block that mixes the two (docs/st-conformance.md); rerunning grows that one block. A multi-name declaration is
// split, one address each, and a comment on a moved line moves with it. Nothing else is touched.
//
// Which addresses. Deterministic, skipping every address already used, in the program's declaration order then
// the scene's. The base depends on the controller ({@link IoTarget}): for a PLC that polls the simulator
// (OpenPLC), bits from %IX0.0 / %QX0.0, words from %IW0 / %QW0, double words from %ID50 / %QD50 (registers 100
// up, leaving a hundred words below). Bits and words start where OpenPLC's Editor (4.3) puts a new remote
// device's first points, so the program runs there with the same addresses (guides/modbus/ follows it). For a
// PLC that serves its process image as registers, packed from the server device's first register, since there
// a bit and the word that holds it are one place.

import { isBitArea, modbusPointFor, registerImagePointFor, type RegisterBase } from '../core/io/externalIo'
import { canonicalAddress, parseDirectAddress, sizeWord, TYPES_FOR_SIZE, type IoSize } from '../core/io/iecAddress'
import { lex } from './lexer'
import { locatedInTokens } from './locatedIndex'
import { identKey } from './program'
import type { Token } from './types'
import { addressProblem } from './wiring'

/** One part parameter wired to a tag by name, and what it needs the tag's point to carry. `dir` is the part's. */
export interface IoTagUse {
  name: string
  dir: 'in' | 'out'
  stType?: 'BOOL' | 'INT' | 'DINT' | 'REAL'
}

/** A tag given an address: `address` is canonical, and `type` is what to declare it as when the program does not. */
export interface IoAssignment {
  name: string
  address: string
  type: string
}

export interface IoSkip {
  name: string
  reason: string
}

export interface IoPlan {
  assignments: IoAssignment[]
  skipped: IoSkip[]
}

/**
 * Which kind of controller the addresses are for.
 *
 * - `modbus-server` (the default): the simulator serves and the PLC polls it, as OpenPLC does. Bits and words
 *   travel in separate Modbus areas there, so %IX100.0 and %IW50 are two different points.
 * - `register-image`: the PLC serves its process image as registers and the simulator polls it
 *   (core/io/externalIo.ts, registerImagePointFor). The image is byte-addressed, so
 *   %IX100.0 is a bit of %IW50 and the two clash, and addresses count from where the device sits (`base`).
 */
export type IoTarget = { kind: 'modbus-server' } | { kind: 'register-image'; base: RegisterBase }

export const SERVER_TARGET: IoTarget = Object.freeze({ kind: 'modbus-server' })

/** One row of an imported I/O list. `line` is 1-based, for a message. */
export interface IoListRow {
  name: string
  address: string
  line: number
}

// ── Reading the controller's declarations ──────────────────────────────────────────────────────────

interface DeclLine {
  names: Token[]
  /** the address token of a declaration that is already located */
  at?: Token
  colon: Token
  semi: Token
  /** the declared type's first word, upper-cased (`BOOL`, `ARRAY`, a named type) */
  type: string
}

interface VarBlock {
  /** VAR_INPUT / VAR_OUTPUT: a top-level one, whose tags can only leave it (IEC gives an input or output no `AT`) */
  kind: 'VAR' | 'VAR_GLOBAL' | 'VAR_INPUT' | 'VAR_OUTPUT'
  /** the block's opening words as they should be repeated: `VAR`, `VAR_GLOBAL RETAIN` */
  header: string
  constant: boolean
  open: Token
  close: Token
  /** just past `END_VAR` (and a `;` after it) */
  endOffset: number
  decls: DeclLine[]
}

interface ControllerTag {
  name: string
  block: VarBlock
  decl: DeclLine
}

interface ControllerDecls {
  blocks: VarBlock[]
  /** identKey -> the first declaration of that name, in declaration order */
  tags: Map<string, ControllerTag>
  /** whether the file declares a PROGRAM, which leaves the controller's tags only VAR_GLOBAL */
  hasProgram: boolean
  /** where the code outside every POU starts (its first VAR block or statement), or null when there is none */
  topLevelAt: number | null
  /** canonical address -> the name located there, anywhere in the file */
  located: Map<string, string>
}

/** PROGRAM and CONFIGURATION are not reserved (lexer.ts), so blocks are told apart by their words. */
const word = (t: Token | undefined): string => (t && (t.kind === 'kw' || t.kind === 'ident') ? t.value.toUpperCase() : '')
const isOp = (t: Token | undefined, v: string): boolean => t?.kind === 'op' && t.value === v
const POU_END: Record<string, string> = { PROGRAM: 'END_PROGRAM', FUNCTION_BLOCK: 'END_FUNCTION_BLOCK', FUNCTION: 'END_FUNCTION', TYPE: 'END_TYPE' }
const STORAGE = new Set(['RETAIN', 'NON_RETAIN', 'PERSISTENT'])

/** One `VAR ... END_VAR` from its opening keyword, or null when its declarations cannot be read. */
function readBlock(toks: readonly Token[], i: number): { block: VarBlock; next: number } | null {
  const open = toks[i]!
  let j = i + 1
  const words = [open.value]
  let constant = false
  for (;;) {
    const w = word(toks[j])
    if (w === 'CONSTANT') constant = true
    else if (!STORAGE.has(w)) break
    words.push(w)
    j++
  }
  const decls: DeclLine[] = []
  while (toks[j] && word(toks[j]) !== 'END_VAR') {
    const names: Token[] = []
    for (;;) {
      const t = toks[j]
      if (t?.kind !== 'ident') return null
      names.push(t)
      j++
      if (!isOp(toks[j], ',')) break
      j++
    }
    let at: Token | undefined
    if (word(toks[j]) === 'AT' && toks[j + 1]?.kind === 'addr') {
      at = toks[j + 1]
      j += 2
    }
    const colon = toks[j]
    if (!colon || !isOp(colon, ':')) return null
    j++
    const type = word(toks[j])
    let depth = 0
    while (!(depth === 0 && isOp(toks[j], ';'))) {
      const t = toks[j]
      if (!t || t.kind === 'eof' || word(t) === 'END_VAR') return null
      if (isOp(t, '(') || isOp(t, '[')) depth++
      else if (isOp(t, ')') || isOp(t, ']')) depth--
      j++
    }
    const semi = toks[j]!
    j++
    decls.push({ names, ...(at ? { at } : {}), colon, semi, type })
  }
  const close = toks[j]
  if (!close) return null
  let endOffset = close.pos.offset + close.value.length
  j++
  if (isOp(toks[j], ';')) {
    endOffset = toks[j]!.pos.offset + 1
    j++
  }
  return { block: { kind: open.value as VarBlock['kind'], header: words.join(' '), constant, open, close, endOffset, decls }, next: j }
}

/** The controller's own declarations: VAR, VAR_INPUT and VAR_OUTPUT blocks outside every POU, and VAR_GLOBAL blocks.
 *  Null when unreadable. */
function controllerDecls(source: string): ControllerDecls | null {
  let toks: Token[]
  try {
    toks = lex(source)
  } catch {
    return null
  }
  const blocks: VarBlock[] = []
  let hasProgram = false
  let topLevelAt: number | null = null
  let inConfiguration = false
  let i = 0
  while (i < toks.length && toks[i]!.kind !== 'eof') {
    const t = toks[i]!
    const w = word(t)
    const declares = toks[i + 1]?.kind === 'ident' // `PROGRAM Main`, not a variable called program
    if (w === 'VAR_GLOBAL' || ((w === 'VAR' || w === 'VAR_INPUT' || w === 'VAR_OUTPUT') && !inConfiguration)) {
      const read = readBlock(toks, i)
      if (!read) return null
      if (w !== 'VAR_GLOBAL') topLevelAt ??= t.pos.offset
      blocks.push(read.block)
      i = read.next
      continue
    }
    if (inConfiguration) {
      if (w === 'END_CONFIGURATION') inConfiguration = false
      i++
      continue
    }
    if (w === 'CONFIGURATION' && declares) {
      inConfiguration = true
      i++
      continue
    }
    const end = POU_END[w]
    if (end !== undefined && (t.kind === 'kw' || declares)) {
      if (w === 'PROGRAM') hasProgram = true
      while (i < toks.length && toks[i]!.kind !== 'eof' && word(toks[i]) !== end) i++
      i++
      if (isOp(toks[i], ';')) i++
      continue
    }
    topLevelAt ??= t.pos.offset
    // a statement: skip to its end, so a word inside it is not read as a block
    while (i < toks.length && toks[i]!.kind !== 'eof' && !isOp(toks[i], ';')) i++
    i++
  }
  const tags = new Map<string, ControllerTag>()
  for (const block of blocks) {
    for (const decl of block.decls) {
      for (const n of decl.names) if (!tags.has(identKey(n.value))) tags.set(identKey(n.value), { name: n.value, block, decl })
    }
  }
  return { blocks, tags, hasProgram, topLevelAt, located: locatedInTokens(toks) }
}

// ── Planning ───────────────────────────────────────────────────────────────────────────────────────

const HANDED_OUT: readonly IoSize[] = ['X', 'W', 'D']
/** Where the first point of each size goes: where OpenPLC's Editor maps a remote device, with room for 100 words below the double words. */
const FIRST_BIT = 0
const FIRST_REGISTER = 0
const FIRST_DOUBLE_REGISTER = 100
const UNREADABLE = "the program's declarations could not be read: fix the errors in the PLC panel first"

/** Who holds a point already, for a message about the clash. */
interface Holder {
  name: string
  from: 'program' | 'scene' | 'list'
  line?: number
}

/**
 * The points an area's addresses occupy, so that a word and the double word covering it are seen as one
 * conflict: %ID100 is the registers %IW200 and %IW201 (core/io/externalIo.ts), and two tags on one register
 * would carry two values in one place. For a register-image target a cell is one bit of the image, so a
 * bit and the word that holds it clash too.
 */
class PointSpace {
  readonly #held = new Map<string, Holder>()

  constructor(private readonly target: IoTarget) {}

  /** Every cell an address covers, or null when it does not travel to this target. */
  cells(address: string): string[] | null {
    if (this.target.kind === 'register-image') {
      const point = registerImagePointFor(address, this.target.base)
      if ('error' in point) return null
      const area = point.area === 'holdingRegister' ? 'I' : 'Q'
      const first = point.register * 16 + (point.bit ?? 0)
      const count = point.bit !== undefined ? 1 : point.words * 16
      return Array.from({ length: count }, (_, i) => `${area}:b:${first + i}`)
    }
    const point = modbusPointFor(address)
    if ('error' in point) return null
    const kind = isBitArea(point.area) ? 'bit' : 'reg'
    const area = point.area === 'discreteInput' || point.area === 'inputRegister' ? 'I' : 'Q'
    return Array.from({ length: point.words }, (_, i) => `${area}:${kind}:${point.address + i}`)
  }

  /** Who else is on any cell of `address`, or null when it is free (a cell held by `self` is not a clash). */
  clash(address: string, self?: string): Holder | null {
    for (const cell of this.cells(address) ?? []) {
      const held = this.#held.get(cell)
      if (held && (self === undefined || identKey(held.name) !== identKey(self))) return held
    }
    return null
  }

  take(address: string, holder: Holder): void {
    for (const cell of this.cells(address) ?? []) this.#held.set(cell, holder)
  }

  taken(kind: 'bit' | 'reg', area: 'I' | 'Q', index: number): boolean {
    return this.#held.has(`${area}:${kind}:${index}`)
  }
}

/** The type an undeclared tag is declared as, at an address of `size`, for parts that carry `stType`. */
function typeFor(size: IoSize, stType: IoTagUse['stType']): string {
  if (size === 'X') return 'BOOL'
  if (size === 'W') return 'INT'
  if (size === 'D') return stType === 'REAL' ? 'REAL' : 'DINT'
  return 'SINT'
}

interface NameUse {
  name: string
  uses: IoTagUse[]
}

function groupUses(uses: readonly IoTagUse[]): Map<string, NameUse> {
  const out = new Map<string, NameUse>()
  for (const u of uses) {
    const key = identKey(u.name)
    const entry = out.get(key)
    if (entry) entry.uses.push(u)
    else out.set(key, { name: u.name, uses: [u] })
  }
  return out
}

/** Why `name` cannot be located at all, whatever the address; null when it can. */
function unlocatable(name: string, tag: ControllerTag | undefined, uses: readonly IoTagUse[]): string | null {
  if (name.includes('.')) {
    return `${name} belongs to program ${name.slice(0, name.indexOf('.'))}, and a PROGRAM's inputs and outputs cannot sit at an address: only the top-level variables (declared outside every PROGRAM) can`
  }
  if (tag?.block.constant) return `${tag.name} is a constant, which cannot sit at an address`
  if (tag && !Object.values(TYPES_FOR_SIZE).some((types) => types.includes(tag.decl.type))) {
    return `${tag.name} is ${tag.decl.type || 'not a plain type'}, and only a single bit or number can sit at an address`
  }
  if (new Set(uses.map((u) => u.dir)).size > 1) {
    return `parts both publish and read ${name}, and a PLC point carries a value one way: wire the reading part to an output of its own`
  }
  return null
}

/** The first problem a part would have with `address`, or null. */
function partProblem(address: string, uses: readonly IoTagUse[]): string | null {
  for (const u of uses) {
    const why = addressProblem(address, u.dir, u.stType)
    if (why) return why
  }
  return null
}

/**
 * "Assign I/O": an address for every tag the scene's parts are wired to by name. `sceneAddresses` are the
 * addresses parts are already wired to, which are never handed out again.
 */
export function planIoAssignment(source: string, uses: readonly IoTagUse[], sceneAddresses: Iterable<string>, target: IoTarget = SERVER_TARGET): IoPlan {
  const decls = controllerDecls(source)
  const byName = groupUses(uses)
  if (!decls) return { assignments: [], skipped: [...byName.values()].map((n) => ({ name: n.name, reason: UNREADABLE })) }
  const space = new PointSpace(target)
  for (const [address, name] of decls.located) space.take(address, { name, from: 'program' })
  for (const a of sceneAddresses) {
    const address = canonicalAddress(a) ?? a
    if (!space.clash(address)) space.take(address, { name: address, from: 'scene' })
  }

  // the program's declaration order first, then the scene's
  const order: NameUse[] = []
  for (const [key, tag] of decls.tags) {
    const use = byName.get(key)
    if (use) order.push({ name: tag.name, uses: use.uses })
  }
  for (const [key, use] of byName) if (!decls.tags.has(key)) order.push(use)

  // one cursor per area and size, so a scene of many tags does not rescan the space for each
  const cursor = new Map<string, number>()
  // a register image: every size packed from the device's first register, at the first free place
  const allocatePacked = (area: 'I' | 'Q', size: IoSize, base: RegisterBase): string => {
    const slot = `${area}${size}`
    const firstWord = area === 'I' ? base.input : base.output
    // bits count in image bits, the others in image words; a double word starts on an even word (%IDn is %IW2n)
    const step = size === 'D' ? 2 : 1
    const start = size === 'X' ? firstWord * 16 : size === 'D' ? firstWord + (firstWord % 2) : firstWord
    for (let n = cursor.get(slot) ?? start; ; n += step) {
      const address = size === 'X' ? `%${area}X${n >> 3}.${n & 7}` : size === 'D' ? `%${area}D${n / 2}` : `%${area}W${n}`
      if (space.clash(address)) continue
      cursor.set(slot, n + step)
      return address
    }
  }
  const allocateSplit = (area: 'I' | 'Q', size: IoSize): string => {
    const slot = `${area}${size}`
    const start = size === 'X' ? FIRST_BIT : size === 'W' ? FIRST_REGISTER : FIRST_DOUBLE_REGISTER
    const step = size === 'D' ? 2 : 1 // a double word starts on an even register: %ID100 is registers 200-201
    for (let n = cursor.get(slot) ?? start; ; n += step) {
      if (size === 'X') {
        if (space.taken('bit', area, n)) continue
        cursor.set(slot, n + 1)
        return `%${area}X${Math.floor(n / 8)}.${n % 8}`
      }
      if (space.taken('reg', area, n) || (size === 'D' && space.taken('reg', area, n + 1))) continue
      cursor.set(slot, n + step)
      return size === 'D' ? `%${area}D${n / 2}` : `%${area}W${n}`
    }
  }

  const assignments: IoAssignment[] = []
  const skipped: IoSkip[] = []
  for (const { name, uses: its } of order) {
    const tag = decls.tags.get(identKey(name))
    const blocked = unlocatable(name, tag, its)
    if (blocked) {
      skipped.push({ name, reason: blocked })
      continue
    }
    if (tag?.decl.at) {
      // already at an address: the parts follow it
      const address = tag.decl.at.value
      const why = partProblem(address, its)
      if (why) skipped.push({ name, reason: `${name} is declared at ${address}, and ${why}` })
      else assignments.push({ name: tag.name, address, type: tag.decl.type })
      continue
    }
    let size: IoSize | undefined
    let type: string
    if (tag) {
      type = tag.decl.type
      size = HANDED_OUT.find((s) => TYPES_FOR_SIZE[s].includes(type))
      if (!size) {
        skipped.push({ name, reason: `${name} is ${type}, which does not travel to an external PLC: a bit (BOOL), a word (INT, UINT, WORD) or a double word (DINT, UDINT, DWORD, REAL) does` })
        continue
      }
    } else {
      const types = [...new Set(its.map((u) => u.stType).filter((t) => t !== undefined))]
      if (types.length !== 1) {
        skipped.push({
          name,
          reason:
            types.length === 0
              ? `no part wired to ${name} says what type it carries: declare ${name} in the PLC panel first`
              : `the parts wired to ${name} disagree on its type (${types.join(', ')})`,
        })
        continue
      }
      size = types[0] === 'BOOL' ? 'X' : types[0] === 'REAL' ? 'D' : 'W'
      type = typeFor(size, types[0])
    }
    const area = its[0]!.dir === 'out' ? 'I' : 'Q'
    const address = target.kind === 'register-image' ? allocatePacked(area, size, target.base) : allocateSplit(area, size)
    const why = partProblem(address, its)
    if (why) {
      skipped.push({ name, reason: why })
      continue
    }
    space.take(address, { name, from: 'program' })
    assignments.push({ name: tag?.name ?? name, address, type })
  }
  return { assignments, skipped }
}

/**
 * "Import I/O list": the addresses a list gives, checked against the program and the parts before any is
 * applied. A row that neither the scene nor the program uses is reported, not declared: a list for a whole
 * machine names points this scene does not model.
 */
export function planIoImport(source: string, uses: readonly IoTagUse[], rows: readonly IoListRow[], sceneAddresses: Iterable<string>, target: IoTarget = SERVER_TARGET): IoPlan {
  const decls = controllerDecls(source)
  const byName = groupUses(uses)
  if (!decls) return { assignments: [], skipped: rows.map((r) => ({ name: r.name, reason: UNREADABLE })) }
  const space = new PointSpace(target)
  for (const [address, name] of decls.located) space.take(address, { name, from: 'program' })
  for (const a of sceneAddresses) {
    const address = canonicalAddress(a) ?? a
    if (!space.clash(address)) space.take(address, { name: address, from: 'scene' })
  }
  const assignments: IoAssignment[] = []
  const skipped: IoSkip[] = []
  const lineOf = new Map<string, number>()
  for (const row of rows) {
    const refuse = (reason: string): void => {
      skipped.push({ name: row.name, reason: `line ${row.line}: ${reason}` })
    }
    const parsed = parseDirectAddress(row.address)
    if ('error' in parsed) {
      refuse(parsed.error)
      continue
    }
    const address = parsed.text
    // what can travel is the link's rule, asked rather than restated (core/io/externalIo.ts)
    const carried = target.kind === 'register-image' ? registerImagePointFor(address, target.base) : modbusPointFor(address)
    if ('error' in carried) {
      refuse(carried.error)
      continue
    }
    const key = identKey(row.name)
    const tag = decls.tags.get(key)
    const its = byName.get(key)?.uses ?? []
    const earlier = lineOf.get(key)
    // a clash on any register the address covers: %ID100 and %IW201 are the same place
    const held = space.clash(address, row.name)
    const heldBy =
      held === null
        ? null
        : held.from === 'list'
          ? `${address} is already given to ${held.name} on line ${held.line}`
          : held.from === 'scene'
            ? `a part is already wired to ${held.name} directly`
            : `the program already declares ${held.name} there`
    const why =
      earlier !== undefined
        ? `${row.name} is already given an address on line ${earlier}`
        : (heldBy ??
          (!tag && its.length === 0
            ? `neither the program nor any part in the scene uses ${row.name}`
            : (unlocatable(row.name, tag, its) ??
              (tag && !TYPES_FOR_SIZE[parsed.size].includes(tag.decl.type)
                ? `${tag.name} is ${tag.decl.type}, which does not fit the ${sizeWord(parsed.size)} address ${address}`
                : partProblem(address, its)))))
    if (why) {
      refuse(why)
      continue
    }
    lineOf.set(key, row.line)
    space.take(address, { name: tag?.name ?? row.name, from: 'list', line: row.line })
    assignments.push({ name: tag?.name ?? row.name, address, type: tag?.decl.type ?? typeFor(parsed.size, its.find((u) => u.stType)?.stType) })
  }
  return { assignments, skipped }
}

// ── Rewriting the program ──────────────────────────────────────────────────────────────────────────

interface TextEdit {
  from: number
  to: number
  text: string
}

const lineStart = (s: string, at: number): number => s.lastIndexOf('\n', at - 1) + 1
const indentAt = (s: string, at: number): string => /^[ \t]*/.exec(s.slice(lineStart(s, at)))![0]

/** Just past the newline that ends `at`'s line. */
function lineEnd(s: string, at: number): number {
  const nl = s.indexOf('\n', at)
  return nl === -1 ? s.length : nl + 1
}

/**
 * What follows a declaration on its line: '' when nothing, the comment when only a comment (`(* ... *)` or
 * `// ...`), null when more code.
 */
function lineRest(source: string, after: number): string | null {
  const nl = source.indexOf('\n', after)
  const rest = source.slice(after, nl === -1 ? source.length : nl).trim()
  if (rest === '') return ''
  if (rest.startsWith('//') || (rest.startsWith('(*') && rest.indexOf('*)') === rest.length - 2)) return rest
  return null
}

/**
 * The program with each assignment's tag declared at its address. Assignments come from a plan
 * ({@link planIoAssignment}, {@link planIoImport}), which has already refused what cannot be located.
 */
export function locateTags(source: string, assignments: readonly IoAssignment[]): string {
  const decls = controllerDecls(source)
  if (!decls || assignments.length === 0) return source
  const byName = new Map(assignments.map((a) => [identKey(a.name), a]))
  const moving = (n: Token): IoAssignment | undefined => byName.get(identKey(n.value))
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const edits: TextEdit[] = []
  const locatedLine = (n: Token, d: DeclLine): string => `${n.value} AT ${moving(n)!.address} ${source.slice(d.colon.pos.offset, d.semi.pos.offset + 1)}`
  const innerIndent = (b: VarBlock): string => (b.decls[0] ? indentAt(source, b.decls[0].names[0]!.pos.offset) : `${indentAt(source, b.open.pos.offset)}  `)

  // whether a block holds only located declarations once this edit is done
  const allLocated = (b: VarBlock): boolean =>
    (b.kind === 'VAR' || b.kind === 'VAR_GLOBAL') && !b.constant && b.decls.length > 0 && b.decls.every((d) => d.at || d.names.every((n) => moving(n)))
  // a top-level input or output can take no address where it is: its located line joins the fresh ones below
  const leftIo: string[] = []

  // lines gathered for the end of a block that stays all located, or for a new block after a mixed one
  const appended = new Map<VarBlock, string[]>()
  const created = new Map<VarBlock, string[]>()
  const appendTo = (b: VarBlock, lines: string[]): void => {
    appended.set(b, [...(appended.get(b) ?? []), ...lines])
  }

  decls.blocks.forEach((block, index) => {
    if (block.constant || block.decls.every((d) => d.names.every((n) => !moving(n)))) return
    if (allLocated(block)) {
      // edit each declaration in place
      for (const d of block.decls) {
        const first = d.names[0]!
        const a = moving(first)
        if (!a) continue
        if (d.at) {
          if (d.at.value !== a.address) edits.push({ from: d.at.pos.offset, to: d.at.pos.offset + (d.at.raw ?? d.at.value).length, text: a.address })
        } else if (d.names.length === 1) {
          const end = first.pos.offset + first.value.length
          edits.push({ from: end, to: end, text: ` AT ${a.address}` })
        } else {
          const indent = indentAt(source, first.pos.offset)
          edits.push({ from: first.pos.offset, to: d.semi.pos.offset + 1, text: d.names.map((n) => locatedLine(n, d)).join(`${eol}${indent}`) })
        }
      }
      return
    }

    // ordinary variables stay: the located ones leave, for the located block right after this one, or a new one
    const io = block.kind === 'VAR_INPUT' || block.kind === 'VAR_OUTPUT'
    // an input or output block every tag leaves goes as a whole, rather than stay behind empty
    const emptied = io && block.decls.every((d) => d.names.every((n) => moving(n)))
    if (emptied) {
      const start = block.open.pos.offset
      const whole = source.slice(lineStart(source, start), start).trim() === '' && lineRest(source, block.endOffset) === ''
      edits.push(whole ? { from: lineStart(source, start), to: lineEnd(source, block.endOffset), text: '' } : { from: start, to: block.endOffset, text: '' })
    }
    const lines: string[] = []
    for (const d of block.decls) {
      const names = d.names.filter((n) => moving(n))
      if (names.length === 0) continue
      const kept = d.names.filter((n) => !moving(n))
      if (kept.length > 0) {
        // `A, B, C : BOOL` keeping B: the name list is rewritten, the type and the spacing before it kept
        lines.push(...names.map((n) => locatedLine(n, d)))
        const last = d.names[d.names.length - 1]!
        const gap = source.slice(last.pos.offset + last.value.length, d.colon.pos.offset)
        edits.push({ from: d.names[0]!.pos.offset, to: d.colon.pos.offset, text: `${kept.map((n) => n.value).join(', ')}${gap}` })
        continue
      }
      const start = d.names[0]!.pos.offset
      const end = d.semi.pos.offset + 1
      const rest = lineRest(source, end)
      const moved = names.map((n) => locatedLine(n, d))
      if (rest) moved[moved.length - 1] += ` ${rest}`
      lines.push(...moved)
      if (emptied) continue
      const alone = source.slice(lineStart(source, start), start).trim() === ''
      if (alone && rest !== null) edits.push({ from: lineStart(source, start), to: lineEnd(source, end), text: '' })
      else edits.push({ from: start, to: rest ? source.indexOf(rest, end) + rest.length : end, text: '' })
    }
    if (io) {
      leftIo.push(...lines)
      return
    }
    const next = decls.blocks[index + 1]
    const adjacent = next && next.kind === block.kind && next.header === block.header && source.slice(block.endOffset, next.open.pos.offset).trim() === ''
    if (next && adjacent && allLocated(next)) appendTo(next, lines)
    else created.set(block, lines)
  })

  // tags the program does not declare yet, and those leaving an input or output block, join the controller's located
  // block, or start one
  const fresh = assignments.filter((a) => !decls.tags.has(identKey(a.name)))
  if (fresh.length > 0 || leftIo.length > 0) {
    const kind = decls.hasProgram ? 'VAR_GLOBAL' : 'VAR'
    const lines = [...leftIo, ...fresh.map((a) => `${a.name} AT ${a.address} : ${a.type};`)]
    const home = decls.blocks.find((b) => b.kind === kind && b.header === kind && allLocated(b))
    const newHome = home ? undefined : [...created.keys()].find((b) => b.header === kind)
    if (home) appendTo(home, lines)
    else if (newHome) created.get(newHome)!.push(...lines)
    else {
      const text = `${kind}${eol}${lines.map((l) => `  ${l}`).join(eol)}${eol}END_VAR${eol}`
      const at = decls.hasProgram ? 0 : decls.topLevelAt !== null ? lineStart(source, decls.topLevelAt) : null
      if (at !== null) edits.push({ from: at, to: at, text: decls.hasProgram ? `${text}${eol}` : text })
      else {
        // nothing outside a POU yet (or nothing at all): the block goes at the end
        const end = source.trimEnd().length
        edits.push({ from: end, to: source.length, text: `${end === 0 ? '' : `${eol}${eol}`}${text}` })
      }
    }
  }

  for (const [block, lines] of appended) {
    const at = lineStart(source, block.close.pos.offset)
    const indent = innerIndent(block)
    edits.push({ from: at, to: at, text: lines.map((l) => `${indent}${l}${eol}`).join('') })
  }
  for (const [block, lines] of created) {
    const outer = indentAt(source, block.open.pos.offset)
    const indent = innerIndent(block)
    edits.push({
      from: block.endOffset,
      to: block.endOffset,
      text: `${eol}${outer}${block.header}${eol}${lines.map((l) => `${indent}${l}${eol}`).join('')}${outer}END_VAR`,
    })
  }

  // later edits first, so earlier offsets stay true. At one offset a deletion goes before an insertion, or the
  // deletion would cut the inserted text (an emptied input block that opens the program shares its line with the
  // new located block); two insertions keep the order they were made in
  const ordered = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.from - a.e.from || b.e.to - a.e.to || b.i - a.i)
  let out = source
  for (const { e } of ordered) out = out.slice(0, e.from) + e.text + out.slice(e.to)
  return out
}

// ── I/O lists ──────────────────────────────────────────────────────────────────────────────────────

/** One CSV line's cells, split on `sep`, honouring double quotes. */
function cells(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === sep) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  out.push(cur.trim())
  return out
}

const TAG_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/

/**
 * An I/O list as rows: CSV (comma, semicolon or tab separated) with a tag name and an IEC address on each
 * row, in either order and beside any other columns. A first row without an address is its header; any
 * other row without one, or without a name beside it, is reported by line.
 */
export function parseIoList(text: string): { rows: IoListRow[]; problems: string[] } {
  // a byte-order mark leads the CSV every spreadsheet exports; it is not part of the first cell
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)
  const sample = lines.filter((l) => l.trim() !== '').slice(0, 20)
  const sep = sample.some((l) => l.includes('\t')) ? '\t' : sample.some((l) => l.includes(';')) && !sample.some((l) => l.includes(',')) ? ';' : ','
  const rows: IoListRow[] = []
  const problems: string[] = []
  let header = true
  lines.forEach((raw, i) => {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return
    const row = cells(raw, sep)
    const first = header
    header = false
    const address = row.find((c) => c.startsWith('%'))
    if (address === undefined) {
      if (!first) problems.push(`line ${i + 1}: no IEC address (like %IX100.0) on this row`)
      return
    }
    const name = row.find((c) => c !== address && TAG_NAME.test(c))
    if (name === undefined) problems.push(`line ${i + 1}: no tag name beside ${address}`)
    else rows.push({ name, address, line: i + 1 })
  })
  return { rows, problems }
}
