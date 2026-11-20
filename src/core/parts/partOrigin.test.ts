import { describe, expect, it } from 'vitest'
import { matchesRecord, originOf, partFingerprint, sourceStatus, storedPackageHash, withOrigin, withoutOrigin } from './partOrigin'
import { PACKAGE_FORMAT } from './partPackage'
import { validatePartPackage } from './partValidate'
import { canonicalOrigin, upgradeStoredPackage } from './partUpgrade'
import type { PartPackage } from './partPackage'

function part(size = 1): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.transfer',
    name: 'Transfer',
    params: {},
    behavior: 'definePart(() => ({}))',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [size, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: size, width: 1, top: 0.05, bottom: -0.1 } },
  }
}

describe('a copy\'s record, per source', () => {
  it('each source keeps its own record, and the record is never part of the content', () => {
    const both = withOrigin(withOrigin(part(), 'app', 'a1'), 'shelf', 's1')
    expect(both.origin).toEqual({ app: 'a1', shelf: 's1' })
    expect(originOf(both, 'app')).toBe('a1')
    expect(partFingerprint(both)).toBe(partFingerprint(part()))
    expect(withoutOrigin(both, 'shelf').origin).toEqual({ app: 'a1' })
    expect(withoutOrigin(withoutOrigin(both, 'shelf'), 'app')).not.toHaveProperty('origin')
  })

  it('statuses are read against one source: a record from another says nothing about it', () => {
    const app = part()
    const copy = withOrigin(part(2), 'app', partFingerprint(app)) // a project's edited version of a built-in
    expect(sourceStatus(copy, app, 'app')).toBe('editedHere')
    expect(sourceStatus(copy, part(3), 'app')).toBe('changedInBoth')
    expect(sourceStatus(copy, part(5), 'shelf')).toBe('sameIdDifferentPart')
  })
})

describe('the fingerprint covers what the author wrote', () => {
  it('a build that derives params or interaction differently is not a new version of the part', () => {
    const derivedElsewhere: PartPackage = { ...part(), params: { speed: { type: 'number', default: 1 } }, interactive: true }
    expect(partFingerprint(derivedElsewhere)).toBe(partFingerprint(part()))
    // the behavior they come from is in it, so the author changing them still shows
    expect(partFingerprint({ ...part(), behavior: 'definePart(() => ({ step() {} }))' })).not.toBe(partFingerprint(part()))
    // the stored package differs, and the corpus keeps both
    expect(storedPackageHash(derivedElsewhere)).not.toBe(storedPackageHash(part()))
  })

  it('a copy whose record is from a build that derived params differently still reads up to date', () => {
    const copied = { ...part(), params: { speed: { type: 'number', default: 1 } } } as PartPackage
    const copy = withOrigin(copied, 'shelf', partFingerprint(copied))
    const rebuiltNow = { ...part(), params: { speed: { type: 'number', default: 1, min: 0 } } } as PartPackage
    expect(sourceStatus(copy, rebuiltNow, 'shelf')).toBe('upToDate')
    expect(sourceStatus({ ...rebuiltNow, origin: copy.origin }, rebuiltNow, 'shelf')).toBe('upToDate')
  })

  // A record made before the scheme prefix is read with the hash that made it, so no project's statuses move.
  it('a record from before the scheme is read the way it was written', () => {
    const shipped = part()
    expect(partFingerprint(shipped).startsWith('v2:')).toBe(true)
    const copy = withOrigin(part(), 'app', storedPackageHash(shipped))
    expect(matchesRecord(copy, storedPackageHash(shipped))).toBe(true)
    expect(sourceStatus(copy, shipped, 'app')).toBe('upToDate')
    expect(sourceStatus(copy, part(2), 'app')).toBe('updateAvailable')
    expect(sourceStatus(withOrigin(part(3), 'app', storedPackageHash(shipped)), shipped, 'app')).toBe('editedHere')
    expect(sourceStatus(withOrigin(part(3), 'app', storedPackageHash(shipped)), part(2), 'app')).toBe('changedInBoth')
  })
})

describe('package format 6: basedOn and fromShelf became origin', () => {
  const v5 = { ...part(), format: 5, basedOn: 'a1', fromShelf: 's1' }

  it('a stored format-5 package is upgraded, losing nothing (so no repair line)', () => {
    const { pkg, repairs } = upgradeStoredPackage(v5 as unknown)
    expect(repairs).toEqual([])
    expect(pkg).toEqual({ ...part(), origin: { app: 'a1', shelf: 's1' } })
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it('the fingerprint does not move across the upgrade, so a stamp made before it still matches', () => {
    expect(partFingerprint(upgradeStoredPackage(v5 as unknown).pkg as PartPackage)).toBe(partFingerprint(part()))
  })

  it('a key origin already has wins, and nothing changes when there is nothing to move', () => {
    expect(canonicalOrigin({ basedOn: 'old', origin: { app: 'new' } })).toEqual({ origin: { app: 'new' } })
    const plain = { id: 'x' }
    expect(canonicalOrigin(plain)).toBe(plain)
  })

  it('a source this build does not know is kept, not refused (a later build may add one)', () => {
    expect(validatePartPackage({ ...part(), origin: { library: 'l1' } })).toEqual([])
    expect(validatePartPackage({ ...part(), origin: { app: 7 } }).map((p) => p.field)).toContain('origin')
    expect(validatePartPackage({ ...part(), origin: 'a1' }).map((p) => p.field)).toContain('origin')
  })
})
