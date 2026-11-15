// The wiring check: does a scene's tag plumbing actually connect?
//
// bindings.ts walks the same bridge direction-blind (it catches a typo, nothing else). With each tag param's direction
// and ST type declared (`ParamSpec.dir` / `stType`, carried to `TagRefParamSpec`), stronger questions are answerable
// without running anything:
//
//   contested   two parts write the same tag (or a part and the program do) - last writer wins, and
//               which one that is depends on part order. Always a bug.
//   type-clash  two parts declare the same tag as different ST types. Always a bug.
//   program-type  a part says BOOL and the program declares that var numeric (or the reverse).
//   undriven    a part reads a tag the program does not drive - it reads the zero value, or, for a tag the part
//               reads only while a program drives it (`onlyWhenDriven`), the part runs on its own setting.
//   unread      a part publishes a tag the program does not read.
//
// A part's tag connects only to the program: parts read the program's outputs, and what a part writes goes only to
// the program's inputs (sim/behaviorBus.ts). So another part writing a tag neither drives it for a part that reads
// it nor reads it for that part.
//   undeclared  a part's tag param has no declared direction, so none of the above can be asked of it. Only a
//               stored package can have one: an authored part is refused without `dir` (core/parts/partAuthoringChecks.ts).
//   address     a part's tag is a direct address (%IX100.0) that cannot carry it: malformed, memory,
//               the wrong way round (a sensor is the PLC's input, so %I; an actuator its output, %Q),
//               or the wrong size for the value (a BOOL is a bit, a REAL a double word).
//   controller  a part's tag has `::` in it but no controller name before it (core/io/controllerTag.ts), or names
//               a controller in a spelling other tags spell differently (`cell2::` beside `Cell2::`). IEC names
//               ignore case, but the sim matches tags exactly, so the two would not meet.
//
// A tag that names another controller (`Cell2::%IX0.0`) is checked as that controller's: its address, its writers
// and its type, but not against the program here, which does not run it. Whether Cell2 drives it is Cell2's business.
//
// The first three, and address, are errors. Undriven and unread are warnings: an undeclared program tag is
// a forward reference (see TagRefParamSpec's doc), mid-authoring scenes are full of them, and a check that cries wolf
// gets switched off. Undeclared is a warning too: the part runs, this check just can't see it.
//
// Scope limits, reported rather than hidden (a silent skip reads as "checked and clean"):
//   â€¢ only parts whose PLC link is on (a declared `commsParam` that is true, or none declared);
//   â€¢ only tag params with a non-empty value - an unset tag is unwired by intent, not by error;
//   â€¢ only parts whose package is loaded: `unresolvedPackages` carries the others out so the caller can say so.

import { badControllerPrefix, controllerOf, controllerTag, splitControllerTag } from '../core/io/controllerTag'
import { canonicalAddress, looksLikeAddress, parseDirectAddress, sizeWord } from '../core/io/iecAddress'
import type { IoSize } from '../core/io/iecAddress'
import { labelHead, packageParamSpecs } from '../core/packageParams'
import { commsOn } from '../core/conveyor/conveyorDirection'
import { getPackage } from '../core/parts/partRegistry'
import type { TaggedPart } from './bindings'
import type { PlcLink, WiredBindings } from './link/plcLink'
import { valueKinds } from './link/plcLink'

/** A scene part as the wiring walk needs it - {@link TaggedPart} plus its display name. */
export interface WiringPart extends TaggedPart {
  /** display name, for readable problem text (falls back to the id) */
  name?: string
}

export type WiringKind = 'contested' | 'type-clash' | 'program-type' | 'undriven' | 'unread' | 'undeclared' | 'address' | 'overlap' | 'controller'

export interface WiringProblem {
  severity: 'error' | 'warning'
  kind: WiringKind
  /** the tag name the problem is about */
  tag: string
  message: string
  /** ids of the scene parts involved, in scene order */
  parts: string[]
}

/** One tag as the scene wires it - who drives it, who reads it, what it carries. */
export interface WiredTag {
  name: string
  writers: string[]
  readers: string[]
  /** the declared ST type, when every declaration agrees; null when undeclared or in conflict */
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
  /** the program declares it as a VAR_OUTPUT (the program drives it) */
  programWrites: boolean
  /** the program declares it as a VAR_INPUT (the program reads it) */
  programReads: boolean
}

export interface WiringReport {
  problems: WiringProblem[]
  tags: WiredTag[]
  /** packageIds referenced by a comms-enabled part but absent from the registry - their signals are
   *  unknown, so those parts contribute nothing. Carried out rather than skipped silently. */
  unresolvedPackages: string[]
}

interface Decl {
  partId: string
  partLabel: string
  /** the param's label as its Inspector row shows it (core labelHead), which is what the problem text names */
  paramLabel: string
  dir: 'in' | 'out'
  stType?: 'BOOL' | 'INT' | 'DINT' | 'REAL'
  /** the label of the param this tag replaces while bound (`setpointFor`): undriven, the part uses 0 in its place */
  replaces?: string
  /** the part reads the tag only while a program drives it (`onlyWhenDriven`): undriven, it runs on its own setting */
  gated?: boolean
}

/** A tag param as the problem text names it: the part, then the param as its Inspector row reads ("Belt1 (Run tag)"). */
function named(d: Pick<Decl, 'partLabel' | 'paramLabel'>): string {
  return `${d.partLabel} (${d.paramLabel})`
}

function paramsOf(p: WiringPart): Record<string, unknown> {
  return typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
}

/** The address sizes a part's declared ST type can travel in. */
const SIZES_FOR: Record<'BOOL' | 'INT' | 'DINT' | 'REAL', readonly IoSize[]> = { BOOL: ['X'], INT: ['B', 'W', 'D'], DINT: ['D'], REAL: ['D'] }

/**
 * What is wrong with a part's tag when it is a direct address, or null when it can carry the value.
 * `dir` is the part's: an `out` param is what the part publishes, which the PLC reads as an input.
 */
export function addressProblem(raw: string, dir: 'in' | 'out', stType: Decl['stType']): string | null {
  const a = parseDirectAddress(raw)
  if ('error' in a) return a.error
  if (a.area === 'M') return `${a.text} is a memory address, and only inputs (%I) and outputs (%Q) are carried between the scene and the PLC`
  if (a.size === 'L') return `${a.text} is a 64-bit address, and 64-bit values are not supported`
  if (dir === 'out' && a.area !== 'I') return `this part publishes the value, so it is the PLC's input: an %I address (${a.text.replace(/^%Q/, '%I')}), not ${a.text}`
  if (dir === 'in' && a.area !== 'Q') return `this part is driven by the value, so it is the PLC's output: a %Q address (${a.text.replace(/^%I/, '%Q')}), not ${a.text}`
  if (stType && !SIZES_FOR[stType].includes(a.size)) {
    return `the value is ${stType}, which does not travel in the ${sizeWord(a.size)} address ${a.text} (${stType === 'BOOL' ? 'a bit, like %IX0.0' : stType === 'REAL' || stType === 'DINT' ? 'a double word, like %ID0' : 'a byte, word or double word, like %IW0'})`
  }
  return null
}

/**
 * What an undriven tag does to the parts that read it. One read whenever it names a tag reads 0, and a setpoint then
 * runs on 0 in place of the param it replaces. One read only while a program drives it (`gated`) runs on its own
 * setting instead, so "stays at its zero value" would be wrong for it.
 */
function undrivenCost(readers: readonly Decl[]): string {
  const zero = readers.filter((r) => !r.gated)
  const own = readers.filter((r) => r.gated)
  const out: string[] = []
  if (zero.length > 0) {
    const hit = zero.filter((r) => r.replaces !== undefined)
    const setpoints = hit.length > 0 ? `, so ${hit.map((r) => `${r.partLabel} uses 0 in place of its ${r.replaces}`).join(', ')}` : ''
    out.push(`${own.length > 0 ? `for ${zero.map(named).join(', ')} ` : ''}it stays at its zero value${setpoints}`)
  }
  const names = [...new Set(own.map((r) => r.partLabel))]
  if (names.length > 0) out.push(`${names.join(', ')} ${names.length === 1 ? 'ignores it and runs on its' : 'ignore it and run on their'} own setting`)
  return out.join('; ')
}

/**
 * Walk a scene's declared tag signals and report what doesn't connect. `link` is optional: without a
 * compiled program the part-vs-part checks still run (contested writers, type clashes), and the
 * program-side ones are not attempted.
 */
export function checkWiring(parts: readonly WiringPart[], link?: Pick<PlcLink, 'inputs' | 'outputs' | 'watch' | 'aliases' | 'declaredKind'>): WiringReport {
  const byTag = new Map<string, Decl[]>()
  const unresolved = new Set<string>()

  const problems: WiringProblem[] = []
  for (const p of parts) {
    if (p.type !== 'part') continue
    const params = paramsOf(p)
    const pkg = getPackage(p.packageId ?? '')
    if (!pkg) {
      // its signals (and whether its PLC link is on) are unknowable - surface the gap instead of quietly treating
      // the part as tagless
      if (p.packageId) unresolved.add(p.packageId)
      continue
    }
    if (!commsOn(p as { type: string; packageId?: string; params: unknown })) continue
    const specs = packageParamSpecs(pkg)
    for (const spec of specs) {
      if (spec.kind !== 'tagRef') continue
      const raw = params[spec.key]
      let tag = typeof raw === 'string' ? raw.trim() : ''
      if (!tag) continue
      if (spec.dir !== 'in' && spec.dir !== 'out') {
        problems.push({
          severity: 'warning',
          kind: 'undeclared',
          tag,
          message: `${p.name ?? p.id}.${spec.key}: its part (${p.packageId}) does not say whether it reads or writes this tag, so its wiring is not checked. Give the param a dir and stType`,
          parts: [p.id],
        })
        continue
      }
      const bad = badControllerPrefix(tag)
      if (bad !== null) {
        const why = `${bad} before the :: is not a controller name (a letter or underscore, then letters, digits and underscores)`
        problems.push({ severity: 'error', kind: 'controller', tag, message: `${named({ partLabel: p.name ?? p.id, paramLabel: labelHead(spec.label) })}: ${why}`, parts: [p.id] })
        continue
      }
      const { controller, local } = splitControllerTag(tag)
      if (looksLikeAddress(local)) {
        const why = addressProblem(local, spec.dir, spec.stType)
        if (why) {
          problems.push({ severity: 'error', kind: 'address', tag, message: `${named({ partLabel: p.name ?? p.id, paramLabel: labelHead(spec.label) })}: ${why}`, parts: [p.id] })
          continue
        }
        tag = controllerTag(controller, canonicalAddress(local) ?? local)
      }
      const list = byTag.get(tag) ?? []
      const replaced = spec.setpointFor ? specs.find((s) => s.key === spec.setpointFor) : undefined
      list.push({ partId: p.id, partLabel: p.name ?? p.id, paramLabel: labelHead(spec.label), dir: spec.dir, stType: spec.stType, ...(replaced ? { replaces: labelHead(replaced.label) } : {}), ...(spec.onlyWhenDriven ? { gated: true } : {}) })
      byTag.set(tag, list)
    }
  }

  // What each tag holds, from its declaration where that says: a link builds its whole value table on each read
  // (reading it per tag made Play take wired tags x table size), and even one read is a third of a second on a large
  // program. The reader builds it at most once, for a tag only the table can answer.
  const programKind = link ? valueKinds(link) : undefined
  const programReadSet = new Set(link?.inputs ?? [])
  const programWriteSet = new Set(link?.outputs ?? [])
  const tags: WiredTag[] = []

  for (const [tag, decls] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const writers = decls.filter((d) => d.dir === 'out')
    const readers = decls.filter((d) => d.dir === 'in')
    // another controller's tag is that controller's to drive and read, not the program's here
    const ours = controllerOf(tag) === null
    const programWrites = ours && programWriteSet.has(tag)
    const programReads = ours && programReadSet.has(tag)

    // types: agreement across every declaration of this tag
    const declaredTypes = [...new Set(decls.map((d) => d.stType).filter((t): t is 'BOOL' | 'INT' | 'DINT' | 'REAL' => t !== undefined))]
    const type = declaredTypes.length === 1 ? (declaredTypes[0] ?? null) : null
    if (declaredTypes.length > 1) {
      problems.push({
        severity: 'error',
        kind: 'type-clash',
        tag,
        message: `declared as ${declaredTypes.join(' and ')} by different parts (${decls.map(named).join(', ')})`,
        parts: [...new Set(decls.map((d) => d.partId))],
      })
    }

    // two things driving one tag: last writer wins, and which one that is depends on part order
    const driverCount = writers.length + (programWrites ? 1 : 0)
    if (driverCount > 1) {
      const who = [...writers.map(named), ...(programWrites ? ['the ST program'] : [])]
      problems.push({
        severity: 'error',
        kind: 'contested',
        tag,
        message: `driven by ${driverCount} writers (${who.join(', ')}) - last one wins, and which that is depends on part order`,
        parts: writers.map((w) => w.partId),
      })
    }

    // a part's declared type vs what the program declared. `watch` is a snapshot of the program's scalars,
    // so it separates BOOL from numeric but not INT from REAL - only the mismatch it can prove is reported.
    const seen = ours ? programKind?.(tag) : undefined
    if (type !== null && seen !== undefined && seen !== 'string') {
      const programIsBool = seen === 'boolean'
      const partIsBool = type === 'BOOL'
      if (programIsBool !== partIsBool) {
        problems.push({
          severity: 'error',
          kind: 'program-type',
          tag,
          message: `parts declare it ${type}, the program declares it ${programIsBool ? 'BOOL' : 'numeric'}`,
          parts: [...new Set(decls.map((d) => d.partId))],
        })
      }
    }

    // a part writing the tag does not count: what a part writes reaches only the program, never another part
    const partsOnly = writers.length > 0 && readers.length > 0 ? ` (a part's write reaches only the program, never another part)` : ''
    if (ours && readers.length > 0 && !programWrites) {
      problems.push({
        severity: 'warning',
        kind: 'undriven',
        tag,
        message: `read by ${readers.map(named).join(', ')} but the program does not drive it - ${undrivenCost(readers)}${partsOnly}`,
        parts: readers.map((r) => r.partId),
      })
    }
    if (ours && writers.length > 0 && !programReads) {
      problems.push({
        severity: 'warning',
        kind: 'unread',
        tag,
        message: `written by ${writers.map(named).join(', ')} but the program does not read it${partsOnly}`,
        parts: writers.map((w) => w.partId),
      })
    }

    tags.push({
      name: tag,
      writers: writers.map((w) => w.partId),
      readers: readers.map((r) => r.partId),
      type,
      programWrites,
      programReads,
    })
  }

  // A word inside a double word: %ID100 is the two words %IW200 and %IW201, in the PLC's memory and on every
  // Modbus link (core/io/externalIo.ts), so two tags there overwrite each other. In the sim they are separate
  // names and nothing collides, which is exactly why it has to be said here. Each controller has memory of its
  // own, so the overlap is looked for within one controller. Only this overlap is universal:
  // a bit inside a word collides on a byte-addressed PLC and in a register image, but not in OpenPLC, whose
  // bits and words are separate tables, so that one is left to the link that would carry it.
  const wordAt = new Map<string, string>() // `${controller}|${area}:${word}` -> the word tag there
  const doubles: [string, string, string, number][] = [] // [tag, controller, area, first word]
  for (const tag of byTag.keys()) {
    const { controller, local } = splitControllerTag(tag)
    const a = looksLikeAddress(local) ? parseDirectAddress(local) : null
    if (!a || 'error' in a || a.area === 'M') continue
    if (a.size === 'W') wordAt.set(`${controller ?? ''}|${a.area}:${a.fields[0]}`, tag)
    else if (a.size === 'D') doubles.push([tag, controller ?? '', a.area, a.fields[0]! * 2])
  }
  for (const [dword, controller, area, first] of doubles) {
    for (const w of [first, first + 1]) {
      const word = wordAt.get(`${controller}|${area}:${w}`)
      if (word === undefined) continue
      problems.push({
        severity: 'error',
        kind: 'overlap',
        tag: word,
        message: `is half of ${dword} (the two words %${area}W${first} and %${area}W${first + 1}), so on a real PLC and over the external link the two overwrite each other. Give one of them an address of its own`,
        parts: [...new Set([...(byTag.get(word) ?? []), ...(byTag.get(dword) ?? [])].map((d) => d.partId))],
      })
    }
  }

  // one controller in two spellings: each spelling after the first that appears, sorted, is the one reported
  const spellings = new Map<string, Map<string, string[]>>() // lower-case name -> spelling -> part ids
  for (const [tag, decls] of byTag) {
    const c = controllerOf(tag)
    if (c === null) continue
    const bySpelling = spellings.get(c.toLowerCase()) ?? new Map<string, string[]>()
    bySpelling.set(c, [...(bySpelling.get(c) ?? []), ...decls.map((d) => d.partId)])
    spellings.set(c.toLowerCase(), bySpelling)
  }
  for (const bySpelling of spellings.values()) {
    if (bySpelling.size < 2) continue
    const [first, ...others] = [...bySpelling.keys()].sort()
    for (const other of others) {
      problems.push({
        severity: 'error',
        kind: 'controller',
        tag: other,
        message: `names the controller ${first!} spelled another way. Names ignore case, but tags must be spelled alike to meet, so write ${first!}`,
        parts: [...new Set(bySpelling.get(other))],
      })
    }
  }

  // errors first, then by tag name - a caller printing the list top-down reads the real breakage first
  problems.sort((a, b) => (a.severity === b.severity ? a.tag.localeCompare(b.tag) : a.severity === 'error' ? -1 : 1))
  return { problems, tags, unresolvedPackages: [...unresolved].sort() }
}

/**
 * The program variables a scene binds by wiring, beyond the VAR_INPUT / VAR_OUTPUT the program declares.
 *
 * A part wired to one of the program's own tags by name (`CompiledProgram.bindable`: a controller tag, a
 * global, `Main.Eye`) is connected to it, and the parts say which way: a tag a part publishes is the
 * program's input, written in before each scan; one that parts only read is its output, which the program
 * drives and owns (ctx.tagDriven). That is the rule the OPC UA link already follows (core/io/opcUa.ts), and the
 * one a programmer expects of controller tags that carry no direction at all: a tag is a tag, and the
 * device on the other end decides.
 *
 * Declared I/O keeps its declaration, a located variable its address, and a tag the program does not have
 * stays the `unwired` warning it always was.
 */
export function wiredBindings(parts: readonly WiringPart[], program: { inputs: readonly string[]; outputs: readonly string[]; bindable: readonly string[] }): WiredBindings {
  const bindable = new Set(program.bindable)
  const declared = new Set([...program.inputs, ...program.outputs])
  const inputs: string[] = []
  const outputs: string[] = []
  for (const t of checkWiring(parts).tags) {
    if (!bindable.has(t.name) || declared.has(t.name)) continue
    if (t.writers.length > 0) inputs.push(t.name)
    else if (t.readers.length > 0) outputs.push(t.name)
  }
  return { inputs, outputs }
}
