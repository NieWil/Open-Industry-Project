import { describe, expect, it } from 'vitest'
import { asCopyOfBuiltIn, asNewPartFrom, builtInChangedSince, builtInFingerprint, variantBase } from './builtInVersion'
import { PACKAGE_FORMAT } from './parts/partPackage'
import type { PartPackage } from './parts/partPackage'

const pkg = (over: Partial<PartPackage> = {}): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: 'oip.thing',
    name: 'Thing',
    params: { speed: { type: 'number', default: 1 } },
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, 0, 0] }], joints: [] },
    ...over,
  }) as PartPackage

describe('builtInFingerprint', () => {
  it('is the same for the same part, whatever order its fields were written in', () => {
    const a = pkg()
    const b = Object.fromEntries(Object.entries(pkg()).reverse()) as unknown as PartPackage
    expect(builtInFingerprint(b)).toBe(builtInFingerprint(a))
  })

  it('ignores what is not the part: the stored format, a thumbnail, and the record itself', () => {
    const fp = builtInFingerprint(pkg())
    expect(builtInFingerprint(pkg({ thumbnail: 'data:image/webp;base64,AAAA' }))).toBe(fp)
    expect(builtInFingerprint(pkg({ origin: { app: 'x', shelf: 'y' } }))).toBe(fp)
    expect(builtInFingerprint({ ...pkg(), format: 3 } as unknown as PartPackage)).toBe(fp)
  })

  // params are what the SDK reads out of the script (sim/validatePart.ts), so a param changes through the script
  it('changes when the part does: its script (params included), its geometry', () => {
    const fp = builtInFingerprint(pkg())
    expect(builtInFingerprint(pkg({ behavior: 'definePart({ step() { /* v2 */ } })' }))).not.toBe(fp)
    expect(builtInFingerprint(pkg({ behavior: "definePart({ params: { speed: { type: 'number', default: 2 } }, step() {} })" }))).not.toBe(fp)
    expect(builtInFingerprint(pkg({ params: { speed: { type: 'number', default: 2 } } }))).toBe(fp)
    expect(builtInFingerprint(pkg({ geometry: { kind: 'rig', links: [], joints: [] } }))).not.toBe(fp)
  })
})

describe('a project copy of a built-in', () => {
  it('records the built-in it came from, once', () => {
    const builtIn = pkg()
    const copy = asCopyOfBuiltIn(pkg({ behavior: 'definePart({ step() { /* mine */ } })' }), builtIn)
    expect(copy.origin?.app).toBe(builtInFingerprint(builtIn))
    expect(asCopyOfBuiltIn(copy, pkg({ name: 'Newer' }))).toBe(copy) // an existing record is kept, not overwritten
  })

  it('knows when the app has changed the built-in since, and says nothing it cannot know', () => {
    const v1 = pkg()
    const copy = asCopyOfBuiltIn(pkg({ name: 'Mine' }), v1)
    expect(builtInChangedSince(copy, v1)).toBe(false)
    expect(builtInChangedSince(copy, pkg({ behavior: 'definePart({ step() { /* v2 */ } })' }))).toBe(true)
    expect(builtInChangedSince(copy, undefined)).toBe(false) // no built-in of that id (any more)
    expect(builtInChangedSince(pkg({ name: 'Old copy' }), pkg({ name: 'v2' }))).toBe(false) // made before records
  })

  it('says nothing when the built-in changed to exactly the project\'s version (the same fix in both)', () => {
    const v1 = pkg()
    const copy = asCopyOfBuiltIn(pkg({ name: 'Fixed' }), v1)
    expect(builtInChangedSince(copy, pkg({ name: 'Fixed' }))).toBe(false)
  })
})

describe('a variant: a new part made from a built-in ("Save as New Part")', () => {
  it('has its own id and name, and records the built-in and the version it came from', () => {
    const builtIn = pkg()
    const v = asNewPartFrom(builtIn, 'user.thing', 'Thing (variant)', builtIn)
    expect(v.id).toBe('user.thing')
    expect(v.name).toBe('Thing (variant)')
    expect(v.origin).toEqual({ app: builtInFingerprint(builtIn), appPart: builtIn.id })
    expect(variantBase(v, [builtIn])).toEqual({ base: builtIn, changedSince: false })
  })

  it("made from the project's copy, it keeps the version that copy came from; a shelf record does not follow", () => {
    const v1 = pkg()
    const copy = { ...asCopyOfBuiltIn(pkg({ name: 'Mine' }), v1), origin: { app: builtInFingerprint(v1), shelf: 'x' } }
    const v = asNewPartFrom(copy, 'user.thing', 'Mine (variant)', v1)
    expect(v.origin).toEqual({ app: builtInFingerprint(v1), appPart: v1.id })
    expect(v.name).toBe('Mine (variant)')
  })

  it('says when the base changes, and is never an update of it (another id)', () => {
    const v1 = pkg()
    const v = asNewPartFrom(v1, 'user.thing', 'Thing (variant)', v1)
    const v2 = pkg({ behavior: 'definePart({ step() { /* v2 */ } })' })
    expect(variantBase(v, [v2])?.changedSince).toBe(true)
    expect(builtInChangedSince(v, undefined)).toBe(false) // no built-in shares its id
  })

  it('made from a part that is no built-in, it records nothing', () => {
    const own = pkg({ id: 'acme.cell' })
    const v = asNewPartFrom({ ...own, origin: { shelf: 's' } }, 'user.cell', 'Cell (variant)', undefined)
    expect(v.origin).toBeUndefined()
    expect(variantBase(v, [own])).toBeUndefined()
  })
})
