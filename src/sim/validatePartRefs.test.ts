// Author-time data checks (core/parts/partAuthoringChecks.ts + sim/validatePart.ts): a corpus of parts, each broken
// in one realistic way that would otherwise load, bake and silently do nothing. Each must fail validation;
// the unbroken control must pass.

import { describe, expect, it } from 'vitest'
import { validatePart } from './validatePart'
import type { PackageManifest } from './buildPackage'
import { checkGeometryRefs } from '../core/parts/partAuthoringChecks'
import type { PartPackageGeometry } from '../core/parts/partPackage'

type M = PackageManifest & { geometry: { links: any[]; joints: any[]; inclineParam?: string } } // eslint-disable-line @typescript-eslint/no-explicit-any -- specs build deliberately malformed links and joints

const P = (extra = ''): string => `{ width: { type: 'number', default: 1, min: 0.2, max: 3 }, on: { type: 'boolean', default: true }, tint: { type: 'color', default: '#ff8800' }, mode: { type: 'enum', default: 'a', options: [{ value: 'a' }, { value: 'b' }] }, runTag: { type: 'tag', default: '', dir: 'in', stType: 'BOOL' }, n: { type: 'number', default: 3, min: 1, max: 9 }${extra} }`
const beh = (params = P()): string => `definePart({ params: ${params}, joints: ['lift'], lamps: ['lamp'], step(ctx) {} })`
const base = (): M => ({ id: 'acme.t', name: 'T', geometry: { kind: 'rig', bounds: { length: 1, width: 1, top: 1 }, joints: [{ name: 'lift', link: 'carriage', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.3 }], links: [
  { name: 'body', shape: { kind: 'box', size: [1, 0.2, 1], sizeParams: [{ axis: 0, param: 'width' }] }, offset: [0, 0.1, 0], colorParam: 'tint', showParam: 'on' },
  { name: 'carriage', shape: { kind: 'frame' }, offset: [0, 0.2, 0] },
  { name: 'lamp', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0.3, 0], lamps: [{ emissive: [1, 0, 0], param: 'on' }] },
  { name: 'eye', shape: { kind: 'frame' }, offset: [0, 0.1, 0.5], beam: { range: 2 } },
  { name: 'posts', shape: { kind: 'box', size: [0.05, 0.5, 0.05] }, offset: [0, 0.25, 0], array: { count: 'n', step: [0.2, 0, 0] } },
] } })
const L = (m: M, i: number) => m.geometry.links[i]
const cases: [string, (m: M) => unknown, string][] = [
  ['clean (control)', (m) => m, beh()],
  ['sizeParams -> missing param', (m) => { L(m, 0).shape.sizeParams[0].param = 'widht' }, beh()],
  ['sizeParams -> boolean param', (m) => { L(m, 0).shape.sizeParams[0].param = 'on' }, beh()],
  ['colorParam -> missing', (m) => { L(m, 0).colorParam = 'colour' }, beh()],
  ['colorParam -> number param', (m) => { L(m, 0).colorParam = 'width' }, beh()],
  ['showParam -> missing', (m) => { L(m, 0).showParam = 'visible' }, beh()],
  ['showParam -> number param', (m) => { L(m, 0).showParam = 'width' }, beh()],
  ['lamp param -> missing', (m) => { L(m, 2).lamps[0].param = 'lit' }, beh()],
  ['array.count -> missing', (m) => { L(m, 4).array.count = 'count' }, beh()],
  ['array.count -> boolean', (m) => { L(m, 4).array.count = 'on' }, beh()],
  ['offsetParams -> missing', (m) => { L(m, 1).offsetParams = [{ axis: 0, param: 'len' }] }, beh()],
  ['offsetParams mulParam -> missing', (m) => { L(m, 1).offsetParams = [{ axis: 0, param: 'width', mulParam: 'k' }] }, beh()],
  ['beam.rangeParam -> missing', (m) => { L(m, 3).beam.rangeParam = 'maxRange' }, beh()],
  ['joint rest.param -> missing', (m) => { m.geometry.joints[0].rest = { param: 'height' } }, beh()],
  ['inclineParam -> missing', (m) => { m.geometry.inclineParam = 'incline' }, beh()],
  ['label textParam -> missing', (m) => { m.geometry.links.push({ name: 'cap', shape: { kind: 'label', textParam: 'caption' }, offset: [0, 0, 0] }) }, beh()],
  ['zone sizeParams -> missing', (m) => { L(m, 3).zone = { size: [1, 1, 1], sizeParams: [{ axis: 0, param: 'zlen' }] } }, beh()],
  ['number default > max', (m) => m, beh(P(", k: { type: 'number', default: 5, min: 0, max: 2 }"))],
  ['number min > max', (m) => m, beh(P(", k: { type: 'number', default: 1, min: 3, max: 2 }"))],
  ['number default is a string', (m) => m, beh(P(", k: { type: 'number', default: '1' }"))],
  ['boolean default is a string', (m) => m, beh(P(", k: { type: 'boolean', default: 'false' }"))],
  ['enum default not an option', (m) => m, beh(P(", k: { type: 'enum', default: 'c', options: [{ value: 'a' }] }"))],
  ['enum with no options', (m) => m, beh(P(", k: { type: 'enum', default: 'a' }"))],
  ['enum duplicate options', (m) => m, beh(P(", k: { type: 'enum', default: 'a', options: [{ value: 'a' }, { value: 'a' }] }"))],
  ['color default not hex', (m) => m, beh(P(", k: { type: 'color', default: 'red' }"))],
  ['unknown param type', (m) => m, beh(P(", k: { type: 'float', default: 1 }"))],
  ['tag dir invalid', (m) => m, beh(P(", k: { type: 'tag', default: '', dir: 'input', stType: 'BOOL' }"))],
  ['tag stType invalid', (m) => m, beh(P(", k: { type: 'tag', default: '', dir: 'in', stType: 'BOOLEAN' }"))],
  ['tag with no dir or stType', (m) => m, beh(P(", k: { type: 'tag', default: '' }"))],
  ['numberList default not rows', (m) => m, beh(P(", k: { type: 'numberList', default: [1, 2] }"))],
  ['numberList row arity', (m) => m, beh(P(", k: { type: 'numberList', arity: 2, default: [[1, 2, 3]] }"))],
  ['visibleWhen -> missing param', (m) => m, beh(P(", k: { type: 'number', default: 1, visibleWhen: { param: 'advanced', is: true } }"))],
  ['visibleWhen value -> not an option', (m) => m, beh(P(", k: { type: 'number', default: 1, visibleWhen: { param: 'mode', is: ['a', 'c'] } }"))],
  ['visibleWhen value -> a boolean switch', (m) => m, beh(P(", k: { type: 'number', default: 1, visibleWhen: { param: 'on', is: 'yes' } }"))],
  ['stamps -> missing numberList', (m) => m, beh(P(", k: { type: 'enum', default: 'a', options: [{ value: 'a', rows: [[1, 2]] }], stamps: 'segments' }"))],
  ['whenAbsent on a number', (m) => m, beh(P(", k: { type: 'number', default: 1, whenAbsent: true }"))],
  ['rest on a boolean', (m) => m, beh(P(", k: { type: 'boolean', default: true, rest: 'surfaceBelow' }"))],
  ['face handle on a boolean', (m) => m, beh(P(", k: { type: 'boolean', default: true, handle: { kind: 'face', axis: 'x' } }"))],
  ['path handle on a number', (m) => m, beh(P(", k: { type: 'number', default: 1, handle: { kind: 'path' } }"))],
  ['handle bayParam -> missing', (m) => m, beh(P(", k: { type: 'number', default: 1, handle: { kind: 'face', axis: 'x', bayParam: 'bay' } }"))],
  ['rigSize handle -> missing link', (m) => m, beh(P(", k: { type: 'number', default: 1, handle: { kind: 'rigSize', link: 'deck', axis: 'x' } }"))],
  ['setpointFor -> missing param', (m) => m, beh(P(", k: { type: 'tag', default: '', dir: 'in', stType: 'REAL', setpointFor: 'speed' }"))],
  ['no step()', (m) => m, `definePart({ params: ${P()}, joints: ['lift'], lamps: ['lamp'] })`],
  ['declared joint not in rig', (m) => m, `definePart({ params: ${P()}, joints: ['lift', 'tilt'], lamps: ['lamp'], step(ctx) {} })`],
  ['parent -> missing link', (m) => { L(m, 1).parent = 'base' }, beh()],
  ['joint.link -> missing', (m) => { m.geometry.joints[0].link = 'carrier' }, beh()],
  ['link friction out of range', (m) => { L(m, 0).friction = 3 }, beh()],
  ['link friction not a number', (m) => { L(m, 0).friction = '0.2' }, beh()],
  ['link friction on a side guard', (m) => { m.geometry.links.push({ name: 'guard', shape: { kind: 'box', size: [1, 0.1, 0.01] }, offset: [0, 0.3, 0.5], sideGuard: 'right', friction: 0.3 }) }, beh()],
  ['drawn friction on a rig (render-only)', (m) => m, `definePart({ params: ${P()}, joints: ['lift'], lamps: ['lamp'], geometry(g) { return [{ desc: g.box([1, 1, 1], [0, 0.5, 0]), collision: 'hull', friction: 0.1 }] }, step(ctx) {} })`],
]

describe('a solid surface friction', () => {
  const drawn = (): PackageManifest => ({ id: 'acme.slide', name: 'Slide', geometry: { kind: 'drawn', bounds: { length: 1, width: 1, top: 1 } } }) as PackageManifest
  const src = (submesh: string): string => `definePart({ geometry(g) { return [{ desc: g.box([1, 0.1, 1], [0, 0.05, 0]), ${submesh} }] }, step() {} })`
  it('accepts a friction on a link and on a drawn solid', () => {
    const m = base()
    L(m, 0).friction = 0.06
    expect(validatePart(m, beh()).diagnostics).toEqual([])
    expect(validatePart(drawn(), src("collision: 'hull', friction: 0.06")).diagnostics).toEqual([])
  })
  it('refuses a drawn friction out of range, on a submesh with no collision, and on a side guard', () => {
    expect(validatePart(drawn(), src("collision: 'hull', friction: -1")).ok).toBe(false)
    expect(validatePart(drawn(), src('friction: 0.1')).ok).toBe(false)
    expect(validatePart(drawn(), src("collision: 'box', sideGuard: 'left', friction: 0.1")).ok).toBe(false)
  })
})

describe('validatePart catches broken part data', () => {
  it('passes the unbroken control', () => {
    const [, mut, src] = cases[0]!
    const m = base()
    mut(m)
    expect(validatePart(m, src).diagnostics).toEqual([])
  })

  it.each(cases.slice(1))('%s', (_name, mut, src) => {
    const m = base()
    mut(m)
    expect(validatePart(m, src).ok).toBe(false)
  })
})

// squash is structurally a mesh link's (validatePartPackage refuses it elsewhere), so its lamp reference is
// checked on a mesh link directly: through validatePart the structural refusal would fire first and pass the
// case for the wrong reason.
describe('squash names a real lamp', () => {
  const geo = (squash: { amount: number; lamp?: string }): PartPackageGeometry => ({
    kind: 'rig',
    joints: [],
    links: [
      { name: 'led', shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, offset: [0, 0, 0], lamps: [{ emissive: [0, 1, 0] }] },
      { name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] },
      { name: 'cups', shape: { kind: 'mesh', asset: 'glb' }, offset: [0, 0, 0], squash },
    ],
  })
  const fields = (squash: { amount: number; lamp?: string }): string[] => checkGeometryRefs(geo(squash), {}).map((p) => p.field)
  it('accepts a lamp elsewhere in the rig', () => expect(fields({ amount: 0.2, lamp: 'led' })).toEqual([]))
  it('refuses a name that is not a lamp: a missing link, or a link with no lamp', () => {
    expect(fields({ amount: 0.2, lamp: 'nope' })).toEqual(['geometry.links[2].squash.lamp'])
    expect(fields({ amount: 0.2, lamp: 'body' })).toEqual(['geometry.links[2].squash.lamp'])
  })
  it('refuses the default (its own lamp) on a link that has none', () => expect(fields({ amount: 0.2 })).toEqual(['geometry.links[2].squash']))
})

describe('validatePart runs a first tick', () => {
  const m = (): M => ({ id: 'acme.x', name: 'X', geometry: { kind: 'rig', links: [{ name: 'b', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0.5, 0] }], joints: [] } }) as unknown as M
  it('reports a step() that throws at default params', () => {
    const r = validatePart(m(), `definePart({ params: { list: { type: 'numberList', default: [] } }, step(ctx) { ctx.writeTag('x', ctx.params.list[0][0]) } })`)
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => d.message).join()).toMatch(/threw on the first tick/)
  })
  it('reports an init() that throws', () => {
    const r = validatePart(m(), `definePart({ init() { null.x }, step() {} })`)
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => d.message).join()).toMatch(/init\(\) or step\(\) threw/)
  })
})
