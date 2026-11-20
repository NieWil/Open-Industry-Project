// --- the scene's Units: one choice for how the scene is shown and what its conveyors' speed tags carry ---
//
// A plant uses one convention: its drawings, its conveyor spec sheets and its program all use feet per minute or
// metres per second, never both. So the scene holds one setting (SceneJSON.units, Scene Properties) that decides
// two things. First, the unit every length and speed field shows and takes (core/units.ts, display only; the
// document stays SI). Second, each conveyor's units switch (the SDK's `imperialUnits` boolean: its speed and speed
// tag in FPM, or in m/s; the tag is a REAL either way). The switch is still a param, because the part's step()
// reads it, but no one sets it by hand. The Inspector hides it, and changing the scene's Units rewrites it on every
// part, with the values it selects.
//
// The scene's Length (SceneJSON.lengthUnit) is a second, display-only setting: one unit every length shows in, such
// as millimetres for machine work in a metric scene. It changes no part and no tag. A scene with none saved shows
// metres, or inches under imperial. Changing the Units carries a Length of the other system with them (mm to inches,
// inches to metres), in the same edit, so the Length shown is always the one in effect.

import { partParamSpecs } from '../packageParams'
import { SCENE_LENGTH_UNITS } from '../types'
import type { BooleanParamSpec, NumberParamSpec, ParamSpec, PartInstance, SceneJSON, SceneLengthUnit, SceneUnits, TagRefParamSpec } from '../types'
import { convertUnit, displayUnits, lengthUnitOf, type DisplayUnits } from '../units'

/** The scene's unit system. Metric unless the scene says imperial: the default for everyone (the audience is
 *  worldwide). A scene with no `units`, new or saved without the setting, is metric, which matches its conveyors
 *  reading m/s when they have no FPM switch (the switch's `whenAbsent`). */
export function sceneUnits(scene: Pick<SceneJSON, 'units'>): SceneUnits {
  return scene.units ?? 'metric'
}

/** A saved Units and Length read back; one that is not a known value comes back undefined. `'metric-mm'`, the
 *  single Units value one release saved for millimetres, reads as metric with a Length of mm. */
export function readSavedUnits(units: unknown, lengthUnit: unknown): { units?: SceneUnits; lengthUnit?: SceneLengthUnit } {
  const length = (SCENE_LENGTH_UNITS as readonly unknown[]).includes(lengthUnit) ? (lengthUnit as SceneLengthUnit) : undefined
  if (units === 'metric-mm') return { units: 'metric', lengthUnit: length ?? 'mm' }
  return {
    ...(units === 'metric' || units === 'imperial' ? { units } : {}),
    ...(length ? { lengthUnit: length } : {}),
  }
}

/** How the scene shows lengths and speeds: its Units and its Length (core/units.ts). */
export function sceneDisplayUnits(scene: Pick<SceneJSON, 'units' | 'lengthUnit'>): DisplayUnits {
  return displayUnits(sceneUnits(scene), scene.lengthUnit)
}

/** The scene with its Length set, or cleared with undefined so it shows the Units' own (metres or inches). */
export function setSceneLengthUnit(scene: SceneJSON, lengthUnit: SceneLengthUnit | undefined): SceneJSON {
  const next: SceneJSON = { ...scene }
  if (lengthUnit) next.lengthUnit = lengthUnit
  else delete next.lengthUnit
  return next
}

/** A part's units switch: its boolean param marked `imperialUnits`, or undefined for a part with none. */
export function unitsSwitchOf(specs: readonly ParamSpec[]): BooleanParamSpec | undefined {
  return specs.find((s): s is BooleanParamSpec => s.kind === 'boolean' && s.imperialUnits === true)
}

const shownWhen = (s: ParamSpec, key: string, is: boolean): boolean => s.visibleWhen?.param === key && s.visibleWhen.is === is

/** A number converted into its twin's unit, kept inside the range the twin declares. Not rounded onto the twin's
 *  step: 2 m/s is 393.70 FPM (the field shows 394), so switching back gives 2 m/s exactly, not 2.00152. */
function intoTwin(v: number, from: NumberParamSpec, to: NumberParamSpec): number {
  const out = Number(convertUnit(v, from.unit, to.unit).toPrecision(10))
  return Math.min(to.max, Math.max(to.min, out))
}

/**
 * One part set to `units`: its switch, and every value the switch chooses between carried to its twin. A speed in
 * one unit becomes the same speed in the other, and a bound speed tag moves to the other tag field (the previous
 * field is cleared, since nothing reads it). Twins are found from the specs alone, so any SDK part that offers one setting
 * two ways works: two number params shown on opposite sides of the switch with the same label, and two tag params
 * that command such a pair (`setpointFor`). Returns the part unchanged when it has no switch or is already there.
 */
export function partInUnits(part: PartInstance, units: SceneUnits): PartInstance {
  if (part.type !== 'part') return part
  const specs = partParamSpecs(part)
  const sw = unitsSwitchOf(specs)
  if (!sw) return part
  const params = part.params as Record<string, unknown>
  const want = units === 'imperial'
  const saved = params[sw.key]
  const cur = typeof saved === 'boolean' ? saved : (sw.whenAbsent ?? sw.default)
  if (cur === want) return part
  const next: Record<string, unknown> = { ...params, [sw.key]: want }
  {
    const from = specs.filter((s) => shownWhen(s, sw.key, cur))
    const to = specs.filter((s) => shownWhen(s, sw.key, want))
    const twinOf = new Map<string, string>() // number param key -> its twin's key
    for (const a of from) {
      if (a.kind !== 'number') continue
      const b = to.find((s): s is NumberParamSpec => s.kind === 'number' && s.label === a.label)
      if (!b) continue
      twinOf.set(a.key, b.key)
      const v = params[a.key]
      next[b.key] = intoTwin(typeof v === 'number' ? v : a.default, a, b)
    }
    for (const a of from) {
      if (a.kind !== 'tagRef' || !a.setpointFor) continue
      const target = twinOf.get(a.setpointFor)
      const b = to.find((s): s is TagRefParamSpec => s.kind === 'tagRef' && s.setpointFor === target)
      if (!b) continue
      next[b.key] = typeof params[a.key] === 'string' ? params[a.key] : ''
      next[a.key] = ''
    }
  }
  return { ...part, params: next } as PartInstance
}

/** What setting a scene's Units changed: the scene, how many parts it switched, the speed tags that now carry
 *  the other unit (the program writes to those, so its speed values have to follow; their type does not change),
 *  and the Length lengths now show in when the switch moved it. */
export interface SceneUnitsChange {
  scene: SceneJSON
  switched: number
  tags: string[]
  length?: SceneLengthUnit
}

const METRIC_LENGTHS: readonly SceneLengthUnit[] = ['m', 'mm']

/** The scene with its Units set to `units`, every part with a units switch carried with it (see partInUnits), and a
 *  Length of the other system cleared to the new Units' own. */
export function setSceneUnits(scene: SceneJSON, units: SceneUnits): SceneUnitsChange {
  let switched = 0
  const tags = new Set<string>()
  const parts = scene.parts.map((p) => {
    const q = partInUnits(p, units)
    if (q === p) return p
    switched++
    const after = q.params as Record<string, unknown>
    const specs = partParamSpecs(q)
    const sw = unitsSwitchOf(specs)!
    for (const s of specs) {
      const tag = after[s.key]
      if (s.kind === 'tagRef' && s.setpointFor && shownWhen(s, sw.key, units === 'imperial') && typeof tag === 'string' && tag) tags.add(tag)
    }
    return q
  })
  const next: SceneJSON = { ...scene, parts, units }
  const was = scene.lengthUnit
  if (was && METRIC_LENGTHS.includes(was) !== (units === 'metric')) delete next.lengthUnit
  const before = lengthUnitOf(sceneDisplayUnits(scene))
  const after = lengthUnitOf(sceneDisplayUnits(next))
  return { scene: next, switched, tags: [...tags].sort(), ...(after !== before ? { length: after } : {}) }
}
