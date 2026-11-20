// Import from PLCopen TC6 XML: the format another IEC tool's project export produces, where `importText.ts`
// covers a spec-legal `.st` file.
//
// The transform is `toPlcopenXml` run backwards. Each `<pou>` becomes a block, each `<dataType>` a `TYPE`
// declaration, the configuration's `<globalVars>` a `VAR_GLOBAL` block, and the program POU's interface and body
// this engine's implicit program. The blocks go through `flattenDocument` (document.ts), so the composition rule
// lives in one place.
//
// What cannot be imported is named in the notes, never dropped silently, as in the text importer. A real file
// carries things this subset has no equivalent for (ladder and FBD bodies, actions, methods, vendor `addData`
// blobs), and a program that means something other than what its author wrote is worse than one that refuses.
//
// Order cannot be preserved: PLCopen keeps `<dataTypes>` and `<pous>` in separate containers, so a `TYPE`
// written between two function blocks has nowhere to record that. It is an unavoidable loss, like the text
// target's `VAR_GLOBAL` hoist.

import { flattenDocument } from '../document'
import { OIP_XML, readLdBody } from '../ladder/ladderXml'
import type { StBlock } from '../document'
import type { ImportResult } from './importText'
import { SCALAR_TYPES } from '../types'
import { parseXml as parseXmlAs, xmlKid, xmlKids, type XmlNode } from '../../core/xml'

/** Parse a PLCopen document into its root element. Throws on malformed input: unlike half-written ST, an XML file
 *  that does not parse is not a program in progress, it is the wrong file. */
export const parseXml = (src: string): XmlNode => parseXmlAs(src, 'PLCopen import')

const kids = xmlKids
const kid = xmlKid

/** Follow a chain of single child elements: `at(project, 'types', 'pous')`. */
function at(n: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  return path.reduce<XmlNode | undefined>((cur, name) => kid(cur, name), n)
}

// ---- PLCopen -> Structured Text ----

/** Elementary type elements, by their TC6 spelling (`<string/>` is lowercase, `<INT/>` is not). */
function elementaryName(name: string): string | null {
  const up = name.toUpperCase()
  if (up === 'STRING' || up === 'WSTRING') return up
  return (SCALAR_TYPES as readonly string[]).includes(up) ? up : null
}

/**
 * The ST spelling of a `<type>` / `<baseType>` element's content.
 *
 * Returns `null` for a shape the subset has no spelling for, so the caller can name it rather
 * than emit a declaration that means something else.
 */
function typeSpec(holder: XmlNode | undefined): string | null {
  for (const c of holder?.children ?? []) {
    if (c.name === 'derived') return c.attrs.name ?? null
    // TC6's `<pointer>`: IEC's REF_TO
    if (c.name === 'pointer') {
      const target = typeSpec(kid(c, 'baseType'))
      return target ? `REF_TO ${target}` : null
    }
    // a variable's own enumeration, `m : (Idle, Run)` (IEC's enumerated_spec_init)
    if (c.name === 'enum') {
      // a value spelled only where it is not the one before it plus one, as the parser names it (EnumDef.inline)
      let next = 0
      const values = kids(kid(c, 'values'), 'value').map((v) => {
        const n = v.attrs.value === undefined ? next : Number(v.attrs.value)
        const text = n === next ? `${v.attrs.name}` : `${v.attrs.name} := ${v.attrs.value}`
        next = n + 1
        return text
      })
      return values.length > 0 ? `(${values.join(', ')})` : null
    }
    if (c.name === 'array') {
      const dims = kids(c, 'dimension').map((d) => `${d.attrs.lower ?? '0'}..${d.attrs.upper ?? '0'}`)
      const elem = typeSpec(kid(c, 'baseType'))
      return dims.length > 0 && elem ? `ARRAY [${dims.join(', ')}] OF ${elem}` : null
    }
    const el = elementaryName(c.name)
    if (el === 'STRING' || el === 'WSTRING') {
      // PLCopen carries the capacity as an attribute; ST puts it on the declaration
      return c.attrs.length ? `${el}[${c.attrs.length}]` : el
    }
    if (el) return el
  }
  return null
}

/** A TC6 initial value as ST: a `simpleValue` as written, an `arrayValue` as a `[...]` list (a
 *  repetition kept), a `structValue` as a `(field := ...)` list. Undefined for anything else. */
function initialValueText(holder: XmlNode | undefined): string | undefined {
  const simple = kid(holder, 'simpleValue')
  if (simple) return simple.attrs.value
  const arr = kid(holder, 'arrayValue')
  if (arr) {
    const items = kids(arr, 'value').map((v) => {
      const inner = initialValueText(v)
      const rep = v.attrs.repetitionValue
      return rep !== undefined && inner !== undefined ? `${rep}(${inner})` : inner
    })
    return items.every((x) => x !== undefined) ? `[${items.join(', ')}]` : undefined
  }
  const st = kid(holder, 'structValue')
  if (st) {
    const fields = kids(st, 'value').map((v) => {
      const inner = initialValueText(v)
      return inner === undefined ? undefined : `${v.attrs.member} := ${inner}`
    })
    return fields.every((x) => x !== undefined) ? `(${fields.join(', ')})` : undefined
  }
  return undefined
}

/** `<variable>` -> one declaration line, or null when its type has no ST spelling. A located variable
 *  (TC6's `address` attribute) keeps its address: `name AT %IX0.0 : BOOL;`. */
function variableDecl(v: XmlNode): { text: string | null; name: string; address?: string } {
  const name = v.attrs.name ?? ''
  const address = v.attrs.address
  const spec = typeSpec(kid(v, 'type'))
  if (!spec) return { text: null, name, address }
  const init = initialValueText(at(v, 'initialValue'))
  return { text: `  ${name}${address ? ` AT ${address}` : ''} : ${spec}${init !== undefined ? ` := ${init}` : ''};`, name, address }
}

/** The PLCopen interface element -> its IEC `VAR` keyword. */
const SECTION_KEYWORD: Record<string, string> = {
  localVars: 'VAR',
  inputVars: 'VAR_INPUT',
  outputVars: 'VAR_OUTPUT',
  inOutVars: 'VAR_IN_OUT',
  tempVars: 'VAR_TEMP',
  globalVars: 'VAR_GLOBAL',
  externalVars: 'VAR_EXTERNAL',
}

/** Every declaration section of an `<interface>` (or a configuration), in IEC spelling. */
function varSections(holder: XmlNode | undefined, notes: Notes, where: string): string[] {
  const out: string[] = []
  for (const section of holder?.children ?? []) {
    const keyword = SECTION_KEYWORD[section.name]
    if (!keyword) continue
    const lines: string[] = []
    for (const v of kids(section, 'variable')) {
      const d = variableDecl(v)
      // an address crosses as written (an input or output the scene binds, or memory the program keeps); an
      // incomplete one is linked in the target's I/O configuration, here the scene's wiring (types.ts Decl.linked)
      if (d.address && /\*$/.test(d.address)) {
        notes.add(`${where}: '${d.name}' has an incomplete address (${d.address}), which the target's I/O configuration completes. Here it is a plain variable: wire a part to it by name.`)
      }
      if (d.text === null) notes.add(`${where}: '${d.name}' has a type this subset cannot spell, and was left out.`)
      else lines.push(d.text)
    }
    if (lines.length === 0) continue
    const constant = section.attrs.constant === 'true' ? ' CONSTANT' : ''
    const retain = section.attrs.retain === 'true'
    if (retain) notes.add(`${where}: RETAIN was declared. Retention is a target concern; this engine does not persist variables across a restart.`)
    out.push(`${keyword}${constant}\n${lines.join('\n')}\nEND_VAR`)
  }
  return out
}

/** `<dataType>` -> a `TYPE ... END_TYPE` block, or null when the shape has no ST spelling. */
function dataTypeBlock(dt: XmlNode, notes: Notes): string | null {
  const name = dt.attrs.name ?? ''
  const base = kid(dt, 'baseType')
  const struct = kid(base, 'struct')
  if (struct) {
    const fields = kids(struct, 'variable').map((v) => {
      const spec = typeSpec(kid(v, 'type'))
      if (!spec) notes.add(`TYPE ${name}: field '${v.attrs.name}' has a type this subset cannot spell, and was left out.`)
      const init = initialValueText(at(v, 'initialValue'))
      return spec ? `${v.attrs.name} : ${spec}${init !== undefined ? ` := ${init}` : ''};` : null
    })
    const kept = fields.filter((f): f is string => f !== null)
    return kept.length > 0 ? `TYPE ${name} : STRUCT ${kept.join(' ')} END_STRUCT; END_TYPE` : null
  }
  const enumEl = kid(base, 'enum')
  if (enumEl) {
    const values = kids(at(enumEl, 'values'), 'value').map((v) =>
      v.attrs.value !== undefined ? `${v.attrs.name} := ${v.attrs.value}` : `${v.attrs.name}`,
    )
    return values.length > 0 ? `TYPE ${name} : (${values.join(', ')}); END_TYPE` : null
  }
  for (const el of ['subrangeSigned', 'subrangeUnsigned']) {
    const sub = kid(base, el)
    if (!sub) continue
    const inner = typeSpec(kid(sub, 'baseType'))
    const range = kid(sub, 'range')
    if (inner && range) return `TYPE ${name} : ${inner} (${range.attrs.lower}..${range.attrs.upper}); END_TYPE`
  }
  // an array, an elementary type or another derived type, given a name of its own
  const spec = typeSpec(base)
  if (spec) return `TYPE ${name} : ${spec}; END_TYPE`
  notes.add(`TYPE ${name}: a data type shape this subset does not have was skipped.`)
  return null
}

/** The text an element holds, its descendants' included. */
const deepText = (n: XmlNode): string => n.text + n.children.map(deepText).join('')

/** The ST text of a `<body>`: typed ST as it is, a ladder diagram as the LADDER section that draws it (ladderXml.ts),
 *  or null for a body drawn in another language, or a ladder a rung here cannot express. */
function bodyText(pou: XmlNode, notes: Notes): string | null {
  const body = kid(pou, 'body')
  const ld = kid(body, 'LD')
  if (ld) return readLdBody(ld, pou.attrs.name ?? '', (m) => notes.add(m))
  const st = kid(body, 'ST')
  if (st) {
    // The code sits in whatever the writer chose: an `<xhtml>` element (ours), `<xhtml:p>` (OpenPLC
    // and a current Beremiz; the parser has already cut it to `p`), or bare text in `<ST>` (older
    // Beremiz). Reading only `<xhtml>` would return an empty body for `<xhtml:p>`, with no note;
    // the import oracle checks bodies arrive, against a file OpenPLC wrote.
    const text = st.children.length > 0 ? st.children.map(deepText).join('\n') : st.text
    return text.trim()
  }
  const drawn = (body?.children ?? []).find((c) => ['FBD', 'LD', 'SFC', 'IL'].includes(c.name.toUpperCase()))
  if (drawn) {
    notes.add(`POU '${pou.attrs.name}' has a ${drawn.name.toUpperCase()} body. Only Structured Text and ladder diagrams can be imported, so this POU was left out - rewrite it in ST or LD on the source toolchain and export again.`)
  } else {
    notes.add(`POU '${pou.attrs.name}' has no Structured Text body, and was left out.`)
  }
  return null
}

// ---- object orientation, from TC6's addData extension point ----
//
// TC6 2.01 has no METHOD, INTERFACE or inheritance, so a file carries them in `addData`, under a name that says whose
// form it is. Two forms are read:
//   - this project's own (OIP_XML, what export.ts writes): a block's header as attributes, and each METHOD and
//     INTERFACE as the Structured Text it was written in;
//   - the form other toolchains' PLCopen exports use (OTHER_XML below): each member spelled out in TC6-like elements
//     (an `<interface>` of typed variables and an ST `<body>`), access words as attributes. Read for interoperability,
//     so such a file arrives with its object orientation instead of losing it.

/** The `<data>` entries of an element's `<addData>` whose name is `stem` + `kind`, each one's content element. */
function addDataOf(holder: XmlNode | undefined, stem: string, kind: string): XmlNode[] {
  return kids(kid(holder, 'addData'), 'data')
    .filter((d) => d.attrs.name === `${stem}${kind}`)
    .flatMap((d) => d.children)
}

/** Our own addData kinds (export.ts writes them). */
const OIP_STEM = `${OIP_XML}/`

/** The namespace stem of the other form of OO addData found in PLCopen files written elsewhere. */
const OTHER_XML = 'http://www.3s-software.com/plcopenxml/'

const WHOLE = {
  METHOD: /^METHOD\b[\s\S]*\bEND_METHOD\s*;?$/i,
  INTERFACE: /^INTERFACE\b[\s\S]*\bEND_INTERFACE\s*;?$/i,
}

/** One of our `<method>` / `<interface>` elements: the ST it carries, when it is the whole construct it claims to be. */
function oipText(node: XmlNode, word: 'METHOD' | 'INTERFACE', notes: Notes, where: string): string {
  const text = node.text.trim()
  if (WHOLE[word].test(text)) return text
  notes.add(`${where} carries a ${word} '${node.attrs.name ?? ''}' that is not ${word} ... END_${word} text, so it was left out.`)
  return ''
}

/** ABSTRACT / FINAL and the access word an element's interface carries, in the other form's `<AccessModifiers>`. */
function modifiers(iface: XmlNode | undefined): string[] {
  const m = addDataOf(iface, OTHER_XML, 'accessmodifiers')[0]?.attrs ?? {}
  const words: string[] = []
  if (m.Private === 'true') words.push('PRIVATE')
  if (m.Protected === 'true') words.push('PROTECTED')
  if (m.Internal === 'true') words.push('INTERNAL')
  if (m.Abstract === 'true') words.push('ABSTRACT')
  if (m.Final === 'true') words.push('FINAL')
  return words
}

/** A `<Method>` of the other form as ST; `signature`: an interface's, which has no statements. */
function methodText(m: XmlNode, notes: Notes, where: string, signature: boolean): string {
  const iface = kid(m, 'interface')
  const ret = typeSpec(kid(iface, 'returnType'))
  const mods = signature ? [] : modifiers(iface)
  const body = signature || mods.includes('ABSTRACT') ? '' : (bodyText(m, notes) ?? '')
  return [`METHOD ${[...mods, m.attrs.name ?? ''].join(' ')}${ret ? ` : ${ret}` : ''}`, ...varSections(iface, notes, `${where} METHOD '${m.attrs.name}'`), body, 'END_METHOD'].filter((x) => x !== '').join('\n')
}

/** A `<Property>` of the other form: left out, said by name. PROPERTY is not part of IEC 61131-3. */
function propertyNote(p: XmlNode, notes: Notes, where: string): string {
  notes.add(`${where} has a PROPERTY '${p.attrs.name ?? ''}', which was left out: PROPERTY is not part of IEC 61131-3. Rewrite it as a METHOD (or a pair of methods).`)
  return ''
}

/** An `<Interface>` of the other form as ST. A base in the `__SYSTEM` namespace is a runtime's own root interface,
 *  no interface of the program's, and is left out. */
function interfaceText(i: XmlNode, notes: Notes): string {
  const where = `INTERFACE '${i.attrs.name}'`
  const ext = kids(kid(i, 'Inheritance'), 'Extends')
    .map((x) => x.text.trim())
    .filter((x) => x !== '' && !/^__SYSTEM\./i.test(x))
  return [
    `INTERFACE ${i.attrs.name ?? ''}${ext.length ? ` EXTENDS ${ext.join(', ')}` : ''}`,
    ...kids(kid(i, 'Methods'), 'Method').map((m) => methodText(m, notes, where, true)),
    ...kids(kid(i, 'Properties'), 'Property').map((p) => propertyNote(p, notes, where)),
    'END_INTERFACE',
  ].join('\n')
}

/** Deduplicating note list: one message per distinct problem, however many times it occurs. */
class Notes {
  #seen = new Set<string>()
  readonly list: string[] = []
  add(note: string): void {
    if (this.#seen.has(note)) return
    this.#seen.add(note)
    this.list.push(note)
  }
}

/** Milliseconds in a TC6 `interval` attribute (`T#40ms`, `PT40MS`, `40ms`). */
function intervalMs(text: string): number | null {
  const t = text.trim().replace(/^(TIME|T)#/i, '')
  // the ISO-8601-ish spelling TC6 also permits
  const iso = /^PT?([\d.]+)(H|M|S|MS)$/i.exec(t)
  const plain = /^([\d.]+)\s*(h|m|s|ms)$/i.exec(t)
  const m = plain ?? iso
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2]!.toLowerCase()
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60000 : n * 3600000
}

/**
 * Read a PLCopen TC6 XML project into a program this engine can run.
 *
 * Throws when the file is not parseable XML or carries no `<project>`. That is the wrong file,
 * not a program in progress, and guessing at it could silently produce a different program.
 */
/**
 * A TC6 configuration as the IEC text this engine runs: each resource with its tasks, the instances
 * each task runs, and the instances that run on no task. What would not run is kept AND named: an
 * event task, a second resource, an interval nobody can read.
 */
function configurationText(config: XmlNode, resources: XmlNode[], notes: Notes): string {
  const lines = [`CONFIGURATION ${config.attrs.name ?? 'Config0'}`]
  if (resources.length > 1) {
    notes.add(`${resources.length} RESOURCEs were declared; a controller here is one RESOURCE, so move every task and program instance into one before running it.`)
  }
  for (const r of resources) {
    lines.push(`  RESOURCE ${r.attrs.name ?? 'Res0'} ON PLC`)
    const tasks = kids(r, 'task')
    for (const t of tasks) {
      const args: string[] = []
      if (t.attrs.single) {
        args.push(`SINGLE := ${t.attrs.single}`)
        notes.add(`TASK '${t.attrs.name}' is an event task (SINGLE := ${t.attrs.single}); this engine runs periodic tasks and continuous programs only, so give it an INTERVAL before running it.`)
      }
      if (t.attrs.interval) {
        const ms = intervalMs(t.attrs.interval)
        if (ms === null) notes.add(`Could not read the interval ${t.attrs.interval} of TASK '${t.attrs.name}'; it was written back as given.`)
        args.push(`INTERVAL := ${ms === null ? t.attrs.interval : `T#${ms}ms`}`)
      }
      args.push(`PRIORITY := ${t.attrs.priority ?? 0}`)
      lines.push(`    TASK ${t.attrs.name}(${args.join(', ')});`)
    }
    for (const t of tasks) for (const i of kids(t, 'pouInstance')) lines.push(`    PROGRAM ${i.attrs.name} WITH ${t.attrs.name} : ${i.attrs.typeName};`)
    for (const i of kids(r, 'pouInstance')) lines.push(`    PROGRAM ${i.attrs.name} : ${i.attrs.typeName};`)
    lines.push('  END_RESOURCE')
  }
  lines.push('END_CONFIGURATION')
  return lines.join('\n')
}

export function importPlcopenXml(xml: string): ImportResult {
  const notes = new Notes()
  const project = parseXml(xml)
  if (project.name !== 'project') {
    throw new Error(`PLCopen import: expected a <project> root, found <${project.name}>.`)
  }

  const blocks: StBlock[] = []

  // ---- 1. the configuration: globals, tasks and program instances ----
  const configs = kids(at(project, 'instances', 'configurations'), 'configuration')
  if (configs.length > 1) {
    notes.add(`${configs.length} CONFIGURATIONs were declared; a file here holds one controller, so only the first was read.`)
  }
  const config = configs[0]
  const resources = kids(config, 'resource')
  const tasks = resources.flatMap((r) => kids(r, 'task'))
  const instances = resources.flatMap((r) => [...kids(r, 'pouInstance'), ...kids(r, 'task').flatMap((t) => kids(t, 'pouInstance'))])
  const pous = kids(at(project, 'types', 'pous'), 'pou')
  const programs = pous.filter((p) => p.attrs.pouType === 'program')
  // More than one of any of these is a controller, which this engine runs as declared: every PROGRAM
  // keeps its name and the CONFIGURATION says what runs when. Otherwise the one program crosses as the
  // implicit program, as it always has, and its variables keep their bare names.
  const controller = programs.length > 1 || instances.length > 1 || tasks.length > 1 || resources.length > 1
  let scanMs: number | null = null
  let programTypeName: string | null = null
  if (config) {
    for (const g of varSections(config, notes, 'CONFIGURATION')) blocks.push({ kind: 'global', name: '', text: g })
    for (const r of resources) for (const g of varSections(r, notes, 'RESOURCE')) blocks.push({ kind: 'global', name: '', text: g })
    if (!controller) {
      const interval = tasks[0]?.attrs.interval
      if (interval) {
        const ms = intervalMs(interval)
        if (ms !== null && ms > 0) scanMs = Math.round(ms)
        else notes.add(`Could not read the TASK interval ${interval}; the scan time is unchanged.`)
      }
      programTypeName = instances[0]?.attrs.typeName ?? null
    }
  }

  // ---- 2. data types ----
  for (const dt of kids(at(project, 'types', 'dataTypes'), 'dataType')) {
    const text = dataTypeBlock(dt, notes)
    if (text) blocks.push({ kind: 'type', name: dt.attrs.name ?? '', text })
  }

  // ---- 2b. interfaces (kept in the project's addData), before every block that implements one ----
  for (const i of addDataOf(project, OIP_STEM, 'interface')) {
    const text = i.name === 'interface' ? oipText(i, 'INTERFACE', notes, 'The project') : ''
    if (text) blocks.push({ kind: 'type', name: i.attrs.name ?? '', text })
  }
  for (const i of addDataOf(project, OTHER_XML, 'interface')) {
    if (i.name === 'Interface') blocks.push({ kind: 'type', name: i.attrs.name ?? '', text: interfaceText(i, notes) })
  }

  // ---- 3. POUs ----
  // a single program is the one the configuration names, or the only one there is
  const main = controller ? undefined : (programs.find((p) => p.attrs.name === programTypeName) ?? programs[0])

  for (const pou of pous) {
    const name = pou.attrs.name ?? ''
    if (kid(pou, 'actions') || kid(pou, 'transitions')) {
      notes.add(`POU '${name}' declares actions or transitions (SFC structure), which this subset does not have. Only its body was read.`)
    }
    if (kid(pou, 'methods') || kid(at(pou, 'interface'), 'methods')) {
      notes.add(`POU '${name}' declares METHODs in a form this importer does not read (only an addData form is), so they were left out.`)
    }
    if (pou.attrs.pouType === 'program') {
      if (!controller) continue // handled below, as the implicit program
      const body = bodyText(pou, notes)
      const sections = varSections(kid(pou, 'interface'), notes, `PROGRAM '${name}'`)
      blocks.push({ kind: 'program', name, text: [`PROGRAM ${name}`, ...sections, body ?? '', 'END_PROGRAM'].filter((s) => s !== '').join('\n') })
      continue
    }

    const body = bodyText(pou, notes)
    if (body === null) continue
    const iface = kid(pou, 'interface')
    const sections = varSections(iface, notes, `POU '${name}'`)
    if (pou.attrs.pouType === 'function') {
      const ret = typeSpec(kid(iface, 'returnType'))
      if (!ret) {
        notes.add(`FUNCTION '${name}' has a return type this subset cannot spell, and was left out.`)
        continue
      }
      blocks.push({ kind: 'function', name, text: [`FUNCTION ${name} : ${ret}`, ...sections, body, 'END_FUNCTION'].join('\n') })
    } else if (pou.attrs.pouType === 'functionBlock') {
      // object orientation: what it derives from and implements, ABSTRACT / FINAL, its methods, in either form
      const where = `FUNCTION_BLOCK '${name}'`
      const ours = addDataOf(pou, OIP_STEM, 'functionblock').find((n) => n.name === 'functionBlock')?.attrs
      const inheritance = addDataOf(iface, OTHER_XML, 'pouinheritance')[0]
      const ext = ours?.extends?.trim() || kids(inheritance, 'Extends').map((x) => x.text.trim()).filter((x) => x !== '')[0]
      const impl = [...(ours?.implements ?? '').split(','), ...kids(inheritance, 'Implements').map((x) => x.text)].map((x) => x.trim()).filter((x) => x !== '')
      const words = [...(ours?.abstract === 'true' ? ['ABSTRACT'] : []), ...(ours?.final === 'true' ? ['FINAL'] : []), ...modifiers(iface).filter((w) => w === 'ABSTRACT' || w === 'FINAL')]
      const head = `FUNCTION_BLOCK ${[...new Set(words), name].join(' ')}${ext ? ` EXTENDS ${ext}` : ''}${impl.length ? ` IMPLEMENTS ${impl.join(', ')}` : ''}`
      const members = [
        ...addDataOf(pou, OIP_STEM, 'method').filter((m) => m.name === 'method').map((m) => oipText(m, 'METHOD', notes, where)),
        ...addDataOf(pou, OTHER_XML, 'method').map((m) => methodText(m, notes, where, false)),
        ...addDataOf(pou, OTHER_XML, 'property').map((p) => propertyNote(p, notes, where)),
      ]
      blocks.push({ kind: 'functionBlock', name, text: [head, ...sections, ...members, body, 'END_FUNCTION_BLOCK'].filter((x) => x !== '').join('\n') })
    } else {
      notes.add(`POU '${name}' has an unrecognised pouType '${pou.attrs.pouType}', and was left out.`)
    }
  }

  // ---- 4. the program itself: a controller's CONFIGURATION, or the implicit program ----
  if (controller) {
    if (config) blocks.push({ kind: 'program', name: '', text: configurationText(config, resources, notes) })
    else notes.add(`${programs.length} PROGRAMs were declared and no configuration says which task runs each. They were loaded as written; add a CONFIGURATION before running them.`)
  } else if (main) {
    const body = bodyText(main, notes)
    const sections = varSections(kid(main, 'interface'), notes, `PROGRAM '${main.attrs.name}'`)
    const text = [...sections, body ?? ''].filter((s) => s !== '').join('\n')
    if (text !== '') blocks.push({ kind: 'program', name: '', text })
  } else {
    notes.add('No PROGRAM was declared in this file, so there is no program body - only the definitions were imported.')
  }

  // (interfaces are read above, in either form; anything else there is a toolchain's own setting)
  if (kids(kid(project, 'addData'), 'data').some((d) => d.attrs.name !== `${OIP_STEM}interface` && d.attrs.name !== `${OTHER_XML}interface`)) {
    notes.add('The file carries vendor addData sections. Those hold toolchain-specific settings with no portable meaning, and were ignored.')
  }

  return { source: `${flattenDocument({ blocks })}\n`, notes: notes.list, scanMs }
}
