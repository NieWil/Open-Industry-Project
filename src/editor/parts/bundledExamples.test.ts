import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPackages, getPackage, onPackagesChanged } from '../../core/parts/partRegistry'
import { createSdkPart } from '../../core/scene/scene'
import { SCENE_VERSION } from '../../core/types'
import type { PackageManifest } from '../../sim/buildPackage'
import { loadBundledExamples } from './bundledExamples'
import type { BundledPartData } from './bundledExamples'
import { loadStoredProject } from '../project/projectFile'
import { EditorStore } from '../store/store'
import { builtInsUpdated } from '../store/storePackages'

// The dev-HMR sweep: a save of one committed part file re-runs loadBundledExamples over the whole catalog
// (bundledExamples.ts import.meta.hot). The registry's content diff must confine the reload fan-out
// (onPackagesChanged → view.refreshPackage + reloadSimPackage) to the part that actually changed. A
// whole-catalog burst mid-run would rebuild every placed part and reset all behavior state. Also covers
// the broken-part path: a build failure surfaces on the same status toast/badge as the desktop watcher.

const behavior = (speed: number): string => `
definePart({
  params: { speed: { type: 'number', default: ${speed} } },
  geometry(g) { return g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], g.fillet([[0, 0, 0], [1, 0, 0]], 0.28)) },
  step() {},
})
`
const manifest = (id: string): PackageManifest =>
  ({ id, name: id, geometry: { kind: 'drawn', conveys: true, bounds: { length: 1, width: 1, top: 0.3 } } }) as unknown as PackageManifest
const data = (id: string, dir: string, src: string): BundledPartData => ({ dir, manifest: manifest(id), behavior: src })

describe('loadBundledExamples (HMR sweep is change-confined; failures surface)', () => {
  beforeEach(clearPackages)
  afterEach(() => vi.restoreAllMocks())

  it('re-running with unchanged data notifies nothing; a one-part edit notifies exactly that part', () => {
    const store = new EditorStore()
    const catalog = (speedA: number) => () => [data('p.a', 'a', behavior(speedA)), data('p.b', 'b', behavior(1))]
    loadBundledExamples(store, catalog(1))

    const events: string[] = []
    const off = onPackagesChanged((id) => events.push(id))
    loadBundledExamples(store, catalog(1)) // the HMR sweep with nothing actually changed
    expect(events).toEqual([])

    loadBundledExamples(store, catalog(2)) // one part's behavior edited
    expect(events).toEqual(['p.a'])
    off()
  })

  it('a broken part raises a build-status toast/badge, keeps its last-good registration, and blocks nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new EditorStore()
    loadBundledExamples(store, () => [data('p.a', 'a', behavior(1)), data('p.b', 'b', behavior(1))])
    expect(store.getState().packageBuildErrors['p.a']).toBeUndefined()

    // the author saves a broken edit: p.a fails, p.b keeps loading, the registry keeps p.a's last-good build
    loadBundledExamples(store, () => [data('p.a', 'a', 'definePart({ oops'), data('p.b', 'b', behavior(1))])
    expect(store.getState().packageBuildErrors['p.a']).toBeTruthy()
    expect(store.getState().partBuildNotices.some((n) => n.id === 'p.a')).toBe(true)
    expect(getPackage('p.a')).toBeDefined()
    expect(store.getState().bundledPackages.map((p) => p.id)).toEqual(['p.b'])

    // fixing the file clears the badge
    loadBundledExamples(store, () => [data('p.a', 'a', behavior(1)), data('p.b', 'b', behavior(1))])
    expect(store.getState().packageBuildErrors['p.a']).toBeUndefined()
  })
})

// Placing a bundled part copies its snapshot into the project's stored parts, stamped as a built-in.
// On the next boot the project runs that copy, and the app reports its own newer version instead of
// replacing it. This guards against a placed part staying frozen at its placement-day content through
// every reload with nothing saying a newer one exists. It walks the real persist → boot loop.
describe('placing a built-in makes it the project\'s own copy, which a newer app never replaces by itself', () => {
  beforeEach(() => {
    clearPackages()
    const m = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('after reload the project runs its own copy, and the app says it has a newer one', () => {
    const catalog = (speed: number) => () => [data('p.a', 'a', behavior(speed))]

    // session 1: load the catalog, place p.a (embedding its snapshot, as the controller does), autosave
    const s1 = new EditorStore()
    loadBundledExamples(s1, catalog(1))
    const placed = getPackage('p.a')!
    s1.commit('Place part', {
      version: SCENE_VERSION,
      parts: [createSdkPart(placed, 'cp_1', [0, 0, 0])],
      packages: [placed],
    })

    // session 2: the committed part file was edited (speed 2); boot exactly like main.tsx + App
    clearPackages()
    const s2 = new EditorStore()
    const loaded = loadStoredProject()
    expect(loaded).not.toBeNull()
    s2.loadProject(loaded!.project)
    loadBundledExamples(s2, catalog(2))

    // the project's copy (the version it was placed at) is what runs; the app's newer one is offered, not imposed
    expect(getPackage('p.a')!.behavior).toContain('default: 1')
    expect(s2.getState().userPackages.map((p) => p.id)).toEqual(['p.a'])
    expect(s2.getState().userPackages[0]!.origin?.app).toBeTruthy()
    expect([...builtInsUpdated(s2.getState())]).toEqual(['p.a'])
    expect(s2.getState().scene.parts.map((p) => p.id)).toEqual(['cp_1'])
  })
})
