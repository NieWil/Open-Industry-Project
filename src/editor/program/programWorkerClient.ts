// The open program, checked and compiled in a worker (program.worker.ts), so a click on a part or a pause in typing
// never waits on the compiler. One answer of each kind is kept per program: it only changes one way at a time.
//
// Every kind of question goes to the one worker (programService.ts), which reads the program once for all of them.
//
// Where there is no Worker (unit tests, a host that refuses one), or one fails, the answer is worked out here.

import type { ControllerDiagnostics } from '../../plc/controller'
import type { ProgramSurface } from '../../plc/programSurface'
import { compiledOnce } from './compiledProgram'
import { ProgramService, type Kind, type ProgramWorker } from './programService'
import { checkOfAsk, factsOfAsk, surfaceOfAsk, type CheckAsk, type FactsAnswer, type FactsAsk, type ProgramAnswers, type ProgramAsk, type ProgramRequest } from './programWorkerAsk'

const service = new ProgramService(
  typeof Worker === 'undefined' ? null : () => new Worker(new URL('./program.worker.ts', import.meta.url), { type: 'module', name: 'program' }) as unknown as ProgramWorker,
)

/** One kind of question: the answer kept for the program last asked about, and how the page answers it. */
class Lane<K extends Kind, A extends ProgramAsk> {
  #kept: { key: string; ask: A; answer: Promise<ProgramAnswers[K]> } | null = null

  constructor(
    private readonly kind: K,
    /** the answer worked out on the page */
    private readonly here: (ask: A) => ProgramAnswers[K],
    /** what a caller is told when its question went stale before it was answered */
    private readonly none: ProgramAnswers[K],
    /** what of an ask, beside its text, decides the answer */
    private readonly rest: (ask: A) => unknown,
  ) {}

  ask(ask: A): Promise<ProgramAnswers[K]> {
    // by what the ask says: the store hands out a new controller table object for an unchanged one
    const key = JSON.stringify(this.rest(ask))
    if (!this.#kept || this.#kept.ask.source !== ask.source || this.#kept.key !== key) {
      const request = { ...ask, kind: this.kind } as unknown as Extract<ProgramRequest, { kind: K }>
      this.#kept = { key, ask, answer: service.request(request, () => this.here(ask), this.none) }
    }
    return this.#kept.answer
  }
}

const NO_PROBLEMS: ControllerDiagnostics = { source: [], controller: [] }

const surfaces = new Lane<'surface', ProgramAsk>(
  'surface',
  // in the copy the Problems panel reads (compiledProgram.ts)
  (ask) => surfaceOfAsk(ask, (text) => compiledOnce(text).program),
  null,
  (ask) => [ask.controller, ask.scanMs],
)
const checks = new Lane<'check', CheckAsk>('check', checkOfAsk, NO_PROBLEMS, (ask) => [ask.controller, ask.scanMs, ask.defaultName ?? null])

const NO_FACTS: FactsAnswer = { facts: { check: NO_PROBLEMS, runControllers: [], main: null, others: [] }, table: null }
const facts = new Lane<'facts', FactsAsk>('facts', (ask) => factsOfAsk(ask, compiledOnce), NO_FACTS, (ask) => [ask.controller, ask.scanMs, ask.compose, ask.defaultName ?? null, ask.simulated, ask.tags])

/** What the Problems panel asks of the program (programFacts.ts). The same promise for the same ask; an ask that went
 *  stale before it was answered resolves empty, so a caller checks its ask is still the current one. */
export function factsFor(ask: FactsAsk): Promise<FactsAnswer> {
  return facts.ask(ask)
}

/** What the program offers the scene, or null when it does not compile. The same promise for the same program. */
export function surfaceFor(ask: ProgramAsk): Promise<ProgramSurface | null> {
  return surfaces.ask({ source: ask.source, controller: ask.controller, scanMs: ask.scanMs })
}

/** Every problem the program and its controller table have. The same promise for the same program. */
export function checkFor(ask: CheckAsk): Promise<ControllerDiagnostics> {
  return checks.ask({ source: ask.source, controller: ask.controller, scanMs: ask.scanMs, ...(ask.defaultName !== undefined ? { defaultName: ask.defaultName } : {}) })
}
