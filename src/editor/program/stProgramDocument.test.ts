// The ST program is one document, owned by store state (EditorState.stProgram / stScanMs).
//
// The hazard is several stores of record - a localStorage key, the room's shared Y.Text, a
// `pendingStProgram` field for the demo - with readers that each consult a different subset: the
// attach path taking `pending ?? shared ?? localStorage` while the scene exporter, the room seeder
// and the project autosave take localStorage alone. Every way those disagree produces the same
// silent symptom: an empty (or wrong) program attaches without error, drives no output, so
// every comms device falls back to hand control and the line never starts.
//
// These tests check that the readers agree at the seams a user actually goes through.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorStore } from '../store/store'
import { loadSceneText, newSimulation, sceneFileText } from '../project/sceneFile'
import { PROJECT_KEY, downloadProject } from '../project/projectFile'
import { oipBytesToProject } from '../../core/project/projectArchive'
import { bakePart } from '../parts/bakePart'
import { DEFAULT_SCAN_MS, ST_PROGRAM_KEY, ST_SCAN_MS_KEY } from './stProgram'
import { validateProject } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'

const PROGRAM = 'VAR_INPUT Sensor : BOOL; END_VAR\nVAR_OUTPUT Motor : BOOL; END_VAR\nMotor := Sensor;'

/** in-memory Storage (the Node test env has no localStorage) */
function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

function scene(): SceneJSON {
  const part: PartInstance = { id: 'g1', type: 'group', position: [1, 0, 0], rotationY: 0, params: {} } as PartInstance
  return { version: SCENE_VERSION, parts: [part] }
}

/**
 * Capture what Export Project actually writes, read back. The test goes through the real export entry point because
 * the bug it guards against is not in the serializer but in which program the exporter chooses to hand it.
 */
async function exportedText(store: EditorStore): Promise<string> {
  let captured: Uint8Array = new Uint8Array()
  vi.stubGlobal(
    'Blob',
    class {
      constructor(parts: Uint8Array[]) {
        captured = parts[0]!
      }
    },
  )
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
  vi.stubGlobal('document', { createElement: () => ({ click: () => {}, href: '', download: '' }) })
  await downloadProject(store)
  const read = await oipBytesToProject(captured, { bakePart })
  if (!read.ok) throw new Error(read.errors.join('; '))
  return JSON.stringify(read.project)
}

describe('the ST program as one document', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('exports the program the controller would attach', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.loadStProgram(PROGRAM, { scanMs: 40 })
    const doc = JSON.parse(await exportedText(store)) as { stProgram?: string; stScanMs?: number }
    expect(doc.stProgram).toBe(PROGRAM)
    expect(doc.stScanMs).toBe(40)
  })

  /**
   * Guards against the room-export bug. In a room the program of record is the shared Y.Text (the
   * store's sink writes there and leaves localStorage alone), so an exporter that read localStorage
   * would get whatever the user had before they joined the room: usually nothing. The scene.json
   * handed round would then have a layout and no logic, and nothing would run for whoever opened it.
   */
  it('exports the room program, not the pre-room localStorage buffer', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    localStorage.setItem(ST_PROGRAM_KEY, 'STALE_PRE_ROOM;')
    const store = new EditorStore(scene())
    const roomDoc: { source: string; scanMs: number }[] = []
    store.setCollabMode(true)
    store.setStProgramSink((d) => void roomDoc.push(d)) // stands in for the shared Y.Text
    store.loadStProgram(PROGRAM)

    expect(roomDoc).toEqual([{ source: PROGRAM, scanMs: DEFAULT_SCAN_MS, controller: null }])
    expect(localStorage.getItem(ST_PROGRAM_KEY)).toBe('STALE_PRE_ROOM;') // untouched, as intended
    expect((JSON.parse(await exportedText(store)) as { stProgram?: string }).stProgram).toBe(PROGRAM)
  })

  /**
   * Guards against the demo-share bug. `?scene=demo` loads its paired program without persisting it
   * (peeking at the demo must not overwrite a returning user's saved work). If that program sits in a
   * side channel only the attach path can see, Share seeds the room (and File > Save writes the file)
   * with the demo's layout and no logic.
   */
  it('a live-but-unpersisted program still reaches the exporter and the room seed', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.loadStProgram(PROGRAM, { persist: false })
    expect(localStorage.getItem(ST_PROGRAM_KEY)).toBeNull() // not kept...
    expect(store.getState().stProgram).toBe(PROGRAM) // ...but fully live
    expect((JSON.parse(await exportedText(store)) as { stProgram?: string }).stProgram).toBe(PROGRAM)
  })

  it('round-trips program + scan time through a scene file', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const source = new EditorStore(scene())
    source.loadStProgram(PROGRAM, { scanMs: 25 })
    const target = new EditorStore()
    expect(loadSceneText(target, sceneFileText(source.getState()))).toBeNull()
    expect(target.getState().stProgram).toBe(PROGRAM)
    expect(target.getState().stScanMs).toBe(25)
  })

  it('clamps a hand-edited scan time on the way in rather than trusting the file', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    const file = JSON.stringify({ version: SCENE_VERSION, parts: [], stProgram: PROGRAM, stScanMs: 999999 })
    expect(loadSceneText(store, file)).toBeNull()
    expect(store.getState().stScanMs).toBe(1000) // MAX_SCAN_MS
  })

  it('keeps the current program when a file bundles none (a layout-only import)', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore()
    store.loadStProgram(PROGRAM)
    expect(loadSceneText(store, JSON.stringify({ version: SCENE_VERSION, parts: [] }))).toBeNull()
    expect(store.getState().stProgram).toBe(PROGRAM)
  })

  it('persists the scan time with the program, solo', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.loadStProgram(PROGRAM)
    store.setStScanMs(20)
    expect(localStorage.getItem(ST_SCAN_MS_KEY)).toBe('20')
    const result = validateProject(JSON.parse(localStorage.getItem(PROJECT_KEY)!))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.project.stScanMs).toBe(20)
  })

  it('New simulation clears the program and its scan time together', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    store.loadStProgram(PROGRAM, { scanMs: 20 })
    newSimulation(store)
    expect(store.getState().stProgram).toBe('')
    expect(store.getState().stScanMs).toBe(DEFAULT_SCAN_MS)
  })

  it('a remote program lands in state without echoing back to the room', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    const writes: unknown[] = []
    store.setCollabMode(true)
    store.setStProgramSink((d) => void writes.push(d))
    store.applyRemoteStProgram(PROGRAM, 30)
    expect(store.getState().stProgram).toBe(PROGRAM)
    expect(store.getState().stScanMs).toBe(30)
    expect(writes).toEqual([]) // the doc already holds it; writing back would loop
  })

  it('a keystroke updates state without broadcasting back into the editor that produced it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const store = new EditorStore(scene())
    const broadcasts: string[] = []
    store.onStProgramLoad((s) => broadcasts.push(s))
    store.setStProgram('Motor := TRUE;')
    expect(store.getState().stProgram).toBe('Motor := TRUE;')
    expect(broadcasts).toEqual([])
    store.loadStProgram('Motor := FALSE;') // a wholesale replacement DOES reach a mounted editor
    expect(broadcasts).toEqual(['Motor := FALSE;'])
  })
})
