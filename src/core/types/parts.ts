// Assembly point: pulls every family together into the discriminated PartInstance
// union and the total PART_DEFS table, and defines the meta parts (group, part) plus
// the scene container. The `Record<PartType, PartDef>` annotation on PART_DEFS is
// the exhaustiveness gate - a family that forgets to register a type fails the build here.
import type { PartPackage } from '../parts/partPackage'
import type { ScenePlc } from '../scene/scenePlcs'
import { SCENE_VERSION, num, tagRef, text, type EnumParamSpec, type PartBase, type PartDef, type PartType } from './base'
import { STRUCTURE_DEFS, type BuildingPart } from './structure'

/** an empty container node ("Reparent to New Node"): no geometry, no sim body - purely a soft-parent anchor that groups a subtree so it moves/selects as one */
export type GroupParams = Record<string, never>
export interface GroupPart extends PartBase { type: 'group'; params: GroupParams }
/** part params are dynamic (package schema-driven), so just a flat bag of the SDK's value types
 *  (scalars + a numberList's `number[][]` table) */
export type SdkPartParams = Record<string, number | boolean | string | number[][]>
/**
 * An instance of an imported SDK part (discriminant `type: 'part'`, stored as `'custom'` before v4). `packageId`
 * references a {@link PartPackage} that must be available in the scene's embedded `packages` (and the runtime
 * registry); the package supplies the geometry, behavior and param schema, while this instance carries only
 * the per-placement param values. Named `SdkPart` (author-supplied part) although the discriminant is `'part'`.
 */
export interface SdkPart extends PartBase { type: 'part'; packageId: string; params: SdkPartParams }

/**
 * A scene annotation - the icon + caption a person pins to a place to explain the layout ("colour sort here",
 * "check clearance"). No geometry and no sim body, like a `group`: the renderer gives it an empty transform so
 * it can be selected and dragged, and the chip is drawn as a screen-space overlay (editor/AnnotationOverlay).
 *
 * Parenting is how it follows a machine. `parent` is ordinary soft-parenting, and a drag carries a part's whole
 * subtree, so an annotation parented to a conveyor moves with it. Layouts get rearranged often, and a note left
 * at a fixed coordinate ends up labelling empty floor or the wrong machine.
 */
export interface AnnotationParams {
  text: string
  icon: string
  /** PLC tag whose live value the chip reads out beside {@link text}; '' = a plain static note */
  tag: string
  /** printed after the value ('/min', 'mm', '%'); ignored when no tag is bound */
  unit: string
  /** decimal places for a numeric readout */
  decimals: number
}
export interface AnnotationPart extends PartBase { type: 'annotation'; params: AnnotationParams }

/**
 * The icons an annotation can show, a closed set. An icon picker (or an upload) would make notes a graphics
 * feature to maintain, outside the simulation itself; six glyphs cover what a marked-up layout drawing uses. They are text, so they need no assets and scale with the
 * chip. Grow the list engine-side when a real note wants one, the same rule the rig's shape kinds follow.
 */
export const ANNOTATION_ICONS = [
  { value: 'info', label: 'Info', glyph: 'ℹ' },
  { value: 'warning', label: 'Warning', glyph: '⚠' },
  { value: 'flag', label: 'Flag', glyph: '⚑' },
  { value: 'arrow', label: 'Arrow', glyph: '➜' },
  { value: 'count', label: 'Count', glyph: '#' },
  { value: 'none', label: 'No icon', glyph: '' },
] as const

/** glyph for an annotation's `icon` param; an unknown value falls back to the info glyph rather than blank */
export function annotationGlyph(icon: string): string {
  return (ANNOTATION_ICONS.find((o) => o.value === icon) ?? ANNOTATION_ICONS[0]).glyph
}

const ANNOTATION_ICON_SPEC: EnumParamSpec = {
  kind: 'enum',
  key: 'icon',
  label: 'Icon',
  options: ANNOTATION_ICONS.map((o) => ({ value: o.value, label: `${o.glyph} ${o.label}`.trim() })),
  default: 'info',
}

export type PartInstance =
  | BuildingPart
  | GroupPart
  | SdkPart
  | AnnotationPart

export interface SceneJSON {
  version: typeof SCENE_VERSION
  parts: PartInstance[]
  /**
   * Part packages this scene embeds, so a saved/shared scene is self-contained: every `part`'s `packageId`
   * resolves to one of these. Deduplicated (one entry per package, many instances). Absent when the scene
   * uses no SDK parts.
   */
  packages?: PartPackage[]
  /**
   * The scene's Units (core/scene/sceneUnits.ts): how every length and speed is shown and typed, and every part's units
   * switch (the SDK's `ParamSpec.imperialUnits`, a conveyor's `fpmUnits`: its speed and speed tag in FPM or m/s).
   * Authored in Scene Properties, where changing it converts every part with it. Absent = `'metric'`: the default for
   * a new scene, and what a scene saved before it existed already is (its conveyors predate the switch).
   */
  units?: SceneUnits
  /**
   * The scene's Length (core/scene/sceneUnits.ts): the one unit every length is shown and typed in, display only.
   * Absent = each length field shows in the Units' own (metres or inches). A scene saved with `units: 'metric-mm'`
   * reads as metric with `lengthUnit: 'mm'`.
   */
  lengthUnit?: SceneLengthUnit
  /**
   * The scene's controllers (core/scene/scenePlcs.ts): the first is the default one, which tags with no controller name
   * belong to, and the rest are PLCs a tag reaches by name (`Cell2::%IX0.0`). Absent: the scene has not set them, and
   * the app derives them as it did before scenes carried them (editor/store/storePlcs.ts).
   */
  plcs?: ScenePlc[]
  /**
   * The PLC values a display shows beside the scene (core/scene/sceneDisplay.ts): names as the Watch panel spells them,
   * picked there with Show on displays. Absent or empty: a display shows the scene alone.
   */
  display?: string[]
}

export type SceneUnits = 'imperial' | 'metric'

/** The units a scene's Length can show every length in. */
export const SCENE_LENGTH_UNITS = ['m', 'mm', 'in'] as const
export type SceneLengthUnit = (typeof SCENE_LENGTH_UNITS)[number]

export const PART_DEFS: Record<PartType, PartDef> = {
  ...STRUCTURE_DEFS,
  group: {
    type: 'group',
    label: 'Group',
    category: 'Structure',
    defaultY: 0,
    resize: {},
    params: [],
    noCatalog: true, // created only via "Reparent to New Node", never placed from the palette
    // nothing of its own to picture (it is only its children), so the Inspector header draws this, not an empty
    // render. A BMP character for the same reason as the annotation's below.
    glyph: '▣',
  },
  part: {
    type: 'part',
    label: 'Part',
    category: 'Equipment',
    defaultY: 0,
    resize: {},
    // Params are package-driven, not static: an instance's editable fields come from its package's
    // baked schema (see packageParamSpecs). noCatalog hides this generic type from the palette; the
    // catalog synthesizes one card per loaded package instead.
    params: [],
    noCatalog: true,
  },
  annotation: {
    type: 'annotation',
    label: 'Annotation',
    // Not really any of the four sections, and 'Structure' is the least wrong: it already holds the other
    // things that describe a site rather than run in it (floor markings, fences, guard rail).
    category: 'Structure',
    // Dropped at chest height rather than on the floor, so a note reads against the machine it is about
    // instead of against the concrete.
    defaultY: 1.2,
    resize: {},
    params: [
      text('text', 'Text', 'Note', 'What this note says'),
      ANNOTATION_ICON_SPEC,
      // Bind a tag and the note becomes a readout: its text is the label, the tag's live value follows it.
      // This is the only place a PLC tag's value shows in the layout; the ST watch table is a table.
      tagRef('tag', 'PLC tag (live value)', 'in', 'Live value'),
      text('unit', 'Unit', '', 'per min, mm, %', 'Live value'),
      num('decimals', 'Decimals', 0, 0, 6, 1, '', 'Live value'),
    ],
    // No thumbnail: there is nothing to render. Without this the card would fetch a
    // /thumbnails/annotation.webp that cannot exist, 404, and fall through to the offscreen renderer to
    // render an empty transform, on every cold load, for every visitor.
    // A BMP character, not an emoji: the card renders in whatever font the page has, and an astral-plane
    // pictograph (🗒) falls back to a tofu box wherever no emoji font is installed. That includes every headless
    // Chromium, so every e2e screenshot.
    glyph: 'ℹ',
  },
}
