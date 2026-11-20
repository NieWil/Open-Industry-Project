// Chain Transfer — a right-angle transfer (RAT). Cargo normally flows through the bed along the
// part's forward (+X, the main line, like every conveyor); on a pop-up command the chain lanes rise and the bed
// diverts it 90° along −Z (the chains' travel direction, off the side). One `conveys` deck carries cargo; the
// behavior switches its surface velocity between the two world directions (derived from ctx.forward) and lifts the
// chains while diverting — the lift slews at a tween rate, not a one-tick jump. Driven by an authored `raised`
// toggle / a hand Use, or — while a PLC program drives its pop-up tag (ctx.tagDriven) — the tag. The
// auto-vs-hand handoff follows output ownership, like a real panel.
//
// Placement: lane-parity track snap onto a roller bed (snap.track.lanes), host pitch adopted into `distance`, lane
// length auto-fit to the host bed.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

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

const RAISE = 0.095 // pop-up stroke, m (travel time is the `raiseTime` param — a real RAT's lift is geared)
const LANE_D = 0.33 // default lane spacing, m (the `distance` default)
// The lane's strand crown, above its mount - the surface a load actually rides on.
const NATIVE_LANE_TOP = 0.0058
// The lanes hang so their STRAND CROWN sits on the conveying deck, because the deck is only a physics stand-in
// for these chains: cargo is carried at the deck's top face, so anything else draws the chains somewhere the
// load is not. At -0.08 the crown sat 74 mm UNDER the deck, and the pop-up could not make that back - a 95 mm
// stroke against a 74 mm hole plus the deck's own 30 mm recess left the chains 9 mm BELOW the host rollers at
// full extension. The deck (and so the cargo) rose over them correctly the whole time; only the chains you can
// see stayed under, which is why it read as "the chains never come up".
const LANE_Y = -NATIVE_LANE_TOP
let raised = false // runtime state — follows the 'raised' param and a Use/click (pilot mode)
let lastRaised // adopt the Inspector 'raised' toggle whenever it changes
let lift = null // current lift, m; seeded from the authored state on the first step, then chases the target

definePart({
  interactive: true, // a Use/click pops the chains up/down
  useParam: 'raised', // the hand state is the param: the state a run starts from. The Inspector sets it; Use never writes it
  joints: ['lift'],
  params: {
    chains: { type: 'number', default: 5, min: 1, max: 10, step: 1, label: 'Chains', group: 'Size', desc: 'How many chain strands lift between the rollers. More strands spread the load, so a small or floppy carton is less likely to sag between them.' },
    distance: { type: 'number', default: LANE_D, min: 0.03, max: 5, step: 0.01, label: 'Lane spacing (m)', group: 'Size', desc: 'Centre-to-centre gap between chain strands. Together with the strand count this sets how wide the transfer reaches across the host bed.' },
    laneLength: { type: 'number', default: 2, min: 0.5, max: 3, step: 0.1, label: 'Lane length (m)', group: 'Size', desc: 'How far each strand runs in the transfer direction - the stroke available to push product off the main line.' },
    ...speedUnitParams(2),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 2, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'How fast the chains carry product sideways once raised. Negative sends it the other way.' },
    raised: { type: 'boolean', default: false, label: 'Raised (divert)', group: 'Start state', desc: 'Lift the chains above the roller line to take the load off the main lane and drive it sideways. This is the state it starts in; Use cycles it by hand. While a program drives the pop-up tag below, that program owns it instead.' },
    // How long the lift takes end to end. It is a real interlock, not decoration: a deck driven through its own
    // stroke is a powered surface travelling sideways while still BELOW the roller line, dragging at the row it is
    // about to lift, so a program has to wait this out before it commands the deck to run.
    // It also has a FLOOR set by the cargo, not by the machine. The lift is a linear tween, so the deck steps
    // straight to RAISE/raiseTime and hands the load that speed; at the top the deck stops and the load does not,
    // carrying on for v²/2g. The default throws cargo ~20 mm, which a packed row survives; halving the time
    // quadruples that, and by ~0.07 s a row is thrown ~94 mm and lands with its packing gone.
    raiseTime: { type: 'number', default: 0.15, min: 0.02, max: 2, step: 0.01, label: 'Pop-up time (s)', desc: 'How long the chains take to rise or drop. A program must wait this out before running the transfer, and a quicker pop-up throws the load harder: at the default a packed row moves about 20 mm, and below about 0.07 s it loses its packing.' },
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands chain speed here, replacing the Speed field above. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0.' },
    ...speedFpmTagParam('Comms'),
    // autoWhenDriven: this tag COMMANDS the pop-up (the step's auto gate reads it), so a program driving it
    // owns the device — the pilot prompt shows "In auto - PLC controlled" instead of a dead "Use".
    popupTag: { type: 'tag', dir: 'in', stType: 'BOOL', autoWhenDriven: true, default: '', label: 'Pop-up tag (true = divert)', group: 'Comms', desc: 'Raise the chains from the program. While a program drives this tag it OWNS the transfer, so a hand Use in pilot mode is refused with "In auto - PLC controlled".' },
  },
  // The chain lanes, drawn. One lane is built in the lane's own frame and NATIVE units (+X along the lane, +Y up, +Z
  // across), at the TRUE lane length — the run is as long as
  // the lane needs and the ends (channel end caps, sprockets, feet, the chain's half-loops) keep their own size, so
  // a sprocket is round at any length. Each lane is then turned into place (+X along → part −Z, the divert
  // direction) and thinned across to the app's lane width, and all lanes merge per material: three draws however
  // many lanes. Everything rides the 'chainBank' link, which the lift raises.
  //
  // The chain is ONE loop — both runs and both half-loops — with its link texture laid out at 16 links a metre all
  // the way round (U in tiles), and it SCROLLS (MeshPart.scroll) at the reported 'speed', the chain drive the
  // program commands: the links move at exactly that speed, the top run toward the divert direction, whether the
  // chains are up or down (the drive and the lift are separate outputs, as on the machine).
  geometry(g, p) {
    var num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d }
    var n = Math.max(1, Math.round(num(p.chains, 5)))
    var pitch = num(p.distance, LANE_D)
    var half = Math.max(num(p.laneLength, 2), 0.1) / 2
    var EX = Math.max(half - 0.1096, 0.02) // the run's half-length: the feet reach 0.1096 past it, so the lane measures laneLength overall
    var SA = 0.04 / 0.087 // across: the model's 0.087 channel thinned to the app's 4 cm lane
    var PIVOT = -0.094309 // the sprocket axle, below the strand crown
    var YAW = [0, Math.SQRT1_2, 0, Math.SQRT1_2] // +90° about +Y: lane +X → part −Z, lane +Z → part +X
    var LINKS_PER_M = 16
    var frame = [], support = [], chain = []

    // ---- the frame (blue): two rails under the lane, the U channel the chain runs in, its round-topped end caps,
    // and a foot at each end (two tapered gussets + a slotted mounting flange outboard of each)
    for (var s = -1; s <= 1; s += 2) frame.push(g.bevelBox([2 * EX, 0.1561, 0.01], [0, -0.27835, s * 0.0554], 0.001, ['x-', 'x+']))
    var channel = [[0.0221, -0.28], [0.0241, -0.278], [0.0241, -0.002], [0.0261, 0], [0.0398, 0], [0.0418, -0.002], [0.0418, -0.298], [0.0398, -0.3],
      [-0.0398, -0.3], [-0.0418, -0.298], [-0.0418, -0.002], [-0.0398, 0], [-0.0261, 0], [-0.0241, -0.002], [-0.0241, -0.278], [-0.0221, -0.28]]
    frame.push(g.extrude(channel.map(function (q) { return [q[1], q[0]] }), -EX, EX, { axis: 'x' })) // outline in (y, z)
    var capWall = [[0, 0], [0.1, 0], [0.1, 0.2]]
    for (var k = 1; k <= 4; k++) capWall.push([0.1 * Math.cos((k * Math.PI) / 8), 0.2 + 0.1 * Math.sin((k * Math.PI) / 8)])
    var gusset = [[0, 0], [0.1006, 0], [0.1006, -0.0761], [0.0672, -0.0791], [0.0381, -0.0943], [0.0229, -0.1234], [0.0196, -0.1556], [0, -0.1561]]
    var FOOT_Y = -0.200264
    for (var e = -1; e <= 1; e += 2) {
      var X0 = e * EX
      var out = function (pts, dy) { return pts.map(function (q) { return [X0 + e * q[0], q[1] + dy] }) }
      // end cap: two walls (the seam edge onto the channel stays square) and the floor between them
      frame.push(g.extrude(out(capWall, -0.3), 0.0241, 0.0418, { bevel: 0.002, square: [capWall.length - 1] }))
      frame.push(g.extrude(out(capWall, -0.3), -0.0418, -0.0241, { bevel: 0.002, square: [capWall.length - 1] }))
      frame.push(g.extrude(out([[0, 0], [0.098, 0], [0.1, 0.002], [0.1, 0.018], [0.098, 0.02], [0, 0.02]], -0.3), -0.0241, 0.0241))
      // foot: gussets (square where they meet the rail and the flange), then a flange tab with a hex hole each side
      frame.push(g.extrude(out(gusset, FOOT_Y), 0.0504, 0.0604, { bevel: 0.001, square: [gusset.length - 1, 1] }))
      frame.push(g.extrude(out(gusset, FOOT_Y), -0.0604, -0.0504, { bevel: 0.001, square: [gusset.length - 1, 1] }))
      for (var sz = -1; sz <= 1; sz += 2) {
        var z0 = sz * 0.0504, z1 = sz * 0.1248, cy = FOOT_Y - 0.0361, cz = sz * 0.0876
        var hex = []
        for (var h = 0; h < 6; h++) hex.push([cy + 0.0137 * Math.cos((h * Math.PI) / 3), cz + 0.0137 * Math.sin((h * Math.PI) / 3)])
        frame.push(g.extrude([[FOOT_Y - 0.0761, z0], [FOOT_Y, z0], [FOOT_Y, z1], [FOOT_Y - 0.0761, z1]], X0 + e * 0.0996, X0 + e * 0.1096, { axis: 'x', holes: [hex], bevel: 0.001 }))
      }
      // ---- the sprocket (grey) the chain turns round
      support.push(g.lathe([[0, -0.0142], [0.07485, -0.0142], [0.07485, 0.0142], [0, 0.0142]], { axis: 'z', center: [X0 + e * 0.01045, PIVOT, 0], segments: 16 }))
    }

    // ---- the chain: one loop of stations (an outer and an inner point each), walked from the middle of the bottom
    // run toward −X, up round the −X sprocket, along the top run, down round the +X one and back — so +U runs along
    // the top toward +X. U is the outer edge's arc length in tiles; the seam (U wraps) sits under the lane.
    var BEND = [[[0, -0.1], [0, -0.0772]], [[0.0488, -0.0925], [0.04, -0.0714]], [[0.0813, -0.0708], [0.0651, -0.0546]], [[0.103, -0.0383], [0.0818, -0.0296]], [[0.1106, 0], [0.0877, 0]]]
    var turn = BEND.concat(BEND.slice(0, 4).reverse().map(function (b) { return [[b[0][0], -b[0][1]], [b[1][0], -b[1][1]]] })) // bottom → top
    var st = [{ o: [0, PIVOT - 0.1], i: [0, PIVOT - 0.0772] }, { o: [-EX, PIVOT - 0.1], i: [-EX, PIVOT - 0.0772] }]
    for (var t1 = 1; t1 < turn.length; t1++) st.push({ o: [-EX - turn[t1][0][0], PIVOT + turn[t1][0][1]], i: [-EX - turn[t1][1][0], PIVOT + turn[t1][1][1]] })
    st.push({ o: [EX, PIVOT + 0.1], i: [EX, PIVOT + 0.0772] })
    for (var t2 = turn.length - 2; t2 >= 0; t2--) st.push({ o: [EX + turn[t2][0][0], PIVOT + turn[t2][0][1]], i: [EX + turn[t2][1][0], PIVOT + turn[t2][1][1]] })
    st.push({ o: [0, PIVOT - 0.1], i: [0, PIVOT - 0.0772] })
    var u = [0]
    for (var a = 1; a < st.length; a++) u.push(u[a - 1] + Math.hypot(st[a].o[0] - st[a - 1].o[0], st[a].o[1] - st[a - 1].o[1]) * LINKS_PER_M)
    var Z = 0.0148, surf = g.surface()
    // per station: the outer and inner broad faces (the link photo's top half) and the two flanks (its side view)
    var V = st.map(function (q, j) {
      return {
        ob: [surf.vertex(q.o[0], q.o[1], -Z, u[j], 0.9842), surf.vertex(q.o[0], q.o[1], Z, u[j], 0.5021)],
        ib: [surf.vertex(q.i[0], q.i[1], -Z, u[j], 0.5021), surf.vertex(q.i[0], q.i[1], Z, u[j], 0.9842)],
        fm: [surf.vertex(q.o[0], q.o[1], -Z, u[j], 0.0043), surf.vertex(q.i[0], q.i[1], -Z, u[j], 0.4941)],
        fp: [surf.vertex(q.o[0], q.o[1], Z, u[j], 0.4941), surf.vertex(q.i[0], q.i[1], Z, u[j], 0.0043)],
      }
    })
    // wind a quad a-b-c-d (along the loop from a to b, then across) to face the direction want, given its first two points
    var quad = function (a, b, c, d, pa, pb, across, want) {
      var ex = pb[0] - pa[0], ey = pb[1] - pa[1]
      var nx = ey * across[2], ny = -ex * across[2], nz = ex * across[1] - ey * across[0] // (b − a) × (d − a)
      if (nx * want[0] + ny * want[1] + nz * want[2] >= 0) surf.quad(a, b, c, d)
      else surf.quad(a, d, c, b)
    }
    for (var j = 0; j + 1 < st.length; j++) {
      var q0 = st[j], q1 = st[j + 1], A = V[j], B = V[j + 1]
      var mx = (q0.o[0] + q1.o[0]) / 2, my = (q0.o[1] + q1.o[1]) / 2
      var core = [mx - Math.max(-EX, Math.min(EX, mx)), my - PIVOT, 0] // away from the loop's middle: out of the chain
      quad(A.ob[0], B.ob[0], B.ob[1], A.ob[1], q0.o, q1.o, [0, 0, 2 * Z], core)
      quad(A.ib[0], B.ib[0], B.ib[1], A.ib[1], q0.i, q1.i, [0, 0, 2 * Z], [-core[0], -core[1], 0])
      quad(A.fm[0], B.fm[0], B.fm[1], A.fm[1], q0.o, q1.o, [q0.i[0] - q0.o[0], q0.i[1] - q0.o[1], 0], [0, 0, -1])
      quad(A.fp[0], B.fp[0], B.fp[1], A.fp[1], q0.o, q1.o, [q0.i[0] - q0.o[0], q0.i[1] - q0.o[1], 0], [0, 0, 1])
    }
    chain.push(surf.build())

    // ---- every lane: the same pieces, turned into place and stepped across the part, centred
    var lane = function (list) { return g.merge.apply(g, list) }
    var one = { frame: lane(frame), support: lane(support), chain: lane(chain) }
    var all = { frame: [], support: [], chain: [] }
    for (var li = 0; li < n; li++) {
      var x = (li - (n - 1) / 2) * pitch
      for (var key in one) all[key].push(g.transform(one[key], { scale: [1, 1, SA], rotate: YAW, translate: [x, LANE_Y, 0] }))
    }
    var both = { link: 'chainBank', doubleSided: true }
    return [
      Object.assign({ desc: lane(all.frame), material: 'frame' }, both),
      Object.assign({ desc: lane(all.support), material: 'support' }, both),
      Object.assign({ desc: lane(all.chain), material: 'chain', scroll: { tilesPerMeter: LINKS_PER_M } }, both),
    ]
  },
  step(ctx) {
    // Signal handoff, modelled on a real panel: the pop-up tag commands the chains only while a controller actually
    // drives it (the tag is an attached program's output — ctx.tagDriven). Any other time — no tag named,
    // no program, sim stopped — the manual signal rules: the 'raised' param or a pilot Use/click.
    if (ctx.params.raised !== lastRaised) { raised = ctx.params.raised; lastRaised = ctx.params.raised }
    if (ctx.used()) raised = !raised
    // auto wins by overwriting the hand latch (bumpless transfer): a press while owned is undone the same tick, and
    // when ownership releases (program detach) the chains hold their last commanded state.
    if (ctx.tagDriven(ctx.params.popupTag)) raised = ctx.readTag(ctx.params.popupTag)
    // the hand latch AFTER the auto gate — what the device is really doing, for the Inspector readout
    ctx.report('raised', raised)
    const fpm = ctx.params.fpmUnits === true
    const setpointTag = fpm ? ctx.params.speedFpmTag : ctx.params.speedTag
    const setpointMs = (setpointTag ? ctx.readNumber(setpointTag) : fpm ? ctx.params.speedFpm : ctx.params.speed) * (fpm ? FPM_MS : 1)
    const speed = setpointMs
    ctx.report('speed', speed) // the chains scroll on 'speed' (m/s) whichever unit the Inspector shows
    reportSpeed(ctx, fpm, speed)
    if (lift === null) lift = raised ? RAISE : 0 // first step: start at the authored state (no spurious slew)
    lift = ctx.approach(lift, raised ? RAISE : 0, (RAISE / Math.max(ctx.params.raiseTime, 0.01)) * ctx.dt)
    ctx.joints.lift = lift
    const f = ctx.forward
    if (raised) {
      // DIVERT: the raised chains carry cargo 90° off the main line — forward rotated +90° about +Y, i.e. out to −Z.
      ctx.setSurfaceVelocity({ x: f.z * speed, y: 0, z: -f.x * speed })
    } else {
      // THROUGH: convey along the part's forward (+X) — the main line.
      ctx.setSurfaceVelocity({ x: f.x * speed, y: 0, z: f.z * speed })
    }
  },
})
