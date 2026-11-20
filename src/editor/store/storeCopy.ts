// Copying parts: duplicate and copy / paste, through one clone path that
// gives fresh ids and names, rewires internal links, and hands cargo minted mid-run to the run. Extracted from
// store.ts verbatim; the EditorStore methods of the same names delegate here, passing the live-cargo seam.
import { isCargoPart } from '../../core/frame'
import { subtreeIds } from '../../core/scene/hierarchy'
import { uniqueName } from '../../core/parts/partDisplayName'
import { definitionsUsedBy } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { builtInPackage, getPackage, hasPackage, registerPackage } from '../../core/parts/partRegistry'
import { idAllocator } from '../../core/scene/scene'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { EditorStore } from './store'
import { clonePart, readClipboard, remapPartRefsInPlace, samePosition, writeClipboard } from './storeClipboard'
import type { LiveCargoHost } from './storeDocument'

const PASTE_NUDGE = 0.5

export function duplicateSelectionDetached(store: EditorStore, host: LiveCargoHost | null): { scene: SceneJSON; selectionIds: string[] } | null {
  const { scene, selectedIds } = store.getState()
  // duplicate each selected part with its subtree; clones of selected roots stay
  // attached under the same parent (siblings of the originals), internal links remapped
  const ids = subtreeIds(scene.parts, selectedIds)
  if (ids.length === 0) return null
  const source = copySourceParts(store, host, ids)
  const clones = cloneWithFreshIds(store, host, source, { keepExternalParent: true })
  // clones[i] mirrors source[i]; keep only those whose original was a selected root
  const selSet = new Set(selectedIds)
  const selectionIds = clones.filter((_, i) => selSet.has(source[i]!.id)).map((c) => c.id)
  return { scene: { ...scene, parts: [...scene.parts, ...clones] }, selectionIds }
}

export function copySelection(store: EditorStore, host: LiveCargoHost | null): void {
  // copy each selected part with its subtree (parent links travel along, to be
  // remapped on paste); a copied parent therefore pastes with its children
  const { scene, selectedIds } = store.getState()
  const ids = subtreeIds(scene.parts, selectedIds)
  if (ids.length === 0) return
  const parts = copySourceParts(store, host, ids).map(clonePart)
  writeClipboard({ parts, packages: definitionsOf(parts) })
}

/**
 * The definitions `parts` use, and what those name (products, a unit load's pieces, held cargo), leaving out the
 * app's built-ins, which every project has. The clipboard outlives the project it was copied from, so a part from
 * this project's own library would otherwise paste into another project as a part nothing defines.
 */
function definitionsOf(parts: readonly PartInstance[]): PartPackage[] {
  return definitionsUsedBy(parts, getPackage).filter((pkg) => !builtInPackage(pkg.id))
}

/**
 * The parts behind `ids`, with any running cargo rebased onto its live body pose. Physics owns a
 * running box's body, so its authored transform is a stale spawn pose: copying it verbatim would put the
 * copy where the box was authored, not where it is. The drag path handles the same case for grabs
 * (controller/drag.ts `dragStartScene`). One seam for every "copy this part" gesture: duplicate
 * (Ctrl+D, tree menu, Shift+drag) and copy/cut. Full YXZ rotation, so a tumbled box copies tumbled.
 */
export function copySourceParts(store: EditorStore, host: LiveCargoHost | null, ids: readonly string[]): PartInstance[] {
  const byId = new Map(store.getState().scene.parts.map((p) => [p.id, p]))
  return ids.map((id) => {
    const p = byId.get(id)!
    const live = host?.pose(id)
    return live
      ? ({ ...p, position: [...live.position], rotationX: live.rotationX, rotationY: live.rotationY, rotationZ: live.rotationZ } as PartInstance)
      : p
  })
}

export function paste(store: EditorStore, host: LiveCargoHost | null): void {
  const content = readClipboard()
  if (!content || content.parts.length === 0 || store.getState().readOnly) return
  const source = content.parts
  // A definition this project lacks comes along with the part. One it has, by id, it keeps: a paste never replaces a
  // part the project already uses. In a room, the bridge hands what is registered here to the room (syncReferencedPackages).
  const brought = content.packages.filter((pkg) => !hasPackage(pkg.id))
  for (const pkg of brought) registerPackage(pkg)
  const scene = store.getState().scene
  // walk the nudge forward until the destination is free, so repeated
  // pastes stack diagonally instead of coinciding
  let shift = 0
  for (let i = 0; i < 64; i++) {
    const occupied = source.some((c) =>
      scene.parts.some((p) =>
        samePosition(p.position, [c.position[0] + shift, c.position[1], c.position[2] + shift]),
      ),
    )
    if (!occupied) break
    shift += PASTE_NUDGE
  }
  const moved = source.map((c) => {
    const clone = clonePart(c)
    clone.position[0] += shift
    clone.position[2] += shift
    return clone
  })
  const clones = cloneWithFreshIds(store, host, moved)
  // the clipboard outlives the project it was copied from, so a pasted part can name a package this scene doesn't
  // carry yet: embed it, as placement does (a scene is self-contained for the sim worker, a room and a scene file).
  // What came along is embedded too, products included: saving moves a scene copy into the library (keepDefinitionsOnce).
  let packages = scene.packages
  const embed = (pkg: PartPackage | undefined): void => {
    if (pkg && !(packages ?? []).some((p) => p.id === pkg.id)) packages = [...(packages ?? []), pkg]
  }
  for (const c of clones) if (c.type === 'part') embed(getPackage(c.packageId))
  for (const pkg of brought) embed(pkg)
  store.commit(clones.length > 1 ? 'Paste parts' : 'Paste part', {
    ...scene,
    parts: [...scene.parts, ...clones],
    ...(packages ? { packages } : {}),
  })
  store.setState({ selectedIds: clones.map((p) => p.id) })
}

/**
 * Clone parts with fresh ids, remapping parent links. A clone whose original
 * parent is also in `source` re-points at that parent's clone (the subtree stays
 * internally linked). For a clone whose parent is outside `source`: keep it
 * (`keepExternalParent`, so a duplicate becomes a sibling of the original) or
 * drop it to a root (paste, which shouldn't dangle onto an un-pasted parent).
 */
export function cloneWithFreshIds(store: EditorStore, host: LiveCargoHost | null, source: readonly PartInstance[], opts?: { keepExternalParent?: boolean }): PartInstance[] {
  const scene = store.getState().scene
  // allocator, not nextId-per-clone: nextId rescans the scene per call, which needed the scene
  // rebuilt after every clone just to make each fresh id visible - O(parts) per clone. The
  // allocator mints the identical id sequence from one scan per prefix.
  const allocId = idAllocator(scene)
  const idMap = new Map<string, string>()
  const clones: PartInstance[] = []
  // a clone with an explicit custom name gets a bumped one ("Belt" -> "Belt 2"), mirroring the
  // fresh id, so duplicates/pastes don't stack identical labels. Unnamed parts keep falling back
  // to their fresh id. Seed `usedNames` with the live scene so we never collide with an existing name.
  const usedNames = new Set<string>()
  for (const p of scene.parts) if (p.name !== undefined && p.name !== '') usedNames.add(p.name)
  for (const part of source) {
    const clone = clonePart(part)
    clone.id = allocId(part.type)
    if (clone.name !== undefined && clone.name !== '') {
      clone.name = uniqueName(usedNames, clone.name)
      usedNames.add(clone.name)
    }
    idMap.set(part.id, clone.id)
    clones.push(clone)
  }
  const keep = opts?.keepExternalParent ?? false
  for (const clone of clones) {
    const mapped = clone.parent !== undefined ? idMap.get(clone.parent) : undefined
    if (mapped !== undefined) clone.parent = mapped
    else if (!keep) delete clone.parent
    // rewire internal partRefs (spawner->conveyor, interlocks) onto the cloned set; external refs survive
    remapPartRefsInPlace(clone, idMap)
  }
  // cargo minted while the sim runs (duplicate / paste) is live sim content, not
  // authored design - hand it to the controller as run-scoped so Stop drops it, exactly like cargo
  // dropped onto a running line (placePart). Equipment cloned mid-run is a real edit and persists.
  if (store.getState().running) {
    const cargo = clones.filter((c) => isCargoPart(c)).map((c) => c.id)
    if (cargo.length > 0) host?.runScoped(cargo)
  }
  return clones
}
