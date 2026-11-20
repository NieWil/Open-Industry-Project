// Edits to a scene's controller: its task table (core/controller.ts), and the program text and tag
// names that have to move with it. Pure and DOM-free like document.ts, whose structural edits these
// sit beside: the ST panel applies what they return, the way it applies a block rename.
//
// What renames a tag. The code outside every PROGRAM declares the controller's own tags, under their bare
// names whichever task runs that code, so retiming it, moving it or adding PROGRAMs beside it renames
// nothing. A PROGRAM instance's variables are its own tags, `Instance.Name`, so renaming an instance moves
// tags that parts in the scene may be wired to. The edits that do that return a list of renames, and the
// panel rewires the scene's parts with it (editor/program/controllerRewire.ts), so a line that ran before the edit
// still runs after it.

import type { Controller } from '../core/controller'
import { DEFAULT_TASK_PRIORITY } from './controller'
import { addBlock, blockNameError, parseDocument, renameBlock } from './document'
import { KEYWORDS } from './lexer'
import type { parse } from './parser'
import { parseStructure } from './structure'
import { identKey } from './program'

/** One tag an edit renames: what parts are wired to now, and what they must be wired to after. */
export interface TagRename {
  from: string
  to: string
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A tolerant parse: code outside every PROGRAM beside PROGRAMs is only legal once a table runs it, and
 *  these queries are asked of the program alone, often mid-edit. Null when it does not even tokenize. */
function tolerantParse(source: string): ReturnType<typeof parse> | null {
  return parseStructure(source).ast // (shared with every other reader of this text: structure.ts)
}

/** The VAR_INPUT and VAR_OUTPUT names of a PROGRAM type: the variables that are an instance's tags. */
function ioNames(source: string, type: string): string[] {
  const def = tolerantParse(source)?.programDefs.find((p) => identKey(p.name) === identKey(type))
  return (def?.decls ?? []).filter((d) => d.section === 'VAR_INPUT' || d.section === 'VAR_OUTPUT').map((d) => d.name)
}

/** Every tag of an instance of `type` called `from`, renamed to `to`. */
function instanceRenames(source: string, type: string, from: string, to: string): TagRename[] {
  if (identKey(from) === identKey(to) && from === to) return []
  return ioNames(source, type).map((v) => ({ from: `${from}.${v}`, to: `${to}.${v}` }))
}

/** `base1`, `base2`, ...: the first not in `taken` (case-insensitive). */
function unusedIn(taken: readonly string[], base: string, bareFirst = false): string {
  const keys = new Set(taken.map(identKey))
  if (bareFirst && !keys.has(identKey(base))) return base
  for (let n = 1; ; n++) if (!keys.has(identKey(`${base}${n}`))) return `${base}${n}`
}

/**
 * Add a PROGRAM to the code and an instance of it to the table, on `task` (the first task when absent;
 * a table with no tasks runs it continuously). Returns where the new block landed, so the panel can open
 * its name field.
 */
export function addProgram(
  source: string,
  controller: Controller,
  task?: string,
  kind: 'programPou' | 'ladderProgram' = 'programPou',
): { source: string; controller: Controller; index: number } {
  const edit = addBlock(source, kind)
  const type = parseDocument(edit.source).blocks[edit.index]?.name ?? ''
  const on = task ?? controller.tasks[0]?.name
  const name = unusedIn(controller.programs.map((p) => p.name), type, true)
  return {
    source: edit.source,
    controller: { ...controller, programs: [...controller.programs, { name, type, ...(on !== undefined ? { task: on } : {}) }] },
    index: edit.index,
  }
}

/**
 * Run a PROGRAM the code already has and nothing runs yet (the organizer's "Unscheduled" group): a new instance of
 * `type`, named after it, on `task` (the first task when absent; a table with no tasks runs it continuously). The code
 * is untouched. A null type is the code outside every PROGRAM, whose instance is called `Main`.
 */
export function scheduleProgram(controller: Controller, type: string | null, task?: string): Controller {
  const on = task ?? controller.tasks[0]?.name
  const name = unusedIn(controller.programs.map((p) => p.name), type ?? 'Main', true)
  return { ...controller, programs: [...controller.programs, { name, ...(type !== null ? { type } : {}), ...(on !== undefined ? { task: on } : {}) }] }
}

function nameError(name: string, taken: readonly string[], what: string): string | null {
  const to = name.trim()
  if (to === '') return 'A name is required.'
  if (!IDENT.test(to)) return `"${to}" is not a valid name - letters, digits and _ only, starting with a letter or _.`
  if (KEYWORDS.has(to.toUpperCase())) return `${to.toUpperCase()} is a reserved word.`
  if (taken.some((t) => identKey(t) === identKey(to))) return `Another ${what} is already called ${to}.`
  return null
}

/** Why `name` cannot name task `index`, as a sentence, or null when it can. */
export function taskNameError(controller: Controller, index: number, name: string): string | null {
  return nameError(name, controller.tasks.filter((_, i) => i !== index).map((t) => t.name), 'task')
}

/** Why `name` cannot name program instance `index`, as a sentence, or null when it can. */
export function programNameError(controller: Controller, index: number, name: string): string | null {
  return nameError(name, controller.programs.filter((_, i) => i !== index).map((p) => p.name), 'program')
}

/** A new task, named `Task1`, `Task2`, ..., at the last task's interval, on the controller `plc` (none: the default one). */
export function addTask(controller: Controller, plc?: string): Controller {
  const name = unusedIn(controller.tasks.map((t) => t.name), 'Task')
  const intervalMs = controller.tasks[controller.tasks.length - 1]?.intervalMs ?? 100
  return { ...controller, tasks: [...controller.tasks, { name, intervalMs, priority: DEFAULT_TASK_PRIORITY, ...(plc !== undefined ? { plc } : {}) }] }
}

/** Run task `index`, and the program instances on it, on the controller `plc`, or on the default one with null. */
export function setTaskPlc(controller: Controller, index: number, plc: string | null): Controller {
  return {
    ...controller,
    tasks: controller.tasks.map((t, i) => {
      if (i !== index) return t
      const { plc: _old, ...rest } = t
      return plc === null ? rest : { ...rest, plc }
    }),
  }
}

/** Rename task `index`, and every program that runs on it follows. (Task names are not part of any tag.) */
export function renameTask(controller: Controller, index: number, name: string): Controller {
  const old = controller.tasks[index]
  const to = name.trim()
  if (!old || to === old.name) return controller
  return {
    tasks: controller.tasks.map((t, i) => (i === index ? { ...t, name: to } : t)),
    programs: controller.programs.map((p) => (p.task !== undefined && identKey(p.task) === identKey(old.name) ? { ...p, task: to } : p)),
  }
}

/** Retime or reprioritize task `index`; each value is clamped to what a table holds (whole ms, 1 or more;
 *  a whole priority, 0 or more). */
export function setTaskTiming(controller: Controller, index: number, patch: { intervalMs?: number; priority?: number }): Controller {
  const whole = (v: number, min: number, fallback: number): number => (Number.isFinite(v) ? Math.max(min, Math.round(v)) : fallback)
  return {
    ...controller,
    tasks: controller.tasks.map((t, i) =>
      i !== index
        ? t
        : {
            ...t,
            ...(patch.intervalMs !== undefined ? { intervalMs: whole(patch.intervalMs, 1, t.intervalMs) } : {}),
            ...(patch.priority !== undefined ? { priority: whole(patch.priority, 0, t.priority) } : {}),
          },
    ),
  }
}

/** The programs that run on task `index`, by instance name. */
export function programsOnTask(controller: Controller, index: number): string[] {
  const task = controller.tasks[index]
  if (!task) return []
  return controller.programs.filter((p) => p.task !== undefined && identKey(p.task) === identKey(task.name)).map((p) => p.name)
}

/** Remove task `index`. Null while any program still runs on it: removing it would quietly stop that program. */
export function removeTask(controller: Controller, index: number): Controller | null {
  if (programsOnTask(controller, index).length > 0) return null
  return { ...controller, tasks: controller.tasks.filter((_, i) => i !== index) }
}

/** Rename program instance `index`. A PROGRAM's tags move from `Old.Name` to `New.Name`, and the renames say which;
 *  the instance that runs the code outside every PROGRAM has no tags of its own to move. */
export function renameProgram(source: string, controller: Controller, index: number, name: string): { controller: Controller; renames: TagRename[] } {
  const old = controller.programs[index]
  const to = name.trim()
  if (!old || to === old.name) return { controller, renames: [] }
  return {
    controller: { ...controller, programs: controller.programs.map((p, i) => (i === index ? { ...p, name: to } : p)) },
    renames: old.type !== undefined ? instanceRenames(source, old.type, old.name, to) : [],
  }
}

/**
 * A scheduled program is an instance (the table's name, which the organizer shows and Program Properties renames) of a
 * PROGRAM in the text (what the tag editor and a routine's label go by). Where the instance is the only one that runs
 * its PROGRAM - the usual case - the two are kept the
 * same: this renames the PROGRAM after the instance. Null when there is nothing to do or it cannot be done (another
 * instance runs the same PROGRAM, as IEC allows; the name is taken in the text).
 */
export function alignProgramType(source: string, controller: Controller, index: number): { source: string; controller: Controller } | null {
  const p = controller.programs[index]
  if (!p || p.type === undefined || p.type === p.name) return null
  const type = p.type
  if (controller.programs.filter((q) => q.type !== undefined && identKey(q.type) === identKey(type)).length !== 1) return null
  const at = parseDocument(source).blocks.findIndex((b) => b.kind === 'programPou' && identKey(b.name) === identKey(type))
  // (a change of CASE only is the same name to the text, and is written)
  if (at < 0 || (identKey(type) !== identKey(p.name) && blockNameError(source, at, p.name) !== null)) return null
  const edit = renameBlock(source, at, p.name)
  if (edit.source === source) return null
  return { source: edit.source, controller: { ...controller, programs: controller.programs.map((q, i) => (i === index ? { ...q, type: p.name } : q)) } }
}

/**
 * Run program instance `index` on `task`, and so on that task's controller, or continuously (once per step, after the
 * periodic tasks) with null, on the controller `plc` (none: the default one).
 */
export function setProgramTask(controller: Controller, index: number, task: string | null, plc?: string): Controller {
  return {
    ...controller,
    programs: controller.programs.map((p, i) => {
      if (i !== index) return p
      const { task: _old, plc: _plc, ...rest } = p
      return task !== null ? { ...rest, task } : { ...rest, ...(plc !== undefined && p.type !== undefined ? { plc } : {}) }
    }),
  }
}

/** Run program instance `index`, one on no task, on the controller `plc`, or on the default one with null. An instance on
 *  a task runs on the task's controller (setTaskPlc), so it is left as it is. */
export function setProgramPlc(controller: Controller, index: number, plc: string | null): Controller {
  return {
    ...controller,
    programs: controller.programs.map((p, i) => {
      if (i !== index || p.task !== undefined) return p
      const { plc: _old, ...rest } = p
      return plc === null ? rest : { ...rest, plc }
    }),
  }
}

/** Point program instance `index` at another PROGRAM type, or with null at the code outside every PROGRAM. */
export function setProgramType(controller: Controller, index: number, type: string | null): Controller {
  return {
    ...controller,
    programs: controller.programs.map((p, i) => {
      if (i !== index) return p
      const { name, task, plc } = p
      // the code outside every PROGRAM is the default controller's, so an instance pointed at it leaves its controller
      return { name, ...(type !== null ? { type } : {}), ...(task !== undefined ? { task } : {}), ...(plc !== undefined && type !== null ? { plc } : {}) }
    }),
  }
}

/** Move program instance `index` up or down: the order instances run in when their tasks come due together
 *  at one priority, and the order of the PROGRAM lines an export writes. */
export function moveProgram(controller: Controller, index: number, delta: number): Controller {
  const to = index + delta
  if (to < 0 || to >= controller.programs.length || !controller.programs[index]) return controller
  const programs = [...controller.programs]
  const [moved] = programs.splice(index, 1)
  programs.splice(to, 0, moved!)
  return { ...controller, programs }
}

/** Take program instance `index` out of the controller. Its PROGRAM stays in the code, unrun. */
export function removeProgram(controller: Controller, index: number): Controller {
  return { ...controller, programs: controller.programs.filter((_, i) => i !== index) }
}

/**
 * A PROGRAM type renamed in the code (`source` is the program after the rename): its instances run the new
 * name. An instance that was named after the type, which is how the organizer names one, is
 * renamed along with it and its tags move; an instance with a name of its own keeps it, and its tags.
 */
export function renameProgramType(source: string, controller: Controller, from: string, to: string): { controller: Controller; renames: TagRename[] } {
  if (from === to) return { controller, renames: [] }
  const taken = controller.programs.map((p) => p.name)
  const renames: TagRename[] = []
  const programs = controller.programs.map((p) => {
    if (p.type === undefined || identKey(p.type) !== identKey(from)) return p
    const follows = identKey(p.name) === identKey(from) && !taken.some((n) => n !== p.name && identKey(n) === identKey(to))
    if (follows) renames.push(...instanceRenames(source, to, p.name, to))
    return { ...p, type: to, ...(follows ? { name: to } : {}) }
  })
  return { controller: { ...controller, programs }, renames }
}
