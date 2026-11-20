import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOTE_STANDARD, TOTE_FOOT_H, TOTE_RIM_DEPTH, TOTE_SIZE, TOTE_STANDARDS, toteCollider, toteSizeOf, toteStandardSize } from './tote'
import { CARGO_KIND_TOTE, cargoFriction, cargoKindName, cargoView, cargoSeatOn } from './frame'
import { PACKAGE_FORMAT } from './parts/partPackage'
import type { PartPackage } from './parts/partPackage'
import { registerPackage } from './parts/partRegistry'
import type { PartInstance } from './types'
import { TOTE_FRICTION } from './types'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

registerPackage({
  format: PACKAGE_FORMAT,
  id: 'test.tote',
  name: 'Tote',
  params: {
    size: { type: 'enum', default: DEFAULT_TOTE_STANDARD, options: TOTE_STANDARDS.map((s) => ({ value: s.value, label: s.label })) },
    mass: { type: 'number', default: 2 },
    color: { type: 'color', default: '#2f6db3' },
  },
  behavior: 'definePart({ step(){} })',
  geometry: { kind: 'cargo', cargoKind: 'tote', size: { length: 0.6, width: 0.4, height: 0.32 } },
} as unknown as PartPackage)
const tote = (params: Record<string, unknown> = {}, at: Partial<PartInstance> = {}): PartInstance =>
  ({ id: 't1', type: 'part', packageId: 'test.tote', position: [0, 0, 0], rotationY: 0, params, ...at }) as unknown as PartInstance

describe('tote sizes', () => {
  it('names every size by its own millimetres, and the default is TOTE_SIZE', () => {
    for (const s of TOTE_STANDARDS) {
      expect(s.value).toBe(`${Math.round(s.length * 1000)}x${Math.round(s.width * 1000)}x${Math.round(s.height * 1000)}`)
      expect(s.length).toBeGreaterThanOrEqual(s.width)
    }
    expect(toteStandardSize(DEFAULT_TOTE_STANDARD)).toEqual([...TOTE_SIZE])
    expect(toteStandardSize('nope')).toEqual([...TOTE_SIZE])
  })

  it('offers the part the same sizes it describes', () => {
    const behavior = readFileSync(join(repo, 'libraries', 'containers', 'tote', 'behavior.js'), 'utf8')
    for (const s of TOTE_STANDARDS) expect(behavior).toContain(`{ value: '${s.value}', label: '${s.label}' }`)
    expect(behavior).toContain(`default: '${DEFAULT_TOTE_STANDARD}'`)
  })

  it('snaps a spawn to a standard size within 6 mm and keeps any other size', () => {
    expect(toteSizeOf()).toEqual([...TOTE_SIZE])
    expect(toteSizeOf([0.603, 0.318, 0.398])).toEqual([0.6, 0.32, 0.4])
    expect(toteSizeOf([0.4, 0.22, 0.3])).toEqual([0.4, 0.22, 0.3])
    expect(toteSizeOf([0.6, 0.4, 0.4])).toEqual([0.6, 0.4, 0.4])
  })
})

describe('tote cargo', () => {
  it('is a tote body at the size its param picks', () => {
    const v = cargoView(tote({ size: '400x300x220' }))!
    expect(v.kind).toBe(CARGO_KIND_TOTE)
    expect(v.halfExtents).toEqual([0.2, 0.11, 0.15])
    expect(v.mass).toBe(2)
    expect(v.color).toBe('#2f6db3')
    expect(cargoView(tote())!.halfExtents).toEqual([0.3, 0.16, 0.2])
  })

  it('has plastic friction and is called a tote', () => {
    expect(cargoFriction(CARGO_KIND_TOTE)).toBe(TOTE_FRICTION)
    expect(cargoKindName(CARGO_KIND_TOTE)).toBe('tote')
  })
})

describe('tote collider', () => {
  for (const t of TOTE_STANDARDS) {
    it(`${t.label}: fills its outer box, is open at the top, and its foot fits the opening of the tote below`, () => {
      const pieces = toteCollider(t.length, t.height, t.width)
      const lo = [0, 1, 2].map((k) => Math.min(...pieces.map((p) => p.center[k]! - p.half[k]!)))
      const hi = [0, 1, 2].map((k) => Math.max(...pieces.map((p) => p.center[k]! + p.half[k]!)))
      const half: [number, number, number] = [t.length / 2, t.height / 2, t.width / 2]
      for (let k = 0; k < 3; k++) {
        expect(lo[k]).toBeCloseTo(-half[k]!, 9)
        expect(hi[k]).toBeCloseTo(half[k]!, 9)
      }
      // nothing covers the middle of the opening
      expect(pieces.filter((p) => p.center[1] + p.half[1] > 0 && Math.abs(p.center[0]) < p.half[0] && Math.abs(p.center[2]) < p.half[2])).toEqual([])
      // the foot is the only piece below the ledge, and it clears the walls' inner faces (the rim's inner edge)
      const below = pieces.filter((p) => p.center[1] - p.half[1] < -half[1] + TOTE_FOOT_H - 1e-9)
      expect(below).toHaveLength(1)
      expect(below[0]!.half[0]).toBeLessThan(half[0]! - TOTE_RIM_DEPTH)
      expect(below[0]!.half[2]).toBeLessThan(half[2]! - TOTE_RIM_DEPTH)
    })
  }
})

describe('cargoSeatOn (where a tote set down on a tote rests)', () => {
  const host = tote({}, { id: 'low', position: [1, 0.16, 2], rotationY: 0.4 })
  it('seats a tote of the same size on its foot, centred on the one below', () => {
    const seat = cargoSeatOn(tote({}, { position: [1.03, 0.6, 1.98], rotationY: 0.4 + Math.PI }), host)!
    expect(seat[0]).toBe(1)
    expect(seat[2]).toBe(2)
    expect(seat[1]).toBeCloseTo(0.16 + 0.32 - TOTE_FOOT_H, 9)
  })

  it('leaves a tote of another size, one turned across, or a tilted one to the plain rest', () => {
    expect(cargoSeatOn(tote({ size: '400x300x220' }), host)).toBeNull()
    expect(cargoSeatOn(tote({}, { rotationY: 0.4 + Math.PI / 2 }), host)).toBeNull()
    expect(cargoSeatOn(tote({}, { rotationY: 0.4, rotationX: 0.2 }), host)).toBeNull()
  })
})
