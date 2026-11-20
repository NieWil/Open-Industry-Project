// The controller table read as a tree: the tasks, the program instances each one runs, and what runs on no task. It is
// what the PLC panel's organizer draws: IEC's configuration model (tasks, and the program instances bound to each)
// as a tree.
//
// Nothing here is a new model. A scene already has a controller table (core/controller.ts): tasks with an interval and
// a priority, and program instances bound to a task, each running a PROGRAM POU of the code or, with no type, the code
// outside every PROGRAM. This is that table regrouped, so the tree and the table cannot disagree, and every edit the
// tree makes is one of controllerEdits.ts's.
//
// It takes the PROGRAM types rather than the source, so a caller that already has the block split (the PLC panel, which
// re-derives it per keystroke without parsing) builds the tree without another parse.

import type { Controller } from '../core/controller'
import { identKey } from './program'
import { plcOfTask } from './controller'

export interface TaskTreeProgram {
  /** its row in `controller.programs`, which is what every edit takes */
  index: number
  /** the instance name: a PROGRAM's tags are addressed `name.Tag` */
  name: string
  /** the PROGRAM POU it runs; null for the one that runs the code outside every PROGRAM */
  type: string | null
  /** false when the table names a PROGRAM the code no longer has */
  exists: boolean
}

export interface TaskTreeTask {
  /** its row in `controller.tasks` */
  index: number
  name: string
  intervalMs: number
  priority: number
  programs: TaskTreeProgram[]
}

/** One controller's share of the tree: the tasks it owns, and the instances on no task it runs. */
export interface TaskTreeGroup {
  /** the controller's name; null for the default one */
  plc: string | null
  tasks: TaskTreeTask[]
  continuous: TaskTreeProgram[]
}

export interface TaskTree {
  tasks: TaskTreeTask[]
  /**
   * The tasks and the instances on no task by controller (ControllerTask.plc), the default one first, then each
   * controller in `plcs` order and any other a task names. One group when every task is the default controller's.
   */
  groups: TaskTreeGroup[]
  /** instances bound to no task: they run once every physics step, after the periodic tasks */
  continuous: TaskTreeProgram[]
  /** instances bound to a task the table does not have. The compile refuses that (it is in Problems), so they are
   *  listed apart rather than under a task, or as if they ran every step */
  lost: TaskTreeProgram[]
  /** PROGRAM POUs in the code that no instance runs */
  unscheduled: string[]
  /** the code outside every PROGRAM has statements and no instance runs them (the compile refuses that too) */
  topLevelUnrun: boolean
}

/**
 * The table as a tree. `types` are the PROGRAM POUs the code declares (plc/controller.ts `programTypes`, or the PLC
 * panel's own block split), and `topLevelStatements` whether the code outside every PROGRAM has statements
 * (`topLevelStatements`): without any, that code is only the controller's tags, which nothing needs to run.
 */
export function taskTree(types: readonly string[], controller: Controller, topLevelStatements: boolean, plcs?: { defaultName: string; named: readonly string[] }): TaskTree {
  const has = new Set(types.map(identKey))
  const rows: TaskTreeProgram[] = controller.programs.map((p, index) => ({
    index,
    name: p.name,
    type: p.type ?? null,
    exists: p.type === undefined || has.has(identKey(p.type)),
  }))
  const taskOf = (r: TaskTreeProgram): string | undefined => controller.programs[r.index]!.task
  const known = new Set(controller.tasks.map((t) => identKey(t.name)))
  const running = new Set(controller.programs.flatMap((p) => (p.type === undefined ? [] : [identKey(p.type)])))
  const tasks = controller.tasks.map((t, index) => ({
    index,
    name: t.name,
    intervalMs: t.intervalMs,
    priority: t.priority,
    programs: rows.filter((r) => identKey(taskOf(r) ?? '') === identKey(t.name)),
  }))
  const continuous = rows.filter((r) => taskOf(r) === undefined)
  // a controller named the default one's is the default one
  const keyOf = (plc: string | undefined): string | null => (plc === undefined || (plcs && identKey(plc) === identKey(plcs.defaultName)) ? null : plc)
  const names: string[] = []
  for (const n of [...(plcs?.named ?? []), ...controller.tasks.map((t) => plcOfTask(controller, t)), ...controller.programs.map((p) => p.plc)]) {
    const k = keyOf(n)
    if (k !== null && !names.some((m) => identKey(m) === identKey(k))) names.push(k)
  }
  const inGroup = (plc: string | null) => (n: string | undefined): boolean => {
    const k = keyOf(n)
    return plc === null ? k === null : k !== null && identKey(k) === identKey(plc)
  }
  const groups: TaskTreeGroup[] = [null, ...names].map((plc) => ({
    plc,
    tasks: tasks.filter((t) => inGroup(plc)(plcOfTask(controller, controller.tasks[t.index]!))),
    continuous: continuous.filter((r) => inGroup(plc)(controller.programs[r.index]!.plc)),
  }))
  return {
    tasks,
    groups,
    continuous,
    lost: rows.filter((r) => {
      const task = taskOf(r)
      return task !== undefined && !known.has(identKey(task))
    }),
    unscheduled: types.filter((t) => !running.has(identKey(t))),
    topLevelUnrun: topLevelStatements && !controller.programs.some((p) => p.type === undefined),
  }
}
