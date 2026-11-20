import { afterEach, describe, expect, it } from 'vitest'
import { getPackage, registerPackage, unregisterPackage } from '../core/parts/partRegistry'
import { buildPackage } from '../sim/buildPackage'
import { manifestOfPackage } from '../core/parts/partPackage'
import { importScannedParts } from './parts/packageSource'
import { builtInsUpdated, keepProjectVersion } from './store/storePackages'
import { EditorStore } from './store/store'
import { partFingerprint } from '../core/parts/partOrigin'

// The project's part library (store.userPackages) is the only source of a project's part definitions: a folder of
// parts is imported into it, and moving to another project replaces it - nothing from the last project survives.

const ID = 'acme.lib-probe'
const manifest = (name: string) => ({ id: ID, name, geometry: { kind: 'rig' as const, links: [{ name: 'body', shape: { kind: 'box' as const, size: [1, 1, 1] as [number, number, number] }, offset: [0, 0, 0] as [number, number, number] }], joints: [] } })
const BEHAVIOR = `definePart({ step() {} })`

afterEach(() => unregisterPackage(ID))

describe('importScannedParts', () => {
  it('adds each part of a scanned folder to the library as this project own, and reports one that fails', () => {
    const store = new EditorStore()
    const statuses = importScannedParts(store, {
      root: 'C:/parts',
      parts: [
        { dir: 'C:/parts/a', id: ID, name: 'Probe', manifestJson: JSON.stringify(manifest('Probe')), behaviorSource: BEHAVIOR },
        { dir: 'C:/parts/b', id: 'acme.broken', name: 'Broken', manifestJson: '{not json', behaviorSource: BEHAVIOR },
      ],
      problems: [{ dir: 'C:/parts/c', message: 'no manifest.json' }],
    })
    expect(statuses.map((s) => s.ok)).toEqual([true, false, false])
    expect(store.getState().userPackages.map((p) => p.id)).toContain(ID)
    expect(getPackage(ID)?.name).toBe('Probe')
    // importing again replaces, never duplicates
    importScannedParts(store, { root: 'C:/parts', parts: [{ dir: 'C:/parts/a', id: ID, name: 'Probe 2', manifestJson: JSON.stringify(manifest('Probe 2')), behaviorSource: BEHAVIOR }], problems: [] })
    expect(store.getState().userPackages.filter((p) => p.id === ID)).toHaveLength(1)
    expect(getPackage(ID)?.name).toBe('Probe 2')
  })
})

describe('adoptProjectLibrary', () => {
  it('replaces the library: a part only the previous project had is gone from the registry too', () => {
    const store = new EditorStore()
    store.adoptProjectLibrary([buildPackage(manifest('Theirs'), BEHAVIOR)])
    expect(getPackage(ID)?.name).toBe('Theirs')
    store.adoptProjectLibrary([])
    expect(store.getState().userPackages.some((p) => p.id === ID)).toBe(false)
    expect(getPackage(ID)).toBeUndefined()
  })

  it('a built-in the previous project had edited goes back to the built-in', () => {
    const store = new EditorStore()
    const builtIn = buildPackage(manifest('Built-in'), BEHAVIOR)
    registerPackage(builtIn, true)
    store.setState({ bundledPackages: [builtIn] })
    store.adoptProjectLibrary([{ ...builtIn, name: 'Edited copy' }])
    expect(getPackage(builtIn.id)?.name).toBe('Edited copy')
    store.adoptProjectLibrary([])
    expect(getPackage(builtIn.id)?.name).toBe(builtIn.name)
  })
})

describe('a project version of a built-in the app later updates', () => {
  // the whole flow through the store: an edit makes the copy, the app ships a new built-in, the person chooses
  function project() {
    const store = new EditorStore()
    const v1 = buildPackage(manifest('Built-in'), BEHAVIOR)
    registerPackage(v1, true)
    store.setState({ bundledPackages: [v1] })
    store.commitPackage('Edit behavior', { ...v1, behavior: 'definePart({ step() { /* mine */ } })' })
    return store
  }
  const shipUpdate = (store: EditorStore) => store.setState({ bundledPackages: [buildPackage(manifest('Built-in'), 'definePart({ step() { /* v2 */ } })')] })

  it('records the built-in it came from, through later edits too', () => {
    const store = project()
    const fromApp = store.getState().userPackages.find((p) => p.id === ID)?.origin?.app
    expect(fromApp).toBeTruthy()
    store.commitPackage('Edit again', { ...getPackage(ID)!, behavior: 'definePart({ step() { /* mine 2 */ } })' })
    expect(store.getState().userPackages.find((p) => p.id === ID)?.origin?.app).toBe(fromApp)
    expect(builtInsUpdated(store.getState()).size).toBe(0)
  })

  it('is flagged once the app ships a changed built-in, and Keep stops the question', () => {
    const store = project()
    shipUpdate(store)
    expect([...builtInsUpdated(store.getState())]).toEqual([ID])
    expect(getPackage(ID)!.behavior).toContain('mine') // still the project's own
    expect(keepProjectVersion(store, ID)).toBe(true)
    expect(builtInsUpdated(store.getState()).size).toBe(0)
    expect(getPackage(ID)!.behavior).toContain('mine')
  })

  it("Use the app's new version puts the updated built-in in place of the project's, as the project's copy", () => {
    const store = project()
    shipUpdate(store)
    expect(store.updateFromApp([ID])).toEqual([ID])
    expect(getPackage(ID)!.behavior).toContain('v2')
    const copy = store.getState().userPackages.find((p) => p.id === ID)
    expect(copy?.behavior).toContain('v2') // still in the library: every part a project uses is its own
    expect(copy?.origin?.app).toBe(partFingerprint(store.getState().bundledPackages[0]!))
    expect(builtInsUpdated(store.getState()).size).toBe(0)
  })

  it('takes nothing it was not asked to', () => {
    const store = project()
    shipUpdate(store)
    expect(store.updateFromApp(['acme.not-in-the-library'])).toEqual([])
    expect(getPackage(ID)!.behavior).toContain('mine')
  })

  it('in a room, an update and a keep go to everyone there, each with its line in the room feed', () => {
    const store = project()
    shipUpdate(store)
    const sent: string[] = []
    const feed: string[] = []
    store.setCollabMode(true)
    store.setPackageSink((p) => sent.push(`${p.id}:${p.behavior.includes('v2') ? 'v2' : 'mine'}`))
    store.setEditEventSink((e) => feed.push(e.label))
    expect(keepProjectVersion(store, ID)).toBe(true)
    expect(sent).toEqual([`${ID}:mine`])
    expect(store.updateFromApp([ID])).toEqual([ID])
    expect(sent).toEqual([`${ID}:mine`, `${ID}:v2`])
    expect(feed).toEqual(["Kept this project's “Built-in”", "Updated “Built-in” to the app's version"])
  })

  it('keeps the record through the project folder (manifest.json and back)', () => {
    const store = project()
    const copy = store.getState().userPackages.find((p) => p.id === ID)!
    const back = buildPackage(manifestOfPackage(copy), copy.behavior)
    expect(back.origin?.app).toBe(copy.origin?.app)
  })
})
