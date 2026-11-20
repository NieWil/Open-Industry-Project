// What is provable without IndexedDB. In a Node test env that is everything here.
//
// Same shape as documentStore.test.ts, pinning the same property: remembering a linked folder is an
// enhancement. A browser that cannot store one (private mode, blocked storage, this test runner) must
// keep a session-only link, with no throw into a boot path and no link that fails because storing it did.
//
// The round trip itself is real-browser behaviour. It is covered two ways: projectFolderLink.test.ts
// drives remember -> recall against an in-memory double, and e2e/verify-folder-link-persist.mjs proves
// a real handle survives a real reload in a real IndexedDB.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetFolderHandle, recallFolderHandle, rememberFolderHandle, supportsHandleMemory } from './folderHandleStore'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('without IndexedDB', () => {
  it('reports no handle memory', () => {
    expect(supportsHandleMemory()).toBe(false)
  })

  it('remembers nothing, and says so by recalling nothing', async () => {
    await expect(rememberFolderHandle('doc-1', { name: 'folder' }, 'sig')).resolves.toBeUndefined()
    await expect(recallFolderHandle('doc-1')).resolves.toBeNull()
  })

  it('forgets without complaining', async () => {
    await expect(forgetFolderHandle('doc-1')).resolves.toBeUndefined()
  })
})

describe('with storage that cannot be opened', () => {
  // the shape blocked storage actually takes: indexedDB exists, so the capability probe says yes, and
  // the open is what fails
  const blocked = (): void => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('storage blocked')
      },
    })
  }

  it('still reports the capability, because the API is there', () => {
    blocked()
    expect(supportsHandleMemory()).toBe(true)
  })

  it('degrades to no memory rather than throwing into the caller', async () => {
    blocked()
    await expect(rememberFolderHandle('doc-1', { name: 'folder' }, 'sig')).resolves.toBeUndefined()
    await expect(recallFolderHandle('doc-1')).resolves.toBeNull()
    await expect(forgetFolderHandle('doc-1')).resolves.toBeUndefined()
  })

  it('survives an open that fails asynchronously', async () => {
    const requests: { onerror?: () => void }[] = []
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req: { onerror?: () => void } = {}
        requests.push(req)
        queueMicrotask(() => req.onerror?.())
        return req
      },
    })
    await expect(recallFolderHandle('doc-1')).resolves.toBeNull()
    expect(requests).toHaveLength(1)
  })
})

// A null id means this browser has no document pointer at all. Guessing would attach the folder to
// whichever document happened to open next, so every entry point declines instead, without touching
// storage. These assert both.
describe('with no document to key against', () => {
  const spyOpen = (): { open: ReturnType<typeof vi.fn> } => {
    const idb = { open: vi.fn(() => ({})) }
    vi.stubGlobal('indexedDB', idb)
    return idb
  }

  it('remembers nothing', async () => {
    const idb = spyOpen()
    await rememberFolderHandle(null, { name: 'folder' }, 'sig')
    expect(idb.open).not.toHaveBeenCalled()
  })

  it('recalls nothing', async () => {
    const idb = spyOpen()
    expect(await recallFolderHandle(null)).toBeNull()
    expect(idb.open).not.toHaveBeenCalled()
  })

  it('forgets nothing', async () => {
    const idb = spyOpen()
    await forgetFolderHandle(null)
    expect(idb.open).not.toHaveBeenCalled()
  })
})
