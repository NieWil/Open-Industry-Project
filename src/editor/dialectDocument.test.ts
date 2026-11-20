// The program's dialect (EditorState.stDialect, core/dialect.ts) is part of the ST program document, like the controller
// table (controllerDocument.test.ts): kept, shared and exported with the source, replaced when it is, undone with it.
// A dialect this build does not have is kept as written and refused wherever the program would be read: the run edge
// (programRefusal), the Problems dock, the test runner. None of those may read it as IEC.

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CollabBridge } from '../collab/bridge'
import { metaMap, readStDoc, ST_DIALECT_META, writeStDoc } from '../collab/schema'
import { dialectRefusal } from '../core/dialect'
import { sceneToProject, serializeProject, validateProject } from '../core/project/project'
import { DEFAULT_SIM_HZ, SCENE_VERSION } from '../core/types'
import type { SceneJSON } from '../core/types'
import { collectProblems } from './problems'
import { attachedProgram, programOutOfDate, programRefusal } from './program/programReload'
import { runProjectTest } from './project/projectTestRunner'
import { loadSceneText, sceneFileText } from './project/sceneFile'
import { importStFile } from './program/stFileTransfer'
import { EditorStore } from './store/store'

const FOREIGN = 'rung Start -> Motor;\n'
const IEC = 'VAR_OUTPUT n : INT; END_VAR\nn := n + 1;\n'
const REFUSAL = dialectRefusal('s7')
const emptyScene = (): SceneJSON => ({ version: SCENE_VERSION, parts: [] })

describe('the dialect is part of the program document', () => {
  it('rides into the project and the scene file with the program, and comes back from the file', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(FOREIGN, { dialect: 's7' })
    expect(store.getState().stDialect).toBe('s7')
    expect(store.snapshotProject().stDialect).toBe('s7')
    const text = sceneFileText(store.getState())
    expect(JSON.parse(text).stDialect).toBe('s7')
    const other = new EditorStore(emptyScene())
    expect(loadSceneText(other, text)).toBeNull()
    expect(other.getState().stDialect).toBe('s7')
    expect(other.getState().stProgram).toBe(FOREIGN)
  })

  it('is IEC (absent) whenever a program is loaded without one, never the dialect of the program it replaced', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(FOREIGN, { dialect: 's7' })
    store.loadStProgram(IEC)
    expect(store.getState().stDialect).toBeUndefined()
    expect(store.snapshotProject().stDialect).toBeUndefined()
    expect(sceneFileText(store.getState())).not.toContain('stDialect')
    store.loadStProgram(IEC, { dialect: 'iec' }) // spelled out, still kept as absent
    expect(store.getState().stDialect).toBeUndefined()
  })

  it('stays with its project when another is loaded, and comes back with it', () => {
    const store = new EditorStore(emptyScene())
    store.loadProject(sceneToProject(emptyScene(), FOREIGN, 'P', 20, null, 's7'))
    expect(store.getState().stDialect).toBe('s7')
    const kept = JSON.parse(serializeProject(store.snapshotProject())) as unknown
    store.loadProject(sceneToProject(emptyScene(), IEC, 'Q'))
    expect(store.getState().stDialect).toBeUndefined() // not the dialect of the project it replaced
    expect(store.snapshotProject().stDialect).toBeUndefined()
    const back = validateProject(kept)
    if (!back.ok) throw new Error(back.errors.join('; '))
    store.loadProject(back.project)
    expect(store.getState()).toMatchObject({ stProgram: FOREIGN, stDialect: 's7' })
  })

  it('is undone with the program: an import that replaces a foreign program as IEC takes the dialect back on undo', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(FOREIGN, { dialect: 's7' })
    store.commitProgram('Import main.st', { source: IEC, controller: null, dialect: null })
    expect(store.getState()).toMatchObject({ stProgram: IEC, stDialect: undefined })
    store.undo()
    expect(store.getState()).toMatchObject({ stProgram: FOREIGN, stDialect: 's7' })
    store.redo()
    expect(store.getState()).toMatchObject({ stProgram: IEC, stDialect: undefined })
  })

  it('a commit that only changes the dialect is a step of its own; one that leaves it out leaves it alone', () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(FOREIGN)
    store.commitProgram('Mark as S7', { dialect: 's7' })
    expect(store.getState().stDialect).toBe('s7')
    store.commitProgram('Retime', { scanMs: 50 })
    expect(store.getState().stDialect).toBe('s7')
    store.undo()
    store.undo()
    expect(store.getState().stDialect).toBeUndefined()
  })

  it('an empty program keeps its marker through a save and a reload', () => {
    // a marker on an empty program is still the document's: dropping it on a capture would rewrite what was saved
    const store = new EditorStore(emptyScene())
    store.loadStProgram('', { dialect: 'other' })
    expect(store.getState()).toMatchObject({ stProgram: '', stDialect: 'other' })
    expect(store.snapshotProject().stDialect).toBe('other')
    const text = sceneFileText(store.getState())
    expect(JSON.parse(text).stDialect).toBe('other')
    const other = new EditorStore(emptyScene())
    expect(loadSceneText(other, text)).toBeNull()
    expect(other.getState().stDialect).toBe('other')
    // ...but only onto an empty program: a program-less file over code is layout-only, and must not relabel the code
    const withCode = new EditorStore(emptyScene())
    withCode.loadStProgram(IEC)
    expect(loadSceneText(withCode, text)).toBeNull()
    expect(withCode.getState()).toMatchObject({ stProgram: IEC, stDialect: undefined })
    // through the saved document and back: an empty program still carries its marker
    const saved = validateProject(JSON.parse(serializeProject(store.snapshotProject())))
    if (!saved.ok) throw new Error(saved.errors.join('; '))
    expect(saved.project.stDialect).toBe('other')
    const reloaded = new EditorStore(emptyScene())
    reloaded.loadProject(saved.project)
    expect(reloaded.getState()).toMatchObject({ stProgram: '', stDialect: 'other' })
    // a fresh project is IEC
    reloaded.loadProject(sceneToProject(emptyScene(), '', 'Fresh'))
    expect(reloaded.getState().stDialect).toBeUndefined()
    // and a program committed as IEC takes the field out of the saved project
    store.commitProgram('Write IEC', { dialect: null })
    expect(store.snapshotProject().stDialect).toBeUndefined()
  })

  it('an import that replaces a program in another dialect says so in its report, and one that does not stays quiet about it', async () => {
    const store = new EditorStore(emptyScene())
    store.loadStProgram(FOREIGN, { dialect: 'other' })
    await importStFile(store, new File([IEC], 'main.st'))
    expect(store.getState()).toMatchObject({ stProgram: IEC, stDialect: undefined })
    expect(store.getState().stFileReport?.detail).toBe("the program it replaced was in the 'other' dialect; this one is IEC 61131-3")
    await importStFile(store, new File([IEC], 'again.st'))
    expect(store.getState().stFileReport?.detail ?? '').not.toContain('dialect')
  })
})

describe('the dialect in a room', () => {
  /** two stores joined by two relayed docs, like two tabs in one room */
  function room(): { a: EditorStore; b: EditorStore; docA: Y.Doc } {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    docA.on('update', (u: Uint8Array) => Y.applyUpdate(docB, u, 'remote'))
    docB.on('update', (u: Uint8Array) => Y.applyUpdate(docA, u, 'remote'))
    const a = new EditorStore(emptyScene())
    const b = new EditorStore(emptyScene())
    a.setCollabMode(true)
    b.setCollabMode(true)
    new CollabBridge(a, docA)
    new CollabBridge(b, docB)
    return { a, b, docA }
  }

  it("reaches a peer with the program, and survives the peer's own unrelated program commit", () => {
    const { a, b, docA } = room()
    a.loadStProgram(FOREIGN, { dialect: 's7' })
    expect(metaMap(docA).get(ST_DIALECT_META)).toBe('s7')
    expect(b.getState()).toMatchObject({ stProgram: FOREIGN, stDialect: 's7' })
    b.commitProgram('Retime', { scanMs: 50 })
    expect(metaMap(docA).get(ST_DIALECT_META)).toBe('s7')
    expect(a.getState().stDialect).toBe('s7')
  })

  it('is cleared for everyone when a peer loads an IEC program over it, and an IEC room never gains the key', () => {
    const { a, b, docA } = room()
    a.loadStProgram(IEC)
    expect(metaMap(docA).has(ST_DIALECT_META)).toBe(false)
    a.loadStProgram(FOREIGN, { dialect: 's7' })
    b.loadStProgram(IEC)
    expect(metaMap(docA).has(ST_DIALECT_META)).toBe(false)
    expect(a.getState().stDialect).toBeUndefined()
  })

  it('reads and writes the atom as a plain string, and treats a non-string one as none', () => {
    const doc = new Y.Doc()
    writeStDoc(doc, FOREIGN, 20, undefined, undefined, 's7')
    expect(readStDoc(doc)).toMatchObject({ source: FOREIGN, dialect: 's7' })
    writeStDoc(doc, FOREIGN, 20, undefined, undefined, undefined) // undefined leaves it
    expect(readStDoc(doc).dialect).toBe('s7')
    writeStDoc(doc, FOREIGN, 20, undefined, undefined, 'iec') // IEC is never written, only cleared to
    expect(metaMap(doc).has(ST_DIALECT_META)).toBe(false)
    metaMap(doc).set(ST_DIALECT_META, 5)
    expect(readStDoc(doc).dialect).toBeUndefined()
  })
})

describe('a program in a dialect this build does not have is refused, never read as IEC', () => {
  it('at the run edge: the attach refuses it with the message, and an IEC program is not refused', () => {
    expect(programRefusal({ stDialect: 's7' })).toBe(REFUSAL)
    expect(programRefusal({})).toBeNull()
    expect(programRefusal({ stDialect: 'iec' })).toBeNull()
  })

  it('and a dialect change is a program a Reload would run differently', () => {
    const doc = { stProgram: FOREIGN, controller: null, stScanMs: 20, stDialect: 's7' }
    const attached = attachedProgram(doc)
    expect(programOutOfDate(attached, doc)).toBe(false)
    expect(programOutOfDate(attached, { ...doc, stDialect: undefined })).toBe(true)
  })

  it('in Problems: one error row with the message, and no IEC diagnostics of its text', () => {
    const report = collectProblems({ parts: [], runtime: [], buildErrors: {}, stepHz: DEFAULT_SIM_HZ, stProgram: FOREIGN, stDialect: 's7' })
    const program = report.problems.filter((p) => p.group === 'Program')
    expect(program).toHaveLength(1)
    expect(program[0]).toMatchObject({ severity: 'error', subject: 'Program', message: REFUSAL, parts: [] })
    expect(program[0]!.panel).toBeUndefined()
    expect(report.notes.join('\n')).toMatch(/dialect this version cannot read/)
    // the same text as IEC is a page of errors, which is exactly what the refusal keeps out
    const asIec = collectProblems({ parts: [], runtime: [], buildErrors: {}, stepHz: DEFAULT_SIM_HZ, stProgram: FOREIGN })
    expect(asIec.errors).toBeGreaterThan(0)
    expect(asIec.problems.some((p) => p.message === REFUSAL)).toBe(false)
  })

  it('by the project test runner, before it steps anything', () => {
    const project = sceneToProject(emptyScene(), FOREIGN, 'P', 20, null, 's7')
    // the refusal comes before Jolt is touched, so no physics module is needed to prove it
    expect(() => runProjectTest(null as never, project, { duration: 1, checks: [] } as never)).toThrow(REFUSAL)
  })
})
