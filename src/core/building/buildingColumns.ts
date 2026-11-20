// Interior columns: the building's column grid, computed in one place for every consumer.
//
// A real warehouse over ~30-40 m does not clear-span: the roof sits on a grid of interior steel columns, and
// conveyor routes, spurs and rack aisles are laid out around that grid. The building's `columnSpacing` param
// turns one on. Physics (sim/buildingColliders.ts buildingBoxes), the drawn columns (render/parts/building.ts) and the
// layout check (checkLayout.ts) all read the stations from here, so the collider, the drawn column and the
// check-layout warning cannot drift apart.
//
// The grid sits on the building's 10 m section lines (the same grid the wall, roof and floor modules tile),
// every `columnSpacing` sections, with any remainder split between the two end bays so the grid sits centred.
// A column stands at every crossing of an X line and a Z line; a direction whose span is clear (fewer
// sections than the spacing) has no lines, and so the building has no interior columns at all.

import { BUILDING_SECTION_SIZE, buildingEaveHeight } from '../types'
import type { BuildingPart } from '../types'

/** a column's square footprint (m): a ~W14 steel section, flange width and depth alike */
export const INTERIOR_COLUMN_SIZE = 0.4

/**
 * The interior grid lines along one side, as local offsets from the building centre. `sections` is that
 * side's length in sections; `spacing` is the grid pitch in sections (0 or less = no grid). Lines on the
 * perimeter are never returned: the wall framing already carries a column there.
 */
export function columnLines(sections: number, spacing: number): number[] {
  const s = Math.floor(spacing)
  const n = Math.floor(sections)
  if (!(s >= 1) || n <= s) return [] // a side no longer than one bay is clear-spanned
  const offset = Math.floor((n % s) / 2)
  const out: number[] = []
  for (let i = offset === 0 ? s : offset; i < n; i += s) {
    if (i > 0) out.push((i - n / 2) * BUILDING_SECTION_SIZE)
  }
  return out
}

/** every interior column's centre, in building-local XZ (x along lengthSections, z along widthSections) */
export function interiorColumns(part: Pick<BuildingPart, 'params'>): { x: number; z: number }[] {
  const { lengthSections, widthSections } = part.params
  const spacing = part.params.columnSpacing ?? 0
  const xs = columnLines(lengthSections, spacing)
  const zs = columnLines(widthSections, spacing)
  const out: { x: number; z: number }[] = []
  for (const x of xs) for (const z of zs) out.push({ x, z })
  return out
}

/**
 * How far the roof deck sits above the eave. The eave is only where the walls stop: the tiled roof modules
 * (public/models/building/Roof_A/B.glb) stand on it with their trusses between 1.9 m and 5.74 m and the
 * deck's underside at 5.743 m, measured from the GLBs. A column that stops at the eave stands short of
 * the trusses, in the air under them.
 */
export const BUILDING_ROOF_DECK_RISE = 5.743

/** a column runs from the floor to the underside of the roof deck */
export function interiorColumnHeight(part: Pick<BuildingPart, 'params'>): number {
  return buildingEaveHeight(part.params.heightSections) + BUILDING_ROOF_DECK_RISE
}
