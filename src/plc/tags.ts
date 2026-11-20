// Tags as a tag editor makes them: a name, a data type, a scope - and, because this engine binds a
// scene by direction, whether the tag is an input from the parts, an output to them, or internal.
//
// A tag is a declaration in the program text (document.ts: one string is the truth), so "new tag"
// is a text edit: `name : type;` written into the right VAR block of the right POU. Controller scope
// is the code outside every POU - its variables are the controller's own tags, seen by every PROGRAM
// beside a CONFIGURATION (program.ts `controllerTags`) and the implicit program's own without one.

import { KEYWORDS, lex } from './lexer'
import { parseStructure, type ProgramStructure } from './structure'
import { findInCode, skipText } from '../core/sourceText'
import { tokenAt } from './sourceFacts'
import { identKey } from './program'
import { SCALAR_TYPES, USER_FB_TYPES, isStruct, isUserFb } from './types'
import type { Ast, DataType, Decl, FbDef, MethodDef, Token, VarSection } from './types'
import type { Controller } from '../core/controller'
import type { TagRename } from './controllerEdits'

export type TagScope = { kind: 'controller' } | { kind: 'pou'; name: string }

export interface TagScopeOption {
  scope: TagScope
  /** what to show: `Controller`, or the POU's name */
  label: string
  kind: 'controller' | 'program' | 'functionBlock' | 'function'
}

export interface NewTag {
  name: string
  /** the type as it will be written: `BOOL`, `DINT`, `TON`, `STRING[20]`, a user type's name... */
  type: string
  section: VarSection
  /** written as a comment after the declaration; blank for none */
  description?: string
}

function ast(source: string): { ast: Ast; toks: readonly Token[] } | null {
  // (both shared with every other reader of this text - structure.ts, and the lexer's own memo)
  const tree = parseStructure(source).ast
  return tree ? { ast: tree, toks: lex(source) } : null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One declared tag, as an organizer lists it. */
export interface TagRow {
  name: string
  /** the type as written, e.g. `BOOL`, `DINT`, `TON`, `STRING[20]`, `ARRAY [1..4] OF INT` */
  type: string
  section: VarSection
  scope: TagScope
  description: string
  /** the starting value as written after `:=`, or '' */
  init: string
  /** declared in a CONSTANT block */
  constant: boolean
  /** its direct address (`%IX100.0`) when it is located */
  location?: string
  /** where the declaration line begins, for revealing it in the text */
  offset: number
}

function typeText(source: string, d: Decl): string {
  // the declaration's own spelling of its type: from the `:` after the name to the `;` or `:=` - in code only
  // (sourceText.ts), so a comment between them cannot end it early or carry its words into the type
  const from = findInCode(source, d.pos.offset + d.name.length, (i) => source[i] === ':')
  if (from < 0) return typeof d.type === 'string' ? d.type : '?'
  const end = findInCode(source, from + 1, (i) => source[i] === ';' || (source[i] === ':' && source[i + 1] === '='), { depth0: true })
  if (end < 0) return typeof d.type === 'string' ? d.type : '?'
  return stripText(source.slice(from + 1, end)).trim()
}

/** `text` with its comments and pragmas taken out (a type spelled `DINT (* counts *)` is `DINT`). */
function stripText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const past = skipText(text, i)
    if (past === i) out += text[i]
    else {
      // a string literal is part of what was written; a comment or a pragma is not
      if (text[i] === "'") out += text.slice(i, past)
      i = past - 1
    }
  }
  return out.replace(/\s+/g, ' ')
}

/**
 * The `;` that ends the declaration starting at `from`, or -1: brackets nest, and strings, comments and pragmas are
 * text (sourceText.ts). The `;` in `Msg : STRING[20] := 'a;b';` ends nothing, and neither does the apostrophe in
 * `(* the operator's count *)` open a string: skipping strings only would run an apostrophe's "string" on into the
 * next declaration, so the tag list shows that tag's type and description, and an edit deletes the span between.
 */
function declEnd(source: string, from: number): number {
  return findInCode(source, from, (i) => source[i] === ';', { depth0: true })
}

function descriptionOf(source: string, d: Decl): string {
  const end = declEnd(source, d.pos.offset)
  if (end < 0) return ''
  const rest = source.slice(end + 1, source.indexOf('\n', end + 1) < 0 ? undefined : source.indexOf('\n', end + 1))
  const m = /^\s*(?:\(\*\s*(.*?)\s*\*\)|\/\/\s*(.*))/.exec(rest)
  return (m?.[1] ?? m?.[2] ?? '').trim()
}

/** The tag list of each parse in play (structure.ts keeps the parses, so this lives exactly as long as they do). */
const listed = new WeakMap<ProgramStructure, readonly TagRow[]>()

/**
 * Every tag the program declares, controller scope first, then each POU's, in source order.
 *
 * Worked out once per text and shared, like the parse it comes from: one ladder gesture asks for the list several
 * times over (a tag's menu, its hover tip, the members a dot offers), and an organizer, a tag editor and the sheet
 * ask for it again of the same text. Read it; never write to it.
 */
export function listTags(source: string): readonly TagRow[] {
  const structure = parseStructure(source)
  const kept = listed.get(structure)
  if (kept) return kept
  const rows = Object.freeze(tagRows(source, structure))
  listed.set(structure, rows)
  return rows
}

function tagRows(source: string, structure: ProgramStructure): TagRow[] {
  const a = structure.ast
  if (!a) return []
  const toks = lex(source)
  const rows: TagRow[] = []
  // (what the ladder lowering declares for itself - a pinned rung condition, a first-scan flag, a loop index - is the
  // engine's, not the program's: nobody declared it, and it is listed nowhere. The lowering marks such a
  // declaration `hidden`)
  const add = (decls: Decl[], scope: TagScope): void => {
    for (const d of decls) {
      if (d.section === 'VAR_EXTERNAL' || d.hidden) continue
      rows.push({
        name: d.name,
        type: typeText(source, d),
        section: d.section,
        scope,
        description: descriptionOf(source, d),
        // the value, without the operator: `declarationSpan`'s `init` is a fragment to re-emit after a type
        // (`INT := 5`), which is not what a pane's Initial column shows
        init: (declarationSpan(source, toks, d.pos.offset, d.name)?.init ?? '').replace(/^:=\s*/, ''),
        constant: d.constant === true,
        ...(d.location ? { location: d.location } : {}),
        offset: d.pos.offset,
      })
    }
  }
  add([...a.globals, ...a.decls].sort((x, y) => x.pos.offset - y.pos.offset), { kind: 'controller' })
  for (const p of [...a.programDefs, ...a.fbDefs, ...a.funcDefs].sort((x, y) => x.pos.offset - y.pos.offset)) add(p.decls, { kind: 'pou', name: p.name })
  return rows
}

/**
 * What a declaration pane over each ladder section needs, from one parse: the POU the section stands in, what kind of
 * POU that is (which decides the sections it may declare) and its declarations.
 *
 * The ladder view draws this as a Variables pane over the section (a POU's declaration part, shown above its rungs);
 * a tag list reaches the same declarations as tags. One reader, because they are one thing.
 */
export function sectionDeclarations(source: string): { pou: string; kind: 'top' | 'program' | 'block'; rows: TagRow[] }[] {
  const parsed = ast(source)
  if (!parsed) return [] // half-written: a pane over it shows nothing rather than something wrong
  const a = parsed.ast
  const all = listTags(source)
  return a.ladder.map((s) => ({
    pou: s.pou,
    kind: s.pou === '' ? 'top' : a.programDefs.some((d) => identKey(d.name) === identKey(s.pou)) ? 'program' : 'block',
    rows: all.filter((r) => (s.pou === '' ? r.scope.kind === 'controller' : r.scope.kind === 'pou' && identKey(r.scope.name) === identKey(s.pou))),
  }))
}

/** The scope a POU's name stands for ('' is the code outside every POU, whose variables are the controller's tags). */
export const scopeOfPou = (pou: string): TagScope => (pou === '' ? { kind: 'controller' } : { kind: 'pou', name: pou })

/** What a tag is edited to: every field the tag dialog holds. */
export interface TagEdit {
  name: string
  type: string
  section: VarSection
  description: string
}

/**
 * `source` with tag `name` of `scope` changed to `next` - the tag dialog's Save on an existing tag.
 *
 * in place wherever it can be: a declaration on a line of its own keeps its position, its starting value
 * (`:= 3`) and everything around it, and only its type and its comment are rewritten. One that cannot be
 * edited where it stands - a name out of `a, b, c : INT`, or a change of usage, which is another VAR block -
 * is deleted and declared again with the same starting value. A new name follows last, wherever it means this tag
 * (`renameTag`), or the edit is refused with its reason.
 */
export function editTag(source: string, scope: TagScope, name: string, next: TagEdit): TagRenameEdit {
  const row = listTags(source).find((r) => identKey(r.name) === identKey(name) && sameScope(r.scope, scope))
  if (!row) return { source, error: null }
  const to = { name: next.name.trim(), type: next.type.trim(), section: next.section, description: next.description.trim() }
  let out = source
  if (to.type !== row.type || to.section !== row.section || to.description !== row.description) {
    const span = declarationSpan(source, lex(source), row.offset, row.name)
    if (span && !span.shared && to.section === row.section) {
      // type, then the comment after the `;` (later first, so the earlier offsets still hold)
      const note = to.description === '' ? '' : ` (* ${to.description.replace(/\*\)/g, '* )')} *)`
      out = out.slice(0, span.commentStart) + note + out.slice(span.commentEnd)
      out = out.slice(0, span.typeStart) + ` ${to.type}${span.init === '' ? '' : ' '}` + out.slice(span.typeEnd)
    } else {
      const init = span?.init ?? ''
      out = deleteTag(out, scope, row.name)
      out = declareTagIn(out, scope, { name: row.name, type: init === '' || span?.shared ? to.type : `${to.type} ${init}`, section: to.section, description: to.description })
    }
  }
  if (to.name !== row.name) {
    const renamed = renameTag(out, scope, row.name, to.name)
    if (renamed.error !== null) return renamed
    out = renamed.source
  }
  return { source: out, error: null }
}

const sameScope = (a: TagScope, b: TagScope): boolean => (a.kind === 'controller' ? b.kind === 'controller' : b.kind === 'pou' && identKey(a.name) === identKey(b.name))

/** Where the parts of the declaration starting at `offset` stand in the text. `shared` when the name is one of a list. */
function declarationSpan(source: string, toks: readonly Token[], offset: number, name: string): { typeStart: number; typeEnd: number; init: string; commentStart: number; commentEnd: number; shared: boolean } | null {
  const after = offset + name.length
  // everything here reads code only (sourceText.ts): a comma, colon or `;` inside a comment or a string is not one
  const colon = findInCode(source, after, (i) => source[i] === ':' || source[i] === ';')
  if (colon < 0 || source[colon] !== ':') return null
  // a name later in the same list: a comma between this name and the colon
  let shared = findInCode(source, after, (i) => source[i] === ',', { to: colon }) >= 0
  // a name earlier in the same list: is the token before this name a comma? The lexer's token, not a character found
  // scanning back: across newlines - a list may be wrapped (`Speed,\n  Accel : REAL;`, where stopping at the newline
  // would let an edit to Accel retype Speed too) - and never a comma in a comment (`Speed : REAL; // m/s,` on the
  // line above would make Accel look shared, and the delete-and-redeclare that follows would drop Accel's initialiser).
  // A token, too, because finding the last code character by scanning forward from the top of the text would make
  // listing the tags quadratic (1000 declarations: a quarter of a second, on every hover and keystroke of type-ahead).
  const at = tokenAt(toks, offset)
  if (at < 0) return null // (the parse and the text disagree about where this name is: nothing here can be trusted)
  if (at > 0 && toks[at - 1]!.kind === 'op' && toks[at - 1]!.value === ',') shared = true
  const semi = declEnd(source, colon + 1)
  if (semi < 0) return null
  const assign = findInCode(source, colon + 1, (i) => source[i] === ':' && source[i + 1] === '=', { depth0: true, to: semi })
  const typeEnd = assign >= 0 ? assign : semi
  const eol = source.indexOf('\n', semi)
  const rest = source.slice(semi + 1, eol < 0 ? undefined : eol)
  const comment = /^[ \t]*(?:\(\*.*?\*\)|\/\/.*)/.exec(rest)
  return { typeStart: colon + 1, typeEnd, init: source.slice(typeEnd, semi).trim(), commentStart: semi + 1, commentEnd: semi + 1 + (comment ? comment[0].length : 0), shared }
}

/**
 * `source` without the declaration of `name` in `scope`. A `a, b, c : INT;` line loses one name; a line of
 * its own goes with its comment; a block left empty goes too. References stay - the compiler then says
 * where the tag was still used, which is the right thing to hear before deleting more.
 */
export function deleteTag(source: string, scope: TagScope, name: string): string {
  const parsed = ast(source)
  if (!parsed) return source
  const a = parsed.ast
  const decls =
    scope.kind === 'controller'
      ? [...a.globals, ...a.decls]
      : ([...a.programDefs, ...a.fbDefs, ...a.funcDefs].find((p) => identKey(p.name) === identKey(scope.name))?.decls ?? [])
  const d = decls.find((x) => identKey(x.name) === identKey(name))
  if (!d) return source
  const toks = parsed.toks
  const at = tokenAt(toks, d.pos.offset)
  if (at < 0) return source
  // the declaration line: back to the block keyword or the previous `;`, forward through its `;`
  let lo = at
  while (lo > 0 && !(toks[lo - 1]!.kind === 'kw' && /^VAR|^CONSTANT$|^RETAIN$/.test(toks[lo - 1]!.value)) && !(toks[lo - 1]!.kind === 'op' && toks[lo - 1]!.value === ';')) lo--
  let hi = at
  while (hi < toks.length && !(toks[hi]!.kind === 'op' && toks[hi]!.value === ';')) hi++
  // no `;` after it: a parse that recovered past a broken declaration. There is no line to cut, and reading
  // `toks[hi]` below would throw out of the declaration pane
  if (hi >= toks.length) return source
  const names: number[] = []
  for (let i = lo; i < hi; i++) {
    if (toks[i]!.kind === 'op' && toks[i]!.value === ':') break
    if (toks[i]!.kind === 'ident') names.push(i)
  }
  if (names.length > 1) {
    // one name of several: `a, b, c : INT` -> `a, c : INT`
    const k = names.find((i) => toks[i]!.pos.offset === d.pos.offset)!
    const isLast = k === names[names.length - 1]
    const start = isLast ? toks[names[names.length - 2]!]!.pos.offset + toks[names[names.length - 2]!]!.value.length : toks[k]!.pos.offset
    const end = isLast ? toks[k]!.pos.offset + toks[k]!.value.length : toks[names[names.indexOf(k) + 1]!]!.pos.offset
    return source.slice(0, start) + source.slice(end)
  }
  const lineStart = source.lastIndexOf('\n', toks[lo]!.pos.offset) + 1
  // A declaration on a line of its own takes the line (and a comment after it); one sharing its line takes only
  // itself. Otherwise `VAR X : INT; END_VAR` loses its `VAR` with the X (the cut runs from the start of the line),
  // and the block left behind is a stray END_VAR the program cannot compile past.
  const leadIsBlank = /^\s*$/.test(source.slice(lineStart, toks[lo]!.pos.offset))
  let end = toks[hi]!.pos.offset + 1
  const eol = source.indexOf('\n', end)
  const tail = source.slice(end, eol < 0 ? undefined : eol)
  if (leadIsBlank && /^\s*(\(\*.*\*\)|\/\/.*)?\s*$/.test(tail)) end = eol < 0 ? source.length : eol + 1
  const from = leadIsBlank ? lineStart : toks[lo]!.pos.offset
  let out = source.slice(0, from) + source.slice(end)
  // a block with nothing left in it, laid out on lines or on one
  out = out.replace(/(^|\n)[ \t]*VAR(?:_INPUT|_OUTPUT|_GLOBAL|_TEMP|_IN_OUT)?(?:\s+(?:CONSTANT|RETAIN|NON_RETAIN))?\s*END_VAR[ \t]*;?[ \t]*(\n|$)/g, '$1')
  return out
}

/** A tag rename as the program's text takes it: the text with the rename in it, or why it cannot be done. */
export type TagRenameEdit = { source: string; error: null } | { source: null; error: string }

/** What one top-level stretch of the text is: a POU (by name), a TYPE block, or a CONFIGURATION. */
interface TextSpan {
  kind: 'pou' | 'type' | 'configuration'
  name: string
  start: number
  end: number
}

/** The POUs, TYPE blocks and CONFIGURATIONs of a token stream, by where they start and end. They do not nest. */
function topLevelSpans(toks: readonly Token[]): TextSpan[] {
  const out: TextSpan[] = []
  const word = (t: Token | undefined): string => (t && (t.kind === 'kw' || t.kind === 'ident') ? t.value.toUpperCase() : '')
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    const w = word(t)
    // PROGRAM and CONFIGURATION are not keywords (a variable may be called `program`): a POU is the word and a name
    const named = toks[i + 1]?.kind === 'ident'
    const end =
      t.kind === 'kw' && w === 'FUNCTION_BLOCK' ? 'END_FUNCTION_BLOCK'
      : t.kind === 'kw' && w === 'FUNCTION' ? 'END_FUNCTION'
      : t.kind === 'kw' && w === 'TYPE' ? 'END_TYPE'
      : t.kind === 'ident' && w === 'PROGRAM' && named ? 'END_PROGRAM'
      : t.kind === 'ident' && w === 'CONFIGURATION' && named ? 'END_CONFIGURATION'
      : null
    if (end === null) continue
    let j = i + 1
    while (j < toks.length && word(toks[j]) !== end) j++
    const last = toks[j]
    out.push({
      kind: w === 'TYPE' ? 'type' : w === 'CONFIGURATION' ? 'configuration' : 'pou',
      name: w === 'TYPE' ? '' : (toks[i + 1]?.value ?? ''),
      start: t.pos.offset,
      end: last ? last.pos.offset + last.value.length : Infinity,
    })
    i = j
  }
  return out
}

/** The declaration of key `k` that `decls` makes itself. A VAR_EXTERNAL is not one: it names the controller's tag. */
function ownDecl(decls: readonly Decl[], k: string): Decl | undefined {
  return decls.find((d) => identKey(d.name) === k && d.section !== 'VAR_EXTERNAL')
}

/** Is token `i` a use of the variable it spells? Not when it names a member (`Zone.Count`), or a formal parameter or a
 *  field being given a value (`T(Count := n)`, `(Count := 3)`): those name something of the callee's or the type's. */
function spellsVariable(toks: readonly Token[], i: number): boolean {
  const prev = toks[i - 1]
  const next = toks[i + 1]
  if (prev?.kind === 'op' && prev.value === '.') return false
  const given = next?.kind === 'op' && (next.value === ':=' || next.value === '=>')
  return !(given && prev?.kind === 'op' && (prev.value === '(' || prev.value === ','))
}

/**
 * `source` with tag `from` of `scope` renamed `to`: every spelling that means that tag, and nothing else.
 *
 * Where it is seen: a POU's tag inside that POU alone; a controller tag in the code outside every POU and in every POU
 * that does not declare a `from` of its own (a local of that name hides the controller's there; a VAR_EXTERNAL does
 * not, it is the controller's). What is not the tag even where it is spelled so: a member, a formal parameter or a
 * field given a value (`spellsVariable`), a TYPE's own declarations, and a CONFIGURATION's task and program lines.
 *
 * Refused, with the reason: a function block's or a function's parameter, because every call names it too (as a member
 * and as a formal argument) and following those takes the type of every instance; and a rename that would hand some
 * POU's uses of one tag to another (a controller tag renamed to a name that POU declares locally, or a POU's tag renamed
 * to the name of a controller tag the POU uses).
 */
export function renameTag(source: string, scope: TagScope, from: string, to: string): TagRenameEdit {
  const parsed = ast(source)
  if (!parsed) return { source: null, error: 'The program does not compile as far as its declarations, so a rename cannot tell this tag from other names yet. Fix that first.' }
  const { ast: a, toks } = parsed
  const key = identKey(from)
  const toKey = identKey(to)
  const pous = [...a.programDefs.map((d) => ({ d, kind: 'program' as const })), ...a.fbDefs.map((d) => ({ d, kind: 'functionBlock' as const })), ...a.funcDefs.map((d) => ({ d, kind: 'function' as const }))]
  const spans = topLevelSpans(toks)
  const spanOf = (name: string): TextSpan | undefined => spans.find((s) => s.kind === 'pou' && identKey(s.name) === identKey(name))
  const within = (s: TextSpan, offset: number): boolean => offset >= s.start && offset < s.end
  // the offsets of a CONFIGURATION's VAR blocks: its globals are the controller's tags; the rest of it is tasks and
  // program lines, which name tasks and instances
  const configVars: Array<[number, number]> = []
  for (const s of spans.filter((x) => x.kind === 'configuration')) {
    let open = -1
    for (const t of toks) {
      if (t.pos.offset < s.start || t.pos.offset >= s.end || t.kind !== 'kw') continue
      if (/^VAR(_|$)/.test(t.value)) open = t.pos.offset
      else if (t.value === 'END_VAR' && open >= 0) {
        configVars.push([open, t.pos.offset])
        open = -1
      }
    }
  }
  const usesIn = (sees: (offset: number) => boolean, k: string): boolean =>
    toks.some((t, i) => t.kind === 'ident' && identKey(t.value) === k && sees(t.pos.offset) && spellsVariable(toks, i))

  let sees: (offset: number) => boolean
  if (scope.kind === 'pou') {
    const pou = pous.find((p) => identKey(p.d.name) === identKey(scope.name))
    const span = spanOf(scope.name)
    const decl = pou && ownDecl(pou.d.decls, key)
    if (!pou || !span || !decl) return { source: null, error: `"${from}" is not a tag of ${scope.name}.` }
    if (pou.kind !== 'program' && (decl.section === 'VAR_INPUT' || decl.section === 'VAR_OUTPUT' || decl.section === 'VAR_IN_OUT')) {
      return { source: null, error: `"${from}" is a parameter of ${pou.d.name}, and every call of ${pou.d.name} names it too. Renaming it here would leave those calls naming a parameter that is gone.` }
    }
    sees = (offset) => within(span, offset)
    if (!ownDecl(pou.d.decls, toKey) && usesIn(sees, toKey)) {
      return { source: null, error: `${pou.d.name} already uses the top-level variable "${to}": renamed, "${from}" would take those uses over. Pick another name.` }
    }
  } else {
    if (!ownDecl([...a.globals, ...a.decls], key)) return { source: null, error: `"${from}" is not a top-level variable.` }
    const hidden = new Set(pous.filter((p) => ownDecl(p.d.decls, key)).map((p) => identKey(p.d.name)))
    sees = (offset) => {
      const at = spans.find((s) => within(s, offset))
      if (!at) return true
      if (at.kind === 'type') return false
      if (at.kind === 'configuration') return configVars.some(([s, e]) => offset > s && offset < e)
      return !hidden.has(identKey(at.name))
    }
    const taker = pous.find((p) => !hidden.has(identKey(p.d.name)) && ownDecl(p.d.decls, toKey) && spanOf(p.d.name) && usesIn((o) => within(spanOf(p.d.name)!, o), key))
    if (taker) {
      return { source: null, error: `${taker.d.name} declares a "${to}" of its own and uses the controller's "${from}": renamed, those uses would become uses of its local. Pick another name.` }
    }
  }
  let out = source
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i]!
    if (t.kind !== 'ident' || identKey(t.value) !== key || !sees(t.pos.offset) || !spellsVariable(toks, i)) continue
    out = out.slice(0, t.pos.offset) + to + out.slice(t.pos.offset + t.value.length)
  }
  return { source: out, error: null }
}

/** What a name resolved to: where its declaration's name is written, and what its members are looked up in. */
interface Definition {
  at: number
  /** a variable's or a field's type: its members are the block's or the struct's */
  type?: DataType
  /** a FUNCTION's or a METHOD's declarations: a formal argument of a call to it names one of these */
  decls?: readonly Decl[]
}

/**
 * Where the name at `offset` is declared: the offset of the declaration's name, or null when `offset` is on no name the
 * program declares (a keyword, a standard block, a library block's member, a half-written program).
 *
 * A name resolves the way the engine resolves it, innermost first: a METHOD's variables, its POU's, what a function
 * block inherits, the controller's (which is where a VAR_EXTERNAL points), then the program's POUs and types. A member
 * (`Zone.Count`) and a formal argument (`T(PT := ...)`) are looked up in the instance's or the callee's declarations.
 * Library blocks merged in from the motion prelude have no text in `source`, so nothing resolves into them.
 */
export function definitionAt(source: string, offset: number): number | null {
  const parsed = ast(source)
  if (!parsed) return null
  const { ast: a, toks } = parsed
  // the name token the offset is in or just after (a caret at a word's end is on that word)
  let lo = 0
  let hi = toks.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (toks[mid]!.pos.offset <= offset) lo = mid + 1
    else hi = mid
  }
  let at = lo - 1
  const onName = (t: Token | undefined): boolean => t?.kind === 'ident' && offset <= t.pos.offset + t.value.length
  // a token starting right at the caret (`;` after a name) loses to the name the caret ends
  if (!onName(toks[at]) && toks[at]?.pos.offset === offset) at--
  if (!onName(toks[at])) return null

  const fbs = a.fbDefs.filter((f) => !f.library)
  const fbNamed = (name: string): FbDef | undefined => fbs.find((f) => identKey(f.name) === identKey(name))
  // a POU's or type's pos may be its keyword: its name is the first token after it that spells the name
  const nameFrom = (pos: number, name: string): number => {
    const k = identKey(name)
    for (let j = tokenAt(toks, pos); j >= 0 && j < toks.length && toks[j]!.pos.offset < pos + 200; j++) {
      if (toks[j]!.kind === 'ident' && identKey(toks[j]!.value) === k) return toks[j]!.pos.offset
    }
    return pos
  }
  const ofDecl = (d: Decl): Definition => ({ at: d.pos.offset, type: d.type })
  const ofMethod = (m: MethodDef): Definition => ({ at: nameFrom(m.pos.offset, m.name), type: m.ret ?? undefined, decls: m.decls })
  // a function block and every block it EXTENDS, itself first (a cycle is the checker's to report, so it stops one)
  const chain = (fb: FbDef | undefined): FbDef[] => {
    const out: FbDef[] = []
    for (let f = fb; f && !out.includes(f); f = f.extends ? fbNamed(f.extends.name) : undefined) out.push(f)
    return out
  }
  const inBlock = (fb: FbDef | undefined, k: string): Definition | null => {
    for (const f of chain(fb)) {
      const d = ownDecl(f.decls, k)
      if (d) return ofDecl(d)
      const m = f.methods?.find((x) => identKey(x.name) === k && !x.bodyless)
      if (m) return ofMethod(m)
    }
    return null
  }
  const member = (of: Definition | null, k: string): Definition | null => {
    if (!of) return null
    if (of.decls) {
      const d = ownDecl(of.decls, k)
      if (d) return ofDecl(d)
    }
    // the parser leaves every named type as `{ fb }` (the checker sorts blocks from structs), so the name is tried as both
    const typeName = of.type && isUserFb(of.type) ? of.type.fb : of.type && isStruct(of.type) ? of.type.struct : null
    if (typeName === null) return null
    const fb = fbNamed(typeName)
    if (fb) return inBlock(fb, k)
    const f = a.typeDefs.find((t) => !t.library && identKey(t.name) === identKey(typeName))?.fields.find((x) => identKey(x.name) === k)
    return f ? { at: f.pos.offset, type: f.type } : null
  }
  // `variables` false inside a TYPE block, where a name is a field's or a type's, never a variable's
  const global = (k: string, variables: boolean): Definition | null => {
    const d = variables ? ownDecl([...a.globals, ...a.decls], k) : undefined
    if (d) return ofDecl(d)
    const fn = a.funcDefs.find((f) => !f.library && identKey(f.name) === k)
    if (fn) return { at: nameFrom(fn.pos.offset, fn.name), type: fn.ret, decls: fn.decls }
    const named = [...fbs, ...a.programDefs, ...a.interfaceDefs, ...a.typeDefs, ...a.enumDefs, ...a.subrangeDefs, ...a.aliasDefs]
      .filter((t) => !('library' in t && t.library) && !('inline' in t && t.inline))
      .find((t) => identKey(t.name) === k)
    if (named) return { at: nameFrom(named.pos.offset, named.name) }
    const value = a.enumDefs.filter((e) => !e.library).flatMap((e) => e.members).find((m) => identKey(m.name) === k)
    return value ? { at: value.pos.offset } : null
  }
  // a name standing alone, seen from where it is written
  const plain = (i: number): Definition | null => {
    const k = identKey(toks[i]!.value)
    const where = toks[i]!.pos.offset
    const span = topLevelSpans(toks).find((s) => where >= s.start && where < s.end)
    if (span?.kind === 'pou') {
      const fb = fbNamed(span.name)
      const method = fb?.methods?.find((m) => m.start !== undefined && m.end !== undefined && where >= m.start && where < m.end)
      const mine = method && ownDecl(method.decls, k)
      if (mine) return ofDecl(mine)
      const pou = [...a.programDefs, ...a.funcDefs].find((p) => identKey(p.name) === identKey(span.name))
      const own = pou && ownDecl(pou.decls, k)
      if (own) return ofDecl(own)
      const inherited = inBlock(fb, k)
      if (inherited) return inherited
    }
    return global(k, span?.kind !== 'type')
  }
  const resolve = (i: number): Definition | null => {
    const prev = toks[i - 1]
    if (prev?.kind === 'op' && prev.value === '.') return toks[i - 2]?.kind === 'ident' ? member(resolve(i - 2), identKey(toks[i]!.value)) : null
    const next = toks[i + 1]
    if (next?.kind === 'op' && (next.value === ':=' || next.value === '=>') && prev?.kind === 'op' && (prev.value === '(' || prev.value === ',')) {
      // a formal argument: the callee is the name before the bracket this argument list opened with
      let depth = 0
      for (let j = i - 1; j > 0; j--) {
        const t = toks[j]!
        if (t.kind !== 'op') continue
        if (t.value === ')' || t.value === ']') depth++
        else if (t.value === '(' || t.value === '[') {
          if (depth > 0) depth--
          else return t.value === '(' && toks[j - 1]?.kind === 'ident' ? member(resolve(j - 1), identKey(toks[i]!.value)) : null
        }
      }
      return null
    }
    return plain(i)
  }
  return resolve(at)?.at ?? null
}

/**
 * The scene's names for tag `from` of `scope` and what they become when it is renamed `to`: what `rewireTags` moves the
 * parts' wiring by. A controller tag is its own name; a PROGRAM's tag is `Instance.Name` for every instance of it in
 * `controller` (the table the program runs by); a function block's or function's local is nothing the scene can name.
 */
export function tagRenamesForScene(source: string, scope: TagScope, from: string, to: string, controller: Controller | null): TagRename[] {
  if (from === to) return []
  if (scope.kind === 'controller') return [{ from, to }]
  const tree = parseStructure(source).ast
  if (!tree || !tree.programDefs.some((p) => identKey(p.name) === identKey(scope.name))) return []
  const programs = controller?.programs ?? []
  const renames = programs
    .filter((p) => p.type !== undefined && identKey(p.type) === identKey(scope.name))
    .map((p) => ({ from: `${p.name}.${from}`, to: `${p.name}.${to}` }))
  // a controller running one program instance also answers to its variables by bare name (plcLink.ts
  // soleInstanceAliases), so a part wired to `from` follows too, unless a top-level `from` owns that name
  const bareTaken = listTags(source).some((r) => r.scope.kind === 'controller' && identKey(r.name) === identKey(from))
  if (programs.length === 1 && renames.length === 1 && !bareTaken) renames.push({ from, to })
  return renames
}

/** Where a tag can live: the controller, then every PROGRAM, FUNCTION_BLOCK and FUNCTION the program
 *  declares, in source order. The controller is always first: it exists even in an empty program. */
export function tagScopes(source: string): TagScopeOption[] {
  const out: TagScopeOption[] = [{ scope: { kind: 'controller' }, label: 'Controller', kind: 'controller' }]
  const parsed = ast(source)
  if (!parsed) return out
  const pous = [
    ...parsed.ast.programDefs.map((p) => ({ name: p.name, kind: 'program' as const, at: p.pos.offset })),
    ...parsed.ast.fbDefs.map((f) => ({ name: f.name, kind: 'functionBlock' as const, at: f.pos.offset })),
    ...parsed.ast.funcDefs.map((f) => ({ name: f.name, kind: 'function' as const, at: f.pos.offset })),
  ].sort((a, b) => a.at - b.at)
  for (const p of pous) out.push({ scope: { kind: 'pou', name: p.name }, label: p.name, kind: p.kind })
  return out
}

/** The data types a tag can be, grouped for a picker: the scalars, the standard blocks, and whatever
 *  the program itself defines (structs, enumerations, named types, function blocks). */
export function tagTypeOptions(source: string): { group: string; types: string[] }[] {
  const out = [
    { group: 'Elementary', types: [...SCALAR_TYPES] as string[] },
    { group: 'Timers, counters, edges (IEC blocks)', types: [...USER_FB_TYPES] as string[] },
  ]
  const parsed = ast(source)
  if (!parsed) return out
  const a = parsed.ast
  const user = [
    ...a.typeDefs.map((t) => t.name),
    ...a.enumDefs.map((t) => t.name),
    ...a.subrangeDefs.map((t) => t.name),
    ...a.aliasDefs.map((t) => t.name),
    ...a.fbDefs.map((t) => t.name),
  ]
  if (user.length > 0) out.push({ group: 'Defined in this program', types: user })
  return out
}

/** The names already declared in `scope` (and, for a POU, the controller's and globals it also sees), folded. */
function namesInScope(a: Ast, scope: TagScope): Set<string> {
  const out = new Set<string>()
  const add = (decls: { name: string }[]): void => decls.forEach((d) => out.add(identKey(d.name)))
  add(a.globals)
  add(a.decls)
  if (scope.kind === 'pou') {
    const pou = [...a.programDefs, ...a.fbDefs, ...a.funcDefs].find((p) => identKey(p.name) === identKey(scope.name))
    if (pou) add(pou.decls)
  }
  return out
}

/** Why `name` cannot be a new tag in `scope`, in a sentence to show, or `null` if it can. */
export function tagNameError(source: string, scope: TagScope, name: string): string | null {
  const n = name.trim()
  if (n === '') return 'A name is required.'
  if (!IDENT.test(n)) return `"${n}" is not a valid tag name - letters, digits and _ only, starting with a letter or _.`
  if (KEYWORDS.has(n.toUpperCase())) return `${n.toUpperCase()} is a reserved word.`
  const parsed = ast(source)
  if (!parsed) return null // half-written program: the compiler will say if the name collides
  if (namesInScope(parsed.ast, scope).has(identKey(n))) return `"${n}" is already declared here.`
  const pous = [...parsed.ast.programDefs, ...parsed.ast.fbDefs, ...parsed.ast.funcDefs]
  if (pous.some((p) => identKey(p.name) === identKey(n))) return `"${n}" is a program or block name.`
  return null
}

/**
 * `source` with `name : type;` declared where the POU's statements begin (`declEnd`).
 *
 * The declaration joins the POU's existing block of that `section` - its last, never a CONSTANT one -
 * and with none, a new block is written at `declEnd`. Shared with the ladder view, which declares tags
 * as they are named on a rung.
 */
export function declareAt(source: string, toks: readonly Token[], declEnd: number, tag: NewTag): string {
  const desc = (tag.description ?? '').replace(/\s+/g, ' ').replace(/\*\)/g, '* )').trim()
  const line = `${tag.name} : ${tag.type};${desc ? ` (* ${desc} *)` : ''}`
  /** the line `at` begins, when nothing but indentation stands before it on that line */
  const lineLead = (at: number): { start: number; indent: string; own: boolean } => {
    const start = source.lastIndexOf('\n', at - 1) + 1
    const lead = source.slice(start, at)
    return /^\s*$/.test(lead) ? { start, indent: lead, own: true } : { start: at, indent: '', own: false }
  }
  // the VAR blocks standing directly before the statements, last first
  let j = toks.findIndex((t) => t.pos.offset >= declEnd) - 1
  while (j >= 0) {
    if (toks[j]!.kind === 'op' && toks[j]!.value === ';') j--
    const end = toks[j]
    if (!end || end.kind !== 'kw' || end.value !== 'END_VAR') break
    let k = j - 1
    while (k >= 0 && !(toks[k]!.kind === 'kw' && /^VAR(_|$)/.test(toks[k]!.value))) k--
    if (k < 0) break
    const constant = toks[k + 1]?.kind === 'kw' && toks[k + 1]!.value === 'CONSTANT'
    if (toks[k]!.value === tag.section && !constant) {
      const { start, indent, own } = lineLead(end.pos.offset)
      const text = own ? `${indent}  ${line}\n` : ` ${line} `
      return source.slice(0, start) + text + source.slice(start)
    }
    j = k - 1
  }
  const { indent } = lineLead(declEnd)
  // at the end of a file with no newline, the new block starts on a line of its own
  const lead = declEnd > 0 && declEnd >= source.length && !source.endsWith('\n') ? '\n' : ''
  return `${source.slice(0, declEnd)}${lead}${tag.section}\n${indent}  ${line}\n${indent}END_VAR\n${indent}${source.slice(declEnd)}`
}

/** `source` with `tag` declared in `scope`. Unchanged when the scope does not exist or the program does not parse. */
export function declareTagIn(source: string, scope: TagScope, tag: NewTag): string {
  const parsed = ast(source)
  if (!parsed) return source
  let declEnd: number | undefined
  if (scope.kind === 'controller') declEnd = parsed.ast.bodyStart
  else declEnd = [...parsed.ast.programDefs, ...parsed.ast.fbDefs, ...parsed.ast.funcDefs].find((p) => identKey(p.name) === identKey(scope.name))?.bodyStart
  if (declEnd === undefined) return source
  return declareAt(source, parsed.toks, declEnd, { ...tag, name: tag.name.trim(), type: tag.type.trim() })
}
