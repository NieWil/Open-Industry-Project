// Agent tools for several controllers (docs/agent-tools.md): a part's tag names the PLC it goes to, `Cell2::%IX0.0`
// (core/io/controllerTag.ts), and a tag with no name belongs to the default controller. The project lists its
// controllers (SceneJSON.plcs). These list them and move a set of parts' tags onto one, as the Edit menu's Assign to
// Controller does.

import { controllersUsed, isControllerName, partsNaming, spelledAs } from '../../core/io/controllerTag'
import { commitControllerAssignment } from '../program/assignController'
import { addTask, defaultController, plcOfProgram, setProgramTask } from '../../plc'
import { commitControllerEdit } from '../program/controllerCommit'
import { keepAddedAddress, plcsWithAdded, setRunsOnAdding } from '../store/storePlcs'
import { AGENT_LABEL, AgentToolError, assertEditable, findPart, optStr, str, strList, type AgentTool, type AgentToolContext } from './toolKit'

/** Every controller the project lists or its tags name, and whether Play connects it. */
function controllerList(ctx: AgentToolContext): Record<string, unknown> {
  const s = ctx.store.getState()
  const canConnect = ctx.controller?.externalPlcAvailable ?? false
  const listed = s.externalPlc.controllers
  const main = s.externalPlc.mainName
  /** the program instances the task table gives a controller (null: the default one) */
  const instancesOn = (name: string | null): string[] =>
    (s.controller?.programs ?? [])
      .filter((p) => {
        const plc = plcOfProgram(s.controller!, p)
        return name === null ? plc === undefined || plc.toLowerCase() === main.toLowerCase() : plc?.toLowerCase() === name.toLowerCase()
      })
      .map((p) => p.name)
  const names = [...new Set([...listed.map((c) => c.name), ...controllersUsed(s.scene.parts).filter((n) => n.toLowerCase() !== main.toLowerCase())])]
  return {
    main: {
      name: main,
      runsOn: s.externalPlc.enabled ? 'external PLC' : 'simulator',
      ...(s.externalPlc.enabled ? { mode: s.externalPlc.mode } : {}),
      ...(s.externalPlc.enabled && s.externalPlc.watch ? { watchOnly: true } : {}),
      instances: instancesOn(null),
    },
    named: names.map((name) => {
      const c = listed.find((k) => k.name === name)
      const simulated = c?.runsOn === 'app'
      return {
        name,
        listed: c !== undefined,
        ...(c ? { runsOn: simulated ? 'simulator' : 'external PLC' } : {}),
        // a simulated controller runs anywhere; a PLC is connected only from the desktop app
        runsOnPlay: c?.enabled === true && (simulated || canConnect),
        ...(c && !simulated ? { mode: c.mode } : {}),
        ...(c && !simulated && c.watch ? { watchOnly: true } : {}),
        ...(simulated ? { instances: instancesOn(name) } : {}),
        parts: partsNaming(s.scene.parts, name).length,
      }
    }),
    ...(canConnect ? {} : { note: 'this surface cannot connect to a PLC, so no named controller connects on Play' }),
  }
}

export const listControllers: AgentTool = {
  name: 'list_controllers',
  description:
    "The project's controllers. `main` is the default one, which runs every tag that names no controller. `named` are " +
    'the ones a part reaches by writing the name before its tag, `Cell2::%IX0.0`: each with whether the project lists ' +
    'it (a tag naming one it does not list stays unconnected), whether it runs in the simulator or on an external PLC, ' +
    'whether Play runs it, and how many parts have a tag on it. A simulated controller runs the program instances the ' +
    'task table gives it (`instances`), on memory and I/O of its own: its instances read and drive only its own tags. ' +
    "An external PLC's address is the person's to give in Controller Properties. `watchOnly`: Play reads every tag " +
    'from that PLC, sensors included, and writes nothing to it, because it runs real equipment.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (ctx) => controllerList(ctx),
}

export const assignControllerTool: AgentTool = {
  name: 'assign_controller',
  description:
    "Put every PLC tag of the parts `ids` on one controller, rewriting the name before each tag's `::` and leaving the " +
    'rest of the tag as it is. `controller` is the name (a letter or underscore, then letters, digits and underscores); ' +
    'leave it out for the default controller. One undo step. Use it after duplicate_parts to send a copied cell to a second ' +
    'PLC. A name the project does not list is added to it in the same step; the person gives it its address in ' +
    'Controller Properties.',
  inputSchema: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, controller: { type: 'string' } },
    required: ['ids'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    const scene = ctx.store.getState().scene
    const ids = strList(args, 'ids')
    for (const id of ids) findPart(scene, id)
    const typed = optStr(args, 'controller')?.trim() || null
    // a known controller in another case is that controller (IEC names ignore case)
    const setup = ctx.store.getState().externalPlc
    const known = [setup.mainName, ...setup.controllers.map((c) => c.name), ...controllersUsed(scene.parts)]
    const spelled = typed === null ? null : spelledAs(typed, known)
    // the default controller by its name is the default controller, whose tags carry none
    const controller = spelled !== null && spelled === setup.mainName ? null : spelled
    if (controller !== null && !isControllerName(controller)) throw new AgentToolError(`${controller} is not a controller name: a letter or underscore, then letters, digits and underscores, at most 32`)
    // as the Edit menu's Assign to Controller does, a name the project does not list is added in the same step
    const result = commitControllerAssignment(ctx.store, ids, controller, `${AGENT_LABEL}: assign ${ids.length === 1 ? 'a part' : `${ids.length} parts`} to ${controller ?? 'the default controller'}`)
    return { controller: controller ?? 'main', changedTags: result.tags, changedParts: result.parts, controllers: controllerList(ctx) }
  },
}

export const setControllerTool: AgentTool = {
  name: 'set_controller',
  description:
    'Run a controller in the simulator or on an external PLC, as Controller Properties does: `runsOn` "simulator" or ' +
    '"plc". `name` is the controller (leave it out for the default one); one the project does not list is added. Run ' +
    'a cell on its own simulated controller to build and test a line of several PLCs before any is real, then hand ' +
    'it to its PLC later without touching a tag. One undo step.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, runsOn: { type: 'string', enum: ['simulator', 'plc'] } },
    required: ['runsOn'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    const runsOn = str(args, 'runsOn') === 'simulator' ? 'app' : 'plc'
    const typed = optStr(args, 'name')?.trim() || null
    const setup = ctx.store.getState().externalPlc
    const name = typed === null ? null : spelledAs(typed, [setup.mainName, ...setup.controllers.map((c) => c.name)])
    const target = name === null || name.toLowerCase() === setup.mainName.toLowerCase() ? null : name
    if (target !== null && !isControllerName(target)) throw new AgentToolError(`${target} is not a controller name: a letter or underscore, then letters, digits and underscores, at most 32`)
    // one undo step, the controller added first when the project does not list it
    const why = setRunsOnAdding(ctx.store, target, runsOn, `${AGENT_LABEL}: run ${target ?? setup.mainName} ${runsOn === 'app' ? 'in the simulator' : 'on a PLC'}`)
    if (why === 'locked') throw new AgentToolError('the project cannot be edited now (a part is open for editing in the Catalog, or the document is read-only)')
    if (why === 'full') throw new AgentToolError(`${target} cannot be added: the project holds at most 31 other controllers`)
    if (why !== null) throw new AgentToolError(`${target} cannot be added (${why})`)
    return { controllers: controllerList(ctx) }
  },
}

export const runInstanceOnTool: AgentTool = {
  name: 'run_instance_on',
  description:
    "Give a program instance (get_program's `programs`) to a controller: `controller` is its name, left out for the " +
    "default one. Each controller runs its own tasks, so the instance moves to one of that controller's tasks: `task` " +
    "when given, else its first, else a new one at the interval of the instance's task now. An instance on no task " +
    "stays on no task. It then runs on that controller, on memory of its own, and its tags are that controller's: a " +
    "part reaches them as `Cell2::LineB.Run` (or `Cell2::Run` when it is that controller's only instance). The " +
    'instance that runs the code outside every PROGRAM stays on the default controller. One undo step.',
  inputSchema: {
    type: 'object',
    properties: { instance: { type: 'string' }, controller: { type: 'string' }, task: { type: 'string' } },
    required: ['instance'],
    additionalProperties: false,
  },
  run: (ctx, args) => {
    assertEditable(ctx.store)
    const s = ctx.store.getState()
    let table = s.controller ?? defaultController(s.stProgram, s.stScanMs)
    const instance = str(args, 'instance')
    const index = table.programs.findIndex((p) => p.name.toUpperCase() === instance.toUpperCase())
    if (index < 0) throw new AgentToolError(`no program instance '${instance}' (they are: ${table.programs.map((p) => p.name).join(', ') || 'none'})`)
    const own = table.programs[index]!
    if (own.type === undefined) throw new AgentToolError(`${own.name} runs the code outside every PROGRAM, which only the default controller runs`)
    const typed = optStr(args, 'controller')?.trim() || null
    const known = [s.externalPlc.mainName, ...s.externalPlc.controllers.map((c) => c.name)]
    const spelled = typed === null ? null : spelledAs(typed, known)
    const plc = spelled === null || spelled.toLowerCase() === s.externalPlc.mainName.toLowerCase() ? null : spelled
    if (plc !== null && !isControllerName(plc)) throw new AgentToolError(`${plc} is not a controller name`)
    const onPlc = (t: { plc?: string }): boolean => (plc === null ? t.plc === undefined || t.plc.toLowerCase() === s.externalPlc.mainName.toLowerCase() : t.plc?.toLowerCase() === plc.toLowerCase())
    if (own.task === undefined && optStr(args, 'task') === undefined) table = setProgramTask(table, index, null, plc ?? undefined)
    else {
      const asked = optStr(args, 'task')
      let task = asked !== undefined ? table.tasks.find((t) => t.name.toUpperCase() === asked.toUpperCase()) : table.tasks.find(onPlc)
      if (asked !== undefined && (!task || !onPlc(task))) throw new AgentToolError(`no task '${asked}' on ${plc ?? s.externalPlc.mainName} (its tasks are: ${table.tasks.filter(onPlc).map((t) => t.name).join(', ') || 'none'})`)
      if (!task) {
        // a controller with no task yet gets one, timed as the instance's task is now
        const now = table.tasks.find((t) => own.task !== undefined && t.name.toUpperCase() === own.task.toUpperCase())
        table = addTask(table, plc ?? undefined)
        const at = table.tasks.length - 1
        if (now) table = { ...table, tasks: table.tasks.map((t, i) => (i === at ? { ...t, intervalMs: now.intervalMs, priority: now.priority } : t)) }
        task = table.tasks[at]!
      }
      table = setProgramTask(table, index, task.name)
    }
    const label = `${AGENT_LABEL}: run ${own.name} on ${plc ?? s.externalPlc.mainName}`
    // as assign_controller and set_controller do, a controller the project does not list is added in the same step
    if (plc !== null && !s.externalPlc.controllers.some((c) => c.name.toLowerCase() === plc.toLowerCase())) {
      const plcs = plcsWithAdded(ctx.store, plc)
      if (!plcs) throw new AgentToolError(`${plc} cannot be added: the project holds at most 31 other controllers`)
      ctx.store.commitProgram(label, { controller: table }, { scene: { ...ctx.store.getState().scene, plcs } })
      keepAddedAddress(ctx.store, plc)
    } else commitControllerEdit(ctx.store, table, [], label)
    return { controllers: controllerList(ctx) }
  },
}
