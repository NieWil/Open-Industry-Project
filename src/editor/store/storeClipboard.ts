// Clipboard persistence + the small pure part-instance helpers the clipboard/paste/duplicate paths share
// (clone, position compare, internal-reference rewiring). Extracted from store.ts verbatim; the
// module-level in-memory clipboard is the fallback when localStorage is unavailable/corrupt.
import { partParamSpecs } from '../../core/packageParams'
import type { PartPackage } from '../../core/parts/partPackage'
import { validateScene } from '../../core/scene/scene'
import { PART_DEFS, SCENE_VERSION } from '../../core/types'
import type { PartInstance } from '../../core/types'

export const CLIPBOARD_KEY = 'oip-web/clipboard'

/** What a copy holds: the parts, and the definitions they use that another project may not have (copySelection) */
export interface ClipboardContent {
  parts: PartInstance[]
  packages: PartPackage[]
}

let memoryClipboard: ClipboardContent | null = null

export function clonePart(part: PartInstance): PartInstance {
  return {
    ...part,
    position: [part.position[0], part.position[1], part.position[2]],
    params: { ...part.params },
  } as PartInstance
}

export function samePosition(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/**
 * Rewrite a freshly-cloned part's internal `partRef` param values in place through `idMap` (the
 * referenced part's old id -> its copy's id). A ref whose target isn't in the map points outside the
 * copied set (an external wire - e.g. a spawner interlocked on a conveyor in another cell) and is left
 * untouched, so copying a cell rewires its *internal* references onto the copy while preserving external
 * ones. Mutates the part's own params object; callers pass a clone whose params were shallow-copied, so
 * the source is never touched. Without this, a duplicated or inserted cell keeps every internal partRef
 * (box_spawner.conveyorId, interlocks) pointing at the original part, a silent miswire.
 */
export function remapPartRefsInPlace(part: PartInstance, idMap: ReadonlyMap<string, string>): void {
  const params = part.params as Record<string, unknown>
  for (const spec of partParamSpecs(part)) {
    if (spec.kind !== 'partRef') continue
    const cur = params[spec.key]
    if (typeof cur !== 'string' || cur === '') continue
    const mapped = idMap.get(cur)
    if (mapped !== undefined) params[spec.key] = mapped
  }
}

function isClipboardPart(v: unknown): v is PartInstance {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.type === 'string' &&
    p.type in PART_DEFS &&
    Array.isArray(p.position) &&
    p.position.length === 3 &&
    p.position.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof p.rotationY === 'number' &&
    Number.isFinite(p.rotationY) &&
    (p.rotationX === undefined || (typeof p.rotationX === 'number' && Number.isFinite(p.rotationX))) &&
    (p.rotationZ === undefined || (typeof p.rotationZ === 'number' && Number.isFinite(p.rotationZ))) &&
    (p.parent === undefined || typeof p.parent === 'string') &&
    typeof p.params === 'object' &&
    p.params !== null
  )
}

/** the stored definitions, checked and upgraded the way a scene file's are; none when any fails */
function clipboardPackages(raw: unknown): PartPackage[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const res = validateScene({ version: SCENE_VERSION, parts: [], packages: raw })
  return res.ok ? (res.scene.packages ?? []) : []
}

export function readClipboard(): ClipboardContent | null {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(CLIPBOARD_KEY)
      if (raw) {
        const data = JSON.parse(raw) as { parts?: unknown; packages?: unknown }
        if (Array.isArray(data.parts)) {
          const parts = data.parts.filter(isClipboardPart)
          if (parts.length > 0) return { parts, packages: clipboardPackages(data.packages) }
        }
      }
    } catch {
      // fall through to the in-memory clipboard
    }
  }
  return memoryClipboard
}

/** replace the clipboard: the in-memory copy always, localStorage best-effort (copySelection) */
export function writeClipboard(content: ClipboardContent): void {
  memoryClipboard = content
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(content))
  } catch {
    // Over the storage quota (definitions can be large): the in-memory clipboard still works, and the stored one
    // goes, since readClipboard prefers it and would paste the copy before this one.
    try {
      localStorage.removeItem(CLIPBOARD_KEY)
    } catch {
      // storage unavailable
    }
  }
}
