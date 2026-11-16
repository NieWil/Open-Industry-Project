// What every conveyor part says to a PLC beyond run / speed / running, written once for the belt, roller, curved,
// curved roller, spur and spur roller conveyors. The speed unit itself is conveyorUnits.js.
//
// THE DRIVE A PLANT PROGRAM TALKS TO. A real line's program writes a speed reference in FEET PER MINUTE,
// reads the drive's output back as a frequency, and counts encoder pulses to track a package. So, beyond the
// speed unit (conveyorUnits.js):
//
//   speedAt30 (Fpm) the belt speed the drive gives at 30 revolutions: the scale of the velocity feedback.
//   velocityTag     REAL out: effective speed / speed-at-30 * 30. A belt running at the speed it is rated for at
//                   30 reads 30; stopped it reads 0; half speed, 15.
//   pulseTag        BOOL out: TRUE for ONE simulation step each time the surface has travelled `inchesPerPulse`.
//                   It can only be as fine as a step: at 60 steps a second a belt at 2 m/s covers 1.3 in a step,
//                   so a pulse an inch needs the project's `simHz` raised (240 resolves it), and a program that
//                   is to see every pulse has to scan at least that often.
//   encoderTag      REAL out: the odometer of surface travel in metres, integrated on sim time in the worker, so it
//                   cannot drift against the physics as scan-clock dead reckoning does. Latch it at a photo-eye,
//                   act once it has advanced a known distance.
//   accelTime /     THE RAMP: a VFD motor ramps, at a rate set as the time from stopped to rated speed (the speed
//   decelTime       that reads 30), and everything above that reads the surface follows it. Defaults are a guess
//                   at the equipment, not a measurement; 0 steps instantly. At Play a PLC-commanded conveyor starts
//                   from rest; one on its authored speed is already running. Every later change ramps.
//
// The drive feedback sits in a `<group>/Feedback` sub-section the Inspector starts folded: it is what a plant
// program reads back, not what most scenes need to set.

import { FPM_MS, paramGroup } from './conveyorUnits.js'

/** Params to stand right AFTER the part's own `speed`: the drive's ramp, in seconds from stopped to rated. */
export function driveRampParams(accelTime, decelTime) {
  return {
    accelTime: { type: 'number', unit: 's', default: accelTime, min: 0, max: 30, step: 0.1, label: 'Accel time', desc: 'How long the drive takes to bring the conveyor from stopped up to its rated speed (the speed that reads 30, under Comms > Feedback), like the acceleration time set on a VFD. A smaller change takes proportionally less. 0 starts instantly.' },
    decelTime: { type: 'number', unit: 's', default: decelTime, min: 0, max: 30, step: 0.1, label: 'Decel time', desc: 'How long the drive takes to bring the conveyor from rated speed down to a stop. Cargo keeps travelling while it does, so a box stopped at a photo-eye ends up past it. 0 stops instantly.' },
  }
}

/** Params to stand after the part's `runningTag`: the velocity feedback, the pulse and the encoder, in a
 *  `Feedback` section under `group`. */
export function driveFeedbackParams(speedMs, group) {
  const fpm = Math.round(speedMs / FPM_MS)
  const g = paramGroup(group ? `${group}/Feedback` : 'Feedback')
  return {
    speedAt30: { type: 'number', default: speedMs, min: 0.01, max: 10, step: 0.01, label: 'Speed that reads 30 (m/s)', ...g, visibleWhen: { param: 'fpmUnits', is: false }, desc: 'The surface speed this conveyor reaches when its drive turns at 30. It scales the velocity tag: running at exactly this speed reads 30.' },
    speedAt30Fpm: { type: 'number', default: fpm, min: 1, max: 2000, step: 1, label: 'Speed that reads 30 (FPM)', ...g, visibleWhen: { param: 'fpmUnits', is: true }, desc: 'The surface speed, in feet per minute, this conveyor reaches when its drive turns at 30. It scales the velocity tag: running at exactly this speed reads 30.' },
    velocityTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Velocity tag (30 at the speed above)', ...g, desc: 'Drive feedback the program reads: the effective speed as a share of the speed at 30 revolutions, times 30. Stopped reads 0, and a run tag holding the conveyor still counts as stopped.' },
    inchesPerPulse: { type: 'number', default: 1, min: 0.05, max: 100, step: 0.05, label: 'Travel per pulse (in)', ...g, desc: 'How far the surface travels between pulses on the pulse tag. A pulse cannot be finer than one simulation step, so a fast conveyor at a fine pitch needs a higher project simHz.' },
    pulseTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Pulse tag (one per pitch)', ...g, desc: 'An encoder for the program to count: TRUE for one simulation step each time the surface has travelled the inches above, in either direction, and FALSE otherwise.' },
    encoderTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Encoder tag (travel)', unit: 'm', ...g, desc: 'Odometer of surface travel in metres, integrated on sim time: it climbs while the conveyor runs forward and counts back while it reverses. Latch it when a photo-eye sees a box, then act once it has advanced a known distance - the standard way to track product without a sensor at every station.' },
  }
}

/** What a conveyor remembers between steps for its ramp, its pulse and its encoder. Make one at the top level. */
export function conveyorDrive() {
  return {
    pulseTravel: 0, // surface travel since the last pulse (in)
    odo: 0, // encoder odometer: surface travel (m), signed with the direction of travel
    driven: 0, // what the drive is actually doing (m/s): the command, through the accel/decel ramp
    rampStarted: false, // past the first step, from which every change of command ramps
  }
}

/** In step(): the unit the conveyor is set up in and the commanded speed, `{ fpm, setpointTag, commanded }`.
 *  `commanded` is always m/s, so everything after this call is m/s. */
export function commandedSpeed(ctx) {
  const fpm = ctx.params.fpmUnits === true
  const setpointTag = fpm ? ctx.params.speedFpmTag : ctx.params.speedTag
  const unit = fpm ? FPM_MS : 1
  const commanded = (setpointTag ? ctx.readNumber(setpointTag) : fpm ? ctx.params.speedFpm : ctx.params.speed) * unit
  return { fpm, setpointTag, commanded }
}

/** In step(), after commandedSpeed(): the speed the surface actually runs at (m/s), `target` (the command, gates
 *  applied) through the drive's ramp. Away from 0 it accelerates at rated / accelTime; toward 0 it decelerates at
 *  rated / decelTime; a reversal runs down to 0 before it turns round.
 *  THE FIRST STEP: a conveyor whose speed or run gate a program owns starts from rest, because the program is
 *  starting the line; one running on its authored speed is already running at it, since nothing started it. */
export function rampedSpeed(ctx, drive, cmd, target) {
  // rates are rated speed over the accel / decel time
  const rated = cmd.fpm ? ctx.params.speedAt30Fpm * FPM_MS : ctx.params.speedAt30
  let want = target
  if (!drive.rampStarted) {
    drive.rampStarted = true
    // no program commands this conveyor: its authored speed is a belt that is running, not one being started
    if (!(cmd.setpointTag || (ctx.params.runTag && ctx.tagDriven(ctx.params.runTag)))) drive.driven = want
  }
  if (want * drive.driven < 0) { if (ctx.params.decelTime > 0) want = 0; else drive.driven = 0 } // reversing: stop first
  const rampTime = Math.abs(want) > Math.abs(drive.driven) ? ctx.params.accelTime : ctx.params.decelTime
  drive.driven = rampTime > 0 && rated > 0 ? ctx.approach(drive.driven, want, (rated / rampTime) * ctx.dt) : want
  return drive.driven
}

/** In step(): the velocity feedback, the pulse and the encoder, from the effective speed `v` (m/s). */
export function publishDrive(ctx, drive, cmd, v) {
  // the velocity as a share of the speed at 30
  const at30 = cmd.fpm ? ctx.params.speedAt30Fpm * FPM_MS : ctx.params.speedAt30
  if (ctx.params.velocityTag) ctx.writeNumber(ctx.params.velocityTag, at30 > 0 ? (v / at30) * 30 : 0)
  // the encoder pulse
  const pitch = ctx.params.inchesPerPulse > 0 ? ctx.params.inchesPerPulse : 1
  drive.pulseTravel += (Math.abs(v) * ctx.dt) / 0.0254
  const pulse = drive.pulseTravel >= pitch - 1e-9 // (a hair of tolerance: twelve twelfths of an inch do not sum to exactly one)
  if (pulse) drive.pulseTravel = Math.max(0, drive.pulseTravel - pitch * Math.max(1, Math.floor(drive.pulseTravel / pitch + 1e-9)))
  if (ctx.params.pulseTag) ctx.writeTag(ctx.params.pulseTag, pulse)
  drive.odo += v * ctx.dt
  if (ctx.params.encoderTag) ctx.writeNumber(ctx.params.encoderTag, drive.odo)
}

/** In react(), last: ask for the next tick while the drive has work of its own. It has while it ramps toward
 *  `target` (the command, gates applied, as handed to rampedSpeed), and while it runs with a pulse or an encoder tag
 *  to count travel on. A conveyor at its commanded speed with neither waits for a tag to change, and its surface
 *  keeps the speed it was last given. */
export function driveAgain(ctx, drive, target) {
  if (drive.driven !== target || (drive.driven !== 0 && (ctx.params.pulseTag || ctx.params.encoderTag))) ctx.again()
}
