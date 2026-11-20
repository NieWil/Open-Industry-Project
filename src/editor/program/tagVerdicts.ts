// What the program says to the Inspector's tag fields: which names a part can be wired to, and whether it declares
// each name the scene's parts are wired to, and as what type. The same compile and bindings as Play and the Problems
// panel's `unwired` and `program-type` rows (editor/problems.ts), so a field, its suggestions and the panel agree.
//
// Loaded by a dynamic import: a tag field renders in the first frame's graph, and the compiler does not.

import type { Controller } from '../../core/controller'
import { isKnownDialect } from '../../core/dialect'
import type { PartInstance } from '../../core/types'
import { commsTags, controllerFor, controllerSource, unhandledProgramTags, type CompiledProgram } from '../../plc'
import { boundNames } from '../../plc/link/plcLink'
import { surfaceOf, type ProgramSurface } from '../../plc/programSurface'
import { surfaceFor } from './programWorkerClient'
import { compiledOnce } from './compiledProgram'
import { wiredBindings } from '../../plc/wiring'

/** The program behind the scene, as the store holds it. */
export interface ProgramCheck {
  source: string
  dialect: string | undefined
  controller: Controller | null
  scanMs: number
}

/**
 * `type` is the program's declared type (`BOOL`, `INT`, `ENUM`), when it can tell. `drives` and `reads` say which way
 * the tag is bound: the program drives what it declares as an output (or what wiring makes one, `wiredBindings`), and
 * reads what it declares as an input. A part reads only what the program drives, and what a part writes reaches only
 * the program's inputs (sim/behaviorBus.ts), so these answer whether a part's binding does anything.
 */
export type TagVerdict = { declared: false } | { declared: true; type?: string; drives: boolean; reads: boolean }

/** The program compiled, in the copy Problems reads too (compiledProgram.ts). Problems reports why one does not
 *  compile; here it says nothing about a tag. */
function compiled(source: string): CompiledProgram | null {
  return compiledOnce(source).program
}

/** The text `check` compiles: the program with its controller table; null when there is nothing to compile. */
function sourceOf(check: ProgramCheck): string | null {
  if (!isKnownDialect(check.dialect) || check.source.trim() === '') return null
  return controllerSource(check.source, controllerFor(check.source, check.controller, check.scanMs))
}

function compiledFor(check: ProgramCheck): CompiledProgram | null {
  const source = sourceOf(check)
  return source === null ? null : compiled(source)
}

/** What the program offers the scene, compiled off the main thread (programWorkerClient.ts); null when it does not
 *  compile. The program goes over as the store holds it: composing the text it compiles reads all of it. */
function surfaceOfCheck(check: ProgramCheck): Promise<ProgramSurface | null> {
  if (!isKnownDialect(check.dialect) || check.source.trim() === '') return Promise.resolve(null)
  return surfaceFor({ source: check.source, controller: check.controller, scanMs: check.scanMs })
}

/**
 * A program variable a part's tag can name. `dir` is how the program declares it: `in` a VAR_INPUT (the program reads
 * it), `out` a VAR_OUTPUT (it drives it). Absent for a variable with no declared direction, which takes the one the
 * parts give it (plc/wiring.ts wiredBindings).
 */
export interface ProgramTag {
  name: string
  type: string
  dir?: 'in' | 'out'
}

/**
 * Every program variable a part's tag can name, with its declared type, in declaration order: the declared inputs and
 * outputs and what wiring binds (`CompiledProgram.bindable`, a program instance's variables as `Main.Eye` among them).
 * A sole instance's variables go by their bare names, which the link answers to (plcLink.ts soleInstanceAliases).
 * Null when the program does not compile, so the caller can fall back to reading its declarations.
 */
export async function programTagNames(check: ProgramCheck): Promise<ProgramTag[] | null> {
  const surface = await surfaceOfCheck(check)
  return surface ? tagNamesOf(surface) : null
}

/** {@link programTagNames} compiled here and now: the answer the worker gives, for a caller that cannot wait. */
export function programTagNamesNow(check: ProgramCheck): ProgramTag[] | null {
  const program = compiledFor(check)
  return program ? tagNamesOf(surfaceOf(program)) : null
}

function tagNamesOf(program: ProgramSurface): ProgramTag[] {
  const bare = new Map(program.aliases.map(([alias, name]) => [name, alias]))
  const inputs = new Set(program.inputs)
  const outputs = new Set(program.outputs)
  const out: ProgramTag[] = []
  const seen = new Set<string>()
  for (const name of [...program.inputs, ...program.outputs, ...program.bindable]) {
    if (seen.has(name)) continue
    seen.add(name)
    const info = program.vars[name]
    if (!info || info.constant) continue
    const dir = inputs.has(name) ? 'in' : outputs.has(name) ? 'out' : undefined
    out.push({ name: bare.get(name) ?? name, type: info.type, ...(dir ? { dir } : {}) })
  }
  return out
}

/**
 * A verdict for every tag a comms-enabled part is wired to, keyed as the part writes it. Empty when there is no
 * program, it is in a dialect this build cannot read, or it does not compile: then a name is a forward reference
 * and nothing can be said about it.
 */
export async function programTagVerdicts(parts: readonly PartInstance[], check: ProgramCheck): Promise<Map<string, TagVerdict>> {
  const surface = await surfaceOfCheck(check)
  return surface ? tagVerdictsOf(parts, surface) : new Map()
}

/** {@link programTagVerdicts} compiled here and now: the answer the worker gives, for a caller that cannot wait. */
export function programTagVerdictsNow(parts: readonly PartInstance[], check: ProgramCheck): Map<string, TagVerdict> {
  const program = compiledFor(check)
  return program ? tagVerdictsOf(parts, surfaceOf(program)) : new Map()
}

function tagVerdictsOf(parts: readonly PartInstance[], program: ProgramSurface): Map<string, TagVerdict> {
  const out = new Map<string, TagVerdict>()
  // bound as the link binds it for Play (plcLink.ts boundNames): its bindable names include a sole instance's bare aliases
  const aliases = new Map(program.aliases)
  const declared = boundNames(program, aliases)
  const link = { ...boundNames(program, aliases, wiredBindings(parts, declared)), aliases }
  const unwired = new Set(unhandledProgramTags(parts, link).unwired)
  const outputs = new Set(link.outputs)
  const inputs = new Set(link.inputs)
  for (const tag of commsTags(parts)) {
    if (unwired.has(tag)) {
      out.set(tag, { declared: false })
      continue
    }
    const type = program.vars[aliases.get(tag) ?? tag]?.type
    const way = { drives: outputs.has(tag), reads: inputs.has(tag) }
    out.set(tag, type ? { declared: true, type, ...way } : { declared: true, ...way })
  }
  return out
}
