// The IEC front end of a scene's controller table (core/controller.ts): the CONFIGURATION a table
// stands for, the source a scene actually runs, and a program's problems kept apart from its table's.
//
// The engine compiles one source string and reads tasks from a CONFIGURATION inside it (checker.ts),
// so a table runs by appending the CONFIGURATION it stands for to the scene's program. That keeps one
// parser, one checker and one set of messages for both spellings of a controller. The downside is that
// a problem with the table surfaces in text nobody wrote, and a problem in the program can spill into
// that text (a missing END_PROGRAM parses straight on into the generated CONFIGURATION). Everything
// below keeps the two apart. A program's error is reported in the program, where the editor can mark
// it. A table's is reported as the table's, never as a line number past the end of the file the
// author is looking at.
//
// Every program has a controller. One with no table of its own runs from the default table: one task at
// its scan time, running the code outside every PROGRAM and each PROGRAM (`defaultController`). That code's
// variables are the controller's tags, so they keep their bare names whichever table runs them, and a
// PROGRAM added beside them renames nothing. A program that is only that code, with no table, is not
// composed at all. As the implicit program on its scan time it runs exactly as the default table would,
// so its own text is what runs.

import type { Controller, ControllerProgram, ControllerTask } from '../core/controller'
import { diagnostics, parseAndCheck, syntaxDiagnostics } from './checker'
import { parseDocument, unusedName } from './document'
import { matchInCode, splitLibrary, triviaMask } from './exchange/exportText'
import { KEYWORDS, lex } from './lexer'
import { parse } from './parser'
import { parseStructure } from './structure'
import type { Diagnostic, SourcePos } from './types'
import { StError } from './types'

/** A new task's priority: IEC's 0 is the highest, so 10 leaves room for a faster task above it. */
export const DEFAULT_TASK_PRIORITY = 10

/** A problem with the controller table, rather than with a line of the program. */
export class ControllerError extends StError {
  constructor(message: string, pos: SourcePos) {
    super(message, pos)
    this.name = 'ControllerError'
  }
}

/** The IEC CONFIGURATION a table stands for: one resource, its tasks, then its program instances in table order.
 *  The instance with no type is written with none, which is how the engine runs the code outside every POU. */
export function configurationText(controller: Controller): string {
  return [
    'CONFIGURATION Config0',
    '  RESOURCE Res0 ON PLC',
    ...controller.tasks.map((t) => `    TASK ${t.name}(INTERVAL := T#${t.intervalMs}ms, PRIORITY := ${t.priority});`),
    ...controller.programs.map((p) => `    PROGRAM ${p.name}${p.task !== undefined ? ` WITH ${p.task}` : ''}${p.type !== undefined ? ` : ${p.type}` : ''};`),
    '  END_RESOURCE',
    'END_CONFIGURATION',
  ].join('\n')
}

/** The PROGRAM types a program declares, in source order. Tolerant of half-written code, like the POU strip. */
export function programTypes(source: string): string[] {
  return parseDocument(source)
    .blocks.filter((b) => b.kind === 'programPou')
    .map((b) => b.name)
}

/** Whether the code outside every PROGRAM has statements: those run only while an instance with no type runs
 *  them. True when the program cannot be read, the safe answer for a caller about to stop running them. */
export function topLevelStatements(source: string): boolean {
  const { ast } = parseStructure(source)
  return ast ? ast.body.length > 0 : true
}

/**
 * Where the controller's own program is: the statements and the ladder sections written
 * outside every PROGRAM, after the controller's tags (which are declarations, and no part of it). Null when there is
 * none: the tags alone are no program. Null too when a block stands after that code, which no edit here writes.
 */
export function mainProgramCode(source: string): { from: number; to: number } | null {
  const { ast } = parseStructure(source)
  if (!ast) return null
  const from = ast.bodyStart
  const to = configurationAt(source) ?? source.length
  if (from >= to || source.slice(from, to).trim() === '') return null
  const after = [...ast.typeDefs, ...ast.enumDefs, ...ast.subrangeDefs, ...ast.aliasDefs, ...ast.fbDefs, ...ast.funcDefs, ...ast.programDefs].some((d) => d.pos.offset > from && d.pos.offset < to)
  return after ? null : { from, to }
}

/** `source` without the controller's own program: its statements and routines go, the controller's tags stay. */
export function deleteMainProgram(source: string): string {
  const at = mainProgramCode(source)
  if (!at) return source
  const rest = source.slice(at.to)
  return `${source.slice(0, at.from).replace(/\s+$/, '')}\n${rest === '' ? '' : `\n${rest}`}`
}

/**
 * The table a program with none of its own runs from: `MainTask` at the scan time, running all of the program.
 * The code outside every PROGRAM runs as `Main` (or `Main1`, ... when the program already spells that name)
 * when it has statements or there is no PROGRAM, and each PROGRAM runs as an instance named after it, in the
 * order they are written. Storing this table, as the organizer's first edit does, renames nothing.
 */
export function defaultController(source: string, scanMs: number): Controller {
  const task: ControllerTask = { name: 'MainTask', intervalMs: Math.max(1, Math.round(scanMs)), priority: DEFAULT_TASK_PRIORITY }
  const types = programTypes(source)
  const topLevel = types.length === 0 || topLevelStatements(source) ? [{ name: unusedName(source, 'Main'), task: task.name }] : []
  return { tasks: [task], programs: [...topLevel, ...types.map((type) => ({ name: type, type, task: task.name }))] }
}

/**
 * The interval of a table that is still the default one for `source`, retimed; null for any other table, one that
 * runs an instance on another controller among them.
 * That table is the program's scan time and nothing more, so a program with no table of its own keeps none.
 */
export function defaultInterval(source: string, controller: Controller): number | null {
  const [task, extraTask] = controller.tasks
  if (!task || extraTask) return null
  const d = defaultController(source, task.intervalMs)
  const dt = d.tasks[0]!
  const same =
    task.name === dt.name &&
    task.priority === dt.priority &&
    controller.programs.length === d.programs.length &&
    controller.programs.every((p, i) => p.name === d.programs[i]!.name && p.type === d.programs[i]!.type && p.task === d.programs[i]!.task && p.plc === undefined) &&
    task.plc === undefined
  return same ? task.intervalMs : null
}

/**
 * The table a program runs from: its own; the default one when it has none and declares a PROGRAM; or null
 * when its text runs as written, because it is only the code outside every PROGRAM (the implicit program,
 * which runs as the default table would) or it declares a CONFIGURATION of its own.
 */
export function controllerFor(source: string, controller: Controller | null | undefined, scanMs: number): Controller | null {
  if (controller) return controller
  if (declaresConfiguration(source) || !declaresProgram(source)) return null
  return defaultController(source, scanMs)
}

/** One controller the simulator runs (null: the default one), and the program and table it compiles. */
export interface ControllerRun {
  controller: string | null
  source: string
  table: Controller | null
}

/**
 * The controller a task runs on: its own (ControllerTask.plc), except a task that runs the instance with no type, which
 * stays on the default controller whatever it names. That instance runs the code outside every POU, the default
 * controller's own (withoutControllerTags blanks it for every other), so on another controller it would run nothing and
 * leave the default with no program. controllerDiagnostics says when a task's own name is overruled this way.
 */
export function plcOfTask(controller: Controller, t: ControllerTask): string | undefined {
  if (t.plc === undefined) return undefined
  const name = t.name.toLowerCase()
  return controller.programs.some((p) => p.type === undefined && p.task?.toLowerCase() === name) ? undefined : t.plc
}

/** The controller a program instance runs on: its task's (plcOfTask), or its own when it is on no task. */
export function plcOfProgram(controller: Controller, p: ControllerProgram): string | undefined {
  if (p.task === undefined) return p.plc
  const task = p.task.toLowerCase()
  const t = controller.tasks.find((k) => k.name.toLowerCase() === task)
  return t ? plcOfTask(controller, t) : undefined
}

/** A task that names another controller but stays on the default one, since it runs the code outside every POU
 *  (plcOfTask): each as a sentence for the Problems dock and the organizer, which the default controller's `name` spells. */
export function pinnedTaskMessages(controller: Controller | null | undefined, defaultName?: string): string[] {
  if (!controller) return []
  const isDefault = (n: string): boolean => defaultName !== undefined && n.toLowerCase() === defaultName.toLowerCase()
  return controller.tasks.flatMap((t) => {
    if (t.plc === undefined || isDefault(t.plc) || plcOfTask(controller, t) !== undefined) return []
    const top = controller.programs.find((p) => p.type === undefined && p.task?.toLowerCase() === t.name.toLowerCase())!
    const home = defaultName ?? 'the default controller'
    return [`Task ${t.name} names ${t.plc}, but it runs ${top.name}, the code outside every POU, which only ${home} runs, so it stays on ${home}. Put ${top.name} on another of ${home}'s tasks to move ${t.name}.`]
  })
}

/**
 * How the simulator runs a program across controllers. A controller owns its tasks (ControllerTask.plc), and runs the
 * instances on them, and the instances on no task that name it. The default controller runs everything that names no
 * controller, the code outside every PROGRAM among it, from the table as before. Each controller in `simulated` runs
 * its own from the same program without the code outside every POU (withoutControllerTags): those variables and
 * statements are the default controller's own, so they run once, and only there. VAR_GLOBAL blocks stay, since every
 * POU may read them. Every controller compiles every POU, so a FUNCTION_BLOCK is shared the way a library is, and each
 * runs it on memory of its own. A controller not in `simulated` runs nothing here, which the Problems dock says.
 * `defaultName` is the default controller's own name, which a task may also spell.
 */
export function controllerRuns(source: string, controller: Controller | null | undefined, scanMs: number, opts: { defaultName?: string; simulated: readonly string[] }): ControllerRun[] {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  const onDefault = (plc: string | undefined): boolean => plc === undefined || (opts.defaultName !== undefined && same(plc, opts.defaultName))
  if (!controller || (controller.tasks.every((t) => onDefault(plcOfTask(controller, t))) && controller.programs.every((p) => onDefault(p.plc)))) {
    return [{ controller: null, source, table: controllerFor(source, controller, scanMs) }]
  }
  const program = ({ plc: _plc, ...rest }: ControllerProgram): ControllerProgram => rest
  const task = ({ plc: _plc, ...rest }: ControllerTask): ControllerTask => rest
  const table = (on: (plc: string | undefined) => boolean): Controller => ({
    tasks: controller.tasks.filter((t) => on(plcOfTask(controller, t))).map(task),
    programs: controller.programs.filter((p) => on(plcOfProgram(controller, p))).map(program),
  })
  const runs: ControllerRun[] = [{ controller: null, source, table: table(onDefault) }]
  const shared = withoutControllerTags(source)
  for (const name of opts.simulated) {
    const own = table((plc) => plc !== undefined && same(plc, name))
    if (own.programs.length > 0) runs.push({ controller: name, source: shared, table: own })
  }
  return runs
}

/**
 * `source` with the code outside every POU blanked: the default controller's own variables and the statements its
 * instance with no type runs. Blanked, not cut, keeping every line break, so each POU stays at the line and column it
 * has in the program the editor shows, and a fault on another controller points at the right place.
 */
export function withoutControllerTags(source: string): string {
  let out = source
  let at = 0
  for (const b of parseDocument(source).blocks) {
    const from = source.indexOf(b.text, at)
    if (from < 0) continue
    at = from + b.text.length
    if (b.kind === 'program') out = out.slice(0, from) + b.text.replace(/[^\r\n]/g, ' ') + out.slice(at)
  }
  return out
}

function declaresProgram(source: string): boolean {
  try {
    return splitLibrary(source).blocks.some((b) => b.kind === 'program')
  } catch {
    return false // a block still being typed: its syntax error is what gets reported
  }
}

/** Where a CONFIGURATION the program declares itself starts, or null. A tolerant parse, so half-typed code answers too. */
function configurationAt(source: string): number | null {
  return parseStructure(source).ast?.configuration?.pos.offset ?? null
}

/** Whether the program declares a CONFIGURATION of its own. */
export function declaresConfiguration(source: string): boolean {
  return configurationAt(source) !== null
}

/** Where the program's own text ends in the composed source: everything from here on was generated. */
function programEnd(source: string): number {
  return source.replace(/\s+$/, '').length
}

/** The 1-based line and column of an offset. */
function posAt(source: string, offset: number): SourcePos {
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - before.lastIndexOf('\n'), offset }
}

/**
 * The source a scene runs: its ST program with the CONFIGURATION its table stands for appended. With no
 * table, the program alone, untouched.
 */
export function controllerSource(source: string, controller: Controller | null | undefined): string {
  if (!controller) return source
  const program = source.slice(0, programEnd(source))
  return `${program}${program === '' ? '' : '\n\n'}${configurationText(controller)}\n`
}

/** A CONFIGURATION the program declares itself, which a table-run scene cannot also have. */
function ownConfiguration(source: string): Diagnostic | null {
  const at = configurationAt(source)
  if (at === null) return null
  return {
    message: "this project's controller table declares its tasks, so the program cannot declare a CONFIGURATION of its own: delete it here, or move its tasks into the table",
    pos: posAt(source, at),
    length: 'CONFIGURATION'.length,
  }
}

/** An identifier ST can spell: the rule the organizer's name fields apply as a name is typed (controllerEdits.ts). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The names in a table that ST cannot spell, each as the table's problem. The organizer refuses them as they are typed,
 * but a table can also come from a hand-edited scene file or an agent. The table runs as CONFIGURATION text, and a name
 * like `Bad Name` breaks that text in a way the parser can only blame on the program, hiding every other table problem.
 */
function unwritableNames(controller: Controller): string[] {
  const bad = (name: string): boolean => !IDENT.test(name) || KEYWORDS.has(name.toUpperCase())
  const rule = 'letters, digits and _ only, starting with a letter or _, and not a reserved word'
  const out: string[] = []
  const badTasks = new Set<string>()
  for (const t of controller.tasks) {
    if (!bad(t.name)) continue
    badTasks.add(t.name)
    out.push(`task name "${t.name}" cannot be written in ST: ${rule}`)
  }
  for (const p of controller.programs) {
    if (bad(p.name)) out.push(`program name "${p.name}" cannot be written in ST: ${rule}`)
    if (p.type !== undefined && bad(p.type)) out.push(`program ${p.name} runs "${p.type}", which cannot be written in ST: ${rule}`)
    if (p.task !== undefined && bad(p.task) && !badTasks.has(p.task)) out.push(`program ${p.name} names task "${p.task}", which cannot be written in ST: ${rule}`)
  }
  return out
}

export interface ControllerDiagnostics {
  /** positioned in the scene's ST program, for the editor's gutter */
  source: Diagnostic[]
  /**
   * about the table itself: a PROGRAM type the program does not declare, a task nobody declared, ... Also what the
   * CONFIGURATION check points at in the code, such as statements no instance runs: those stay in `source` too, marked
   * `origin: 'configuration'`, so the gutter still shows where they are and a list of both can skip them there.
   */
  controller: string[]
}

/**
 * Every problem a scene's program and table have, split by whose they are. The program is parsed on
 * its own first, so a syntax error in it is reported there instead of wherever the parser stopped
 * inside the generated CONFIGURATION; only a program that parses is checked together with its table.
 */
export function controllerDiagnostics(source: string, controller: Controller | null | undefined, opts: { defaultName?: string } = {}): ControllerDiagnostics {
  // a table across several controllers is checked as it runs, each controller's share on its own (controllerRuns): two
  // instances that locate the same address on two controllers are on two sets of I/O, not one. A task that spells the
  // default controller's own name is the default's, as it is when the program runs.
  const isDefault = (n: string): boolean => opts.defaultName !== undefined && n.toLowerCase() === opts.defaultName.toLowerCase()
  const named = [...new Set([...(controller?.tasks ?? []).map((t) => t.plc), ...(controller?.programs ?? []).map((p) => p.plc)].filter((n): n is string => n !== undefined && !isDefault(n)))]
  if (!controller || named.length === 0) return diagnosticsOfOne(source, controller)
  const out: ControllerDiagnostics = { source: [], controller: pinnedTaskMessages(controller, opts.defaultName) }
  const seen = new Set<string>()
  for (const run of controllerRuns(source, controller, 0, { ...(opts.defaultName !== undefined ? { defaultName: opts.defaultName } : {}), simulated: named })) {
    const found = diagnosticsOfOne(run.source, run.table)
    for (const d of found.source) {
      const key = `${d.pos.offset}:${d.message}`
      if (seen.has(key)) continue
      seen.add(key)
      out.source.push(d)
    }
    for (const m of found.controller) {
      const message = run.controller === null ? m : `${run.controller}: ${m}`
      if (!out.controller.includes(message)) out.controller.push(message)
    }
  }
  return out
}

/** Every problem one controller's program and table have (controllerDiagnostics, for a table on one controller). */
function diagnosticsOfOne(source: string, controller: Controller | null | undefined): ControllerDiagnostics {
  if (!controller) return { source: diagnostics(source, undefined), controller: [] }
  // a name the generated CONFIGURATION cannot spell makes the rest unreadable, program included: it is fixed first
  const unwritable = unwritableNames(controller)
  if (unwritable.length > 0) return { source: [], controller: unwritable }
  // Parsed as it will run, with the CONFIGURATION appended, because code outside every PROGRAM beside a
  // PROGRAM only reads as the controller's once a CONFIGURATION is there. A program that runs on into the
  // generated text (a missing END_PROGRAM) is reported the way it reads alone, where its error is.
  const end = programEnd(source)
  const syntax = syntaxDiagnostics(controllerSource(source, controller))
  if (syntax.length > 0 && syntax.every((d) => d.pos.offset < end)) return { source: syntax, controller: [] }
  if (syntax.length > 0) {
    const alone = syntaxDiagnostics(source)
    if (alone.length > 0) return { source: alone, controller: [] }
  }
  // a CONFIGURATION of the program's own collides with the generated one, which is not the program's error to find
  const own = ownConfiguration(source)
  if (own) return { source: [own], controller: [] }
  if (syntax.length > 0) return { source: [], controller: syntax.map((d) => d.message) }
  const found = diagnostics(controllerSource(source, controller), undefined)
  return {
    source: found.filter((d) => d.pos.offset < end),
    // past the program, or raised by the CONFIGURATION check wherever it points: a row is what fixes either
    controller: found.filter((d) => d.pos.offset >= end || d.origin === 'configuration').map((d) => d.message),
  }
}

/**
 * The source to run for a scene, proven to compile. Throws the way `compile` does, with one difference:
 * a problem the table causes is a {@link ControllerError}, positioned at the end of the program rather
 * than inside text the author never saw. Every host that attaches a scene's program goes through here.
 */
export function runnableSource(source: string, controller: Controller | null | undefined): string {
  if (!controller) return source
  const unwritable = unwritableNames(controller)[0]
  if (unwritable !== undefined) throw new ControllerError(unwritable, posAt(source, programEnd(source)))
  const own = ownConfiguration(source)
  if (own) throw new StError(own.message, own.pos, own.length)
  const composed = controllerSource(source, controller)
  const end = programEnd(source)
  try {
    parseAndCheck(composed)
  } catch (e) {
    // the program's own error stays where it is; one past it, or raised by the CONFIGURATION check, is the table's
    if (!(e instanceof StError) || (e.pos.offset < end && e.origin !== 'configuration')) throw e
    // past the program's end: a program that ran on into the generated CONFIGURATION throws where it reads alone
    if (syntaxDiagnostics(composed).length > 0) {
      const alone = syntaxDiagnostics(source)[0]
      if (alone) throw new StError(alone.message, alone.pos, alone.length)
    }
    throw new ControllerError(e.message, posAt(source, end))
  }
  return composed
}

/** Every `VAR_GLOBAL ... END_VAR` block in a span of source, as written. */
function globalBlocks(text: string): string[] {
  const mask = triviaMask(text)
  const out: string[] = []
  for (let at = 0; ; ) {
    const open = matchInCode(text, mask, /\bVAR_GLOBAL\b/i, at)
    if (!open) break
    const close = matchInCode(text, mask, /\bEND_VAR\b/i, open.end)
    if (!close) break
    out.push(text.slice(open.start, close.end).trim())
    at = close.end
  }
  return out
}

/**
 * Split a program that declares its own CONFIGURATION into the program without it and the table it
 * stands for, which is how a file arrives in a scene that keeps its tasks as data (Import .st). The
 * CONFIGURATION's globals stay in the program, at the top.
 *
 * Null when there is no CONFIGURATION, or when it says something a table does not hold: an event task,
 * an interval that is not a literal whole number of milliseconds, a priority that is not a literal, or
 * more than one RESOURCE. Such a file stays as written, and the engine still runs (or refuses) it from
 * the text, so nothing it said is lost on the way in.
 */
export function extractController(source: string): { source: string; controller: Controller } | null {
  let config
  try {
    config = parse(lex(source), null).configuration
  } catch {
    return null
  }
  if (!config || config.resources.length > 1) return null
  const tasks: ControllerTask[] = []
  for (const t of config.tasks) {
    if (t.args.some((a) => a.name === 'SINGLE')) return null
    const iv = t.args.find((a) => a.name === 'INTERVAL')?.value
    const pr = t.args.find((a) => a.name === 'PRIORITY')?.value
    if (iv?.node !== 'num' || iv.declared !== 'TIME' || !Number.isInteger(iv.value) || iv.value < 1) return null
    if (pr?.node !== 'num' || pr.real || pr.declared !== undefined || pr.value < 0) return null
    tasks.push({ name: t.name, intervalMs: iv.value, priority: pr.value })
  }
  const programs = config.programs.map((p) => ({ name: p.name, ...(p.type !== null ? { type: p.type } : {}), ...(p.task !== null ? { task: p.task } : {}) }))

  // the CONFIGURATION's span, wherever it sits: after the PROGRAMs, or after code outside every POU
  const mask = triviaMask(source)
  const close = matchInCode(source, mask, /\bEND_CONFIGURATION\b/i, config.pos.offset)
  if (!close) return null
  const after = matchInCode(source, mask, /\S/, close.end)
  const end = after && source[after.start] === ';' ? after.end : close.end
  const text = source.slice(config.pos.offset, end)
  const rest = `${source.slice(0, config.pos.offset).trimEnd()}\n\n${source.slice(end).trimStart()}`.trim()
  const kept = [...globalBlocks(text), rest].filter((s) => s !== '')
  return { source: kept.length > 0 ? `${kept.join('\n\n')}\n` : '', controller: { tasks, programs } }
}
