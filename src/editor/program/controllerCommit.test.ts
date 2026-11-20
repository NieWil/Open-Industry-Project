// The commit the Controller dock and the PLC panel's chip rename share (editor/program/controllerCommit.ts). It runs with no
// code editor mounted (the Controller dock is often on screen while the PLC panel is not), so everything it does has to
// go through the store alone.

import { describe, expect, it } from 'vitest'
import type { Controller } from '../../core/controller'
import { SCENE_VERSION } from '../../core/types'
import type { SceneJSON } from '../../core/types'
import { defaultController, renameProgram, setTaskTiming } from '../../plc'
import { commitControllerEdit, commitProgramAddition, namedProgramAddition } from './controllerCommit'
import { EditorStore } from '../store/store'

const TOP_LEVEL = 'VAR_INPUT Start : BOOL; END_VAR\nVAR_OUTPUT Motor : BOOL; END_VAR\nMotor := Start;'
const COUNTER = 'PROGRAM Counter\nVAR_OUTPUT n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\n'
const TABLE: Controller = { tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }], programs: [{ name: 'A', type: 'Counter', task: 'Fast' }] }
const emptyScene = (): SceneJSON => ({ version: SCENE_VERSION, parts: [] })

describe('namedProgramAddition', () => {
  const table = defaultController(TOP_LEVEL, 100)

  it('with no name, adds the PROGRAM under the name it picks, run by an instance named after it', () => {
    const added = namedProgramAddition(TOP_LEVEL, table)
    if (added.error !== null) throw new Error(added.error)
    expect(added.name).not.toBe('')
    expect(added.source).toContain(`PROGRAM ${added.name}`)
    expect(added.controller.programs.at(-1)).toEqual({ name: added.name, type: added.name, task: 'MainTask' })
  })

  it('with a name, the code and the instance both carry it, and the top-level code is left alone', () => {
    const added = namedProgramAddition(TOP_LEVEL, table, 'Sorter')
    if (added.error !== null) throw new Error(added.error)
    expect(added.source).toContain('PROGRAM Sorter')
    expect(added.source).toContain('Motor := Start;')
    expect(added.controller.programs).toEqual([...table.programs, { name: 'Sorter', type: 'Sorter', task: 'MainTask' }])
  })

  it('refuses a name the code already uses, and says why', () => {
    const added = namedProgramAddition(TOP_LEVEL, table, 'Motor')
    expect(added.error).toMatch(/already used/)
    expect('source' in added).toBe(false)
  })
})

describe('commitControllerEdit', () => {
  it('retiming the default table of a program with none is its scan time, and stores no table', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(TOP_LEVEL, { scanMs: 100 })
    const next = setTaskTiming(defaultController(TOP_LEVEL, 100), 0, { intervalMs: 25 })
    expect(commitControllerEdit(store, next, [], 'Retime task MainTask')).toBeNull()
    expect(store.getState().stScanMs).toBe(25)
    expect(store.getState().controller).toBeNull()
  })

  it('a renamed instance moves its tags, reports them, and undoes as one step', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(COUNTER, { controller: TABLE })
    const { controller, renames } = renameProgram(COUNTER, TABLE, 0, 'B')
    const report = commitControllerEdit(store, controller, renames, 'Rename program A')
    expect(store.getState().controller?.programs[0]?.name).toBe('B')
    expect(report?.items).toContain('A.n is now B.n')
    store.undo()
    expect(store.getState().controller).toEqual(TABLE)
  })
})

describe('commitProgramAddition', () => {
  it('adds the named PROGRAM and its instance, and one undo takes back both', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(TOP_LEVEL, { scanMs: 100 })
    expect(commitProgramAddition(store, 'Sorter')).toBeNull()
    expect(store.getState().stProgram).toContain('PROGRAM Sorter')
    expect(store.getState().controller?.programs.at(-1)).toEqual({ name: 'Sorter', type: 'Sorter', task: 'MainTask' })
    store.undo()
    expect(store.getState().stProgram).toBe(TOP_LEVEL)
    expect(store.getState().controller).toBeNull()
  })

  it('refuses a name the code already uses, says why, and changes nothing', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(TOP_LEVEL, { scanMs: 100 })
    expect(commitProgramAddition(store, 'Motor')).toMatch(/already used/)
    expect(store.getState().stProgram).toBe(TOP_LEVEL)
    expect(store.getState().controller).toBeNull()
  })
})
