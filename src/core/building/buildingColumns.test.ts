import { describe, expect, it } from 'vitest'
import { columnLines, interiorColumns } from './buildingColumns'

const bld = (lengthSections: number, widthSections: number, columnSpacing?: number) => ({
  params: { lengthSections, widthSections, heightSections: 1, ...(columnSpacing !== undefined ? { columnSpacing } : {}) },
}) as Parameters<typeof interiorColumns>[0]

describe('columnLines', () => {
  it('has none when the grid is off or the side is one bay or less', () => {
    expect(columnLines(5, 0)).toEqual([])
    expect(columnLines(4, 4)).toEqual([])
    expect(columnLines(3, 4)).toEqual([])
  })

  it('sits on the 10 m section lines, never on the perimeter', () => {
    expect(columnLines(4, 2)).toEqual([0])
    expect(columnLines(6, 2)).toEqual([-10, 10])
    expect(columnLines(4, 1)).toEqual([-10, 0, 10])
  })

  it('splits a remainder between the end bays so the grid is centred', () => {
    // 8 sections every 3: bays 1 | 3 | 3 | 1
    expect(columnLines(8, 3)).toEqual([-30, 0, 30])
    // 6 every 4: bays 1 | 4 | 1
    expect(columnLines(6, 4)).toEqual([-20, 20])
  })
})

describe('interiorColumns', () => {
  it('is empty for a building saved before the param existed', () => {
    expect(interiorColumns(bld(10, 10))).toEqual([])
  })

  it('stands a column at every crossing of the two directions', () => {
    expect(interiorColumns(bld(6, 4, 2))).toEqual([{ x: -10, z: 0 }, { x: 10, z: 0 }])
  })

  it('has none when either direction is clear-spanned', () => {
    // 60 m long but only 20 m wide: the width spans clear, so nothing needs to stand inside
    expect(interiorColumns(bld(6, 2, 2))).toEqual([])
  })
})
