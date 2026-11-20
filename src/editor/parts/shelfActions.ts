// What the shelf's buttons do (docs/parts-shelf.md): put a project's part on the shelf, take the shelf's newer
// version, or give this project's part a new id when the shelf has a different part under the same one. Each asks
// first where it replaces a version, with the list of what changes, then reads the shelf again.
//
// Loaded on the first shelf action (Catalog.tsx, the Part Editor's actions): the shelf is the desktop app's alone.

import { partChanges } from '../../core/parts/partChanges'
import type { PartPackage } from '../../core/parts/partPackage'
import { getPackage } from '../../core/parts/partRegistry'
import { freePartId } from '../../core/parts/partRename'
import { forShelf, shelfFingerprint } from '../../core/parts/partShelf'
import type { ShelfStatus } from '../../core/parts/partShelf'
import { renderPackageThumbnails } from '../../render/viewport/thumbnails'
import { askName } from '../nameDialog'
import { askPartChange } from '../partChangeDialog'
import { documentSceneOf } from '../store/store'
import type { EditorStore } from '../store/store'
import { copyFromShelf, getShelfApi, putOnShelf } from './partShelf'
import { refreshShelf, shelfSnapshot } from './shelfListing'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('shelfActions', {
  putConfirm: 'Put “{name}” on the shelf? Other projects can then place it, and update when it changes.',
  putTitle: 'Put “{name}” on the shelf',
  putIntro: "This replaces the shelf's version for every project that updates from it. What changes on the shelf:",
  putOnShelf: 'Put on shelf',
  updateDialogTitle: 'Update “{name}” from the shelf',
  updateIntroBoth:
    "This part has changed both in this project and on the shelf. Updating replaces this project's changes, and every placed copy changes. What changes here, including undoing this project's edits:",
  updateIntro: 'Every placed copy in this project changes. What changes here:',
  update: 'Update',
  useDialogTitle: "Use the shelf's “{name}”",
  useIntro: "The shelf keeps its own version of the app's “{name}”. This project then uses the shelf's, and every placed copy changes. What changes from the app's version:",
  use: "Use the shelf's",
  alreadyOnShelf: '“{name}” is on the shelf as it is here',
  renameTitle: "Rename this project's part",
  renameIntro: "This project's “{name}” and the shelf's are different parts with the same id. Give this project's a new id. Every placed copy moves with it.",
  rename: 'Rename',
  idTaken: 'The shelf already has a part with the id “{id}”.',
})

/**
 * The part's card image to keep beside it on the shelf, rendered now from the project's loaded part, since a project
 * that has not placed it yet cannot render it. Undefined where it cannot be rendered (no GPU).
 */
export async function cardImage(part: PartPackage): Promise<string | undefined> {
  try {
    return (await renderPackageThumbnails([getPackage(part.id) ?? part])).get(part.id)
  } catch {
    return undefined
  }
}

/** Put this project's version of a part on the shelf, asking first, and over a different shelf version with the list of what changes there. */
export async function putPartOnShelf(store: EditorStore, part: PartPackage): Promise<void> {
  const api = getShelfApi()
  if (!api) return
  // what is on the shelf now decides the question, so read it rather than trust a listing from before a git pull
  await refreshShelf()
  const onShelf = shelfSnapshot().listing?.parts.find((p) => p.id === part.id)
  if (onShelf && shelfFingerprint(onShelf) === shelfFingerprint(forShelf(part))) {
    store.flashViewportHint(t(M.alreadyOnShelf, { name: part.name }))
    return
  }
  if (!onShelf) {
    if (!window.confirm(t(M.putConfirm, { name: part.name }))) return
  } else {
    const answer = await askPartChange({
      title: t(M.putTitle, { name: part.name }),
      intro: t(M.putIntro),
      partId: part.id,
      changes: partChanges(onShelf, part),
      confirmLabel: t(M.putOnShelf),
    })
    if (answer !== 'confirm') return
  }
  const failed = await putOnShelf(store, api, part, await cardImage(part))
  if (failed !== '') alert(failed)
  await refreshShelf()
}

/**
 * Take the shelf's version of a part, after the list of what changes here. The part is one this project has, or a
 * built-in the shelf keeps its own version of ('shelfVersion'), measured against the app's version the project uses.
 */
export async function updateFromShelf(store: EditorStore, shelfPart: PartPackage, status: ShelfStatus | 'shelfVersion'): Promise<void> {
  const state = store.getState()
  const mine = state.userPackages.find((p) => p.id === shelfPart.id) ?? state.bundledPackages.find((p) => p.id === shelfPart.id)
  if (!mine) return
  const builtIn = status === 'shelfVersion'
  const answer = await askPartChange({
    title: t(builtIn ? M.useDialogTitle : M.updateDialogTitle, { name: shelfPart.name }),
    intro: builtIn ? t(M.useIntro, { name: mine.name }) : status === 'changedInBoth' ? t(M.updateIntroBoth) : t(M.updateIntro),
    partId: shelfPart.id,
    changes: partChanges(mine, shelfPart),
    confirmLabel: t(builtIn ? M.use : M.update),
    here: { parts: documentSceneOf(state).parts, program: state.stProgram },
  })
  if (answer === 'confirm') copyFromShelf(store, shelfPart)
  await refreshShelf()
}

/**
 * A different part of the same id: this project's moves to a new id (placed copies with it), and the shelf's can then
 * come in beside it. Never the shelf's: other projects may use it under its id.
 */
export async function renameOursForShelf(store: EditorStore, shelfPart: PartPackage): Promise<void> {
  const mine = store.getState().userPackages.find((p) => p.id === shelfPart.id)
  if (!mine) return
  const onShelfIds = new Set((shelfSnapshot().listing?.parts ?? []).map((p) => p.id))
  const taken = (id: string): boolean =>
    onShelfIds.has(id) || getPackage(id) !== undefined || store.getState().userPackages.some((p) => p.id === id)
  const to = await askName({
    title: t(M.renameTitle),
    intro: t(M.renameIntro, { name: mine.name }),
    initial: freePartId(mine.id, taken),
    confirmLabel: t(M.rename),
  })
  if (to === null) return
  const failed = onShelfIds.has(to) ? t(M.idTaken, { id: to }) : store.renameUserPackage(mine.id, to)
  if (failed !== '') alert(failed)
  await refreshShelf()
}
