import type { PartType } from '../../core/types'

/**
 * One-line property descriptions shown as inspector hover tooltips, for the rows the host owns.
 *
 * A part's params document themselves - the SDK's `ParamSpec.desc`, authored next to the value it explains
 * and carried through `schemaToParamSpecs` - so nothing here is keyed by part type: every part instance
 * reports `type: 'part'` (the discriminant), so a `${partType}.${paramKey}` table could never match, and a
 * user-authored part could not use one.
 *
 * What is left here is what no package owns:
 *   - the `_`-prefixed built-in rows (`_name` / `_visible` / `_position` / `_rotation`), which the
 *     Inspector renders for every part regardless of type, so they are stored unqualified;
 *   - `building.*`, still a core PartType with static PART_DEFS params rather than a package.
 *
 * Adding a description for a part belongs in that part's `params` block, not here. `paramDescriptions.test.ts`
 * fails if a key in this table names a part type that no longer exists.
 */
export const PARAM_DESC: Record<string, string> = {
  // built-in rows (apply to every part type; looked up unqualified)
  '_name': 'Display name in the scene tree',
  '_visible': 'Hide the visuals (the part still collides and simulates)',
  '_position': 'World position. Type "+= 600mm" or "-= 2" to move the selection and its children by that much',
  '_rotation': 'Rotation (YXZ Euler), degrees. Type "+= 90" in Y to turn the selection about its centre',

  // building
  'building.lengthSections': 'Footprint along local X, in 10 m grid sections',
  'building.widthSections': 'Footprint along local Z, in 10 m grid sections',
  'building.heightSections': 'Stacked full-wall layers',
  'building.columnSpacing': 'Interior steel column grid, every N 10 m sections (0 = clear span, no columns). Columns are solid: cargo and the walking person stop at them, and Check Layout flags any part standing in one.',
  'building.rules': 'Perimeter wall pattern painted over the default Wall_D. A "Dock door" rule cuts a loading-dock bay (sliding door + auto leveler + container trailer) into the ground floor. Each door is raised individually with Use in pilot mode. A "Personnel door" rule puts a shut exit door in the middle of a ground-floor wall, with an EXIT sign over it and a fire extinguisher and alarm pull station beside it.',
  'building.floorVisible': 'Show the floor slab (viewing aid; physics unaffected)',
  'building.wallsVisible': 'Show the walls (viewing aid; physics unaffected)',
  'building.roofVisible': 'Show the roof (viewing aid; physics unaffected)',
  'building.brightness': 'Directional + ambient light multiplier',
  'building.backgroundColor': 'Scene clear / sky color',
  // shadow-map resolution is a per-client preference (render/quality.ts), not a scene param
}

/**
 * Description for a part property, or undefined when none is registered. A bare key (the `_`-prefixed
 * built-in rows) applies to every part type, so it is the fallback for the type-qualified lookup. Without
 * that second read the built-in rows would be unreachable, since the caller always has a type to prefix with.
 *
 * Note this is the fallback: ParamField prefers the package's own `spec.desc`.
 */
export function paramDesc(type: PartType, key: string): string | undefined {
  return PARAM_DESC[`${type}.${key}`] ?? PARAM_DESC[key]
}
