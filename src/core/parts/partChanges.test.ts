import { describe, expect, it } from 'vitest'
import type { PartPackage } from './partPackage'
import { partChanges, worstImpact } from './partChanges'

function part(over: Partial<PartPackage> = {}): PartPackage {
  return {
    format: 6,
    id: 'test.belt',
    name: 'Belt',
    params: {
      speed: { type: 'number', default: 0.5, min: 0, max: 2, label: 'Speed' },
      run: { type: 'tag', dir: 'in', stType: 'BOOL', default: 'Belt_Run', label: 'Run' },
    },
    behavior: 'definePart({})',
    geometry: { kind: 'rig', links: [], joints: [] } as unknown as PartPackage['geometry'],
    ...over,
  }
}

const subjects = (from: PartPackage, to: PartPackage): string[] => partChanges(from, to).map((c) => `${c.impact}:${c.subject}${c.key ? `:${c.key}` : ''}`)

describe('partChanges', () => {
  it('reports nothing for the same part, whatever its key order, origin or thumbnail', () => {
    const a = part()
    const b: PartPackage = { ...part({ origin: { app: 'x' }, thumbnail: 'data:,' }), params: { run: a.params.run!, speed: { label: 'Speed', max: 2, min: 0, default: 0.5, type: 'number' } } }
    expect(partChanges(a, b)).toEqual([])
    expect(worstImpact(partChanges(a, b))).toBeUndefined()
  })

  it('calls a removed signal, or one whose direction or type changed, breaking', () => {
    const { run: _gone, ...rest } = part().params
    expect(subjects(part(), part({ params: rest }))).toEqual(['breaking:signal:run'])
    const retyped = part({ params: { ...part().params, run: { ...part().params.run!, stType: 'INT', dir: 'out' } } })
    expect(subjects(part(), retyped)).toEqual(['breaking:signal:run', 'breaking:signal:run'])
  })

  it('a new signal or a changed default is a behaviour change, not a break', () => {
    const to = part({ params: { ...part().params, speed: { ...part().params.speed!, default: 1 }, fault: { type: 'tag', dir: 'out', stType: 'BOOL', default: 'Belt_Fault' } } })
    const changes = partChanges(part(), to)
    expect(changes.map((c) => c.impact)).toEqual(['behavior', 'behavior'])
    expect(changes[0]!.text).toContain('0.5 to 1')
    expect(worstImpact(changes)).toBe('behavior')
  })

  it('a comms switch dropped or added is a break: placed copies connect, or disconnect, without a word', () => {
    const switched = part({ commsParam: 'link', params: { ...part().params, link: { type: 'boolean', default: false } } })
    expect(subjects(switched, part())).toEqual(['breaking:param:link', 'breaking:commsParam'])
    // added: copies take the switch's default, and a default of off disconnects every one of them
    expect(subjects(part(), switched)).toEqual(['breaking:commsParam', 'behavior:param:link'])
  })

  it('lists changes most severe first', () => {
    const { speed: _gone, ...rest } = part().params
    const to = part({ name: 'Belt 2', behavior: 'definePart({ v: 2 })', snap: {} as PartPackage['snap'], params: rest })
    expect(partChanges(part(), to).map((c) => c.impact)).toEqual(['breaking', 'placement', 'behavior', 'wording'])
  })

  it('a script change with nothing else changed still says so', () => {
    expect(subjects(part(), part({ behavior: 'definePart({ v: 2 })' }))).toEqual(['behavior:script'])
  })

  it('compares an asset by its hash when it has one, however it holds its bytes', () => {
    const held = part({ assets: [{ id: 'm', mime: 'model/gltf-binary', data: 'AAAA', sha256: 'a'.repeat(64) }] })
    const named = part({ assets: [{ id: 'm', mime: 'model/gltf-binary', url: '/part-assets/x.glb', sha256: 'a'.repeat(64) }] })
    const newer = part({ assets: [{ id: 'm', mime: 'model/gltf-binary', url: '/part-assets/y.glb', sha256: 'b'.repeat(64) }] })
    expect(partChanges(held, named)).toEqual([])
    expect(subjects(named, newer)).toEqual(['appearance:asset:m'])
  })

  it('wording-only edits are wording', () => {
    const to = part({ params: { ...part().params, speed: { ...part().params.speed!, desc: 'Belt speed in m/s' } } })
    expect(subjects(part(), to)).toEqual(['wording:param:speed'])
  })
})
