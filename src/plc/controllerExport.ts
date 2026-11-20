// One controller's program, as the file that goes onto that PLC. The project keeps one program, whose POUs every
// controller may run instances of (plc/controller.ts controllerRuns), but a real PLC takes a download of its own: its
// tasks and instances, and the POUs those reach. A POU no instance of this controller reaches is left out, so the file
// is what that PLC runs and nothing else.

import type { Controller } from '../core/controller'
import { controllerRuns, plcOfProgram } from './controller'
import { parseDocument, type StBlock } from './document'
import { lex } from './lexer'

export interface ControllerExport {
  /** the controller's program: the blocks it keeps, in the order the program has them */
  source: string
  /** its own tasks and instances, with no controller named on them */
  table: Controller | null
  /** the POUs left out, as named in the program */
  dropped: string[]
}

/** A controller that runs no program instance: there is nothing to put on its PLC. Not a compile error, so it is said
 *  differently (a program that does not compile is the code editor's to point at). */
export class NothingToExportError extends Error {}

/** The controllers a task table gives a program instance, besides the default one, as first spelled: the ones with a
 *  file of their own to export. */
export function exportableControllers(table: Controller | null | undefined, defaultName?: string): string[] {
  if (!table) return []
  const isDefault = (n: string): boolean => defaultName !== undefined && n.toLowerCase() === defaultName.toLowerCase()
  const out: string[] = []
  for (const p of table.programs) {
    const plc = plcOfProgram(table, p)
    if (plc !== undefined && !isDefault(plc) && !out.some((n) => n.toLowerCase() === plc.toLowerCase())) out.push(plc)
  }
  return out
}

/** The controllers a task table names besides the default one, as first spelled. */
export function tableControllers(table: Controller | null | undefined, defaultName?: string): string[] {
  const out: string[] = []
  const isDefault = (n: string): boolean => defaultName !== undefined && n.toLowerCase() === defaultName.toLowerCase()
  for (const plc of [...(table?.tasks ?? []).map((t) => t.plc), ...(table?.programs ?? []).map((p) => (table ? plcOfProgram(table, p) : undefined))]) {
    if (plc !== undefined && !isDefault(plc) && !out.some((n) => n.toLowerCase() === plc.toLowerCase())) out.push(plc)
  }
  return out
}

const POU_KINDS: ReadonlySet<StBlock['kind']> = new Set(['programPou', 'functionBlock', 'function'])

/** The names a block's text mentions, upper-cased; null when it cannot be read, which keeps everything it might reach. */
function namesIn(text: string): Set<string> | null {
  try {
    const out = new Set<string>()
    for (const tok of lex(text)) {
      if (tok.kind !== 'ident') continue
      out.add(tok.value.toUpperCase())
      if (tok.qualifier) out.add(tok.qualifier.toUpperCase())
    }
    return out
  } catch {
    return null
  }
}

/**
 * Controller `plc`'s program (null: the default one). It runs the instances on its tasks, and the instances on no task
 * that name it (controllerRuns). The roots are their PROGRAM types, and the TYPE and VAR_GLOBAL blocks, which are kept
 * whole: a type or a global costs a PLC nothing unused, and its declarations can name a function block. The code
 * outside every POU is the default controller's own, so only its file has it. A POU is kept when a root reaches it,
 * by naming it anywhere in its text, which can keep a POU a comment mentions but never drops one that is called.
 * Throws when the controller runs no program instance: it has nothing to download.
 */
export function controllerExport(source: string, table: Controller | null | undefined, scanMs: number, plc: string | null, defaultName?: string): ControllerExport {
  const runs = controllerRuns(source, table, scanMs, { ...(defaultName !== undefined ? { defaultName } : {}), simulated: tableControllers(table, defaultName) })
  const run = runs.find((r) => (plc === null ? r.controller === null : r.controller?.toLowerCase() === plc.toLowerCase()))
  // the default controller of a program with no table runs it from no table at all (a CONFIGURATION of its own, or
  // statements only), which is its whole program; any other controller needs an instance of its own
  if (!run || (run.table !== null && run.table.programs.length === 0)) throw new NothingToExportError(`${plc ?? defaultName ?? 'The default controller'} runs no program instance, so there is nothing to export for it.`)
  const blocks = parseDocument(run.source).blocks.filter((b) => b.text.trim() !== '')
  const pous = new Map(blocks.filter((b) => POU_KINDS.has(b.kind)).map((b) => [b.name.toUpperCase(), b]))
  const kept = new Set<StBlock>()
  const pending: string[] = (run.table?.programs ?? []).flatMap((p) => (p.type !== undefined ? [p.type.toUpperCase()] : []))
  const reach = (b: StBlock): void => {
    const names = namesIn(b.text)
    pending.push(...(names ? [...names] : [...pous.keys()]))
  }
  for (const b of blocks) {
    if (POU_KINDS.has(b.kind)) continue
    kept.add(b)
    reach(b)
  }
  while (pending.length > 0) {
    const b = pous.get(pending.pop()!)
    if (!b || kept.has(b)) continue
    kept.add(b)
    reach(b)
  }
  return {
    source: `${blocks.filter((b) => kept.has(b)).map((b) => b.text.trim()).join('\n\n')}\n`,
    table: run.table,
    dropped: blocks.filter((b) => !kept.has(b) && b.name !== '').map((b) => b.name),
  }
}
