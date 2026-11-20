import { afterEach, describe, expect, it } from 'vitest'
import type { BeltGuardOpeningSpec, SdkPart } from '../types'
import type { PartPackage } from '../parts/partPackage'
import { PACKAGE_FORMAT } from '../parts/partPackage'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import {
  MIN_SWEEP,
  beltGuardArcRange,
  guardArcRange,
  straightGuardArcRange,
  isolateOnWall,
  moveOpening,
  openingAt,
  openingSpecsToRows,
  openingsOnSide,
  removeFromWall,
  resizeOpeningEdge,
  rowIndexAfterWrite,
  rowsToOpeningSpecs,
  snapArc,
  straightGuardOpenings,
  sweepOpening,
} from './guardOpeningEdit'

const op = (arcStart: number, arcEnd: number, side: BeltGuardOpeningSpec['side']): BeltGuardOpeningSpec => ({
  arcStart,
  arcEnd,
  side,
})

describe('openingsOnSide', () => {
  it('selects matching + both-sided openings, ordered by arcStart', () => {
    const specs = [op(2, 3, 'right'), op(0, 1, 'left'), op(1.5, 2, 'both')]
    expect(openingsOnSide(specs, 'left')).toEqual([1, 2])
    expect(openingsOnSide(specs, 'right')).toEqual([2, 0])
  })

  it('drops collapsed openings (arcEnd <= arcStart)', () => {
    expect(openingsOnSide([op(1, 1, 'left'), op(0, 0.5, 'left')], 'left')).toEqual([1])
  })
})

describe('resizeOpeningEdge', () => {
  it('moves an edge, clamping to [lo, hi]', () => {
    const specs = [op(1, 3, 'left')]
    expect(resizeOpeningEdge(specs, 0, 'start', 2, 0, 4)[0]).toMatchObject({ arcStart: 2, arcEnd: 3 })
    expect(resizeOpeningEdge(specs, 0, 'end', 9, 0, 4)[0]).toMatchObject({ arcStart: 1, arcEnd: 4 })
    expect(resizeOpeningEdge(specs, 0, 'start', -2, 0, 4)[0]).toMatchObject({ arcStart: 0 })
    // a belt's lo is negative (pulley-wrap stub): the edge may go past the tail
    expect(resizeOpeningEdge(specs, 0, 'start', -2, -0.25, 4.25)[0]).toMatchObject({ arcStart: -0.25 })
  })

  it('does not let an edge cross the other edge', () => {
    const specs = [op(1, 3, 'left')]
    expect(resizeOpeningEdge(specs, 0, 'start', 5, 0, 6)[0]!.arcStart).toBe(3) // clamped to arcEnd
    expect(resizeOpeningEdge(specs, 0, 'end', 0, 0, 6)[0]!.arcEnd).toBe(1) // clamped to arcStart
  })
})

describe('sweepOpening', () => {
  it('cuts a single-sided opening from the press to the pointer, in either direction', () => {
    expect(sweepOpening([op(0, 1, 'right')], 'left', 2.5, 1.5, 0, 4)).toEqual({ specs: [op(0, 1, 'right'), op(1.5, 2.5, 'left')], index: 1 })
  })

  it('clamps to the guard, whose belt ends reach past the bed (pulley wrap)', () => {
    expect(sweepOpening([], 'left', -1, 1, -0.25, 4.25)!.specs[0]).toEqual(op(-0.25, 1, 'left'))
  })

  it('writes nothing for a press that barely moved', () => {
    expect(sweepOpening([], 'left', 1, 1 + MIN_SWEEP / 2, 0, 4)).toBeNull()
  })
})

describe('moveOpening', () => {
  it('slides an opening, keeping its width', () => {
    expect(moveOpening([op(1, 2, 'left')], 0, 0.5, 0, 4)[0]).toEqual(op(1.5, 2.5, 'left'))
  })

  it('stops at the guard ends instead of shrinking there', () => {
    expect(moveOpening([op(1, 2, 'left')], 0, 5, 0, 4)[0]).toEqual(op(3, 4, 'left'))
    expect(moveOpening([op(1, 2, 'left')], 0, -5, 0, 4)[0]).toEqual(op(0, 1, 'left'))
  })
})

describe('openingAt', () => {
  it('finds the opening containing s on that wall only; the newest of two overlapping wins', () => {
    const specs = [op(1, 3, 'left'), op(2, 4, 'both'), op(0, 1, 'right')]
    expect(openingAt(specs, 'left', 1.5)).toBe(0)
    expect(openingAt(specs, 'left', 2.5)).toBe(1)
    expect(openingAt(specs, 'right', 1.5)).toBe(-1)
    expect(openingAt(specs, 'right', 0.5)).toBe(2)
  })
})

describe('one wall at a time', () => {
  it('isolateOnWall splits a both-sided row: this wall in place, the other appended', () => {
    expect(isolateOnWall([op(1, 2, 'both'), op(3, 4, 'left')], 0, 'right')).toEqual([op(1, 2, 'right'), op(3, 4, 'left'), op(1, 2, 'left')])
    const single = [op(1, 2, 'left')]
    expect(isolateOnWall(single, 0, 'left')).toBe(single)
  })

  it('removeFromWall leaves a both-sided row cutting the other wall', () => {
    expect(removeFromWall([op(1, 2, 'both')], 0, 'left')).toEqual([op(1, 2, 'right')])
    expect(removeFromWall([op(0, 1, 'left'), op(2, 3, 'left')], 0, 'left')).toEqual([op(2, 3, 'left')])
  })
})

describe('rowIndexAfterWrite', () => {
  it('accounts for the shut rows the write drops', () => {
    const specs = [op(1, 1, 'left'), op(0, 1, 'left'), op(2, 3, 'right')]
    expect(rowIndexAfterWrite(specs, 2)).toBe(1)
    expect(rowIndexAfterWrite(specs, 0)).toBeNull()
  })
})

describe('snapArc', () => {
  it('rounds to the step, or leaves the value alone without one', () => {
    expect(snapArc(1.26, 0.25)).toBeCloseTo(1.25)
    expect(snapArc(1.26, null)).toBe(1.26)
  })
})

describe('straightGuardOpenings', () => {
  it('maps specs to per-side X ranges, clamped, both-sided on both', () => {
    const specs = [op(1, 2, 'left'), op(3, 9, 'right'), op(0.5, 1.5, 'both')]
    const { left, right } = straightGuardOpenings(specs, 4)
    expect(left).toEqual([
      [1, 2],
      [0.5, 1.5],
    ])
    expect(right).toEqual([
      [3, 4], // clamped to length
      [0.5, 1.5],
    ])
  })

  it('drops collapsed/empty openings', () => {
    expect(straightGuardOpenings([op(2, 2, 'left'), op(3, 1, 'left')], 4).left).toEqual([])
  })
})

describe('rows <-> opening specs (SDK belt numberList bridge)', () => {
  it('parses [start, end, side] rows into specs (−1 left / +1 right / 0 both)', () => {
    expect(rowsToOpeningSpecs([[0, 1, -1], [1.5, 2, 1], [2, 3, 0]])).toEqual([
      op(0, 1, 'left'),
      op(1.5, 2, 'right'),
      op(2, 3, 'both'),
    ])
  })

  it('treats a missing side column as both, and skips malformed rows', () => {
    expect(rowsToOpeningSpecs([[0, 1], [Number.NaN as unknown as number], [2, 3, -1]])).toEqual([
      op(0, 1, 'both'),
      op(2, 3, 'left'),
    ])
  })

  it('round-trips specs -> rows -> specs', () => {
    const specs = [op(0, 1, 'left'), op(1.5, 2, 'right'), op(2, 3, 'both')]
    expect(openingSpecsToRows(specs)).toEqual([[0, 1, -1], [1.5, 2, 1], [2, 3, 0]])
    expect(rowsToOpeningSpecs(openingSpecsToRows(specs))).toEqual(specs)
  })

  it('an opening dragged shut is dropped, not saved as a row nothing can select again', () => {
    // resizeOpeningEdge clamps an edge to the other one, so a drag can close an opening to zero width
    const shut = resizeOpeningEdge([op(0, 1, 'left'), op(1.5, 2, 'right')], 1, 'end', 1.2, 0, 4)
    expect(shut[1]!.arcEnd).toBe(shut[1]!.arcStart)
    expect(openingSpecsToRows(shut)).toEqual([[0, 1, -1]])
  })
})

describe('beltGuardArcRange', () => {
  afterEach(() => clearPackages())

  // an SDK belt: `path`-handle segments + width/height + a guardOpenings numberList (arity 3)
  function beltPkg(): PartPackage {
    return {
      format: PACKAGE_FORMAT,
      id: 'acme.belt',
      name: 'Acme Belt', conveyor: { bed: 'path', surface: 'belt' },
      params: {
        segments: { type: 'numberList', arity: 2, default: [[3, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
        width: { type: 'number', default: 0.6 },
        height: { type: 'number', default: 0.5 },
        guardOpenings: { type: 'numberList', arity: 3, default: [] },
      },
      behavior: 'definePart({ step(){} })',
      geometry: { kind: 'drawn', bounds: { length: 3, width: 0.6, top: 0.5 }, conveys: true },
    } as PartPackage
  }
  const belt = (segments: number[][] = [[3, 0]]): SdkPart =>
    ({ id: 'b', type: 'part', packageId: 'acme.belt', position: [0, 0, 0], rotationY: 0, params: { segments, width: 0.6, height: 0.5, guardOpenings: [] } }) as unknown as SdkPart

  it('spans [−pulley, topLength + pulley] for a straight belt', () => {
    registerPackage(beltPkg())
    // single 3 m run, height 0.5 → pulley (end-drum) radius 0.25
    expect(beltGuardArcRange(belt())).toEqual({ lo: -0.25, hi: 3.25 })
  })

  it('grows the range with a multi-segment belt length', () => {
    registerPackage(beltPkg())
    const range = beltGuardArcRange(belt([[2, 0], [2, 0]]))
    expect(range!.lo).toBeCloseTo(-0.25, 10)
    expect(range!.hi).toBeCloseTo(4.25, 10) // 4 m of run + the head pulley wrap
  })

  it('returns null for a part that authors no guardOpenings param', () => {
    const pkg = beltPkg()
    delete (pkg.params as Record<string, unknown>).guardOpenings
    registerPackage(pkg)
    expect(beltGuardArcRange(belt())).toBeNull()
  })

  it('returns null for a non-belt part', () => {
    registerPackage(beltPkg())
    expect(beltGuardArcRange({ id: 'x', type: 'building', position: [0, 0, 0], rotationY: 0, params: {} } as unknown as SdkPart)).toBeNull()
  })

  // the straight (roller) half of the same gizmo: rows stay tail-relative, so the range is the plain bed
  describe('straight beds', () => {
    // a straight SDK roller: conveying rig + length/width `face` handles, opting in to authored openings
    function rollerPkg(withParam = true): PartPackage {
      const params: Record<string, unknown> = {
        length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
        width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
        speed: { type: 'number', default: 0.5 },
      }
      if (withParam) params.guardOpenings = { type: 'numberList', arity: 3, default: [] }
      return {
        format: PACKAGE_FORMAT,
        id: 'acme.roller',
        name: 'Acme Roller',
        conveyor: { bed: 'straight', surface: 'roller' },
        params,
        behavior: 'definePart({ step(){} })',
        geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [4, 0.04, 0.6] }, conveys: true }], joints: [], bounds: { length: 4, width: 0.6, top: 0.9 } },
      } as unknown as PartPackage
    }
    const roller = (length = 4): SdkPart =>
      ({ id: 'r', type: 'part', packageId: 'acme.roller', position: [0, 0, 0], rotationY: 0, params: { length, width: 0.6, speed: 0.5, guardOpenings: [] } }) as unknown as SdkPart

    it('spans the plain bed [0, length] - no pulley wrap to reach past', () => {
      registerPackage(rollerPkg())
      expect(straightGuardArcRange(roller(4))).toEqual({ lo: 0, hi: 4 })
      expect(straightGuardArcRange(roller(2.5))).toEqual({ lo: 0, hi: 2.5 })
    })

    it('returns null without the opt-in param', () => {
      registerPackage(rollerPkg(false))
      expect(straightGuardArcRange(roller())).toBeNull()
    })

    it('guardArcRange serves both families off one call', () => {
      registerPackage(beltPkg())
      registerPackage(rollerPkg())
      expect(guardArcRange(belt())).toEqual({ lo: -0.25, hi: 3.25 })
      expect(guardArcRange(roller(4))).toEqual({ lo: 0, hi: 4 })
      expect(guardArcRange({ id: 'x', type: 'building', position: [0, 0, 0], rotationY: 0, params: {} } as unknown as SdkPart)).toBeNull()
    })
  })
})
