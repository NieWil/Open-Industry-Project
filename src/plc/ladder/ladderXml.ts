// Ladder Diagram as PLCopen TC6 XML: the `<LD>` body a ladder POU exports as (ladder.ts has the model).
//
// TC6 draws LD as a graph, not as rungs: every element has a `localId`, and its `connectionPointIn` lists the
// elements whose outputs feed it (`<connection refLocalId=...>`). A series is a chain of such links; a branch is a
// fan-out (one output feeding the first element of each path) and a wired OR (one input listing the last element of
// every path); a box's pins are `inputVariables` / `outputVariables` named by `formalParameter`, and a value on a pin
// comes from an `inVariable` (an expression) and one that goes to a place is named on the output pin itself. Each rung
// is drawn between its own pair of power rails, so a network is one connected graph and nothing links one rung to the
// next.
//
// Three choices keep the graph plain for any reader: an input value comes from an inVariable rather than an
// `<expression>` inside the input pin; an output bound to a place is written on its pin rather than as an outVariable
// wired to it; and trailing coils in series are drawn in parallel. Networks are written in document order.
//
// Positions are required by the schema and used by the editors that draw TC6 as written (Beremiz, OpenPLC); a tool
// that lays LD out itself ignores them. They are a plain grid: a column per element, a row per branch path.

import type { LdBox, LdElement, LdRung, LdSection } from './ladder'

/** The namespace this project's own TC6 `addData` is named under (export.ts writes it, importXml.ts reads it): each
 *  `<data>` is named `${OIP_XML}/<kind>` and holds one element in this namespace. Here because both sides already
 *  import this module, and neither should pull in the other. */
export const OIP_XML = 'http://www.openindustryproject.org/plcopenxml'

/**
 * Other names some tools' PLCopen files give the pins of the standard blocks, beside IEC 61131-3's: a counter's reset
 * and load as RESET and LOAD, the bistables' as SET1 / RESET and SET / RESET1. Only read: a file read in has them taken
 * back to IEC's names, and the export always writes IEC's.
 */
const IMPORT_PIN_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  CTU: { R: 'RESET' },
  CTD: { LD: 'LOAD' },
  CTUD: { R: 'RESET', LD: 'LOAD' },
  SR: { S1: 'SET1', R: 'RESET' },
  RS: { S: 'SET', R1: 'RESET1' },
}

/** A pin as read from a file, in IEC's spelling: another name for a standard block's pin taken back. */
function iecPinName(type: string, pin: string): string {
  const pins = IMPORT_PIN_ALIASES[type.toUpperCase()]
  if (!pins) return pin
  const found = Object.entries(pins).find(([, theirs]) => theirs === pin.toUpperCase())
  return found ? found[0] : pin
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** where a link comes from: an element, and for a box the output pin */
interface Producer {
  id: number
  param?: string
}

// the grid, in the units the file's <ld><scaling x="16" y="16"/> declares
const COL = 96
const ROW = 64
const LEFT = 32
const RAIL_GAP = 40
const SYMBOL = { w: 21, h: 20 }
const BOX_W = 64
const PIN_STEP = 20

interface Size {
  cols: number
  rows: number
}

function sizeOf(els: readonly LdElement[]): Size {
  let cols = 0
  let rows = 1
  for (const el of els) {
    const s = elementSize(el)
    cols += s.cols
    rows = Math.max(rows, s.rows)
  }
  return { cols, rows }
}

function elementSize(el: LdElement): Size {
  if (el.kind === 'branch') {
    const paths = el.paths.map(sizeOf)
    return { cols: Math.max(1, ...paths.map((p) => p.cols)), rows: paths.reduce((n, p) => n + p.rows, 0) }
  }
  if (el.kind === 'box') return { cols: 2, rows: Math.max(1, Math.ceil((boxPins(el).inputs.length * PIN_STEP + PIN_STEP) / ROW)) }
  return { cols: 1, rows: 1 }
}

/** A box's pins as TC6 lists them: the one on the rung first, then the ones with a value, in the order written. A
 *  function that starts the rung has no pin the rung feeds. */
function boxPins(box: LdBox): { inputs: string[]; outputs: string[] } {
  const r = box.resolved!
  const inputs = [...(r.input !== null ? [r.input] : []), ...box.pins.filter((p) => !p.out && p.value !== null).map((p) => p.name)]
  const outputs = [r.output, ...box.pins.filter((p) => p.out).map((p) => p.name)]
  return { inputs, outputs }
}

class Writer {
  readonly lines: string[] = []
  private nextId = 1

  constructor(private readonly indent: string) {}

  private id(): number {
    return this.nextId++
  }

  private put(depth: number, s: string): void {
    this.lines.push(`${this.indent}${'  '.repeat(depth)}${s}`)
  }

  private pointIn(depth: number, from: readonly Producer[], rel: { x: number; y: number }): void {
    this.put(depth, '<connectionPointIn>')
    this.put(depth + 1, `<relPosition x="${rel.x}" y="${rel.y}"/>`)
    for (const p of from) this.put(depth + 1, `<connection refLocalId="${p.id}"${p.param !== undefined ? ` formalParameter="${esc(p.param)}"` : ''}/>`)
    this.put(depth, '</connectionPointIn>')
  }

  private pointOut(depth: number, rel: { x: number; y: number }): void {
    this.put(depth, '<connectionPointOut>')
    this.put(depth + 1, `<relPosition x="${rel.x}" y="${rel.y}"/>`)
    this.put(depth, '</connectionPointOut>')
  }

  /** One rung between its own rails, from `top`; returns where the next may start. */
  rung(r: LdRung, top: number): number {
    const size = sizeOf(r.elements)
    const height = size.rows * ROW
    // a rung's comment and its label stand ahead of it in the file: a reader gives each to the network after it
    if (r.comment) {
      const lines = r.comment.split('\n')
      this.put(0, `<comment localId="${this.id()}" height="${lines.length * 16}" width="${Math.max(...lines.map((l) => l.length)) * 7 + 16}">`)
      this.put(1, `<position x="${LEFT}" y="${top}"/>`)
      this.put(1, `<content><xhtml:p>${esc(r.comment)}</xhtml:p></content>`)
      this.put(0, '</comment>')
    }
    if (r.label) {
      this.put(0, `<label localId="${this.id()}" height="20" width="${r.label.name.length * 8 + 16}" label="${esc(r.label.name)}">`)
      this.put(1, `<position x="0" y="${top + ROW / 2 - 10}"/>`)
      this.put(0, '</label>')
    }
    const left = this.id()
    this.put(0, `<leftPowerRail localId="${left}" width="3" height="${height}">`)
    this.put(1, `<position x="${LEFT}" y="${top}"/>`)
    this.put(1, '<connectionPointOut formalParameter="">')
    this.put(2, `<relPosition x="3" y="${ROW / 2}"/>`)
    this.put(1, '</connectionPointOut>')
    this.put(0, '</leftPowerRail>')
    // Coils that end a rung with a jump or a RETURN after them are drawn beside it, fed from what feeds them: a coil
    // passes its left link on unchanged, so it means the same, and editors that draw every output at the right end
    // can take it
    let coils = 0
    while (r.exit && coils < r.elements.length && r.elements[r.elements.length - 1 - coils]!.kind === 'coil') coils++
    const head = r.elements.slice(0, r.elements.length - coils)
    const feed = this.series(head, LEFT + RAIL_GAP, top, [{ id: left }])
    const tail = r.elements.slice(head.length)
    const out = tail.length === 0 ? feed : this.series(tail, LEFT + RAIL_GAP + sizeOf(head).cols * COL, top, feed)
    const exitFrom = r.exit && coils > 0 ? feed : out
    const railX = LEFT + RAIL_GAP + size.cols * COL + RAIL_GAP
    // a jump or a RETURN ends the rung: what reaches the end goes into it, and the right rail takes only coils beside it
    if (r.exit) {
      const tag = r.exit.kind === 'jump' ? 'jump' : 'return'
      const label = r.exit.kind === 'jump' ? ` label="${esc(r.exit.label)}"` : ''
      this.put(0, `<${tag} localId="${this.id()}" height="20" width="${r.exit.kind === 'jump' ? r.exit.label.length * 8 + 24 : 56}"${label}>`)
      this.put(1, `<position x="${railX - RAIL_GAP / 2}" y="${top + ROW / 2 - 10}"/>`)
      this.pointIn(1, exitFrom, { x: 0, y: 10 })
      this.put(0, `</${tag}>`)
    }
    const right = this.id()
    this.put(0, `<rightPowerRail localId="${right}" width="3" height="${height}">`)
    this.put(1, `<position x="${railX}" y="${top}"/>`)
    if (out.length > 0 && (!r.exit || coils > 0)) this.pointIn(1, out, { x: 0, y: ROW / 2 })
    this.put(0, '</rightPowerRail>')
    return top + height + ROW / 2
  }

  private series(els: readonly LdElement[], x: number, y: number, from: Producer[]): Producer[] {
    let at = x
    let feed = from
    for (const [i, el] of els.entries()) {
      // Coils in series at the end of a rung are drawn in parallel: every coil passes its left link on unchanged,
      // so it means the same, and editors that draw every output at the right end can take it
      const rest = els.slice(i)
      if (rest.length > 1 && rest.every((e) => e.kind === 'coil')) {
        return this.element({ kind: 'branch', paths: rest.map((e) => [e]), pos: el.pos }, at, y, feed)
      }
      feed = this.element(el, at, y, feed)
      at += elementSize(el).cols * COL
    }
    return feed
  }

  private element(el: LdElement, x: number, y: number, from: Producer[]): Producer[] {
    switch (el.kind) {
      case 'contact':
      case 'coil': {
        const id = this.id()
        const tag = el.kind
        const negated = el.kind === 'contact' ? el.mode === 'closed' : el.mode === 'negated'
        const edge = el.mode === 'rising' || el.mode === 'falling' ? el.mode : 'none'
        const storage = el.kind === 'coil' && (el.mode === 'set' || el.mode === 'reset') ? el.mode : 'none'
        this.put(0, `<${tag} localId="${id}" negated="${negated}" edge="${edge}" storage="${storage}" width="${SYMBOL.w}" height="${SYMBOL.h}">`)
        this.put(1, `<position x="${x}" y="${y + ROW / 2 - SYMBOL.h / 2}"/>`)
        this.pointIn(1, from, { x: 0, y: SYMBOL.h / 2 })
        this.pointOut(1, { x: SYMBOL.w, y: SYMBOL.h / 2 })
        this.put(1, `<variable>${esc(el.operand.text)}</variable>`)
        this.put(0, `</${tag}>`)
        return [{ id }]
      }
      case 'branch': {
        const outs: Producer[] = []
        let row = y
        for (const path of el.paths) {
          // an empty path is a wire: what feeds the branch reaches its join
          outs.push(...(path.length === 0 ? from : this.series(path, x, row, from)))
          row += sizeOf(path).rows * ROW
        }
        // one producer reached by two paths is still one connection
        return outs.filter((p, i) => outs.findIndex((q) => q.id === p.id && q.param === p.param) === i)
      }
      case 'box':
        return this.box(el, x, y, from)
    }
  }

  private box(el: LdBox, x: number, y: number, from: Producer[]): Producer[] {
    const r = el.resolved
    if (!r) throw new Error(`the box '${el.head.text}' was never lowered, so its pins are not known`)
    const pins = boxPins(el)
    const id = this.id()
    const bx = x + COL / 2
    const by = y + ROW / 2 - PIN_STEP
    const height = Math.max(pins.inputs.length, pins.outputs.length) * PIN_STEP + PIN_STEP
    // a value on a pin is an element of its own, drawn beside the box
    const sources = new Map<string, number>()
    for (const p of el.pins) {
      if (p.out || p.value === null) continue
      const v = this.id()
      sources.set(p.name.toUpperCase(), v)
      const py = by + (pins.inputs.indexOf(p.name) + 1) * PIN_STEP
      this.put(0, `<inVariable localId="${v}" width="${Math.max(24, p.value.text.length * 8)}" height="20">`)
      this.put(1, `<position x="${bx - COL / 2}" y="${py - 10}"/>`)
      this.pointOut(1, { x: Math.max(24, p.value.text.length * 8), y: 10 })
      this.put(1, `<expression>${esc(p.value.text)}</expression>`)
      this.put(0, '</inVariable>')
    }
    const instance = el.func ? '' : ` instanceName="${esc(el.head.text)}"`
    // A function that starts the rung takes nothing from it: the rail it stands at links to no pin of it, and the rung
    // carries on from its result.
    const starts = r.input === null
    const rungOut = r.output
    this.put(0, `<block localId="${id}" width="${BOX_W}" height="${height}" typeName="${esc(r.type || el.head.text)}"${instance}>`)
    this.put(1, `<position x="${bx}" y="${by}"/>`)
    this.put(1, '<inputVariables>')
    pins.inputs.forEach((name, i) => {
      const rel = { x: 0, y: (i + 1) * PIN_STEP }
      this.put(2, `<variable formalParameter="${esc(name)}">`)
      if (i === 0 && !starts) this.pointIn(3, from, rel)
      else this.pointIn(3, [{ id: sources.get(name.toUpperCase())! }], rel)
      this.put(2, '</variable>')
    })
    this.put(1, '</inputVariables>')
    this.put(1, '<inOutVariables/>')
    this.put(1, '<outputVariables>')
    pins.outputs.forEach((name, i) => {
      // an output bound to a place names it on the pin (`<connectionPointOut><expression>`): TC6 allows an
      // outVariable wired to the pin as well, which a reader may take as the rung output
      const bound = el.pins.find((p) => p.out && p.name === name)?.value
      this.put(2, `<variable formalParameter="${esc(i === 0 ? rungOut : name)}">`)
      this.put(3, '<connectionPointOut>')
      this.put(4, `<relPosition x="${BOX_W}" y="${(i + 1) * PIN_STEP}"/>`)
      if (bound) this.put(4, `<expression>${esc(bound.text)}</expression>`)
      this.put(3, '</connectionPointOut>')
      this.put(2, '</variable>')
    })
    this.put(1, '</outputVariables>')
    this.put(0, '</block>')
    return [{ id, param: rungOut }]
  }
}

/** The contents of an `<LD>` body for a POU whose whole body is `section` (LdSection.whole), one line per element. */
export function ladderBodyXml(section: LdSection, indent: string): string {
  const w = new Writer(indent)
  let top = 32
  for (const r of section.rungs) top = w.rung(r, top)
  return w.lines.join('\n')
}

// ---------------------------------------------------------------------------
// Reading an <LD> body back into rungs
// ---------------------------------------------------------------------------
//
// The graph is taken electrically: connection points joined by a link are one node (union-find), every output of a
// left rail is the rail's node, and every contact, coil and box is an edge between two nodes (a function that starts
// the rung, which nothing feeds, from the rail's node). A network is reduced the
// way any series-parallel circuit is (edges between the same two nodes are a branch; a node with one edge in and one
// out is a series) until one edge runs rail to rail, and that edge is the rung.
//
// Order is document order, not position: an exporter may write every position as 0,0, so networks, and the paths of a
// branch, are read in the order the file lists them. A rung is the network's first element's place in the
// file, a branch's paths likewise.
//
// What cannot be a rung is named and the POU is left out, rather than half read: a network that is not series-parallel
// (a bridge), a value wired from one box to another, a box with two pins on the rung, a box pin with no name, a
// connector. What TC6 lets any tool add for itself, a `vendorElement`, an `addData` and `documentation`, carries nothing
// a rung runs and is skipped whatever it holds; a `comment` becomes the comment of the rung after it.

/** The slice of an XML element this reader uses (importXml.ts parses the file). */
export interface LdXmlNode {
  name: string
  attrs: Record<string, string>
  children: LdXmlNode[]
  text: string
}

const kidsOf = (n: LdXmlNode | undefined, name: string): LdXmlNode[] => (n?.children ?? []).filter((c) => c.name === name)
const kidOf = (n: LdXmlNode | undefined, name: string): LdXmlNode | undefined => kidsOf(n, name)[0]
const textOf = (n: LdXmlNode | undefined): string => (n ? n.text + n.children.map(textOf).join('') : '').trim()

interface Link {
  ref: number
  param: string
}

function linksOf(point: LdXmlNode | undefined): Link[] {
  return kidsOf(point, 'connection').map((c) => ({ ref: Number(c.attrs['refLocalId']), param: c.attrs['formalParameter'] ?? '' }))
}

/** A rung as a series-parallel tree: an element's text, a series, or a branch. An empty series is a wire. `at` is the
 *  place in the file of its first element, which orders branches and rungs. */
type Tree = { k: 'el'; text: string; at: number } | { k: 'ser'; items: Tree[] } | { k: 'par'; items: Tree[] }

function atOf(t: Tree): number {
  if (t.k === 'el') return t.at
  return t.items.length === 0 ? Infinity : Math.min(...t.items.map(atOf))
}

function ser(a: Tree, b: Tree): Tree {
  const items = [...(a.k === 'ser' ? a.items : [a]), ...(b.k === 'ser' ? b.items : [b])]
  return items.length === 1 ? items[0]! : { k: 'ser', items }
}

function par(all: Tree[]): Tree {
  const items = all.flatMap((t) => (t.k === 'par' ? t.items : [t])).sort((a, b) => atOf(a) - atOf(b))
  // a jump or a RETURN drawn beside the coils that end its rung (the shape the writer above uses) is the
  // same rung as the coils followed by it: a coil passes its left link on unchanged
  const isExit = (t: Tree): boolean => t.k === 'el' && (t.text.startsWith('>>') || t.text === 'RETURN')
  const exits = items.filter(isExit)
  const rest = items.filter((t) => !isExit(t))
  if (exits.length === 1 && rest.length > 0 && rest.every((t) => t.k === 'el' && t.text.startsWith('('))) {
    return ser(rest.length === 1 ? rest[0]! : { k: 'par', items: rest }, exits[0]!)
  }
  return { k: 'par', items }
}

function printTree(t: Tree): string {
  if (t.k === 'el') return t.text
  if (t.k === 'ser') return t.items.map(printTree).join(' ')
  return `[${t.items.map(printTree).join(', ')}]`
}

class Refused extends Error {}

interface Edge {
  from: string
  to: string
  tree: Tree
}

/**
 * The rungs an `<LD>` body draws, as the text of a LADDER section, or null when a network cannot be a rung (each such
 * network is named through `note`).
 */
export function readLdBody(ld: LdXmlNode, pou: string, note: (message: string) => void): string | null {
  const byId = new Map<number, LdXmlNode>()
  const order = new Map<LdXmlNode, number>()
  ld.children.forEach((el, i) => {
    order.set(el, i)
    const id = el.attrs['localId']
    if (id !== undefined) byId.set(Number(id), el)
  })
  for (const el of ld.children) {
    if (['connector', 'continuation', 'actionBlock'].includes(el.name)) {
      note(`POU '${pou}' draws a ${el.name} in its ladder, which this engine's ladder does not have yet, so the POU was left out.`)
      return null
    }
  }

  // ---- nodes: every connection point, joined by what links them ----
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(k, r)
    return r
  }
  const join = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const railOut = (l: Link): boolean => byId.get(l.ref)?.name === 'leftPowerRail'
  const outKey = (l: Link): string => (railOut(l) ? 'rail:left' : `out:${l.ref}:${l.param}`)

  /** the elements that take block `id`'s output `param`, anywhere in the body */
  const consumersOf = (id: number, param: string): LdXmlNode[] =>
    ld.children.filter((el) => {
      const points = [...kidsOf(el, 'connectionPointIn'), ...kidsOf(kidOf(el, 'inputVariables'), 'variable').map((v) => kidOf(v, 'connectionPointIn'))]
      return points.some((p) => linksOf(p).some((l) => l.ref === id && l.param === param))
    })

  const edges: Edge[] = []
  /** producers a right rail takes: their nodes end a rung */
  const ends: string[] = []
  /** what stands ahead of a network in the file and belongs to it: a label, a comment */
  const ahead: { at: number; label?: string; comment?: string }[] = []

  const block = (el: LdXmlNode, id: number, at: number): Edge => {
    const type = el.attrs['typeName'] ?? ''
    const instance = el.attrs['instanceName']
    const label = instance ? `'${instance}'` : `a ${type} box`
    const pins: string[] = []
    let powerIn: { name: string; links: Link[] } | null = null
    // TC6 requires every pin to carry its formalParameter, and the pin is known only by it: an empty one names no pin,
    // so it is refused rather than guessed from where the pin stands
    const pinName = (v: LdXmlNode, side: string): string => {
      const raw = v.attrs['formalParameter'] ?? ''
      if (raw === '') throw new Refused(`${label} with an ${side} pin that has no name (an empty formalParameter)`)
      return iecPinName(type, raw)
    }
    for (const v of kidsOf(kidOf(el, 'inputVariables'), 'variable')) {
      const name = pinName(v, 'input')
      if (v.attrs['negated'] === 'true' || (v.attrs['edge'] ?? 'none') !== 'none') throw new Refused(`${label} with its input ${name} negated or edge-sensing`)
      const point = kidOf(v, 'connectionPointIn')
      const expr = kidOf(point, 'expression')
      if (expr) {
        pins.push(`${name} := ${textOf(expr)}`)
        continue
      }
      const links = linksOf(point)
      if (links.length === 0) continue
      const from = links.map((l) => byId.get(l.ref))
      if (links.length === 1 && from[0]?.name === 'inVariable') {
        pins.push(`${name} := ${textOf(kidOf(from[0], 'expression'))}`)
        continue
      }
      if (from.some((n) => n?.name === 'block' || n?.name === 'inVariable')) {
        if (links.some((l) => byId.get(l.ref)?.name === 'block' && consumersOf(l.ref, l.param).every((c) => c.name === 'block' && c !== el))) {
          throw new Refused(`a value wired into ${label}'s ${name} straight from another box (give it a variable)`)
        }
      }
      // two pins linked into the rung, even from the same place: a rung reaches a box by one pin
      if (powerIn !== null) throw new Refused(`${label} on the rung by two inputs, ${powerIn.name} and ${name}`)
      powerIn = { name, links }
      for (const l of links) join(`in:${id}`, outKey(l))
    }
    let powerOut: string | null = null
    let powerOutLink = ''
    for (const v of kidsOf(kidOf(el, 'outputVariables'), 'variable')) {
      // links name the pin as the file does, so consumers are found by the raw name
      const raw = v.attrs['formalParameter'] ?? ''
      const name = pinName(v, 'output')
      const onPin = kidOf(kidOf(v, 'connectionPointOut'), 'expression')
      const consumers = consumersOf(id, raw)
      const places = consumers.filter((c) => c.name === 'outVariable')
      const bound = [...(onPin ? [textOf(onPin)] : []), ...places.map((p) => textOf(kidOf(p, 'expression')))]
      if (bound.length > 1) throw new Refused(`${label}'s ${name} bound to two places`)
      if (bound.length === 1) pins.push(`${name} => ${bound[0]}`)
      if (consumers.length > places.length) {
        if (bound.length > 0) throw new Refused(`${label}'s ${name} both bound to a place and carried on along the rung`)
        if (powerOut !== null) throw new Refused(`${label} on the rung by two outputs, ${powerOut} and ${name}`)
        powerOut = name
        powerOutLink = raw
      }
    }
    const func = instance === undefined || instance === ''
    if (powerIn === null) {
      // a function whose result starts the rung, with no EN drawn: the rail links to none of its pins and the rung carries
      // on from its result, so electrically it is an edge from the rail. EN is optional in IEC 61131-3 and a function
      // without it runs every scan, so the result is the power flow; the writer above draws this shape too
      if (func && powerOut !== null && powerOut.toUpperCase() !== 'ENO') {
        return { from: 'rail:left', to: `out:${id}:${powerOutLink}`, tree: { k: 'el', text: `${type}(${[...pins, powerOut].join(', ')})`, at } }
      }
      throw new Refused(`${label} that nothing on the rung feeds`)
    }
    const inName = powerIn.name
    if (func && inName.toUpperCase() !== 'EN') throw new Refused(`a ${type} function fed by the rung on ${inName} rather than EN`)
    if (func && powerOut !== null && powerOut.toUpperCase() !== 'ENO') throw new Refused(`a ${type} function carrying the rung on from ${powerOut} rather than ENO`)
    const head = func ? type : instance
    const text = func ? `${head}(${pins.join(', ')})` : `${head}(${[inName, ...pins, ...(powerOut !== null ? [powerOut] : [])].join(', ')})`
    return { from: `in:${id}`, to: `out:${id}:${powerOutLink}`, tree: { k: 'el', text, at } }
  }

  try {
    for (const el of ld.children) {
      const id = Number(el.attrs['localId'])
      const at = order.get(el)!
      switch (el.name) {
        case 'comment': {
          const text = textOf(kidOf(el, 'content'))
          if (text !== '') ahead.push({ at, comment: text })
          break
        }
        case 'label':
          ahead.push({ at, label: el.attrs['label'] ?? '' })
          break
        case 'jump':
        case 'return': {
          // the end of its rung, like the right rail, with what it does as the rung's last word
          const into = `in:${id}`
          const links = linksOf(kidOf(el, 'connectionPointIn'))
          if (links.length === 0) join(into, 'rail:left')
          for (const l of links) join(into, outKey(l))
          edges.push({ from: into, to: 'rail:right', tree: { k: 'el', text: el.name === 'jump' ? `>>${el.attrs['label'] ?? ''}` : 'RETURN', at } })
          break
        }
        case 'leftPowerRail':
        case 'vendorElement':
        case 'inVariable':
        case 'documentation':
        case 'addData':
          break
        case 'outVariable':
          // one fed by a contact or a coil is not a box's output: it copies the rung into a place, every scan
          if (linksOf(kidOf(el, 'connectionPointIn')).some((l) => byId.get(l.ref)?.name !== 'block')) {
            throw new Refused(`the rung wired straight into a variable, '${textOf(kidOf(el, 'expression'))}' (draw a coil)`)
          }
          break
        case 'rightPowerRail':
          for (const p of kidsOf(el, 'connectionPointIn')) for (const l of linksOf(p)) ends.push(outKey(l))
          break
        case 'contact':
        case 'coil': {
          const variable = textOf(kidOf(el, 'variable'))
          if (variable === '') throw new Refused(`a ${el.name} with no variable`)
          const negated = el.attrs['negated'] === 'true'
          const edge = el.attrs['edge'] ?? 'none'
          const storage = el.attrs['storage'] ?? 'none'
          const marks = [negated ? '/' : '', edge === 'rising' ? 'P ' : edge === 'falling' ? 'N ' : '', storage === 'set' ? 'S ' : storage === 'reset' ? 'R ' : ''].filter((m) => m !== '')
          if (marks.length > 1 || (el.name === 'contact' && storage !== 'none')) {
            throw new Refused(`a ${el.name} on '${variable}' that is ${[negated ? 'negated' : '', edge !== 'none' ? `${edge}-edge` : '', storage !== 'none' ? storage : ''].filter(Boolean).join(' and ')}`)
          }
          const mark = marks[0] ?? ''
          const into = `in:${id}`
          const links = linksOf(kidOf(el, 'connectionPointIn'))
          // an input with no link sits on the left rail
          if (links.length === 0) join(into, 'rail:left')
          for (const l of links) join(into, outKey(l))
          edges.push({ from: into, to: `out:${id}:`, tree: { k: 'el', text: el.name === 'contact' ? `|${mark}${variable}|` : `(${mark}${variable})`, at } })
          break
        }
        case 'block':
          edges.push(block(el, id, at))
          break
        default:
          throw new Refused(`a <${el.name}> element`)
      }
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e
    note(`POU '${pou}': its ladder has ${e.message}, which a rung here cannot express, so the POU was left out.`)
    return null
  }

  // ---- the graph, node by node ----
  const left = find('rail:left')
  const right = find('rail:right')
  const g: Edge[] = edges.map((e) => ({ from: find(e.from), to: find(e.to), tree: e.tree }))
  for (const k of ends) g.push({ from: find(k), to: right, tree: { k: 'ser', items: [] } })
  // a node nothing leaves ends a rung too: a coil with no right rail drawn, a box whose output is not used
  for (const e of [...g]) {
    if (e.to !== right && !g.some((f) => f.from === e.to)) g.push({ from: e.to, to: right, tree: { k: 'ser', items: [] } })
  }
  // one wire between the same two nodes is enough
  const wires = new Set<string>()
  const graph = g.filter((e) => {
    if (e.tree.k !== 'ser' || e.tree.items.length > 0) return true
    const key = `${e.from}>${e.to}`
    if (wires.has(key)) return false
    wires.add(key)
    return true
  })
  for (const e of graph) {
    if (e.from !== left && !graph.some((f) => f.to === e.from)) {
      note(`POU '${pou}': an element of its ladder is not connected to the left rail, so the POU was left out.`)
      return null
    }
  }

  // ---- networks: what is connected, the rails apart ----
  const groups: Edge[][] = []
  const placed = new Set<Edge>()
  for (const start of graph) {
    if (placed.has(start)) continue
    const group: Edge[] = []
    const stack = [start]
    placed.add(start)
    while (stack.length > 0) {
      const e = stack.pop()!
      group.push(e)
      const inner = [e.from, e.to].filter((n) => n !== left && n !== right)
      for (const f of graph) {
        if (!placed.has(f) && (inner.includes(f.from) || inner.includes(f.to))) {
          placed.add(f)
          stack.push(f)
        }
      }
    }
    groups.push(group)
  }

  const rungs: { at: number; text: string }[] = []
  for (const group of groups) {
    let es = group
    for (;;) {
      if (es.length === 1 && es[0]!.from === left && es[0]!.to === right) break
      let changed = false
      // a branch: the edges between the same two nodes
      const byEnds = new Map<string, Edge[]>()
      for (const e of es) byEnds.set(`${e.from}>${e.to}`, [...(byEnds.get(`${e.from}>${e.to}`) ?? []), e])
      for (const same of byEnds.values()) {
        if (same.length < 2) continue
        es = [...es.filter((e) => !same.includes(e)), { from: same[0]!.from, to: same[0]!.to, tree: par(same.map((e) => e.tree)) }]
        changed = true
      }
      // a series: a node with one edge in and one out
      for (const e of es) {
        const v = e.to
        if (v === left || v === right) continue
        const ins = es.filter((f) => f.to === v)
        const outs = es.filter((f) => f.from === v)
        if (ins.length !== 1 || outs.length !== 1) continue
        const next = outs[0]!
        es = [...es.filter((f) => f !== e && f !== next), { from: e.from, to: next.to, tree: ser(e.tree, next.tree) }]
        changed = true
        break
      }
      if (!changed) {
        note(`POU '${pou}': a network of its ladder is not series-parallel (a bridge), which a rung here cannot express, so the POU was left out.`)
        return null
      }
    }
    const tree = es[0]!.tree
    rungs.push({ at: atOf(tree), text: `${printTree(tree)};` })
  }
  rungs.sort((a, b) => a.at - b.at)
  // a label or a comment belongs to the first network after it in the file; one after the last network labels an
  // empty rung of its own, which is where a jump to the end of the section lands
  const heads = new Map<number, { label?: string; comments: string[] }>()
  for (const a of ahead.sort((x, y) => x.at - y.at)) {
    let k = rungs.findIndex((r) => r.at > a.at)
    if (k < 0) {
      rungs.push({ at: Infinity, text: ';' })
      k = rungs.length - 1
    }
    const h = heads.get(k) ?? { comments: [] }
    if (a.label !== undefined) h.label = a.label
    if (a.comment !== undefined) h.comments.push(a.comment)
    heads.set(k, h)
  }
  const lines = rungs.flatMap((r, k) => {
    const h = heads.get(k)
    const comments = (h?.comments ?? []).flatMap((c) => c.split('\n')).map((line) => `  (* ${line.replace(/\*\)/g, '* )')} *)`)
    return [...comments, `  ${h?.label ? `${h.label}: ` : ''}${r.text}`]
  })
  return ['LADDER', ...lines, 'END_LADDER'].join('\n')
}
