import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampScanMs,
  DEFAULT_SCAN_MS,
  DEFAULT_ST_GEOMETRY,
  fitStEditorGeometry,
  MAX_SCAN_MS,
  MIN_SCAN_MS,
  readStScanMs,
  saveStScanMs,
  ST_EDITOR_MIN_H,
  ST_EDITOR_MIN_W,
} from './stProgram'

/** in-memory Storage for the persistence tests (the Node test env has no localStorage) */
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clampScanMs', () => {
  it('rounds to whole ms and clamps into [MIN, MAX]', () => {
    expect(clampScanMs(10.4)).toBe(10)
    expect(clampScanMs(0)).toBe(MIN_SCAN_MS)
    expect(clampScanMs(-5)).toBe(MIN_SCAN_MS)
    expect(clampScanMs(99999)).toBe(MAX_SCAN_MS)
  })

  it('falls back to the default for non-finite input (unparseable text -> NaN)', () => {
    expect(clampScanMs(NaN)).toBe(DEFAULT_SCAN_MS)
    expect(clampScanMs(Number('garbage'))).toBe(DEFAULT_SCAN_MS)
    // note: Number('') === 0 (not NaN), so a truly empty field is handled in the UI's
    // commitScan (reverts to the current value) rather than clamping to MIN here
  })
})

describe('scan-time persistence', () => {
  it('defaults when nothing is stored, then round-trips a saved value', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(readStScanMs()).toBe(DEFAULT_SCAN_MS)
    saveStScanMs(25)
    expect(readStScanMs()).toBe(25)
  })

  it('clamps a hand-edited / legacy stored value on read', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    localStorage.setItem('oip-web/st-scan-ms', '0') // out of range
    expect(readStScanMs()).toBe(MIN_SCAN_MS)
    localStorage.setItem('oip-web/st-scan-ms', 'garbage') // unparseable -> default
    expect(readStScanMs()).toBe(DEFAULT_SCAN_MS)
  })

  it('the default scan time is a sane, sub-frame interval', () => {
    expect(DEFAULT_SCAN_MS).toBeGreaterThanOrEqual(MIN_SCAN_MS)
    expect(DEFAULT_SCAN_MS).toBeLessThan(16) // shorter than a 60 fps frame, so >= 1 scan/frame
  })
})

describe('fitStEditorGeometry', () => {
  // the 3D view at 1366x768 with the default docks: under the toolbar, between the side docks, above the bottom dock
  const view = { x: 260, y: 40, w: 800, h: 492 }

  it('keeps the default window off the bottom dock', () => {
    const fit = fitStEditorGeometry(DEFAULT_ST_GEOMETRY, view)
    expect(fit.y + fit.h).toBeLessThanOrEqual(view.y + view.h)
    expect(fit.x).toBeGreaterThanOrEqual(view.x)
    // it moved to fit; it did not shrink, because it fits once moved
    expect([fit.w, fit.h]).toEqual([DEFAULT_ST_GEOMETRY.w, DEFAULT_ST_GEOMETRY.h])
  })

  it('slides a window back inside from every side', () => {
    const g = { x: 0, y: 0, w: 300, h: 250 }
    expect(fitStEditorGeometry({ ...g, x: -50, y: -50 }, view)).toMatchObject({ x: view.x, y: view.y })
    expect(fitStEditorGeometry({ ...g, x: 5000, y: 5000 }, view)).toMatchObject({ x: view.x + view.w - 300, y: view.y + view.h - 250 })
  })

  it('shrinks a window bigger than the view, but never below the minimum', () => {
    expect(fitStEditorGeometry({ x: 0, y: 0, w: 2000, h: 2000 }, view)).toEqual(view)
    const tiny = { x: 10, y: 20, w: 100, h: 100 }
    // the one overflow that cannot be avoided: pinned to the view's top-left at the minimum size
    expect(fitStEditorGeometry({ x: 500, y: 500, w: 400, h: 400 }, tiny)).toEqual({ x: 10, y: 20, w: ST_EDITOR_MIN_W, h: ST_EDITOR_MIN_H })
  })

  it('lets a collapsed window park its title bar at the bottom, still fitting the height it expands to', () => {
    const collapsed = fitStEditorGeometry({ x: 300, y: 5000, w: 360, h: 460 }, view, 28)
    expect(collapsed.y).toBe(view.y + view.h - 28)
    // expanding it (no shownH) pushes it back up so the whole window fits
    const open = fitStEditorGeometry(collapsed, view)
    expect(open.y + open.h).toBe(view.y + view.h)
  })

  it('returns the same object when the window already fits, so setState skips the render', () => {
    const g = { x: 300, y: 60, w: 360, h: 400 }
    expect(fitStEditorGeometry(g, view)).toBe(g)
  })
})
