// Stretch Wrapper — a rotary-arm wrapper that stands over a conveyor and unitises the load stopped under it.
//
// The load never moves: a single column beside the line carries a boom over it, and an arm under the boom turns
// about the load's centre, carrying a mast with the film carriage on it. A cycle is the one every such machine
// runs: wraps at the base to tie the load to its pallet, a climb while the arm keeps turning (the spiral), wraps
// at the top, and back down on a second pass before the arm parks beside the column. The carriage finds the top of
// the load itself, with a photo-eye that looks in at the load and climbs until it sees over it. It climbs only while
// the eye sees the load, and calls the top only once the eye has stayed clear for half a turn: the eye sweeps round
// with the arm, and the gap between two rows of cases passes it on every turn.
//
// What it does to the load is three product-state calls, so the load carries the result on down the line:
//   - ctx.dress fits the FILM round everything resting on the pallet in the station zone, in this part's own 'film'
//     material, up to the top of the roll on the carriage as it climbs; while the arm turns the web of film runs from
//     the roll back to the corner of the load it last went round.
//   - ctx.join, once the arm has parked, makes the load ONE unit load: pallet and cases a single rigid body, the way a
//     wrapped load travels, stores and is picked on a real line.
//   - ctx.mark leaves `wrapped: true` on it, which any part downstream can read (ctx.marked, a beam's marks).
//
// It is COMMANDED: one cycle per request, a request being a rising edge on the start tag while a program drives it,
// else a Use, else (Auto wrap) a load that has stood in the station for a moment. A request with no load in the
// station is dropped. Busy reads true from the request until the arm has parked; Done reads true from then until
// the load leaves the station, so a program holds its conveyor on Busy and carries on at Done. In position is the
// station eye across the line, just downstream of centre: a program stops the load on it.
//
// The enable tag is the safety stop. Dropped mid-cycle, the arm brakes to a standstill in SAFE_STOP and the carriage
// holds where it is. The cycle keeps its place and carries on when the tag comes back, so a load is never wrapped
// twice at the base. A program wires it to the line running, so a Stop or a trip holds the wrap and a Start
// finishes it.
//
// Part frame: the origin is on the conveyor surface at the wrap axis, loads travel along Z (either way), and the
// column stands at +X, where the arm parks so a load can pass. The arm sweeps a 1.45 m radius: the roll runs 1.1 m
// out, far enough outside a pallet load's corners (0.8 m on 48 x 40 in, 0.82 m on the largest, 1165 x 1165) that the
// web of film shows crossing the gap.

const TAU = Math.PI * 2
const WEB = 0.5 // the film's width (the roll's height): the band one turn lays down
// the roll, on the carriage: the web leaves its inner face (the roll is 0.055 in radius, its axis 0.06 in from the
// carriage datum), 1.1 m out from the wrap axis, so a web of film crosses the gap to the load's corners
const ROLL = { link: 'carriage', offset: [-0.115, 0.03, 0], height: WEB }
const ROLL_BASE = 0.03 // the carriage's lowest point above the conveyor surface (its joint 0)
const FILM_OPACITY = 0.42 // how see-through the film is on the load
const RAMP = 1.2 // seconds to bring the arm up to speed, or down from it
// seconds from full speed to a standstill on a dropped enable: about a tenth of a turn at 18 rpm, where RAMP would
// swing the arm a third of a turn on
const SAFE_STOP = 0.4
const AUTO_SETTLE = 1.0 // Auto wrap: how long a load stands in the station before the cycle starts

let phase = 'idle' // idle | base | climb | top | descend | park
let angle = 0 // arm angle, rad, 0 = parked beside the column
let omega = 0 // arm speed, rad/s
let lift = 0 // carriage height above its lowest point, m
let turnLeft = 0 // rad still to turn in the base / top phase
let turned = 0 // rad turned this cycle (the film goes on after the first quarter turn)
let clearFor = 0 // rad the arm has turned since the carriage eye last saw the load
let pending = false
let wrappedHere = false // the load now in the station has been wrapped; cleared when the station empties
let settle = 0
let blink = 0

definePart({
  interactive: true, // Use wraps the load in the station (by hand, when no program owns the start tag)
  joints: ['arm', 'lift'],
  lamps: ['beacon'],
  params: {
    rpm: { type: 'number', unit: 'rpm', default: 18, min: 4, max: 30, step: 1, label: 'Arm speed', group: 'Wrap cycle', desc: 'How fast the arm turns while wrapping. The carriage climbs in step with it, so this sets the cycle time, not the spiral.' },
    overlap: { type: 'number', unit: '%', default: 60, min: 0, max: 90, step: 5, label: 'Film overlap', group: 'Wrap cycle', desc: 'How much of each band the next turn of the spiral covers. The carriage climbs with the arm, one film width less this per turn, so the overlap holds at any arm speed. Wrapped loads are usually run at 50-70%.' },
    liftSpeed: { type: 'number', default: 0.15, min: 0.03, max: 0.6, step: 0.01, label: 'Carriage speed (m/s)', group: 'Wrap cycle', desc: 'How fast the film carriage travels when it is not climbing the spiral: it drops to the base and comes back down from the top at twice this.' },
    baseTurns: { type: 'number', default: 1.5, min: 0, max: 6, step: 0.5, label: 'Base wraps', group: 'Wrap cycle', desc: 'Turns at the bottom before the climb: the film run down over the pallet boards is what ties the load to its pallet.' },
    topTurns: { type: 'number', default: 1.5, min: 0, max: 6, step: 0.5, label: 'Top wraps', group: 'Wrap cycle', desc: 'Turns at the top of the load before the carriage comes back down.' },
    autoWrap: { type: 'boolean', default: true, label: 'Auto wrap', desc: 'With no program driving the start tag, wrap a load once it has stood in the station for a moment, and only once. Off, it wraps only on Use.' },
    standHeight: { type: 'number', default: 1, min: 0.2, max: 2.5, step: 0.01, label: 'Stand height (m)', desc: 'Height of the conveying surface the load stands on. The part stands with its origin on that surface, and its column runs from here down to the floor.' },
    frameColor: { type: 'color', default: '#24507a', label: 'Frame color', group: 'Colors', desc: 'Paint of the column, the boom and its knee brace.' },
    armColor: { type: 'color', default: '#f2bd0f', label: 'Arm color', group: 'Colors', desc: 'Paint of the rotating arm and its mast, the parts that sweep round the load.' },
    showBeam: { type: 'boolean', default: false, label: 'Show beams', desc: 'Draw the station eye and the film carriage eye. Off by default: the carriage eye turns with the arm.' },
    startTag: { type: 'tag', dir: 'in', stType: 'BOOL', autoWhenDriven: true, default: '', label: 'Start tag (rising edge)', group: 'Comms', desc: 'Each rising edge starts ONE wrap cycle on the load in the station; holding it true does not wrap again. While a program drives this tag it owns the machine: Use and Auto wrap stand aside.' },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Enable tag', group: 'Comms', desc: 'The wrapper moves only while this is true. Drop it and the arm brakes to a stop where it is and the carriage holds; raise it and the cycle carries on from there. A start while it is false is ignored. Wire it to the line running, so a Stop or a trip holds the wrap and a Start finishes it. Until a program drives it, or with it empty, the wrapper is always enabled, so a merely-typed tag does not hold it.' },
    busyTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Busy tag', group: 'Comms', desc: 'True from a start until the arm has parked beside the column. Hold the conveyor while it is true: the arm is turning around the load.' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag', group: 'Comms', desc: 'True once the load in the station is wrapped and the arm is parked, until the load leaves. Carry on down the line when it goes true.' },
    inPositionTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'In position tag', group: 'Comms', desc: 'The station eye, across the line just downstream of the wrap axis: true while a load blocks it. Stop the conveyor on it and the load comes to rest centred under the arm.' },
  },
  // The machine, drawn. The column, boom and hub are on the part root; the arm, mast and counterweight ride 'arm';
  // the carriage, its film roll and its eye ride 'carriage'. Carriage y = 0 is its lowest point, ROLL_BASE over the
  // conveyor surface.
  geometry(g, p) {
    var num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d }
    var sh = num(p.standHeight, 1)
    var B = 0.004
    var box = function (list, x0, x1, y0, y1, z0, z1, square) {
      list.push(g.bevelBox([Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], B, square))
    }
    // a round bar along an axis through `center`: [radius, from, to] measured along that axis
    var bar = function (list, axis, center, rad, from, to, seg) {
      list.push(g.lathe([[0, from], [rad, from], [rad, to], [0, to]], { axis: axis, center: center, segments: seg || 16 }))
    }
    // a hex head, nut or thread end standing on a face: `face` is its coordinate along the axis, s the side it
    // stands out to (+1 / -1), af across flats
    var hx = function (list, axis, center, face, s, af, h) {
      var a = s > 0 ? face : face - h, b = s > 0 ? face + h : face, r = af / Math.sqrt(3)
      list.push(g.lathe([[0, a], [r, a], [r, b], [0, b]], { axis: axis, center: center, segments: 6, smooth: false }))
    }
    // a floor anchor on a plate whose top is at y: a square washer, a nut and the stud end
    var anchor = function (list, x, y, z) {
      box(list, x - 0.016, x + 0.016, y - 0.0005, y + 0.003, z - 0.016, z + 0.016, ['y-'])
      hx(list, 'y', [x, 0, z], y + 0.003, 1, 0.022, 0.012)
      hx(list, 'y', [x, 0, z], y + 0.015, 1, 0.012, 0.009)
    }
    // a square member of side t from (x0, y0) to (x1, y1) in the XY plane at z = 0
    var strut = function (list, x0, y0, x1, y1, t) {
      var dx = x1 - x0, dy = y1 - y0, th = Math.atan2(dy, dx)
      list.push(g.transform(g.bevelBox([Math.sqrt(dx * dx + dy * dy), t, t], [0, 0, 0], B, ['x-', 'x+']), { rotate: [0, 0, Math.sin(th / 2), Math.cos(th / 2)], translate: [(x0 + x1) / 2, (y0 + y1) / 2, 0] }))
    }
    var frame = [], dark = [], panel = [], steel = []

    // --- the column: on a base plate with a stiffener fin off each face and four anchors, capped by the boom,
    //     which is bolted to it through an end plate. A knee brace, bolted at both ends, carries the boom ---
    var CX = 1.7, yp = -sh + 0.012
    box(frame, CX - 0.08, CX + 0.08, yp, 1.95, -0.08, 0.08, ['y-'])
    box(dark, CX - 0.22, CX + 0.22, -sh, yp, -0.22, 0.22, ['y-'])
    for (var f = -1; f <= 1; f += 2) {
      frame.push(g.extrude([[CX + f * 0.08, yp], [CX + f * 0.19, yp], [CX + f * 0.08, yp + 0.2]], -0.006, 0.006, { axis: 'z' }))
      frame.push(g.extrude([[yp, f * 0.08], [yp, f * 0.19], [yp + 0.2, f * 0.08]], CX - 0.006, CX + 0.006, { axis: 'x' }))
      for (var f2 = -1; f2 <= 1; f2 += 2) anchor(dark, CX + f * 0.16, yp, f2 * 0.16)
    }
    box(frame, -0.22, CX + 0.08, 1.8, 1.95, -0.09, 0.09)
    box(frame, CX + 0.08, CX + 0.094, 1.785, 1.96, -0.11, 0.11, ['x-'])
    box(dark, -0.232, -0.22, 1.805, 1.945, -0.085, 0.085, ['x+'])
    for (var ey = 0; ey < 2; ey++) for (var ez = -1; ez <= 1; ez += 2) hx(dark, 'x', [0, 1.82 + ey * 0.11, ez * 0.07], CX + 0.094, 1, 0.022, 0.009)
    var KA = [CX - 0.09, 1.36], KB = [CX - 0.56, 1.81]
    strut(frame, KA[0], KA[1], KB[0], KB[1], 0.08)
    for (var kt = 0; kt < 2; kt++) {
      var tt = kt ? 0.86 : 0.14, kx = KA[0] + (KB[0] - KA[0]) * tt, ky = KA[1] + (KB[1] - KA[1]) * tt
      hx(dark, 'z', [kx, ky, 0], 0.04, 1, 0.02, 0.008)
      hx(dark, 'z', [kx, ky, 0], -0.04, -1, 0.02, 0.01)
    }

    // --- the drive: the slewing bearing's housing under the boom; on top, the gearbox on its flange (bolted
    //     down), the motor lying along the boom with its fan cowl and terminal box, and the beacon's base ---
    bar(dark, 'y', [0, 0, 0], 0.14, 1.68, 1.8)
    box(dark, -0.17, 0.17, 1.95, 1.965, -0.14, 0.14, ['y-'])
    for (var gx = -1; gx <= 1; gx += 2) for (var gz = -1; gz <= 1; gz += 2) hx(dark, 'y', [gx * 0.145, 0, gz * 0.115], 1.965, 1, 0.02, 0.008)
    box(dark, -0.12, 0.12, 1.965, 2.16, -0.11, 0.11, ['y-'])
    bar(dark, 'x', [0, 2.06, 0], 0.075, 0.12, 0.44, 24)
    bar(steel, 'x', [0, 2.06, 0], 0.082, 0.44, 0.5, 24)
    bar(dark, 'x', [0, 2.06, 0], 0.06, 0.5, 0.505, 24)
    box(dark, 0.2, 0.3, 2.13, 2.18, -0.045, 0.045, ['y-'])
    bar(dark, 'y', [CX, 0, 0], 0.055, 1.95, 1.958, 16)

    // --- the control cabinet on the column: an enclosure with a hinged door under a rain hood, a handle and a
    //     nameplate, and a gland plate underneath. No screen or buttons, since none of them would do anything. The
    //     station eye hangs off a clamp collar on the column, looking across the line ---
    var PX = CX + 0.08, PF = CX + 0.3
    box(panel, PX, PF - 0.008, -0.35, 0.45, -0.25, 0.25, ['x-'])
    box(panel, PF - 0.009, PF, -0.342, 0.442, -0.242, 0.242, ['x-'])
    box(panel, PX, PF + 0.022, 0.45, 0.466, -0.268, 0.268, ['x-'])
    for (var sw = -1; sw <= 1; sw += 2) bar(dark, 'y', [PF + 0.004, 0, -0.247], 0.007, sw > 0 ? 0.3 : -0.26, sw > 0 ? 0.37 : -0.19, 8)
    box(dark, PF, PF + 0.018, -0.2, -0.1, 0.205, 0.225, ['x-'])
    box(steel, PF, PF + 0.003, 0.39, 0.42, -0.1, 0.1, ['x-'])
    box(dark, PX + 0.01, PF - 0.02, -0.366, -0.35, -0.22, 0.22, ['y+'])
    for (var gl = -1; gl <= 1; gl++) bar(dark, 'y', [PX + 0.11, 0, gl * 0.12], 0.014, -0.4, -0.366, 12)
    box(steel, CX - 0.092, CX + 0.092, 0.555, 0.645, -0.092, 0.092)
    hx(dark, 'x', [0, 0.6, 0.05], CX + 0.092, 1, 0.02, 0.008)
    hx(dark, 'x', [0, 0.6, -0.05], CX + 0.092, 1, 0.02, 0.008)
    box(steel, CX - 0.05, CX + 0.01, 0.57, 0.63, -0.56, -0.092, ['z+'])
    box(dark, 1.42, CX - 0.05, 0.55, 0.65, -0.57, -0.49) // outside the arm's 1.45 m sweep at this z

    // --- the arm: a flange under the gearbox, the arm out to the mast (capped, with a gusset in the corner and the
    //     mast bolted to it), the mast down to the conveyor with a stop at its foot, and a counterweight of bolted
    //     plates on the short end ---
    var arm = [], armDark = [], armAlu = []
    bar(armAlu, 'y', [0, 0, 0], 0.16, -0.06, 0.02)
    box(arm, -0.12, 1.42, -0.1, 0, -0.07, 0.07)
    box(arm, 1.3, 1.4, -1.63, -0.1, -0.06, 0.06, ['y+'])
    arm.push(g.extrude([[1.3, -0.1], [1.06, -0.1], [1.3, -0.34]], -0.006, 0.006, { axis: 'z' }))
    box(armDark, 1.42, 1.432, -0.098, -0.002, -0.068, 0.068, ['x-'])
    box(armDark, 1.29, 1.41, -1.66, -1.63, -0.07, 0.07, ['y+'])
    for (var mb = 0; mb < 2; mb++) {
      hx(armDark, 'z', [1.35, -0.15 - mb * 0.08, 0], 0.06, 1, 0.02, 0.008)
      hx(armDark, 'z', [1.35, -0.15 - mb * 0.08, 0], -0.06, -1, 0.02, 0.01)
    }
    for (var cw = 0; cw < 4; cw++) box(armDark, -0.45 + cw * 0.0825, -0.45 + (cw + 1) * 0.0825 - 0.003, -0.14, 0.02, -0.12, 0.12)
    for (var tr = -1; tr <= 1; tr += 2) {
      hx(armDark, 'x', [0, -0.06, tr * 0.08], -0.45, -1, 0.024, 0.012)
      hx(armDark, 'x', [0, -0.06, tr * 0.08], -0.462, -1, 0.013, 0.012)
    }

    // --- the film carriage: top and bottom plates, a back plate and a sleeve round the mast, the roll between
    //     the plates, two pre-stretch rollers beside it, and the eye on the top plate; bolted together ---
    var car = [], carAlu = [], film = [], carDark = []
    box(car, -0.13, 0.08, 0, 0.02, -0.13, 0.13)
    box(car, -0.13, 0.08, 0.54, 0.56, -0.13, 0.13)
    box(car, 0.02, 0.07, 0.02, 0.54, -0.035, 0.035, ['y-', 'y+'])
    box(car, 0.07, 0.2, 0.2, 0.36, -0.085, -0.065)
    box(car, 0.07, 0.2, 0.2, 0.36, 0.065, 0.085)
    box(car, 0.18, 0.2, 0.2, 0.36, -0.065, 0.065)
    bar(film, 'y', [-0.06, 0, 0], 0.055, 0.03, 0.53)
    bar(carDark, 'y', [-0.06, 0, 0], 0.028, 0.02, 0.54)
    bar(carAlu, 'y', [0.0, 0, 0.095], 0.022, 0.03, 0.53, 12)
    bar(carAlu, 'y', [0.0, 0, -0.095], 0.022, 0.03, 0.53, 12)
    box(carDark, -0.14, -0.1, 0.45, 0.49, -0.025, 0.025)
    for (var cb = -1; cb <= 1; cb += 2) {
      hx(carDark, 'y', [0.045, 0, cb * 0.11], 0.56, 1, 0.018, 0.007)
      hx(carDark, 'y', [0.0, 0, cb * 0.095], 0.56, 1, 0.03, 0.008)
      hx(carDark, 'x', [0, 0.24 + (cb + 1) * 0.04, 0], 0.2, 1, 0.018, 0.007)
    }

    var m = function (list) { return g.merge.apply(g, list) }
    return [
      { desc: m(frame), material: 'frame', colorParam: 'frameColor' },
      { desc: m(dark), material: 'dark' },
      { desc: m(panel), material: 'panel' },
      { desc: m(steel), material: 'steel' },
      { desc: m(arm), material: 'arm', colorParam: 'armColor', link: 'arm' },
      { desc: m(armDark), material: 'dark', link: 'arm' },
      { desc: m(armAlu), material: 'alu', link: 'arm' },
      { desc: m(car), material: 'steel', link: 'carriage' },
      { desc: m(carAlu), material: 'alu', link: 'carriage' },
      { desc: m(carDark), material: 'dark', link: 'carriage' },
      { desc: m(film), material: 'film', link: 'carriage' },
    ]
  },
  step(ctx) {
    const p = ctx.params
    const dt = ctx.dt
    const loaded = ctx.zone('station') > 0
    if (!loaded && phase === 'idle') wrappedHere = false // the wrapped load has gone: the next one is due

    // requests: the program's edge while it owns the machine, else a Use or a load standing in the station
    const driven = ctx.tagDriven(p.startTag)
    const enabled = !ctx.tagDriven(p.enableTag) || ctx.readTag(p.enableTag) === true
    if (driven) {
      if (ctx.rising(p.startTag)) pending = true
    } else {
      if (ctx.used()) pending = true
      settle = loaded && phase === 'idle' && !wrappedHere ? settle + dt : 0
      if (p.autoWrap && settle >= AUTO_SETTLE) pending = true
    }
    if (phase === 'idle' && pending) {
      pending = false
      if (loaded && enabled) {
        phase = 'base'
        turnLeft = Math.max(0, p.baseTurns) * TAU
        turned = 0
        clearFor = 0
      }
    }

    // the arm: up to speed while wrapping, and in 'park' down again so that it stops exactly beside the column. With
    // the enable dropped it brakes hard wherever it is.
    const wMax = (Math.max(1, p.rpm) * TAU) / 60
    const accel = wMax / RAMP
    if (!enabled) {
      omega = Math.max(0, omega - (wMax / SAFE_STOP) * dt)
    } else if (phase === 'park') {
      const rem = (TAU - angle) % TAU
      const stopping = (omega * omega) / (2 * accel)
      if (rem <= stopping + 1e-6) omega = Math.sqrt(Math.max(0, 2 * accel * rem))
      else omega = Math.min(wMax, omega + accel * dt)
    } else if (phase !== 'idle') {
      omega = Math.min(wMax, omega + accel * dt)
    }
    if (phase === 'park') {
      const rem = (TAU - angle) % TAU // still to turn to the park angle (0 = TAU), going forward
      // a braking arm that reaches the park angle stops there too, so it never runs a turn past it
      if (rem < 1e-3 || omega * dt >= rem) {
        angle = 0
        omega = 0
        phase = 'idle'
        wrappedHere = true
        // wrapped: the load is one unit from here, and says so
        ctx.join('station')
        ctx.mark('station', 'wrapped', true)
      }
    }
    const step = omega * dt
    angle = (angle + step) % TAU
    if (phase !== 'idle' && phase !== 'park') turned += step

    // the carriage: at the bottom for the base wraps, up the mast until its eye sees over the load, wraps at the
    // top, and back down. With the enable dropped it holds its height and the cycle holds its phase.
    const up = Math.max(0.01, p.liftSpeed) * dt
    const MAX = 1.5
    if (!enabled) {
      // held
    } else if (phase === 'base') {
      lift = ctx.approach(lift, 0, 2 * up)
      turnLeft -= step
      if (turnLeft <= 0 && lift === 0) phase = 'climb'
    } else if (phase === 'climb') {
      if (ctx.sense('eye').hit) {
        clearFor = 0
        // one film width less the overlap per turn of the arm, so the overlap does not depend on the arm speed
        const overlap = Math.min(0.9, Math.max(0, (p.overlap ?? 60) / 100))
        lift = Math.min(MAX, lift + (step / TAU) * WEB * (1 - overlap))
      } else clearFor += step
      if (clearFor >= TAU / 2 || lift >= MAX) {
        phase = 'top'
        turnLeft = Math.max(0, p.topTurns) * TAU
      }
    } else if (phase === 'top') {
      turnLeft -= step
      if (turnLeft <= 0) phase = 'descend'
    } else if (phase === 'descend') {
      lift = ctx.approach(lift, 0, 2 * up)
      if (lift === 0) phase = 'park'
    }

    // the film: laid on the load up to the top of the roll while the arm turns, once it has turned far enough to
    // have caught the load
    const wrapping = phase === 'base' || phase === 'climb' || phase === 'top' || phase === 'descend'
    if (wrapping && turned >= TAU / 4) {
      ctx.dress('station', { id: 'film', material: 'film', opacity: FILM_OPACITY, upTo: ROLL_BASE + ROLL.offset[1] + lift + WEB, web: ROLL })
    }

    ctx.joints.arm = angle
    ctx.joints.lift = lift
    const busy = pending || phase !== 'idle'
    blink = (blink + dt) % 1
    ctx.lamps.beacon = busy && blink < 0.5
    if (p.busyTag) ctx.writeTag(p.busyTag, busy)
    if (p.doneTag) ctx.writeTag(p.doneTag, phase === 'idle' && wrappedHere && loaded)
    if (p.inPositionTag) ctx.writeTag(p.inPositionTag, ctx.sense('inPos').hit)
  },
})
