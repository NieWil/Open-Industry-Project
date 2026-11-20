import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeDeckClusters } from './deckClusters'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartPackage } from './parts/partPackage'
import type { SdkPart, PartInstance } from './types'
import { PACKAGE_FORMAT } from './parts/partPackage'

// Only belt-like custom/SDK parts merge their decks (computeDeckClusters → isMergeable → custom && isBeltLike).
// A belt-like SDK part has segments + half-pulley ends, so the generic merge cases (butt / gap / perpendicular /
// chain) run on customBelt, alongside the SDK-only exclusion cases.

// a belt-like custom/SDK part (declares a `path` handle): width 0.6 + length-4 flat bed + height-0.5 pulleys.
function customBeltPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.belt',
    name: 'Acme Belt', conveyor: { bed: 'path', surface: 'belt' },
    params: {
      segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
      width: { type: 'number', default: 0.6 },
      height: { type: 'number', default: 0.5 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
  } as PartPackage
}

function belt(id: string, x: number, z: number, rotationY = 0, length = 4): SdkPart {
  return { id, type: 'part', packageId: 'acme.belt', position: [x, 2, z], rotationY, params: { segments: [[length, 0]], width: 0.6, height: 0.5 } } as unknown as SdkPart
}

function scene(...parts: PartInstance[]): PartInstance[] {
  return parts
}

describe('computeDeckClusters', () => {
  beforeEach(() => registerPackage(customBeltPkg()))
  afterEach(() => clearPackages())

  // length 4 + 2*pulley(0.25) => butting centres are 4.5 apart along the flow axis
  it('merges two belts butted end-to-end', () => {
    const m = computeDeckClusters(scene(belt('a', -2.25, 0), belt('b', 2.25, 0)))
    expect(m.get('a')?.members.map((p) => p.id)).toEqual(['a', 'b'])
    expect(m.get('a')?.ownerId).toBe('a')
    expect(m.get('b')?.ownerId).toBe('a')
  })

  it('does not merge belts with a gap between their ends', () => {
    // 0.5 m past the butting distance: ends are well beyond the touch tolerance
    const m = computeDeckClusters(scene(belt('a', -2.25, 0), belt('b', 2.75, 0)))
    expect(m.get('a')?.members).toHaveLength(1)
    expect(m.get('b')?.members).toHaveLength(1)
  })

  it('does not merge a perpendicular (end-to-side) L junction', () => {
    // b is rotated 90deg with its back end landing on a's front end, but the end
    // normals are perpendicular, not opposed -> a side junction, not a deck butt.
    const m = computeDeckClusters(scene(belt('a', 0, 0, 0), belt('b', 2.25, -2.25, Math.PI / 2)))
    expect(m.get('a')?.members).toHaveLength(1)
    expect(m.get('b')?.members).toHaveLength(1)
  })

  it('merges a chain of three into one cluster owned by the lowest id', () => {
    const m = computeDeckClusters(scene(belt('c', 4.5, 0), belt('a', -4.5, 0), belt('b', 0, 0)))
    expect(m.get('b')?.members.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(m.get('b')?.ownerId).toBe('a')
  })

  it('a non-belt-like custom part stays out of clusters', () => {
    registerPackage({ ...customBeltPkg(), id: 'acme.box', params: { width: { type: 'number', default: 1 } } } as PartPackage)
    const box = { id: 'x', type: 'part', packageId: 'acme.box', position: [2.25, 2, 0], rotationY: 0, params: {} } as unknown as SdkPart
    const m = computeDeckClusters(scene(belt('a', -2.25, 0), box))
    expect(m.has('x')).toBe(false)
    expect(m.get('a')?.members).toHaveLength(1)
  })

  // a straight `face`-handle SDK conveyor (the spur/roller family) contributes no cluster deck facets - its
  // deck is built by its own scripted spawn path. If it merged and became the lowest-id owner, no member would
  // build the cluster deck at all (non-owner members early-return) and cargo would fall through the whole run.
  it('a straight face-handle SDK conveyor (spur) does not merge with a butted belt', () => {
    registerPackage({
      ...customBeltPkg(),
      id: 'acme.spur',
      params: {
        length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
        width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      },
    } as unknown as PartPackage)
    // belt 'b' front end is at world x=2.0; the centre-origin spur (length 4) at x=4 butts its back end there -
    // spur id 'a' < 'b' would make the deck-less spur the cluster owner if it were allowed to merge.
    const spur = { id: 'a', type: 'part', packageId: 'acme.spur', position: [4, 2, 0], rotationY: 0, params: { length: 4, width: 0.6 } } as unknown as SdkPart
    const m = computeDeckClusters(scene(belt('b', -2.25, 0), spur))
    expect(m.has('a')).toBe(false)
    expect(m.get('b')?.members).toHaveLength(1)
  })
})
