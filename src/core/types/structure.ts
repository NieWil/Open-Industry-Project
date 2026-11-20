// Static structure: the warehouse shell. Platforms, stairs, storage racks and floor markings are SDK parts
// (see docs/architecture.md); only the Building shell, which has no rig+behavior SDK equivalent, is a
// built-in type. Params + Part interface + the PART_DEFS fragment.
import {
  bool,
  color,
  num,
  type BuildingWallRule,
  type PartBase,
  type PartDef,
} from './base'

/**
 * The warehouse shell. At most one per scene;
 * visibility toggles are viewing aids only - wall physics stays regardless.
 * Dimensions are in 10 m grid sections;
 * the visual tiles the real Wall/Roof/Floor GLB modules on that grid.
 */
export interface BuildingParams {
  /** footprint along local X, in BUILDING_SECTION_SIZE modules */
  lengthSections: number
  /** footprint along local Z, in modules */
  widthSections: number
  /** stacked full-wall layers; eave = n*FULL_WALL */
  heightSections: number
  /**
   * Interior column grid pitch, in sections (core/building/buildingColumns.ts). 0 = clear span, no interior columns.
   * Optional in the type because documents saved before it existed lack it; loading fills the default.
   */
  columnSpacing?: number
  floorVisible: boolean
  wallsVisible: boolean
  roofVisible: boolean
  /**
   * Perimeter wall pattern painted over the default Wall_D. A rule with `wall: 'dock_door'` cuts a loading-dock bay
   * (surround + sliding door + auto leveler, + optional container trailer) into
   * the ground floor; `wall: 'personnel_door'` puts a shut exit door (with its EXIT sign, extinguisher and pull station) in the middle of a ground-floor Wall_D cell.
   * Empty = a plain warehouse shell.
   */
  rules: BuildingWallRule[]
  /**
   * Open dock-door leaves, as stable `"<cellIdx>:<leafIdx>"` keys. Each leaf is toggled independently by Use in
   * pilot mode - there is no building-wide control. Absent/empty = all closed.
   * Runtime state, not a configured param, so it has no PART_DEFS entry; it is
   * round-tripped explicitly by validate/serializeScene.
   */
  openDoors?: string[]
  /** directional + ambient light multiplier */
  brightness: number
  /** scene clear/sky color (hex) */
  backgroundColor: string
  // Shadow-map resolution is not a building param. It names a texture size, so it belongs to
  // the viewer's machine, not the scene: the render tier already clamps it per device, and as a
  // shared param a collab peer could dictate every other viewer's shadow memory (and trip the
  // WebGPU live-resize blackout). It lives in src/render/quality.ts as a client preference.
}

export interface BuildingPart extends PartBase { type: 'building'; params: BuildingParams }

export const STRUCTURE_DEFS: Record<'building', PartDef> = {
  building: {
    type: 'building',
    label: 'Building',
    category: 'Structure',
    defaultY: 0,
    resize: {},
    params: [
      num('lengthSections', 'Length sections', 4, 2, Infinity, 1, '× 10 m'),
      num('widthSections', 'Width sections', 3, 2, Infinity, 1, '× 10 m'),
      num('heightSections', 'Height sections', 1, 1, Infinity, 1, ''),
      num('columnSpacing', 'Interior columns every', 0, 0, 10, 1, '× 10 m', 'Columns'),
      { kind: 'wallRules', key: 'rules', label: 'Wall rules', group: 'Walls', default: [] },
      bool('floorVisible', 'Floor', true, 'Visibility'),
      bool('wallsVisible', 'Walls', true, 'Visibility'),
      bool('roofVisible', 'Roof', true, 'Visibility'),
      num('brightness', 'Brightness', 1, 0, 3, 0.05, '', 'Lighting'),
      color('backgroundColor', 'Background Color', '#9fb1c4', 'Lighting'),
    ],
  },
}
