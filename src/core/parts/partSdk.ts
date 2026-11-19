// The Part SDK level: which version of what a part can say this build understands.
//
// The package format (PACKAGE_FORMAT) changes only when a stored spelling has to be translated. Most SDK growth is
// additive (a new ctx member, a new manifest field) and needs no format bump, so an older build loads a part that
// uses it and then fails inside the part, with no word why. The level closes that gap. Every part is stamped with the
// level of the build that last changed it, and a build older than the stamp warns (Problems dock, group Parts)
// instead of failing silently. It warns and never refuses: most parts made under a newer level use nothing new, and
// an installed app updates itself, so the cost of a cautious stamp is one warning.
//
// Raise PART_SDK_LEVEL when the SDK's surface changes. `npm run build-part-sdk -- --check` fails until it is raised
// (packages/part-sdk/levels.json records the surface each level shipped).

import { partFingerprint } from './partOrigin'
import type { PartPackage } from './partPackage'

/** The Part SDK level of this build. packages/part-sdk/package.json's version is `0.<level>.0`. */
export const PART_SDK_LEVEL = 17

/**
 * `pkg` stamped with the level it was last changed under. An existing stamp is kept while it still describes the
 * part (same fingerprint), so loading or copying a part keeps the level of the build that changed it. A part with
 * no stamp, or one changed since it was stamped, takes this build's level.
 */
export function stampSdk(pkg: PartPackage): PartPackage {
  const of = partFingerprint(pkg)
  if (pkg.sdk?.of === of) return pkg
  return { ...pkg, sdk: { level: PART_SDK_LEVEL, of } }
}

/** The level `pkg` was last changed under, or undefined when unknown (no stamp, or changed since it was stamped). */
export function sdkLevelOf(pkg: PartPackage): number | undefined {
  const s = pkg.sdk
  if (!s || typeof s.level !== 'number' || typeof s.of !== 'string') return undefined
  return s.of === partFingerprint(pkg) ? s.level : undefined
}

/** The level `pkg` was made under when that is newer than this build's, else undefined. */
export function newerSdkLevel(pkg: PartPackage, current: number = PART_SDK_LEVEL): number | undefined {
  const level = sdkLevelOf(pkg)
  return level !== undefined && level > current ? level : undefined
}
