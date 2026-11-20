// The controller table is part of the ST program document (EditorState.controller): it is kept, shared
// and exported with the source and the scan time, and replaced when they are. Each carrier gets one
// assertion here, because each is a place the program itself can go missing (stProgramDocument.test).

import { describe, expect, it } from 'vitest'
import type { Controller } from '../core/controller'
import { sceneToProject } from '../core/project/project'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { SceneJSON } from '../core/types'
import { collectProblems } from './problems'
import { sceneFileText } from './project/sceneFile'
import { EditorStore } from './store/store'

const PROGRAM = 'PROGRAM Counter\nVAR_OUTPUT n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\n'
const TABLE: Controller = { tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }], programs: [{ name: 'A', type: 'Counter', task: 'Fast' }] }
const emptyScene = (): SceneJSON => ({ version: SCENE_VERSION, parts: [] })

describe('the controller table is part of the program document', () => {
  it('rides into the project and the scene file with the program', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(PROGRAM, { controller: TABLE })
    expect(store.getState().controller).toEqual(TABLE)
    expect(store.snapshotProject().controller).toEqual(TABLE)
    expect(JSON.parse(sceneFileText(store.getState())).controller).toEqual(TABLE)
  })

  it('is replaced with the program: one loaded without a table runs alone', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(PROGRAM, { controller: TABLE })
    store.loadStProgram('VAR n : INT; END_VAR\nn := 1;')
    expect(store.getState().controller).toBeNull()
    expect(store.snapshotProject().controller).toBeUndefined()
  })

  it('reaches the room through the program sink, and a clear reaches it too', () => {
    const store = new EditorStore(emptyScene())
    const room: { controller: Controller | null }[] = []
    store.setCollabMode(true)
    store.setStProgramSink((d) => void room.push(d))
    store.loadStProgram(PROGRAM)
    store.setController(TABLE)
    store.setController(structuredClone(TABLE)) // the same table: nothing to keep
    store.setController(null)
    expect(room.map((d) => d.controller)).toEqual([null, TABLE, null])
  })

  it("adopts a peer's table, and keeps its own when a peer's update carries none", () => {
    const store = new EditorStore(emptyScene())
    store.applyRemoteStProgram(PROGRAM, 100, TABLE)
    expect(store.getState().controller).toEqual(TABLE)
    store.applyRemoteStProgram(PROGRAM, 100)
    expect(store.getState().controller).toEqual(TABLE)
    store.applyRemoteStProgram(PROGRAM, 100, null)
    expect(store.getState().controller).toBeNull()
  })

  it('stays with its project when another is loaded, and comes back with it', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(PROGRAM, { controller: TABLE })
    const kept = structuredClone(store.snapshotProject())
    store.loadProject(sceneToProject(emptyScene(), PROGRAM, 'Other'))
    expect(store.getState().controller).toBeNull() // not the table of the project it replaced
    expect(store.snapshotProject().controller).toBeUndefined()
    store.loadProject(kept)
    expect(store.getState().controller).toEqual(TABLE)
  })
})

describe('Problems, for a program that runs from a controller table', () => {
  const base = { parts: [], runtime: [], buildErrors: {}, stepHz: DEFAULT_SIM_HZ }

  it("lists what the table names but the program lacks as a Controller row, with no line", () => {
    const report = collectProblems({ ...base, stProgram: PROGRAM, controller: { ...TABLE, programs: [{ name: 'A', type: 'Merge', task: 'Fast' }] } })
    const row = report.problems.find((p) => p.subject === 'Controller')
    expect(row?.message).toMatch(/unknown PROGRAM 'Merge'/)
    expect(row?.line).toBeUndefined()
  })

  it('is clean when the table and the program agree', () => {
    const report = collectProblems({ ...base, stProgram: PROGRAM, controller: TABLE })
    expect(report.problems.filter((p) => p.group === 'Program')).toEqual([])
    expect(report.notes).toEqual([])
  })
})
