// test-project's `--only` (scripts/lib/projectTests.mjs pickTests): an exact name is picked over a substring match.
import { describe, expect, it } from 'vitest'

interface T {
  name: string
  file?: string
  spec: { name?: string }
}
interface Picked {
  specs: T[]
  unreadable: { file: string }[]
  match: string
  ambiguous: string[]
}
// @ts-expect-error - a plain .mjs CLI helper, untyped
const { pickTests } = (await import('../../../scripts/lib/projectTests.mjs')) as {
  pickTests: (all: T[], bad: { file: string }[], only: string | null) => Picked
}

const t = (file: string, name?: string): T => ({ name: file, file, spec: name ? { name } : {} })
const all = [t('lane2-full.test.json', 'Lane 2 backs up'), t('lane2-full-logic.test.json', 'Lane 2 logic'), t('sort.test.json', 'Physical sort')]

describe('pickTests', () => {
  it('runs everything without --only', () => {
    expect(pickTests(all, [], null).specs).toHaveLength(3)
  })
  it('an exact file name, with or without .test.json, picks that test alone', () => {
    for (const only of ['lane2-full', 'lane2-full.test.json']) {
      const r = pickTests(all, [], only)
      expect(r.specs.map((s) => s.file)).toEqual(['lane2-full.test.json'])
      expect(r.match).toBe('exact')
      expect(r.ambiguous).toEqual([])
    }
  })
  it('an exact display name picks that test alone', () => {
    expect(pickTests(all, [], 'Lane 2 logic').specs.map((s) => s.file)).toEqual(['lane2-full-logic.test.json'])
  })
  it('falls back to a substring, listing what it picked when that is several', () => {
    const r = pickTests(all, [{ file: 'lane2-broken.test.json' }], 'lane2')
    expect(r.match).toBe('substring')
    expect(r.ambiguous).toEqual(['lane2-full.test.json', 'lane2-full-logic.test.json', 'lane2-broken.test.json'])
  })
  it('a single substring match is not ambiguous', () => {
    expect(pickTests(all, [], 'sort').ambiguous).toEqual([])
  })
  it('an exact match on a spec that cannot run picks that one', () => {
    const r = pickTests(all, [{ file: 'lane2.test.json' }], 'lane2')
    expect(r.specs).toEqual([])
    expect(r.unreadable).toEqual([{ file: 'lane2.test.json' }])
  })
  it('matches nothing: match "none"', () => {
    expect(pickTests(all, [], 'nosuch')).toMatchObject({ specs: [], unreadable: [], match: 'none' })
  })
})
