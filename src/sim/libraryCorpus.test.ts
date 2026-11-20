/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { oippartBytesToFolder } from '../core/parts/partArchive'
import { checkLibraryDownload } from '../core/parts/partLibrary'
import type { LibraryVersion } from '../core/parts/partLibrary'
import { buildPackage } from './buildPackage'
import { runPartAlone } from './partBehaviour'
import { REPO_ROOT, shippedParts } from './shippedParts.node'

// The listed library's half of the old-parts corpus (docs/part-libraries.md, "How a deploy keeps working with
// published parts"). Every listed version from another publisher records what it did when it was listed (its
// `behaviour` digest, under the project's signature). This build must load each the way Get parts installs it, run
// it alone with no problem, and get the same digest.
//
// The versions come from the network, so they are fetched first by `node scripts/library-corpus.mjs` (CI does, before
// the tests), into .cache/library-corpus/. Without that download there is nothing to run, and this file says so.

const DIR = process.env.OIP_LIBRARY_CORPUS ?? join(REPO_ROOT, '.cache', 'library-corpus')
const LIST = join(DIR, 'listed.json')
interface Listed {
  name: string
  partId: string
  file: string
  version: LibraryVersion & { behaviour: string }
}
const listed: Listed[] = existsSync(LIST) ? (JSON.parse(readFileSync(LIST, 'utf8')) as Listed[]) : []

describe('listed library corpus: every listed version still installs and runs as it did when listed', () => {
  if (listed.length === 0) {
    it.skip('no listed versions downloaded (node scripts/library-corpus.mjs)', () => {})
    return
  }
  const now = shippedParts()
  for (const entry of listed) {
    it(`${entry.name}: installs, and runs alone the way it did when listed`, async () => {
      const Jolt = await initJolt()
      const bytes = new Uint8Array(readFileSync(join(DIR, entry.file)))
      const folder = await oippartBytesToFolder(bytes)
      if ('error' in folder) throw new Error(folder.error)
      const pkg = buildPackage(JSON.parse(folder.manifestJson), folder.behaviorJs)
      expect(checkLibraryDownload(entry.version, entry.partId, bytes, pkg)).toBe('')
      const { digest, problems } = runPartAlone(Jolt, pkg, { others: now })
      expect(problems).toEqual([])
      expect(digest, 'it behaves differently from when this version was listed').toBe(entry.version.behaviour)
    })
  }
})
