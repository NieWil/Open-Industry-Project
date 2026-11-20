// --- units: the one conversion table, and how a stored quantity is shown in the scene's unit system ---
//
// Storage never changes with the display: a document holds SI (or whatever unit a param declares). The scene's Units
// and Length (core/scene/sceneUnits.ts) decide how a length or a speed is shown and typed. Only units of length and
// speed convert; '°', 's', '%', 'kg' and the rest show as declared under either system.

import { DEFAULT_TRANSLATE_SNAP } from './types/base'
import type { SceneLengthUnit, SceneUnits } from './types/parts'

/** How lengths and speeds are shown: the scene's Units (metric: m/s, imperial: feet per minute, and what its
 *  conveyors' speed tags carry), and its Length, which shows every length in one unit (lengthUnitOf).
 *  Built by displayUnits, which returns one shared object per combination, so `===` compares them. */
export interface DisplayUnits {
  readonly system: SceneUnits
  readonly length?: SceneLengthUnit
}

const interned = new Map<string, DisplayUnits>()

/** The display units for a scene's Units and Length; the same object for the same pair. */
export function displayUnits(system: SceneUnits, length?: SceneLengthUnit): DisplayUnits {
  const key = `${system}|${length ?? ''}`
  let d = interned.get(key)
  if (!d) {
    d = Object.freeze(length ? { system, length } : { system })
    interned.set(key, d)
  }
  return d
}

/** Metric with no Length set: a new scene's display, and the default where no scene is at hand. */
export const METRIC_DISPLAY = displayUnits('metric')

/** The unit every length shows in: the Length, else metres or (imperial) inches. A scene with no Length saved
 *  shows exactly what that unit set explicitly shows, so the two are the same setting. */
export function lengthUnitOf(d: DisplayUnits): SceneLengthUnit {
  return d.length ?? (d.system === 'imperial' ? 'in' : 'm')
}

/** The grid-snap translate increment a viewer who never set one gets, in metres: 1 m, or 1 ft when lengths show in inches. */
export function defaultTranslateSnap(d: DisplayUnits): number {
  return lengthUnitOf(d) === 'in' ? 0.3048 : DEFAULT_TRANSLATE_SNAP
}

// Each table is factors to its base (metres; metres per second). Keys are lower case: look units up lower-cased.
export const LENGTH_UNITS: Readonly<Record<string, number>> = {
  m: 1, cm: 0.01, mm: 0.001,
  in: 0.0254, inch: 0.0254, inches: 0.0254, '"': 0.0254,
  ft: 0.3048, foot: 0.3048, feet: 0.3048, "'": 0.3048,
}
export const SPEED_UNITS: Readonly<Record<string, number>> = { 'm/s': 1, fpm: 0.00508, 'ft/min': 0.00508 }

/** The table a unit belongs to (a length or a speed), or undefined for a unit that never converts. */
export function unitTable(unit: string): Readonly<Record<string, number>> | undefined {
  const u = unit.toLowerCase()
  return LENGTH_UNITS[u] !== undefined ? LENGTH_UNITS : SPEED_UNITS[u] !== undefined ? SPEED_UNITS : undefined
}

/**
 * The unit a quantity stored in `unit` is shown in under `d`. Every length shows in the scene's Length, whatever unit
 * its part stores it in. A speed already of the system shows as itself, and one of the other system shows in the
 * system's: feet per minute or m/s.
 */
export function displayUnitFor(unit: string, d: DisplayUnits): string {
  const table = unitTable(unit)
  if (!table) return unit
  const u = unit.toLowerCase()
  if (table === LENGTH_UNITS) {
    const length = lengthUnitOf(d)
    return u === length ? unit : length
  }
  if (d.system === 'metric') return u === 'm/s' ? unit : 'm/s'
  return u === 'm/s' ? 'FPM' : unit
}

/** Convert `v` from one unit to another of the same table; unchanged when either doesn't convert or they differ in kind. */
export function convertUnit(v: number, from: string, to: string): number {
  const table = unitTable(from)
  const a = table?.[from.toLowerCase()]
  const b = table?.[to.toLowerCase()]
  if (a === undefined || b === undefined || a === b) return v
  return (v * a) / b
}

// How many decimals a converted field shows: enough to read the value back without it drifting on screen (0.6 m
// is 23.62 in, not 23.6), never so many that float dust shows. A field shown in its own unit keeps its step's.
const CONVERTED_DECIMALS: Readonly<Record<string, number>> = { in: 2, ft: 3, mm: 1, cm: 2, m: 3, 'm/s': 3, fpm: 0 }

/** What a field stored in `unit` shows under `system`: the unit it shows, and `k` (shown = stored * k). */
export interface UnitView {
  unit: string
  k: number
  /** decimals to show when converted (k !== 1); undefined keeps the field's own */
  decimals?: number
}

export function unitView(unit: string, d: DisplayUnits): UnitView {
  const shown = displayUnitFor(unit, d)
  const k = convertUnit(1, unit, shown)
  return k === 1 ? { unit, k } : { unit: shown, k, decimals: CONVERTED_DECIMALS[shown.toLowerCase()] }
}

/** The nearest 1-2-5 step to `x`: a converted field's arrow step (0.01 m is 0.3937 in, stepped as 0.5 in). */
export function niceStep(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return x
  const p = 10 ** Math.floor(Math.log10(x))
  const m = x / p
  const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10
  return Number((nice * p).toPrecision(6))
}

/** A shown value back into its stored unit, without the float dust a division leaves (24 in -> 0.6096, not 0.6096000000000001). */
export function toStored(shown: number, k: number): number {
  return k === 1 ? shown : Number((shown / k).toPrecision(12))
}

/**
 * A length in metres as a read-out (the measure tool): metres to the millimetre, millimetres to a tenth, or feet and
 * inches to a hundredth (`12' 3.50"`; under a foot, inches alone). Not for a field, which shows one number in one unit.
 */
export function formatLength(m: number, d: DisplayUnits): string {
  const unit = lengthUnitOf(d)
  if (unit === 'm') return `${m.toFixed(3)} m`
  if (unit === 'mm') return `${(m * 1000).toFixed(1)} mm`
  const sign = m < 0 ? '-' : ''
  const totalIn = Math.round((Math.abs(m) / 0.0254) * 100) / 100
  const ft = Math.floor(totalIn / 12)
  const inches = totalIn - ft * 12
  return ft === 0 ? `${sign}${inches.toFixed(2)}"` : `${sign}${ft}' ${inches.toFixed(2)}"`
}

/**
 * A speed in m/s as a read-out (the fly-speed indicator): m/s to two decimals under 1, else one, or whole feet per
 * minute under imperial. Like formatLength, not for a field.
 */
export function formatSpeed(mps: number, d: DisplayUnits): string {
  if (d.system === 'metric') return `${mps.toFixed(Math.abs(mps) < 1 ? 2 : 1)} m/s`
  return `${Math.round(convertUnit(mps, 'm/s', 'fpm'))} FPM`
}
