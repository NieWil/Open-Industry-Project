// Everything the Problems panel asks of the program (editor/problems.ts), as plain data: what the checker found, and
// for each controller the simulator runs, what its program declares and whether it compiles. Working it out reads
// and compiles the whole program, so the panel asks a worker for it (programWorkerClient.ts); the checks that weigh
// it against the scene's parts stay on the page, where the parts and their packages are.
//
// `programFactsOf` is the one way to get the facts: the worker calls it, and so does the page when it cannot wait
// (the agent's get_problems, a unit test).

import type { Controller } from '../../core/controller'
import { controllerDiagnostics, controllerRuns, controllerSource, runnableSource, type ControllerDiagnostics } from '../../plc/controller'
import { compile } from '../../plc/interpreter'
import { LocalPlcLink, valueKinds, type ValueKind } from '../../plc/link/plcLink'
import { surfaceOf, type ProgramSurface } from '../../plc/programSurface'
import { parseStructure } from '../../plc/structure'
import { StError, type CompiledProgram, type TaskInfo } from '../../plc/types'

/** What to work the facts out for. */
export interface FactsArgs {
  /** the program's text; '' when there is none to read (none written, or a dialect this build does not have) */
  source: string
  /** the table it runs from (plc/controller.ts `controllerFor`), or null when its text runs as written */
  controller: Controller | null
  /** the default controller's name, which a task may spell */
  defaultName?: string
  /** the named controllers the simulator runs */
  simulated: readonly string[]
  /** the tags the scene's parts are wired to, by controller ('' the default one): the names whose kind is asked */
  tags: Readonly<Record<string, readonly string[]>>
}

export type { ValueKind }

/** One controller's program, as it compiles. */
export interface RunFacts {
  /** what it offers the scene; null when it does not compile */
  surface: ProgramSurface | null
  /** the kind of each asked tag the program holds a value for, by the tag as asked */
  kinds: Record<string, ValueKind>
  tasks: TaskInfo[]
  /** why it does not compile, with the place in its text when the compiler gave one */
  error: { message: string; offset?: number } | null
}

export interface ProgramFacts {
  /** every problem the checker found in the program and its table */
  check: ControllerDiagnostics
  /** the controller of each share of the table that runs (plc controllerRuns); null is the default one */
  runControllers: (string | null)[]
  /** the default controller's program; null when there is no program text. `intervals` is where each task's INTERVAL
   *  is written, for a program that declares its own CONFIGURATION */
  main: (RunFacts & { intervals: Record<string, number> }) | null
  /** each other controller the simulator runs, when the default one's program compiles */
  others: ({ controller: string } & RunFacts)[]
}

const NO_PROBLEMS: ControllerDiagnostics = { source: [], controller: [] }

/** how a text is compiled: the page keeps one copy for all its readers (compiledProgram.ts), the worker its own */
export type Build = (text: string) => { program: CompiledProgram | null; error: unknown }

const compileNow: Build = (text) => {
  try {
    return { program: compile(text), error: null }
  } catch (error) {
    return { program: null, error }
  }
}

// The checker's answer is kept against what was checked: the panel collects on every scene commit, and a commit that
// leaves the program alone must not check it again. The table is compared by value (the default one is minted fresh).
let checked: { key: string; found: ControllerDiagnostics } | null = null
function checkedFor(source: string, controller: Controller | null, defaultName: string | undefined): ControllerDiagnostics {
  const key = JSON.stringify([controller, source, defaultName ?? null])
  if (checked?.key !== key) checked = { key, found: controllerDiagnostics(source, controller, defaultName !== undefined ? { defaultName } : {}) }
  return checked.found
}

function runFacts(build: () => { program: CompiledProgram | null; error: unknown }, tags: readonly string[]): RunFacts {
  let built: { program: CompiledProgram | null; error: unknown }
  try {
    built = build()
  } catch (error) {
    built = { program: null, error }
  }
  const { program, error } = built
  if (!program) {
    const message = error instanceof Error ? error.message : String(error)
    return { surface: null, kinds: {}, tasks: [], error: error === null ? null : { message, ...(error instanceof StError ? { offset: error.pos.offset } : {}) } }
  }
  // (from each tag's declaration where that says, and the value table only for one it cannot answer: plcLink.ts)
  const kindOf = valueKinds(new LocalPlcLink(program))
  const kinds: Record<string, ValueKind> = {}
  for (const tag of tags) {
    const kind = kindOf(tag)
    if (kind !== undefined) kinds[tag] = kind
  }
  return { surface: surfaceOf(program), kinds, tasks: program.tasks.map((t) => ({ ...t, programs: [...t.programs] })), error: null }
}

/** Where each task's INTERVAL value is written, in a program that declares its own CONFIGURATION. */
function intervalsOf(source: string): Record<string, number> {
  // Read off the shared parse (plc/structure.ts), which the table was worked out from and is kept: checking the
  // program again for this read all of it a third time. A program that does not read has no task to place.
  const out: Record<string, number> = {}
  for (const t of parseStructure(source).ast?.configuration?.tasks ?? []) {
    const at = t.args.find((a) => a.name.toUpperCase() === 'INTERVAL')?.value.pos.offset
    if (at !== undefined) out[t.name] = at
  }
  return out
}

/** The facts for `args`. `build` compiles a text (kept, on the page, in the copy its other readers use). */
export function programFactsOf(args: FactsArgs, build: Build = compileNow): ProgramFacts {
  const { source, controller } = args
  const check = source.trim() !== '' || controller ? checkedFor(source, controller, args.defaultName) : NO_PROBLEMS
  // Each controller the simulator runs compiles its own share of the program, as Play runs it (plc/controller.ts
  // controllerRuns): the default one's is the program, and each other one's is checked against its own tags.
  const runs = controller ? controllerRuns(source, controller, 0, { ...(args.defaultName !== undefined ? { defaultName: args.defaultName } : {}), simulated: [...args.simulated] }) : []
  const mainTable = runs.find((r) => r.controller === null)?.table ?? controller
  const main = source.trim() === '' ? null : runFacts(() => build(controllerSource(source, mainTable)), args.tags[''] ?? [])
  const periodic = main?.tasks.some((t) => t.kind === 'periodic') ?? false
  const others: ProgramFacts['others'] = []
  if (main?.surface) {
    for (const r of runs) {
      if (r.controller === null) continue
      others.push({ controller: r.controller, ...runFacts(() => build(runnableSource(r.source, r.table)), args.tags[r.controller] ?? []) })
    }
  }
  return {
    check,
    runControllers: runs.map((r) => r.controller),
    main: main ? { ...main, intervals: main.surface && !controller && periodic ? intervalsOf(source) : {} } : null,
    others,
  }
}
