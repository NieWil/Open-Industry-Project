// Export a checked ST program in the formats a real toolchain ingests.
//
// The subset is chosen so a program ports, and this module writes it out. The IEC-text target is
// the same code path the external oracle renders the whole conformance corpus through
// (scripts/oracle-matiec.mjs), so what a user exports is exactly what CI compiles with a real
// IEC compiler. Without that check an export could produce a file no toolchain opens.
//
// Two targets, because there is no universal one:
//
//   - `iec-text` - a spec-legal IEC 61131-3 source file (exportText.ts). Compiles with
//                     MATIEC / STruC++ / RuSTy, and pastes into any vendor's ST editor.
//   - `plcopen-xml` - PLCopen TC6 XML, the vendor-neutral interchange format, and what
//                     OpenPLC's own editor emits, having had to solve the same problem.
//
// What carries over is the POU body. The wrapper around it does not: declarations, I/O binding
// and task scheduling all differ per vendor, so nothing vendor-specific is baked into the program
// and each target's shell is synthesised here. See docs/st-conformance.md.

import { declaredName } from '../document'
import { canonicalSyntax, controllerBody, declaredLibraryName, renderIecText, splitLibrary } from './exportText'
import { expandBits } from '../bits'
import { parseAndCheck } from '../checker'
import { lex } from '../lexer'
import { ladderExportCaveats, expandLadder } from '../ladder/ladder'
import type { LdSection } from '../ladder/ladder'
import { OIP_XML, ladderBodyXml } from '../ladder/ladderXml'
import { parse } from '../parser'
import { controllerTags } from '../program'
import { CALENDAR_TYPE_NAMES, DEFAULT_STRING_LEN, FB_TYPES, isArray, isEnum, isInterface, isRef, isStruct, isUserFb } from '../types'
import type { AliasDef, Ast, ConfigurationDef, DataType, Decl, EnumDef, Expr, FbDef, Initializer, InterfaceDef, MethodDef, Stmt, StructDef, SubrangeDef, VarSection } from '../types'

export type ExportTarget = 'iec-text' | 'plcopen-xml'

export interface ExportOptions {
  /** name of the generated PROGRAM POU (IEC needs one; our program body is implicit) */
  programName?: string
  projectName?: string
  companyName?: string
  /** ISO-8601 stamp for the XML headers. Injected so a test can assert exact output. */
  timestamp?: string
  /** scan period of the generated TASK, in milliseconds */
  scanMs?: number
}

export interface ExportResult {
  content: string
  /** suggested download name, extension matching the target */
  filename: string
  /**
   * What did not survive the trip, in the user's words. A silently lossy export is the
   * worst outcome for a portability tool: the file opens, and the logic is subtly not what
   * was simulated. Empty means the program crossed whole.
   */
  warnings: string[]
}

const DEFAULTS = {
  programName: 'Main',
  projectName: 'Untitled',
  companyName: 'Open Industry Project',
  timestamp: '1970-01-01T00:00:00',
  scanMs: 100,
}

// ---- PLCopen TC6 XML ----

/** PLCopen's elementary-type element names. Mixed case on purpose: `<string>` and
 *  `<wstring>` are lowercase and everything else is uppercase - a TC6 schema validator
 *  rejects `<STRING>` outright, with an error that reads like the type is unknown. */
function typeTag(t: string): string {
  return t === 'STRING' ? 'string' : t === 'WSTRING' ? 'wstring' : t.toUpperCase()
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The statement body of a POU block: everything after its declarations.
 *
 * `END_VAR` is a keyword that can only terminate a variable section (it cannot occur
 * inside a statement), so the last one in the block is exactly where declarations stop.
 * Going through the lexer rather than a regex means an `END_VAR` inside a string literal
 * or a comment cannot move the boundary.
 */
export function bodyOf(blockText: string, endKeyword?: RegExp): string {
  let start = 0
  try {
    for (const t of lex(blockText)) {
      if (t.kind === 'kw' && t.value === 'END_VAR') start = t.pos.offset + 'END_VAR'.length
    }
  } catch {
    return blockText.trim() // unlexable; the caller has already type-checked, so unreachable
  }
  const text = blockText.slice(start)
  return (endKeyword ? text.replace(endKeyword, '') : text).trim()
}

/** The one-line form used wherever a `<baseType>` wraps a non-array type. */
/** The enumerations of the program being written that were declared in a variable's declaration (EnumDef.inline),
 *  by name: such a variable's type is the enumeration itself, spelled out, not a type of that name. */
let inlineEnums = new Map<string, EnumDef>()

/** TC6's `<enum>`: an enumeration's values, as a dataType holds them or as a variable's own type. */
function enumValuesXml(e: EnumDef, indent: string): string[] {
  return [
    `${indent}<enum>`,
    `${indent}  <values>`,
    ...e.members.map((m) => `${indent}    <value name="${esc(m.name)}" value="${m.value}"/>`),
    `${indent}  </values>`,
    `${indent}</enum>`,
  ]
}

function innerTypeXml(t: DataType, maxLen?: number): string {
  if (isStruct(t)) return `<derived name="${esc(t.struct)}"/>`
  const inline = isEnum(t) ? inlineEnums.get(t.enum) : undefined
  if (inline) return enumValuesXml(inline, '').join('')
  if (isEnum(t)) return `<derived name="${esc(t.enum)}"/>`
  // an interface is a type by name; a REF_TO is TC6's own `<pointer>`
  if (isInterface(t)) return `<derived name="${esc(t.iface)}"/>`
  if (isRef(t)) return `<pointer><baseType>${typeXml(t.ref, t.maxLen, '')}</baseType></pointer>`
  // an array element or struct field that is a function block is derived too, for the same
  // reason a top-level instance is (see fbTypeName): TC6 has no elementary `<TON/>`
  if (isUserFb(t)) return `<derived name="${esc(t.fb)}"/>`
  // a use of a named array type refers to it by name; only its dataType spells the array out
  if (isArray(t) && t.named !== undefined) return `<derived name="${esc(t.named)}"/>`
  if (isArray(t)) return `<derived name="ARRAY"/>` // nested arrays are not in the subset
  if (fbTypeName(t)) return `<derived name="${esc(t)}"/>`
  if (t === 'STRING') {
    // PLCopen carries the capacity as an attribute rather than in the type spec: the length
    // rides along with the variable
    return maxLen !== undefined && maxLen !== DEFAULT_STRING_LEN ? `<string length="${maxLen}"/>` : '<string/>'
  }
  return `<${typeTag(t)}/>`
}

// ---- object orientation, in TC6's addData extension point ----
//
// TC6 2.01 has no methods, interfaces or inheritance, so they travel in TC6's extension point, `addData`, named under
// this project's own domain (OIP_XML, declared in the file's `addDataInfo`). The shape is ours and small:
// each `<data>` holds one element in the OIP_XML namespace, and the code itself is carried as the ST it was written in.
//
//   POU addData:     <data name=".../functionblock"> <functionBlock extends="Base" implements="IA,IB" abstract="true" final="true"/>
//                    <data name=".../method">        <method name="Run">METHOD Run ... END_METHOD</method>   (one per METHOD)
//   project addData: <data name=".../interface">     <interface name="IA">INTERFACE IA ... END_INTERFACE</interface>
//
// importXml.ts reads it back. Every other reader skips an addData it does not know, which is what the schema's
// `handleUnknown` is for. docs/st-conformance.md describes the same shape.

/** What each of our addData kinds holds, for the file's `addDataInfo`. */
const OIP_KINDS = {
  functionblock: 'What a FUNCTION_BLOCK derives from (extends), the INTERFACEs it implements, and whether it is ABSTRACT or FINAL.',
  method: 'One METHOD of a FUNCTION_BLOCK, as its Structured Text, METHOD to END_METHOD.',
  interface: 'One INTERFACE, as its Structured Text, INTERFACE to END_INTERFACE.',
} as const
type OipKind = keyof typeof OIP_KINDS

/** One addData `<data>` element of ours around `inner`, an element in the OIP_XML namespace. */
function oipData(kind: OipKind, inner: string, indent: string): string[] {
  return [`${indent}<data name="${OIP_XML}/${kind}" handleUnknown="implementation">`, `${indent}  ${inner}`, `${indent}</data>`]
}

/** The `addDataInfo` entries for the kinds a document uses, in the contentHeader. */
function addDataInfoXml(kinds: ReadonlySet<OipKind>, indent: string): string[] {
  if (kinds.size === 0) return []
  return [
    `${indent}<addDataInfo>`,
    ...[...kinds].flatMap((k) => [
      `${indent}  <info name="${OIP_XML}/${k}" version="1.0" vendor="http://www.openindustryproject.org">`,
      `${indent}    <description><xhtml:p>${esc(OIP_KINDS[k])}</xhtml:p></description>`,
      `${indent}  </info>`,
    ]),
    `${indent}</addDataInfo>`,
  ]
}

/** Source between two offsets with the members written in it (METHODs) taken out: a block's own body. */
function withoutMembers(source: string, from: number, to: number, members: readonly { start?: number; end?: number }[]): string {
  let text = ''
  let at = from
  for (const m of [...members].filter((x) => x.start !== undefined && x.end !== undefined && x.start >= from && x.end <= to).sort((a, b) => a.start! - b.start!)) {
    text += source.slice(at, m.start)
    at = m.end!
    // the `;` IEC allows after END_METHOD belongs to the member
    while (at < to && /\s/.test(source[at]!)) at++
    if (source[at] === ';') at++
  }
  return (text + source.slice(at, to)).trim()
}

/** A METHOD's ST, METHOD to END_METHOD, as written. */
function methodSource(m: MethodDef, source: string): string {
  if (m.start === undefined || m.end === undefined) {
    throw new Error(`export: METHOD '${m.name}' has no source position, which is a bug in the exporter - please report the program that produced it.`)
  }
  return source.slice(m.start, m.end)
}

/** A block's object orientation, for its own addData: its header (EXTENDS, IMPLEMENTS, ABSTRACT / FINAL), then each
 *  METHOD. Nothing for a block that has none of it. */
function blockOopXml(def: FbDef, source: string, indent: string, used: Set<OipKind>): string[] {
  const out: string[] = []
  const attrs = [
    ...(def.extends ? [`extends="${esc(def.extends.name)}"`] : []),
    ...(def.implements?.length ? [`implements="${esc(def.implements.map((i) => i.name).join(','))}"`] : []),
    ...(def.abstract ? ['abstract="true"'] : []),
    ...(def.final ? ['final="true"'] : []),
  ]
  if (attrs.length) {
    used.add('functionblock')
    out.push(...oipData('functionblock', `<functionBlock xmlns="${OIP_XML}" ${attrs.join(' ')}/>`, indent))
  }
  for (const m of def.methods ?? []) {
    used.add('method')
    out.push(...oipData('method', `<method xmlns="${OIP_XML}" name="${esc(m.name)}">${esc(methodSource(m, source))}</method>`, indent))
  }
  return out
}

/** An INTERFACE, for the project's addData. */
function interfaceXml(def: InterfaceDef, source: string, indent: string): string[] {
  const text = [
    `INTERFACE ${def.name}${def.extends.length ? ` EXTENDS ${def.extends.map((x) => x.name).join(', ')}` : ''}`,
    ...def.methods.map((m) => methodSource(m, source)),
    'END_INTERFACE',
  ].join('\n')
  return oipData('interface', `<interface xmlns="${OIP_XML}" name="${esc(def.name)}">${esc(text)}</interface>`, indent)
}

/** A `<type>` element body for a declared type. A named array is referred to by its name, unless
 *  `expand` asks for the array itself, which only its own dataType definition does. */
function typeXml(t: DataType, maxLen: number | undefined, indent: string, expand = false): string {
  if (!isArray(t) || (t.named !== undefined && !expand)) return `${indent}${innerTypeXml(t, maxLen)}`
  return [
    `${indent}<array>`,
    ...t.dims.map((d) => `${indent}  <dimension lower="${d.lo}" upper="${d.hi}"/>`),
    `${indent}  <baseType>${innerTypeXml(t.elem, t.elemMaxLen)}</baseType>`,
    `${indent}</array>`,
  ].join('\n')
}

/** IEC var section -> the PLCopen element that holds it. */
const SECTION_ELEMENT: Record<VarSection, string> = {
  VAR: 'localVars',
  VAR_INPUT: 'inputVars',
  VAR_OUTPUT: 'outputVars',
  VAR_IN_OUT: 'inOutVars',
  VAR_TEMP: 'tempVars',
  VAR_GLOBAL: 'globalVars',
  VAR_EXTERNAL: 'externalVars',
}

/** A literal token as the author wrote it, so `T#1s500ms` and `16#FF` survive as themselves instead
 *  of being printed back as the numbers they mean. */
function tokenText(offset: number, source: string): string {
  const t = lex(source.slice(offset))[0]
  return t === undefined ? '' : t.kind === 'str' ? (t.raw ?? `'${t.value}'`) : t.value
}

/** An initial value's expression in ST: literal tokens as written, and anything built from them
 *  rebuilt around them, a binary operation parenthesised so its grouping survives the trip. */
function valueText(e: Expr, source: string): string {
  switch (e.node) {
    case 'num':
    case 'str':
    case 'bool':
      return tokenText(e.pos.offset, source)
    case 'var':
      return e.qualifier !== undefined ? `${e.qualifier}#${e.name}` : e.ref ? `${e.name}^` : e.name
    case 'unary':
      return `${e.op === 'NOT' ? 'NOT ' : e.op === 'NEG' ? '-' : '+'}${valueText(e.expr, source)}`
    case 'binary':
      return `(${valueText(e.left, source)} ${e.op} ${valueText(e.right, source)})`
    case 'call':
      return `${e.name}(${e.args.map((a) => valueText(a, source)).join(', ')})`
    case 'member':
      return `${valueText(e.obj, source)}.${e.field}`
    case 'bit':
      return `${valueText(e.obj, source)}.%X${e.bit}`
    case 'index':
      return `${valueText(e.obj, source)}[${e.indices.map((x) => valueText(x, source)).join(', ')}]`
    case 'this':
      return e.super ? 'SUPER^' : 'THIS'
    case 'mcall':
      return `${valueText(e.obj, source)}.${e.method}(${e.args.map((a) => `${a.name} ${a.out ? '=>' : ':='} ${valueText(a.value, source)}`).join(', ')})`
    case 'isref':
      return `(${valueText(e.obj, source)} <> NULL)`
  }
}

/** TC6's initial value for one value: `simpleValue`, or `arrayValue` / `structValue` for a list. A field's value the
 *  checker added from its struct's default (`implied`) is left out: the struct's declaration says it. */
function initValueXml(v: Initializer, source: string): string {
  if (v.node === 'structInit') {
    return `<structValue>${v.fields.filter((f) => !f.implied).map((f) => `<value member="${esc(f.name)}">${initValueXml(f.value, source)}</value>`).join('')}</structValue>`
  }
  if (v.node === 'arrayInit') return `<arrayValue>${v.items.map((x) => `<value>${initValueXml(x, source)}</value>`).join('')}</arrayValue>`
  return `<simpleValue value="${esc(valueText(v, source))}"/>`
}

/** A declaration's whole initial value in TC6 form, or null when it declares none. An array's
 *  `[...]` list and a struct's `(field := ...)` list are included. */
function initialValueXml(d: Decl, source: string): string | null {
  if (d.structInit) return d.structInit.implied ? null : initValueXml(d.structInit, source)
  // an array of a struct with defaults, given no value of its own: every element is the struct's defaults
  if (d.arrayInit?.every((x) => x.node === 'structInit' && x.implied)) return null
  if (d.arrayInit) return initValueXml({ node: 'arrayInit', items: d.arrayInit, pos: d.pos }, source)
  return d.init ? initValueXml(d.init, source) : null
}

/** The name of the function-block type this declaration instantiates, user-defined or
 *  builtin, or null when it is not an FB instance at all.
 *
 *  A builtin instance (`t : TON`) is a bare type name in our AST, so without this it would
 *  take the elementary-type path and emit `<TON/>`, which TC6 rejects: a standard function
 *  block is a derived type there, like a user-defined one (`npm run st-oracle:xml` checks). */
function fbTypeName(t: Decl['type']): string | null {
  if (isUserFb(t)) return t.fb
  return typeof t === 'string' && (FB_TYPES as readonly string[]).includes(t) ? t : null
}

function variableXml(d: Decl, source: string, indent: string): string {
  // a located variable's address is TC6's `address` attribute, in the canonical spelling
  const address = d.location !== undefined ? ` address="${esc(d.location)}"` : ''
  const lines = [`${indent}<variable name="${esc(d.name)}"${address}>`]
  const fb = fbTypeName(d.type)
  if (fb) lines.push(`${indent}  <type><derived name="${esc(fb)}"/></type>`)
  else {
    lines.push(`${indent}  <type>`, typeXml(d.type as DataType, d.maxLen, `${indent}    `), `${indent}  </type>`)
  }
  const init = initialValueXml(d, source)
  if (init !== null) lines.push(`${indent}  <initialValue>${init}</initialValue>`)
  lines.push(`${indent}</variable>`)
  return lines.join('\n')
}

function varSectionsXml(decls: Decl[], source: string, indent: string): string {
  const bySection = new Map<string, Decl[]>()
  for (const d of decls) {
    const el = SECTION_ELEMENT[d.section]
    bySection.set(el, [...(bySection.get(el) ?? []), d])
  }
  const out: string[] = []
  // a fixed order, so two exports of the same program are byte-identical
  for (const el of ['inputVars', 'outputVars', 'inOutVars', 'externalVars', 'localVars', 'tempVars', 'globalVars']) {
    const list = bySection.get(el)
    if (!list?.length) continue
    const constant = list.every((d) => d.constant) ? ' constant="true"' : ''
    // TC6 carries retention on the var list, the same place as `constant`. The simulator
    // ignores RETAIN, but a target that warm-restarts does not, so the word is written back
    // out rather than dropped on the way through.
    const retain = list.every((d) => d.retain) ? ' retain="true"' : ''
    const persistent = list.every((d) => d.persistent) ? ' persistent="true"' : ''
    out.push(`${indent}<${el}${constant}${retain}${persistent}>`)
    for (const d of list) out.push(variableXml(d, source, `${indent}  `))
    out.push(`${indent}</${el}>`)
  }
  return out.join('\n')
}

function structXml(s: StructDef, indent: string, source: string): string {
  const fields = s.fields.map((f) => {
    const inner = isArray(f.type)
      ? `\n${typeXml(f.type, f.maxLen, `${indent}      `)}\n${indent}    `
      : innerTypeXml(f.type, f.maxLen)
    const init = f.init ? `<initialValue>${initValueXml(f.init, source)}</initialValue>` : ''
    return `${indent}    <variable name="${esc(f.name)}"><type>${inner}</type>${init}</variable>`
  })
  return [
    `${indent}<dataType name="${esc(s.name)}">`,
    `${indent}  <baseType>`,
    `${indent}    <struct>`,
    ...fields,
    `${indent}    </struct>`,
    `${indent}  </baseType>`,
    `${indent}</dataType>`,
  ].join('\n')
}

function enumXml(e: EnumDef, indent: string): string {
  return [
    `${indent}<dataType name="${esc(e.name)}">`,
    `${indent}  <baseType>`,
    ...enumValuesXml(e, `${indent}    `),
    `${indent}  </baseType>`,
    `${indent}</dataType>`,
  ].join('\n')
}

function subrangeXml(r: SubrangeDef, indent: string): string {
  // PLCopen splits the element by the signedness of the base type, and sequences its children range then baseType
  // (TC6 xsd: subrangeSigned / subrangeUnsigned are an xsd:sequence of range, baseType)
  const signed = r.base === 'SINT' || r.base === 'INT' || r.base === 'DINT'
  const el = signed ? 'subrangeSigned' : 'subrangeUnsigned'
  return [
    `${indent}<dataType name="${esc(r.name)}">`,
    `${indent}  <baseType>`,
    `${indent}    <${el}>`,
    `${indent}      <range lower="${r.lo}" upper="${r.hi}"/>`,
    `${indent}      <baseType><${typeTag(r.base)}/></baseType>`,
    `${indent}    </${el}>`,
    `${indent}  </baseType>`,
    `${indent}</dataType>`,
  ].join('\n')
}

/** A named type: the one place its definition is spelled out, where every use of it is `<derived>`. */
function aliasXml(a: AliasDef, indent: string): string {
  return [
    `${indent}<dataType name="${esc(a.name)}">`,
    `${indent}  <baseType>`,
    typeXml(a.type, a.maxLen, `${indent}    `, true),
    `${indent}  </baseType>`,
    `${indent}</dataType>`,
  ].join('\n')
}

function dataTypesXml(ast: Ast, indent: string, source: string): string {
  return [
    ...ast.typeDefs.map((s) => structXml(s, indent, source)),
    ...ast.enumDefs.filter((e) => !e.inline).map((e) => enumXml(e, indent)),
    ...ast.subrangeDefs.map((r) => subrangeXml(r, indent)),
    ...ast.aliasDefs.map((a) => aliasXml(a, indent)),
  ].join('\n')
}

/** One `<pou>`: its interface (the VAR sections) and its body: its ST verbatim, or, for a POU whose whole body is one
 *  LADDER section, that section as an `<LD>` graph (ladderXml.ts). */
function pouXml(
  name: string,
  pouType: 'program' | 'functionBlock' | 'function',
  decls: Decl[],
  body: string | LdSection,
  source: string,
  returnType: DataType | null,
  indent: string,
  retMaxLen?: number,
  oop?: string[],
): string {
  const lines = [`${indent}<pou name="${esc(name)}" pouType="${pouType}">`, `${indent}  <interface>`]
  // a struct or enumeration result is derived, like any other use of the type (the checker never
  // lets an ARRAY written out in place through as a result type)
  if (returnType) lines.push(`${indent}    <returnType>${innerTypeXml(returnType, retMaxLen)}</returnType>`)
  // drawn as LD, the POU needs none of the temporaries its ST form declares: a target's LD keeps its own edge memory
  const temps = typeof body === 'string' ? null : new Set(body.temps.map((t) => t.name.toUpperCase()))
  const vars = varSectionsXml(temps ? decls.filter((d) => !temps.has(d.name.toUpperCase())) : decls, source, `${indent}    `)
  if (vars) lines.push(vars)
  // (TC6: a POU's addData follows its body)
  const own = oop?.length ? [`${indent}  <addData>`, ...oop, `${indent}  </addData>`] : []
  if (typeof body !== 'string') {
    lines.push(`${indent}  </interface>`, `${indent}  <body>`, `${indent}    <LD>`, ladderBodyXml(body, `${indent}      `), `${indent}    </LD>`, `${indent}  </body>`, ...own, `${indent}</pou>`)
    return lines.join('\n')
  }
  lines.push(
    `${indent}  </interface>`,
    `${indent}  <body>`,
    `${indent}    <ST>`,
    // `xhtml:p` (the prefix is bound on <project>): what OpenPLC and a current Beremiz write, and
    // the only spelling OpenPLC's reader takes; it reads an `<xhtml>` element as an empty body
    // (scripts/oracle-openplc.mjs).
    `${indent}      <xhtml:p>${esc(body)}</xhtml:p>`,
    `${indent}    </ST>`,
    `${indent}  </body>`,
    ...own,
    `${indent}</pou>`,
  )
  return lines.join('\n')
}

/**
 * The peeled source of every POU, keyed by its declared name (upper-cased, since ST
 * identifiers are case-insensitive).
 *
 * The AST and the peeler are two independent recoveries of the same structure (a real parse
 * and a keyword scan over raw text). Pairing them by position breaks as soon as they disagree
 * on count or order, and an empty-string fallback would emit a POU with the right name and
 * interface but no body, which opens on a target and silently does nothing. Keyed by name there
 * is nothing to drift, and a definition with no block is an error instead of a blank.
 *
 * Names come from the lexer, not a regex: a block carries any comment written above it, so
 * `(* see FUNCTION_BLOCK Latch below *)` sits inside the text being named.
 */
function pouTextsByName(pous: { kind: 'fb' | 'func'; text: string }[]): Map<string, string> {
  // an unnamed block leaves nothing mapped, which surfaces as the named error below rather
  // than as a silently empty body
  return new Map(pous.map((p) => [declaredName(p.text).toUpperCase(), p.text]))
}

/** The body of the POU `name` declares. Throws rather than emitting an empty one. */
function bodyFor(name: string, byName: Map<string, string>, endKeyword: RegExp): string {
  const text = byName.get(name.toUpperCase())
  if (text === undefined) {
    throw new Error(
      `export: no source block found for POU '${name}'. The parser and the source peeler disagree about this program, which is a bug in the exporter - please report the program that produced it.`,
    )
  }
  return bodyOf(text, endKeyword)
}

/**
 * PLCopen TC6 XML - the IEC interchange format.
 *
 * The namespace is `tc6_0201`. PLCopen publishes an obtainable XSD for 0201 and none for 0200,
 * so only 0201 output can be validated. 0201 is also what Beremiz emits and reads, which is the
 * toolchain OpenPLC's editor is built on.
 *
 * Every corpus program is validated against that schema (`npm run st-oracle:xml`). It catches
 * defects string assertions miss, such as a `resource` emitted after the globals, or standard
 * function-block instances emitted as elementary types.
 */
export function toPlcopenXml(source: string, opts: ExportOptions = {}): string {
  source = portableText(source)
  const o = { ...DEFAULTS, ...opts }
  // A POU that is one LADDER section and nothing else goes out as an <LD> body. Any other ladder is replaced by the
  // ST it lowers to, like the rest of the file. Both are read off the file as written, before it is expanded.
  const sections = ladderSections(source)
  const drawn = new Map(sections.filter((s) => s.whole).map((s) => [s.pou.toUpperCase(), s]))
  const ld = (pou: string, st: string): string | LdSection => drawn.get(pou.toUpperCase()) ?? st
  if (sections.length > 0) source = expandLadder(source, sections)
  const ast = programOnly(parseAndCheck(source).ast)
  inlineEnums = new Map(ast.enumDefs.filter((e) => e.inline).map((e) => [e.name, e]))
  const { blocks, rest } = splitLibrary(source)

  const byName = pouTextsByName(blocks.filter((b): b is { kind: 'fb' | 'func'; text: string } => b.kind === 'fb' || b.kind === 'func'))
  const programTexts = new Map(blocks.filter((b) => b.kind === 'program').map((b) => [declaredLibraryName(b.text, 'PROGRAM').toUpperCase(), b.text]))
  // Code outside every POU beside a CONFIGURATION goes out as a PROGRAM of its own, its variables that
  // PROGRAM's or, when another POU names one, VAR_GLOBALs it reaches through VAR_EXTERNAL (exportText.ts).
  const outside = ast.configuration ? controllerBody(source) : null
  const tags = controllerTags(ast)
  const tagsAsGlobals = outside !== null && (outside.shared || outside.runners.length === 0)
  const outsidePou = outside && outside.runners.length > 0
    ? [
        pouXml(
          outside.typeName,
          'program',
          tagsAsGlobals
            ? [...tags.map((d): Decl => ({ ...d, section: 'VAR_EXTERNAL', init: null, arrayInit: undefined, structInit: undefined })), ...ast.decls.filter((d) => d.section === 'VAR_EXTERNAL')]
            : ast.decls,
          outside.statements,
          source,
          null,
          '      ',
        ),
      ]
    : []
  // a file's own PROGRAMs export under their names; the implicit program takes `programName`
  const programs = ast.programDefs.length > 0 || ast.configuration
    ? [...ast.programDefs.map((def) => pouXml(def.name, 'program', def.decls, ld(def.name, programBody(def.name, programTexts)), source, null, '      ')), ...outsidePou]
    : [pouXml(o.programName, 'program', ast.decls, ld('', bodyOf(rest)), source, null, '      ')]
  // which of our addData kinds the document uses, for its addDataInfo
  const used = new Set<OipKind>()
  const pouElements = [
    ...ast.fbDefs.map((def) => {
      // a block with METHODs: its own body is what is left of its statements once they are taken out
      const members = def.methods ?? []
      const oop = members.length > 0 || def.extends !== undefined || (def.implements?.length ?? 0) > 0
      const body = oop && def.bodyStart !== undefined && def.end !== undefined ? withoutMembers(source, def.bodyStart, def.end, members) : bodyFor(def.name, byName, /END_FUNCTION_BLOCK\s*;?\s*$/i)
      return pouXml(def.name, 'functionBlock', def.decls, ld(def.name, body), source, null, '      ', undefined, blockOopXml(def, source, '        ', used))
    }),
    ...ast.funcDefs.map((def) =>
      pouXml(def.name, 'function', def.decls, ld(def.name, bodyFor(def.name, byName, /END_FUNCTION\s*;?\s*$/i)), source, def.ret, '      ', def.retMaxLen),
    ),
    ...programs,
  ]

  const interfaces = ast.interfaceDefs.flatMap((d) => interfaceXml(d, source, '    '))
  if (interfaces.length) used.add('interface')
  const dataTypes = dataTypesXml(ast, '      ', source)
  const globals = varSectionsXml([...ast.globals, ...(tagsAsGlobals ? tags.map((d): Decl => ({ ...d, section: 'VAR_GLOBAL' })) : [])], source, '          ')

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<project xmlns="http://www.plcopen.org/xml/tc6_0201" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    `  <fileHeader companyName="${esc(o.companyName)}" productName="${esc(o.projectName)}" productVersion="1" creationDateTime="${esc(o.timestamp)}"/>`,
    `  <contentHeader name="${esc(o.projectName)}" modificationDateTime="${esc(o.timestamp)}">`,
    `    <coordinateInfo>`,
    `      <fbd><scaling x="16" y="16"/></fbd>`,
    `      <ld><scaling x="16" y="16"/></ld>`,
    `      <sfc><scaling x="16" y="16"/></sfc>`,
    `    </coordinateInfo>`,
    ...addDataInfoXml(used, '    '),
    `  </contentHeader>`,
    `  <types>`,
    `    <dataTypes>`,
    ...(dataTypes ? [dataTypes] : []),
    `    </dataTypes>`,
    `    <pous>`,
    ...pouElements,
    `    </pous>`,
    `  </types>`,
    `  <instances>`,
    `    <configurations>`,
    ...configurationXml(ast.configuration, ast.programDefs[0]?.name ?? o.programName, o.scanMs, globals, outside?.typeName ?? ''),
    `    </configurations>`,
    `  </instances>`,
    ...(interfaces.length ? ['  <addData>', ...interfaces, '  </addData>'] : []),
    `</project>`,
    ``,
  ].join('\n')
}

/** A PROGRAM block's statement body: past its header and its declarations, up to END_PROGRAM. */
function programBody(name: string, texts: Map<string, string>): string {
  const text = texts.get(name.toUpperCase())
  if (text === undefined) {
    throw new Error(
      `export: no source block found for PROGRAM '${name}'. The parser and the source peeler disagree about this program, which is a bug in the exporter - please report the program that produced it.`,
    )
  }
  // the header is found through the lexer, so a comment above the block naming another PROGRAM cannot
  // be taken for it; a PROGRAM with no VAR section would otherwise keep its header in the body
  const toks = lex(text)
  const at = toks.findIndex((t, k) => t.kind === 'ident' && t.value.toUpperCase() === 'PROGRAM' && toks[k + 1]?.kind === 'ident')
  const nameTok = toks[at + 1]
  const afterHeader = at < 0 || !nameTok ? text : text.slice(nameTok.pos.offset + nameTok.value.length)
  return bodyOf(afterHeader, /END_PROGRAM\s*;?\s*$/i)
}

/**
 * The `<configuration>`: the file's own, or the one-task wrapper the implicit program (and a lone
 * PROGRAM) runs in.
 *
 * Order matters: TC6 declares `configuration` as a sequence of resource*, globalVars*,
 * accessVars?, configVars?, ... so a `resource` after the globals is schema-invalid, however sensible
 * it reads. Caught by validating against PLCopen's own XSD; the structural string
 * assertions never saw it. A `resource` is task*, globalVars*, pouInstance* in turn, which is where
 * an instance with no task (the continuous one) goes.
 */
function configurationXml(config: ConfigurationDef | null, programName: string, scanMs: number, globals: string, outsideType: string): string[] {
  /** the type an instance runs: the code outside every POU goes out as `outsideType` */
  const typeOf = (p: ConfigurationDef['programs'][number]): string => esc(p.type ?? outsideType)
  const lines: string[] = []
  if (!config) {
    lines.push(
      `      <configuration name="Config0">`,
      `        <resource name="Res0">`,
      `          <task name="Tick" interval="T#${scanMs}ms" priority="0">`,
      `            <pouInstance name="Inst0" typeName="${esc(programName)}"/>`,
      `          </task>`,
      `        </resource>`,
    )
  } else {
    lines.push(`      <configuration name="${esc(config.name)}">`, `        <resource name="${esc(config.resources[0]?.name ?? 'Res0')}">`)
    for (const t of config.tasks) {
      lines.push(`          <task name="${esc(t.name)}" interval="T#${t.periodMs}ms" priority="${t.priority}">`)
      for (const p of config.programs) {
        if (p.task !== null && p.task.toUpperCase() === t.name.toUpperCase()) lines.push(`            <pouInstance name="${esc(p.name)}" typeName="${typeOf(p)}"/>`)
      }
      lines.push(`          </task>`)
    }
    for (const p of config.programs) {
      if (p.task === null) lines.push(`          <pouInstance name="${esc(p.name)}" typeName="${typeOf(p)}"/>`)
    }
    lines.push(`        </resource>`)
  }
  if (globals) lines.push(globals)
  lines.push(`      </configuration>`)
  return lines
}

// ---- public entry point ----

function slug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'program'
}

/**
 * What the target will not have, stated up front.
 *
 * The subset is currently small enough that almost everything crosses, so this is usually
 * empty - but the channel exists because the moment a feature lands that only some targets
 * have (methods being the obvious candidate), the export has to say so rather than quietly
 * producing a file that opens and misbehaves.
 */
/**
 * Standard-function names that a target's lexer is likely to reserve outright.
 *
 * IEC's Instruction List uses these as operators, and a compiler that reads both languages
 * shares one lexer between them. So the name is a keyword even in ST, and a variable called
 * `lt` will not build. MATIEC is such a compiler (iec_flex.ll marks them "Keyword
 * (Standard Function)").
 *
 * This engine accepts them: IEC does not list standard function names among its reserved
 * words, and refusing them would invent a rule the standard lacks. A warning on export is
 * the compromise. `AND`/`OR`/`XOR`/`NOT`/`MOD` are absent
 * because they are ST operators too, so this engine already rejects them as identifiers.
 * `S` and `R` are IL's set and reset, and a toolchain that reads IL may reserve them as names too, which is why the
 * corpus's jump case says X3.
 */
const IL_OPERATOR_NAMES = new Set(['ADD', 'SUB', 'MUL', 'DIV', 'GT', 'GE', 'EQ', 'LE', 'LT', 'NE', 'S', 'R'])

/**
 * Sequential Function Chart keywords, which a toolchain that also reads SFC reserves in ST by the
 * same mechanism as the IL operators above. MATIEC refused `step : INT` outright ("invalid variable(s)
 * declaration"); the others are the rest of the same SFC vocabulary.
 */
const SFC_KEYWORD_NAMES = new Set(['STEP', 'INITIAL_STEP', 'TRANSITION', 'ACTION', 'FROM'])

/**
 * The calendar type names, which this engine leaves usable as names (`dt` is a time step in programs that
 * predate the types; types.ts CALENDAR_TYPE_NAMES) and every IEC compiler reserves: MATIEC refused
 * `dt : REAL`, and `tod`, `date` and both long spellings.
 */
const CALENDAR_TYPE_WORDS = new Set(Object.keys(CALENDAR_TYPE_NAMES))

/** Declared names that collide with one of a set of reserved words, in the author's own spelling. */
function reservedNames(ast: Ast, reserved: Set<string>): string[] {
  const hits = new Set<string>()
  const scan = (decls: Decl[]): void => {
    for (const d of decls) if (reserved.has(d.name.toUpperCase())) hits.add(d.name)
  }
  scan(ast.decls)
  scan(ast.globals)
  for (const fb of ast.fbDefs) scan(fb.decls)
  for (const fn of ast.funcDefs) scan(fn.decls)
  for (const p of ast.programDefs) scan(p.decls)
  return [...hits]
}

/** Every `var` name an expression reads, however deeply nested. */
function readsOf(e: Expr | null | undefined, out: Set<string>): void {
  if (!e) return
  const anyE = e as unknown as Record<string, unknown>
  if (e.node === 'var') out.add(e.name.toUpperCase())
  for (const k of ['obj', 'index', 'left', 'right', 'operand', 'arg']) {
    if (anyE[k]) readsOf(anyE[k] as Expr, out)
  }
  for (const k of ['args', 'items']) {
    if (Array.isArray(anyE[k])) for (const a of anyE[k] as Expr[]) readsOf(a, out)
  }
}

/** Every name a statement list assigns to, at any depth. */
function writesOf(body: Stmt[], out: Set<string>): void {
  for (const s of body) {
    if (s.node === 'assign' && s.target.node === 'var') out.add(s.target.name.toUpperCase())
    if (s.node === 'assign' && s.target.node === 'member' && s.target.obj.node === 'var') out.add(s.target.obj.name.toUpperCase())
    if (s.node === 'if') {
      for (const b of s.branches) writesOf(b.body, out)
      if (s.elseBody) writesOf(s.elseBody, out)
    }
    if (s.node === 'case') {
      for (const c of s.cases) writesOf(c.body, out)
      if (s.elseBody) writesOf(s.elseBody, out)
    }
    if (s.node === 'for' || s.node === 'while' || s.node === 'repeat') writesOf(s.body, out)
  }
}

/**
 * `FOR` loops whose body rewrites a variable their own bound is read from.
 *
 * The one construct measured to run a different number of times depending on the toolchain.
 * This engine snapshots the bound at entry. MATIEC and RuSTy, the two independent IEC compilers
 * whose behaviour could be inspected, both re-read it every iteration, so
 * `FOR i := 1 TO n DO n := 10; ... END_FOR;` runs 3 times here and 10 times there. IEC
 * constrains `FOR` to a count "determined in advance" but does not say (in any text reachable
 * from here) when the final-value expression is evaluated, so neither side is wrong. The author
 * has to avoid it, and the export warns about it.
 */
function loopBoundWarnings(body: Stmt[], where: string, out: string[]): void {
  for (const s of body) {
    if (s.node === 'for') {
      const bound = new Set<string>()
      readsOf(s.to, bound)
      readsOf(s.by, bound)
      const written = new Set<string>()
      writesOf(s.body, written)
      const clash = [...bound].filter((n) => written.has(n))
      if (clash.length) {
        out.push(
          `${where}: the FOR loop over '${s.varName}' rewrites ${clash.join(', ')}, which its own bound is read from. This engine fixes the bound when the loop starts; MATIEC and RuSTy re-read it every pass, so the loop runs a different number of times there. Hoist the bound into its own variable before the loop, or use WHILE.`,
        )
      }
      loopBoundWarnings(s.body, where, out)
    }
    if (s.node === 'if') {
      for (const b of s.branches) loopBoundWarnings(b.body, where, out)
      if (s.elseBody) loopBoundWarnings(s.elseBody, where, out)
    }
    if (s.node === 'case') {
      for (const c of s.cases) loopBoundWarnings(c.body, where, out)
      if (s.elseBody) loopBoundWarnings(s.elseBody, where, out)
    }
    if (s.node === 'while' || s.node === 'repeat') loopBoundWarnings(s.body, where, out)
  }
}

/** Does a value of this type hold a function-block instance, itself or anywhere inside it? */
function holdsFb(t: DataType, structs: Map<string, StructDef>): boolean {
  if (fbTypeName(t)) return true
  if (isArray(t)) return holdsFb(t.elem, structs)
  if (isStruct(t)) return (structs.get(t.struct.toUpperCase())?.fields ?? []).some((f) => holdsFb(f.type, structs))
  return false
}

/**
 * Is a function-block instance kept inside an array or a struct field anywhere in the program?
 *
 * The one shape this engine accepts that splits the targets by edition, as measured:
 * STruC++ builds the struct field, but MATIEC (2nd edition) refuses both outright. See docs/st-conformance.md.
 */
function fbInsideAggregate(ast: Ast): boolean {
  const structs = new Map(ast.typeDefs.map((s) => [s.name.toUpperCase(), s]))
  if (ast.typeDefs.some((s) => s.fields.some((f) => holdsFb(f.type, structs)))) return true
  const decls = [...ast.decls, ...ast.globals, ...ast.fbDefs.flatMap((fb) => fb.decls), ...ast.programDefs.flatMap((p) => p.decls)]
  return decls.some((d) => isArray(d.type) && holdsFb(d.type.elem, structs))
}

/**
 * Declared variables spelled like a declared TYPE, function block or function, case-insensitively,
 * in the author's own spelling.
 *
 * Nothing in this engine confuses the two, so it accepts them. MATIEC's lexer does: it reads a
 * name declared as a type as that type's token wherever it appears, so `VAR_OUTPUT pkg : Pkg;`
 * does not even declare ("unknown error in output variable(s) declaration").
 */
function typeNamedVariables(ast: Ast): string[] {
  const named = [...ast.typeDefs, ...ast.enumDefs, ...ast.subrangeDefs, ...ast.aliasDefs, ...ast.fbDefs, ...ast.funcDefs, ...ast.programDefs]
  const types = new Set(named.map((d) => d.name.toUpperCase()))
  const hits = new Set<string>()
  const scan = (decls: Decl[]): void => {
    for (const d of decls) if (types.has(d.name.toUpperCase())) hits.add(d.name)
  }
  scan(ast.decls)
  scan(ast.globals)
  for (const fb of ast.fbDefs) scan(fb.decls)
  for (const fn of ast.funcDefs) scan(fn.decls)
  for (const p of ast.programDefs) scan(p.decls)
  return [...hits]
}

/** Does a statement list, at any depth, copy a whole ARRAY spelled out in place into another? (A
 *  named array type copies under its name, which MATIEC takes.) */
function assignsWholeArray(body: Stmt[]): boolean {
  return body.some((s) => {
    if (s.node === 'assign') return s.copy === 'anonymous-array'
    if (s.node === 'if') return s.branches.some((b) => assignsWholeArray(b.body)) || (s.elseBody !== null && assignsWholeArray(s.elseBody))
    if (s.node === 'case') return s.cases.some((c) => assignsWholeArray(c.body)) || (s.elseBody !== null && assignsWholeArray(s.elseBody))
    if (s.node === 'for' || s.node === 'while' || s.node === 'repeat') return assignsWholeArray(s.body)
    return false
  })
}

/** Does a starting value mix the two kinds of list, a `[...]` inside a `(field := ...)` or field lists
 *  inside a `[...]`? MATIEC refuses both directions, named array type or not (measured). */
function mixedInitLists(ast: Ast): boolean {
  const mixes = (v: Initializer, inside: 'struct' | 'array' | null): boolean => {
    if (v.node === 'structInit') return inside === 'array' || v.fields.some((f) => mixes(f.value, 'struct'))
    if (v.node === 'arrayInit') return inside === 'struct' || v.items.some((x) => mixes(x, 'array'))
    return false
  }
  const decls = [...ast.decls, ...ast.globals, ...ast.fbDefs.flatMap((fb) => fb.decls), ...ast.funcDefs.flatMap((fn) => fn.decls), ...ast.programDefs.flatMap((p) => p.decls)]
  return decls.some((d) => (d.structInit !== undefined && mixes(d.structInit, null)) || (d.arrayInit ?? []).some((x) => mixes(x, 'array')))
}

/** Is an array bound anywhere in the program written as a named CONSTANT (or an expression over
 *  one) rather than a literal? MATIEC calls that non-standard for IEC 61131-3 ("Use of variables in
 *  array size limits is not allowed"). */
function constantBounds(ast: Ast): boolean {
  const viaConstant = (t: DataType): boolean => isArray(t) && (t.dims.some((d) => d.loExpr !== undefined || d.hiExpr !== undefined) || viaConstant(t.elem))
  const decls = [...ast.decls, ...ast.globals, ...ast.fbDefs.flatMap((fb) => fb.decls), ...ast.funcDefs.flatMap((fn) => fn.decls), ...ast.programDefs.flatMap((p) => p.decls)]
  return decls.some((d) => viaConstant(d.type)) || ast.typeDefs.some((s) => s.fields.some((f) => viaConstant(f.type))) || ast.aliasDefs.some((a) => viaConstant(a.type))
}

/**
 * Does any statement in these lists, at any depth, hold an expression `isExpr` accepts, or is one `isStmt` accepts?
 */
function someInBodies(bodies: Stmt[][], isExpr: (x: Expr) => boolean, isStmt: (s: Stmt) => boolean = () => false): boolean {
  const e = (x: Expr | null | undefined): boolean => {
    if (!x) return false
    if (isExpr(x)) return true
    switch (x.node) {
      case 'member': return e(x.obj)
      case 'bit': return e(x.obj)
      case 'index': return e(x.obj) || x.indices.some(e)
      case 'unary': return e(x.expr)
      case 'binary': return e(x.left) || e(x.right)
      case 'call': return x.args.some(e)
      case 'mcall': return e(x.obj) || x.args.some((a) => e(a.value))
      case 'isref': return e(x.obj)
      default: return false
    }
  }
  const st = (s: Stmt): boolean => {
    if (isStmt(s)) return true
    switch (s.node) {
      case 'assign': return e(s.target) || e(s.value)
      case 'fbcall': return e(s.target) || s.args.some((a) => e(a.value))
      case 'invoke': return e(s.call)
      case 'bind': return e(s.target) || e(s.source)
      case 'if': return s.branches.some((b) => e(b.cond) || b.body.some(st)) || (s.elseBody ?? []).some(st)
      case 'case': return e(s.selector) || s.cases.some((c) => c.body.some(st)) || (s.elseBody ?? []).some(st)
      case 'for': return e(s.from) || e(s.to) || e(s.by) || s.body.some(st)
      case 'while': case 'repeat': return e(s.cond) || s.body.some(st)
      default: return false
    }
  }
  return bodies.some((b) => b.some(st))
}

/** `TIME_TO_<number>` or `<number>_TO_TIME`: a duration converted to or from a count, whose unit the toolchains disagree
 *  on (BOOL and STRING are not counts). */
const convertsTimeAndNumber = (name: string): boolean => {
  const m = /^([A-Z]+)_TO_([A-Z]+)$/.exec(name.toUpperCase())
  if (!m || (m[1] === 'TIME') === (m[2] === 'TIME')) return false
  return !['BOOL', 'STRING'].includes(m[1] === 'TIME' ? m[2]! : m[1]!)
}

/** How the warnings below name the target: the compiler OpenPLC v4's editor ships, at the version measured. */
const OPENPLC_V4 = 'OpenPLC v4 (its compiler, STruC++ 0.6.2)'

const INTEGER_TYPES = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD'])
/** the calendar functions STruC++ 0.6.2's runtime declares none of (the operators they name build there) */
const STRUCPP_MISSING_CALENDAR = new Set(['ADD_TOD_TIME', 'ADD_DT_TIME', 'SUB_TOD_TIME', 'SUB_DT_TIME', 'SUB_DATE_DATE', 'SUB_TOD_TOD', 'SUB_DT_DT'])

/**
 * What OpenPLC v4 builds or runs differently, one warning per thing, each naming what to write instead.
 *
 * Measured by the run tier of the STruC++ oracle (scripts/oracle-strucpp.mjs --execute, its RUN_GAPS):
 * every corpus case STruC++ 0.6.2 compiles was built with g++ against its runtime and run against the goldens. Two
 * kinds come out of that. Some programs STruC++ reports compiling but whose C++ does not build (its runtime lacks the
 * function, or the header is out of order): the user finds out at build time, so the warning says so before. Others
 * build and compute something else: those are the ones that matter most, because nothing on the target says so.
 * Only what was measured is warned about, and only where the program can be seen to do it. The object-oriented and
 * naming rules at the end were pinned down by building small variations with STruC++ 0.6.2 and g++ until each
 * failure had one cause, with a control beside it that builds.
 */
function strucppWarnings(ast: Ast, programBodies: Stmt[][]): string[] {
  const out: string[] = []
  const bodies = [...programBodies, ...ast.fbDefs.flatMap((d) => (d.methods ?? []).map((m) => m.body))]
  const decls = [...ast.decls, ...ast.globals, ...ast.fbDefs.flatMap((d) => [...d.decls, ...(d.methods ?? []).flatMap((m) => m.decls)]), ...ast.programDefs.flatMap((p) => p.decls), ...ast.funcDefs.flatMap((f) => f.decls)]
  const userFunctions = new Set(ast.funcDefs.map((f) => f.name.toUpperCase()))
  const calls = new Map<string, Extract<Expr, { node: 'call' }>[]>()
  let notLiteral = false
  let dateDifference = false
  let stringOrder = false
  someInBodies(bodies, (x) => {
    if (x.node === 'call') {
      const name = x.name.toUpperCase()
      calls.set(name, [...(calls.get(name) ?? []), x])
    }
    if (x.node === 'unary' && x.op === 'NOT' && x.expr.node === 'num' && x.t !== 'BOOL') notLiteral = true
    if (x.node === 'binary' && x.op === '-' && x.left.t === 'DATE' && x.right.t === 'DATE') dateDifference = true
    if (x.node === 'binary' && ['<', '<=', '>', '>='].includes(x.op) && x.left.t === 'STRING') stringOrder = true
    return false
  })
  const named = (test: (name: string) => boolean): string[] => [...calls.keys()].filter(test).sort()

  // ---- it builds, and computes something else ----
  const realToInt = named((n) => {
    const m = /^(L?REAL)_TO_([A-Z]+)$/.exec(n)
    return m !== null && INTEGER_TYPES.has(m[2]!)
  })
  if (realToInt.length > 0) {
    out.push(`${realToInt.join(', ')}: a REAL exactly halfway between two integers rounds to even here, as MATIEC rounds it (2.5 converts to 2), but ${OPENPLC_V4} rounds it away from zero (2.5 to 3, -2.5 to -3); every other value converts the same. Where a tie can reach the conversion, decide it yourself, e.g. with TRUNC.`)
  }
  if (notLiteral) {
    out.push(`NOT of an integer literal (NOT 0) complements every bit here, but ${OPENPLC_V4} generates it as a logical NOT, so NOT 0 stored into a WORD is 1 there instead of 16#FFFF. Write the value itself (16#FFFF), or NOT of a variable, which complements correctly there.`)
  }
  const downCounters = decls.filter((d) => /^CTU?D$/.test((fbTypeName(d.type) ?? '').toUpperCase())).map((d) => d.name)
  if (downCounters.length > 0) {
    out.push(`${[...new Set(downCounters)].sort().join(', ')}: a CTD or CTUD counts down on the RISING edge of CD here, as IEC says; ${OPENPLC_V4}'s library detects CD with an F_TRIG, so there it counts down when CD falls - a scan or more later, and once per pulse all the same. A program that reads CV the scan CD rises sees the old count there.`)
  }
  // a PROGRAM's own variables only (the code outside every POU goes out as one): the starting values STruC++ drops are
  // the ones its generated PROGRAM constructor leaves out. A function block's and a FUNCTION's keep theirs (measured);
  // a CONFIGURATION's VAR_GLOBAL was not, so it is not warned about
  const programDecls = [...ast.decls, ...ast.programDefs.flatMap((p) => p.decls)]
  const arrayStarts = programDecls.filter((d) => !d.hidden && (d.arrayInit?.length ?? 0) > 0).map((d) => d.name)
  if (arrayStarts.length > 0) {
    out.push(`${[...new Set(arrayStarts)].sort().join(', ')}: a PROGRAM's array with a [...] starting value. ${OPENPLC_V4} drops it, so the array starts at zero there (a function block's or a FUNCTION's array keeps its own); set its elements in the program on the first scan for that target.`)
  }
  const literal = (e: Expr): boolean => e.node === 'num' || e.node === 'bool' || e.node === 'str' || (e.node === 'unary' && e.op === 'NEG' && e.expr.node === 'num')
  const constantStarts = programDecls.filter((d) => d.constant && d.init !== null && !literal(d.init)).map((d) => d.name)
  if (constantStarts.length > 0) {
    out.push(`${[...new Set(constantStarts)].sort().join(', ')}: a PROGRAM's CONSTANT whose value is an expression (LAST : INT := ZONES - 1). ${OPENPLC_V4} starts it at 0 (inside a function block it holds); write the number itself for that target.`)
  }
  if (dateDifference) {
    out.push(`A DATE is subtracted from a DATE. Here the result is the TIME between them, as IEC says; ${OPENPLC_V4} stores the number of DAYS in the TIME, so two days apart reads as T#2ns there. Subtract two DTs instead (DT#... at midnight), which it gets right.`)
  }
  const calendarText = named((n) => /^(DATE|TOD|DT|TIME_OF_DAY|DATE_AND_TIME)_TO_STRING$/.test(n))
  if (calendarText.length > 0) {
    out.push(`${calendarText.join(', ')}: here a calendar value prints as its literal (D#2024-02-29); ${OPENPLC_V4} prints the count it keeps (19782 days, or nanoseconds). Build the text from the parts you need, or keep the value in its own type.`)
  }
  const taskless = ast.configuration?.programs.filter((p) => p.task === null && p.type !== null).map((p) => p.name) ?? []
  if (taskless.length > 0 && (ast.configuration?.tasks.length ?? 0) > 0) {
    out.push(`${taskless.join(', ')}: a PROGRAM line with no WITH. Here it runs after the periodic tasks, at the lowest priority, as IEC gives it; ${OPENPLC_V4} puts it on the configuration's FIRST task, so it runs with that task, before a lower-priority task due on the same tick. Give it a task of its own for that target.`)
  }

  // ---- STruC++ reports compiling it, and the C++ it generates does not build ----
  const bcd = named((n) => /_TO_BCD$|^BCD_TO_/.test(n))
  if (bcd.length > 0) {
    out.push(`${bcd.join(', ')}: ${OPENPLC_V4} declares no BCD conversion, so the program does not build there although STruC++ reports compiling it. Pack the digits with arithmetic (tens * 16 + ones) for that target.`)
  }
  const calendarFns = named((n) => STRUCPP_MISSING_CALENDAR.has(n) || /_TO_(TIME_OF_DAY|DATE_AND_TIME)$/.test(n))
  if (calendarFns.length > 0) {
    out.push(`${calendarFns.join(', ')}: ${OPENPLC_V4} declares none of these, so the program does not build there although STruC++ reports compiling it. Write the operator (tod + t, dt1 - dt2) or the short name (DT_TO_TOD), which build.`)
  }
  const literalOnly = named((n) => !userFunctions.has(n) && (calls.get(n) ?? []).some((c) => c.args.some((a) => a.t === 'STRING') && c.args.every((a) => a.t !== 'STRING' || a.node === 'str')))
  if (literalOnly.length > 0) {
    out.push(`${literalOnly.join(', ')}: a standard function whose STRING arguments are all literals ('ab'). ${OPENPLC_V4} has no form of it that takes only literals, so the program does not build there although STruC++ reports compiling it. Put one of them in a variable, or write the result itself.`)
  }
  if (stringOrder) {
    out.push(`Two STRINGs are ordered with <, <=, > or >=. ${OPENPLC_V4} has no such operator for a STRING variable, so the program does not build there although STruC++ reports compiling it (= and <> do build).`)
  }
  const structs = new Map(ast.typeDefs.map((s) => [s.name.toUpperCase(), s]))
  const fbStructs = ast.typeDefs.filter((s) => s.fields.some((f) => holdsFb(f.type, structs))).map((s) => s.name)
  if (fbStructs.length > 0) {
    out.push(`${fbStructs.join(', ')}: a STRUCT that holds a function-block instance. ${OPENPLC_V4} declares every struct before any function block, so the program does not build there although STruC++ reports compiling it. Keep the instance beside the struct, not in it, for that target.`)
  }
  // measured with STruC++ 0.6.2 and g++, a control beside each that builds
  const refs = decls.filter((d) => isRef(d.type) && (isStruct(d.type.ref) || fbTypeName(d.type.ref) !== null)).map((d) => d.name)
  if (refs.length > 0) {
    out.push(`${[...new Set(refs)].sort().join(', ')}: a REF_TO a STRUCT or a function block. ${OPENPLC_V4} builds a REF_TO an elementary type (INT, REAL, ...), REF() of an array element or a struct's field included, but not REF() of a whole struct or block, although STruC++ reports compiling it (and it refuses a METHOD called through one, r^.M()). Pass the struct or block itself (VAR_IN_OUT) for that target.`)
  }
  let nullFirst = false
  const outputsLeft = new Set<string>()
  const sameName = new Set<string>()
  someInBodies(bodies, (x) => {
    if (x.node === 'isref' && x.nullFirst) nullFirst = true
    if (x.node !== 'mcall' || x.body) return false
    if (x.obj.node === 'var' && x.cls && x.obj.name.toUpperCase() === x.cls.toUpperCase()) sameName.add(x.obj.name)
    const outputs = (x.sig?.decls ?? []).filter((d) => d.section === 'VAR_OUTPUT').map((d) => d.name.toUpperCase())
    const bound = new Set(x.args.filter((a) => a.out).map((a) => a.name.toUpperCase()))
    if (outputs.some((o) => !bound.has(o))) outputsLeft.add(x.method)
    return false
  })
  if (nullFirst) {
    out.push(`NULL is written on the left of a comparison (NULL <> r). ${OPENPLC_V4} has no comparison that way round, so the program does not build there although STruC++ reports compiling it; write the reference first, r <> NULL.`)
  }
  if (outputsLeft.size > 0) {
    out.push(`${[...outputsLeft].sort().join(', ')}: a METHOD called without binding every one of its outputs (=>). Here an output left out is not read; ${OPENPLC_V4} generates the call with that argument missing, so the program does not build there although STruC++ reports compiling it. Bind every output, to a scratch variable if it is not wanted.`)
  }
  if (sameName.size > 0) {
    out.push(`${[...sameName].sort().join(', ')}: a METHOD called on an instance named like its own block type (fast : Fast). ${OPENPLC_V4} renames such an instance where it is declared but not in a method call, so the program does not build there although STruC++ reports compiling it (calling the block itself builds). Rename the instance for that target.`)
  }
  return out
}

/** Every VAR_GLOBAL a statement list reads or writes, in its declared spelling. */
function globalRefs(body: Stmt[], out: Set<string>): void {
  const expr = (e: Expr | null | undefined): void => {
    if (!e) return
    switch (e.node) {
      case 'var':
        if (e.global && e.constValue === undefined) out.add(e.name)
        return
      case 'member':
      case 'bit':
        expr(e.obj)
        return
      case 'index':
        expr(e.obj)
        e.indices.forEach(expr)
        return
      case 'unary':
        expr(e.expr)
        return
      case 'binary':
        expr(e.left)
        expr(e.right)
        return
      case 'call':
        e.args.forEach(expr)
        return
      default:
        return
    }
  }
  for (const s of body) {
    switch (s.node) {
      case 'assign':
        expr(s.target)
        expr(s.value)
        break
      case 'fbcall':
        expr(s.target)
        for (const a of s.args) expr(a.value)
        break
      case 'if':
        for (const b of s.branches) {
          expr(b.cond)
          globalRefs(b.body, out)
        }
        if (s.elseBody) globalRefs(s.elseBody, out)
        break
      case 'case':
        expr(s.selector)
        for (const c of s.cases) globalRefs(c.body, out)
        if (s.elseBody) globalRefs(s.elseBody, out)
        break
      case 'for':
        if (s.vGlobal) out.add(s.varName)
        expr(s.from)
        expr(s.to)
        expr(s.by)
        globalRefs(s.body, out)
        break
      case 'while':
        expr(s.cond)
        globalRefs(s.body, out)
        break
      case 'repeat':
        globalRefs(s.body, out)
        expr(s.cond)
        break
      default:
        break
    }
  }
}

/** The POUs that use a VAR_GLOBAL without declaring it VAR_EXTERNAL, each as `POU (names)`. */
function globalsWithoutExternal(ast: Ast): string[] {
  const out: string[] = []
  const check = (where: string, decls: Decl[], body: Stmt[], exempt = new Set<string>()): void => {
    const declared = new Set(decls.filter((d) => d.section === 'VAR_EXTERNAL').map((d) => d.name.toUpperCase()))
    const used = new Set<string>()
    globalRefs(body, used)
    const missing = [...used].filter((n) => !declared.has(n.toUpperCase()) && !exempt.has(n.toUpperCase()))
    if (missing.length > 0) out.push(`${where} (${missing.join(', ')})`)
  }
  // the export writes the code outside every POU with whatever reaches the tags it declares
  if (ast.configuration) check('the code outside every POU', ast.decls, ast.body, new Set(controllerTags(ast).map((d) => d.name.toUpperCase())))
  else if (ast.programDefs.length === 0) check('the program', ast.decls, ast.body)
  for (const p of ast.programDefs) check(`PROGRAM ${p.name}`, p.decls, p.body)
  for (const fb of ast.fbDefs) check(`FUNCTION_BLOCK ${fb.name}`, fb.decls, fb.body)
  for (const fn of ast.funcDefs) check(`FUNCTION ${fn.name}`, fn.decls, fn.body)
  return out
}

/** Are a CONFIGURATION's PROGRAM lines written highest priority first, the instances with no task last? */
function programLinesInPriorityOrder(config: ConfigurationDef): boolean {
  const priority = new Map(config.tasks.map((t) => [t.name.toUpperCase(), t.priority ?? 0]))
  const ranks = config.programs.map((p) => (p.task === null ? Infinity : (priority.get(p.task.toUpperCase()) ?? 0)))
  return ranks.every((r, i) => i === 0 || ranks[i - 1]! <= r)
}

function exportWarnings(ast: Ast): string[] {
  const warnings: string[] = []
  const bodies = [ast.body, ...ast.programDefs.map((p) => p.body), ...ast.fbDefs.map((fb) => fb.body), ...ast.funcDefs.map((fn) => fn.body)]
  if (constantBounds(ast)) {
    warnings.push(
      'An array bound is written as a named CONSTANT. A 3rd-edition compiler may build that, but an IEC 2nd-edition compiler such as MATIEC calls it non-standard and refuses it unless told to allow it.',
    )
  }
  if (mixedInitLists(ast)) {
    warnings.push(
      'A starting value puts a [...] list inside a (field := ...) list, or field lists inside a [...] list. The values are right here, but MATIEC refuses the two kinds of list mixed in one starting value; set those elements in the program instead for such a target.',
    )
  }
  // object orientation: what each toolchain builds of it (docs/st-conformance.md)
  const oop = ast.interfaceDefs.length > 0 || ast.fbDefs.some((d) => d.methods?.length || d.extends || d.implements?.length) || usesReferences(ast)
  if (oop) {
    warnings.push(
      'The program uses IEC 3rd-edition object orientation or references (METHOD, EXTENDS, INTERFACE or REF_TO). A 3rd-edition compiler builds it; a 2nd-edition compiler such as MATIEC does not.',
    )
  }
  const ifaceVars = [...ast.decls, ...ast.globals, ...ast.fbDefs.flatMap((d) => [...d.decls, ...(d.methods ?? []).flatMap((m) => m.decls)]), ...ast.programDefs.flatMap((p) => p.decls)].filter((d) => isInterface(d.type))
  if (ifaceVars.length) {
    warnings.push(
      `'${ifaceVars[0]!.name}' is a variable of an interface type. STruC++ 0.6.2, the compiler OpenPLC's editor uses, does not yet (an instance assigned to one is refused), so such a program does not build for OpenPLC.`,
    )
  }
  if (ast.usesBits) {
    warnings.push(
      'A bit of an integer is addressed (Status.3, exported as Status.%X3). That is IEC 3rd-edition partial access: STruC++ reads it, a 2nd-edition compiler such as MATIEC does not.',
    )
  }
  const reordered = new Set<string>()
  someInBodies(bodies, (x) => {
    if (x.node === 'call' && x.reordered) reordered.add(x.name)
    return false
  })
  if (reordered.size > 0) {
    warnings.push(
      `${[...reordered].sort().join(', ')}: a standard function is called with its arguments named out of IEC's order. That is valid IEC and means the same here and in MATIEC, but STruC++, OpenPLC's compiler, binds a standard function's arguments by POSITION and ignores the names (LIMIT(MX := 9, IN := x, MN := 0) compiles as LIMIT(9, x, 0)). Write them in order - LIMIT(MN, IN, MX) - before exporting to OpenPLC.`,
    )
  }
  // measured (docs/st-conformance.md, under TIME): MATIEC converts between a TIME and a number in seconds,
  // both ways, where this engine and STruC++ (OpenPLC v4) count milliseconds
  const timeUnit = new Set<string>()
  someInBodies(bodies, (x) => {
    if (x.node === 'call' && convertsTimeAndNumber(x.name)) timeUnit.add(x.name.toUpperCase())
    return false
  })
  if (timeUnit.size > 0) {
    warnings.push(
      `${[...timeUnit].sort().join(', ')}: a conversion between a TIME and a number counts milliseconds here, as it does in STruC++ (OpenPLC v4), but MATIEC (OpenPLC v3) counts seconds, both ways: T#1500ms converts to 1 there, and 1500 to T#1500s. To run the same on every target, keep the value a TIME and compare it with a TIME literal: elapsed >= T#5s.`,
    )
  }
  warnings.push(...strucppWarnings(ast, bodies))
  const typeNamed = typeNamedVariables(ast)
  if (typeNamed.length > 0) {
    warnings.push(
      `${typeNamed.join(', ')}: a variable spelled like a declared type, function block or function (identifiers are case-insensitive). It is valid here, but a compiler that reads declared type names as keywords, as MATIEC does, refuses the declaration outright; rename it before exporting to such a target.`,
    )
  }
  // measured: MATIEC types every ARRAY spelled out in place as a type of its own, so it
  // refuses copying one whole array into another even when the two are declared identically, and
  // passing one into a FUNCTION's ARRAY input ("Data type incompatibility for value passed in
  // position 1") for the same reason
  const arrayInputs = ast.funcDefs.some((fn) => fn.decls.some((d) => d.section === 'VAR_INPUT' && isArray(d.type) && d.type.named === undefined))
  if (bodies.some(assignsWholeArray) || arrayInputs) {
    warnings.push(
      'A whole array is copied into another, or passed by value into a FUNCTION, with its ARRAY type written out in place. An IEC 2nd-edition compiler such as MATIEC gives every such declaration a type of its own and refuses both, and this subset cannot give an array type a name yet.',
    )
  }
  if (fbInsideAggregate(ast)) {
    warnings.push(
      'A function-block instance is kept inside an array or a struct field. A 3rd-edition compiler may build that, but an IEC 2nd-edition compiler such as MATIEC has no arrays or struct fields of function blocks and will refuse the file.',
    )
  }
  loopBoundWarnings(ast.body, 'the program', warnings)
  for (const p of ast.programDefs) loopBoundWarnings(p.body, `PROGRAM ${p.name}`, warnings)
  for (const fb of ast.fbDefs) loopBoundWarnings(fb.body, `FUNCTION_BLOCK ${fb.name}`, warnings)
  for (const fn of ast.funcDefs) loopBoundWarnings(fn.body, `FUNCTION ${fn.name}`, warnings)
  const ilNames = reservedNames(ast, IL_OPERATOR_NAMES)
  if (ilNames.length > 0) {
    warnings.push(
      `${ilNames.join(', ')}: this name is an Instruction List operator, and a toolchain that reads both languages (MATIEC does) reserves it as a keyword even in ST. The program is valid here and will not build there - rename before exporting to such a target.`,
    )
  }
  const sfcNames = reservedNames(ast, SFC_KEYWORD_NAMES)
  if (sfcNames.length > 0) {
    warnings.push(
      `${sfcNames.join(', ')}: this name is a Sequential Function Chart keyword, and a toolchain that also reads SFC (MATIEC does) reserves it even in ST. The program is valid here and will not build there; rename it before exporting to such a target.`,
    )
  }
  const calendarNames = reservedNames(ast, CALENDAR_TYPE_WORDS)
  if (calendarNames.length > 0) {
    warnings.push(
      `${calendarNames.join(', ')}: this name is an IEC elementary type (DATE, TOD / TIME_OF_DAY, DT / DATE_AND_TIME), which every IEC compiler reserves; MATIEC refuses it as a variable name. It is allowed here so that older programs keep working; rename it before exporting to such a target.`,
    )
  }
  const undeclared = globalsWithoutExternal(ast)
  if (undeclared.length > 0) {
    warnings.push(
      `${undeclared.join('; ')}: a POU uses a VAR_GLOBAL or a top-level variable without declaring it in VAR_EXTERNAL. This engine allows it; IEC wants the declaration, so add it before exporting to a target whose compiler is strict.`,
    )
  }
  // measured: `PROGRAM Main WITH MainTask : Main;` is "invalid program name defined in program
  // configuration" to MATIEC, whose lexer reads a declared type name as that type's token. Other tools name
  // instances that way, and so does the organizer, so it is a warning and not a refusal
  const typeNames = new Set(ast.programDefs.map((p) => p.name.toUpperCase()))
  const typeNamedInstances = (ast.configuration?.programs ?? []).filter((p) => typeNames.has(p.name.toUpperCase())).map((p) => p.name)
  if (typeNamedInstances.length > 0) {
    warnings.push(
      `${typeNamedInstances.join(', ')}: a program instance spelled like a PROGRAM type. That is valid, but MATIEC refuses the CONFIGURATION ("invalid program name"); rename the instance before exporting to such a target.`,
    )
  }
  if (ast.configuration && !programLinesInPriorityOrder(ast.configuration)) {
    warnings.push(
      "The CONFIGURATION's PROGRAM lines are not in priority order. When tasks come due together this engine runs them by PRIORITY, but MATIEC ignores PRIORITY and runs the instances in the order their PROGRAM lines are written, so put higher-priority instances first (and any with no task last) for such a target.",
    )
  }
  if (ast.ladder.length > 0) {
    warnings.push(
      'The ladder diagram goes out as the Structured Text it runs as here: IEC defines no text for LD, so a text file carries its logic, not its rungs. Its temporaries are declared in a VAR block of their own (LD_C for a rung condition held across a write, LD_E and LD_M for an edge and its memory, LD_R for the result of a function that starts a rung).',
    )
    for (const gap of new Set(ast.ladder.flatMap(ladderExportCaveats))) warnings.push(gap)
  }
  // a variable named S or R (either case): some toolchains have S= and R= set / reset assignments and may reserve
  // the two letters. IEC reserves neither, so this engine runs them
  const setReset = setResetNames(ast)
  if (setReset.length > 0) {
    warnings.push(
      `${setReset.join(', ')}: a variable named S or R. Some targets reserve those two letters for set and reset (S=, R=), so the program may not build there as written; rename ${setReset.length === 1 ? 'it' : 'them'} (Set, Reset, ...) before exporting to such a target.`,
    )
  }
  if (ast.subrangeDefs.length > 0) {
    warnings.push(
      'Subrange bounds are exported, but not every target enforces them at run time the way the simulator does (it faults the scan on an out-of-range store).',
    )
  }
  // measured: MATIEC reads a VAR block as either all located or all ordinary, the way IEC's
  // grammar writes them ("invalid located variable declaration"); STruC++ takes a mix
  const mixed = mixedLocatedBlocks(ast)
  if (mixed.length > 0) {
    warnings.push(
      `${mixed.join(', ')}: a VAR block holds both located (AT %...) and ordinary variables. STruC++ (the compiler OpenPLC ships) builds that, but an IEC 2nd-edition compiler such as MATIEC takes located declarations only in a VAR block of their own; split the block before exporting to such a target.`,
    )
  }
  return warnings
}

/** Every variable or parameter named S or R, with the POU that declares it (`S in Main`), the engine's own hidden
 *  temporaries left out. */
function setResetNames(ast: Ast): string[] {
  const named = (decls: readonly Decl[], where: string): string[] => decls.filter((d) => !d.hidden && /^[SR]$/i.test(d.name)).map((d) => (where === '' ? d.name : `${d.name} in ${where}`))
  return [
    ...named(ast.globals, ''),
    ...named(ast.decls, ''),
    ...ast.programDefs.flatMap((p) => named(p.decls, p.name)),
    ...ast.fbDefs.flatMap((b) => named(b.decls, b.name)),
    ...ast.funcDefs.flatMap((f) => named(f.decls, f.name)),
  ]
}

/** The first located variable of each VAR block that mixes located and ordinary declarations. */
function mixedLocatedBlocks(ast: Ast): string[] {
  const out: string[] = []
  const lists = [ast.globals, ast.decls, ...ast.programDefs.map((p) => p.decls)]
  for (const decls of lists) {
    const byBlock = new Map<number, Decl[]>()
    for (const d of decls) if (d.block !== undefined) byBlock.set(d.block, [...(byBlock.get(d.block) ?? []), d])
    for (const block of byBlock.values()) {
      const located = block.find((d) => d.location !== undefined)
      if (located && block.some((d) => d.location === undefined)) out.push(located.name)
    }
  }
  return out
}

/**
 * The program with every LADDER section replaced by the ST it lowers to (ladder.ts), and each POU holding one
 * given the VAR block that ST's temporaries need. LADDER is this engine's text for a ladder diagram, which no IEC
 * toolchain reads; the ST is the same text the engine parsed and ran, so what goes out is what was simulated.
 * (exportText.ts cannot do this itself: it stays import-free for the MATIEC oracle, and this needs the parser.)
 */
export function withoutLadder(source: string): string {
  const sections = ladderSections(source)
  return sections.length === 0 ? source : expandLadder(source, sections)
}

/** The LADDER sections of `source`, as its parse finds them (none, cheaply, when it has none). */
function ladderSections(source: string): LdSection[] {
  return /\bLADDER\b/i.test(source) ? parse(lex(source), []).ladder : []
}

/**
 * What a program's text holds that not every IEC toolchain reads, respelled before anything is exported: the vendor
 * spellings the parser accepts, and `Tag.3` written as IEC's `Tag.%X3`. A program with neither comes back as it
 * was, untouched.
 */
function portableText(source: string): string {
  source = foldedCapacities(source)
  // the non-IEC spellings the parser accepts, written back in IEC form (exportText.ts `canonicalSyntax`)
  source = canonicalSyntax(source)
  return /\.\s*\d/.test(source) ? expandBits(source) : source
}

/**
 * `STRING(MAX_LEN)` written as `STRING[5]`: a capacity given as a constant expression, which the engine reads and IEC
 * does not have (its capacity is an integer), replaced by the integer it folds to. Only a program that writes one is
 * parsed and checked here. One that does not compile is left as it is, for the check after this to report.
 */
function foldedCapacities(source: string): string {
  if (!/\bW?STRING[ \t]*[[(](?![ \t]*\d+[ \t]*[\])])/i.test(source)) return source
  let ast: Ast
  try {
    ast = parseAndCheck(source).ast
  } catch {
    return source
  }
  const spans = ast.capacitySpans ?? []
  const values = ast.capacityValues ?? []
  let out = source
  for (let k = spans.length - 1; k >= 0; k--) {
    const s = spans[k]!
    const v = values[k]
    if (v === undefined) continue
    out = `${out.slice(0, s.start)}[${v}]${out.slice(s.end)}`
  }
  return out
}

/** The program without what the PLCopen motion library merged into it (plc/motionPrelude.ts): on a real controller
 *  those blocks and AXIS_REF come from the vendor's motion library, so no export writes or warns about them as the
 *  program's own. Checked first, with them in, since the program's calls are checked against them. */
function programOnly(ast: Ast): Ast {
  const own = <T extends { library?: true }>(defs: T[]): T[] => defs.filter((d) => !d.library)
  return { ...ast, typeDefs: own(ast.typeDefs), enumDefs: own(ast.enumDefs), funcDefs: own(ast.funcDefs), fbDefs: own(ast.fbDefs) }
}

/** Whether a program declares a REF_TO anywhere: a variable of a POU or of a method, or a global. */
function usesReferences(ast: Ast): boolean {
  const decls = [...ast.decls, ...ast.globals, ...ast.fbDefs.flatMap((d) => [...d.decls, ...(d.methods ?? []).flatMap((m) => m.decls)]), ...ast.programDefs.flatMap((p) => p.decls)]
  return decls.some((d) => isRef(d.type))
}

/** What a program using the motion library needs on the target, said once. */
function motionLibraryWarning(ast: Ast): string[] {
  if (!ast.fbDefs.some((d) => d.library)) return []
  return [
    'Uses the PLCopen motion blocks (MC_Power, MC_MoveAbsolute, ...), which the file names but does not define: the target needs its own PLCopen motion library, with each axis set up there as that library asks and named as the axis variable in the program. Then drop the AXIS_REF variables from the program: on the target the axes are devices.',
  ]
}

/** Export a program for a target. Throws a positioned `StError` if it does not compile -
 *  otherwise an invalid program could reach a real PLC as a broken file. */
export function exportProgram(source: string, target: ExportTarget, opts: ExportOptions = {}): ExportResult {
  source = portableText(source)
  const o = { ...DEFAULTS, ...opts }
  const checked = parseAndCheck(source).ast
  const ast = programOnly(checked)
  const warnings = [...motionLibraryWarning(checked), ...exportWarnings(ast)]
  if (target === 'plcopen-xml') {
    // A POU is one language in PLCopen (and in every IEC tool): its body is ST or LD. A POU that is only a ladder goes
    // out as an <LD> body. One that mixes statements and a LADDER section (only this engine reads that) can only go
    // out as ST, so its rungs arrive as the logic they run as, not as rungs. The warning names each such POU.
    const mixed = [...new Set(ast.ladder.filter((s) => !s.whole).map((s) => s.pou || 'the code outside every POU'))]
    if (mixed.length > 0) warnings.push(`${mixed.join(', ')} ${mixed.length === 1 ? 'mixes' : 'mix'} Structured Text with a ladder section. A PLCopen POU is one language, so ${mixed.length === 1 ? 'it goes' : 'they go'} out as Structured Text, the rungs as the statements they run as: keep a POU all ladder or all Structured Text to export it as drawn.`)
    return { content: toPlcopenXml(source, o), filename: `${slug(o.projectName)}.xml`, warnings }
  }
  return { content: renderIecText(withoutLadder(source), o), filename: `${slug(o.projectName)}.st`, warnings }
}
