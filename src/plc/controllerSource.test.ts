// A scene's controller table as the engine runs it (plc/controller.ts): appended to the program as the
// CONFIGURATION it stands for, with the program's problems and the table's reported apart, and a file
// that declares its own CONFIGURATION split back into program and table on the way in.

import { describe, expect, it } from 'vitest'
import type { Controller } from '../core/controller'
import { parseAndCheck } from './checker'
import {
  configurationText,
  ControllerError,
  controllerDiagnostics,
  controllerFor,
  controllerSource,
  declaresConfiguration,
  defaultController,
  defaultInterval,
  extractController,
  runnableSource,
} from './controller'
import { exportProgram, toPlcopenXml } from './exchange/export'
import { compile } from './interpreter'
import { StError } from './types'

const PROGRAMS = `PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM
`

const TABLE: Controller = {
  tasks: [
    { name: 'Fast', intervalMs: 10, priority: 1 },
    { name: 'Slow', intervalMs: 30, priority: 2 },
  ],
  programs: [
    { name: 'FastCount', type: 'Counter', task: 'Fast' },
    { name: 'SlowCount', type: 'Counter', task: 'Slow' },
  ],
}

/** what `fn` threw */
function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('a controller table runs as the CONFIGURATION it stands for', () => {
  it('writes one resource, the tasks, then the instances in table order', () => {
    const table: Controller = {
      tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }],
      programs: [{ name: 'A', type: 'P', task: 'Fast' }, { name: 'B', type: 'P' }, { name: 'Main', task: 'Fast' }],
    }
    expect(configurationText(table)).toBe(
      'CONFIGURATION Config0\n  RESOURCE Res0 ON PLC\n    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);\n    PROGRAM A WITH Fast : P;\n    PROGRAM B : P;\n    PROGRAM Main WITH Fast;\n  END_RESOURCE\nEND_CONFIGURATION',
    )
  })

  it('compiles into the tasks the table declares', () => {
    expect(compile(runnableSource(PROGRAMS, TABLE)).tasks.map((t) => [t.name, t.periodSec, t.programs])).toEqual([
      ['Fast', 0.01, ['FastCount']],
      ['Slow', 0.03, ['SlowCount']],
    ])
  })

  it('leaves a program with no table exactly as written', () => {
    const implicit = 'VAR n : INT; END_VAR\nn := n + 1;'
    expect(controllerSource(implicit, null)).toBe(implicit)
    expect(runnableSource(implicit, undefined)).toBe(implicit)
  })

  it('keeps the program a prefix of what runs, so a position in one is a position in the other', () => {
    expect(controllerSource(PROGRAMS, TABLE).startsWith(PROGRAMS.trimEnd())).toBe(true)
  })
})

describe("a program's problems and its table's are reported apart", () => {
  it('reports a type error in the program at its place in the program', () => {
    const src = PROGRAMS.replace('n := n + 1;', 'n := TRUE;')
    const found = controllerDiagnostics(src, TABLE)
    expect(found.controller).toEqual([])
    expect(found.source).toHaveLength(1)
    expect(src.slice(found.source[0]!.pos.offset)).toMatch(/^TRUE|^n := TRUE/)
  })

  it('reports a missing END_PROGRAM in the program, not inside the CONFIGURATION it would run into', () => {
    const src = PROGRAMS.replace('END_PROGRAM', '')
    const found = controllerDiagnostics(src, TABLE)
    expect(found.source.map((d) => d.message)).toEqual([expect.stringMatching(/expected END_PROGRAM/)])
    expect(found.source[0]!.pos.offset).toBeLessThanOrEqual(src.length)
    expect(found.controller).toEqual([])
  })

  it("reports what the table names but the program does not declare as the table's own problems", () => {
    const found = controllerDiagnostics(PROGRAMS, {
      tasks: TABLE.tasks,
      programs: [
        { name: 'X', type: 'Merge', task: 'Fast' },
        { name: 'Y', type: 'Counter', task: 'Nope' },
      ],
    })
    expect(found.source).toEqual([])
    expect(found.controller).toEqual(expect.arrayContaining([expect.stringMatching(/unknown PROGRAM 'Merge'/), expect.stringMatching(/unknown TASK 'Nope'/)]))
  })

  it('does not flag a table-run program for declaring no CONFIGURATION of its own', () => {
    const two = `${PROGRAMS}\nPROGRAM Idle\nVAR k : INT; END_VAR\nk := 0;\nEND_PROGRAM\n`
    const table: Controller = { tasks: TABLE.tasks, programs: [...TABLE.programs, { name: 'Idler', type: 'Idle', task: 'Slow' }] }
    expect(controllerDiagnostics(two, table)).toEqual({ source: [], controller: [] })
    // without the table the same file is a problem: nothing says which task runs each program
    expect(controllerDiagnostics(two, null).source.map((d) => d.message)).toEqual([expect.stringMatching(/2 PROGRAMs are declared/)])
  })

  it('refuses a program that declares a CONFIGURATION when the scene already has a table', () => {
    const own = `${PROGRAMS}\nCONFIGURATION C\n  TASK T(INTERVAL := T#10ms, PRIORITY := 0);\n  PROGRAM I WITH T : Counter;\nEND_CONFIGURATION\n`
    const found = controllerDiagnostics(own, TABLE)
    expect(found.source.map((d) => d.message)).toEqual([expect.stringMatching(/cannot declare a CONFIGURATION of its own/)])
    expect(own.slice(found.source[0]!.pos.offset)).toMatch(/^CONFIGURATION C/)
    expect(() => runnableSource(own, TABLE)).toThrow(/cannot declare a CONFIGURATION of its own/)
  })

  it("throws a table's problem as a ControllerError, at the end of the program rather than past it", () => {
    const e = thrown(() => runnableSource(PROGRAMS, { tasks: [], programs: [{ name: 'A', type: 'Missing' }] }))
    expect(e).toBeInstanceOf(ControllerError)
    expect((e as ControllerError).message).toMatch(/unknown PROGRAM 'Missing'/)
    expect((e as ControllerError).pos.offset).toBe(PROGRAMS.trimEnd().length)
  })

  it("throws a program's problem as a plain StError, where it is", () => {
    const e = thrown(() => runnableSource(PROGRAMS.replace('n := n + 1;', 'n := TRUE;'), TABLE))
    expect(e).toBeInstanceOf(StError)
    expect(e).not.toBeInstanceOf(ControllerError)
  })
})

describe('a program with no table of its own runs from the default one', () => {
  const BODY = 'VAR_INPUT Start : BOOL; END_VAR\nVAR_OUTPUT Motor : BOOL; END_VAR\nMotor := Start;'

  it('is not composed while it is only top-level code, which runs exactly as the default table would', () => {
    expect(controllerFor(BODY, null, 50)).toBeNull()
  })

  it('runs the default table once it declares a PROGRAM: all of the program, on one task', () => {
    const src = `PROGRAM Idle\nVAR k : INT; END_VAR\nk := 1;\nEND_PROGRAM\n\n${BODY}`
    const table = controllerFor(src, null, 50)
    expect(table).toEqual({
      tasks: [{ name: 'MainTask', intervalMs: 50, priority: 10 }],
      programs: [
        { name: 'Main', task: 'MainTask' },
        { name: 'Idle', type: 'Idle', task: 'MainTask' },
      ],
    })
    expect(controllerDiagnostics(src, table)).toEqual({ source: [], controller: [] })
    const p = compile(runnableSource(src, table))
    expect(p.inputs).toEqual(['Start']) // the top-level code's tags keep their names beside a PROGRAM
    expect(p.tasks.map((t) => t.programs)).toEqual([['Main', 'Idle']])
  })

  it('runs a lone PROGRAM under its own name, and no top-level row when there are no top-level statements', () => {
    const lone = 'PROGRAM Sorter\nVAR_OUTPUT Divert : BOOL; END_VAR\nDivert := TRUE;\nEND_PROGRAM\n'
    const table = controllerFor(lone, null, 20)!
    expect(table.programs).toEqual([{ name: 'Sorter', type: 'Sorter', task: 'MainTask' }])
    const p = compile(runnableSource(lone, table))
    p.scan(0.02)
    expect(p.get('Sorter.Divert')).toBe(true)
  })

  it('prefers the table the scene keeps, and runs a file with its own CONFIGURATION as written', () => {
    expect(controllerFor(BODY, TABLE, 50)).toBe(TABLE)
    const own = `${PROGRAMS}\nCONFIGURATION C\n  TASK T(INTERVAL := T#10ms, PRIORITY := 0);\n  PROGRAM I WITH T : Counter;\nEND_CONFIGURATION\n`
    expect(controllerFor(own, null, 50)).toBeNull()
    expect(declaresConfiguration(own)).toBe(true)
    expect(declaresConfiguration(BODY)).toBe(false)
    // a statement about a variable called `configuration` does not declare one
    expect(declaresConfiguration('VAR configuration : BOOL; x : BOOL; END_VAR\nIF configuration THEN x := TRUE; END_IF;')).toBe(false)
  })

  it('names its instance past a name the program already spells', () => {
    expect(defaultController('VAR Main : BOOL; END_VAR\nMain := TRUE;', 100).programs[0]!.name).toBe('Main1')
  })

  it('knows a retimed default table for the scan time it is, and anything more for a table', () => {
    const d = defaultController(BODY, 50)
    expect(defaultInterval(BODY, { ...d, tasks: [{ ...d.tasks[0]!, intervalMs: 20 }] })).toBe(20)
    expect(defaultInterval(BODY, { ...d, tasks: [{ ...d.tasks[0]!, priority: 1 }] })).toBeNull()
    expect(defaultInterval(BODY, { ...d, programs: [{ name: 'Main' }] })).toBeNull() // moved to every step
    expect(defaultInterval(BODY, { tasks: d.tasks, programs: [...d.programs, { name: 'P', type: 'P', task: 'MainTask' }] })).toBeNull()
  })
})

describe('code outside every POU beside a CONFIGURATION', () => {
  const SRC = `PROGRAM Watch
VAR_EXTERNAL count : INT; END_VAR
VAR_OUTPUT seen : INT; END_VAR
seen := count;
END_PROGRAM

VAR_OUTPUT count : INT; END_VAR
count := count + 1;`
  const table: Controller = {
    tasks: [{ name: 'Fast', intervalMs: 10, priority: 0 }],
    programs: [
      { name: 'Main', task: 'Fast' },
      { name: 'Watcher', type: 'Watch', task: 'Fast' },
    ],
  }

  it("is the controller's: its variables are tags under their bare names, and every PROGRAM reaches them", () => {
    const p = compile(runnableSource(SRC, table))
    expect(p.outputs).toEqual(['count', 'Watcher.seen'])
    p.scan(0.01)
    p.scan(0.01)
    expect(p.get('count')).toBe(2)
    expect(p.get('Watcher.seen')).toBe(2)
  })

  it('refuses statements that no instance runs, where they are', () => {
    const found = controllerDiagnostics(SRC, { ...table, programs: [table.programs[1]!] })
    const unrun = found.source.find((d) => /no PROGRAM instance runs that code/.test(d.message))
    expect(unrun).toBeDefined()
    expect(SRC.slice(unrun!.pos.offset)).toMatch(/^count := count \+ 1/)
  })

  it('refuses a second instance running it, and a tag named like a global', () => {
    expect(controllerDiagnostics(SRC, { ...table, programs: [...table.programs, { name: 'Again', task: 'Fast' }] }).controller).toEqual([
      expect.stringMatching(/'Main' already runs it/),
    ])
    const clash = `VAR_GLOBAL count : INT; END_VAR\n${SRC}`
    expect(controllerDiagnostics(clash, table).source.map((d) => d.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/top-level variable, and VAR_GLOBAL 'count' already has that name/)]),
    )
  })

  it('exports as IEC: a PROGRAM of its own, its tags VAR_GLOBALs once another POU names one', () => {
    const text = exportProgram(runnableSource(SRC, table), 'iec-text').content
    expect(text).toContain('PROGRAM MainProgram\nVAR_EXTERNAL\n  count : INT;\nEND_VAR\ncount := count + 1;\nEND_PROGRAM')
    expect(text).toMatch(/CONFIGURATION Config0\n {2}VAR_GLOBAL count : INT; END_VAR/)
    expect(text).toContain('PROGRAM Main WITH Fast : MainProgram;')
    expect(() => parseAndCheck(text)).not.toThrow()
    const xml = toPlcopenXml(runnableSource(SRC, table))
    expect(xml).toContain('<pou name="MainProgram" pouType="program">')
    expect(xml).toContain('<pouInstance name="Main" typeName="MainProgram"/>')
    expect(xml).toMatch(/<globalVars>\s*<variable name="count">/)
  })

  it('keeps its variables the PROGRAM\'s own when nothing else names them', () => {
    const lone = exportProgram(runnableSource('VAR n : INT; END_VAR\nn := n + 1;', defaultController('', 20)), 'iec-text').content
    expect(lone).toContain('PROGRAM MainProgram\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM')
    expect(lone).not.toContain('VAR_GLOBAL')
    expect(() => parseAndCheck(lone)).not.toThrow()
  })
})

describe('a file that declares its own CONFIGURATION splits into program and table', () => {
  const FILE = `PROGRAM Counter
VAR_EXTERNAL total : INT; END_VAR
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
total := total + 1;
END_PROGRAM

CONFIGURATION Cell
  VAR_GLOBAL total : INT; END_VAR
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM A WITH Fast : Counter;
    PROGRAM B : Counter;
  END_RESOURCE
END_CONFIGURATION
`

  it('takes the tasks and instances into the table, and keeps the globals in the program', () => {
    const split = extractController(FILE)!
    expect(split.controller).toEqual({
      tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }],
      programs: [
        { name: 'A', type: 'Counter', task: 'Fast' },
        { name: 'B', type: 'Counter' },
      ],
    })
    expect(split.source).not.toMatch(/CONFIGURATION/)
    expect(split.source.startsWith('VAR_GLOBAL total : INT; END_VAR')).toBe(true)
  })

  it('runs exactly as the file did', () => {
    const split = extractController(FILE)!
    const fromFile = compile(FILE)
    const fromTable = compile(runnableSource(split.source, split.controller))
    expect(fromTable.tasks).toEqual(fromFile.tasks)
    fromFile.scan(0.01)
    fromTable.scan(0.01)
    expect(fromTable.watch).toEqual(fromFile.watch)
  })

  it('leaves a file alone when a table cannot hold its CONFIGURATION, or it has none', () => {
    expect(extractController(FILE.replace('INTERVAL := T#10ms', 'SINGLE := go'))).toBeNull() // an event task
    expect(extractController(FILE.replace('RESOURCE Res0 ON PLC', 'RESOURCE A ON PLC').replace('END_RESOURCE', 'END_RESOURCE\n  RESOURCE B ON PLC\n    TASK S(INTERVAL := T#5ms, PRIORITY := 0);\n    PROGRAM C WITH S : Counter;\n  END_RESOURCE'))).toBeNull()
    expect(extractController('VAR n : INT; END_VAR\nn := 1;')).toBeNull()
    expect(extractController('PROGRAM (')).toBeNull()
  })
})

// The Controller dock's problem count is `controller.length`: every problem the table has, each once.
describe("a table's problems, counted", () => {
  const CODE = 'PROGRAM Sorter\nVAR_OUTPUT Divert : BOOL; END_VAR\nDivert := TRUE;\nEND_PROGRAM\n\nVAR_OUTPUT Motor : BOOL; END_VAR\nMotor := TRUE;'
  const task = { name: 'MainTask', intervalMs: 10, priority: 10 }

  it('counts both problems of one row: a missing PROGRAM on a missing task', () => {
    const found = controllerDiagnostics(CODE, { tasks: [task], programs: [{ name: 'Main', task: 'MainTask' }, { name: 'G', type: 'Ghost', task: 'Nope' }] })
    expect(found.controller).toHaveLength(2)
    expect(found.controller).toEqual(expect.arrayContaining([expect.stringMatching(/unknown PROGRAM 'Ghost'/), expect.stringMatching(/unknown TASK 'Nope'/)]))
  })

  it("counts code no instance runs as the table's problem, still marked in the code where it is written", () => {
    const table = { tasks: [task], programs: [{ name: 'Main', type: 'Sorter', task: 'MainTask' }] }
    const found = controllerDiagnostics(CODE, table)
    expect(found.controller).toEqual([expect.stringMatching(/no PROGRAM instance runs that code/)])
    expect(found.source.map((d) => [d.message, d.origin])).toEqual([[expect.stringMatching(/no PROGRAM instance runs that code/), 'configuration']])
    expect(thrown(() => runnableSource(CODE, table))).toBeInstanceOf(ControllerError)
  })

  it("reports a table name ST cannot spell as the table's, instead of as an error in the program", () => {
    const bad = { tasks: [{ ...task, name: 'Main Task' }], programs: [{ name: 'Main', task: 'Main Task' }, { name: 'G', type: 'Ghost', task: 'Main Task' }] }
    const found = controllerDiagnostics(CODE, bad)
    expect(found.source).toEqual([])
    expect(found.controller).toEqual([expect.stringMatching(/task name "Main Task" cannot be written in ST/)])
    const e = thrown(() => runnableSource(CODE, bad))
    expect(e).toBeInstanceOf(ControllerError)
    expect((e as ControllerError).message).toMatch(/"Main Task"/)
  })

  it("leaves a CONFIGURATION the program declares itself to the program: with no table, nothing is the table's", () => {
    const own = `${CODE}\n\nCONFIGURATION C\n  TASK T(INTERVAL := T#10ms, PRIORITY := 0);\n  PROGRAM S WITH T : Sorter;\nEND_CONFIGURATION\n`
    const found = controllerDiagnostics(own, null)
    expect(found.controller).toEqual([])
    expect(found.source.map((d) => d.message)).toEqual([expect.stringMatching(/no PROGRAM instance runs that code/)])
  })
})
