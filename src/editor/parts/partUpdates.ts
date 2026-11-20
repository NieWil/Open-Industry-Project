// Every newer version of a part this project holds, wherever it came from (docs/part-sources.md): the app's built-ins,
// a part library, the parts shelf. The sources keep the same record (core/parts/partOrigin.ts), so they are told the
// same way: one "Update" badge on the card, one dialog listing what changes, one notice above the cards.
//
// Taking a newer version is always asked first and never automatic. A decline leaves the badge, except for the app's
// "Keep this project's version", which records the answer so the app stops asking until it changes the part again.

import { useMemo } from 'react'
import { builtInChangedSince, editedSinceCopied, sameAsBuiltIn } from '../../core/builtInVersion'
import { libraryCredit, libraryStatus } from '../../core/parts/partLibrary'
import { partChanges } from '../../core/parts/partChanges'
import type { PartCredit, PartPackage } from '../../core/parts/partPackage'
import type { EditorController } from '../controller'
import { askPartChange } from '../partChangeDialog'
import { documentSceneOf, type EditorState } from '../store/store'
import { downloadKey, fromLibrary, offerFor, useLibrarySnapshot, type LibrarySnapshot } from './libraryUpdates'
import { copyFromShelf, statusInProject, type ShelfListing } from './partShelf'
import { useShelf } from './shelfListing'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('partUpdate', {
  title: 'Update “{name}”',
  update: 'Update',
  fromApp: "The app has a newer “{name}” than this project. Every placed copy changes. What changes here:",
  fromAppEdited:
    "The app has a newer “{name}”, and this project changed its own copy. Updating discards this project's changes, and every placed copy changes. What changes here:",
  fromLibrary: '“{library}” has a newer “{name}” than this project. Every placed copy changes. What changes here:',
  fromLibraryEdited:
    "“{library}” has a newer “{name}”, and this project changed its own copy. Updating discards this project's changes, and every placed copy changes. What changes here:",
  fromShelf: 'The shelf has a newer “{name}” than this project. Every placed copy changes. What changes here:',
  fromShelfEdited:
    "“{name}” has changed both here and on the shelf. Updating discards this project's changes, and every placed copy changes. What changes here:",
  keep: "Keep this project's",
  keepTitle: "Keep this project's version. The app asks again only if it changes the part again.",
})

/** Where a newer version comes from. */
export type UpdateSource = 'app' | 'library' | 'shelf'

/** One part with a newer version at the place it came from. */
export interface PartUpdate {
  id: string
  /** the newer version's name */
  name: string
  source: UpdateSource
  /** the library's name, for a library update */
  from?: string
  /** this project changed its copy too, so taking the newer version discards those changes */
  edited: boolean
  current: PartPackage
  next: PartPackage
  /** who made a library part, kept on the copy (core/parts/partPackage.ts PartCredit) */
  credit?: PartCredit
}

/**
 * Every update this project has, a part with two sources once per source. A part's own come shelf, library, app: the
 * most specific place it came from first, which is the one its card's badge offers.
 */
export function partUpdatesOf(
  state: Pick<EditorState, 'userPackages' | 'bundledPackages'>,
  shelf: ShelfListing | null,
  libraries: LibrarySnapshot,
): PartUpdate[] {
  const out: PartUpdate[] = []
  const bundledById = new Map(state.bundledPackages.map((p) => [p.id, p]))
  const builtInIds = new Set(bundledById.keys())
  for (const copy of state.userPackages) {
    const builtIn = bundledById.get(copy.id)
    // the shelf: a team's version of a built-in the project uses unchanged is offered on the card, not an update
    const shelfPart = shelf?.parts.find((p) => p.id === copy.id)
    if (shelfPart && !(builtIn && sameAsBuiltIn(copy, builtIn))) {
      const status = statusInProject(state, shelfPart)
      if (status === 'updateAvailable' || status === 'changedInBoth') {
        out.push({ id: copy.id, name: shelfPart.name, source: 'shelf', edited: status === 'changedInBoth', current: copy, next: shelfPart })
      }
    }
    // a part library, once its version has been downloaded and checked
    if (libraries.listings && fromLibrary(copy, builtInIds)) {
      const offer = offerFor(libraries.listings, copy.id)
      const next = offer ? libraries.downloaded.get(downloadKey(offer.version, copy.id)) : undefined
      if (offer && next && offer.listing.index) {
        const status = libraryStatus(copy, offer.version, offer.listing.firstParty)
        if (status === 'updateAvailable' || status === 'changedInBoth') {
          const index = offer.listing.index
          out.push({
            id: copy.id,
            name: next.name,
            source: 'library',
            from: index.name,
            edited: status === 'changedInBoth',
            current: copy,
            next,
            credit: libraryCredit(index, index.parts.find((p) => p.id === copy.id), offer.listing.firstParty),
          })
        }
      }
    }
    // the app
    if (builtIn && builtInChangedSince(copy, builtIn)) {
      out.push({ id: copy.id, name: builtIn.name, source: 'app', edited: editedSinceCopied(copy), current: copy, next: builtIn })
    }
  }
  return out
}

/** This project's updates, from every source, kept current as the shelf and the libraries are read. */
export function usePartUpdates(state: Pick<EditorState, 'userPackages' | 'bundledPackages'>): PartUpdate[] {
  const shelf = useShelf()
  const libraries = useLibrarySnapshot(state)
  const listing = shelf?.listing ?? null
  const { userPackages, bundledPackages } = state
  // the same list until a part, the shelf or a library changes: a scene edit re-renders the Catalog sixty times a second
  return useMemo(() => partUpdatesOf({ userPackages, bundledPackages }, listing, libraries), [userPackages, bundledPackages, listing, libraries])
}

/** Take these newer versions into the project. The caller has asked first. */
export async function takeUpdates(controller: EditorController, updates: readonly PartUpdate[]): Promise<void> {
  const fromApp = updates.filter((u) => u.source === 'app').map((u) => u.id)
  if (fromApp.length > 0) controller.updateFromApp(fromApp)
  for (const u of updates) if (u.source === 'shelf') copyFromShelf(controller.store, u.next)
  const fromLibraries = updates.filter((u) => u.source === 'library')
  if (fromLibraries.length > 0) {
    const { installFromLibrary } = await import('./partLibraries')
    for (const u of fromLibraries) installFromLibrary(controller.store, u.next, u.credit)
  }
}

/** The intro a part's update dialog opens with: where the newer version is, and what taking it costs. */
function introOf(u: PartUpdate): string {
  const name = u.name
  if (u.source === 'app') return t(u.edited ? M.fromAppEdited : M.fromApp, { name })
  if (u.source === 'library') return t(u.edited ? M.fromLibraryEdited : M.fromLibrary, { name, library: u.from ?? '' })
  return t(u.edited ? M.fromShelfEdited : M.fromShelf, { name })
}

/**
 * Ask about one part's update, with the list of what changes here, and take it if confirmed. The app's update also
 * offers "Keep this project's", which stops it asking.
 */
export async function reviewUpdate(controller: EditorController, u: PartUpdate): Promise<void> {
  const state = controller.store.getState()
  const answer = await askPartChange({
    title: t(M.title, { name: u.name }),
    intro: introOf(u),
    partId: u.id,
    changes: partChanges(u.current, u.next),
    confirmLabel: t(M.update),
    ...(u.source === 'app' ? { alternative: { label: t(M.keep), title: t(M.keepTitle) } } : {}),
    here: { parts: documentSceneOf(state).parts, program: state.stProgram },
  })
  if (answer === 'confirm') await takeUpdates(controller, [u])
  else if (answer === 'alternative') controller.keepProjectVersion(u.id)
}
