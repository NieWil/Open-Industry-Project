// Shared leaf of the scene schema: the pieces every part family (and the ParamSpec
// system) builds on, with no upward dependency on any family file. Family modules
// (conveyors.ts, sensors.ts, …) import from here; the index.ts barrel re-exports
// everything so the public import path stays `core/types`.

import type { ProgramSpec } from '../parts/partApi'
import { PALLET_BLOCK_HALF, PALLET_BLOCK_OFFSET, PALLET_DECK_THICKNESS, PALLET_POCKET_HEIGHT, PALLET_SIZE } from '../pallet'

// v4: the generic SDK-part discriminant renamed 'custom' -> 'part' (there are no code built-ins, so an SDK
// part is the part). See validateScene's migration. v3: conveyor origin moved from the bed centre to the
// tail. v1: roller_conveyor/box_spawner era; v2: pre-tail-origin.
export const SCENE_VERSION = 4

export type PartType =
  | 'building'
  | 'group'
  // A user-authored part imported from a PartPackage (src/core/parts/partPackage.ts). Unlike the container/shell
  // meta types, its params are not static PART_DEFS metadata. They come from the referenced package's baked
  // schema, resolved at runtime via the package registry (src/core/parts/partRegistry.ts). This is the part type:
  // conveyors, devices, structure and cargo are all such parts. Cargo (box, pallet) is a `part` whose package
  // declares `geometry.kind: 'cargo'` - see core/frame.ts cargoView. Stored as 'custom' before v4.
  | 'part'
  // A scene annotation: an icon + a line of text pinned to a place, drawn as a screen-space chip over the
  // viewport rather than as geometry (docs/annotations.md). Like `group` it has no mesh, no body and no sim
  // presence. It is a note about the layout, not a thing in it, so it is readable from any angle and any
  // distance, unlike a sign bolted to a wall. Parent it to a part and soft-parenting carries it along
  // when that part moves.
  | 'annotation'

export type RollerClass = 'light' | 'medium' | 'heavy'

/** duty class -> roller radius + pitch (m); top of roller always at part y=0 */
export const ROLLER_CLASSES: Record<RollerClass, { radius: number; pitch: number }> = {
  light: { radius: 0.024, pitch: 0.075 },
  medium: { radius: 0.03, pitch: 0.1 },
  heavy: { radius: 0.04, pitch: 0.13 },
}

/**
 * One straight run of a multi-segment belt. The path lives
 * in the part's local X-Y plane (+X = segment 0 tangent, +Z cross-belt); `tiltDeg`
 * rotates around +Z, so it inclines/declines the belt in the vertical plane.
 */
export interface BeltSegmentSpec {
  /** nominal length before tangent-fillet insets are deducted, m */
  length: number
  /** tilt relative to the previous segment (path base for segment 0), deg */
  tiltDeg: number
}

/** belt shape presets: stamps a segment template; editing segments drifts to 'custom'. Shared by the belt
 *  path builder (preset → segment template) and the SDK belt's `shapePreset` param picker. */
export type BeltShapePreset = 'custom' | 'straight' | 'zframe' | 'walkthru' | 'noseover'

export type GuardOpeningSide = 'left' | 'right' | 'both'

/** authored side-guard cutout: an arc-length range from the tail */
export interface BeltGuardOpeningSpec {
  /** arc-length from the tail, m */
  arcStart: number
  arcEnd: number
  side: GuardOpeningSide
}

/** wall variant a rule paints (the four wall variants, the dock door, and a personnel door: Wall_D with a shut exit
 *  door in the middle of its ground-floor cell) */
export type WallVariant = 'A' | 'B' | 'C' | 'D' | 'dock_door' | 'personnel_door'
export const WALL_VARIANTS: readonly WallVariant[] = ['A', 'B', 'C', 'D', 'dock_door', 'personnel_door']
/** each whole-number field of a BuildingWallRule: its range and the value loading gives a missing one */
export const WALL_RULE_NUMBERS = {
  run: { min: 1, max: 400, absent: 1 },
  gap: { min: 0, max: 400, absent: 1 },
  count: { min: 0, max: 100, absent: 0 },
  start: { min: 0, max: 400, absent: 0 },
  doorCount: { min: 1, max: 2, absent: 1 },
} as const

/**
 * One painted run over the perimeter walls. Rules are
 * applied in order over the default wall (D); where rules overlap, the later one is used.
 * The perimeter is indexed front (local -Z) → back (+Z) → left (-X) → right (+X),
 * `lengthSections` cells per Z-facing wall and `widthSections` per X-facing wall.
 */
export interface BuildingWallRule {
  /** which wall variant (or a dock or personnel door) this rule paints where it matches */
  wall: WallVariant
  /** consecutive sections painted per run */
  run: number
  /** sections skipped between runs (0 = solid) */
  gap: number
  /** number of runs to paint (0 = unlimited, tile the whole perimeter) */
  count: number
  /** perimeter index where the first run begins */
  start: number
  /** openings per dock-door section, 1 or 2 (only when wall = dock_door) */
  doorCount: number
  /** park a container trailer behind each opening (only when wall = dock_door) */
  trailer: boolean
}

interface PartBaseInternal {
  id: string
  /** display name for the scene tree; defaults to id when absent */
  name?: string
  /** false hides the part's visuals (it still collides and simulates); omitted when visible */
  visible?: boolean
  /**
   * A locked part stays visible and simulates, but the viewport
   * can't pick it (clicks/band/list-select fall through) and it shows no transform
   * gizmo, so it can't be moved by dragging. Still fully editable from the tree.
   * Omitted when unlocked.
   */
  locked?: boolean
  /**
   * "Select as one" (the UI's name; Ctrl+G): when set, clicking any of this part's descendants in the
   * viewport selects this part instead, so the subtree moves as one. Affects viewport click-selection
   * only; the tree still selects parts individually. Omitted when off. Not to be confused with a `group`
   * part (the empty container "Reparent to New Node" makes), which is born with this flag set.
   */
  grouped?: boolean
  /**
   * id of this part's parent in the scene tree, or omitted for a top-level part.
   * "Soft" parenting: positions stay world-space (the sim/renderer are unaffected),
   * but the editor treats the parent + its descendants as a rigid group - moving or
   * rotating a parent carries its subtree, and deleting/duplicating acts on the whole
   * subtree. References must resolve and stay acyclic (see core/scene/hierarchy).
   */
  parent?: string
  /** world meters; conveying-surface top sits at origin y for conveyors */
  position: [number, number, number]
  /** radians about world +Y; 0 = local +X aligned with world +X */
  rotationY: number
  /**
   * radians of pitch (about local X) / roll (about local Z). Omitted = 0 (flat),
   * which is every conveyor/floor part. Composed with rotationY in YXZ
   * Euler order so a tilted part (e.g. an angled sensor) round-trips losslessly
   * to/from a full 3D transform. Planar authoring (snapping, roller grid,
   * footprints) reads rotationY only and ignores these.
   */
  rotationX?: number
  rotationZ?: number
}
// Re-exported under the canonical name; every family file's *Part interface extends this.
export type PartBase = PartBaseInternal

export type ParamValue =
  | number
  | boolean
  | string
  | BuildingWallRule[]
  | string[]
  | number[][]

export interface NumberParamSpec {
  kind: 'number'
  key: string
  label: string
  /** inspector section header; ungrouped params come first */
  group?: string
  min: number
  max: number
  step: number
  unit: string
  default: number
  /**
   * Host-resolved placement fact (SDK `rest`, e.g. a conveyor's `standHeight`): the host writes it from the
   * surface beneath the part, so its value can legitimately exceed the manual-slider `max` (a deck standing on
   * a tall surface). Load-time validation clamps only the `min` for a rest param, never shrinking the value
   * below the deck it pairs with - which would float the legs off the floor on reload. `min`/`max` still bound
   * the Inspector slider for manual tuning. See {@link ParamSchema.rest}.
   */
  rest?: 'surfaceBelow'
  /** a bitmask edited as one checkbox per bit (the SDK's `bits`): the bit count, or the number param holding it */
  bits?: number | string
}

export interface BooleanParamSpec {
  kind: 'boolean'
  key: string
  label: string
  group?: string
  default: boolean
  /** what a part whose saved params lack this key takes, where `default` is what a newly placed one gets (the
   *  SDK's `ParamSpec.whenAbsent`): a new switch must not change what an existing scene's numbers mean */
  whenAbsent?: boolean
  /** the part's units switch, true = imperial (the SDK's `imperialUnits`): set by the scene's Units (SceneJSON
   *  `units`, core/scene/sceneUnits.ts) on every part, never a field of its own */
  imperialUnits?: boolean
}

export interface EnumParamSpec {
  kind: 'enum'
  key: string
  label: string
  group?: string
  /** an option may carry `rows` - a template stamped into the `stamps` numberList param when chosen (custom-part shape presets) */
  options: { value: string; label: string; rows?: number[][] }[]
  default: string
  /**
   * Choosing an option with `rows` stamps them into this `numberList` param (e.g. a belt `shapePreset`
   * stamping `segments`); editing that param drifts the enum to the option whose rows match, or to the first
   * row-less option. Set only for custom-part shape-preset pickers.
   */
  stamps?: string
}

/** a colour: a hex string (#rrggbb) edited via a swatch picker */
export interface ColorParamSpec {
  kind: 'color'
  key: string
  label: string
  group?: string
  default: string
  /** expose an alpha channel (#rrggbbaa) - a full RGBA colour (e.g. floor markings) */
  alpha?: boolean
  /** a list of colours (the SDK's `list`): the value is the `#rrggbb` entries joined by commas, `''` = none */
  list?: boolean
}

/** free-text string (e.g. a pushbutton label) */
export interface TextParamSpec {
  kind: 'text'
  key: string
  label: string
  group?: string
  default: string
  placeholder?: string
  /** what the field suggests while typing (the SDK's `suggest`): `'marks'` = the product marks the scene declares */
  suggest?: 'marks'
  /** the value is a cargo part's package id (the SDK's `product`): edited as a dropdown of the cargo parts */
  product?: boolean
  /** the hidden string param holding the product's settings as JSON (the SDK's `settings`), edited under the dropdown */
  settings?: string
}

/**
 * Reference to another part by id (e.g. the box spawner's `conveyor`). Rendered as a
 * dropdown of scene parts; `partTypes` filters which
 * parts are offered (empty list = any). Stored value is the target part's id, '' = unset.
 */
export interface PartRefParamSpec {
  kind: 'partRef'
  key: string
  label: string
  group?: string
  default: string
  /** part types eligible as the target; omitted/empty = any part */
  partTypes?: readonly PartType[]
}

/**
 * Reference to a PLC tag by name (the editor stand-in for the SDK's `type: 'tag'` param). Rendered as a
 * combobox that autocompletes from the tag names already used elsewhere in the scene, so the person
 * placing a part picks an existing tag instead of retyping (and mistyping) it. Free entry is still
 * allowed - a tag the PLC program hasn't declared yet is a forward reference, not an error - so the
 * stored value is just the tag name string ('' = unbound). `dir` says whether the part reads or
 * writes the tag.
 */
export interface TagRefParamSpec {
  kind: 'tagRef'
  key: string
  label: string
  group?: string
  default: string
  /**
   * Which way the signal flows: 'in' = the part reads the tag, 'out' = the part writes it. It is the part's
   * declared direction (the SDK's `ParamSpec.dir`), carried through from the package. The wiring check
   * (plc/wiring.ts) reads it to find tags nothing drives and tags two parts both write. Required of an authored
   * part (core/parts/partAuthoringChecks.ts); absent only on a stored package saved before `dir` existed, which the check
   * reports as `undeclared` rather than skipping.
   */
  dir?: 'in' | 'out'
  /** the ST scalar the tag carries (the SDK's `ParamSpec.stType`) - pairs with {@link dir} */
  stType?: 'BOOL' | 'INT' | 'DINT' | 'REAL'
  /** the unit of the value the tag carries (the SDK's `ParamSpec.unit`): `'m/s'`, `'FPM'`, `'m'`. A setpoint tag
   *  that declares none takes its {@link setpointFor} param's. Shown as declared: the program reads and writes the
   *  value in it, so the scene's Units never convert it. */
  unit?: string
  /**
   * This tag is an analog setpoint that replaces the named number param while it's bound (the SDK's
   * `setpointFor`): a conveyor's `speedTag` replaces `speed`. The Inspector shows the live commanded
   * value in that param's field - read-only, badged `plc` - instead of the authored one the running
   * scene isn't using. Same units as the target param by contract.
   */
  setpointFor?: string
  /** the part reads this tag only while a program drives it, and runs on its own setting otherwise (the SDK's
   *  `onlyWhenDriven`, or `autoWhenDriven`, which implies it). The wiring check words an undriven warning by it. */
  onlyWhenDriven?: boolean
  /** what each number a code tag carries means (the SDK's `values`), listed on the field */
  values?: { value: number; label: string }[]
}

/**
 * A list of fixed-width numeric rows (the editor stand-in for the SDK's `type: 'numberList'`) - a
 * waypoint/pose/setpoint table. `arity` is the numbers per row (6 = a joint pose, 3 = an XYZ point,
 * 1 = a flat list); `cellLabels` optionally names the columns in the row editor. Rendered as a row grid
 * with add/remove, so the value is structured `number[][]` the author can't make malformed.
 */
export interface NumberListParamSpec {
  kind: 'numberList'
  key: string
  label: string
  group?: string
  /** numbers per row */
  arity: number
  default: number[][]
  /** per-cell clamp + spinner step, applied to every column (optional) */
  min?: number
  max?: number
  step?: number
  /** optional column headers (length should match `arity`) */
  cellLabels?: readonly string[]
  /** a fixed row count (the SDK's `rows`): the grid shows these rows with no Add / Remove */
  rows?: number
  /** the rows are indices into this other numberList (the SDK's `rowsOf`): edited as a checkbox per row of it */
  rowsOf?: string
  /** a string param naming each row, one per line (the SDK's `rowNames`) */
  rowNames?: string
  /** the rows are the steps of numbered programs (the SDK's `program`): edited as programs of steps */
  program?: ProgramSpec
}

/** building perimeter wall-rule list editor */
export interface WallRulesParamSpec {
  kind: 'wallRules'
  key: 'rules'
  label: string
  group?: string
  default: BuildingWallRule[]
}

/**
 * `hidden` applies to every kind (an intersection, so `kind` still narrows): a param the part stores and the
 * engine resolves/clamps like any other, but the Inspector never shows - the SDK's {@link ParamSchema.hidden}.
 * For engine-owned state the user must not hand-edit, e.g. the curved conveyor's
 * snap-set `reverse` flag. Hidden only in the Inspector (Inspector.tsx drops them); createPart / normalizePart
 * / validateScene must keep seeing them or the value would never default and would be stripped on reload.
 */
/** When a param is shown: while the switch param `param` holds `is` - a boolean param's true / false, an enum
 *  param's value, or any of a list of its values. */
export interface VisibleWhen {
  param: string
  is: boolean | string | readonly string[]
}

export type ParamSpec = (
  | NumberParamSpec
  | BooleanParamSpec
  | EnumParamSpec
  | ColorParamSpec
  | TextParamSpec
  | PartRefParamSpec
  | TagRefParamSpec
  | NumberListParamSpec
  | WallRulesParamSpec
) & {
  hidden?: boolean
  /** shown in the Inspector only while the named switch param has this value (the SDK's `ParamSpec.visibleWhen`):
   *  a boolean param's true / false, or an enum param's value or one of a list of them. Like `hidden`, presentation
   *  only - the param is stored and resolved regardless - except that a tag param it hides names no tag of the
   *  scene (plc/bindings.ts liveSpecs): the part does not read it. One rule decides both: {@link visibleWhenHolds}. */
  visibleWhen?: VisibleWhen
  /**
   * One-line doc for the field, shown in its Inspector hover under the label (see the SDK's
   * {@link ParamSchema.desc}, which is where a part authors it). Applies to every kind for the same reason
   * `hidden` does: it is a property of the param, not of one editor control.
   */
  desc?: string
}

export interface PartDef {
  type: PartType
  label: string
  /** catalog section */
  category: 'Equipment' | 'Devices' | 'Products' | 'Structure'
  /** placement height of the part origin when dropped on the ground plane */
  defaultY: number
  /** which viewport resize handles the part offers (y = vertical height handle) */
  resize: { x?: boolean; y?: boolean; z?: boolean }
  params: ParamSpec[]
  /** true hides the type from the catalog palette (created another way, e.g. a Group node) */
  noCatalog?: boolean
  /**
   * Catalog card glyph for a type with no 3-D form to picture (an annotation). Declaring it opts the type out
   * of the thumbnail path entirely - no `/thumbnails/<type>.webp` to fetch, nothing for the boot warm to
   * prefetch, and no offscreen render when that fetch 404s. Omit for anything that can actually be drawn.
   */
  glyph?: string
}

// --- PART_DEFS authoring helpers, shared by every family's defs fragment ---

export const num = (key: string, label: string, def: number, min: number, max: number, step: number, unit: string, group?: string): NumberParamSpec =>
  ({ kind: 'number', key, label, default: def, min, max, step, unit, ...(group ? { group } : {}) })

export const bool = (key: string, label: string, def: boolean, group?: string): BooleanParamSpec =>
  ({ kind: 'boolean', key, label, default: def, ...(group ? { group } : {}) })

export const color = (key: string, label: string, def: string, group?: string, alpha?: boolean): ColorParamSpec =>
  ({ kind: 'color', key, label, default: def, ...(group ? { group } : {}), ...(alpha ? { alpha } : {}) })

export const text = (key: string, label: string, def: string, placeholder?: string, group?: string): TextParamSpec =>
  ({ kind: 'text', key, label, default: def, ...(placeholder ? { placeholder } : {}), ...(group ? { group } : {}) })

export const partRef = (key: string, label: string, partTypes?: readonly PartType[], group?: string): PartRefParamSpec =>
  ({ kind: 'partRef', key, label, default: '', ...(partTypes ? { partTypes } : {}), ...(group ? { group } : {}) })

export const tagRef = (key: string, label: string, dir: 'in' | 'out', group?: string): TagRefParamSpec =>
  ({ kind: 'tagRef', key, label, default: '', dir, ...(group ? { group } : {}) })

// --- multi-segment belt ---
/** default belt height: fillet bend radius = height, end-drum radius = height/2. Sized to a typical unit-handling
 *  belt conveyor (a 6-5/8" frame, 6" tail / 8" drive pulleys). */
export const BELT_HEIGHT = 0.17
export const BELT_DEFAULT_SEGMENT_LENGTH = 4
/** runs shorter than this are dropped from the collision/leg layout */
export const BELT_MIN_RUN_LENGTH = 0.01
/** per-bend convex prisms approximating the fillet arc */
export const BELT_BEND_SUBDIVISIONS = 4
/** segment tilt clamp, deg */
export const BELT_MAX_TILT_DEG = 89

// device geometry, shared by the procedural visuals and partFootprint so they can't drift.
// sensors aim their beam along local +Z from the lens at (0, SENSOR_EMIT_Y, SENSOR_EMIT_Z).
// SENSOR_HEIGHT is every sensor's overall height. The emit point is the photoeye's (the diffuse
// and colour sensors, whose housing examples/parts/_shared/sensorPhotoeye.js draws with its lens face at
// SENSOR_EMIT_Z); the laser's deeper housing declares its own, and SENSOR_HALF_X is a coarse
// shared approximation.
export const SENSOR_HALF_X = 0.036
export const SENSOR_HEIGHT = 0.16
export const SENSOR_EMIT_Y = 0.1
export const SENSOR_EMIT_Z = 0.037
/** pushbutton panel faces local +Z; base on the floor */
export const PUSH_BUTTON_HEIGHT = 0.18

// --- six-axis joint kinematics (the FK oracle the custom-part "oip.six-axis-robot" rig is parity-tested against) ---
/** robot joint hard limits (deg), J1..J6 */
export const ROBOT_JOINT_MIN: readonly number[] = [-180, -135, -160, -180, -120, -360]
export const ROBOT_JOINT_MAX: readonly number[] = [180, 135, 160, 180, 120, 360]
/** which joints rotate about local +Y (else local +Z) */
export const ROBOT_JOINT_IS_Y: readonly boolean[] = [true, false, false, true, false, true]

/** v1 compatibility: the only pitch/radius pair the old grid used */
export const ROLLER_PITCH = ROLLER_CLASSES.light.pitch
export const ROLLER_RADIUS = ROLLER_CLASSES.light.radius

/** static collision slab under every conveying surface; top face at part origin y */
export const CONVEYOR_BODY_THICKNESS = 0.15
// Surface frictions are material-based. Jolt combines two bodies' frictions as the
// geometric mean sqrt(a·b), not their product; constants tuned for a product (roller
// 0.8 / belt 0.5) nearly double the effective grip. Values are chosen
// so the combined result comes out near real material pairs (box-on-belt ≈ 0.59,
// box-on-roller ≈ 0.42) and belts hold a stopped ~30° incline (μ_eff ≥ tan θ).
/** roller running surface - steel roller shell, slips more than a belt */
export const CONVEYOR_FRICTION = 0.35
/** belt running surface - rubber/PVC belt face, the grippy surface */
export const BELT_FRICTION = 0.7

/**
 * Width auto-fit: a chain transfer's Z scale is width / (1.524 / 0.575);
 * its unscaled length-2 lane mesh ends up twice that scale long, so the
 * lane length that spans a host bed of `width` is width · (2 · 0.575 / 1.524).
 */
export const CHAIN_FIT_WIDTH_FACTOR = (2 * 0.575) / 1.524

export const MARKING_HEIGHT_OFFSET = 0.01

// Stairs run/rise geometry: 0.178 m rise / 0.28 m tread sit at the building-code limits
// (7 in maximum rise, 11 in minimum tread). Used by snapping to size a flight to the
// platform deck it mounts to.
export const STAIRS_STANDARD_RISE = 0.178
export const STAIRS_STANDARD_TREAD = 0.28
/** top landing depth (m) of the SDK stair flight - the flat plate at the flight top that a deck connection
 *  raises flush to the deck. 0.76 m = 30 in, OSHA 1910.25(b)(4)'s minimum landing depth; must equal
 *  examples/parts/stairs/part.js LANDING. */
export const STAIRS_LANDING_DEPTH = 0.76
/** the minimum stair size - the shortest rise a flight is allowed */
export const STAIRS_MIN_RISE = 0.3
/** the stairs height padding - a stair's snap height gate is padded by half its
 *  rise + this, so a flight resized to a tall deck still engages from its (raised) foot */
export const SNAP_STAIRS_HEIGHT_PADDING = 0.25

export const BUILDING_WALL_THICKNESS = 0.4
/** building tile-grid cell: 10 m XZ sections */
export const BUILDING_SECTION_SIZE = 10
/** one full wall module is 12 m tall (two stacked 6 m grid cells) */
export const BUILDING_FULL_WALL_HEIGHT = 12
/** the Wall_C half module: the gable ends beside the roof's eave band */
export const BUILDING_HALF_WALL_HEIGHT = 6
/** roof auto-hides when the camera is above the ceiling and pitched down this steeply */
export const ROOF_HIDE_PITCH_DEG = 80

/**
 * Where the walls stop and the roof modules start: the full-wall layers alone. One layer is a 12 m eave, about
 * what a conveyor distribution centre has (10-12 m clear under the joists); the roof's own trusses start
 * 1.9 m above it. There is no extra half-wall ring under the roof. With one, the lowest building would have an
 * 18 m eave and a 23.7 m ceiling, a high-bay shell that throws off the scale of everything inside it.
 */
export function buildingEaveHeight(heightSections: number): number {
  return heightSections * BUILDING_FULL_WALL_HEIGHT
}

// Snapping
// Structure engine: platforms, barriers, stairs, markings.
export const SNAP_SEARCH_RADIUS = 8.0
export const SNAP_VISIBLE_THRESHOLD = 3.0
export const SNAP_FENCE_VISIBLE_THRESHOLD = 1.0
export const SNAP_HEIGHT_TOLERANCE = 0.35
export const SNAP_HEIGHT_COST_WEIGHT = 0.2
export const SNAP_ROTATION_COST_WEIGHT = 0.35
export const SNAP_MIN_SWITCH_MS = 140
// Conveyor engine: every join a conveyor could make (each of its ends onto each end and each flank of the
// target) is solved, and the cheapest is chosen (docs/part-snap-connectors.md, "Conveyor to conveyor"). The search
// radius is a broadphase, measured to the target's box plus the mover's own reach. A join engages when the
// mover's mating end has to move at most SNAP_CONVEYOR_VISIBLE_THRESHOLD to reach it, and a join the live
// controller is already holding is kept out to SNAP_CONVEYOR_RELEASE, so the preview does not drop while the
// user overshoots or nudges. Cost = that end move + SNAP_CONVEYOR_TURN_COST per radian turned.
export const SNAP_CONVEYOR_SEARCH_RADIUS = 3.0
export const SNAP_CONVEYOR_VISIBLE_THRESHOLD = 0.3
export const SNAP_CONVEYOR_RELEASE = 0.6
/** metres of cost per radian a join turns the mover: 90° weighs like ~0.8 m of travel */
export const SNAP_CONVEYOR_TURN_COST = 0.5
/** an end join may square a conveyor up by at most a quarter turn (lining a perpendicular drop up with the
 *  line); past that the mover's other end is the one that faces the join */
export const SNAP_CONVEYOR_END_MAX_TURN = Math.PI / 2
/** a flank join takes a face already within 45° of square to the flank, so a conveyor laid parallel beside
 *  another is never swung into a T */
export const SNAP_CONVEYOR_FLANK_MAX_TURN = Math.PI / 4
/** device mounts (seatOnRail): an overlapping mover whose facing matches the seat (dot above this) engages at
 *  any interface distance */
export const SNAP_FACING_PRESERVED_DOT = 0.85
/** the live controller switches away from the join it holds only for one clearly cheaper: by this fraction of
 *  the held cost, and by at least SNAP_SWITCH_MIN_GAIN (so two near-zero costs never trade places) */
export const SNAP_SWITCH_MARGIN = 0.2
export const SNAP_SWITCH_MIN_GAIN = 0.05
// Face engine (generic footprint faces): the flush fallback for parts with no declared snap features, and
// `accepts: 'face'` device mounts onto any part's footprint side face. Tighter than the 3 m
// structural gate, so a generic box snaps only when brought close, not from across the aisle.
export const SNAP_FACE_THRESHOLD = 0.75
/** two parts must overlap this much vertically to face-flush - keeps a floor decal or a part on another
 *  storey from grabbing a box that only lines up in plan */
export const SNAP_FACE_MIN_Y_OVERLAP = 0.02
export const ROTATION_SNAP = Math.PI / 12

// Grid snap ("Use Snap" / Configure Snap) defaults: 1 m translate, 15 deg rotate
export const DEFAULT_TRANSLATE_SNAP = 1
export const DEFAULT_ROTATE_SNAP_DEG = 15

// Conveyor hardware (frame, legs, guards, bolts) is fixed-size and
// width-independent: every piece keeps its own dimensions at any conveyor
// width. Only placement (rail half-width, leg
// post spacing) tracks the width - never the piece proportions.

// side-guard + conveyor-frame dimensions. GUARD_HEIGHT is above the conveying surface: 6", the top of a real
// adjustable channel guide rail's range.
export const GUARD_HEIGHT = 0.15
export const GUARD_THICKNESS = 0.005
/** a sensor beam's hole through a side guard (core/guards/guardHoles.ts): 40 mm across, the size a real photo-eye is
 *  given through a guide rail */
export const GUARD_HOLE_RADIUS = 0.02
/** the length of guard sheet a hole's panel replaces: the hole plus a 30 mm margin each side. The guard is split
 *  around it and a panel with the hole cut through fills the gap. */
export const GUARD_HOLE_PANEL = 0.1
export const GUARD_COLLISION_THICKNESS = 0.05
export const FRAME_WALL_THICKNESS = 0.01
export const FRAME_FLANGE_WIDTH = 0.02

/**
 * Spur side-merge clearance from the host bed edge: a spur parks this far
 * off the edge and its rails/guards then extend back to the host wall (guardExtents.ts). The frame
 * flange is the only thing in the junction, so FLANGE_WIDTH*2 clears it, for every spur family.
 *
 * Roller spurs get no separate 0.12 "for the end pulley". A roller spur has no end drum: its frame terminates
 * flush at the splayed face and the roller stubs protrude in Z, not X. A 0.12 gap would only leave a 12 cm strip
 * of bare frame between the two roller banks, and just 3 cm of slack under the 0.15 contact tolerance that gates
 * the guard opening and the rail extents, so a lightly nudged spur would silently lose both.
 */
export const SPUR_SIDE_GAP = FRAME_FLANGE_WIDTH * 2

/**
 * How close a conveyor end must come to another conveyor's side (in plan) for the pair to be a side
 * junction. One budget for both halves of it: the host's guard opening (guardOpenings.ts) and the mover's
 * rail/guard extents (guardExtents.ts). They must agree, or a junction opens the host's guard while the
 * mover's guards stop short of it (or the reverse). A spur's
 * parked SPUR_SIDE_GAP counts against it.
 */
export const GUARD_CONTACT_TOLERANCE = 0.15

/**
 * ...and how far apart in height the two running surfaces may be at that end. Beyond a guard's height the
 * mover passes over or under the host's guard rather than through it (a mezzanine crossover, a line
 * running beneath another), so there is no junction: no opening, no extents.
 */
export const GUARD_CONTACT_HEIGHT = GUARD_HEIGHT

/**
 * Tangent lead-in/out length at each connecting end of a curved conveyor
 * (height/2 = the belt's end-drum radius). The frame and
 * guards carry a straight stub of this length tangent to the arc; the belt bed
 * wraps a rounded nose-drum of this radius and the roller bed continues with
 * straight rollers. The part's snap/footprint ends sit at the stub/nose tips, so
 * a curve butted to a straight meets it collinearly instead of an arc peeling away.
 */
export const ARC_END_EXT = BELT_HEIGHT / 2

/**
 * Curved-roller snap-end lead-in. Roller curves have no end pulley, so the
 * snap gap butts two of them at ~0.004 m (0.001 to a straight) - effectively
 * touching - where curved belts keep a half-pulley (ARC_END_EXT) of clearance. Half
 * the roller-roller gap, so stub+stub reproduces those pairwise gaps.
 */
export const CURVED_ROLLER_END_EXT = 0.002

// The pallet's size and the pallet half of the fork interface below are read off its one description (core/pallet.ts),
// which the drawn mesh and the physics shape are built from too.
export { PALLET_BLOCK_HALF, PALLET_BLOCK_OFFSET, PALLET_DECK_THICKNESS, PALLET_POCKET_HEIGHT, PALLET_SIZE }
export const PALLET_FRICTION = 0.5

/**
 * The fork interface: the numbers a pallet and a fork truck have to agree on, in one place.
 *
 * The pallet is a four-way block pallet with open fork channels, and AGV.glb's blades are 51 mm thick. If the
 * pallet's collider is a solid box, or the tine collider is thicker than the blade, there is no pocket to enter in
 * physics. Nothing fails: the trucks lift their forks straight up through the staging conveyors to reach the load,
 * and it only looks wrong.
 *
 * A collider is a proxy and is meant to simplify: a roller conveyor's model is forty rollers and its collider
 * is one slab. A feature another mechanism has to pass through cannot be approximated away, and those
 * features are defined here. The pallet half (PALLET_POCKET_HEIGHT, PALLET_BLOCK_*, PALLET_DECK_THICKNESS,
 * re-exported above) is derived from the pallet's pieces, and palletForkFit.test.ts pins the two halves together,
 * so a blade that stops fitting its pocket fails a test instead of quietly driving through a conveyor.
 */

/** AGV fork blade, measured off AGV_Forks in AGV.glb: 51 mm thick, 0.11 across, centres 0.73 m apart */
export const AGV_TINE_THICKNESS = 0.051
export const AGV_TINE_WIDTH = 0.11
export const AGV_TINE_OFFSET = 0.365
/** blade underside above the carriage's lift datum - the blade sits just proud of it, it is not the datum */
export const AGV_TINE_RISE = 0.003
/** how far the blade reaches ahead of the truck's own origin: heel .. heel + length */
export const AGV_TINE_HEEL = 0.82
export const AGV_TINE_LENGTH = 1.26

/**
 * Where a load ends up relative to the lift command, once the blade is in the pocket and carrying it - i.e. the
 * pallet's underside sits this far below the lift datum, because the blade is inside the pallet rather than under
 * it. Negative, and derived: a route that says "hold the load at height H" is asking for lift = H − this.
 *
 * It is fixed by the two shapes, so unlike a carry offset measured off the running cell, it does not drift when a
 * lane moves.
 */
export const AGV_LOAD_UNDER_LIFT = AGV_TINE_RISE + AGV_TINE_THICKNESS - PALLET_POCKET_HEIGHT
/** ...and where it rides along the blade: centred on it, which is where a fully-inserted fork puts it */
export const AGV_LOAD_AHEAD = AGV_TINE_HEEL + AGV_TINE_LENGTH / 2

export const BOX_MASS = 5
export const BOX_FRICTION = 0.5
export const BOX_RESTITUTION = 0
/** An empty plastic tote. Its friction is below cardboard's: polypropylene slips on a steel roller (0.37 combined)
 *  where a carton grips (0.42), and still holds a belt incline to about 28 degrees (0.53). */
export const TOTE_MASS = 2
export const TOTE_FRICTION = 0.4
/**
 * The instanced cargo batch's starting capacity (render/viewport/boxes.ts), which it outgrows on demand. Despite
 * the name it is not a limit on anything: capping cargo here (deleting the oldest box) would collapse finished
 * pallet stacks (sim/bodyFactory.ts makeCargoBody says why and what does run out).
 */
export const MAX_BOXES = 200

/**
 * The physics step rate (Hz) of a project that names none. A project may choose any whole rate from
 * {@link MIN_SIM_HZ} to {@link MAX_SIM_HZ}, and a running world carries its own (`SimWorld.hz`). Read that
 * for the rate a world is actually stepping at; this is only the default. See docs/sim-clock.md.
 */
export const DEFAULT_SIM_HZ = 60
/**
 * The slowest step rate a project may choose. A correctness floor, not a performance one: below it a loaded
 * pallet cannot be held up. Measured on a running roller deck, even with the pallet solver override
 * (sim/bodyFactory.ts PALLET_VELOCITY_STEPS) 600 kg sank into the deck at 30 Hz and 1500 kg at 45 Hz, while every
 * load to 1500 kg holds from 60 Hz up. (Without that override the demo cell's own 150 kg load stalls its line
 * at 29-40 Hz, and 1050 kg sinks even at 60.) A slower step also makes the PLC react later.
 */
export const MIN_SIM_HZ = 60
/**
 * The fastest step rate a project may choose. A 1 ms step matches the shortest PLC scan (MIN_SCAN_MS), so a
 * faster one does not lower I/O latency, it only uses more CPU: the cost is linear, and the demo cell already takes ~0.38 s of
 * compute per sim-second at 1000 Hz headless.
 */
export const MAX_SIM_HZ = 1000
/** A physics step rate in whole Hz, within [MIN_SIM_HZ, MAX_SIM_HZ]. Make one with {@link toSimRate}. */
export type SimRate = number
/** An untrusted step rate (the UI, a file, a peer, a hand-edited manifest) as one a world can run: rounded to
 *  whole Hz and clamped into range. Anything that is not a finite number is {@link DEFAULT_SIM_HZ}. */
export function toSimRate(value: unknown): SimRate {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIM_HZ
  return Math.min(MAX_SIM_HZ, Math.max(MIN_SIM_HZ, Math.round(value)))
}
export const GROUND_SIZE = 60
/** The floor's top, where legs, feet and everything dropped on the floor rest: the building's floor plane (render/parts/
 *  building.ts floorGeometry) and the physics ground's top (sim/world.ts), both y=0. Any other value leaves legged
 *  parts standing off the drawn floor while unlegged parts sit on it. A named constant so each use says "the floor",
 *  not a bare 0. */
export const FLOOR_SURFACE_Y = 0
