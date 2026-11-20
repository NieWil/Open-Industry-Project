// A scene's controller: the tasks its PLC program runs on, and which program runs in which task.
//
// Why this is data and not text: IEC spells this layer as a CONFIGURATION inside the source, and the
// engine reads that spelling (src/plc). But tools that edit a controller hold its tasks and program
// assignments as objects (a task tree, a list of organization blocks, a task configuration), and so
// does this one. An organizer that adds a task, retimes it or moves a program into it edits this table,
// never a span of text. The PROGRAM POUs stay in the scene's one ST document; the table sits beside it,
// as the scan time does, and travels with it through every format (project, folder, scene file, collab room).
//
// The model is IEC 61131-3's software model: tasks with a period and a priority, running instances of program
// types. The IEC front end turns a table into a CONFIGURATION (plc/controller.ts).
//
// This checks structure only: identifiers, whole positive periods, priorities, so a
// document carrying a malformed table is refused with the reason. Whether the tasks and program
// types a table names exist is the ST checker's business: the program types live in source that is
// often mid-edit, and a table naming one still being typed has to load.

import { isControllerName } from './io/controllerTag'

/** A periodic task. */
export interface ControllerTask {
  /** an identifier, unique among the tasks (case-insensitive, like every IEC name) */
  name: string
  /** how often the task runs, in whole milliseconds of simulated time */
  intervalMs: number
  /** IEC's convention: 0 is the highest; tasks due together run in this order */
  priority: number
  /**
   * The controller that runs it, and the program instances on it (SceneJSON.plcs, core/scene/scenePlcs.ts); absent
   * means the default one. Each controller the simulator runs compiles the same program with only its own tasks and
   * instances, so it runs them on memory and I/O of its own, and its I/O is the parts' tags that name it
   * (`Cell2::%IX0.0`). IEC calls a controller a resource, and a resource owns its tasks.
   */
  plc?: string
}

/** One running instance of a PROGRAM type, or the one that runs the code outside every PROGRAM. */
export interface ControllerProgram {
  /** the instance name; a PROGRAM's variables are addressed `name.Variable` on scene tags and in the watch table */
  name: string
  /**
   * the PROGRAM POU it runs, declared in the scene's ST program. Absent for the instance that runs the code
   * outside every PROGRAM: that code's variables are the controller's own tags, and keep their bare names
   * whichever task runs it, which is why a program that gains a PROGRAM beside it renames nothing.
   */
  type?: string
  /** the task that runs it; absent means it runs continuously, once per physics step after the periodic tasks */
  task?: string
  /**
   * The controller that runs an instance on no task (ControllerTask.plc); absent means the default one. An instance on
   * a task runs on that task's controller, so it names none. The instance that runs the code outside every PROGRAM is
   * the default controller's.
   */
  plc?: string
}

export interface Controller {
  tasks: ControllerTask[]
  /** in the order they run when their tasks come due together at one priority */
  programs: ControllerProgram[]
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const IDENT_RULE = 'an identifier (letters, digits and _, not starting with a digit)'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isWhole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min

/**
 * Structural validation of an untrusted controller table. Returns a fresh copy holding only the known
 * fields, in a fixed key order, so two equal tables serialize identically. `at` prefixes each error
 * with where the table sits in its document.
 */
export function validateController(raw: unknown, at = 'controller'): { ok: true; controller: Controller } | { ok: false; errors: string[] } {
  if (!isObject(raw)) return { ok: false, errors: [`${at} must be an object with "tasks" and "programs"`] }
  const errors: string[] = []
  if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) errors.push(`${at}.tasks must be an array`)
  if (!Array.isArray(raw.programs)) errors.push(`${at}.programs must be an array`)

  const tasks: ControllerTask[] = []
  ;(Array.isArray(raw.tasks) ? raw.tasks : []).forEach((t: unknown, i: number) => {
    const w = `${at}.tasks[${i}]`
    if (!isObject(t)) {
      errors.push(`${w} must be an object`)
      return
    }
    const before = errors.length
    if (typeof t.name !== 'string' || !IDENT.test(t.name)) errors.push(`${w}.name must be ${IDENT_RULE}`)
    if (!isWhole(t.intervalMs, 1)) errors.push(`${w}.intervalMs must be a whole number of milliseconds, 1 or more`)
    if (!isWhole(t.priority, 0)) errors.push(`${w}.priority must be a whole number, 0 or more (0 is the highest)`)
    if (t.plc !== undefined && (typeof t.plc !== 'string' || !isControllerName(t.plc))) errors.push(`${w}.plc must name a controller, or be left out for the default one`)
    if (errors.length === before) tasks.push({ name: t.name as string, intervalMs: t.intervalMs as number, priority: t.priority as number, ...(t.plc !== undefined ? { plc: t.plc as string } : {}) })
  })

  const programs: ControllerProgram[] = []
  ;(Array.isArray(raw.programs) ? raw.programs : []).forEach((p: unknown, i: number) => {
    const w = `${at}.programs[${i}]`
    if (!isObject(p)) {
      errors.push(`${w} must be an object`)
      return
    }
    const before = errors.length
    if (typeof p.name !== 'string' || !IDENT.test(p.name)) errors.push(`${w}.name must be ${IDENT_RULE}`)
    if (p.type !== undefined && (typeof p.type !== 'string' || !IDENT.test(p.type))) {
      errors.push(`${w}.type must name a PROGRAM (${IDENT_RULE}), or be left out for the program that runs the code outside every PROGRAM`)
    }
    if (p.task !== undefined && (typeof p.task !== 'string' || !IDENT.test(p.task))) {
      errors.push(`${w}.task must name a task (${IDENT_RULE}), or be left out for a program that runs continuously`)
    }
    if (p.plc !== undefined && (typeof p.plc !== 'string' || !isControllerName(p.plc))) {
      errors.push(`${w}.plc must name a controller (a letter or underscore, then letters, digits and underscores), or be left out for the default one`)
    } else if (p.plc !== undefined && p.type === undefined) {
      errors.push(`${w} runs the code outside every PROGRAM, which only the default controller runs, so it names no controller`)
    } else if (p.plc !== undefined && p.task !== undefined) {
      errors.push(`${w} runs on task ${String(p.task)}, so it runs on that task's controller and names none of its own`)
    }
    if (errors.length === before) {
      programs.push({
        name: p.name as string,
        ...(p.type !== undefined ? { type: p.type as string } : {}),
        ...(p.task !== undefined ? { task: p.task as string } : {}),
        ...(p.plc !== undefined ? { plc: p.plc as string } : {}),
      })
    }
  })

  return errors.length > 0 ? { ok: false, errors } : { ok: true, controller: { tasks, programs } }
}

/** Do two tables describe the same controller? (Both are compared in validateController's key order.) */
export function sameController(a: Controller | null | undefined, b: Controller | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
