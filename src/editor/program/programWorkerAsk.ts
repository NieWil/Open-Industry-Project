// What the page asks the program worker, and what it answers (program.worker.ts, programWorkerClient.ts). The work
// itself is here, as functions of the ask, so the worker and the page's fallback run the same code.

import type { Controller } from '../../core/controller'
import { controllerDiagnostics, controllerFor, controllerSource, type ControllerDiagnostics } from '../../plc/controller'
import { compile } from '../../plc/interpreter'
import { surfaceOf, type ProgramSurface } from '../../plc/programSurface'
import { programFactsOf, type Build, type FactsArgs, type ProgramFacts } from './programFacts'

/** The program as the store holds it: its text, the scene's controller table (null: the default one) and scan time. */
export interface ProgramAsk {
  source: string
  controller: Controller | null
  scanMs: number
}
/** ...and, for a check, the default controller's name, which a task may spell (plc controllerDiagnostics). */
export interface CheckAsk extends ProgramAsk {
  defaultName?: string
}

/** ...and, for the Problems panel's facts (programFacts.ts), what they are asked about. `compose` is false for a
 *  program in a dialect this build does not read: it runs from no table, and its text is not sent. */
export interface FactsAsk extends ProgramAsk, Omit<FactsArgs, 'source' | 'controller'> {
  compose: boolean
}
/** The facts, with the table the program was read under (plc/controller.ts `controllerFor`). */
export interface FactsAnswer {
  facts: ProgramFacts
  table: Controller | null
}

/** What the worker is asked: what the program offers the scene, every problem it and its table have, or all the
 *  Problems panel asks of it. */
export type ProgramRequest = ({ kind: 'surface' } & ProgramAsk) | ({ kind: 'check' } & CheckAsk) | ({ kind: 'facts' } & FactsAsk)
/** A request as it is sent: numbered, and with the program's text only when the worker does not hold it yet
 *  (programService.ts sends a text once, however many questions are asked about it). */
export type ProgramMessage = { [K in ProgramRequest['kind']]: Omit<Extract<ProgramRequest, { kind: K }>, 'source'> }[ProgramRequest['kind']] & { id: number; source?: string }
/** Its answer to each. A surface is null when the program does not compile. */
export interface ProgramAnswers {
  surface: ProgramSurface | null
  check: ControllerDiagnostics
  facts: FactsAnswer
}
export type ProgramReply = { id: number } & (
  | { kind: 'surface'; answer: ProgramSurface | null }
  | { kind: 'check'; answer: ControllerDiagnostics }
  | { kind: 'facts'; answer: FactsAnswer }
  | { kind: 'failed' }
)

/** The text `ask` compiles: the program with its controller table, as Play runs it. Working the table out reads the
 *  whole program, which is why the worker does it and not the page. */
export function compiledText(ask: ProgramAsk): string {
  return controllerSource(ask.source, controllerFor(ask.source, ask.controller, ask.scanMs))
}

/** What the program offers the scene, or null when it does not compile (the Problems panel says why). `build` is
 *  how the text is compiled: the worker's own compile, or the page's kept copy. */
export function surfaceOfAsk(ask: ProgramAsk, build: (text: string) => ReturnType<typeof compile> | null = compile): ProgramSurface | null {
  try {
    const program = build(compiledText(ask))
    return program ? surfaceOf(program) : null
  } catch {
    return null
  }
}

/** What the Problems panel asks of the program. `build` is how a text is compiled (programFacts.ts Build). */
export function factsOfAsk(ask: FactsAsk, build?: Build): FactsAnswer {
  const table = ask.compose ? controllerFor(ask.source, ask.controller, ask.scanMs) : null
  const args: FactsArgs = { source: ask.source, controller: table, ...(ask.defaultName !== undefined ? { defaultName: ask.defaultName } : {}), simulated: ask.simulated, tags: ask.tags }
  return { facts: programFactsOf(args, build), table }
}

/** Every problem the program and its table have, as the text editor's gutter lists them. */
export function checkOfAsk(ask: CheckAsk): ControllerDiagnostics {
  return controllerDiagnostics(ask.source, controllerFor(ask.source, ask.controller, ask.scanMs), ask.defaultName !== undefined ? { defaultName: ask.defaultName } : {})
}
