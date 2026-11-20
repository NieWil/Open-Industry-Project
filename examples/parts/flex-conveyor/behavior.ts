// Flex Conveyor — an expandable powered roller conveyor: 16 sections on a scissor truss, hinged end to end.
//
// Its shape is a smooth path from the infeed (heading +X) through the control points in 'points', the sections
// fitted along it with equal chords; every hinge is posed from that fit each tick, and ctx.setSurfaceSpeed runs each
// section's deck along its own direction, so product follows every bend. flexStations below MIRRORS
// core/flexPath.ts line for line (a part cannot import core); src/sim/flexConveyor.test.ts holds them together.
//
// It is built the way the real one is - the kind a dock reaches into a trailer with and people pull into whatever
// shape the floor needs: a chain of SECTIONS, each a short roller bed on a scissor-frame truss with a caster leg under
// its hinge, and every hinge free to angle on its own. The bed LENGTH is the fitted chord x the section count, a
// hidden param the editor writes as the points are dragged (the `flexPath` handle): it is what sizes each section, so
// it is the accordion, stretched or compressed. Each section's deck is its own conveying link riding its hinge.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

// Part frame: the origin is the INFEED end of the conveying surface, on its centreline (y = 0 is the roller tops).

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

const N = 16 //                 sections (hinges): a real unit has a fixed number of truss bays
const SAMPLES = 24
const ROLLERS = 8 //            rollers per section: FIXED, on the scissor pivots, so they bunch and spread with the bed
const ROLLER_R = 0.024 //       roller radius: the common 1.9" (48 mm) flex roller
// Fully COMPRESSED is where the rollers nearly touch: one diameter plus a working clearance between centres (~2.3",
// where real units close up). Every roller rides a pivot at an even spacing, so the bed can be no shorter than all
// N x ROLLERS of those; any shorter and the rollers would stand inside each other.
const ROLLER_CLOSED = 2 * ROLLER_R + 0.01
const LEN_DEFAULT = 8
const LEN_MIN = Math.ceil(N * ROLLERS * ROLLER_CLOSED * 100) / 100 // 7.43 m, 0.46 m a section
const LEN_MAX = 24 //           fully extended, 1.5 m a section and ~7.4" roller centres (real units open to 7-9"), a
//                               ~3:1 stretch like theirs: the long trailer-loading units run to ~80 ft
// The scissor LINKS are one fixed length, as a real unit's are: as the rollers spread the X's flatten and the truss gets
// shallower, and it is the links that stop the stretch (a scissor opens no further than flat). They are made as long
// as leaves the truss TRUSS_MIN_DEPTH deep fully extended, so full stretch is the flattest the truss goes.
const TRUSS_MIN_DEPTH = 0.07
const SCISSOR_LINK = +Math.hypot(LEN_MAX / (N * ROLLERS), TRUSS_MIN_DEPTH).toFixed(4) // ~0.2 m
const WIDTH_DEFAULT = 0.6
const STAND_DEFAULT = 0.8
const POINTS_DEFAULT = [[3, 0], [6, 0], [LEN_DEFAULT, 0]]
const GUIDE_H = 0.06 //         side guides: how far they stand above the roller tops
const GUIDE_T = 0.04 //         ...and their thickness
const GUIDE_Z = 0.025 //        guide centre, out from the roller ends
const EYE_AT = 0.8 //           each zone's photo-eye, as a fraction of its section: a held case waits with its nose here
const EYE_Y = 0.025 //          beam height over the roller tops: LOW, as zone eyes are (15-25 mm), so a tote, a thin carton
//                               or a bag is seen too - an eye at case-middle height lets anything shorter pass under it
const EYE_OUT = 0.018 //        the eye's lens, this far outside the roller ends: its housing is tucked in against the -z

// ONE SIDE OF THE SCISSOR TRUSS: lazy tongs. Its top pivots are the roller axles, level at y = top and at x = xs[j] along
// the side; every link is `link` long; and a bottom pivot hangs under every roller, joined to the rollers either side
// of it, so it sits under their midpoint as deep as a link that long reaches. Rollers close together stand the X's up
// (a deep truss), spread apart they flatten it (a shallow one), and on the inside of a bend, where the rollers close
// up, the truss stands taller than on the outside: the links never stretch. xs runs from the roller before this
// stretch to the one after it, so the result is a bottom pivot under each roller between.
function scissorBottoms(xs, top, link) {
  const out = []
  for (let j = 1; j < xs.length - 1; j++) {
    const half = (xs[j + 1] - xs[j - 1]) / 2
    out.push([(xs[j + 1] + xs[j - 1]) / 2, top - Math.sqrt(Math.max(0, link * link - half * half))])
  }
  return out
}

function flexPolyline(points) {
  const ctrl = [[0, 0]]
  for (const p of points || []) if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) ctrl.push([p[0], p[1]])
  if (ctrl.length < 2) ctrl.push([1, 0])
  const d0 = Math.hypot(ctrl[1][0], ctrl[1][1]) || 1
  const last = ctrl[ctrl.length - 1], prev = ctrl[ctrl.length - 2]
  const ext = [[ctrl[1][0] - 2 * d0, ctrl[1][1]], ...ctrl, [2 * last[0] - prev[0], 2 * last[1] - prev[1]]]
  const out = [[0, 0]]
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2]
    for (let k = 1; k <= SAMPLES; k++) {
      const t = k / SAMPLES, t2 = t * t, t3 = t2 * t
      const c = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3)
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  return out
}

function stepChord(poly, from, seg, d) {
  for (let i = seg; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1]
    if (Math.hypot(b[0] - from[0], b[1] - from[1]) < d) continue
    const dx = b[0] - a[0], dz = b[1] - a[1], fx = a[0] - from[0], fz = a[1] - from[1]
    const A = dx * dx + dz * dz, B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - d * d
    const disc = Math.max(0, B * B - 4 * A * C)
    const t = A > 0 ? Math.min(1, Math.max(0, (-B + Math.sqrt(disc)) / (2 * A))) : 0
    return { at: [a[0] + t * dx, a[1] + t * dz], seg: i }
  }
  return null
}

function flexStations(points, n) {
  const poly = flexPolyline(points)
  const end = poly[poly.length - 1]
  let arc = 0
  for (let i = 1; i < poly.length; i++) arc += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1])
  let lo = Math.hypot(end[0], end[1]) / n, hi = arc / n
  let best = []
  for (let iter = 0; iter < 48; iter++) {
    const d = (lo + hi) / 2
    const st = [[0, 0]]
    let seg = 0
    let ok = true
    for (let k = 0; k < n; k++) {
      const s = stepChord(poly, st[st.length - 1], seg, d)
      if (!s) { ok = false; break }
      st.push(s.at)
      seg = s.seg
    }
    if (!ok) { hi = d; continue }
    best = st
    const lastSt = st[st.length - 1]
    if (Math.hypot(end[0] - lastSt[0], end[1] - lastSt[1]) > 1e-9 && seg < poly.length - 1) lo = d
    else hi = d
  }
  if (best.length !== n + 1) {
    best = []
    for (let k = 0; k <= n; k++) best.push([(end[0] * k) / n, (end[1] * k) / n])
  }
  const headings = []
  for (let k = 0; k < n; k++) headings.push(Math.atan2(-(best[k + 1][1] - best[k][1]), best[k + 1][0] - best[k][0]))
  return { stations: best, headings, pitch: Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1]) }
}

// the fit only changes when the points do: cache it on their JSON
let fitKey = ''
let fit = null
// accumulation state: the part's own clock, and when a case last left the discharge eye (for the release spacing)
let clock = 0
let lastExit = -1e9
let lastEye = false

definePart({
  joints: Array.from({ length: N }, (_, i) => 'h' + i),
  params: {
    points: { type: 'numberList', columns: ['x m', 'z m'], arity: 2, default: POINTS_DEFAULT, label: 'Path points', group: 'Shape', handle: { kind: 'flexPath', lengthParam: 'length', sections: N, maxHingeDeg: 40, infeedBrakeParam: 'infeedBrakes', dischargeBrakeParam: 'dischargeBrakes', scissor: { widthParam: 'width', rollers: ROLLERS } }, desc: 'The bed runs from its infeed (the part origin, heading +X) along a smooth curve through these points, part-local metres, the last one being the discharge end. Drag the dots in the viewport to pull it into shape: S-curves, a turn through a door, a loop. The length follows.' },
    length: { type: 'number', default: LEN_DEFAULT, min: LEN_MIN, max: LEN_MAX, step: 0.01, hidden: true, label: 'Length (m)', group: 'Shape', desc: 'The bed length along its sections, written by the path drag: it sets how far each section is stretched.' },
    infeedBrakes: { type: 'boolean', default: false, label: 'Infeed brakes', group: 'Shape', desc: 'The caster brakes under the infeed end are on. Walking, a braked end cannot be pulled, and pulling the other end further than the bed reaches stops there instead of rolling the unit after you. The editor places it wherever you drag it.' },
    dischargeBrakes: { type: 'boolean', default: false, label: 'Discharge brakes', group: 'Shape', desc: 'The caster brakes under the discharge end are on. Walking, a braked end cannot be pulled, and pulling the other end further than the bed reaches stops there instead of rolling the unit after you. The editor places it wherever you drag it.' },
    width: { type: 'number', default: WIDTH_DEFAULT, min: 0.3, max: 1.2, step: 0.05, label: 'Width (m)', group: 'Size', desc: 'Roller width between the scissor sides.' },
    sideGuides: { type: 'boolean', default: false, label: 'Side guides', group: 'Size', desc: 'Low rails along both edges that keep product on the bed through a tight bend. Off, as a flex usually ships: a gentle bed carries without them, and a hard bend or a U-turn wants them on.' },
    standHeight: { type: 'number', default: STAND_DEFAULT, min: 0.4, max: 1.6, step: 0.01, label: 'Stand height (m)', desc: 'Height of the roller tops above the floor. The legs under every hinge reach down to their casters.' },
    ...speedUnitParams(1),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'Surface speed along the bed. Negative runs it back toward the infeed.' },
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands the bed speed here, replacing the Speed field above. Once bound it takes over even if no program drives it, and an undriven tag reads 0.' },
    ...speedFpmTagParam('Comms'),
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (rollers run while true)', group: 'Comms', desc: 'Start/stop gate: while a program drives this tag false the bed stands still, and true it runs at its speed. Until a program actually drives it the bed runs, so a merely-typed tag does not stop it.' },
    accumulate: { type: 'boolean', default: false, label: 'Zone accumulation', group: 'Accumulation', desc: 'Zero-pressure accumulation: each section is a zone with its own photo-eye, and a zone holding a case stops while the zone ahead is full, so product queues with gaps and never pushes. Off, the whole bed runs as one. Sections must be longer than the product.' },
    releaseTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Release tag (discharge zone runs while true)', group: 'Accumulation', desc: 'With accumulation on: the discharge zone lets its case go only while a program drives this true, so the line takes product when it wants it. Unbound, or not driven by a program, the discharge zone always releases.' },
    meterGap: { type: 'number', default: 0, min: 0, max: 10, step: 0.1, label: 'Release spacing (s)', group: 'Accumulation', desc: 'With accumulation on: the least time between two cases leaving the discharge end. A queue released all at once goes out a zone apart; this meters it wider, to the spacing the line downstream is set up for.' },
    fullTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Full tag (first zone eye covered)', group: 'Accumulation', desc: 'True while the first zone eye is covered: the last case has not cleared it, or the queue has backed up to it. Put the next case down (a case length and a gap behind that eye) only while this is false, and cases can never land on each other.' },
    showBeam: { type: 'boolean', default: false, label: 'Show beams', group: 'Accumulation', desc: 'Draw each zone photo-eye beam across the bed: green where the zone is clear, red from the eye to the case it sees.' },
  },
  // Everything drawn rides its SECTION (link 's<i>'), in that section's own frame: x from 0 (its infeed hinge) to the
  // pitch (the next hinge). As on the real unit: a fixed set of rollers whose axles ride the scissor pivots, so their
  // spacing IS the stretch; each side a zig-zag of flat galvanised links, an X between every pair of rollers; black
  // H-stands on casters under every other hinge. The rollers are the top of the bed (no side channel stands proud of
  // them) unless the side guides are on. Two draws a section: galvanised steel, and the black stands and tyres.
  geometry(g, p) {
    var num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d }
    var L = Math.max(num(p.length, LEN_DEFAULT), 0.5)
    var W = num(p.width, WIDTH_DEFAULT)
    var H = num(p.standHeight, STAND_DEFAULT)
    var P = L / N
    var hw = W / 2
    var RR = ROLLER_R // roller radius: tops at y = 0
    var K = ROLLERS
    var S = P / K // roller spacing
    var ZP = hw + 0.012 // the scissor plates' plane, just outside the roller ends
    var TOP = -RR // the scissor's top pivots: the roller axles (its bottom pivots hang from them, scissorBottoms)
    var LINK = SCISSOR_LINK // every scissor link, pivot to pivot
    var ZL = hw + 0.06 // the stands' legs, outside the scissors
    var box = function (list, x0, x1, y0, y1, z0, z1) {
      list.push(g.bevelBox([Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], 0.003))
    }
    var bar = function (list, axis, center, rad, from, to, seg) {
      list.push(g.lathe([[0, from], [rad, from], [rad, to], [0, to]], { axis: axis, center: center, segments: seg || 10 }))
    }
    // one flat scissor link, pivot to pivot in the side plane
    var link = function (list, x0, y0, x1, y1, z) {
      var len = Math.hypot(x1 - x0, y1 - y0), a = Math.atan2(y1 - y0, x1 - x0)
      list.push(g.transform(g.box([len + 0.03, 0.03, 0.005], [0, 0, 0]), { rotate: [0, 0, Math.sin(a / 2), Math.cos(a / 2)], translate: [(x0 + x1) / 2, (y0 + y1) / 2, z] }))
    }
    // an H-stand: two telescoping legs outside the scissors, a cross tie, and a caster under each. Its top hangs from
    // the truss's bottom pivots, one side each (bot[0] the -z side, bot[1] the +z), which rise as the bed opens and
    // stand lower on the inside of a bend: the legs telescope to meet them, and the cross member between sits level
    // at the lower of the two, so neither side floats above it
    var stand = function (steel, dark, x, bot) {
      for (var s = -1; s <= 1; s += 2) {
        var b = bot[s < 0 ? 0 : 1]
        box(dark, x - 0.022, x + 0.022, -H + 0.16, b + 0.01, s * ZL - 0.022, s * ZL + 0.022)
        box(steel, x - 0.017, x + 0.017, -H + 0.45, b - 0.05, s * ZL - 0.017, s * ZL + 0.017) // the inner tube
        box(steel, x - 0.05, x + 0.05, -H + 0.145, -H + 0.16, s * ZL - 0.05, s * ZL + 0.05) // the caster plate
        box(steel, x - 0.012, x + 0.012, -H + 0.08, -H + 0.145, s * ZL - 0.03, s * ZL + 0.03) // the fork
        bar(dark, 'z', [x, -H + 0.075, s * ZL], 0.075, -0.022, 0.022, 16) // the tyre
      }
      var low = Math.min(bot[0], bot[1])
      box(dark, x - 0.015, x + 0.015, -H + 0.3, -H + 0.33, -ZL, ZL)
      box(dark, x - 0.02, x + 0.02, low - 0.01, low + 0.02, -ZL, ZL) // the top cross member the scissors hang from
    }
    // THE ROLLERS FAN. On the real unit every roller rides its own scissor pivots, so a bend is spread over all of
    // them, each a little askew of the next, the scissors closing on the inside of the curve and opening on the
    // outside. Here the sections are rigid between hinges, so each section's rollers are turned by a share of the
    // hinges at either end of it: from half the turn at its infeed hinge (back) to half the one at its discharge
    // hinge (forward). Every gap then takes an even share of the bend, never a whole hinge's worth at one pair, which
    // is what put two rollers inside each other. The pull keeps that share where the rollers cannot touch (the
    // handle's scissor limit, core flexPull).
    var turn = []
    var fitHeadings = flexStations(p.points, N).headings
    for (var h = 0; h <= N; h++) {
      var d = h === N ? 0 : fitHeadings[h] - (h === 0 ? 0 : fitHeadings[h - 1])
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      turn.push(d)
    }
    // roller k of section i: its yaw off the section, and where its end on side z sits along the section
    var fan = function (i, k) { var f = (k + 0.5) / K; return -turn[i] / 2 + (turn[i] / 2 + turn[i + 1] / 2) * f }
    var endX = function (i, k, z) { return (k + 0.5) * S + z * Math.sin(fan(i, k)) }
    // where roller k's end on side z sits along section i, for k one past either end of the section too: a neighbour
    // section's roller, brought into this section's frame across the hinge between (the SDK yaw: (x, z) turned by t is
    // (x cos t + z sin t, -x sin t + z cos t)); past either end of the bed, carried on at the spacing
    var sideX = function (i, k, z) {
      if (k >= 0 && k < K) return endX(i, k, z)
      if (k >= K) {
        if (i === N - 1) return 2 * sideX(i, k - 1, z) - sideX(i, k - 2, z)
        var t = turn[i + 1], o1 = fan(i + 1, k - K), x1 = (k - K + 0.5) * S + z * Math.sin(o1), z1 = z * Math.cos(o1)
        return P + x1 * Math.cos(t) + z1 * Math.sin(t)
      }
      if (i === 0) return 2 * sideX(i, k + 1, z) - sideX(i, k + 2, z)
      var tb = turn[i], ob = fan(i - 1, K + k), xb = (K + k + 0.5) * S + z * Math.sin(ob) - P, zb = z * Math.cos(ob)
      return xb * Math.cos(tb) - zb * Math.sin(tb)
    }
    // one side plane's truss for section i: its top pivots from the roller before the section to the one after the
    // next section's first (k = -1 .. K + 1), and the bottom pivots under rollers 0 .. K (scissorBottoms)
    var truss = function (i, z) {
      var xs = []
      for (var k = -1; k <= K + 1; k++) xs.push(sideX(i, k, z))
      return { tops: xs.slice(1), bottoms: scissorBottoms(xs, TOP, LINK) }
    }
    var out = []
    for (var i = 0; i < N; i++) {
      var steel = [], dark = [], eyes = []
      for (var k = 0; k < K; k++) {
        var xr = (k + 0.5) * S
        var o = fan(i, k)
        steel.push(g.transform(g.lathe([[0, -hw], [RR, -hw], [RR, hw], [0, hw]], { axis: 'z', center: [0, -RR, 0], segments: 12 }), { rotate: [0, Math.sin(o / 2), 0, Math.cos(o / 2)], translate: [xr, 0, 0] }))
      }
      // THE SCISSORS, two plates a side. Each X joins a roller's axle to the bottom pivot under the next roller, and
      // that bottom pivot up to the axle after it (lazy tongs, scissorBottoms): every link LINK long, so the truss
      // deepens as the bed closes and flattens as it opens, and stands taller on the inside of a bend than the outside.
      // The last X of the section reaches the next section's first roller.
      var bots = [[0, 0], [0, 0]]
      for (var sd = -1; sd <= 1; sd += 2) {
        var z0 = sd * ZP, z1 = sd * (ZP + 0.006)
        var a = truss(i, z0), b = truss(i, z1)
        for (var j = 0; j < K; j++) {
          link(steel, a.tops[j], TOP, a.bottoms[j + 1][0], a.bottoms[j + 1][1], z0)
          link(steel, b.bottoms[j][0], b.bottoms[j][1], b.tops[j + 1], TOP, z1)
        }
        bots[sd < 0 ? 0 : 1] = [a.bottoms[0][1], a.bottoms[K][1]]
      }
      if (i % 2 === 0) stand(steel, dark, 0, [bots[0][0], bots[1][0]])
      if (i === N - 1) stand(steel, dark, P, [bots[0][1], bots[1][1]])
      if (i === 0) box(dark, 0.08, 0.3, -0.26, -0.1, -0.12, 0.12) // the drive, under the infeed section
      // the zone's photo-eye, when the bed accumulates: a dark eye housing on the -z side on a small bracket, a
      // reflector opposite, both at the beam's height and clear of the scissor plates
      if (p.accumulate === true) {
        // lens face at the beam origin; the housing reaches back over the scissor plates, clipped to them at roller level
        var xe = EYE_AT * P, ye = EYE_Y, ze = hw + EYE_OUT
        box(eyes, xe - 0.016, xe + 0.016, ye - 0.018, ye + 0.02, -ze - 0.026, -ze)
        box(steel, xe - 0.007, xe + 0.007, -0.05, ye - 0.018, -ze - 0.02, -ze - 0.012)
        box(eyes, xe - 0.018, xe + 0.018, ye - 0.016, ye + 0.018, ze, ze + 0.008)
        box(steel, xe - 0.007, xe + 0.007, -0.05, ye - 0.016, ze + 0.002, ze + 0.008)
      }
      if (p.sideGuides === true) {
        for (var gs = -1; gs <= 1; gs += 2) box(steel, 0, P, -0.02, GUIDE_H, gs * (hw + GUIDE_Z) - GUIDE_T / 2, gs * (hw + GUIDE_Z) + GUIDE_T / 2)
      }
      out.push({ desc: g.merge.apply(g, steel), material: 'steel', link: 's' + i })
      out.push({ desc: g.merge.apply(g, dark), material: 'dark', link: 's' + i })
      if (eyes.length) out.push({ desc: g.merge.apply(g, eyes), material: 'eye', link: 's' + i })
    }
    return out
  },
  step(ctx) {
    const p = ctx.params
    const key = JSON.stringify(p.points)
    if (key !== fitKey || !fit) { fit = flexStations(p.points, N); fitKey = key }
    // each hinge turns by the change of heading between its two sections; the first sets the bed off the infeed
    let prev = 0
    for (let i = 0; i < N; i++) {
      let d = fit.headings[i] - prev
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      ctx.setJoint('h' + i, d)
      prev = fit.headings[i]
    }
    const fpm = p.fpmUnits === true
    const setpointTag = fpm ? p.speedFpmTag : p.speedTag
    const setpointMs = (setpointTag ? ctx.readNumber(setpointTag) : fpm ? p.speedFpm : p.speed) * (fpm ? FPM_MS : 1)
    const setpoint = setpointMs
    // the run gate belongs to the program only while it drives the tag (ctx.tagDriven), never to a typed name
    const running = !ctx.tagDriven(p.runTag) || ctx.readTag(p.runTag)
    const commanded = running ? setpoint : 0
    ctx.report('speed', commanded) // the rollers turn on 'speed' (m/s) whichever unit the Inspector shows
    reportSpeed(ctx, fpm, commanded)
    clock += ctx.dt
    // FULL = the first zone's eye is covered: the case put on last has not yet cleared the load spot's far edge, or the
    // queue has backed up to it. A loader puts the next case down BEHIND that eye (a case length and a gap back), so
    // one waiting on a clear eye can never land on the one before it.
    const loadCovered = ctx.sense('e0').hit
    if (p.fullTag) ctx.writeTag(p.fullTag, loadCovered)
    if (!p.accumulate) {
      ctx.setSurfaceSpeed(commanded)
      return
    }
    // ZERO-PRESSURE ACCUMULATION, zone i = section i. A zone is FULL when its eye sees a case and it is stopped; a zone
    // runs unless it holds a case (its eye) and the zone ahead is full. The discharge zone is full while it holds a
    // case it has not been told to release, so a queue backs up from the discharge end, one case a zone, never touching.
    const eye = []
    for (let i = 0; i < N; i++) eye.push(ctx.sense('e' + i).hit)
    const released = !ctx.tagDriven(p.releaseTag) || ctx.readTag(p.releaseTag)
    // the release is metered: a case that has just left the discharge eye holds the next one for meterGap seconds
    if (lastEye && !eye[N - 1]) lastExit = clock
    lastEye = eye[N - 1]
    const metered = clock - lastExit >= (p.meterGap || 0)
    const run = new Array(N)
    run[N - 1] = !eye[N - 1] || (released && metered)
    for (let i = N - 2; i >= 0; i--) run[i] = !(eye[i] && eye[i + 1] && !run[i + 1])
    ctx.setSurfaceSpeed(run.map((r) => (r ? commanded : 0)))
  },
})
