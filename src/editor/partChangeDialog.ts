// askPartChange(): asked before one version of a part replaces another (docs/part-sources.md, docs/parts-shelf.md),
// with the list of what changes: taking a newer version from the app, a part library or the parts shelf, or putting
// this project's version on the shelf. Callable from anywhere such a change starts (a Catalog card, the updates
// notice, the Part Editor) and answered by the one dialog App mounts (components/PartChangeDialog.tsx's
// PartChangeDialogHost), as askName is.

import type { PartChange } from '../core/parts/partChanges'
import type { PartInstance } from '../core/types'

export interface PartChangeRequest {
  title: string
  intro: string
  partId: string
  changes: PartChange[]
  confirmLabel: string
  /** a second answer beside confirming: the app's "Keep this project's version", which also stops it asking */
  alternative?: { label: string; title: string }
  /** the project's scene and program when the change lands in this project, so a breaking signal change says what it breaks here */
  here?: { parts: readonly PartInstance[]; program: string }
}

/** confirmed, chose the alternative, or cancelled */
export type PartChangeAnswer = 'confirm' | 'alternative' | 'cancel'

type Opener = (request: PartChangeRequest, resolve: (answer: PartChangeAnswer) => void) => void

let opener: Opener | null = null

/** The mounted host registers here (and unregisters with the returned function). */
export function registerPartChangeDialog(open: Opener): () => void {
  opener = open
  return () => {
    if (opener === open) opener = null
  }
}

/** Ask whether to go ahead. Resolves 'cancel' when dismissed, or at once with no host mounted. */
export function askPartChange(request: PartChangeRequest): Promise<PartChangeAnswer> {
  return new Promise((resolve) => {
    if (!opener) return resolve('cancel')
    opener(request, resolve)
  })
}
