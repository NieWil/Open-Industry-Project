import { describe, expect, it } from 'vitest'
import { dockDoors, editBuildingParams, perimeterSides } from './buildingEdit'
import { defaultBuilding } from '../scene/scene'
import type { BuildingPart, BuildingWallRule } from '../types'

const DOCK: BuildingWallRule = { wall: 'dock_door', run: 1, gap: 0, count: 2, start: 10, doorCount: 2, trailer: true }

/** a 5 x 4 building whose only rule cuts two double dock bays into cells 10 and 11 (the left wall) */
function building(openDoors?: string[]): BuildingPart {
  const b = defaultBuilding()
  b.params.rules = [{ ...DOCK }]
  if (openDoors) b.params.openDoors = openDoors
  return b
}

describe('building edits without the editor', () => {
  it('lists the perimeter order and every dock door with its key, wall and world position', () => {
    expect(perimeterSides(5, 4).map((s) => `${s.side} ${s.first}-${s.last}`)).toEqual(['front 0-4', 'back 5-9', 'left 10-13', 'right 14-17'])
    const doors = dockDoors(building(['10:1']))
    expect(doors.map((d) => d.key)).toEqual(['10:0', '10:1', '11:0', '11:1'])
    expect(doors.every((d) => d.side === 'left' && d.x === -25)).toBe(true)
    expect(doors.filter((d) => d.open).map((d) => d.key)).toEqual(['10:1'])
  })

  it('sets size, rules and open doors, and reports each change', () => {
    const r = editBuildingParams(building(), { lengthSections: 6, openDoors: '10:0,11:1' })
    expect(r.params.lengthSections).toBe(6)
    // the rule's start now lands on the back wall (cells 6-11), so the doors are 10:* and 11:* still
    expect(r.params.openDoors).toEqual(['10:0', '11:1'])
    expect(r.changes.map((c) => c.key).sort()).toEqual(['lengthSections', 'openDoors'])
  })

  it('fills a dock rule the way loading does, and refuses a bad field instead of clamping it', () => {
    const r = editBuildingParams(building(), { rules: [{ wall: 'dock_door', run: 1, gap: 0, count: 1, start: 0 }] })
    expect(r.params.rules).toEqual([{ wall: 'dock_door', run: 1, gap: 0, count: 1, start: 0, doorCount: 1, trailer: true }])
    expect(() => editBuildingParams(building(), { rules: [{ ...DOCK, doorCount: 3 }] })).toThrow(/doorCount=3 is not a whole number from 1 to 2/)
    expect(() => editBuildingParams(building(), { rules: [{ ...DOCK, wall: 'garage' }] })).toThrow(/wall="garage" is not one of/)
    expect(() => editBuildingParams(building(), { rules: [{ ...DOCK, dors: 2 }] })).toThrow(/has no field "dors"/)
    expect(() => editBuildingParams(building(), { rules: [{ wall: 'A', run: 1 }] })).toThrow(/needs gap/)
    expect(() => editBuildingParams(building(), { rules: 'dock' })).toThrow(/a JSON list of rules/)
  })

  it('refuses an open door the rules do not cut, and names the doors that exist', () => {
    expect(() => editBuildingParams(building(), { openDoors: ['3:0'] })).toThrow(/names 3:0, which the wall rules do not cut \(the dock doors are: 10:0, 10:1, 11:0, 11:1/)
    expect(() => editBuildingParams(building(), { roofs: false })).toThrow(/a building has no param "roofs"/)
  })

  it('drops open doors the new rules no longer cut, and says so', () => {
    const notes: string[] = []
    const r = editBuildingParams(building(['10:0', '11:1']), { rules: [{ ...DOCK, count: 1 }] }, notes)
    expect(r.params.openDoors).toEqual(['10:0'])
    expect(notes).toEqual(['openDoors: 11:1 dropped, since the wall rules no longer cut that door'])
    // every door gone leaves no openDoors at all, as a saved building with none has
    expect('openDoors' in editBuildingParams(building(['10:0']), { rules: [] }).params).toBe(false)
  })

  it('notes a rule whose start wraps past the last perimeter cell', () => {
    const notes: string[] = []
    editBuildingParams(building(), { rules: [{ ...DOCK, start: 20 }] }, notes)
    expect(notes).toEqual(['rules[0].start 20 is past the last perimeter cell (17), so it wraps to 2'])
  })

  it('an unchanged value is no change', () => {
    expect(editBuildingParams(building(['10:0']), { lengthSections: 5, openDoors: ['10:0'] }).changes).toEqual([])
  })
})
