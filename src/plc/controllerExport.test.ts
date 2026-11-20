import { describe, expect, it } from 'vitest'
import type { Controller } from '../core/controller'
import { controllerExport, exportableControllers, NothingToExportError, tableControllers } from './controllerExport'
import { runnableSource } from './controller'
import { exportProgram } from './exchange/export'

const SOURCE = `TYPE
  Mode : (Idle, Running);
END_TYPE

VAR_GLOBAL
  Shared : INT;
END_VAR

FUNCTION Clamp : INT
VAR_INPUT
  x : INT;
END_VAR
Clamp := MIN(x, 10);
END_FUNCTION

FUNCTION_BLOCK Debounce
VAR_INPUT
  x : BOOL;
END_VAR
VAR_OUTPUT
  q : BOOL;
END_VAR
q := x;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Counter
VAR
  n : INT;
END_VAR
n := Clamp(n + 1);
END_FUNCTION_BLOCK

PROGRAM Line
VAR_INPUT
  Eye : BOOL;
END_VAR
VAR_OUTPUT
  Run : BOOL;
END_VAR
VAR
  d : Debounce;
END_VAR
d(x := Eye);
Run := NOT d.q;
END_PROGRAM

PROGRAM Tally
VAR
  c : Counter;
END_VAR
c();
END_PROGRAM

VAR_INPUT
  Start : BOOL;
END_VAR
VAR_OUTPUT
  Lamp : BOOL;
END_VAR
Lamp := Start;
`

const TABLE: Controller = {
  tasks: [
    { name: 'MainTask', intervalMs: 10, priority: 10 },
    { name: 'Cell2Task', intervalMs: 20, priority: 5, plc: 'Cell2' },
  ],
  programs: [
    { name: 'Main', task: 'MainTask' },
    { name: 'LineA', type: 'Line', task: 'MainTask' },
    { name: 'TallyB', type: 'Tally', task: 'Cell2Task' },
  ],
}

describe('one controller as the file for its PLC', () => {
  it('names the controllers a table gives tasks to, besides the default one', () => {
    expect(tableControllers(TABLE, 'PLC1')).toEqual(['Cell2'])
    expect(tableControllers({ ...TABLE, tasks: [...TABLE.tasks, { name: 'T', intervalMs: 10, priority: 1, plc: 'plc1' }] }, 'PLC1')).toEqual(['Cell2'])
    expect(tableControllers(null)).toEqual([])
  })

  it("keeps the default controller's tasks, its own code and the POUs its instances reach", () => {
    const own = controllerExport(SOURCE, TABLE, 10, null, 'PLC1')
    expect(own.table?.tasks.map((t) => t.name)).toEqual(['MainTask'])
    expect(own.table?.programs.map((p) => p.name)).toEqual(['Main', 'LineA'])
    expect(own.source).toContain('PROGRAM Line')
    expect(own.source).toContain('FUNCTION_BLOCK Debounce')
    expect(own.source).toContain('Lamp := Start;')
    expect(own.source).not.toContain('PROGRAM Tally')
    expect(own.source).not.toContain('FUNCTION_BLOCK Counter')
    expect(own.dropped).toEqual(['Clamp', 'Counter', 'Tally'])
  })

  it("keeps another controller's instances and what they call, through a chain, and none of the default's own code", () => {
    const own = controllerExport(SOURCE, TABLE, 10, 'cell2', 'PLC1')
    expect(own.table).toEqual({ tasks: [{ name: 'Cell2Task', intervalMs: 20, priority: 5 }], programs: [{ name: 'TallyB', type: 'Tally', task: 'Cell2Task' }] })
    // Tally -> Counter -> Clamp
    expect(own.source).toContain('PROGRAM Tally')
    expect(own.source).toContain('FUNCTION_BLOCK Counter')
    expect(own.source).toContain('FUNCTION Clamp')
    expect(own.source).not.toContain('PROGRAM Line')
    expect(own.source).not.toContain('Lamp := Start;')
    expect(own.dropped).toEqual(['Debounce', 'Line'])
  })

  it('keeps the types and globals in every file', () => {
    for (const plc of [null, 'Cell2']) {
      const own = controllerExport(SOURCE, TABLE, 10, plc, 'PLC1')
      expect(own.source).toContain('Mode : (Idle, Running);')
      expect(own.source).toContain('Shared : INT;')
    }
  })

  it('refuses a controller that runs nothing, as nothing to export rather than as a compile error', () => {
    expect(() => controllerExport(SOURCE, TABLE, 10, 'Cell9', 'PLC1')).toThrow(NothingToExportError)
    // every instance moved off the default controller: its file would hold no program
    const moved: Controller = { tasks: TABLE.tasks, programs: [{ name: 'TallyB', type: 'Tally', task: 'Cell2Task' }] }
    expect(() => controllerExport(SOURCE, moved, 10, null, 'PLC1')).toThrow(NothingToExportError)
  })

  it('counts as exportable only the controllers with an instance, not one with an empty task', () => {
    const withEmpty: Controller = { ...TABLE, tasks: [...TABLE.tasks, { name: 'PackerTask', intervalMs: 20, priority: 10, plc: 'Packer' }] }
    expect(tableControllers(withEmpty, 'PLC1')).toEqual(['Cell2', 'Packer'])
    expect(exportableControllers(withEmpty, 'PLC1')).toEqual(['Cell2'])
  })

  it('exports each as a program that compiles, with its own CONFIGURATION', () => {
    for (const plc of [null, 'Cell2']) {
      const own = controllerExport(SOURCE, TABLE, 10, plc, 'PLC1')
      const file = exportProgram(runnableSource(own.source, own.table), 'iec-text', { projectName: 'demo' })
      expect(file.content).toContain('CONFIGURATION')
      expect(file.content).toContain(plc === null ? 'PROGRAM LineA WITH MainTask : Line' : 'PROGRAM TallyB WITH Cell2Task : Tally')
      expect(file.content).not.toContain(plc === null ? 'Cell2Task' : 'MainTask')
      const xml = exportProgram(runnableSource(own.source, own.table), 'plcopen-xml', { projectName: 'demo' }).content
      expect(xml).toContain(plc === null ? 'name="MainTask"' : 'name="Cell2Task"')
      expect(xml).not.toContain(plc === null ? 'Cell2Task' : 'MainTask')
      expect(xml.includes('<pou name="Tally"')).toBe(plc !== null)
    }
  })
})
