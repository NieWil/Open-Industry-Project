// Whether an imported model is too big for where this browser keeps the project.
//
// The working copy keeps each model's bytes in IndexedDB by hash (project/localAssets.ts), which is sized to the disk,
// so a model of any size saves. Without IndexedDB (some private windows) the model is base64 inside the project text
// in localStorage, which holds a few MB per site, and one large model can stop the autosave.

import { defineMessages, t } from '../../core/i18n'
import { supportsLocalAssets } from '../project/localAssets'

const M = defineMessages('modelStorage', {
  large:
    'This model is {mb} MB. This browser cannot keep models apart from the project (it has no IndexedDB, as in some private windows), so the model goes into local storage, which holds a few MB per site, and the autosave may stop. Export the project to a file to keep your work.',
})

/** past this many bytes a model alone can fill localStorage: 1.5 MB is 2 MB of base64, and a site gets roughly 5-10 MB */
const LARGE_MODEL_BYTES = 1_500_000

/** The advisory for an imported model of `bytes`, or null when this browser stores it without a size limit. */
export function largeModelAdvisory(bytes: number): string | null {
  if (bytes <= LARGE_MODEL_BYTES || supportsLocalAssets()) return null
  return t(M.large, { mb: (bytes / 1e6).toFixed(1) })
}
