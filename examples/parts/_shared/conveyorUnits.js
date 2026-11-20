// The unit a conveyor's PLC speaks, shared by every conveyor part: the `fpmUnits` switch (`imperialUnits`: set by
// the scene's Units, never by hand), the speed field and setpoint tag in each unit, and the readout of whichever is
// in use. ON: the speed field and tag are FEET PER MINUTE, as a real line's program writes them; OFF: metres per
// second. The tag is a REAL either way, so a Units switch changes its value's meaning, never its type, and saved
// params without the key take OFF (`whenAbsent`). Only the fields of the unit in use are shown (`visibleWhen`).
// The drive behind it (ramp, velocity feedback, pulse, encoder) is conveyorDrive.js.

/** metres per second in one foot per minute */
export const FPM_MS = 0.00508

/** `{ group }` to spread into a param, or nothing when there is no group */
export const paramGroup = (group) => (group ? { group } : {})

/** Spread into the part's own m/s `speed` and `speedTag` params: shown only while the PLC speaks metres per second. */
export const METRIC_ONLY = { visibleWhen: { param: 'fpmUnits', is: false } }

/** Params to stand BEFORE the part's own `speed`: the unit switch, and the speed in the other unit. */
export function speedUnitParams(speedMs) {
  return {
    fpmUnits: { type: 'boolean', default: true, whenAbsent: false, imperialUnits: true, label: 'PLC speed in FPM', desc: 'The unit the PLC commands this conveyor in. On: feet per minute. Off: metres per second. The speed tag is a REAL either way, so switching changes what its value means and never how the program declares it. Set by the scene Units (Scene Properties), which switch every conveyor together, so the Inspector does not show it. A conveyor saved before this switch existed is in metres per second.' },
    speedFpm: { type: 'number', default: Math.round(speedMs / FPM_MS), min: -600, max: 600, step: 1, unit: 'FPM', label: 'Speed', visibleWhen: { param: 'fpmUnits', is: true }, desc: 'Surface speed in feet per minute. Negative runs it backwards. A program can command this through the FPM speed tag below.' },
  }
}

/** The param to stand right AFTER the part's own `speedTag`: the same setpoint, in FPM. */
export function speedFpmTagParam(group) {
  return {
    speedFpmTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speedFpm', default: '', label: 'Speed tag', ...paramGroup(group), visibleWhen: { param: 'fpmUnits', is: true }, desc: 'The program commands surface speed here in feet per minute, replacing the Speed field above, which then shows the live value read-only. Once BOUND this takes over even if no program writes it, so an unwritten tag holds the conveyor at 0.' },
  }
}

/** In step(): the Inspector readout of whichever speed field is in use. `v` is the effective m/s. */
export function reportSpeed(ctx, fpm, v) {
  if (fpm) ctx.report('speedFpm', Math.round(v / FPM_MS)); else ctx.report('speed', v)
}
