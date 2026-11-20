// What a project's part library holds, as a report names it (scripts/validate-project.mjs): the project's own copies
// of the app's built-in parts, apart from the parts authored for it. A copy of a built-in keeps the built-in's id and
// records the version it was copied at in `origin.app` (docs/part-sources.md); a variant made from one ("Save as a
// New Part") has an id of its own and names its base in `origin.appPart`, so it is the project's own part.

import { originOf, sourceStatus, type SourceStatus } from './partOrigin'
import type { PartPackage } from './partPackage'

export type LibraryEntry =
  | {
      kind: 'builtInCopy'
      id: string
      /** the built-in version it was copied at (`origin.app`); undefined for a copy saved before copies recorded it */
      version?: string
      /** the copy against this app's built-in of that id; `notInThisApp` when this app ships none */
      status: SourceStatus | 'notInThisApp'
    }
  | {
      kind: 'authored'
      id: string
      /** the built-in a variant was made from (`origin.appPart`) */
      madeFrom?: string
    }

/** Is `pkg` a project's copy of the built-in of its own id: stamped `origin.app`, or carrying a built-in's id? */
export function isBuiltInCopy(pkg: PartPackage, builtIn: PartPackage | undefined): boolean {
  const appPart = pkg.origin?.appPart
  if (appPart !== undefined && appPart !== pkg.id) return false
  return originOf(pkg, 'app') !== undefined || builtIn !== undefined
}

/** Each library part as a built-in copy (with its version and status) or an authored part, in library order. */
export function summarizeLibrary(pkgs: readonly PartPackage[], builtInOf: (id: string) => PartPackage | undefined): LibraryEntry[] {
  return pkgs.map((pkg): LibraryEntry => {
    const builtIn = builtInOf(pkg.id)
    if (isBuiltInCopy(pkg, builtIn)) {
      const version = originOf(pkg, 'app')
      return { kind: 'builtInCopy', id: pkg.id, ...(version !== undefined ? { version } : {}), status: builtIn ? sourceStatus(pkg, builtIn, 'app') : 'notInThisApp' }
    }
    const madeFrom = pkg.origin?.appPart
    return { kind: 'authored', id: pkg.id, ...(madeFrom !== undefined ? { madeFrom } : {}) }
  })
}

const STATUS_WORDS: Record<SourceStatus | 'notInThisApp', string> = {
  notInProject: 'not in the project',
  upToDate: 'same as this app ships',
  updateAvailable: 'this app ships a newer version',
  editedHere: 'edited in this project',
  changedInBoth: 'edited here, and this app ships a newer version',
  sameIdDifferentPart: "differs from this app's part of that id",
  notInThisApp: 'this app ships no part of that id',
}

/** One entry in words: `oip.diverter (version 25549:21kqq8sdiyr, same as this app ships)`, `my.part (made from oip.x)`. */
export function describeLibraryEntry(e: LibraryEntry): string {
  if (e.kind === 'authored') return e.madeFrom ? `${e.id} (made from ${e.madeFrom})` : e.id
  return `${e.id} (${e.version !== undefined ? `version ${e.version}` : 'version not recorded'}, ${STATUS_WORDS[e.status]})`
}
