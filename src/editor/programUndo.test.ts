// A program edit is one undo step (store.commitProgram): the controller organizer, the POU strip's program commands
// and import change the code, the scan time, the task table and the scene wiring together, and no Ctrl+Z may take
// back half of that. Solo it is an entry on the snapshot stack; in a room it is one shared-doc transaction the
// client's Y.UndoManager reverts whole. Typing stays the code editor's own history, and an edit whose code has been
// typed over since is dropped rather than undone over that work.

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Controller } from '../core/controller'
import { createPart } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { SceneJSON } from '../core/types'
import { CollabBridge } from '../collab/bridge'
import { docToScene, readStDoc, sceneToDoc } from '../collab/schema'
import { EditorStore } from './store/store'

const CODE = 'VAR_OUTPUT Motor : BOOL; END_VAR\nMotor := TRUE;'
const WITH_PROGRAM = `PROGRAM Sorter\nVAR_OUTPUT Divert : BOOL; END_VAR\nDivert := Motor;\nEND_PROGRAM\n\n${CODE}`
const TABLE: Controller = {
  tasks: [{ name: 'MainTask', intervalMs: 50, priority: 10 }],
  programs: [
    { name: 'Main', task: 'MainTask' },
    { name: 'Sorter', type: 'Sorter', task: 'MainTask' },
  ],
}

function soloStore(): EditorStore {
  const store = new EditorStore()
  store.loadStProgram(CODE, { scanMs: 50, persist: false })
  return store
}

const doc = (store: EditorStore) => {
  const s = store.getState()
  return { source: s.stProgram, scanMs: s.stScanMs, controller: s.controller }
}
const hasPart = (store: EditorStore, id: string): boolean => store.getState().scene.parts.some((p) => p.id === id)

describe('a program edit is one undo step', () => {
  it('takes the code, the table and the wiring back together, and puts them back together', () => {
    const store = soloStore()
    const rewired = { ...store.getState().scene, parts: [...store.getState().scene.parts, createPart('group', 'g_rewired', [0, 0, 0])] }
    store.commitProgram('Add program', { source: WITH_PROGRAM, controller: TABLE }, { scene: rewired })
    expect(doc(store)).toEqual({ source: WITH_PROGRAM, scanMs: 50, controller: TABLE })
    expect(hasPart(store, 'g_rewired')).toBe(true)
    expect(store.getEditHistory().events.at(-1)).toMatchObject({ label: 'Add program', kind: 'program' })

    store.undo()
    expect(doc(store)).toEqual({ source: CODE, scanMs: 50, controller: null })
    expect(hasPart(store, 'g_rewired')).toBe(false)

    store.redo()
    expect(doc(store)).toEqual({ source: WITH_PROGRAM, scanMs: 50, controller: TABLE })
    expect(hasPart(store, 'g_rewired')).toBe(true)
  })

  it('records nothing for an edit that changes nothing', () => {
    const store = soloStore()
    store.commitProgram('Retime', { scanMs: 50 })
    expect(store.canUndo).toBe(false)
  })

  it('leaves code typed since a table-only edit as it is', () => {
    const store = soloStore()
    store.commitProgram('Retime task MainTask', { scanMs: 20 })
    const typed = `${CODE}\n(* typed after *)`
    store.setStProgram(typed)
    store.undo()
    expect(doc(store)).toEqual({ source: typed, scanMs: 50, controller: null })
  })

  it('drops an edit whose code has changed since, says so, and lets the next undo go on', () => {
    const store = soloStore()
    store.commitProgram('Retime task MainTask', { scanMs: 20 })
    store.commitProgram('Add program', { source: WITH_PROGRAM, controller: TABLE })
    store.setStProgram(`${WITH_PROGRAM}\n(* typed into it *)`)

    store.undo()
    expect(store.getState().stProgram).toBe(`${WITH_PROGRAM}\n(* typed into it *)`) // the typing survives
    expect(store.getState().controller).toEqual(TABLE) // and nothing else moved either
    expect(store.getState().undoNotice?.title).toBe('Can\'t undo "Add program"')
    expect(store.getEditHistory().events.map((e) => e.label)).toEqual(['Retime task MainTask'])

    store.undo()
    expect(store.getState().stScanMs).toBe(50)
    store.dismissUndoNotice()
    expect(store.getState().undoNotice).toBeNull()
  })

  it('hands Ctrl+Z in the code editor a program edit only when nothing typed there is newer', () => {
    const store = soloStore()
    store.commitProgram('Add program', { source: WITH_PROGRAM, controller: TABLE })
    expect(store.undoProgramEditAt(`${WITH_PROGRAM} x`)).toBe(false) // typing is newer: the editor undoes that first
    expect(store.undoProgramEditAt(WITH_PROGRAM)).toBe(true)
    expect(doc(store)).toEqual({ source: CODE, scanMs: 50, controller: null })
    expect(store.redoProgramEditAt(`${CODE} y`)).toBe(false)
    expect(store.redoProgramEditAt(CODE)).toBe(true)
    expect(store.getState().controller).toEqual(TABLE)

    store.commitProgram('Retime task MainTask', { scanMs: 30 })
    expect(store.undoProgramEditAt(WITH_PROGRAM)).toBe(false) // a table-only edit is the project's, like a scene edit
  })

  it('the PLC panel (organizer, ladder view) also takes back a table-only edit: a task deleted, a program unscheduled', () => {
    const store = soloStore()
    store.commitProgram('Add program Sorter', { source: WITH_PROGRAM, controller: TABLE })
    const unscheduled: Controller = { tasks: TABLE.tasks, programs: [TABLE.programs[0]!] }
    store.commitProgram('Unschedule Sorter', { controller: unscheduled })
    expect(store.getState().controller).toEqual(unscheduled)

    // the code editor leaves it alone, as before; the panel asks for it
    expect(store.undoProgramEditAt(WITH_PROGRAM)).toBe(false)
    // ...but not over work done since: something drawn or typed after it is undone first, by the text's own history
    expect(store.undoProgramEditAt(`${WITH_PROGRAM} x`, true)).toBe(false)
    expect(store.undoProgramEditAt(WITH_PROGRAM, true)).toBe(true)
    expect(store.getState().controller).toEqual(TABLE)
    expect(store.getState().stProgram).toBe(WITH_PROGRAM) // the code was never part of that edit

    expect(store.redoProgramEditAt(WITH_PROGRAM, true)).toBe(true)
    expect(store.getState().controller).toEqual(unscheduled)
  })

  it('tells the mounted editor of code a program edit or its undo changes, and of nothing else', () => {
    const store = soloStore()
    const seen: string[] = []
    store.onStProgramEdit((source) => seen.push(source))
    store.commitProgram('Retime task MainTask', { scanMs: 30 })
    expect(seen).toEqual([])
    store.commitProgram('Add program', { source: WITH_PROGRAM, controller: TABLE })
    store.undo()
    expect(seen).toEqual([WITH_PROGRAM, CODE])
  })
})

describe('a program edit in a room', () => {
  /** two stores joined by relayed Y.Docs: two browser tabs in one room */
  function room(): { store1: EditorStore; store2: EditorStore; doc1: Y.Doc } {
    const scene: SceneJSON = { version: SCENE_VERSION, parts: [createPart('group', 'g_1', [2, 0.75, 0])] }
    const doc1 = new Y.Doc()
    sceneToDoc(scene, doc1)
    const store1 = new EditorStore()
    store1.setCollabMode(true)
    store1.applyRemote(docToScene(doc1))
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    const store2 = new EditorStore()
    store2.setCollabMode(true)
    store2.applyRemote(docToScene(doc2))
    doc1.on('update', (u: Uint8Array) => Y.applyUpdate(doc2, u, 'remote'))
    doc2.on('update', (u: Uint8Array) => Y.applyUpdate(doc1, u, 'remote'))
    new CollabBridge(store1, doc1)
    new CollabBridge(store2, doc2)
    return { store1, store2, doc1 }
  }

  it('undoes the code, the table and the wiring as one step, on both peers', () => {
    const { store1, store2, doc1 } = room()
    store1.loadStProgram(CODE, { scanMs: 50 })
    expect(store2.getState().stProgram).toBe(CODE)
    expect(store1.canUndo).toBe(false) // loading a program is not an edit anyone takes back with Ctrl+Z

    const rewired = { ...store1.getState().scene, parts: [...store1.getState().scene.parts, createPart('group', 'g_rewired', [6, 0.75, 0])] }
    store1.commitProgram('Add program', { source: WITH_PROGRAM, controller: TABLE }, { scene: rewired })
    expect(readStDoc(doc1)).toEqual({ source: WITH_PROGRAM, scanMs: 50, controller: TABLE })
    expect(doc(store2)).toEqual({ source: WITH_PROGRAM, scanMs: 50, controller: TABLE })
    expect(hasPart(store2, 'g_rewired')).toBe(true)

    store1.undo()
    for (const s of [store1, store2]) {
      expect(doc(s)).toEqual({ source: CODE, scanMs: 50, controller: null })
      expect(hasPart(s, 'g_rewired')).toBe(false)
    }
    expect(store1.canUndo).toBe(false) // it was one step

    store1.redo()
    expect(doc(store2)).toEqual({ source: WITH_PROGRAM, scanMs: 50, controller: TABLE })
    expect(hasPart(store2, 'g_rewired')).toBe(true)
  })

  it('keeps a step-rate change out of undo, and leaves the code editor its own', () => {
    const { store1 } = room()
    store1.loadStProgram(CODE, { scanMs: 50 })
    store1.setSimHz(120)
    expect(store1.canUndo).toBe(false)
    store1.commitProgram('Retime task MainTask', { scanMs: 20 })
    expect(store1.undoProgramEditAt(store1.getState().stProgram)).toBe(false) // a room's code undo is the shared binding's
    store1.undo()
    expect(store1.getState().stScanMs).toBe(50)
    expect(store1.getState().simHz).toBe(120)
  })
})
