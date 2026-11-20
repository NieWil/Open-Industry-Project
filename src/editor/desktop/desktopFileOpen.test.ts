import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorController } from '../controller'
import type { EditorStore } from '../store/store'

const importProjectFile = vi.fn(async () => {})
vi.mock('../project/importProjectFile', () => ({ importProjectFile }))
const { openDocumentFile } = await import('./desktopFileOpen')

const bytes = new Uint8Array([0x50, 0x4b, 3, 4])
let alerts: string[]
let notices: string[]

function fakeStore(state: Partial<{ running: boolean; collab: unknown; readOnly: boolean }> = {}): EditorStore {
  return {
    getState: () => ({ running: false, collab: null, readOnly: false, ...state }),
    showSaveNotice: (title: string) => void notices.push(title),
  } as unknown as EditorStore
}
const controller = (error: string | null = null) =>
  ({ importPart: vi.fn(async (_b: Uint8Array, confirmReplace?: (n: string) => boolean) => (confirmReplace?.('Old'), error)) }) as unknown as EditorController & {
    importPart: ReturnType<typeof vi.fn>
  }

beforeEach(() => {
  alerts = []
  notices = []
  importProjectFile.mockClear()
  vi.stubGlobal('alert', (m: string) => void alerts.push(m))
  vi.stubGlobal('confirm', () => true)
})
afterEach(() => vi.unstubAllGlobals())

describe('a project or part file opened from outside the app (desktopFileOpen.ts)', () => {
  it('a .oip goes through Import Project, with its name', async () => {
    const store = fakeStore()
    await openDocumentFile(store, null, { name: 'Line 2.oip', kind: 'project', bytes })
    expect(importProjectFile).toHaveBeenCalledWith(store, null, bytes, 'Line 2.oip')
  })

  it('a .oippart goes into the library through Import part, asking before it replaces one, and says so', async () => {
    const ctrl = controller()
    await openDocumentFile(fakeStore(), ctrl, { name: 'acme.box.oippart', kind: 'part', bytes })
    expect(ctrl.importPart).toHaveBeenCalledWith(bytes, expect.any(Function))
    expect(notices).toEqual(['Part imported'])
    expect(alerts).toEqual([])
  })

  it('reports a part that does not import, and a file the shell could not read', async () => {
    await openDocumentFile(fakeStore(), controller('invalid package: x'), { name: 'bad.oippart', kind: 'part', bytes })
    await openDocumentFile(fakeStore(), null, { error: "couldn't read gone.oip: ENOENT" })
    expect(alerts).toEqual(["Couldn't import “bad.oippart”:\ninvalid package: x", "couldn't read gone.oip: ENOENT"])
  })

  it('refuses while running or view-only, and says why, importing nothing', async () => {
    const ctrl = controller()
    for (const state of [{ running: true }, { readOnly: true }]) {
      await openDocumentFile(fakeStore(state), ctrl, { name: 'x.oip', kind: 'project', bytes })
      await openDocumentFile(fakeStore(state), ctrl, { name: 'x.oippart', kind: 'part', bytes })
    }
    expect(importProjectFile).not.toHaveBeenCalled()
    expect(ctrl.importPart).not.toHaveBeenCalled()
    expect(alerts).toHaveLength(4)
    expect(alerts[0]).toMatch(/Stop the simulation first/)
    expect(alerts[2]).toMatch(/view-only/)
  })

  it('opens a project and imports a part in a shared project too, as the app\'s own Import does', async () => {
    const ctrl = controller()
    await openDocumentFile(fakeStore({ collab: {} }), ctrl, { name: 'x.oip', kind: 'project', bytes })
    await openDocumentFile(fakeStore({ collab: {} }), ctrl, { name: 'x.oippart', kind: 'part', bytes })
    expect(importProjectFile).toHaveBeenCalledTimes(1)
    expect(ctrl.importPart).toHaveBeenCalledTimes(1)
  })
})
