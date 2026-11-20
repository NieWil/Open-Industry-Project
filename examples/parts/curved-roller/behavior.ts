// Curved Roller Conveyor — a quarter-turn powered roller bed (geometry-function tier). geometry(g, p) lofts
// the steel frame + side guards along a horizontal arc, lays a bank of spinning rollers (+ axle stubs) around
// it, and yaws trestle legs to the sweep; step(ctx) hands the host the arc centre (the part origin) + omega =
// speed / centreline-radius, so cargo is carried round the curve. A negative speed reverses; a PLC run tag
// start/stops it.
//
// The rollers are the part's own code (_shared/rollerBed.js): the roller tube drawn once and instanced around the
// arc, each copy yawed so its axle points radially and spun about that axle by the bank's `spin` - one roller for
// every roller part.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` left out) and rig.json (the manifest).

// ---- from examples/parts/_shared/conveyorUnits.js ----
/** metres per second in one foot per minute */
const FPM_MS = 0.00508

/** `{ group }` to spread into a param, or nothing when there is no group */
const paramGroup = (group) => (group ? { group } : {})

/** Spread into the part's own m/s `speed` and `speedTag` params: shown only while the PLC speaks metres per second. */
const METRIC_ONLY = { visibleWhen: { param: 'fpmUnits', is: false } }

/** Params to stand BEFORE the part's own `speed`: the unit switch, and the speed in the other unit. */
function speedUnitParams(speedMs) {
  return {
    fpmUnits: { type: 'boolean', default: true, whenAbsent: false, imperialUnits: true, label: 'PLC speed in FPM', desc: 'The unit the PLC commands this conveyor in. On: feet per minute. Off: metres per second. The speed tag is a REAL either way, so switching changes what its value means and never how the program declares it. Set by the scene Units (Scene Properties), which switch every conveyor together, so the Inspector does not show it. A conveyor saved before this switch existed is in metres per second.' },
    speedFpm: { type: 'number', default: Math.round(speedMs / FPM_MS), min: -600, max: 600, step: 1, unit: 'FPM', label: 'Speed', visibleWhen: { param: 'fpmUnits', is: true }, desc: 'Surface speed in feet per minute. Negative runs it backwards. A program can command this through the FPM speed tag below.' },
  }
}

/** The param to stand right AFTER the part's own `speedTag`: the same setpoint, in FPM. */
function speedFpmTagParam(group) {
  return {
    speedFpmTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speedFpm', default: '', label: 'Speed tag', ...paramGroup(group), visibleWhen: { param: 'fpmUnits', is: true }, desc: 'The program commands surface speed here in feet per minute, replacing the Speed field above, which then shows the live value read-only. Once BOUND this takes over even if no program writes it, so an unwritten tag holds the conveyor at 0.' },
  }
}

/** In step(): the Inspector readout of whichever speed field is in use. `v` is the effective m/s. */
function reportSpeed(ctx, fpm, v) {
  if (fpm) ctx.report('speedFpm', Math.round(v / FPM_MS)); else ctx.report('speed', v)
}

// ---- from examples/parts/_shared/conveyorDrive.js ----
/** Params to stand right AFTER the part's own `speed`: the drive's ramp, in seconds from stopped to rated. */
function driveRampParams(accelTime, decelTime) {
  return {
    accelTime: { type: 'number', unit: 's', default: accelTime, min: 0, max: 30, step: 0.1, label: 'Accel time', desc: 'How long the drive takes to bring the conveyor from stopped up to its rated speed (the speed that reads 30, under Comms > Feedback), like the acceleration time set on a VFD. A smaller change takes proportionally less. 0 starts instantly.' },
    decelTime: { type: 'number', unit: 's', default: decelTime, min: 0, max: 30, step: 0.1, label: 'Decel time', desc: 'How long the drive takes to bring the conveyor from rated speed down to a stop. Cargo keeps travelling while it does, so a box stopped at a photo-eye ends up past it. 0 stops instantly.' },
  }
}

/** Params to stand after the part's `runningTag`: the velocity feedback, the pulse and the encoder, in a
 *  `Feedback` section under `group`. */
function driveFeedbackParams(speedMs, group) {
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
function conveyorDrive() {
  return {
    pulseTravel: 0, // surface travel since the last pulse (in)
    odo: 0, // encoder odometer: surface travel (m), signed with the direction of travel
    driven: 0, // what the drive is actually doing (m/s): the command, through the accel/decel ramp
    rampStarted: false, // past the first step, from which every change of command ramps
  }
}

/** In step(): the unit the conveyor is set up in and the commanded speed, `{ fpm, setpointTag, commanded }`.
 *  `commanded` is always m/s, so everything after this call is m/s. */
function commandedSpeed(ctx) {
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
function rampedSpeed(ctx, drive, cmd, target) {
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
function publishDrive(ctx, drive, cmd, v) {
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
function driveAgain(ctx, drive, target) {
  if (drive.driven !== target || (drive.driven !== 0 && (ctx.params.pulseTag || ctx.params.encoderTag))) ctx.again()
}

// ---- from examples/parts/_shared/conveyorFriction.js ----
/** The `friction` param, with the surface's default grip against a carton. */
function frictionParam(carton) {
  return {
    friction: { type: 'number', default: carton, min: 0, step: 0.01, label: 'Friction', desc: 'Grip between the running surface and a standard carton, the figure a belt datasheet quotes. A smooth PVC belt is about 0.4, a rough-top incline belt about 0.9 and a low-friction plastic modular belt about 0.2, made for product to slide while it accumulates. Bare steel rollers are about 0.4. Other cargo grips by its own friction against the same surface.' },
  }
}

// ---- from examples/parts/_shared/guardHolePanel.js ----
// A side guard's sensor-beam hole panel, drawn once for every function conveyor whose guard is a formed sheet
// (belt, spur, spur roller, curved, curved roller). The rig roller draws the same plate from core (guardHoles.ts
// guardHolePanelDescription), without the top return, which is its own link there.
//
// Where a beam crosses a guard, the host works out the hole (core/guardHoles.ts: the beams are facts of the scene,
// not of a frame) and hands it to the conveyor as a `guardHoles` row [x, y, side]; its geometry() splits the guard
// sheet around a HOLE_PANEL gap there and fills it with this panel.
//
// The panel is in the guard's own frame, the one its sheet is built in: x centred on the hole, y up from the running
// surface, z from the sheet's inner face OUTWARD (0 .. the sheet, then the top return out to LIP). The sheet runs
// from just under the surface (-0.005) to the guard top with a round hole at `holeY`; the top return runs over it
// unbroken, so a guard with a hole in it still shows one continuous top edge. Mirror it onto the other side with a
// 180 degree yaw, never a negative scale (a mirror turns the faces inside out).
//
// The numbers are the guard's own (GUARD_HEIGHT, GUARD_THICKNESS, the 20 mm return, GUARD_HOLE_RADIUS and
// GUARD_HOLE_PANEL in core/types): keep them in sync.
//
// `lip`: draw the top return over the panel. A family whose guard SHEET carries its return (the belt's swept L
// section, split around the hole with it) needs it; one whose return is its own continuous part (the spurs' lip
// boxes) must not, or the two coincide face to face and z-fight.
function holePanel(g, holeY, lip) {
  var H = 0.15, T = 0.005, LIP = 0.025, LIP_T = 0.005, R = 0.02, PW = 0.1
  var hole = []
  for (var k = 0; k < 16; k++) { var a = (k * Math.PI) / 8; hole.push([R * Math.cos(a), holeY + R * Math.sin(a)]) }
  var sheet = g.extrude([[-PW / 2, -0.005], [PW / 2, -0.005], [PW / 2, H], [-PW / 2, H]], 0, T, { axis: 'z', holes: [hole] })
  if (!lip) return sheet
  return g.merge(sheet, g.box([PW, LIP_T, LIP - T], [0, H - LIP_T / 2, T + (LIP - T) / 2]))
}

/** the panel's length along the guard (core GUARD_HOLE_PANEL) */

// ---- from examples/parts/_shared/guardArc.js ----
function arcP(r, t) { return [r * Math.cos(t), 0, -r * Math.sin(t)] }
function arcGuard(g, section, r, rFace, side, holes, sweep, n, stub, panels) {
  var half = 0.05 / rFace, gaps = []
  for (var i = 0; i < holes.length; i++) {
    var h = holes[i]
    if (h[2] !== side || h[0] - half < 0 || h[0] + half > sweep) continue
    gaps.push([h[0] - half, h[0] + half])
    var key = h[1].toFixed(4)
    if (!panels[key]) panels[key] = { y: h[1], at: [] }
    panels[key].at.push({ t: h[0], side: side, rFace: rFace })
  }
  gaps.sort(function (a, b) { return a[0] - b[0] })
  var kept = [], cur = 0
  for (var gi = 0; gi < gaps.length; gi++) { if (gaps[gi][0] - cur > 1e-6) kept.push([cur, gaps[gi][0]]); cur = Math.max(cur, gaps[gi][1]) }
  if (sweep - cur > 1e-6) kept.push([cur, sweep])
  var out = []
  for (var ki = 0; ki < kept.length; ki++) {
    var a = kept[ki][0], b = kept[ki][1], pts = []
    if (a <= 1e-9) pts.push([r, 0, stub]) // lead-in: −tangent(0) = +Z
    pts.push(arcP(r, a))
    for (var s = 0; s <= n; s++) { var t = (sweep * s) / n; if (t > a + 1e-4 && t < b - 1e-4) pts.push(arcP(r, t)) }
    pts.push(arcP(r, b))
    if (b >= sweep - 1e-9) pts.push([r * Math.cos(sweep) - Math.sin(sweep) * stub, 0, -r * Math.sin(sweep) - Math.cos(sweep) * stub]) // lead-out
    out.push(g.sweep(section, pts, { caps: true }))
  }
  return out
}
function arcHolePanels(g, panels) {
  return Object.keys(panels).sort().map(function (k) {
    var base = holePanel(g, panels[k].y, true)
    var placed = panels[k].at.map(function (e) {
      var phi = e.t + e.side * Math.PI / 2
      return g.transform(base, { rotate: [0, Math.sin(phi / 2), 0, Math.cos(phi / 2)], translate: [e.rFace * Math.cos(e.t), 0, -e.rFace * Math.sin(e.t)] })
    })
    return { desc: placed.length === 1 ? placed[0] : g.merge.apply(g, placed), finish: 'guard' }
  })
}

// ---- from examples/parts/_shared/legs.js ----
// The conveyor floor support, drawn once for every legged conveyor (belt, curved, curved roller, spur, spur roller),
// and mirrored in TS by legPieces() in src/render/parts/common.ts for the rig roller's kind:'leg' link
// (conveyorLegs.test.ts holds the two to the same pieces).
//
// It is sized to a typical unit-handling conveyor floor stand, not a
// trestle whose posts were a 7.8" x 5.9" box: formed-channel uprights 4" x 1-3/4" standing under the side frames, a support
// channel across under the bed, a 1-1/2" x 8" mounting bracket bolted to each frame web, a 6" x 4" x 1/4" foot
// plate with two anchor bolts, a telescoping inner leg with its adjustment bolts, horizontal cross braces, and knee
// braces once the stand is tall.
//
// Leg-local metres: the floor at y 0, x along travel centred on the station, z across. `height` is the frame bottom
// above the floor, `hw` half the bed width (the side frame's wall is hw .. hw + 0.01), `dir` the way the knee
// braces lean along x (+1 / -1, toward the middle of the bed; 0 = none, e.g. on an arc, where a brace reaching
// along the tangent would miss the curving frame). `frameDepth` is the deck → frame bottom: the mounting bracket
// climbs 0.127 up the frame web, or stops 10 mm under the deck on a frame too shallow for that (a belt's Frame height
// goes down to 0.1), dropping the web bolts it no longer reaches. Omitted, it takes the full rise.
//
// Returns { boxes, bolts }: a box is [cx, cy, cz, sx, sy, sz, rz] (a unit cube scaled, then turned rz about z),
// a bolt [cx, cy, cz, r, depth, axis] (a hex head, axis 'y' standing up or 'z' across).
function legPieces(hw, height, dir, frameDepth) {
  var boxes = [], bolts = []
  function box(x0, y0, z0, x1, y1, z1) { boxes.push([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, 1e-4), Math.max(y1 - y0, 1e-4), Math.max(z1 - z0, 1e-4), 0]) }
  function bolt(x, y, z, axis) { bolts.push([x, y, z, 0.009, 0.007, axis]) }
  var FACE = hw + 0.01 //              the side frame's outer face: the uprights stand flush under it
  var LW = 0.0508, LD = Math.min(0.0445, Math.max(hw - 0.02, 0.02)) // upright: 4" along travel, 1-3/4" deep
  var PT = 0.009, CH = 0.076 //        foot plate top (1/4" plate on a 3 mm floor gap); support channel depth (3")
  var TELE = height > 0.45 ? 0.3 : 0 // the telescoping inner leg's top, on a stand tall enough to adjust
  var RISE = typeof frameDepth === 'number' ? Math.max(0, Math.min(0.127, frameDepth - 0.01)) : 0.127 // bracket rise up the web
  for (var sg = 0; sg < 2; sg++) {
    var s = sg === 0 ? 1 : -1, zo = s * FACE, zi = s * (FACE - LD), zc = s * (FACE - LD / 2)
    var lo = Math.min(zo, zi), hi = Math.max(zo, zi)
    if (TELE > 0) {
      box(-0.042, PT, lo + 0.004, 0.042, TELE, hi - 0.004) // inner leg
      box(-LW, TELE - 0.05, lo, LW, height, hi) //             outer leg, sleeved over it
      bolt(-0.025, TELE - 0.025, zo + s * 0.0035, 'z'); bolt(0.025, TELE - 0.025, zo + s * 0.0035, 'z') // adjustment bolts
    } else box(-LW, PT, lo, LW, height, hi)
    box(-0.0762, 0.003, zc - 0.0508, 0.0762, PT, zc + 0.0508) // foot plate
    bolt(-0.055, PT + 0.0035, zc, 'y'); bolt(0.055, PT + 0.0035, zc, 'y') // anchor bolts
    var bo = zo + s * 0.006
    box(-0.019, height - CH, Math.min(zo, bo), 0.019, height + RISE, Math.max(zo, bo)) // mounting bracket on the frame web
    if (0.04 + 0.009 <= RISE) bolt(0, height + 0.04, bo + s * 0.0035, 'z') // the web bolts the bracket still reaches
    if (0.1 + 0.009 <= RISE) bolt(0, height + 0.1, bo + s * 0.0035, 'z')
    bolt(0, height - CH / 2, bo + s * 0.0035, 'z')
    if (dir !== 0 && height > 1.0) { // knee brace: 1-1/4" angle from the upright up to the frame web, outside both
      var d = Math.min(0.6, 0.45 * height), ax = 0, ay = height - d, bx = dir * d, by = height + 0.04
      var L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, kz = s * (FACE + 0.016 + 0.006)
      boxes.push([(ax + bx) / 2, (ay + by) / 2, kz, L, 0.032, 0.032, Math.atan2(by - ay, bx - ax)])
      bolt(ax + ux * 0.03, ay + uy * 0.03, kz + s * 0.0195, 'z'); bolt(bx - ux * 0.03, by - uy * 0.03, kz + s * 0.0195, 'z')
    }
  }
  var zin = FACE - LD + 0.005 //         the uprights' inner faces, lapped 5 mm
  box(-0.0222, height - CH, -zin, 0.0222, height, zin) // support channel across under the bed
  if (height >= 0.6) { // horizontal cross braces (1-3/4" x 1-1/2" channel), clear of the telescoping joint
    var n = Math.min(Math.max(Math.floor(height / 0.9), 1), 3), y0 = TELE + 0.1, y1 = height - CH - 0.1
    for (var k = 0; k < n && y1 > y0; k++) { var y = y0 + ((k + 1) * (y1 - y0)) / (n + 1); box(-0.0222, y - 0.019, -zin, 0.0222, y + 0.019, zin) }
  }
  return { boxes: boxes, bolts: bolts }
}

// Station layout shared by the straight beds: supports stand at the ends and at bed-joint pitch between (a
// 10 ft section), the way a real run is supported. LEG_END_INSET is the station's distance in from the end: the
// upright's half-width plus clearance for the foot plate.
const LEG_END_INSET = 0.15
const LEG_SPACING = 3.05
// how far past an end station the middle cadence may start: a third of the pitch, so a middle support never lands
// within a metre of an end one (at the old 0.5 a 4 m bed stood a middle leg 0.8 m from its head leg)
const LEG_CLEARANCE = 1.0

// ---- from examples/parts/_shared/rollerBed.js ----
/** the drive-band urethane (a warm amber, matte) as a package material: linear RGB of #d9772b */

// The roller's profile, [radius, z] from the axle out to the tube, in the template's native units (radius 0.12):
// the hub face, the chamfered bearing housing, the rim, and the tube.
const ROLLER_PROFILE = [[0, 0.938], [0.0689, 0.938], [0.0718, 0.9362], [0.0787, 0.9199], [0.1072, 0.9199], [0.1072, 0.9351], [0.1092, 0.9371], [0.118, 0.9371], [0.12, 0.9351]]
const ROLLER_TEMPLATE_R = 0.12, ROLLER_TEMPLATE_BODY = 2 * 0.9371 // tube radius, and the rim-to-rim length a body is fitted by
// a roller shorter than this is a sliver at a clipped corner: dropped rather than drawn
const ROLLER_SLIVER = 0.02
// Drive-band proportions as fractions of the ROLLER RADIUS, so every roller class keeps one look: on a 24 mm roller a
// 4.8 mm cord (the common 3/16" round band) in grooves 20 and 38 mm in from the bed edge.
const BAND_CORD_PER_R = 1 / 5, BAND_INSET_PER_R = 5 / 6, BAND_SPACING_PER_R = 3 / 4

// the tube: the profile walked from the -Z hub to the +Z hub, turned about Z. Axle = local Z, centred.
function rollerTemplate(g) {
  var walk = []
  for (var i = 0; i < ROLLER_PROFILE.length; i++) walk.push([ROLLER_PROFILE[i][0], -ROLLER_PROFILE[i][1]])
  for (var k = ROLLER_PROFILE.length - 1; k >= 0; k--) walk.push([ROLLER_PROFILE[k][0], ROLLER_PROFILE[k][1]])
  return g.lathe(walk, { axis: 'z', segments: 18, startAngle: Math.PI / 18 })
}
// an axle stub: a capped unit cylinder along Z, centred
function stubTemplate(g) {
  return g.lathe([[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]], { axis: 'z', segments: 16 })
}
// a drive band's half-ring: a torus of loop radius lr and cord radius t over the -X half of the XY plane (the side of
// a roller facing AWAY from the neighbour the band runs to). Axle = local Z.
function bandArcTemplate(g, lr, t) {
  var s = g.surface(), T = 10, N = 6, rows = []
  for (var i = 0; i <= T; i++) {
    var u = Math.PI * i / T, row = []
    for (var j = 0; j < N; j++) {
      var v = 2 * Math.PI * j / N, rr = lr + t * Math.cos(v)
      row.push(s.vertex(-rr * Math.sin(u), rr * Math.cos(u), t * Math.sin(v)))
    }
    rows.push(row)
  }
  for (var a = 0; a < T; a++) for (var b = 0; b < N; b++) s.quad(rows[a][b], rows[a + 1][b], rows[a + 1][(b + 1) % N], rows[a][(b + 1) % N])
  return s.build()
}
// a band's straight run: an open unit cylinder along X (its ends bury in the half-rings)
function bandStrandTemplate(g) {
  return g.lathe([[1, -0.5], [1, 0.5]], { axis: 'x', segments: 6 })
}
function yawQuat(yaw) { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] }

// Where the bands go, from the rollers in bed order ({x, z, yaw, length}). A groove sits on the line
// z = side * (zWall - inset) (or one spacing further in); pair k uses the first groove when k is even, the second when
// odd, as a two-groove roller does. The band runs in the plane across the axles, so its far end is the near groove
// point projected onto the next roller's axle. A pair is skipped when a groove point falls off its (clipped) roller,
// when the two rollers aren't parallel, or when the gap is a dropped roller wide (over 1.5x the tightest pair).
function layoutRollerBands(rollers, bands, fullAxle, radius) {
  var side = bands.side || 1
  var zWall = typeof bands.zWall === 'number' ? bands.zWall : fullAxle / 2
  var cord = typeof bands.cord === 'number' ? bands.cord : radius * BAND_CORD_PER_R
  var inset = typeof bands.inset === 'number' ? bands.inset : radius * BAND_INSET_PER_R
  var spacing = typeof bands.spacing === 'number' ? bands.spacing : radius * BAND_SPACING_PER_R
  var grooves = [side * (zWall - inset), side * (zWall - inset - spacing)]
  var out = [], minSpan = Infinity
  for (var k = 0; k + 1 < rollers.length; k++) {
    var a = rollers[k], b = rollers[k + 1]
    if (Math.abs(a.yaw - b.yaw) > 1e-4) continue
    var sin = Math.sin(a.yaw), cos = Math.cos(a.yaw)
    if (Math.abs(cos) < 1e-3) continue // an axle along the flow has no wall to measure a groove from
    var zg = grooves[k % 2]
    var ta = (zg - a.z) / cos
    if (Math.abs(ta) > a.length / 2 - cord) continue
    var px = a.x + ta * sin, pz = zg
    var d = (b.x - px) * cos - (b.z - pz) * sin // across to b's axle, along the axle normal (cos, -sin)
    if (Math.abs(d) < 1e-4) continue
    var qx = px + d * cos, qz = pz - d * sin
    var tb = (qx - b.x) * sin + (qz - b.z) * cos
    if (Math.abs(tb) > b.length / 2 - cord) continue
    minSpan = Math.min(minSpan, Math.abs(d))
    out.push({ px: px, pz: pz, qx: qx, qz: qz, span: Math.abs(d) })
  }
  return { cord: cord, bands: out.filter(function (b) { return b.span <= minSpan * 1.5 }) }
}

// A roller bed as MeshParts: the tubes (spinning), their axle stubs (spinning with them) and, on a powered bed, the
// drive bands (static - an even band looks the same moving or still, and a static bank merges across every bed).
//   rollers  [{x, z, yaw, length}] in bed order: part-local centre, yaw about +Y (axle = local +Z yawed), body length
//   o.radius the tube radius, which also sets the no-slip spin rate (speed / radius)
//   o.y      the axle height in the frame the parts are drawn in
//   o.link   the rig link to hang them on (optional)
//   o.stub   { radius, length, protrude }: two shafts per roller, centred protrude past each (clipped) end
//   o.bands  a band spec ({ zWall, inset, spacing, cord, side }, all optional) - omit for an unpowered bed
//   o.fullAxle the unclipped axle length the bands measure the bed edge from (default the first roller's length)
//   o.dropSlivers  skip rollers of length <= ROLLER_SLIVER
//   o.bandMaterial the package material id the bands are drawn in (default 'band')
//   o.speed  the reported value (ctx.report) that turns the rollers, m/s at the tube surface (default 'speed')
// A positive speed turns the tubes the way that carries cargo toward +X on a bed whose axles run along Z: about -Z.
function rollerBed(g, rollers, o) {
  var R = o.radius, y = o.y || 0
  var sxy = R / ROLLER_TEMPLATE_R
  var spin = { axis: [0, 0, -1], radius: R }
  if (o.speed) spin.speed = o.speed
  var bodies = [], stubs = [], drawn = []
  for (var i = 0; i < rollers.length; i++) {
    var r = rollers[i]
    if (o.dropSlivers && r.length <= ROLLER_SLIVER) continue
    drawn.push(r)
    var q = yawQuat(r.yaw)
    bodies.push({ position: [r.x, y, r.z], quaternion: q, scale: [sxy, sxy, Math.max(0.01, r.length) / ROLLER_TEMPLATE_BODY] })
    if (o.stub) {
      var ax = Math.sin(r.yaw), az = Math.cos(r.yaw), so = r.length / 2 + o.stub.protrude
      var ss = [o.stub.radius, o.stub.radius, o.stub.length]
      stubs.push({ position: [r.x + ax * so, y, r.z + az * so], quaternion: q, scale: ss })
      stubs.push({ position: [r.x - ax * so, y, r.z - az * so], quaternion: q, scale: ss })
    }
  }
  var out = [{ desc: rollerTemplate(g), finish: 'roller', instances: bodies, spin: spin }]
  if (o.stub) out.push({ desc: stubTemplate(g), finish: 'roller', instances: stubs, spin: spin, castShadow: false })
  if (o.bands) {
    var full = typeof o.fullAxle === 'number' ? o.fullAxle : (rollers.length ? rollers[0].length : 0)
    var laid = layoutRollerBands(drawn, o.bands, full, R)
    var cord = laid.cord, lr = R + cord * 0.4 // seated on the tube: the cord's inner edge just under the facet flats
    var arcs = [], strands = []
    for (var b = 0; b < laid.bands.length; b++) {
      var bd = laid.bands[b]
      var yaw = Math.atan2(-(bd.qz - bd.pz), bd.qx - bd.px) // band frame: local X toward q, local Z the axle
      arcs.push({ position: [bd.qx, y, bd.qz], quaternion: yawQuat(yaw + Math.PI) })
      arcs.push({ position: [bd.px, y, bd.pz], quaternion: yawQuat(yaw) })
      var mx = (bd.px + bd.qx) / 2, mz = (bd.pz + bd.qz) / 2, sc = [bd.span, cord / 2, cord / 2]
      strands.push({ position: [mx, y + lr, mz], quaternion: yawQuat(yaw), scale: sc })
      strands.push({ position: [mx, y - lr, mz], quaternion: yawQuat(yaw), scale: sc })
    }
    // finish 'mesh' says plainly what they are: a finish-less submesh of a CONVEYING function part is read as its belt
    // fabric, which would draw the bands in the belt weave
    var bm = o.bandMaterial || 'band'
    out.push({ desc: bandArcTemplate(g, lr, cord / 2), finish: 'mesh', material: bm, instances: arcs, castShadow: false })
    out.push({ desc: bandStrandTemplate(g), finish: 'mesh', material: bm, instances: strands, castShadow: false })
  }
  if (o.link) for (var m = 0; m < out.length; m++) out[m].link = o.link
  return out
}

// ---- from examples/parts/_shared/rollerFrame.js ----
/** The roller beds' `frameHeight` param: the side frame channel's height (deck-side top 5 mm under the
 *  conveying plane, as on every bed). Same meaning and default as the belt's `height`, whose frame wall is that deep,
 *  so a roller bed set to a belt's Frame height meets its frame flush. A geometry()-tier bed reads its frame bottom
 *  through frameBottom(); a rig bed tracks it with sizeParams / offsetParams / leg frameDepthParam.
 *  Same range as the belt's, so every Frame height has a roller bed that matches it; on a shallow frame the legs'
 *  mounting brackets shorten to stay under the deck (legPieces' frameDepth, _shared/legs.js). */
function frameHeightParam(group) {
  return {
    frameHeight: { type: 'number', default: 0.17, min: 0.1, max: 0.6, step: 0.01, label: 'Frame height (m)', ...(group ? { group } : {}), desc: 'Depth of the side frame channel below the rollers. Set it to the Frame height of the conveyor this bed butts against so the two frames line up at the joint. The legs shorten or lengthen to meet the frame bottom; the deck height does not move.' },
  }
}

/** The frame bottom's y (negative, below the deck) for a geometry()-tier bed.
 *  Rounded to the micrometre exactly as the belt's is, so at the default it is the literal -0.175 the pooled rail
 *  template is shared by value with (0.17 + 0.005 is 0.17500000000000002 in binary). */
function frameBottom(p) {
  var fh = typeof p.frameHeight === 'number' && p.frameHeight > 0 ? p.frameHeight : 0.17
  return -Math.round((fh + 0.005) * 1e6) / 1e6
}

const drive = conveyorDrive() // the ramp, the pulse and the encoder, remembered between steps

definePart({
  params: {
    innerRadius: { type: 'number', default: 0.825, min: 0.2, max: 4, step: 0.025, label: 'Inner radius (m)', group: 'Size', desc: 'Radius of the INNER edge of the curve. The outer edge sits this plus the width away, so a tight inner radius on a wide bed makes a sharply banked turn that product can jam on.' },
    width: { type: 'number', default: 1.524, min: 0.2, step: 0.05, label: 'Width (m)', group: 'Size', desc: 'Bed width, measured across the curve from the inner edge to the outer one.' },
    ...frameHeightParam('Size'),
    // the 'arc' handle marks this a curved conveyor: the host derives the two tangent-stub arc ends (from
    // innerRadius + width + this sweep) so the curve butt-snaps to any neighbour. endGap 0.002 (vs a belt
    // curve's 0.085 half-pulley) mates a straight roller to the arc near-flush.
    sweepDeg: { type: 'number', default: 90, min: 15, max: 180, step: 5, label: 'Sweep (°)', group: 'Size', handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width', endGap: 0.002 }, desc: 'How far the curve turns. 90 degrees is the usual corner; 180 turns a lane back on itself. The snap ends move with this, so a neighbour re-snaps to the new tangent rather than needing to be dragged.' },
    ...speedUnitParams(1),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed at the centreline of the curve; the outer edge moves faster, which carries a box round square. Negative reverses flow, the ONLY way to turn a curve around (spinning it would swap its inner and outer radius).' },
    ...driveRampParams(0.2, 0.2),
    ...frictionParam(0.42),
    // Engine storage, never an Inspector field (hidden): the SNAP flips this
    // when it mates two ends that both discharge into the junction — a curve can't just be spun 180°, that
    // would swap inner/outer radius. Reversing by hand stays a negative speed; step() folds the two below.
    reverse: { type: 'boolean', default: false, hidden: true, label: 'Reversed (snap-owned)' },
    innerGuard: { type: 'boolean', default: true, label: 'Inner guard', group: 'Guards', desc: 'Guard wall along the INNER edge of the curve. A real barrier, so turning it off lets cargo cut the corner and leave the bed.' },
    outerGuard: { type: 'boolean', default: true, label: 'Outer guard', group: 'Guards', desc: 'Guard wall along the OUTER edge, which is the one centrifugal drift pushes product against. A real barrier - turning it off is how you let product leave on the outside of a turn.' },
    // sensor-beam holes as [θ rad, y m, side ±1] rows: arc angle from the inlet, height above the deck, side −1 the
    // inner guard / +1 the outer. HOST-FED (core/guardHoles.ts works them out from the scene's beams), so hidden.
    guardHoles: { type: 'numberList', arity: 3, default: [], hidden: true, label: 'Guard holes [θ rad, y m, side ±1]', group: 'Guards', desc: 'Where sensor beams cross the side guards. Worked out by the host from the scene; not for editing.' },
    // deck height above the floor — drives the LEG length; host auto-fills it from the surface beneath at drop/snap.
    standHeight: { type: 'number', default: 2.0, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the conveyor, so the legs reach the floor - or a platform crossing underneath - without you measuring. Pin it by hand when you want a deliberate height.' },
    // Comms trio: speedTag = REAL setpoint in (replaces the speed param), runningTag = BOOL feedback out
    // (effective speed ≠ 0); runTag = BOOL run/stop gate (back-compat).
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands surface speed here, replacing the Speed field above, which then shows the live value read-only. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0 - so a half-wired conveyor sits still rather than running at its authored speed.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (rollers run while true)', group: 'Comms', desc: 'Start/stop gate: false forces the speed to 0 whatever the setpoint says. Unlike the speed tag, this only takes effect once a program actually DRIVES it, so binding it alone will not stop the bed.' },
    runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Running tag (true while moving)', group: 'Comms', desc: 'Feedback the conveyor publishes for the program to read: true whenever it is actually moving. This is the EFFECTIVE speed, gates included, so a run tag holding it at zero reads false here.' },
    ...driveFeedbackParams(1, 'Comms'),
  },
  geometry(g, p) {
    var DEG = Math.PI / 180
    var ir = typeof p.innerRadius === 'number' && p.innerRadius > 0 ? p.innerRadius : 0.825
    var w = typeof p.width === 'number' && p.width > 0 ? p.width : 1.524
    var sweep = (typeof p.sweepDeg === 'number' ? p.sweepDeg : 90) * DEG
    var rc = ir + w / 2 // centreline radius
    var hw = w / 2
    var FB = frameBottom(p) // the frame bottom (frameHeight below the rail top)
    // Frame + guards sweep a straight tangent tail to the SNAP end (= the sweep handle's endGap) and stop there,
    // so they meet a butted neighbour's rails end to end, the way a curved belt's do at its half-pulley. Running
    // further would lie on top of the neighbour's own rails and guard: a bare stub past the last roller at a free
    // end, and a guard put back over the neighbour's openings or switched-off side.
    var STUB = 0.002
    var n = Math.max(8, Math.ceil((sweep / DEG) / 5))
    // SDK arc convention (matches snapping): P(t) = (r·cos t, 0, −r·sin t), t ∈ [0, sweep]. Inlet at +X (t=0),
    // sweeping toward −Z. Tangent T(t) = (−sin t, 0, −cos t); radial-outward R(t) = P(t)/r.
    // edgePath(sign): the arc along one BED EDGE (radius rc + sign·hw, so −1 = innerRadius, +1 = the outer
    // edge), extended by a straight tangent STUB at each end. Each rail/guard is swept along its own edge, with
    // its profile measured off that edge, not off the centreline: the sweep squares every ring to a central-
    // difference tangent, and beside a stub much shorter than one arc step the first arc ring tilts ~dt/2.
    // Measured off the centreline that tilt had a lever arm of hw (0.76 m on the default bed) and folded the
    // inner rail 33 mm back past the stub; off the edge the lever is the profile's own ≤0.03 m.
    function edgePath(sign) {
      var r = rc + sign * hw
      var path = [[r, 0, STUB]] // t=0 lead-in: −tangent(0) = (0,0,1) → +Z stub
      for (var i = 0; i <= n; i++) {
        var t = (sweep * i) / n
        path.push([r * Math.cos(t), 0, -r * Math.sin(t)])
      }
      var et = [-Math.sin(sweep), 0, -Math.cos(sweep)] // end tangent (lead-out direction)
      path.push([r * Math.cos(sweep) + et[0] * STUB, 0, -r * Math.sin(sweep) + et[2] * STUB])
      return path
    }

    // 1. SIDE FRAME RAILS (steel) — an L-rail cross-section (wall FB..−0.005 + an outward flange lip),
    // swept along the arc. The profile's cross coord is radial, so sign −1 = the inner rail (radius rc−hw =
    // innerRadius), +1 = the outer rail (rc+hw = innerRadius+width).
    function sideRail(sign) {
      var path = edgePath(sign)
      var z1 = sign * 0.01, z2 = sign * 0.03
      var wall = g.sweep([[FB, 0], [FB, z1], [-0.005, z1], [-0.005, 0]], path, { caps: true })
      var flange = g.sweep([[-0.005, z1], [-0.005, z2], [0, z2], [0, z1]], path, { caps: true })
      return g.merge(wall, flange)
    }
    var frame = { desc: g.merge(sideRail(-1), sideRail(1)), finish: 'frame' }

    // 2. SIDE GUARDS (steel) — a thin wall just outside each rail, −0.005..0.15. Inner / outer are
    // independently toggled. collision:'box' so cargo can't leave the band.
    var guardParts = []
    // the guard section, z measured off its own bed edge (edgePath): the 5 mm sheet just outside the frame wall, its top
    // turned OUTWARD (away from the bed) into a 20 mm return so it reads as formed sheet steel. Concave (an L);
    // the capped sweep triangulates it. Visual only: the host builds the arc guard colliders from the shared
    // guard constants (core/curvedGuards.ts), never from this profile.
    function guardSection(zIn, sign) {
      var z1 = zIn + sign * 0.005, z2 = zIn + sign * 0.025
      return [[-0.005, zIn], [-0.005, z1], [0.145, z1], [0.145, z2], [0.15, z2], [0.15, zIn]]
    }
    // each guard is swept along its own bed edge (edgePath's arc), broken around its sensor-beam holes (host-fed
    // 'guardHoles' rows; the panels that fill the gaps are appended last, below)
    var holes = Array.isArray(p.guardHoles) ? p.guardHoles : [], holePanels = {}
    if (p.innerGuard !== false) guardParts.push.apply(guardParts, arcGuard(g, guardSection(-0.01, -1), rc - hw, rc - hw - 0.01, -1, holes, sweep, n, STUB, holePanels))
    if (p.outerGuard !== false) guardParts.push.apply(guardParts, arcGuard(g, guardSection(0.01, 1), rc + hw, rc + hw + 0.01, 1, holes, sweep, n, STUB, holePanels))
    var guards = guardParts.length ? { desc: g.merge.apply(g, guardParts), finish: 'guard', collision: 'box' } : null

    // 3. ROLLERS (render-only, spinning) — a bank laid on the arc: one roller per roller pitch of centreline arc
    // length. Each is yawed t+π/2 so its axle points radially (across flow) and spins about it at the bed speed.
    var R = 0.024, PITCH = 0.075 // rendered roller radius + centre-to-centre pitch
    var rollerLen = Math.max(w - 0.004, 0.01) // body recessed just behind the inner/outer frame walls
    var WALL = 0.01, STUB_PROT = 0.02, STUB_ANCHOR = 0.015 // frame wall thickness / stub poke past it / anchor into the bed
    var stubR = R * 0.34
    var stubOff = hw + (WALL + STUB_PROT - STUB_ANCHOR) / 2 // stub centre outside the bed edge
    var stubLen = WALL + STUB_PROT + STUB_ANCHOR
    var dtheta = PITCH / Math.max(rc, 0.01) // centreline pitch → angular step (density matches a straight neighbour)
    var count = Math.max(2, Math.ceil(sweep / dtheta) + 1)
    var insts = []
    // rollers span exactly the arc [0, sweep] — no tangent lead-in/out overhang, so a roller curve butts flush.
    for (var ri = 0; ri < count; ri++) {
      var a = (sweep * ri) / (count - 1)
      insts.push({ x: rc * Math.cos(a), z: -rc * Math.sin(a), yaw: a + Math.PI / 2, length: rollerLen })
    }
    // axles at y = -R (the tube tops are the conveying plane); the stubs centred stubOff out from the bed's centreline
    var rollers = rollerBed(g, insts, { radius: R, y: -R, stub: { radius: stubR, length: stubLen, protrude: stubOff - rollerLen / 2 } })

    // 4. SUPPORT LEGS (steel trestles) — dual-post legs (posts + foot plates + collars + sleeves + clamps +
    // crossbar braces + hex bolts), built leg-local then yawed to each arc station's sweep angle and dropped
    // at the centreline point. A rotation preserves the box winding, so the same faces stay outward.
    var standH = typeof p.standHeight === 'number' && p.standHeight > 0 ? p.standHeight : 0.75
    var FLOOR_Y = -standH
    var legSfc = g.surface()
    var boltSfc = g.surface()
    function ybox(sfc, t, mnx, mny, mnz, mxx, mxy, mxz) {
      var ct = Math.cos(t), st = Math.sin(t), ax = rc * ct, az = -rc * st
      function V(lx, ly, lz) { return sfc.vertex(ax + lx * -st + lz * ct, ly + FLOOR_Y, az + lx * -ct + lz * -st) }
      var x0 = mnx, x1 = mxx, y0 = mny, y1 = mxy, z0 = mnz, z1 = mxz
      sfc.quad(V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1)) // +x
      sfc.quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0)) // −x
      sfc.quad(V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0), V(x0, y1, z0)) // +y
      sfc.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1)) // −y
      sfc.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)) // +z
      sfc.quad(V(x1, y0, z0), V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0)) // −z
    }
    function yhex(t, lx, ly, lz, r, depth, axis) {
      var ct = Math.cos(t), st = Math.sin(t), ax = rc * ct, az = -rc * st
      function V(ux, uy, uz) { return boltSfc.vertex(ax + ux * -st + uz * ct, uy + FLOOR_Y, az + ux * -ct + uz * -st) }
      var f = [], b = []
      for (var k = 0; k < 6; k++) {
        var a = (k / 6) * Math.PI * 2 + Math.PI / 6, u = Math.cos(a) * r, ww = Math.sin(a) * r
        if (axis === 'y') { f.push(V(lx + u, ly + depth / 2, lz + ww)); b.push(V(lx + u, ly - depth / 2, lz + ww)) }
        else { f.push(V(lx + u, ly + ww, lz + depth / 2)); b.push(V(lx + u, ly + ww, lz - depth / 2)) }
      }
      for (var k = 1; k < 5; k++) { boltSfc.triangle(f[0], f[k], f[k + 1]); boltSfc.triangle(b[0], b[k + 1], b[k]) }
      for (var k = 0; k < 6; k++) { var k2 = (k + 1) % 6; boltSfc.quad(f[k], b[k], b[k2], f[k2]) }
    }
    // a real floor support (_shared/legs.js) at arc angle t, every box/bolt yawed to the arc. No knee
    // braces: one reaching along the tangent would miss the curving frame by the arc's sag over its length.
    function legAt(t, height) {
      var pc = legPieces(hw, height, 0, -FB)
      for (var i = 0; i < pc.boxes.length; i++) {
        var b = pc.boxes[i]
        ybox(legSfc, t, b[0] - b[3] / 2, b[1] - b[4] / 2, b[2] - b[5] / 2, b[0] + b[3] / 2, b[1] + b[4] / 2, b[2] + b[5] / 2)
      }
      for (var j = 0; j < pc.bolts.length; j++) { var q = pc.bolts[j]; yhex(t, q[0], q[1], q[2], q[3], q[4], q[5]) }
    }
    // leg stations: tail/head insets + a spacing grid along the arc length, mapped back to sweep angles.
    // Height = standH − frame depth (−FB); the arc bed is flat (no tilt).
    var arcLen = rc * sweep, height = standH + FB
    if (height > 0.05 && arcLen > 0) {
      var TAIL = LEG_END_INSET, SP = LEG_SPACING, CLR = LEG_CLEARANCE
      var xs = []
      xs.push(TAIL)
      for (var v = Math.ceil((TAIL + CLR) / SP) * SP; v <= arcLen - TAIL - CLR + 1e-6; v += SP) xs.push(v)
      xs.push(arcLen - TAIL)
      for (var lgi = 0; lgi < xs.length; lgi++) { var s = xs[lgi]; if (s < 0.05 || s > arcLen - 0.05) continue; legAt(s / rc, height) }
    }
    var legs = { desc: legSfc.build(), finish: 'leg' }
    var bolts = { desc: boltSfc.build(), finish: 'bolt' }

    var parts = [frame]
    if (guards) parts.push(guards)
    parts.push(legs, bolts)
    parts.push.apply(parts, rollers)
    // hole panels LAST (they come and go with the sensors in the scene); VISUAL ONLY, no collision
    parts.push.apply(parts, arcHolePanels(g, holePanels))
    return parts
  },
  react(ctx) {
    // Tag precedence: speedTag (REAL in) replaces the speed param as the commanded speed; runTag (BOOL)
    // gates it to 0, but ONLY while a controller actually drives the tag (ctx.tagDriven, output ownership) —
    // undriven, the authored speed rules; runningTag (BOOL out) = effective speed ≠ 0, written on every call.
    // the unit the conveyor is set up in: everything below this line is m/s
    const cmd = commandedSpeed(ctx)
    const fpm = cmd.fpm, commanded = cmd.commanded
    const running = ctx.tagDriven(ctx.params.runTag) ? ctx.readTag(ctx.params.runTag) : true
    // 'reverse' is a MOUNTING fact the snap owns, not a value the program owns, so it flips whichever speed is
    // in force — authored or tag-commanded.
    const ramped = rampedSpeed(ctx, drive, cmd, running ? commanded : 0)
    const speed = ramped * (ctx.params.reverse ? -1 : 1)
    // Inspector readout for speed: the effective m/s INCLUDING the reverse flip - the arc omega below is
    // derived from it, so a curve reports the linear rate its speed param is authored in, not rad/s.
    reportSpeed(ctx, fpm, speed)
    if (ctx.params.runningTag) ctx.writeTag(ctx.params.runningTag, speed !== 0)
    // drive feedback: the velocity as a share of the speed at 30, an encoder pulse and the odometer
    publishDrive(ctx, drive, cmd, speed)
    // the arc centre is the part origin (the bed is authored around it); omega = speed / centreline-radius.
    const rc = (ctx.params.innerRadius > 0 ? ctx.params.innerRadius : 0.825) + (ctx.params.width > 0 ? ctx.params.width : 1.524) / 2
    const omega = speed / Math.max(rc, 1e-3)
    ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega })
    // the next tick is needed only while the drive ramps or counts travel (conveyorDrive.js)
    driveAgain(ctx, drive, running ? commanded : 0)
  },
})
