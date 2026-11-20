// A part's stored stock is authored (PartPackage.holds): real cargo parts at its gripper positions, parented to it.
// A synthetic holder here (three gripper positions stacked 0.2 apart above a 0.5 m datum, a capacity param) pins the
// rules without the real dispenser (src/sim/palletDispenser.test.ts runs that one).

import { beforeEach, describe, expect, it } from 'vitest'
import { emptyHolds, fillHolds, holdCount, holdPositions, holdsOf } from './heldStock'
import { PACKAGE_FORMAT } from './parts/partPackage'
import { validatePartPackage } from './parts/partValidate'
import type { PartPackage } from './parts/partPackage'
import { clearPackages, registerPackage } from './parts/partRegistry'
import type { PartInstance, SceneJSON, SdkPart } from './types'

const HOLDER = 'acme.holder'
const TOTE = 'acme.tote'

function holder(holds: PartPackage['holds'] | null = { part: TOTE, positions: ['s0', 's1', 's2'], limitParam: 'capacity' }): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: HOLDER,
    name: 'Holder',
    params: { capacity: { type: 'number', default: 3 } },
    behavior: 'definePart({})',
    geometry: {
      kind: 'rig',
      links: [0, 1, 2].map((i) => ({ name: `s${i}`, shape: { kind: 'frame' as const }, offset: [0, 0.5 + i * 0.2, 0] as [number, number, number], grip: { zone: { size: [0.4, 0.16, 0.3] as [number, number, number], offset: [0, 0.1, 0] as [number, number, number] } } })),
      joints: [],
      bounds: { length: 1, width: 1, top: 1.2 },
    },
    ...(holds ? { holds } : {}),
  }
}
const tote: PartPackage = {
  format: PACKAGE_FORMAT,
  id: TOTE,
  name: 'Tote',
  params: {},
  behavior: 'definePart({})',
  geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.3, 0.2, 0.2] }, offset: [0, 0, 0] }], joints: [], bounds: { length: 0.3, width: 0.2, top: 0.1 } },
}

const placed = (rotationY = 0, capacity = 3): SdkPart => ({ id: 'h1', type: 'part', packageId: HOLDER, position: [2, 0, 1], rotationY, params: { capacity } })
const sceneWith = (...parts: PartInstance[]): SceneJSON => ({ version: 1, parts }) as unknown as SceneJSON

beforeEach(() => {
  clearPackages()
  registerPackage(holder())
  registerPackage(tote)
})

describe('holds (stored stock is authored cargo at the gripper positions)', () => {
  it('puts each position at its grip zone centre, bottom first, turned and moved with the part', () => {
    const h = holdsOf(placed())!
    expect(holdPositions(placed(), h.pkg, h.holds).map((p) => p.centre.map((v) => +v.toFixed(6)))).toEqual([
      [2, 0.6, 1],
      [2, 0.8, 1],
      [2, 1.0, 1],
    ])
    // a gripper link off the part's centre line swings round with the part
    registerPackage({ ...holder(), geometry: { ...(holder().geometry as never as object), links: [{ name: 's0', shape: { kind: 'frame' }, offset: [1, 0.5, 0], grip: { zone: { size: [0.4, 0.16, 0.3], offset: [0, 0.1, 0] } } }] } as PartPackage['geometry'], holds: { part: TOTE, positions: ['s0'] } })
    const turned = placed(Math.PI / 2)
    const h2 = holdsOf(turned)!
    expect(holdPositions(turned, h2.pkg, h2.holds)[0]!.centre.map((v) => +v.toFixed(6))).toEqual([2, 0.6, 0]) // +x turns to -z
  })

  it('Fill places one item per empty position, parented to the holder, and embeds the held package', () => {
    const next = fillHolds(sceneWith(placed()), 'h1')!
    const items = next.parts.filter((p) => p.parent === 'h1')
    expect(items).toHaveLength(3)
    expect(items.every((p) => p.type === 'part' && p.packageId === TOTE && p.name === 'Tote')).toBe(true)
    expect(new Set(next.parts.map((p) => p.id)).size).toBe(next.parts.length) // every id unique
    expect(next.packages?.map((p) => p.id)).toEqual([TOTE])
    expect(holdCount(next, placed())).toEqual({ filled: 3, positions: 3 })
    expect(fillHolds(next, 'h1')).toBeNull() // full: nothing to add
  })

  it('fills only the empty positions, and only as many as the limit param allows', () => {
    const one = fillHolds(sceneWith(placed(0, 1)), 'h1')! // capacity 1: the bottom position only
    expect(one.parts.filter((p) => p.parent === 'h1')).toHaveLength(1)
    const bottom = one.parts.find((p) => p.parent === 'h1')!
    const all = fillHolds({ ...one, parts: one.parts.map((p) => (p.id === 'h1' ? placed(0, 3) : p)) }, 'h1')!
    const items = all.parts.filter((p) => p.parent === 'h1')
    expect(items).toHaveLength(3)
    expect(items.filter((p) => p.id === bottom.id)).toHaveLength(1) // the one there is kept, not doubled
  })

  it('Empty removes the held items and nothing else', () => {
    const other: PartInstance = { id: 'x1', type: 'part', packageId: TOTE, position: [9, 0, 9], rotationY: 0, params: {} } as PartInstance
    const full = fillHolds(sceneWith(placed(), other), 'h1')!
    const emptied = emptyHolds(full, 'h1')!
    expect(emptied.parts.map((p) => p.id).sort()).toEqual(['h1', 'x1'])
    expect(emptyHolds(emptied, 'h1')).toBeNull()
  })

  it('a part without holds offers neither', () => {
    registerPackage(holder(null))
    expect(holdsOf(placed())).toBeNull()
    expect(fillHolds(sceneWith(placed()), 'h1')).toBeNull()
  })

  it('validation: positions must be gripper links, the limit a number param', () => {
    const bad = (holds: unknown): string[] => validatePartPackage({ ...holder(), holds }).map((p) => p.field)
    expect(bad({ part: TOTE, positions: ['s0', 's1'] })).toEqual([])
    expect(bad({ part: TOTE, positions: ['s0', 'nope'] })).toEqual(['holds.positions[1]'])
    expect(bad({ part: '', positions: [] })).toEqual(['holds.part', 'holds.positions'])
    expect(bad({ part: TOTE, positions: ['s0'], limitParam: 'missing' })).toEqual(['holds.limitParam'])
    expect(bad({ part: TOTE, positions: ['s0'], params: { size: 'capacity' } })).toEqual([])
    expect(bad({ part: TOTE, positions: ['s0'], params: { size: 'missing' } })).toEqual(['holds.params.size'])
    expect(bad({ part: TOTE, positions: ['s0'], params: ['capacity'] })).toEqual(['holds.params'])
    // `link#i` names a copy of a posable gripper array, and nothing else
    expect(bad({ part: TOTE, positions: ['s0#0'] })).toEqual(['holds.positions[0]']) // s0 is a plain gripper link
  })

  it('a posable gripper array holds one item per copy, each at its rest place in the row', () => {
    const row = holder({ part: TOTE, positions: ['s#0', 's#1', 's#2'], limitParam: 'capacity' })
    row.geometry = { kind: 'rig', links: [{ name: 's', shape: { kind: 'frame' }, offset: [0, 0.5, 0], grip: { zone: { size: [0.4, 0.16, 0.3], offset: [0, 0.1, 0] } }, array: { count: 'capacity', step: [0, 0.2, 0], posable: true } }], joints: [] }
    expect(validatePartPackage(row)).toEqual([])
    registerPackage(row)
    const pos = holdPositions(placed(0, 3), row, row.holds!)
    expect(pos.map((p) => p.gripper)).toEqual(['s#0', 's#1', 's#2'])
    expect(pos.map((p) => Math.round(p.centre[1] * 1e6) / 1e6)).toEqual([0.6, 0.8, 1]) // 0.5 + i * 0.2 + the zone's 0.1
    expect(holdPositions(placed(0, 2), row, row.holds!)).toHaveLength(2) // a smaller capacity: fewer copies, fewer positions
  })

  it('Fill hands each item the holder params its holds.params names', () => {
    clearPackages()
    registerPackage(holder({ part: TOTE, positions: ['s0', 's1', 's2'], limitParam: 'capacity', params: { load: 'capacity' } }))
    registerPackage(tote)
    const next = fillHolds(sceneWith(placed(0, 2)), 'h1')!
    const items = next.parts.filter((p) => p.parent === 'h1') as SdkPart[]
    expect(items).toHaveLength(2)
    for (const it of items) expect(it.params.load).toBe(2)
  })
})
