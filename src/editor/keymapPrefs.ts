/**
 * The localStorage half of the rebinding seam: core/keymap.ts owns what the bindings are, this owns
 * what they were last time. Split because core is DOM-free, the same way editor/program/stProgram.ts holds
 * the program document's storage half.
 *
 * Validated on read, not trusted. A stored map outlives the build that wrote it, so an action that
 * has since been renamed or deleted, a `fixed` binding someone hand-edited in, an empty chord list,
 * or a chord that now collides with a new default all have to be survivable - and the failure has to
 * be "that one row falls back to its default", never "the keyboard is dead". Anything that does not
 * pass is dropped with a console warning rather than kept.
 */
import {
  activeKeymap,
  chordConflict,
  DEFAULT_KEYMAP,
  resolveKeymap,
  setKeymapOverrides,
  type KeymapOverrides,
} from '../core/keymap'

export const KEYMAP_KEY = 'oip-web/keymap'

/** a chord token this build can still resolve - the shape `parseChord` expects */
const CHORD_RE = /^(ctrl\+|alt\+|shift\+|meta\+)*[A-Za-z0-9]+$/

/**
 * Drop everything unusable from a candidate override map. Order matters: unknown/fixed actions go
 * first, then malformed chords, then collisions - checked against the map built so far plus the
 * defaults, so two stored rows that fight each other resolve deterministically (first wins by the
 * table's order) instead of by object-key order.
 */
export function sanitizeOverrides(raw: unknown): KeymapOverrides {
  const out: Record<string, readonly string[]> = {}
  if (typeof raw !== 'object' || raw === null) return out
  const byId = new Map(DEFAULT_KEYMAP.map((b) => [b.id, b]))
  const warn = (why: string): void => console.warn(`[oip] dropping stored keybinding: ${why}`)
  // walk in table order, not object order, so the result does not depend on how the JSON was written
  for (const binding of DEFAULT_KEYMAP) {
    const chords = (raw as Record<string, unknown>)[binding.id]
    if (chords === undefined) continue
    if (binding.fixed) {
      warn(`${binding.id} is fixed and cannot be rebound`)
      continue
    }
    if (!Array.isArray(chords) || chords.length === 0 || !chords.every((c) => typeof c === 'string' && CHORD_RE.test(c))) {
      warn(`${binding.id} has no usable chords`)
      continue
    }
    // resolve against defaults + what has been accepted so far
    const soFar = resolveKeymap({ ...out, [binding.id]: chords })
    const clash = chords.map((c) => chordConflict(soFar, binding.id, c)).find((x) => x !== null)
    if (clash) {
      warn(`${binding.id} collides with ${clash}`)
      continue
    }
    out[binding.id] = chords
  }
  // an id in the blob that this build no longer has
  for (const id of Object.keys(raw as Record<string, unknown>)) {
    if (!byId.has(id)) warn(`${id} is not an action in this build`)
  }
  return out
}

/** Read + sanitize the stored map. Never throws; returns `{}` when there is nothing usable. */
export function readStoredKeymap(): KeymapOverrides {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEYMAP_KEY)
    return raw ? sanitizeOverrides(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

/** Persist a map (or clear the key when it is empty). Storage failures are non-fatal by design:
 *  the binding is already live in core, and losing it on reload is better than refusing the rebind. */
export function saveStoredKeymap(overrides: KeymapOverrides): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(KEYMAP_KEY)
    else localStorage.setItem(KEYMAP_KEY, JSON.stringify(overrides))
  } catch (err) {
    console.warn('[oip] could not save keybindings', err)
  }
}

/** Boot: install what was stored, and follow later changes made in other windows. Called once from
 *  main.tsx, before anything listens for a key. */
export function initKeymapPrefs(): void {
  const stored = readStoredKeymap()
  if (Object.keys(stored).length > 0) setKeymapOverrides(stored)
  // a `storage` event fires in every other same-origin window (browser tabs, and the desktop app's
  // one-window-per-project) when one of them writes, never in the writer itself
  if (typeof window !== 'undefined') window.addEventListener('storage', (e) => applyStoredKeymapChange(e.key))
}

/** Another window changed the stored keymap (or cleared storage: `key` null): install what it holds now. */
export function applyStoredKeymapChange(key: string | null): void {
  if (key !== null && key !== KEYMAP_KEY) return
  setKeymapOverrides(readStoredKeymap())
}

/**
 * Rebind one action, live + persisted. Returns the colliding action id when it refuses, else null.
 * The single write path: the panel never touches core or localStorage itself.
 */
export function rebindAction(id: string, chords: readonly string[]): string | null {
  const binding = DEFAULT_KEYMAP.find((b) => b.id === id)
  if (!binding || binding.fixed) return id
  const next: Record<string, readonly string[]> = { ...baseOverrides(), [id]: chords }
  const clash = chords.map((c) => chordConflict(resolveKeymap(next), id, c)).find((x) => x !== null)
  if (clash) return clash
  commit(next)
  return null
}

/** Put one action back on its default chords. */
export function resetAction(id: string): void {
  const next = baseOverrides()
  delete next[id]
  commit(next)
}

/** Put every action back on its default chords. */
export function resetAllActions(): void {
  commit({})
}

/**
 * The map a rebind or reset edits: what storage holds now, not this window's table. Every write
 * stores the whole map, so starting from this window's table erased a rebind made in another window
 * since this one loaded. Without storage, the live table is all there is.
 */
function baseOverrides(): Record<string, readonly string[]> {
  if (typeof localStorage === 'undefined') return { ...(currentOverrides() ?? {}) }
  return { ...readStoredKeymap() }
}

/** The live override map as a mutable copy, or null when nothing is overridden. */
function currentOverrides(): Record<string, readonly string[]> | null {
  // read back off the active table rather than keeping a second copy here: core is the record
  const active = activeKeymap()
  if (active === DEFAULT_KEYMAP) return null
  const out: Record<string, readonly string[]> = {}
  for (const b of active) {
    const def = DEFAULT_KEYMAP.find((d) => d.id === b.id)
    if (def && def.keys !== b.keys) out[b.id] = b.keys
  }
  return out
}

function commit(next: Record<string, readonly string[]>): void {
  setKeymapOverrides(next)
  saveStoredKeymap(next)
}
