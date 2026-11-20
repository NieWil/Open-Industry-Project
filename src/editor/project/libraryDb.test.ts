// Which document a tab has open. Each tab keeps its own pointer in sessionStorage, so a switch in one tab never
// moves another. The stamps that keep two tabs on one document from erasing each other are real-browser behaviour,
// gated by e2e/verify-project-cross-tab.mjs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_DOC_KEY, currentDocumentId, documentsOpenInTabs, forgetCurrentDocument, pinTabDocument, setCurrentDocumentId } from './libraryDb'

/** in-memory Storage (the Node test env has none) */
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

/** a stand-in for navigator.locks: shared locks held until their callback's promise settles */
function fakeLocks() {
  const held = new Map<string, number>()
  return {
    held,
    request: (name: string, _opts: unknown, cb: () => Promise<void>) => {
      held.set(name, (held.get(name) ?? 0) + 1)
      return cb().then(() => {
        const n = (held.get(name) ?? 1) - 1
        if (n === 0) held.delete(name)
        else held.set(name, n)
      })
    },
    query: () => Promise.resolve({ held: [...held.keys()].map((name) => ({ name, mode: 'shared' })) }),
  }
}

describe('the tab pointer', () => {
  let browser: Storage
  let tab: Storage

  beforeEach(() => {
    browser = fakeStorage()
    tab = fakeStorage()
    vi.stubGlobal('localStorage', browser)
    vi.stubGlobal('sessionStorage', tab)
    vi.stubGlobal('navigator', {}) // Node has Web Locks of its own; these tests are about the pointer only
  })
  afterEach(() => {
    forgetCurrentDocument()
    vi.unstubAllGlobals()
  })

  it('a new tab starts on the document opened last', () => {
    browser.setItem(CURRENT_DOC_KEY, 'doc-last')
    pinTabDocument()
    expect(currentDocumentId()).toBe('doc-last')
    expect(tab.getItem(CURRENT_DOC_KEY)).toBe('doc-last')
  })

  it('once pinned, another tab opening a document does not move it', () => {
    browser.setItem(CURRENT_DOC_KEY, 'doc-a')
    pinTabDocument()
    browser.setItem(CURRENT_DOC_KEY, 'doc-b') // the other tab's switch
    expect(currentDocumentId()).toBe('doc-a')
  })

  it("a switch sets the tab's pointer and the browser's", () => {
    pinTabDocument()
    setCurrentDocumentId('doc-next')
    expect(tab.getItem(CURRENT_DOC_KEY)).toBe('doc-next')
    expect(browser.getItem(CURRENT_DOC_KEY)).toBe('doc-next')
  })

  it("a tab with no document does not take the browser's after it pinned", () => {
    pinTabDocument()
    expect(currentDocumentId()).toBeNull()
    browser.setItem(CURRENT_DOC_KEY, 'doc-other-tab')
    expect(currentDocumentId()).toBeNull()
  })

  it("forgetting leaves the browser's pointer when it names another tab's document", () => {
    browser.setItem(CURRENT_DOC_KEY, 'doc-a')
    pinTabDocument()
    browser.setItem(CURRENT_DOC_KEY, 'doc-b')
    forgetCurrentDocument()
    expect(currentDocumentId()).toBeNull()
    expect(browser.getItem(CURRENT_DOC_KEY)).toBe('doc-b')
  })

  it("forgetting the document opened last clears the browser's pointer too", () => {
    setCurrentDocumentId('doc-a')
    forgetCurrentDocument()
    expect(browser.getItem(CURRENT_DOC_KEY)).toBeNull()
  })

  it('a desktop window opened on a document starts on that one (?doc=)', () => {
    browser.setItem(CURRENT_DOC_KEY, 'doc-last')
    vi.stubGlobal('location', { href: 'http://x/app/?doc=doc-asked' })
    pinTabDocument()
    expect(currentDocumentId()).toBe('doc-asked')
    expect(browser.getItem(CURRENT_DOC_KEY)).toBe('doc-asked')
  })

  it('a reload keeps the tab on its own document, whatever ?doc= says', () => {
    tab.setItem(CURRENT_DOC_KEY, 'doc-switched-to')
    vi.stubGlobal('location', { href: 'http://x/app/?doc=doc-opened-on' })
    pinTabDocument()
    expect(currentDocumentId()).toBe('doc-switched-to')
  })

  it('ignores a ?doc= that is not a document id', () => {
    browser.setItem(CURRENT_DOC_KEY, 'doc-last')
    vi.stubGlobal('location', { href: 'http://x/app/?doc=../../etc' })
    pinTabDocument()
    expect(currentDocumentId()).toBe('doc-last')
  })

  it('with no sessionStorage, the browser pointer is the only one', () => {
    vi.stubGlobal('sessionStorage', undefined)
    browser.setItem(CURRENT_DOC_KEY, 'doc-a')
    pinTabDocument()
    browser.setItem(CURRENT_DOC_KEY, 'doc-b')
    expect(currentDocumentId()).toBe('doc-b')
  })
})

describe('documents open in tabs', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage())
    vi.stubGlobal('sessionStorage', fakeStorage())
  })
  afterEach(() => {
    forgetCurrentDocument() // release the lock this module holds, so the next test starts with none
    vi.unstubAllGlobals()
  })

  it('names the document this tab holds, and moves with a switch', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    setCurrentDocumentId('doc-a')
    expect(await documentsOpenInTabs()).toEqual(new Set(['doc-a']))
    setCurrentDocumentId('doc-b')
    await Promise.resolve() // the released lock's callback settles
    await Promise.resolve()
    expect(await documentsOpenInTabs()).toEqual(new Set(['doc-b']))
  })

  it('is unknowable without Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    setCurrentDocumentId('doc-a')
    expect(await documentsOpenInTabs()).toBeNull()
  })
})
