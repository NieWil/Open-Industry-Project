/**
 * The Problems aggregator: every check this app can run over the open document, in one list.
 *
 * It is the common surface over engines that each report somewhere else too: wiring (plc/wiring.ts,
 * otherwise checked only on the run edge), ST diagnostics (the editor gutter), part build failures
 * (a catalog badge) and part runtime failures (the Inspector, for the selected part only).
 *
 * Pure, DOM-free and synchronous, so the whole aggregation is unit-testable against hand-built
 * inputs.
 *
 * Two rules:
 *
 * 1. **The engines own severity.** `undriven`/`unread` are warnings because a tag the program has
 *    not declared yet is a legal forward reference, and mid-authoring scenes are full of them
 *    (see wiring.ts's header). This module never promotes or demotes; it only sorts.
 * 2. **A blind spot is reported, not skipped.** An unloaded package's signals are unknowable, and a
 *    program that does not compile cannot be asked what it declares. Each of those leaves a `note`, because a short
 *    list that silently means "could not look" looks the same as a clean result.
 *
 * A run's flow facts (core/flow/flowFacts.ts) are not listed here: they are what happened, not something to fix. The
 * agent's get_problems, the Tests overlay and the test-project and check-flow CLIs report them.
 */
import { compiledOnce } from './program/compiledProgram'
import { programFactsOf, type FactsArgs, type ProgramFacts, type RunFacts } from './program/programFacts'
import type { FactsAsk } from './program/programWorkerAsk'
import { plcOfProgram, unhandledProgramTags } from '../plc'
import { boundNames } from '../plc/link/plcLink'
import { checkLayout } from '../core/checkLayout'
import { controllersUsed, controllerTag, partsForController, partsNaming } from '../core/io/controllerTag'
import type { Controller } from '../core/controller'
import { dialectRefusal, isKnownDialect } from '../core/dialect'
import { packageParamSpecs } from '../core/packageParams'
import { getPackage } from '../core/parts/partRegistry'
import { newerSdkLevel, PART_SDK_LEVEL } from '../core/parts/partSdk'
import type { TestSpec } from '../core/project/projectTest'
import { coverByTests } from '../core/project/projectTestTags'
import { MAX_SIM_HZ, type PartInstance, type SimRate } from '../core/types'
import { timeToString } from '../plc/runtime'
import { checkWiring, wiredBindings } from '../plc/wiring'
import type { RuntimePartDiagnostic } from '../core/parts/partDiagnostics'
import { shortestHeldIntervalSec } from '../sim/plcHost'

/** Which check produced a row. Also the display grouping, and the sort tie-break after severity. */
export type ProblemGroup = 'Program' | 'Wiring' | 'Parts' | 'Layout'

export type ProblemSeverity = 'error' | 'warning'

export interface Problem {
  /** stable identity: a React key, and what a "seen" set would dedupe on across recomputes */
  readonly key: string
  readonly severity: ProblemSeverity
  readonly group: ProblemGroup
  /** the row's leading column: a tag name, a part/package label, or a source line */
  readonly subject: string
  readonly message: string
  /** scene part ids this row is about - what a click selects. Empty when it is about no part. */
  readonly parts: readonly string[]
  /** where a click goes, for a row fixed there rather than at a line or a part: a controller table's problem has no
   *  place in the text, and its tasks are edited in the PLC panel's organizer ('tasks') */
  readonly panel?: 'tasks'
  /** character offset into the ST program (program rows only), for jumping the editor there */
  readonly offset?: number
  /** 1-based source line (program rows only) */
  readonly line?: number
  /** repeats of an identical runtime diagnostic (a throwing step() ticks at sim rate) */
  readonly count?: number
}

export interface ProblemsReport {
  /** errors first, then warnings, deterministic within a severity (group, then key) */
  readonly problems: readonly Problem[]
  readonly errors: number
  readonly warnings: number
  /** what could not be checked - see rule 2 in the header */
  readonly notes: readonly string[]
}

export interface ProblemsInput {
  /** the scene's parts */
  readonly parts: readonly PartInstance[]
  /** the bound ST program's source; '' when the scene has no logic yet */
  readonly stProgram: string
  /** the table that program runs from (plc/controller.ts `controllerFor`), or null when its text runs as written */
  readonly controller?: Controller | null
  /** the program's dialect (EditorState.stDialect, core/dialect.ts); absent = IEC. A program in one this build does
   *  not have is one error row, and nothing reads it as IEC: the program-side checks are a blind spot, and say so */
  readonly stDialect?: string
  /** live runtime diagnostics (core/parts/partDiagnostics.allPartDiagnostics()) */
  readonly runtime: readonly RuntimePartDiagnostic[]
  /** packageId -> build error, for authored parts whose latest edit did not compile */
  readonly buildErrors: Readonly<Record<string, string>>
  /** packageId -> display name, so a build-error row reads as "Diverter" not "oip.diverter" */
  readonly packageNames?: Readonly<Record<string, string>>
  /** the scene's physics step rate: it sets the shortest TASK INTERVAL the sim can scan on time */
  readonly stepHz: SimRate
  /** the program's last runtime fault (a scan that faulted and dropped it to STOP: division by zero, an index out of
   *  bounds), when it is a fault of the program as it now reads; line and col are 1-based, as the engine gives them */
  readonly plcFault?: { readonly message: string; readonly line?: number; readonly col?: number } | null
  // What the checks above cannot see, each only for its coverage note (rule 2 in the header). Absent = none.
  /** the runtime diagnostics store stopped recording new entries at its cap (partDiagnosticsOverflowed) */
  readonly runtimeOverflowed?: boolean
  /** part types from a collab room whose own code is held back, so a stand-in runs in their place */
  readonly heldCode?: number
  /** Play serves the scene to an external PLC, so the program in this app is not what runs */
  readonly externalPlc?: boolean
  /** the named controllers the scene lists (`Cell2::...`, core/scene/scenePlcs.ts) and whether Play connects each;
   *  absent, the controllers the tags name are not checked */
  readonly namedPlcs?: readonly { readonly name: string; readonly enabled: boolean; readonly runsOn?: 'app' | 'plc' }[]
  /** the default controller's name, which a tag never carries */
  readonly mainPlcName?: string
  /** the tests the project keeps: a tag only a test reads or drives is not an `unread` / `undriven` warning, as the
   *  check-wiring CLI counts it (core/project/projectTestTags.ts) */
  readonly tests?: readonly TestSpec[]
}

/** The offset of a 1-based line and column in `src`, or undefined when the line is past its end (the part of a
 *  compiled source that was generated, not written: a controller table's CONFIGURATION). */
function offsetAt(src: string, line: number, col: number): number | undefined {
  let start = 0
  for (let l = 1; l < line; l++) {
    const nl = src.indexOf('\n', start)
    if (nl < 0) return undefined
    start = nl + 1
  }
  const end = src.indexOf('\n', start)
  return start + Math.min(Math.max(0, col - 1), (end < 0 ? src.length : end) - start)
}

/** 1-based line containing `offset`. */
function lineOf(src: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, src.length)
  for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/** The tags the scene's parts are wired to, by controller ('' the default one): what the facts are asked about. */
function wiredTagNames(parts: readonly PartInstance[], simulated: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = { '': checkWiring(parts).tags.map((t) => t.name) }
  for (const name of simulated) out[name] = checkWiring(partsForController(parts, name)).tags.map((t) => t.name)
  return out
}

/** The named controllers the simulator runs. */
const simulatedOf = (input: Pick<ProblemsInput, 'namedPlcs'>): string[] => (input.namedPlcs ?? []).filter((c) => c.runsOn === 'app' && c.enabled).map((c) => c.name)

/**
 * What {@link collectProblems} asks of the program for `input` (program/programFacts.ts). The panel sends it to a
 * worker and hands the answer back in; anything that cannot wait lets collectProblems work the facts out itself.
 */
export function factsArgsOf(input: Pick<ProblemsInput, 'parts' | 'stProgram' | 'stDialect' | 'controller' | 'namedPlcs' | 'mainPlcName'>): FactsArgs {
  const foreign = input.stDialect !== undefined && !isKnownDialect(input.stDialect)
  const simulated = simulatedOf(input)
  return {
    source: foreign ? '' : input.stProgram,
    controller: foreign ? null : (input.controller ?? null),
    ...(input.mainPlcName !== undefined ? { defaultName: input.mainPlcName } : {}),
    simulated,
    tags: wiredTagNames(input.parts, simulated),
  }
}

/**
 * {@link factsArgsOf} for a worker (program/programWorkerClient.ts `factsFor`): the same question, with the scene's
 * own controller table and scan time in place of the composed table, which the worker works out and hands back.
 */
export function factsAskOf(doc: Pick<ProblemsInput, 'parts' | 'stProgram' | 'stDialect' | 'namedPlcs' | 'mainPlcName'> & { controller: Controller | null; scanMs: number }): FactsAsk {
  const known = isKnownDialect(doc.stDialect)
  const simulated = simulatedOf(doc)
  return {
    source: known ? doc.stProgram : '',
    controller: doc.controller,
    scanMs: doc.scanMs,
    compose: known,
    ...(doc.mainPlcName !== undefined ? { defaultName: doc.mainPlcName } : {}),
    simulated,
    tags: wiredTagNames(doc.parts, simulated),
  }
}

/** A value of the kind the program holds, for the wiring check's type comparison (it reads only what kind it is). */
const SAMPLE = { boolean: false, number: 0, string: '' } as const

/** One controller's program as the wiring checks read it: bound to the scene's wiring as Play binds it (its bindable
 *  names include a sole instance's bare aliases), with a value of the right kind for each wired tag. */
function linkOf(run: RunFacts, parts: readonly PartInstance[]): { inputs: string[]; outputs: string[]; bindable: string[]; aliases: ReadonlyMap<string, string>; watch: Record<string, boolean | number | string> } | null {
  if (!run.surface) return null
  const aliases = new Map(run.surface.aliases)
  const bound = boundNames(run.surface, aliases, wiredBindings(parts, boundNames(run.surface, aliases)))
  const watch: Record<string, boolean | number | string> = {}
  for (const [tag, kind] of Object.entries(run.kinds)) watch[aliases.get(tag) ?? tag] = SAMPLE[kind]
  return { ...bound, aliases, watch }
}

const GROUP_RANK: Record<ProblemGroup, number> = { Program: 0, Wiring: 1, Parts: 2, Layout: 3 }

/**
 * Collect every problem the open document currently has. `known` is what the program says (program/programFacts.ts),
 * when a worker has already worked it out for this very input ({@link factsArgsOf}); without it the program is checked
 * and compiled here.
 */
export function collectProblems(input: ProblemsInput, known?: ProgramFacts): ProblemsReport {
  const problems: Problem[] = []
  const notes: string[] = []
  // A program written for a dialect this build does not have is not checked as IEC: every check below would report
  // errors that are not in it. It is one row, the refusal Play gives, and to everything below it is no program at
  // all, except that the wiring checks that count the program as a writer or reader stay quiet (see brokenProgram).
  const dialect = input.stDialect
  const foreign = dialect !== undefined && !isKnownDialect(dialect)
  if (foreign) {
    problems.push({ key: `dialect:${dialect}`, severity: 'error', group: 'Program', subject: 'Program', message: dialectRefusal(dialect), parts: [] })
    notes.push('The PLC program is in a dialect this version cannot read, so the checks that need its declarations did not run.')
  }
  const src = foreign ? '' : input.stProgram
  const nameOf = (packageId: string): string => input.packageNames?.[packageId] ?? packageId
  const labelOf = (partId: string): string => input.parts.find((p) => p.id === partId)?.name ?? partId

  // the ST program: syntax, then type-check (diagnostics() suppresses the cascade itself), together with
  // its controller table when it has one. A table's own problems have no line in the text to point at,
  // so they are rows about the controller rather than about a place in the program
  const controller = foreign ? null : (input.controller ?? null)
  const facts = known ?? programFactsOf(factsArgsOf(input), compiledOnce)
  const found = facts.check
  for (const message of found.controller) {
    problems.push({ key: `controller:${message}`, severity: 'error', group: 'Program', subject: 'Controller', message, parts: [], panel: 'tasks' })
  }
  if (src.trim() !== '') {
    for (const d of found.source) {
      // with a table, what the CONFIGURATION check points at in the code (statements no instance runs) is a row to fix,
      // listed above as the Controller's; the gutter still marks it where it is
      if (controller && d.origin === 'configuration') continue
      const line = lineOf(src, d.pos.offset)
      problems.push({
        key: `program:${d.pos.offset}:${d.message}`,
        severity: d.severity === 'warning' ? 'warning' : 'error',
        group: 'Program',
        subject: `Line ${line}`,
        message: d.message,
        parts: [],
        offset: d.pos.offset,
        line,
      })
    }
  }

  // Without a compiled program the part-vs-part wiring checks still run; the program-side ones
  // cannot. Say so - a scene whose logic does not compile would otherwise look better wired than
  // one whose logic does.
  // with the scene's bindings by wiring, as Play attaches it: a controller tag a part is wired to is connected
  // Each controller the simulator runs compiles its own share of the program, as Play runs it (plc/controller.ts
  // controllerRuns): the default one's is checked here as the program, and each other one's against its own tags below.
  const simulated = simulatedOf(input)
  const main = facts.main
  const link = main ? linkOf(main, input.parts) : null
  const brokenProgram = src.trim() !== '' && link === null
  if (brokenProgram) {
    notes.push('The PLC program does not compile, so the checks that need its declarations did not run.')
  }
  // compile() refused a program the checks above passed. The checker is meant to run every check the compiler
  // does, so this is a gap in it (a function block holding itself was one), but the panel must not read
  // "0 errors" for a program that will not run: the compiler's own message is the row
  if (main?.error && !problems.some((p) => p.severity === 'error' && p.group === 'Program')) {
    const message = main.error.message
    const at = main.error.offset
    // with a table the compiled source is the program with its CONFIGURATION appended, so past the program's own text is the table's
    if (at !== undefined && (!controller || at < src.trimEnd().length)) {
      const line = lineOf(src, at)
      problems.push({ key: `compile:${at}:${message}`, severity: 'error', group: 'Program', subject: `Line ${line}`, message, parts: [], offset: at, line })
    } else {
      problems.push({ key: `compile:${message}`, severity: 'error', group: 'Program', subject: controller ? 'Controller' : 'Program', message, parts: [], ...(controller ? { panel: 'tasks' as const } : {}) })
    }
  }

  // The program faulted while it ran. The scan dropped it to STOP and every device went to hand control. The PLC
  // panel's status line says so until Stop clears it, and this row outlasts the run, like a part's runtime failure
  // below. The caller passes it only while the program still reads as it did, so an edit retires it.
  if (input.plcFault && !foreign) {
    const f = input.plcFault
    const message = `${f.message}: the scan faulted, so the program stopped and every device went to hand control`
    const at = f.line !== undefined ? offsetAt(src, f.line, f.col ?? 1) : undefined
    if (at !== undefined) {
      const line = lineOf(src, at)
      problems.push({ key: `plcfault:${at}:${f.message}`, severity: 'error', group: 'Program', subject: `Line ${line}`, message, parts: [], offset: at, line })
    } else {
      problems.push({ key: `plcfault:${f.message}`, severity: 'error', group: 'Program', subject: 'Program', message, parts: [] })
    }
  }

  // a task the sim cannot scan on its INTERVAL drops scans and its timers lag sim time. A warning, because a
  // real PLC may well hold that interval and the program exports fine; only the sim cannot. It depends on the
  // document alone (see shortestHeldIntervalSec), so it is reported here before Run, not counted during it
  if (main?.surface) {
    const shortest = shortestHeldIntervalSec(input.stepHz)
    // the value the message offers, rounded up to a whole microsecond so it is one that holds
    const shortestText = timeToString(Math.ceil(shortest * 1e6 - 1e-6) / 1000)
    for (const t of main.tasks) {
      // the scheduler's own tolerance (plc/scanEngine.ts), so an interval AT the limit is not flagged by a rounding error
      if (t.kind !== 'periodic' || t.periodSec >= shortest * (1 - 1e-6)) continue
      // the limit scales with the step: the rate at which this interval would hold, if a project may choose it
      const hz = Math.ceil((input.stepHz * shortest) / t.periodSec - 1e-9)
      const fix = hz <= MAX_SIM_HZ ? `use ${shortestText} or longer, or a step rate of ${hz} Hz or more` : `use ${shortestText} or longer`
      const message = `task ${t.name} runs every ${timeToString(t.periodSec * 1000)}, faster than the simulator can scan it at ${input.stepHz} Hz steps, so it drops scans and its timers lag sim time: ${fix}`
      const row = { key: `task-rate:${t.name}`, severity: 'warning', group: 'Program', message, parts: [] } as const
      if (controller) {
        // a table's intervals are its tasks, fixed in the organizer (whole ms from 1 up, so only a hand-edited table gets here)
        problems.push({ ...row, subject: 'Controller', panel: 'tasks' })
        continue
      }
      const offset = main.intervals[t.name]
      if (offset === undefined) {
        problems.push({ ...row, subject: `Task ${t.name}` })
        continue
      }
      const line = lineOf(src, offset)
      problems.push({ ...row, subject: `Line ${line}`, offset, line })
    }
  }

  // wiring: does the tag plumbing connect (direction- and type-aware)
  const wiring = checkWiring(input.parts, link ?? undefined)
  // the program/scene name bridge: declared-but-unhandled, wired-but-undeclared
  const { unbound, unwired } = link ? unhandledProgramTags(input.parts, link) : { unbound: [], unwired: [] }
  // A tag the program never declares is always undriven or unread too, since a part's tag connects only to the
  // program. That row names the parts and can be clicked, so it carries the likelier cause instead of a second row.
  const undeclared = new Set(unwired)
  // what the project's tests read and drive answers an `unread` / `undriven` warning, as in check-wiring
  const tests = (input.tests ?? []).map((spec, i) => ({ label: spec.name ?? `test-${i + 1}`, spec }))
  for (const p of coverByTests(wiring.problems, tests).problems) {
    // `undriven`/`unread` ask whether anything drives or reads a tag, and the program counts as a
    // writer/reader. So with no link they fire on every tag the program handles. Those warnings are
    // wrong, caused by the blind spot rather than by the scene: one stray semicolon turns the demo's
    // clean panel into 36 of them. The note above already says the program-side checks did not run,
    // and a warning per tag on top teaches people to ignore the panel. The part-vs-part kinds
    // (contested, type-clash) need no program and stay.
    if ((brokenProgram || foreign) && (p.kind === 'undriven' || p.kind === 'unread')) continue
    problems.push({
      key: `wiring:${p.kind}:${p.tag}`,
      severity: p.severity,
      group: 'Wiring',
      subject: p.tag,
      message: (p.kind === 'undriven' || p.kind === 'unread') && undeclared.has(p.tag) ? `${p.message}. The program does not declare it, which is usually a typo` : p.message,
      parts: p.parts,
    })
  }
  // another controller the simulator runs: its program against its own tags, as the default one's is above. Only what
  // is the program's to say: the part-against-part checks already ran on every tag, names and all
  for (const r of facts.others) {
    const name = r.controller
    const own = linkOf(r, partsForController(input.parts, name))
    if (!own) {
      problems.push({ key: `controller-compile:${name}`, severity: 'error', group: 'Program', subject: name, message: `does not compile its program instances: ${r.error?.message ?? 'it does not compile'}`, parts: [], panel: 'tasks' })
      continue
    }
    const seen = partsForController(input.parts, name)
    for (const w of checkWiring(seen, own).problems) {
      if (w.kind !== 'undriven' && w.kind !== 'unread' && w.kind !== 'program-type') continue
      const tag = controllerTag(name, w.tag)
      problems.push({ key: `wiring:${w.kind}:${tag}`, severity: w.severity, group: 'Wiring', subject: tag, message: w.message, parts: w.parts })
    }
    for (const tag of unhandledProgramTags(seen, own).unbound) {
      const named = controllerTag(name, tag)
      problems.push({ key: `unbound:${named}`, severity: 'warning', group: 'Wiring', subject: named, message: 'the program declares it, but no part reads or writes it', parts: [] })
    }
  }
  // a program instance on a controller that will not run it here
  for (const q of controller?.programs ?? []) {
    // its task's controller, or its own on no task
    const plc = plcOfProgram(controller!, q)
    if (plc === undefined || (input.mainPlcName !== undefined && plc.toLowerCase() === input.mainPlcName.toLowerCase())) continue
    if (simulated.some((n) => n.toLowerCase() === plc.toLowerCase())) continue
    const named = (input.namedPlcs ?? []).find((c) => c.name.toLowerCase() === plc.toLowerCase())
    problems.push({
      key: `instance-plc:${q.name}`,
      severity: 'warning',
      group: 'Program',
      subject: q.name,
      message: !named
        ? `runs on ${plc}, which the project has no controller for, so it does not run`
        : named.runsOn === 'plc'
          ? `runs on ${named.name}, a PLC outside the app, so it does not run here: run ${named.name} in the simulator, or give the instance to another controller`
          : `runs on ${named.name}, which is switched off, so it does not run`,
      parts: [],
      panel: 'tasks',
    })
  }
  // a controller the simulator runs with nothing to run: its tags read and drive nothing
  for (const name of simulated) {
    if (facts.runControllers.includes(name)) continue
    problems.push({ key: `controller-idle:${name}`, severity: 'warning', group: 'Program', subject: name, message: "runs in the simulator but runs no program instance: put one on a task of this controller's in the organizer's Tasks", parts: [], panel: 'tasks' })
  }
  // a controller the tags name that Play will not connect: its tags read and drive nothing
  if (input.namedPlcs) {
    for (const name of controllersUsed(input.parts)) {
      const set = input.namedPlcs.find((c) => c.name === name)
      if (set?.enabled) continue
      // the default controller's tags carry no name, and one that does is a tag the sim keeps apart from them
      if (input.mainPlcName !== undefined && name.toLowerCase() === input.mainPlcName.toLowerCase()) {
        problems.push({
          key: `controller:${name}`,
          severity: 'warning',
          group: 'Wiring',
          subject: name,
          message: 'tags name the default controller, whose tags carry no name: take the name off, or they stay unconnected',
          parts: partsNaming(input.parts, name),
        })
        continue
      }
      // set up in another case: the tags must be spelled as it is to reach it (the wiring check says so too)
      const asSetUp = set ? undefined : input.namedPlcs.find((c) => c.name.toLowerCase() === name.toLowerCase())
      problems.push({
        key: `controller:${name}`,
        severity: 'warning',
        group: 'Wiring',
        subject: name,
        message: set
          ? 'tags name this controller, but it is switched off in Controller Properties, so Play leaves its tags unconnected'
          : asSetUp
            ? `tags name this controller, which the project lists as ${asSetUp.name}: spell the tags ${asSetUp.name} to reach it`
            : 'tags name this controller, but the project has no controller by that name (add it in Controller Properties), so Play leaves its tags unconnected',
        parts: partsNaming(input.parts, name),
      })
    }
  }
  if (wiring.unresolvedPackages.length > 0) {
    notes.push(`Tags unknown for ${wiring.unresolvedPackages.join(', ')}: the package is not loaded, so parts using it were not checked.`)
  }

  for (const tag of unbound) {
    problems.push({
      key: `unbound:${tag}`,
      severity: 'warning',
      group: 'Wiring',
      subject: tag,
      message: 'the program declares it, but no part reads or writes it',
      parts: [],
    })
  }
  // A `@bind` pragma names a scoped cell's tags, and this build has no tag scope, so one left in a
  // program is a comment that binds nothing. Said where it stands, since the program around it still compiles.
  for (const m of src.matchAll(/\(\*\s*@bind\b/g)) {
    const offset = m.index
    const line = lineOf(src, offset)
    problems.push({
      key: `bind:${offset}`,
      severity: 'warning',
      group: 'Wiring',
      subject: `Line ${line}`,
      message: '@bind was retired, so this comment binds nothing: wire a part to the variable by its name instead',
      parts: [],
      offset,
      line,
    })
  }

  // authored parts that did not build: the catalog card shows the last good version, so without a
  // row here the only trace is a badge the author has probably already dismissed
  for (const packageId of Object.keys(input.buildErrors).sort()) {
    const message = input.buildErrors[packageId]
    if (!message) continue
    problems.push({
      key: `build:${packageId}`,
      severity: 'error',
      group: 'Parts',
      subject: nameOf(packageId),
      message: `does not build: ${message}`,
      parts: input.parts.filter((p) => p.type === 'part' && p.packageId === packageId).map((p) => p.id),
    })
  }

  // parts made under a newer Part SDK than this build's (core/parts/partSdk.ts): they may use something this build lacks,
  // and would then fail inside the part with no word why. A warning, since most such parts use nothing new
  const newer = new Map<string, string[]>()
  for (const p of input.parts) {
    if (p.type === 'part') newer.set(p.packageId, [...(newer.get(p.packageId) ?? []), p.id])
  }
  for (const [packageId, placed] of [...newer].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const pkg = getPackage(packageId)
    const level = pkg ? newerSdkLevel(pkg) : undefined
    if (level === undefined) continue
    problems.push({
      key: `sdk:${packageId}`,
      severity: 'warning',
      group: 'Parts',
      subject: nameOf(packageId),
      message: `made with a newer version of the app (Part SDK level ${level}; this app has ${PART_SDK_LEVEL}), so it may use something this app lacks. Update the app if it misbehaves`,
      parts: placed,
    })
  }

  // parts failing at runtime: a step() that threw, a geometry() that fell back, a command to a joint
  // the rig does not have. All silent by design in the sim; this is where they surface
  for (const d of input.runtime) {
    problems.push({
      key: `runtime:${d.source}:${d.partId}:${d.packageId}:${d.message}`,
      severity: 'error',
      group: 'Parts',
      subject: d.partId ? labelOf(d.partId) : nameOf(d.packageId),
      message: `${d.source}: ${d.message}`,
      parts: d.partId ? [d.partId] : [],
      ...(d.count > 1 ? { count: d.count } : {}),
    })
  }

  // a part-reference param (a spawner's "pause when this conveyor stops") naming a part that is not in the scene:
  // the part was deleted, or the reference came in with a cell pasted from another scene. Inert by design
  // (ctx.conveyorRunning reads a missing part as running), which is exactly why nothing else says so. An error,
  // not a warning: the Inspector only offers parts that exist, so unlike an undriven tag this is never a
  // reference still being written, and what it configured (an interlock) has silently stopped happening
  const ids = new Set(input.parts.map((p) => p.id))
  for (const p of input.parts) {
    if (p.type !== 'part') continue
    const pkg = getPackage(p.packageId)
    if (!pkg) continue
    for (const spec of packageParamSpecs(pkg)) {
      const target = spec.kind === 'partRef' ? p.params[spec.key] : undefined
      if (typeof target !== 'string' || target === '' || ids.has(target)) continue
      problems.push({
        key: `partref:${p.id}:${spec.key}`,
        severity: 'error',
        group: 'Parts',
        subject: labelOf(p.id),
        message: `"${spec.label}" points at ${target}, which is not in this scene, so it does nothing: pick another part in the Inspector`,
        parts: [p.id],
      })
    }
  }

  // parts that declare they seat onto a host and have none near them, and parts standing in an interior building
  // column: the check-layout CLI's errors, so they are errors here too (core/checkLayout.ts says why it reports
  // disconnection, and the column clash is its one collision). A conveyor end against a spur's side is its warning.
  for (const f of checkLayout(input.parts)) {
    problems.push({ key: `layout:${f.kind}:${f.partId}`, severity: f.severity, group: 'Layout', subject: f.partName ?? f.partId, message: f.detail, parts: [f.partId] })
  }

  // what nothing above could look at
  if (input.runtimeOverflowed) notes.push('Part runtime problems stopped being recorded after the first 200, so some may be missing here.')
  const held = input.heldCode ?? 0
  if (held > 0) {
    notes.push(
      held === 1
        ? '1 part type in this shared project is blocked from running its own code, so its runtime problems come from the stand-in that runs instead.'
        : `${held} part types in this shared project are blocked from running their own code, so their runtime problems come from the stand-ins that run instead.`,
    )
  }
  if (input.externalPlc) notes.push('An external PLC runs the logic when you press Play, so the program checks above are about the program in this app, which does not run.')

  problems.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group]
    return a.key.localeCompare(b.key)
  })
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.filter((p) => p.severity === 'warning').length
  return { problems, errors, warnings, notes }
}
