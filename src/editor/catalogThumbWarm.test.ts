// The boot warm must cover the catalog's real card set.
//
// The catalog's parts are SDK packages, and PART_DEFS holds only `building` + two noCatalog entries. A
// warm list derived from PART_DEFS alone covers one file instead of ~31, and nothing fails: the loop
// runs, the cards appear, and they fetch cold on first tab click. That is the lag the function exists
// to prevent, and no other gate sees it.
//
// So this pins it against the files on disk in both directions. A warmed url with no file is a 404;
// a card with no warmed url is a cold fetch. Both are silent in production, so both fail here.
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { packageThumbFile } from '../core/parts/partPackage'
import { PART_DEFS } from '../core/types'
import type { PartType } from '../core/types'
import { prefetchThumbnails } from '../render/prefetch'
import { bundledManifests, bundledThumbnailIds } from './parts/bundledExamples'

/** Capture the urls prefetchThumbnails warms, by standing in for the DOM Image it uses. */
function warmedUrls(ids: readonly string[]): string[] {
  const urls: string[] = []
  const prior = (globalThis as { Image?: unknown }).Image
  ;(globalThis as { Image?: unknown }).Image = class {
    set src(value: string) {
      urls.push(value)
    }
  }
  try {
    prefetchThumbnails(ids)
  } finally {
    if (prior === undefined) delete (globalThis as { Image?: unknown }).Image
    else (globalThis as { Image?: unknown }).Image = prior
  }
  return urls
}

const committedPkgFiles = (): string[] =>
  readdirSync(new URL('../../public/thumbnails/pkg', import.meta.url))
    .filter((f) => f.endsWith('.webp'))
    .map((f) => f.replace(/\.webp$/, ''))

describe('catalog thumbnail boot warm', () => {
  it('warms one url per bundled package card', () => {
    const urls = warmedUrls(bundledThumbnailIds())
    for (const id of bundledThumbnailIds()) {
      expect(urls).toContain(`/thumbnails/pkg/${packageThumbFile(id)}.webp`)
    }
  })

  it('warms the catalog-visible built-in types too', () => {
    const urls = warmedUrls([])
    for (const type of Object.keys(PART_DEFS) as PartType[]) {
      // a `glyph` type has no 3-D form and so no image (an annotation): its card draws the glyph and asks
      // for nothing, so warming a url would be a guaranteed 404 rather than a saved fetch
      if (PART_DEFS[type].noCatalog || PART_DEFS[type].glyph) continue
      expect(urls).toContain(`/thumbnails/${type}.webp`)
    }
  })

  it('warms nothing for a glyph type - the whole point of declaring one', () => {
    const urls = warmedUrls([])
    for (const type of Object.keys(PART_DEFS) as PartType[]) {
      if (PART_DEFS[type].glyph) expect(urls).not.toContain(`/thumbnails/${type}.webp`)
    }
  })

  // The tripwire for a newly dropped part folder. Adding a part is just committing the folder, and
  // everything about it works immediately except its catalog card, which 404s and falls back to the
  // offscreen renderer: a ~15 s shimmer skeleton on the card while a second GPU device spins up, on
  // every cold load, for every visitor. Nothing else reports it. Baking the image is the fix.
  it('has a committed thumbnail for every bundled part (a new folder needs `npm run thumbnails`)', () => {
    const files = new Set(committedPkgFiles())
    const missing = bundledThumbnailIds().filter((id) => !files.has(packageThumbFile(id)))
    expect(
      missing,
      `no public/thumbnails/pkg/*.webp for: ${missing.join(', ')}. Run \`npm run thumbnails\` and commit ` +
        `the result, or these cards render offscreen on every cold load instead of loading an image.`,
    ).toEqual([])
  })

  // The other direction: a committed image nobody warms is an image nobody loads, left behind by a part
  // folder that was renamed or deleted. Harmless at runtime, so only a check finds it.
  it('has no orphan thumbnail left by a renamed or deleted part', () => {
    const warmed = new Set(warmedUrls(bundledThumbnailIds()))
    const orphans = committedPkgFiles().filter((f) => !warmed.has(`/thumbnails/pkg/${f}.webp`))
    expect(
      orphans,
      `public/thumbnails/pkg/${orphans.join('.webp, ')}.webp has no bundled part in examples/parts. ` +
        `Delete the stale image, or restore the part folder it belonged to.`,
    ).toEqual([])
  })

  // The failure stated as a number: a warm that covers a single card is the failure mode,
  // and it reads as success everywhere else.
  it('covers the whole catalog, not a handful of leftovers', () => {
    expect(warmedUrls(bundledThumbnailIds()).length).toBeGreaterThan(20)
  })

  it('skips packages that carry their own author-supplied thumbnail', () => {
    const authored = bundledManifests().filter((m) => m.thumbnail).map((m) => m.id)
    const warmed = new Set(warmedUrls(bundledThumbnailIds()))
    for (const id of authored) expect(warmed).not.toContain(`/thumbnails/pkg/${packageThumbFile(id)}.webp`)
  })

  it('does nothing when the browser asks to save data', () => {
    const nav = globalThis as { navigator?: unknown }
    const prior = nav.navigator
    Object.defineProperty(globalThis, 'navigator', { value: { connection: { saveData: true } }, configurable: true })
    try {
      expect(warmedUrls(bundledThumbnailIds())).toHaveLength(0)
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: prior, configurable: true })
    }
  })
})
