import { versionedAssetUrl } from '../core/assetVersions'
import { packageThumbFile } from '../core/parts/partPackage'
import { PART_DEFS } from '../core/types'
import type { PartType } from '../core/types'

interface NetworkInformation {
  saveData?: boolean
}

/**
 * Warm the static catalog thumbnails into the browser HTTP cache. The catalog only mounts the active
 * tab's cards, so every other tab's `<img>` otherwise fetches on first click, a visible lag when
 * switching tabs. The whole set is ~80 KB, less than one part model. Call it early (ahead of the
 * heavy GLB prefetch), since thumbnails are the first thing a user browses.
 *
 * There are two url shapes, because a catalog card comes from a built-in PART_DEFS type
 * (`/thumbnails/<type>.webp`) or a custom-part package (`/thumbnails/pkg/<id>.webp`). In practice the
 * package ids are required: the built-ins are authored on the part SDK, so PART_DEFS holds only
 * `building` plus two noCatalog entries, and warming it alone covers one card out of ~31.
 * `prefetch.test.ts` pins the coverage to the real card set, so a change that drops the package
 * thumbnails fails a test.
 *
 * Skipped: `noCatalog` types (no card) and packages carrying an author-supplied `thumbnail` (already a
 * data URL in the bundle). Don't pass ids with no committed file (desktop-folder or in-app authored
 * parts): they 404 here and render offscreen instead (App.tsx).
 */
export function prefetchThumbnails(packageIds: readonly string[] = []): void {
  if (typeof Image === 'undefined') return
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection
  if (conn?.saveData) return
  const warm = (url: string): void => {
    const img = new Image()
    img.src = versionedAssetUrl(url)
  }
  for (const type of Object.keys(PART_DEFS) as PartType[]) {
    // A glyph type has no image to warm (nothing to render) - warming one would be a guaranteed 404 on
    // every cold load, which is the opposite of what this function is for.
    if (PART_DEFS[type].noCatalog || PART_DEFS[type].glyph) continue
    warm(`/thumbnails/${type}.webp`)
  }
  for (const id of packageIds) warm(`/thumbnails/pkg/${packageThumbFile(id)}.webp`)
}
