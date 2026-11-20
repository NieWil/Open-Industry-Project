// The parts shelf: custom parts kept outside any project, for projects to copy from (docs/parts-shelf.md).
//
// A project's own copies stay the only place its parts come from: placing a shelf part copies it into the project,
// stamped with the fingerprint of the shelf version it was copied from (`PartPackage.origin.shelf`). The shelf is
// one source among others: the statuses, and how they are read from that record, are core/parts/partOrigin.ts.

import { partFingerprint, sourceStatus, withOrigin, withoutOrigin } from './partOrigin'
import type { SourceStatus } from './partOrigin'
import type { PartPackage } from './partPackage'

/** What a shelf part is to the open project (core/parts/partOrigin.ts {@link SourceStatus}). */
export type ShelfStatus = SourceStatus

/** A part's content fingerprint, the one every shelf comparison uses. */
export function shelfFingerprint(pkg: PartPackage): string {
  return partFingerprint(pkg)
}

/** What `shelfPart` is to the project, whose library holds `projectCopy` of that id (or nothing). */
export function shelfStatus(projectCopy: PartPackage | undefined, shelfPart: PartPackage): ShelfStatus {
  return sourceStatus(projectCopy, shelfPart, 'shelf')
}

/**
 * `shelfPart` as it goes into a project's parts: stamped with the fingerprint of this shelf version. A record from
 * the app stays: a version of a built-in is that wherever it goes, so the built-in's own "Updated" badge keeps working.
 */
export function asShelfCopy(shelfPart: PartPackage): PartPackage {
  return withOrigin(shelfPart, 'shelf', shelfFingerprint(shelfPart))
}

/**
 * A project's part as it goes onto the shelf: without the record of which shelf version the project's copy came
 * from, which describes that copy and not the part (a shelf part is the original every copy is measured against).
 */
export function forShelf(projectPart: PartPackage): PartPackage {
  return withoutOrigin(projectPart, 'shelf')
}

/** The project's copy once `part` is on the shelf as it is: recorded as copied from that version, so up to date. */
export function onShelfAs(projectPart: PartPackage): PartPackage {
  return withOrigin(projectPart, 'shelf', shelfFingerprint(projectPart))
}
