// The PLC values a scene's displays show beside it (SceneJSON.display; editor/components/PresentOverlay.tsx): names as
// the Watch panel spells them, picked there with Show on displays. Part of the scene, so it is saved with the project,
// undone like any edit, and reaches everyone in a shared project, every display included.

/** most values a display lists: past this a projector's list is unreadable anyway */
export const MAX_DISPLAY_VALUES = 32
/** longest name kept: an ST path is far shorter, and this stops a megabyte string from another copy */
const MAX_NAME = 128

/** A saved display list read back: names only, trimmed, each once, at most MAX_DISPLAY_VALUES. Undefined when none. */
export function readDisplayList(raw: unknown, repairs?: string[]): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    repairs?.push('display is not a list of names, so displays show the scene alone')
    return undefined
  }
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const name = v.trim()
    if (name === '' || name.length > MAX_NAME || out.includes(name)) continue
    if (out.length === MAX_DISPLAY_VALUES) {
      repairs?.push(`display lists more than ${MAX_DISPLAY_VALUES} values, so the rest are dropped`)
      break
    }
    out.push(name)
  }
  return out.length > 0 ? out : undefined
}

/** the list with `name` shown or not; an equal copy when nothing changes */
export function withDisplayed(list: readonly string[] | undefined, name: string, shown: boolean): string[] | undefined {
  const cur = list ?? []
  const has = cur.includes(name)
  if (has === shown) return list === undefined ? undefined : [...cur]
  const next = shown ? [...cur, name].slice(0, MAX_DISPLAY_VALUES) : cur.filter((n) => n !== name)
  return next.length > 0 ? next : undefined
}
