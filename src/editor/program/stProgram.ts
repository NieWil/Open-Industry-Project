import { DEFAULT_SCAN_PERIOD_SEC } from '../../plc'

// The authored ST program persists alongside the scene autosave (same 'oip-web/'
// namespace as the store), so a reload restores your work instead of resetting. A
// first-ever load with no saved key starts with an empty editor - the demo program
// arrives only when you press "Load demo" (which loads its matching scene too) or
// import a scene that bundled one. Defaulting to empty keeps the editor consistent with
// the empty default scene, rather than orphaning the demo program over a building that
// has none of the parts its tags reference. Kept out of SceneJSON: the store treats a
// scene as spatial-only, and the ST program is a separate document the editor owns -
// the exported file (serializeScene) is what bundles the two.
export const ST_PROGRAM_KEY = 'oip-web/st-program'

export function readStProgram(): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    return localStorage.getItem(ST_PROGRAM_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveStProgram(source: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ST_PROGRAM_KEY, source)
  } catch {
    // best-effort persistence (quota etc.), mirroring the store's persist()
  }
}

// The program's PLC scan (cycle) time persists alongside its source - it's part of the
// authored program, like a real PLC task's interval. Stored in milliseconds (what the UI
// edits); the controller converts to the engine's seconds. Clamped on read so a hand-edited
// or legacy value can't drive a runaway scan rate.
export const ST_SCAN_MS_KEY = 'oip-web/st-scan-ms'

/** default scan time in ms, mirroring the engine's default period (single source of truth) */
export const DEFAULT_SCAN_MS = Math.round(DEFAULT_SCAN_PERIOD_SEC * 1000)
export const MIN_SCAN_MS = 1
export const MAX_SCAN_MS = 1000

/** Coerce any value to a valid whole-millisecond scan time inside [MIN, MAX]. */
export function clampScanMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_SCAN_MS
  return Math.min(MAX_SCAN_MS, Math.max(MIN_SCAN_MS, Math.round(ms)))
}

export function readStScanMs(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_SCAN_MS
  try {
    const raw = localStorage.getItem(ST_SCAN_MS_KEY)
    return raw === null ? DEFAULT_SCAN_MS : clampScanMs(Number(raw))
  } catch {
    return DEFAULT_SCAN_MS
  }
}

export function saveStScanMs(ms: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ST_SCAN_MS_KEY, String(clampScanMs(ms)))
  } catch {
    // best-effort, mirroring saveStProgram
  }
}

// The editor panel's position and size persist in the same namespace, so a reload
// restores the window you arranged (drag + resize) rather than re-centering at the
// default. The restored geometry is fitted into the 3D view (fitStEditorGeometry), so a
// value saved on a larger screen can't strand the window off-screen or over a dock.
export const ST_GEOMETRY_KEY = 'oip-web/st-editor-geometry'

export interface StEditorGeometry {
  x: number
  y: number
  w: number
  h: number
}

export const DEFAULT_ST_GEOMETRY: StEditorGeometry = { x: 232, y: 104, w: 360, h: 460 }
export const ST_EDITOR_MIN_W = 280
export const ST_EDITOR_MIN_H = 220

/**
 * Keep the floating PLC window inside `bounds`: the part of the 3D view it may use, below the view's toolbar (in
 * client pixels; StEditor's floatBounds measures it).
 *
 * The window is drawn over the page at a fixed position, so this is the only thing that keeps it off the docks.
 * Fitting it to the browser window instead lets the default window hang 32 px onto the bottom dock at 1366x768 and
 * a dragged one sit almost entirely over it.
 *
 * Size first, then position: a window bigger than the view shrinks to it (never below the minimum), then slides
 * back inside. `shownH` is the height actually drawn when that differs from `g.h`: a collapsed window is only its
 * title bar and may park as low as the title bar allows, while its stored height, the one it expands to, is still
 * fitted. A view smaller than the minimum pins the window to the view's top-left corner, the one overflow that
 * cannot be avoided.
 *
 * Returns `g` itself when nothing changes, so the result can go straight to setState without a re-render.
 */
export function fitStEditorGeometry(g: StEditorGeometry, bounds: StEditorGeometry, shownH?: number): StEditorGeometry {
  const w = Math.max(ST_EDITOR_MIN_W, Math.min(g.w, bounds.w))
  const h = Math.max(ST_EDITOR_MIN_H, Math.min(g.h, bounds.h))
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.w - w, g.x))
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.h - (shownH ?? h), g.y))
  return x === g.x && y === g.y && w === g.w && h === g.h ? g : { x, y, w, h }
}

export function readStEditorGeometry(): StEditorGeometry {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_ST_GEOMETRY }
  try {
    const raw = localStorage.getItem(ST_GEOMETRY_KEY)
    if (!raw) return { ...DEFAULT_ST_GEOMETRY }
    const g = JSON.parse(raw) as Partial<StEditorGeometry>
    // tolerate partial/legacy payloads: fall back per-field to the default
    return {
      x: typeof g.x === 'number' ? g.x : DEFAULT_ST_GEOMETRY.x,
      y: typeof g.y === 'number' ? g.y : DEFAULT_ST_GEOMETRY.y,
      w: typeof g.w === 'number' ? g.w : DEFAULT_ST_GEOMETRY.w,
      h: typeof g.h === 'number' ? g.h : DEFAULT_ST_GEOMETRY.h,
    }
  } catch {
    return { ...DEFAULT_ST_GEOMETRY }
  }
}

export function saveStEditorGeometry(geom: StEditorGeometry): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ST_GEOMETRY_KEY, JSON.stringify(geom))
  } catch {
    // best-effort, mirroring saveStProgram
  }
}
