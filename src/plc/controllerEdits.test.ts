// The organizer's edits (plc/controllerEdits.ts). What matters beyond the table arithmetic is the rename
// report: an edit that changes a tag's name must say so, or the scene's parts silently lose their wiring,
// and an edit that does not must say nothing. Every program an edit produces is run through the real
// checker with its table, because an organizer command that leaves the program not compiling is one
// nobody uses twice.

import { describe, expect, it } from 'vitest'
import type { Controller } from '../core/controller'
import { defaultController, programTypes, runnableSource, topLevelStatements } from './controller'
import {
  alignProgramType,
  addProgram,
  addTask,
  moveProgram,
  programNameError,
  removeProgram,
  removeTask,
  renameProgram,
  renameProgramType,
  renameTask,
  setProgramTask,
  setProgramType,
  setTaskTiming,
  taskNameError,
} from './controllerEdits'
import { flattenDocument, parseDocument } from './document'
import { exportProgram } from './exchange/export'
import { compile } from './interpreter'
import { lex } from './lexer'
import { parse } from './parser'

const LONE = `VAR_INPUT Start : BOOL; Cell_Done : BOOL; END_VAR
VAR_OUTPUT Motor : BOOL; END_VAR
Motor := Start AND NOT Cell_Done;`

/** the edit's program, run with its table: what the organizer would attach */
const runs = (source: string, controller: Controller) => compile(runnableSource(source, controller))

/** LONE with a PROGRAM beside it that reads one of its tags */
const WITH_SORTER = `PROGRAM Sorter
VAR_OUTPUT Divert : BOOL; END_VAR
Divert := Motor;
END_PROGRAM

${LONE}`

describe('the default table a program with none of its own runs from', () => {
  const base = defaultController(LONE, 40)

  it('is one task at the scan time running the top-level code, whose tags keep their names', () => {
    expect(base).toEqual({ tasks: [{ name: 'MainTask', intervalMs: 40, priority: 10 }], programs: [{ name: 'Main', task: 'MainTask' }] })
    const p = runs(LONE, base)
    expect(p.inputs).toEqual(['Start', 'Cell_Done'])
    expect(p.outputs).toEqual(['Motor'])
  })

  it('runs the program exactly as it ran alone', () => {
    const alone = compile(LONE)
    const tabled = runs(LONE, base)
    for (const p of [alone, tabled]) {
      p.setInput('Start', true)
      p.scan(0.04)
    }
    expect(tabled.get('Motor')).toBe(true)
    expect(tabled.watch).toEqual(alone.watch)
  })
})

describe('the table edits', () => {
  const base = defaultController(LONE, 40)
  const withSorter: Controller = { ...base, programs: [...base.programs, { name: 'Sorter', type: 'Sorter', task: 'MainTask' }] }

  it('adds a PROGRAM beside the top-level code without renaming any of its tags', () => {
    const added = addProgram(LONE, base)
    expect(programTypes(added.source)).toEqual(['Program1'])
    expect(added.controller.programs).toEqual([
      { name: 'Main', task: 'MainTask' },
      { name: 'Program1', type: 'Program1', task: 'MainTask' },
    ])
    expect(parseDocument(added.source).blocks[added.index]!.name).toBe('Program1')
    const p = runs(added.source, added.controller)
    expect(p.tasks[0]!.programs).toEqual(['Main', 'Program1'])
    expect(p.inputs).toEqual(['Start', 'Cell_Done'])
    expect(p.outputs).toEqual(['Motor'])
  })

  it('adds a ladder PROGRAM the same way: one LADDER section that is its whole body, running on the first task', () => {
    const added = addProgram(LONE, base, undefined, 'ladderProgram')
    const block = parseDocument(added.source).blocks[added.index]!
    expect([block.kind, block.name]).toEqual(['programPou', 'Program1'])
    expect(added.controller.programs[1]).toEqual({ name: 'Program1', type: 'Program1', task: 'MainTask' })
    const ast = parse(lex(runnableSource(added.source, added.controller)))
    expect(ast.ladder.map((s) => [s.pou, s.whole])).toEqual([['Program1', true]])
    expect(runs(added.source, added.controller).tasks[0]!.programs).toEqual(['Main', 'Program1'])
  })

  it("lets a PROGRAM use the top-level code's variables, which are the controller's tags", () => {
    const p = runs(WITH_SORTER, withSorter)
    p.setInput('Start', true)
    p.scan(0.04)
    expect(p.get('Motor')).toBe(true)
    expect(p.get('Sorter.Divert')).toBe(true) // Main runs first on the task, so Sorter sees this scan's Motor
    expect(p.outputs).toEqual(['Motor', 'Sorter.Divert'])
  })

  it('adds tasks with free names, retimes them within what a table holds, and renames their references', () => {
    const two = addTask(addTask(base))
    expect(two.tasks.map((t) => [t.name, t.intervalMs])).toEqual([
      ['MainTask', 40],
      ['Task1', 40],
      ['Task2', 40],
    ])
    expect(setTaskTiming(two, 1, { intervalMs: 0.4, priority: -3 }).tasks[1]).toEqual({ name: 'Task1', intervalMs: 1, priority: 0 })
    expect(renameTask(base, 0, 'Cyclic').programs[0]!.task).toBe('Cyclic')
  })

  it('will not remove a task a program still runs on', () => {
    expect(removeTask(base, 0)).toBeNull()
    expect(removeTask(addTask(base), 1)?.tasks.map((t) => t.name)).toEqual(['MainTask'])
  })

  it("renames a PROGRAM instance's tags with it, and nothing for the instance running the top-level code", () => {
    const r = renameProgram(WITH_SORTER, withSorter, 1, 'Line1')
    expect(r.controller.programs[1]!.name).toBe('Line1')
    expect(r.renames).toEqual([{ from: 'Sorter.Divert', to: 'Line1.Divert' }])
    const main = renameProgram(WITH_SORTER, withSorter, 0, 'Cell')
    expect(main.controller.programs[0]).toEqual({ name: 'Cell', task: 'MainTask' })
    expect(main.renames).toEqual([])
    expect(runs(WITH_SORTER, main.controller).outputs).toEqual(['Motor', 'Sorter.Divert'])
  })

  it('moves a program to continuous and back, points a row at a PROGRAM or the top-level code, and reorders and removes rows', () => {
    const added = addProgram(LONE, base).controller
    const always = setProgramTask(added, 1, null)
    expect(always.programs[1]).toEqual({ name: 'Program1', type: 'Program1' })
    expect(setProgramTask(always, 1, 'MainTask').programs[1]!.task).toBe('MainTask')
    expect(setProgramType(added, 0, 'Program1').programs[0]).toEqual({ name: 'Main', type: 'Program1', task: 'MainTask' })
    expect(setProgramType(added, 1, null).programs[1]).toEqual({ name: 'Program1', task: 'MainTask' })
    expect(moveProgram(added, 1, -1).programs.map((p) => p.name)).toEqual(['Program1', 'Main'])
    expect(moveProgram(added, 0, -1)).toBe(added)
    expect(removeProgram(added, 0).programs.map((p) => p.name)).toEqual(['Program1'])
  })

  it('carries an instance named after a renamed PROGRAM type along, tags and all, and leaves one with its own name', () => {
    const renamed = WITH_SORTER // the source after `PROGRAM Merge` became `PROGRAM Sorter`
    const merge: Controller = { ...base, programs: [...base.programs, { name: 'Merge', type: 'Merge', task: 'MainTask' }] }
    const followed = renameProgramType(renamed, merge, 'Merge', 'Sorter')
    expect(followed.controller.programs).toEqual([
      { name: 'Main', task: 'MainTask' },
      { name: 'Sorter', type: 'Sorter', task: 'MainTask' },
    ])
    expect(followed.renames).toEqual([{ from: 'Merge.Divert', to: 'Sorter.Divert' }])
    const own = renameProgramType(renamed, { ...base, programs: [{ name: 'Line1', type: 'Merge', task: 'MainTask' }] }, 'Merge', 'Sorter')
    expect(own.controller.programs[0]).toEqual({ name: 'Line1', type: 'Sorter', task: 'MainTask' })
    expect(own.renames).toEqual([])
  })

  it('refuses a name that is empty, not an identifier, reserved, or already taken', () => {
    const two = addTask(base)
    expect(taskNameError(two, 1, 'maintask')).toMatch(/already called maintask/)
    expect(taskNameError(two, 1, 'Task1')).toBeNull() // its own name
    expect(programNameError(base, 0, '2fast')).toMatch(/not a valid name/)
    expect(programNameError(base, 0, 'while')).toMatch(/WHILE is a reserved word/)
    expect(programNameError(base, 0, ' ')).toMatch(/A name is required/)
  })
})

describe('the statements outside every PROGRAM', () => {
  it('are what keeps the row running them from being removed', () => {
    expect(topLevelStatements(LONE)).toBe(true)
    expect(topLevelStatements('VAR_INPUT Start : BOOL; END_VAR')).toBe(false)
    expect(topLevelStatements('PROGRAM P\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\n')).toBe(false)
    // beside a PROGRAM they are only legal once a table runs them, and are read all the same
    expect(topLevelStatements(WITH_SORTER)).toBe(true)
  })
})

describe('PROGRAM and CONFIGURATION blocks in the POU strip', () => {
  it('are chips of their own, named, and the strip still joins back into the same program', () => {
    const src = 'FUNCTION_BLOCK F\nVAR_OUTPUT q : BOOL; END_VAR\nq := TRUE;\nEND_FUNCTION_BLOCK;\n\nPROGRAM P\nVAR n : INT; END_VAR\nn := 1;\nEND_PROGRAM\n\nCONFIGURATION Cell\n  TASK T(INTERVAL := T#10ms, PRIORITY := 0);\n  PROGRAM I WITH T : P;\nEND_CONFIGURATION'
    const doc = parseDocument(src)
    expect(doc.blocks.map((b) => [b.kind, b.name])).toEqual([
      ['functionBlock', 'F'],
      ['programPou', 'P'],
      ['configuration', 'Cell'],
    ])
    expect(doc.blocks[0]!.text.endsWith('END_FUNCTION_BLOCK;')).toBe(true) // the `;` travels with its block
    expect(flattenDocument(doc)).toBe(src)
  })
})

describe('exporting an instance spelled like its PROGRAM type', () => {
  it('warns, since MATIEC refuses it', () => {
    const added = addProgram(LONE, defaultController(LONE, 40))
    expect(exportProgram(runnableSource(added.source, added.controller), 'iec-text').warnings.join(' ')).toMatch(/Program1: a program instance spelled like a PROGRAM type/)
  })
})

describe('a program with one name: renamed in its Properties, the PROGRAM in the text follows', () => {
  const TWO = 'PROGRAM Merge\nVAR n : DINT; END_VAR\nn := n + 1;\nEND_PROGRAM\n\nPROGRAM Sort\nVAR m : DINT; END_VAR\nm := m + 1;\nEND_PROGRAM\n'
  const table = (programs: Controller['programs']): Controller => ({ tasks: [{ name: 'MainTask', intervalMs: 10, priority: 10 }], programs })

  it('the only instance of its PROGRAM takes the PROGRAM along - an instance left behind by an earlier rename too', () => {
    const renamed = table([{ name: 'Line_Merge', type: 'Merge', task: 'MainTask' }, { name: 'Sort', type: 'Sort', task: 'MainTask' }])
    const aligned = alignProgramType(TWO, renamed, 0)!
    expect(aligned.source).toContain('PROGRAM Line_Merge\n')
    expect(aligned.source).not.toContain('PROGRAM Merge\n')
    expect(aligned.controller.programs[0]).toEqual({ name: 'Line_Merge', type: 'Line_Merge', task: 'MainTask' })
    expect(compile(runnableSource(aligned.source, aligned.controller)).tasks[0]!.programs).toEqual(['Line_Merge', 'Sort'])
  })

  it('nothing to do, or not to be done: the same name already, two instances of one PROGRAM (IEC allows it), a name the text has taken', () => {
    expect(alignProgramType(TWO, table([{ name: 'Merge', type: 'Merge', task: 'MainTask' }]), 0)).toBeNull()
    expect(alignProgramType(TWO, table([{ name: 'A', type: 'Merge', task: 'MainTask' }, { name: 'B', type: 'Merge', task: 'MainTask' }]), 0)).toBeNull()
    expect(alignProgramType(TWO, table([{ name: 'Sort', type: 'Merge', task: 'MainTask' }]), 0)).toBeNull()
  })
})
