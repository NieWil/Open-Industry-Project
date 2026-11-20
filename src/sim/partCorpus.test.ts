import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { afterAll, describe, expect, it } from 'vitest'
import { storedPackageHash } from '../core/parts/partOrigin'
import { validatePartPackage } from '../core/parts/partValidate'
import { upgradeStoredPackage } from '../core/parts/partUpgrade'
import type { PartPackage } from '../core/parts/partPackage'
import { runPartAlone } from './partBehaviour'
import { shippedParts } from './shippedParts.node'

// The old-parts corpus (scripts/part-corpus.mjs, docs/part-sources.md "Keeping old copies running"): every
// first-party part as the app has ever shipped it. A project keeps its own copy of each part it uses, so every
// version ever shipped lives on in somebody's project. This build has to load and run all of them, or that project
// needs an older app, which is what per-project copies exist to prevent. Each version is read the way a project
// library is (upgradeStoredPackage, the one door), validated, placed alone in a scene and run for two seconds of sim
// time. It must report no runtime problem, and what it did must match what that version did when it was recorded
// (test-corpus/behaviour.json: cargo to the millimetre, joints, lamps and displays, behaviourDigest). Recording only
// ever adds the digest of a version new to the corpus (`node scripts/part-corpus.mjs` runs this file with
// OIP_RECORD_CORPUS=1); an existing digest is never rewritten, since an old version behaving differently in a later
// build is exactly what this exists to catch.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORPUS = join(repo, 'test-corpus', 'parts')
const BEHAVIOUR = join(repo, 'test-corpus', 'behaviour.json')
const RECORD = process.env.OIP_RECORD_CORPUS === '1'
const recorded = (existsSync(BEHAVIOUR) ? JSON.parse(readFileSync(BEHAVIOUR, 'utf8')) : {}) as Record<string, string>
const newlyRecorded: Record<string, string> = {}

const fileOf = (pkg: PartPackage): string => join(CORPUS, pkg.id, `${storedPackageHash(pkg).replace(/:/g, '-')}.json`)

/** every stored version in the corpus, as raw JSON (it is read through upgradeStoredPackage like a library entry) */
function corpus(): { name: string; raw: unknown }[] {
  if (!existsSync(CORPUS)) return []
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(CORPUS, d.name))
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ name: `${d.name}/${f}`, raw: JSON.parse(readFileSync(join(CORPUS, d.name, f), 'utf8')) as unknown })),
    )
}

const now = shippedParts()
const stored = corpus()

describe('old-parts corpus: every part version this app has shipped still loads and runs', () => {
  afterAll(() => {
    if (!RECORD || Object.keys(newlyRecorded).length === 0) return
    const all = { ...newlyRecorded, ...recorded } // a recorded digest always takes precedence: recording only adds
    writeFileSync(BEHAVIOUR, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + '\n')
  })

  it('holds every first-party part as this build ships it (run `node scripts/part-corpus.mjs` after changing a part)', () => {
    const missing = now.filter((p) => !existsSync(fileOf(p))).map((p) => p.id)
    expect(missing, 'first-party parts whose current version is not in test-corpus/parts').toEqual([])
  })

  for (const { name, raw } of stored) {
    it(`${name}: loads, validates, and runs alone in a scene the way it did when recorded`, () => {
      const { pkg } = upgradeStoredPackage(raw)
      expect(validatePartPackage(pkg).map((p) => `${p.field}: ${p.message}`)).toEqual([])
      // what it may name (held cargo, a unit load's pieces) resolves to this build's parts, as in a project whose
      // library was completed by this build
      const { digest, problems } = runPartAlone(Jolt, pkg as PartPackage, { others: now })
      expect(problems).toEqual([])
      if (recorded[name] !== undefined) expect(digest, 'it behaves differently from when this version was recorded').toBe(recorded[name])
      else if (RECORD) newlyRecorded[name] = digest
      else expect.fail(`no recorded behaviour for ${name}: run \`node scripts/part-corpus.mjs\``)
    })
  }
})
