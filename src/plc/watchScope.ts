// Which watch-table entry a name written in the program text stands for, read in the POU it is written in.
//
// The watch image (CompiledProgram.watch) keys the code outside every POU and the globals by their bare names, and a
// program instance's variables as `Instance.Name`. A user function block's own variables are not in it (only a
// standard block's outputs, `Main.T1.Q`, as members of the variable that holds it). So the same `i` written in a
// FUNCTION_BLOCK and in a PROGRAM are two different things, and only the program's has a value to show:
//   - outside every POU, a name is its own key;
//   - in a PROGRAM, its own variables are `Instance.Name` of the instance being monitored: the only one, or the one
//     picked for that type (the organizer's instance rows, the header chip), else the first; anything else it names
//     is a global;
//   - in a FUNCTION_BLOCK, a FUNCTION or a method, its own variables get none; anything else is a global.
// Names compare as IEC compares them, ignoring case.

import { lex } from './lexer'
import { parseStructure } from './structure'
import type { Ast } from './types'

/** One running instance of a PROGRAM type: the controller table's (core/controller.ts) or a CONFIGURATION's. An
 *  instance with no type runs the code outside every POU. */
export interface WatchInstance {
  name: string
  type?: string | null
}

interface Pou {
  kind: 'program' | 'block'
  start: number
  end: number
  /** its own variables (a block's methods' too), upper-cased */
  locals: ReadonlySet<string>
  /** the monitored instance of a program, or null for a program no instance runs */
  instance: string | null
}

/** A PROGRAM that runs as several instances: where its header is, the instances in run order, and the one monitored. */
export interface MonitoredProgram {
  type: string
  /** offset of its PROGRAM keyword */
  start: number
  instances: string[]
  monitored: string
}

/** Resolves a name written at an offset of `source` to the watch key it is published under, or null when the running
 *  controller publishes nothing for it there. */
export interface WatchScopes {
  keyAt(offset: number, name: string): string | null
  /** the programs that run as several instances, for saying which one the values are */
  shared: MonitoredProgram[]
}

const END_OF: Record<string, string> = { PROGRAM: 'END_PROGRAM', FUNCTION_BLOCK: 'END_FUNCTION_BLOCK', FUNCTION: 'END_FUNCTION' }

/** Where each POU's text ends: the END keyword that closes it, found from its start. */
function endsOf(source: string, starts: readonly { start: number; opener: string }[]): number[] {
  let toks: ReturnType<typeof lex>
  try {
    toks = lex(source)
  } catch {
    return starts.map(() => source.length)
  }
  return starts.map(({ start, opener }) => {
    const want = END_OF[opener]
    const tk = toks.find((t) => t.pos.offset > start && t.kind === 'kw' && t.value === want)
    return tk ? tk.pos.offset + tk.value.length : source.length
  })
}

/** The instances running a PROGRAM type, in run order. */
const instancesOfType = (instances: readonly WatchInstance[], type: string): string[] =>
  instances.filter((i) => i.type?.toUpperCase() === type.toUpperCase()).map((i) => i.name)

/** The instance monitored for a type: the one picked, while it still runs it, else the first. */
function monitoredOf(names: readonly string[], picked: string | undefined): string | null {
  const keep = picked === undefined ? undefined : names.find((n) => n.toUpperCase() === picked.toUpperCase())
  return keep ?? names[0] ?? null
}

function pousOf(source: string, ast: Ast, instances: readonly WatchInstance[], picked: Readonly<Record<string, string>>): Pou[] {
  const upper = (names: Iterable<string>): Set<string> => new Set([...names].map((n) => n.toUpperCase()))
  const monitored = (type: string): string | null => monitoredOf(instancesOfType(instances, type), picked[type.toUpperCase()])
  const found = [
    ...ast.programDefs.map((p) => ({ opener: 'PROGRAM', start: p.pos.offset, kind: 'program' as const, locals: upper(p.decls.map((d) => d.name)), instance: monitored(p.name) })),
    ...ast.fbDefs
      .filter((b) => !b.library)
      .map((b) => ({
        opener: 'FUNCTION_BLOCK',
        start: b.pos.offset,
        kind: 'block' as const,
        locals: upper([...b.decls, ...(b.methods ?? []).flatMap((m) => m.decls)].map((d) => d.name)),
        instance: null,
      })),
    ...ast.funcDefs
      .filter((f) => !f.library)
      .map((f) => ({ opener: 'FUNCTION', start: f.pos.offset, kind: 'block' as const, locals: upper([f.name, ...f.decls.map((d) => d.name)]), instance: null })),
  ].sort((a, b) => a.start - b.start)
  const ends = endsOf(source, found)
  return found.map((p, i) => ({ kind: p.kind, start: p.start, end: ends[i]!, locals: p.locals, instance: p.instance }))
}

/**
 * The watch scopes of a program text run by `instances`, with `picked` the instance chosen for a PROGRAM type that runs
 * as several (keyed by the type upper-cased). Text that does not parse yet reads every name as its own key, as the
 * code outside every POU does.
 */
export function watchScopes(source: string, instances: readonly WatchInstance[], picked: Readonly<Record<string, string>> = {}): WatchScopes {
  const ast = parseStructure(source).ast
  const pous = ast ? pousOf(source, ast, instances, picked) : []
  const shared: MonitoredProgram[] = []
  for (const p of ast?.programDefs ?? []) {
    const names = instancesOfType(instances, p.name)
    if (names.length > 1) shared.push({ type: p.name, start: p.pos.offset, instances: names, monitored: monitoredOf(names, picked[p.name.toUpperCase()])! })
  }
  return {
    shared,
    keyAt(offset, name) {
      const pou = pous.find((p) => offset >= p.start && offset < p.end)
      if (!pou) return name
      const dot = name.search(/[.[]/)
      const root = (dot < 0 ? name : name.slice(0, dot)).toUpperCase()
      if (!pou.locals.has(root)) return name
      return pou.kind === 'program' && pou.instance !== null ? `${pou.instance}.${name}` : null
    },
  }
}

/** The program instances a text runs under `controller`: the table's, else the text's own CONFIGURATION's, else none
 *  (a text with no PROGRAM runs as the code outside every POU). */
export function watchInstances(source: string, controller: { programs: readonly WatchInstance[] } | null | undefined): WatchInstance[] {
  if (controller) return controller.programs.map((p) => ({ name: p.name, type: p.type ?? null }))
  return (parseStructure(source).ast?.configuration?.programs ?? []).map((p) => ({ name: p.name, type: p.type }))
}
