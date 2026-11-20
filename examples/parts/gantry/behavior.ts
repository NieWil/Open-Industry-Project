// Cartesian Gantry: a 3-axis linear pick-and-place on three SERVO axes (x along the length, y across the width,
// z the lift, measured DOWNWARD). The host runs each servo's motion profile; this script decides where they go.
//
// Three ways a PLC drives it, picked by the 'mode' param:
//  - WAYPOINTS (default): an INT command tag picks a row of the taught waypoint table (0 = home), a rising Execute
//    runs the move, Done reads true while idle. A row outside the frame parks at the frame's limit.
//  - POSITION CONTROL: three REAL target tags say where to go, in metres, and a rising Execute goes there. A target
//    outside the frame drives toward the frame's end, stops short of it and raises Fault, as a real axis does at
//    its software limit (the other axes halt with it).
//  - FOLLOW: while Execute is HELD each axis tracks its target tag every scan, the way
//    a drive follows a motion controller: the PLC plans the motion (an MC_MoveAbsolute per axis on its own
//    AXIS_REF) and streams each axis's set position. Done reads true while all three sit on last scan's setpoints;
//    dropping Execute halts them. A setpoint past the frame parks that axis at the frame's end (Done stays false):
//    limits that FAULT are the program's own axis's (AXIS_REF software limits), as on a real drive in this mode.
// The first two move COORDINATED: each axis's velocity and acceleration are scaled by its share of the longest
// axis's travel, which scales the whole profile, so they start and arrive together and the tool runs a straight
// line. In follow mode the coordination is the program's. The actual X/Y/Z tags report where the axes are, every tick. An Enable tag (always on until a program drives it)
// powers the drives: dropping it stops the gantry dead and abandons the move, like a real drive's enable.
// With no tags named the gantry holds home. 'vacuumOn' is the authored idle vacuum: it seeds the grip state and
// lights the status LED at rest (the lamp's param) until a vacuum tag is named.
//
// The rig is assembled from Gantry.glb: four corner legs, twin Beam_Main rails, an X bridge on a prismatic 'x'
// joint, a Y carriage on 'z'-axis travel ('y' joint), and a telescoping Beam_Lift + Tool_01 on a downward
// prismatic 'z' joint ending in the vacuum gripper. The frame is parametric: the GLB members node-scale (mesh
// sizeParams - members are authored at a 4 m span, their Trim strip re-tiling along the stretch via tileUv so it
// never smears) while the corner/rail/carriage links slide out with the frame params. No collision links - the
// gantry frame straddles the line and never touches cargo (the gripper carry is host-side).
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

// Waypoints arrive already parsed + validated as number[][] (the 'waypoints' numberList, arity 3). Row 0 is home.
const DEFAULT_POSES = [
  [0, 0, 0],     // 0 home (raised, centred)
  [-1.4, 0.6, 0.7], // 1 pick (over the feed, lowered)
  [1.4, -0.6, 0.7], // 2 place (over the takeaway, lowered)
]
// a move reports busy for at least this long, so even a degenerate one shows the PLC a real busy window and the
// Execute/Done handshake can't miss it at any scan rate
const MIN_BUSY = 0.1

let grip = false
let moving = false
let busy = 0          // seconds since the active move was accepted
let fault = false     // the last move was refused (drives not enabled) or ended in a fault (a target past the frame)
let ids = [0, 0, 0]   // the active move's command per axis
let followed = [NaN, NaN, NaN] // follow mode: the setpoints sent last scan, which is what the positions read this scan reach

// Send all three axes to tgt, coordinated: true when every axis took its command.
function moveTo(S, tgt, speed, accel) {
  let longest = 0
  const dist = S.map((s, i) => {
    const d = Math.abs(tgt[i] - s.position)
    longest = Math.max(longest, d)
    return d
  })
  ids = S.map((s, i) => {
    const k = longest > 1e-9 ? dist[i] / longest : 1
    return s.moveAbsolute(tgt[i], k > 1e-9 ? { velocity: speed * k, accel: accel * k } : { velocity: speed, accel })
  })
  if (ids.every((id) => id > 0)) return true
  for (const s of S) s.halt() // one axis refused: none of them goes
  return false
}

// One axis in a fault (it reached the frame's end) ends the move: the others halt with it.
function faulted(S) {
  if (!S.some((s) => s.state === 'errorStop')) return false
  for (const s of S) if (s.state !== 'errorStop') s.halt()
  return true
}

definePart({
  servos: ['x', 'y', 'z'],
  grippers: ['gripper'],
  lamps: ['vacuumLamp'],
  params: {
    // Frame size — the rig's sizeParams/offsetParams reference these (legs/rails/bridge stretch with them).
    frameLength: { type: 'number', default: 4, min: 0.5, max: 20, step: 0.1, label: 'Frame length (m)', desc: 'Span of the frame along its X axis, which is also the travel available to the carriage. The legs, rails and bridge all stretch with it.' },
    frameWidth: { type: 'number', default: 2, min: 0.3, max: 10, step: 0.1, label: 'Frame width (m)', desc: 'Span across the frame in Y, the second axis of travel.' },
    frameHeight: { type: 'number', default: 1, min: 0.5, max: 10, step: 0.1, label: 'Frame height (m)', desc: 'Height of the frame, which sets how far the tool can be lowered on the lift axis.' },
    speed: { type: 'number', default: 1, min: 0.1, max: 10, step: 0.1, label: 'Motion speed (m/s)', group: 'Motion', desc: 'Top speed of a move, reached by the axis with the farthest to go. The other two are slowed in proportion so all three arrive together and the tool runs a straight line.' },
    accel: { type: 'number', default: 5, min: 0.1, max: 50, step: 0.1, label: 'Acceleration (m/s²)', group: 'Motion', desc: 'How hard the axes ramp up to speed and brake to a stop, for the axis with the farthest to go. Lower it for a heavier or more delicate load; a short move may never reach top speed at all.' },
    vacuumOn: { type: 'boolean', default: false, label: 'Vacuum on (idle grip + LED)', group: 'Start state', desc: 'Authored resting state of the vacuum: it seeds the grip and lights the status LED while the gantry sits idle. Once a vacuum tag is named, that tag takes over.' },
    mode: {
      type: 'enum', default: 'waypoints', label: 'Mode', group: 'Comms',
      desc: 'How the program drives the gantry. Waypoints: set the command tag to a row of the taught table and pulse Execute, like drives with stored positions. Position: write the X, Y and Z targets and pulse Execute; the gantry plans one coordinated straight-line move, like a gantry with its own controller. Follow setpoints: hold Execute and stream each axis set position every scan, for a program that runs its own motion control (an MC_MoveAbsolute per axis); the program does the coordinating.',
      options: [
        { value: 'waypoints', label: 'Taught waypoints (gantry plans the move)' },
        { value: 'position', label: 'Move to X/Y/Z (gantry plans the move)' },
        { value: 'follow', label: 'Follow PLC setpoints (PLC plans the motion)' },
      ],
    },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Enable tag', group: 'Comms', desc: 'Powers the drives. Drop it and the gantry stops where it is and abandons its move; raise it and it waits for the next Execute. Wire it to the cell being safe to work in. Until a program drives it, or with it empty, the drives are always on, so a merely-typed tag does not hold them.' },
    commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: '', label: 'Command tag (0 = home, 1+ = waypoint)', group: 'Comms', visibleWhen: { param: 'mode', is: 'waypoints' }, desc: 'Which row of the waypoint table to move to, as an index: 0 is home, 1 the second row and so on. Set it BEFORE pulsing execute. An index past the end of the table is ignored, and the arm stays put rather than guessing.' },
    targetXTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '', label: 'Target X tag', unit: 'm', group: 'Comms', visibleWhen: { param: 'mode', is: ['position', 'follow'] }, desc: 'Where to move along the length, in metres from the frame centre. Position mode: set all three targets BEFORE pulsing execute; outside the frame, the gantry drives toward the end of the frame, stops short of it and raises Fault. Follow mode: read every scan; outside the frame, that axis parks at the end of the frame.' },
    targetYTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '', label: 'Target Y tag', unit: 'm', group: 'Comms', visibleWhen: { param: 'mode', is: ['position', 'follow'] }, desc: 'Where to move across the width, in metres from the frame centre.' },
    targetZTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '', label: 'Target Z tag (down)', unit: 'm', group: 'Comms', visibleWhen: { param: 'mode', is: ['position', 'follow'] }, desc: 'How far to lower the tool, in metres below its raised position: 0 is fully up.' },
    executeTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Execute tag', group: 'Comms', desc: 'Pulse this false-to-true to start a move. It is edge-triggered, so holding it true does NOT repeat - drop it and raise it again for each move. In follow mode, hold it true for as long as the gantry should track the targets.' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag', group: 'Comms', desc: 'Handshake back to the program: true whenever the gantry is parked and ready for the next command. Wait for it before pulsing execute again, or the edge lands mid-move and is dropped. In follow mode: true while all three axes sit on their setpoints.' },
    faultTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Fault tag', group: 'Comms', desc: 'True when the last move was refused (the drives not enabled) or ended in a fault (a target past the frame: the gantry stops short of the frame end). The next Execute clears it, once the axes are still.' },
    actualXTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Actual X tag', unit: 'm', group: 'Comms', desc: 'Where the X axis is now, every scan, in the same metres as the target.' },
    actualYTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Actual Y tag', unit: 'm', group: 'Comms', desc: 'Where the Y axis is now.' },
    actualZTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Actual Z tag (down)', unit: 'm', group: 'Comms', desc: 'How far the tool is lowered now.' },
    gripperTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Vacuum tag', group: 'Comms', desc: 'Grip or release the load. Read continuously rather than on an edge, so hold it true for the whole carry and drop it only once the load is where it belongs.' },
    waypoints: { type: 'numberList', columns: ['x m', 'y m', 'z m'], arity: 3, default: DEFAULT_POSES, visibleWhen: { param: 'mode', is: 'waypoints' }, label: 'Waypoints (row 0 = home)', group: 'Motion', desc: 'Positions in frame-local metres, one row each: x along the length, y across, and z the lift measured DOWNWARD (larger is lower). Row 0 is home and the command tag picks a row. A value outside the frame parks at its limit.' },
  },
  init(ctx) {
    grip = ctx.params.vacuumOn === true
  },
  step(ctx) {
    const P = ctx.params
    const S = [ctx.servos.x, ctx.servos.y, ctx.servos.z]
    const enabled = !ctx.tagDriven(P.enableTag) || ctx.readTag(P.enableTag)
    for (const s of S) s.power(enabled)
    if (!enabled) moving = false // a drive that drops out abandons its move
    const following = P.mode === 'follow'
    // follow mode: Done compares with LAST scan's setpoints, since the positions read here are where the servos
    // stood before this scan
    const onTarget = S.every((s, i) => Math.abs(s.position - followed[i]) <= 1e-6)
    if (following) {
      const held = ctx.readTag(P.executeTag)
      if (ctx.rising(P.executeTag)) {
        for (const s of S) s.reset() // a fault clears on the next Execute (refused while an axis still brakes)
        fault = false
      }
      if (faulted(S)) fault = true
      else if (held) {
        const tgt = [ctx.readNumber(P.targetXTag), ctx.readNumber(P.targetYTag), ctx.readNumber(P.targetZTag)]
        if (S.map((s, i) => s.follow(tgt[i])).some((id) => id <= 0)) {
          for (const s of S) s.halt() // one axis refused (the drives are off): none of them goes
          fault = true
        }
        followed = tgt
      } else for (const s of S) if (s.state === 'continuous') s.halt()
      moving = false
      if (P.gripperTag) grip = ctx.readTag(P.gripperTag)
    } else {
      // ctx.rising diffs the begin-of-tick snapshot, so an edge can't be dropped over the async bus the way a
      // hand-rolled prev-flag could
      if (ctx.rising(P.executeTag) && !moving) {
        let tgt = null
        if (P.mode === 'position') {
          tgt = [ctx.readNumber(P.targetXTag), ctx.readNumber(P.targetYTag), ctx.readNumber(P.targetZTag)]
        } else {
          const POSES = P.waypoints.length ? P.waypoints : DEFAULT_POSES
          const cmd = Math.round(ctx.readNumber(P.commandTag))
          if (cmd >= 0 && cmd < POSES.length) {
            // a taught row outside the frame parks at the frame's limit: a 0.12 m inset on both horizontal axes
            // (0.06 per side), and the lift stopping 0.225 m short of the frame top
            const xHalf = Math.max((P.frameLength - 0.12) / 2, 0)
            const yHalf = Math.max((P.frameWidth - 0.12) / 2, 0)
            const zMax = Math.max(P.frameHeight - 0.225, 0)
            const raw = POSES[cmd]
            tgt = [ctx.clamp(raw[0], -xHalf, xHalf), ctx.clamp(raw[1], -yHalf, yHalf), ctx.clamp(raw[2], 0, zMax)]
          }
        }
        if (tgt) {
          for (const s of S) s.reset() // a fault clears on the next Execute (refused while an axis still brakes)
          moving = moveTo(S, tgt, P.speed, P.accel)
          fault = !moving
          busy = 0
        }
      }
      if (P.gripperTag) grip = ctx.readTag(P.gripperTag)
    }
    if (moving) {
      busy += ctx.dt
      if (faulted(S)) {
        moving = false
        fault = true
      } else if (busy >= MIN_BUSY && S.every((s, i) => s.done(ids[i]))) moving = false
    }
    ctx.grips.gripper = grip
    ctx.lamps.vacuumLamp = grip
    if (P.doneTag) ctx.writeTag(P.doneTag, following ? onTarget : !moving)
    if (P.faultTag) ctx.writeTag(P.faultTag, fault)
    if (P.actualXTag) ctx.writeNumber(P.actualXTag, S[0].position)
    if (P.actualYTag) ctx.writeNumber(P.actualYTag, S[1].position)
    if (P.actualZTag) ctx.writeNumber(P.actualZTag, S[2].position)
  },
})
