import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeBinding, activeKeymap, DEFAULT_KEYMAP, isRebound, resolveKeyAction, setKeymapOverrides } from '../core/keymap'
import { applyStoredKeymapChange, KEYMAP_KEY, readStoredKeymap, rebindAction, resetAction, resetAllActions, sanitizeOverrides, saveStoredKeymap } from './keymapPrefs'

/** a real-enough localStorage: these helpers read-modify-write one key (cf. storeViewport.test.ts) */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

// The keymap is process-wide module state (that is the point - three layers of listeners read it),
// so every test here resets it, the way the partRegistry tests clear packages.
beforeEach(() => {
  setKeymapOverrides(null)
  vi.stubGlobal('localStorage', fakeStorage())
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setKeymapOverrides(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const press = (code: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  code,
  key: code.replace(/^Key/, '').toLowerCase(),
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe('sanitizeOverrides', () => {
  it('keeps a well-formed rebinding', () => {
    expect(sanitizeOverrides({ 'tool.move': ['KeyJ'] })).toEqual({ 'tool.move': ['KeyJ'] })
  })

  it('drops an action this build no longer has', () => {
    expect(sanitizeOverrides({ 'tool.doesNotExist': ['KeyJ'] })).toEqual({})
  })

  it('refuses to rebind a fixed action', () => {
    expect(sanitizeOverrides({ 'ui.cancel': ['KeyJ'] })).toEqual({})
  })

  it('drops malformed chords rather than storing something no parser accepts', () => {
    expect(sanitizeOverrides({ 'tool.move': [] })).toEqual({})
    expect(sanitizeOverrides({ 'tool.move': ['ctrl+'] })).toEqual({})
    expect(sanitizeOverrides({ 'tool.move': [42] })).toEqual({})
    expect(sanitizeOverrides({ 'tool.move': 'KeyJ' })).toEqual({})
  })

  it('drops a stored chord that now collides with a default in the same mode', () => {
    // KeyE is the Rotate tool by default; a stored Move-on-E is from a build where it was free
    expect(sanitizeOverrides({ 'tool.move': ['KeyE'] })).toEqual({})
  })

  it('allows a chord that collides only across modes - W is Move and fly-forward by design', () => {
    // KeyS is fly.back, but that is `fly` mode and the two are never live at once
    expect(sanitizeOverrides({ 'tool.move': ['KeyS'] })).toEqual({ 'tool.move': ['KeyS'] })
    // KeyQ is the Transform tool in `editor` and fly.down in `fly`; `pilot` has it free
    expect(sanitizeOverrides({ 'pilot.forward': ['KeyQ'] })).toEqual({ 'pilot.forward': ['KeyQ'] })
  })

  it('resolves two stored rows that fight each other deterministically, by table order', () => {
    const a = sanitizeOverrides({ 'tool.move': ['KeyJ'], 'tool.rotate': ['KeyJ'] })
    const b = sanitizeOverrides({ 'tool.rotate': ['KeyJ'], 'tool.move': ['KeyJ'] })
    expect(a).toEqual(b)
    expect(Object.keys(a)).toEqual(['tool.move'])
  })

  it('survives junk instead of a map', () => {
    expect(sanitizeOverrides(null)).toEqual({})
    expect(sanitizeOverrides('nope')).toEqual({})
    expect(sanitizeOverrides(7)).toEqual({})
  })
})

describe('readStoredKeymap', () => {
  it('returns an empty map when nothing is stored', () => {
    expect(readStoredKeymap()).toEqual({})
  })

  it('survives unparseable JSON', () => {
    localStorage.setItem(KEYMAP_KEY, '{not json')
    expect(readStoredKeymap()).toEqual({})
  })

  it('round-trips through save', () => {
    saveStoredKeymap({ 'tool.move': ['KeyJ'] })
    expect(readStoredKeymap()).toEqual({ 'tool.move': ['KeyJ'] })
  })

  it('clears the key rather than storing an empty map', () => {
    saveStoredKeymap({ 'tool.move': ['KeyJ'] })
    saveStoredKeymap({})
    expect(localStorage.getItem(KEYMAP_KEY)).toBeNull()
  })
})

describe('rebindAction', () => {
  it('moves the action onto the new chord, live', () => {
    expect(resolveKeyAction(press('KeyJ'), 'editor')).toBeNull()
    expect(rebindAction('tool.move', ['KeyJ'])).toBeNull()
    expect(resolveKeyAction(press('KeyJ'), 'editor')).toBe('tool.move')
  })

  it('frees the old chord', () => {
    rebindAction('tool.move', ['KeyJ'])
    expect(resolveKeyAction(press('KeyW'), 'editor')).toBeNull()
  })

  it('refuses a chord already taken in the same mode, naming the holder', () => {
    expect(rebindAction('tool.move', ['KeyE'])).toBe('tool.rotate')
    // and nothing moved
    expect(resolveKeyAction(press('KeyW'), 'editor')).toBe('tool.move')
    expect(resolveKeyAction(press('KeyE'), 'editor')).toBe('tool.rotate')
  })

  it('refuses a fixed action', () => {
    expect(rebindAction('ui.cancel', ['KeyJ'])).toBe('ui.cancel')
    expect(activeKeymap()).toBe(DEFAULT_KEYMAP)
  })

  it('persists, so the binding survives a reload', () => {
    rebindAction('tool.move', ['ctrl+KeyM'])
    expect(readStoredKeymap()).toEqual({ 'tool.move': ['ctrl+KeyM'] })
  })

  it('keeps modifiers exact, so a modified rebind coexists with the plain key', () => {
    // KeyM is the Measure tool. Ctrl+M is a different chord, not a collision, which is exactly
    // what keeps G and Shift+G distinct in the default table.
    expect(rebindAction('tool.move', ['ctrl+KeyM'])).toBeNull()
    expect(resolveKeyAction(press('KeyM'), 'editor')).toBe('tool.ruler')
    expect(resolveKeyAction(press('KeyM', { ctrlKey: true }), 'editor')).toBe('tool.move')
  })

  it('accumulates across several rebinds', () => {
    rebindAction('tool.move', ['KeyJ'])
    rebindAction('tool.rotate', ['KeyK'])
    expect(readStoredKeymap()).toEqual({ 'tool.move': ['KeyJ'], 'tool.rotate': ['KeyK'] })
    expect(resolveKeyAction(press('KeyJ'), 'editor')).toBe('tool.move')
    expect(resolveKeyAction(press('KeyK'), 'editor')).toBe('tool.rotate')
  })
})

describe('reset', () => {
  it('puts one action back and leaves the others rebound', () => {
    rebindAction('tool.move', ['KeyJ'])
    rebindAction('tool.rotate', ['KeyK'])
    resetAction('tool.move')
    expect(isRebound('tool.move')).toBe(false)
    expect(isRebound('tool.rotate')).toBe(true)
    expect(resolveKeyAction(press('KeyW'), 'editor')).toBe('tool.move')
    expect(readStoredKeymap()).toEqual({ 'tool.rotate': ['KeyK'] })
  })

  it('restores the default table identity when the last override goes', () => {
    rebindAction('tool.move', ['KeyJ'])
    expect(activeKeymap()).not.toBe(DEFAULT_KEYMAP)
    resetAction('tool.move')
    expect(activeKeymap()).toBe(DEFAULT_KEYMAP)
  })

  it('resetAllActions clears everything, live and stored', () => {
    rebindAction('tool.move', ['KeyJ'])
    rebindAction('tool.rotate', ['KeyK'])
    resetAllActions()
    expect(activeKeymap()).toBe(DEFAULT_KEYMAP)
    expect(localStorage.getItem(KEYMAP_KEY)).toBeNull()
    expect(resolveKeyAction(press('KeyW'), 'editor')).toBe('tool.move')
  })
})

describe('what the rest of the app sees', () => {
  it('activeBinding reports the rebound chord, so menus and the palette print it', () => {
    rebindAction('edit.duplicate', ['ctrl+KeyM'])
    expect(activeBinding('edit.duplicate')?.keys).toEqual(['ctrl+KeyM'])
  })

  it('a rebind never mutates DEFAULT_KEYMAP', () => {
    const before = DEFAULT_KEYMAP.find((b) => b.id === 'tool.move')?.keys
    rebindAction('tool.move', ['KeyJ'])
    expect(DEFAULT_KEYMAP.find((b) => b.id === 'tool.move')?.keys).toBe(before)
    expect(before).toEqual(['KeyW'])
  })
})

// Two windows share one stored map (browser tabs; the desktop app's window per project). "This window" is the
// module state here; "the other window" is simulated by writing storage behind its back, the way a real one does.
describe('several windows', () => {
  const other = (map: Record<string, string[]>) => localStorage.setItem(KEYMAP_KEY, JSON.stringify(map))
  const stored = () => JSON.parse(localStorage.getItem(KEYMAP_KEY) ?? '{}') as Record<string, string[]>

  it("a rebind here keeps a rebind the other window made after this one loaded", () => {
    other({ 'tool.move': ['KeyJ'] }) // this window's table is still the default
    expect(rebindAction('tool.rotate', ['KeyK'])).toBeNull()
    expect(stored()).toEqual({ 'tool.move': ['KeyJ'], 'tool.rotate': ['KeyK'] })
    // and this window now runs the other's rebind too
    expect(resolveKeyAction(press('KeyJ'), 'editor')).toBe('tool.move')
  })

  it("a reset here keeps the other window's rebinds", () => {
    rebindAction('tool.rotate', ['KeyK'])
    other({ 'tool.move': ['KeyJ'], 'tool.rotate': ['KeyK'] })
    resetAction('tool.rotate')
    expect(stored()).toEqual({ 'tool.move': ['KeyJ'] })
  })

  it("a rebind checks clashes against the other window's chords", () => {
    other({ 'tool.move': ['KeyJ'] })
    expect(rebindAction('tool.rotate', ['KeyJ'])).toBe('tool.move')
  })

  it('follows a change the other window stores', () => {
    other({ 'tool.move': ['KeyJ'] })
    applyStoredKeymapChange(KEYMAP_KEY)
    expect(activeBinding('tool.move')?.keys).toEqual(['KeyJ'])
    // a different key is not ours to follow
    other({})
    applyStoredKeymapChange('oip-web/something-else')
    expect(activeBinding('tool.move')?.keys).toEqual(['KeyJ'])
    // storage cleared (key null), or the other window restored all defaults
    applyStoredKeymapChange(null)
    expect(activeKeymap()).toBe(DEFAULT_KEYMAP)
  })
})
