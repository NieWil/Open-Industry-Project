// Fork-lift AGV — a mobile pick-and-place vehicle. Demonstrates root motion: it moves its own base with
// ctx.drive(forward, turn) and reads its live pose back via ctx.position / ctx.forward to steer toward
// waypoints, each [worldX, worldZ, headingDeg, forkHeight]. A PLC drives it through a
// command/execute/done handshake. With no tags named it stays parked (forks down, beacon dark).
// It also animates the cosmetic dressing joints each tick: the four wheels roll from the commanded travel and
// the mast piston tracks the lift at half rate.
//
// The fork HEIGHT rides in the waypoint rather than in a second command, because a truck that picks off a 1 m
// deck and sets that load on a 1.6 m rack beam has to meet each surface at its own height, and the row that
// says where to stand is the natural place to say how high to hold the tines. Sending the same spot twice at
// two heights is therefore a lift or a lower, standing still. The fork tag is left with one job: GRAB or
// RELEASE, both of which happen where the tines are (see the grip note in step).
//
// Rendered from the real AGV.glb with per-node mesh links; the wheel/piston joints are `cosmetic` (dressing
// the behavior animates; the rig gizmo skips them, so the lift stays the one author-posable axis).
// Collision = hidden boxes (chassis + the two fork tines, measured from the GLB).
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

const TINE_OFFSET = 0.365
// Fork spread: blade centre to centre, set per site like a fork positioner. The model's blades stand TINE_OFFSET
// either side (0.73 apart), which is the default, so nothing that exists moves. Each blade is its own node of
// AGV.glb (scripts/split-agv-forks.mjs), so the blades and their colliders slide to the spread while the carriage
// and backrest stay.
const SPREAD_DEFAULT = TINE_OFFSET * 2
const SPREAD_MIN = 0.25 // the blades' inner edges 0.14 apart
const SPREAD_MAX = 0.9 // the blades' outer edges inside the carriage's 1.26 width
// What each spread fits, read off the pallets themselves (core/pallet.ts fittingSpreads). agvRigParity.test.ts
// derives this text from them and fails when a pallet changes and this sentence was not updated.
const SPREAD_DESC =
  'Blade centre to centre, set the way a fork positioner is set for the pallets a site handles. Between 210-490 mm ' +
  'the forks enter every face of every pallet size. At the default 730 mm they enter the long face of every size ' +
  'and the short face of 1165 x 1165 mm, 1100 x 1100 mm, 1067 x 1067 mm. A short face is entered over the bottom ' +
  'runners, about 3 cm above what the pallet stands on. Taking a pallet through a face the blades do not fit is ' +
  'reported on the truck.'

const D2R = Math.PI / 180
const WHEEL_RADIUS = 0.125 // AGV.glb wheel radius (core AGV_WHEEL_RADIUS)
const PISTON_LIFT_RATIO = 0.5 // core AGV_PISTON_LIFT_RATIO
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
// signed shortest angle from a to b, in (−π, π]
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
// wrap an accumulating angle into (−π, π] so the wheel joints never leave their clamp range
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a))

// Author-editable via the 'waypoints' numberList grid, which arrives already parsed + validated as number[][]
// — no JSON.parse, no silent fallback; each row is exactly [x, z, deg, fork height m] (a missing height cell
// pads 0, i.e. forks down).
const DEFAULT_WP = [
  [0, 0, 0, 0],   // 0 home (forks down)
  [4, 0, 0, 1],   // 1 pick — drive to the feed with the tines at deck height (the fork tag grabs there)
  [4, 4, 90, 1],  // 2 carry across the cell
  [0, 4, 180, 0], // 3 place — set the load back down, facing back (the fork tag releases there)
]

let wpIdx = 0
let phase = 'turn1'    // turn1 (face the target) → drive (straight) → turn2 (final heading) → act (forks)
let reversing = false  // this move starts with a straight BACK-OUT — no turning while the tines are in a bay
let liftAt = 0         // live fork height, m
let held = false       // grip state, latched at the commanded height (see step)
let moving = false
let ackLeft = 0        // s the done tag stays low after an accepted command, while execute is still held (see step)
let wheelAngle = 0     // shared wheel roll angle (visual)
// A move can finish inside the tick that accepted it (a lift of a few cm, or a spot the truck already stands on).
// Done must still DROP for every accepted command, or a handshake that waits to see the truck go busy waits for
// ever. One tick isn't enough: a PLC scanning slower than the sim, or polling over Modbus, can miss it. So done
// stays low until the program has released execute (it has seen the edge land) or this long has passed (a program
// that holds execute until done must not deadlock).
const MIN_BUSY_S = 0.5

definePart({
  joints: ['lift', 'piston', 'wheelLF', 'wheelRF', 'wheelLR', 'wheelRR'],
  grippers: ['gripper'],
  lamps: ['beacon'],
  params: {
    driveSpeed: { type: 'number', default: 1, min: 0.1, max: 5, step: 0.1, label: 'Drive speed (m/s)', group: 'Motion', desc: 'How fast the truck travels between waypoints.' },
    turnSpeed: { type: 'number', default: 90, min: 10, max: 360, step: 1, label: 'Turn speed (°/s)', group: 'Motion', desc: 'How fast it pivots on the spot. Every move turns to face the target, drives, then turns to the waypoint heading, so this sets much of the cycle time on short hops.' },
    liftSpeed: { type: 'number', default: 1.2, min: 0.1, max: 5, step: 0.1, label: 'Fork lift speed (m/s)', group: 'Motion', desc: 'How fast the tines raise and lower to the height the waypoint asks for.' },
    maxLiftHeight: { type: 'number', default: 3, min: 0.1, max: 8, step: 0.1, label: 'Max fork height (m)', group: 'Motion', desc: 'Ceiling on the tines, whatever a waypoint asks for. Set it to the top beam of the racking the truck actually serves.' },
    forkSpread: { type: 'number', unit: 'm', default: SPREAD_DEFAULT, min: SPREAD_MIN, max: SPREAD_MAX, step: 0.01, label: 'Fork spread', group: 'Forks', desc: SPREAD_DESC },
    reverseRange: { type: 'number', unit: 'm', default: 3, min: 0, max: 20, step: 0.5, label: 'Back-out range', group: 'Motion', desc: 'How close a target behind the truck, at about the heading it already holds, has to be for it to back out instead of turning round, the way tines withdraw from a rack bay. 0 means it always turns.' },
    commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: '', label: 'Command tag (0 = home, 1+ = waypoint)', group: 'Comms', desc: 'Which row of the waypoint table to drive to, as an index: 0 is home, 1 the second row and so on. Set it BEFORE pulsing execute. An index past the end of the table is ignored, and the truck stays put rather than guessing.' },
    executeTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Execute tag (rising edge runs the move)', group: 'Comms', desc: 'Pulse this false-to-true to start the move. It is edge-triggered, so holding it true does NOT repeat - drop it and raise it again for each move. An edge arriving mid-move is ignored.' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag (true while idle)', group: 'Comms', desc: 'True while the truck is parked and ready. It drops for every move it accepts, even one that finishes at once, and comes back once the move is over and Execute is released (or half a second has passed), so wait for it before pulsing Execute again.' },
    forkTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Fork tag (true grabs, false releases)', group: 'Comms', desc: 'Clamp or release whatever is sitting on the tines. It is read continuously rather than on an edge, so hold it true for the whole carry and drop it only once the load is where it belongs.' },
    waypoints: { type: 'numberList', columns: ['x m', 'z m', '°', 'fork m'], arity: 4, default: DEFAULT_WP, label: 'Waypoints (row 0 = home)', group: 'Motion', desc: 'The stops this truck knows, one row each: X and Z in the scene, the heading, and the tine height. Row 0 is home and the command tag picks a row. The tines move while it drives, except on a back-out, where they reach height first.' },
  },
  step(ctx) {
    const WP = ctx.params.waypoints.length ? ctx.params.waypoints : DEFAULT_WP

    // live pose (ctx.position/forward reflect a drive command the following tick)
    const px = ctx.position.x, pz = ctx.position.z
    const fx = ctx.forward.x, fz = ctx.forward.z
    const yaw = Math.atan2(-fz, fx)
    const turnRate = ctx.params.turnSpeed * D2R
    // ANG_TOL is a LEVER, not a nicety. The load rides about 1.25 m ahead of the pivot, so whatever heading
    // error this stops correcting at becomes that much times sin(err) of SIDEWAYS placement error - and it
    // lands twice, once captured into the grip at the pick and once again at the place. At 1.5 deg that was
    // ~33 mm a side, which put every rack delivery ~50 mm off the bay centre and 2.3 deg skewed: 30 mm INSIDE
    // an upright, invisible because the poles between bays don't collide (e2e/probes/rack-delivered-reach.mjs
    // measures it). 0.25 deg costs at most a tick, because turnCmd commands exactly the remaining angle and so
    // converges instead of creeping, and it leaves ~5 mm. POS_TOL deliberately stays where it is: that one is a
    // dead-band on the bearing to the target, which goes ill-conditioned close in, and tightening it makes the
    // truck hunt around the spot rather than park on it.
    const ANG_TOL = 0.25 * D2R, POS_TOL = 0.06
    const liftOf = (row) => clamp(row[3] || 0, 0, ctx.params.maxLiftHeight)
    const forksUp = ctx.readTag(ctx.params.forkTag)

    // Settle the fork tag against the height the tines are AT before a new command can move them. A program that
    // drops the fork and sends the next move in one scan means "let go here, then go": latched only after the
    // command, the grip would wait for the NEXT row's height and carry the load off with it (and a grab sent with
    // a move would close at the next stop, not the pick).
    const wasHeld = held
    if (Math.abs(liftAt - liftOf(WP[wpIdx] || WP[0])) < 1e-3) held = forksUp

    // ctx.rising diffs the begin-of-tick snapshot, so an edge held over the async tag bus can't be missed
    if (ctx.rising(ctx.params.executeTag) && !moving && ackLeft <= 0) {
      const cmd = Math.round(ctx.readNumber(ctx.params.commandTag))
      // an out-of-range command ignores the edge: stay put, done stays true
      if (cmd >= 0 && cmd < WP.length) {
        wpIdx = cmd; phase = 'turn1'; moving = true; ackLeft = MIN_BUSY_S
        // BACK OUT rather than turn round, when the target is behind, close, and asks for the heading already
        // held. That is the shape of exactly one move — withdrawing the tines from a rack bay — and turning to
        // face it would swing two metres of fork through the uprights and through the load just set down.
        // Anything beyond reverseRange is a haul rather than a withdrawal, so it drives forward as before.
        const t = WP[wpIdx]
        const bx = t[0] - px, bz = t[1] - pz
        reversing = ctx.params.reverseRange > 0 &&
          Math.hypot(bx, bz) <= ctx.params.reverseRange &&
          bx * fx + bz * fz < 0 &&
          Math.abs(angDiff(yaw, (t[2] || 0) * D2R)) <= 20 * D2R
      }
    }

    const tgt = WP[wpIdx] || WP[0]
    const tx = tgt[0], tz = tgt[1], tyaw = (tgt[2] || 0) * D2R
    const dx = tx - px, dz = tz - pz
    const dist = Math.hypot(dx, dz)

    // the fork height is the WAYPOINT's, clamped to the mast's travel; it holds still on the tick the grip changes
    const liftTgt = liftOf(tgt)
    if (held === wasHeld) liftAt = ctx.approach(liftAt, liftTgt, ctx.params.liftSpeed * ctx.dt)
    const forksSettled = Math.abs(liftAt - liftTgt) < 1e-3
    ctx.joints.lift = liftAt
    ctx.joints.piston = liftAt * PISTON_LIFT_RATIO
    // Grab and let go WHERE THE TINES ARE, never on the command itself. A grip captures the load's pose RELATIVE
    // to the tines at the moment it closes, so closing while they are still travelling makes the load ride that
    // gap for the whole trip, and opening mid-stroke lets it go in mid-air. Latching the tag on arrival instead
    // means the tines meet the load where it stands, carry it, and set it on whatever deck or beam they were
    // sent to before letting go — which is also just what a fork truck does.
    if (forksSettled) held = forksUp
    const gripChanged = held !== wasHeld
    ctx.grips.gripper = held

    let fwdCmd = 0, turnCmd = 0
    if (moving && reversing) {
      // BACK OUT the way an operator withdraws from a bay: tines to the row's height FIRST, standing still (lower
      // clear of the pallet just set down, or lift the one just taken off its beam), then straight back on the
      // heading already held. Nothing turns while the tines are in the bay - the drive is exact, so there is no
      // drift to steer out - and whatever is left once level with the target (a sideways offset, the row's own
      // heading) is finished below like any move, from out in the aisle. Stopping there instead parked the truck
      // up to reverseRange x sin(20 deg) to one side and reported done.
      const behind = -(dx * fx + dz * fz)
      if (forksSettled && behind > POS_TOL) fwdCmd = -Math.min(ctx.params.driveSpeed, behind / ctx.dt)
      else if (forksSettled) { reversing = false; phase = 'turn1' }
    }
    if (moving && !reversing) {
      if (phase === 'turn1') {
        if (dist <= POS_TOL) phase = 'turn2'
        else {
          const travel = Math.atan2(-dz, dx)
          const e = angDiff(yaw, travel)
          if (Math.abs(e) <= ANG_TOL) phase = 'drive'
          else turnCmd = clamp(e / ctx.dt, -turnRate, turnRate)
        }
      }
      if (phase === 'drive') {
        if (dist <= POS_TOL) phase = 'turn2'
        else {
          const travel = Math.atan2(-dz, dx)
          turnCmd = clamp(angDiff(yaw, travel) / ctx.dt, -turnRate, turnRate) // keep aligned while rolling
          fwdCmd = Math.min(ctx.params.driveSpeed, dist / ctx.dt) // never overshoot the waypoint in one tick
        }
      }
      if (phase === 'turn2') {
        const e = angDiff(yaw, tyaw)
        if (Math.abs(e) <= ANG_TOL) phase = 'act'
        else turnCmd = clamp(e / ctx.dt, -turnRate, turnRate)
      }
    }
    // the tick the grip closes or opens, nothing moves: it captures the load where it stands against still tines
    if (gripChanged) { fwdCmd = 0; turnCmd = 0 }
    ctx.drive(fwdCmd, turnCmd)

    // wheels roll from the commanded travel (the drive applies fwdCmd exactly, so command = actual)
    wheelAngle = wrapPi(wheelAngle + (fwdCmd * ctx.dt) / WHEEL_RADIUS)
    ctx.joints.wheelLF = wheelAngle
    ctx.joints.wheelRF = wheelAngle
    ctx.joints.wheelLR = wheelAngle
    ctx.joints.wheelRR = wheelAngle
    ctx.lamps.beacon = moving

    if (phase === 'act' && forksSettled) moving = false
    if (ctx.params.doneTag) ctx.writeTag(ctx.params.doneTag, !moving && ackLeft <= 0)
    // the acknowledgement ends once the program lets go of execute (read NEXT tick, after it has seen done low)
    if (ackLeft > 0) ackLeft = ctx.readTag(ctx.params.executeTag) ? ackLeft - ctx.dt : 0
  },
})
