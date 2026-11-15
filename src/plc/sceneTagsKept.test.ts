// A scene's tag list and a package's param specs are kept between readers (bindings.ts sceneTags, core
// packageParams.ts packageParamSpecs): a ladder sheet asks for both once per rung on every redraw. Kept, they must
// still be right after anything they depend on changes, and must not let two parts share a default.
import { afterEach, describe, expect, it } from 'vitest'
import { packageParamSpecs } from '../core/packageParams'
import { PACKAGE_FORMAT, type PartPackage } from '../core/parts/partPackage'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { sceneTags, type TaggedPart } from './bindings'

const pkg = (params: PartPackage['params'], id = 'x'): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id,
    name: id,
    commsParam: 'enableComms',
    params,
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [], joints: [], bounds: { length: 1, width: 1, top: 1 } },
  }) as PartPackage
const TAGGED = { enableComms: { type: 'boolean', default: false }, runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' } } as PartPackage['params']
const part = (id: string, runTag: string, on = true): TaggedPart => ({ id, type: 'part', packageId: 'x', params: { enableComms: on, runTag } }) as TaggedPart

afterEach(() => clearPackages())

describe("a scene's tag list, kept", () => {
  it('is one list for the same parts, and worked out again when the parts are another array', () => {
    registerPackage(pkg(TAGGED))
    const parts = [part('a', 'Run1'), part('b', 'Run2')]
    const first = sceneTags(parts)
    expect(first.map((t) => t.name)).toEqual(['Run1', 'Run2'])
    expect(sceneTags(parts)).toBe(first)
    const edited = [parts[0]!, part('b', 'Run3')]
    expect(sceneTags(edited).map((t) => t.name)).toEqual(['Run1', 'Run3'])
    expect(sceneTags(parts)).toBe(first)
  })

  it('keeps the list with disabled parts apart from the one without', () => {
    registerPackage(pkg(TAGGED))
    const parts = [part('a', 'Run1'), part('b', 'Off1', false)]
    expect(sceneTags(parts).map((t) => t.name)).toEqual(['Run1'])
    expect(sceneTags(parts, { includeDisabled: true }).map((t) => t.name)).toEqual(['Run1', 'Off1'])
    expect(sceneTags(parts).map((t) => t.name)).toEqual(['Run1'])
  })

  it('is worked out again when a package changes under the same parts', () => {
    registerPackage(pkg(TAGGED))
    const parts = [part('a', 'Run1')]
    expect(sceneTags(parts)[0]!.type).toBe('BOOL')
    registerPackage(pkg({ ...TAGGED, runTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '' } } as PartPackage['params']))
    expect(sceneTags(parts)[0]!.type).toBe('REAL')
  })
})

describe("a package's param specs, kept", () => {
  it('are the same specs for the same package', () => {
    const p = pkg(TAGGED)
    expect(packageParamSpecs(p)).toBe(packageParamSpecs(p))
    expect(packageParamSpecs(p).map((s) => s.key)).toEqual(['enableComms', 'runTag'])
    expect(packageParamSpecs(pkg(TAGGED))).toEqual(packageParamSpecs(p)) // another package object: its own, the same in content
  })

  it('hand out a default that is a list as a copy of its own each time', () => {
    const p = pkg({ path: { type: 'numberList', arity: 2, default: [[0, 0], [1, 1]], min: 0, max: 5 } } as PartPackage['params'])
    const a = packageParamSpecs(p).find((s) => s.key === 'path') as { default: number[][] }
    const b = packageParamSpecs(p).find((s) => s.key === 'path') as { default: number[][] }
    expect(a.default).toEqual([[0, 0], [1, 1]])
    expect(a.default).not.toBe(b.default)
    a.default[0]![0] = 9 // a part given this list may write to it
    expect(b.default).toEqual([[0, 0], [1, 1]])
    expect((packageParamSpecs(p).find((s) => s.key === 'path') as { default: number[][] }).default).toEqual([[0, 0], [1, 1]])
  })
})
