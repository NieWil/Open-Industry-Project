import { describe, expect, it } from 'vitest'
import type { Controller } from '../core/controller'
import { validateController } from '../core/controller'
import { controllerDiagnostics, controllerRuns, runnableSource } from './controller'
import { LocalPlcLink } from './index'

const SOURCE = `PROGRAM Line
VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
Run := NOT Eye;
END_PROGRAM

VAR
  Count : INT;
END_VAR
Count := Count + 1;
`

const TABLE: Controller = {
  tasks: [
    { name: 'Fast', intervalMs: 10, priority: 1 },
    { name: 'Slow', intervalMs: 100, priority: 5, plc: 'Cell2' },
  ],
  programs: [
    { name: 'Main', task: 'Fast' },
    { name: 'LineA', type: 'Line', task: 'Fast' },
    { name: 'LineB', type: 'Line', task: 'Slow' },
  ],
}

describe('a program across controllers', () => {
  it('gives each simulated controller its own tasks and the instances on them, and the default one the rest', () => {
    const runs = controllerRuns(SOURCE, TABLE, 10, { simulated: ['cell2'] })
    expect(runs.map((r) => [r.controller, r.table?.programs.map((p) => p.name), r.table?.tasks.map((t) => t.name)])).toEqual([
      [null, ['Main', 'LineA'], ['Fast']],
      ['cell2', ['LineB'], ['Slow']],
    ])
    // both compile, each with only its own instances, and the code outside every PROGRAM runs on the default one alone
    const main = new LocalPlcLink(runnableSource(runs[0]!.source, runs[0]!.table))
    const cell2 = new LocalPlcLink(runnableSource(runs[1]!.source, runs[1]!.table))
    expect(main.outputs).toContain('LineA.Run')
    expect(main.outputs).not.toContain('LineB.Run')
    expect(cell2.outputs).toContain('LineB.Run')
    expect(Object.keys(cell2.watch).some((k) => k.startsWith('LineA.'))).toBe(false)
  })

  it('runs a task on a controller the simulator does not run nowhere, and one naming the default on it', () => {
    expect(controllerRuns(SOURCE, TABLE, 10, { simulated: [] }).map((r) => r.table?.programs.map((p) => p.name))).toEqual([['Main', 'LineA']])
    const onDefault = { ...TABLE, tasks: TABLE.tasks.map((t) => (t.plc ? { ...t, plc: 'Line1' } : t)) }
    expect(controllerRuns(SOURCE, onDefault, 10, { defaultName: 'line1', simulated: [] })).toEqual([{ controller: null, source: SOURCE, table: onDefault }])
  })

  it('keeps a table with one controller exactly as it ran before', () => {
    const plain = { tasks: TABLE.tasks.slice(0, 1), programs: TABLE.programs.slice(0, 2) }
    expect(controllerRuns(SOURCE, plain, 10, { simulated: ['Cell2'] })).toEqual([{ controller: null, source: SOURCE, table: plain }])
    expect(controllerRuns(SOURCE, null, 20, { simulated: [] })[0]!.table?.tasks[0]?.intervalMs).toBe(20)
  })

  it('reads the controller a task names, and an instance on no task, and refuses the rest', () => {
    expect(validateController(TABLE)).toEqual({ ok: true, controller: TABLE })
    const continuous = { tasks: [], programs: [{ name: 'LineB', type: 'Line', plc: 'Cell2' }] }
    expect(validateController(continuous)).toEqual({ ok: true, controller: continuous })
    expect(controllerRuns(SOURCE, continuous, 10, { simulated: ['Cell2'] }).map((r) => r.controller)).toEqual([null, 'Cell2'])
    // the code outside every PROGRAM is the default controller's; an instance on a task runs on the task's controller
    const bad = validateController({ tasks: [{ name: 'T', intervalMs: 10, priority: 1, plc: '2x' }], programs: [{ name: 'Main', plc: 'Cell2' }, { name: 'X', type: 'Line', task: 'T', plc: 'Cell2' }] })
    expect(!bad.ok && bad.errors).toHaveLength(3)
  })
})

describe('the default table, with its task given to another controller', () => {
  it('is no longer the default table, so the edit is kept as a table and not folded into a scan time', async () => {
    const { defaultController, defaultInterval } = await import('./controller')
    const { setTaskPlc } = await import('./controllerEdits')
    const plain = defaultController(SOURCE, 10)
    expect(defaultInterval(SOURCE, plain)).toBe(10)
    expect(defaultInterval(SOURCE, setTaskPlc(plain, 0, 'Cell2'))).toBeNull()
  })
})

describe('the organizer tree by controller', () => {
  it('groups each controller with its own tasks and instances, the default one first, and lists one that has none', async () => {
    const { taskTree } = await import('./taskTree')
    const tree = taskTree(['Line'], TABLE, true, { defaultName: 'PLC1', named: ['Cell3', 'Cell2'] })
    expect(tree.groups.map((g) => [g.plc, g.tasks.map((t) => t.name), g.tasks.flatMap((t) => t.programs.map((p) => p.name))])).toEqual([
      [null, ['Fast'], ['Main', 'LineA']],
      ['Cell3', [], []],
      ['Cell2', ['Slow'], ['LineB']],
    ])
    expect(taskTree(['Line'], { tasks: TABLE.tasks.slice(0, 1), programs: TABLE.programs.slice(0, 2) }, true).groups).toHaveLength(1)
  })
})

describe("another controller's share of the program", () => {
  it("leaves out the default controller's own variables and statements, keeping every POU where it was", async () => {
    const { withoutControllerTags } = await import('./controller')
    const shared = withoutControllerTags(SOURCE)
    expect(shared.length).toBe(SOURCE.length)
    expect(shared.split('\n').length).toBe(SOURCE.split('\n').length)
    expect(shared.indexOf('PROGRAM Line')).toBe(SOURCE.indexOf('PROGRAM Line'))
    expect(shared).not.toMatch(/Count/)
    const runs = controllerRuns(SOURCE, TABLE, 10, { simulated: ['Cell2'] })
    const cell2 = new LocalPlcLink(runnableSource(runs[1]!.source, runs[1]!.table))
    // its one instance's variables by name, and by bare name too, as a controller with one instance answers
    expect(cell2.outputs).toEqual(['LineB.Run', 'Run'])
  })
})

describe('checking a table across controllers', () => {
  it('checks each controller on its own I/O, so one PROGRAM locating an address may run once on each', () => {
    const located = `PROGRAM Line\nVAR\n  Eye AT %IX100.0 : BOOL;\nEND_VAR\nEND_PROGRAM\n`
    const table = (plc?: string): Controller => ({
      tasks: [
        { name: 'A', intervalMs: 10, priority: 1 },
        { name: 'B', intervalMs: 10, priority: 1, ...(plc ? { plc } : {}) },
      ],
      programs: [
        { name: 'LineA', type: 'Line', task: 'A' },
        { name: 'LineB', type: 'Line', task: 'B' },
      ],
    })
    // on one controller the two instances would be one I/O point, which is refused
    expect(controllerDiagnostics(located, table()).controller.join(' ')).toMatch(/one instance only/)
    expect(controllerDiagnostics(located, table('Cell2'))).toEqual({ source: [], controller: [] })
  })

  // the task that runs the code outside every POU stays on the default controller, whatever it names (plcOfTask)
  it('keeps the task that runs the code outside every POU on the default controller, and says why', () => {
    const moved: Controller = { ...TABLE, tasks: [{ ...TABLE.tasks[0]!, plc: 'Cell2' }, TABLE.tasks[1]!] }
    const runs = controllerRuns(SOURCE, moved, 10, { simulated: ['Cell2'] })
    expect(runs.map((r) => [r.controller, r.table?.programs.map((p) => p.name), r.table?.tasks.map((t) => t.name)])).toEqual([
      [null, ['Main', 'LineA'], ['Fast']],
      ['Cell2', ['LineB'], ['Slow']],
    ])
    expect(() => runnableSource(runs[0]!.source, runs[0]!.table)).not.toThrow()
    const found = controllerDiagnostics(SOURCE, moved, { defaultName: 'PLC1' })
    expect(found.source).toEqual([])
    expect(found.controller.join(' ')).toMatch(/Task Fast names Cell2, but it runs Main.*stays on PLC1/)
  })

  it("checks a task that spells the default controller's own name as the default controller's", () => {
    const spelled: Controller = { ...TABLE, tasks: [TABLE.tasks[0]!, { ...TABLE.tasks[1]!, plc: 'plc1' }] }
    expect(controllerDiagnostics(SOURCE, spelled, { defaultName: 'PLC1' })).toEqual({ source: [], controller: [] })
  })
})
