// Copy Properties / Paste Properties: every property of one part, pasted onto other parts of its type as one
// undo step. The single-property Copy / Paste in the Inspector's row menu (inspector/menu.tsx) is the per-field
// version; both go through coercePaste, so a pasted value is vetted exactly as typing it into the field would be.
import { partParamSpecs } from '../../core/packageParams'
import { getPackage } from '../../core/parts/partRegistry'
import { PART_DEFS } from '../../core/types'
import type { ParamSpec, ParamValue, PartInstance, SdkPart } from '../../core/types'
import { coercePaste } from '../components/inspector/paramLogic'
import type { EditorState, EditorStore } from './store'

export interface PropertyClipboard {
  /** what the parts must be to take the paste: the package for an SDK part, else the structural type */
  kind: string
  /** the copied part's type as the Inspector header names it, for the disabled Paste's reason */
  kindLabel: string
  /** the copied params, only those the source part stores: a key it leaves absent pastes as absent */
  params: Readonly<Record<string, ParamValue>>
}

/** Every SDK part is type 'part', so its package says what it is (the Inspector's mixed-type rule). */
export function partKind(p: PartInstance): string {
  return p.type === 'part' ? `part:${(p as SdkPart).packageId}` : p.type
}

function kindLabelOf(p: PartInstance): string {
  return (p.type === 'part' ? getPackage((p as SdkPart).packageId)?.name : undefined) ?? PART_DEFS[p.type].label
}

/**
 * The params Copy Properties carries. Left out: `hidden` params (engine-owned storage such as a curve's snap-set
 * `reverse`), the units switch (the scene's Units set it on every part), and tags. A tag names one device's I/O,
 * so pasting it would wire two devices to the same PLC point.
 */
export function copyableSpecs(part: PartInstance): ParamSpec[] {
  return partParamSpecs(part).filter(
    (s) => !s.hidden && !(s.kind === 'boolean' && s.imperialUnits === true) && s.kind !== 'tagRef',
  )
}

function selectedParts(state: EditorState): PartInstance[] {
  const sel = new Set(state.selectedIds)
  return state.scene.parts.filter((p) => sel.has(p.id))
}

/** the one selected part Copy Properties would read, or null */
export function propertiesSource(state: EditorState): PartInstance | null {
  const parts = selectedParts(state)
  return parts.length === 1 && copyableSpecs(parts[0]!).length > 0 ? parts[0]! : null
}

export function copyProperties(store: EditorStore): void {
  const part = propertiesSource(store.getState())
  if (!part) return
  const stored = part.params as unknown as Record<string, ParamValue>
  const params: Record<string, ParamValue> = {}
  for (const s of copyableSpecs(part)) {
    const v = stored[s.key]
    if (v !== undefined) params[s.key] = structuredClone(v)
  }
  store.setState({ propertyClipboard: { kind: partKind(part), kindLabel: kindLabelOf(part), params } })
}

/** whether every selected part takes the clipboard's properties */
export function canPasteProperties(state: EditorState): boolean {
  const clip = state.propertyClipboard
  const parts = selectedParts(state)
  return !!clip && parts.length > 0 && parts.every((p) => partKind(p) === clip.kind)
}

/**
 * `part` with the clipboard's properties. A value the part's field would refuse (a part reference to the part
 * itself) leaves that param as it was; a param the source left absent is removed, so the part reads it the
 * way the source does.
 */
export function withPastedProperties(
  part: PartInstance,
  clip: PropertyClipboard,
  allParts: readonly PartInstance[],
  targetIds: ReadonlySet<string>,
): PartInstance {
  const params: Record<string, ParamValue> = { ...(part.params as unknown as Record<string, ParamValue>) }
  for (const s of copyableSpecs(part)) {
    if (!(s.key in clip.params)) {
      delete params[s.key]
      continue
    }
    const v = coercePaste(s, clip.params[s.key], { allParts, targetIds })
    if (v !== null) params[s.key] = v
  }
  return { ...part, params } as PartInstance
}

export function pasteProperties(store: EditorStore): void {
  const state = store.getState()
  const clip = state.propertyClipboard
  if (!clip || !canPasteProperties(state)) return
  const targetIds = new Set(state.selectedIds)
  const scene = state.scene
  store.commit(targetIds.size > 1 ? `Paste Properties (${targetIds.size})` : 'Paste Properties', {
    ...scene,
    parts: scene.parts.map((p) => (targetIds.has(p.id) ? withPastedProperties(p, clip, scene.parts, targetIds) : p)),
  })
}
