import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, manifestOfPackage } from './partPackage'
import { validatePartPackage } from './partValidate'
import type { PartPackage } from './partPackage'
import { asShelfCopy, forShelf, onShelfAs, shelfFingerprint, shelfStatus } from './partShelf'

function part(name = 'Transfer', size = 1): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.transfer',
    name,
    params: {},
    behavior: 'definePart(() => ({}))',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [size, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: size, width: 1, top: 0.05, bottom: -0.1 } },
  }
}
/** the same part with a change to its content (what an edit, on either side, does) */
const changed = (p: PartPackage, size: number): PartPackage => ({
  ...p,
  geometry: { ...p.geometry, links: [{ name: 'deck', shape: { kind: 'box', size: [size, 0.1, 1] }, offset: [0, -0.05, 0] }] } as PartPackage['geometry'],
})

describe('shelfStatus: which side changed a shelf part, from the copy\'s record alone', () => {
  const shelf = part()
  const copy = asShelfCopy(shelf)

  it('a part the project does not have is placed by copying it in', () => {
    expect(shelfStatus(undefined, shelf)).toBe('notInProject')
  })

  it('a fresh copy is up to date, and the record is not part of the content', () => {
    expect(copy.origin?.shelf).toBe(shelfFingerprint(shelf))
    expect(shelfFingerprint(copy)).toBe(shelfFingerprint(shelf))
    expect(shelfStatus(copy, shelf)).toBe('upToDate')
  })

  it('the four states', () => {
    const newerShelf = changed(shelf, 2)
    const editedCopy = changed(copy, 3)
    expect(shelfStatus(copy, newerShelf)).toBe('updateAvailable')
    expect(shelfStatus(editedCopy, shelf)).toBe('editedHere')
    expect(shelfStatus(editedCopy, newerShelf)).toBe('changedInBoth')
    // both changed to the same content: nothing to choose between
    expect(shelfStatus(changed(copy, 2), newerShelf)).toBe('upToDate')
  })

  it('a same-id part that never came from the shelf is the same part only if its content is', () => {
    expect(shelfStatus(part(), shelf)).toBe('upToDate')
    expect(shelfStatus(changed(part(), 5), shelf)).toBe('sameIdDifferentPart')
  })

  it('a thumbnail or a stored-format change is not a new version', () => {
    expect(shelfStatus(copy, { ...shelf, thumbnail: 'data:image/png;base64,AAAA' })).toBe('upToDate')
  })
})

describe('moving a part between a project and the shelf', () => {
  it('onto the shelf without the record of the project copy; the copy then reads up to date', () => {
    const edited = changed(asShelfCopy(part()), 4)
    const onShelf = forShelf(edited)
    expect(onShelf.origin).toBeUndefined()
    expect(shelfStatus(onShelfAs(edited), onShelf)).toBe('upToDate')
  })

  it('a built-in version keeps its record from the app both ways, so the built-in\'s own update badge still works', () => {
    const builtInVersion: PartPackage = { ...part(), origin: { app: 'abc' } }
    expect(forShelf(builtInVersion).origin).toEqual({ app: 'abc' })
    expect(asShelfCopy(builtInVersion).origin?.app).toBe('abc')
    expect(forShelf(asShelfCopy(builtInVersion)).origin).toEqual({ app: 'abc' })
  })

  it('the record survives the part folder (manifest.json) and validation', () => {
    const copy = asShelfCopy(part())
    expect(manifestOfPackage(copy).origin).toEqual(copy.origin)
    expect(validatePartPackage(copy)).toEqual([])
    expect(validatePartPackage({ ...copy, origin: { shelf: '' } }).map((p) => p.field)).toContain('origin')
  })
})
