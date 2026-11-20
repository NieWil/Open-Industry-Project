// Pallet Dispenser — a magazine of empty pallets over a conveyor, set down one at a time.
//
// The stack stands between corner guides, held on forks in the BOTTOM pallet's fork pockets. A dispense is the
// machine's own cycle: the carriage sets the stack down on the conveyor, the forks come out, the carriage climbs one
// pallet pitch, the forks go back in (into the second pallet), and the carriage lifts the stack clear — leaving the
// bottom pallet on the conveyor.
//
// Every pallet in the magazine is a REAL pallet, held by the gripper of the magazine position it stands in (a copy of
// the posable gripper array `pos`, one per position the capacity allows).
// Nothing is deleted and nothing is made to stand in for it: a pallet a truck loads is the pallet that comes out, with
// its tint, mass and marks. A dispense opens the bottom position's gripper as the forks come out of it; the rest stay
// held, so the stack never stands on its own and the conveyor under it may keep running.
//
// It is COMMANDED: one dispense per request, a request being a rising edge on the dispense tag while a program
// drives it, else a Use, else (Auto dispense) an empty bay. A request that arrives mid-cycle, or while the bay
// still holds the last pallet, waits for it — the machine never sets a stack down on a pallet. Busy reads true
// from the request until the stack is back up, so a controller can hold its conveyor until the pallet is free, and
// the bay eye says whether a pallet is standing ready, so it can keep one waiting.
//
// The enable tag is the safety stop. Dropped mid-cycle, the carriage and forks stop where they are and the stack stays
// held, as it does when the valves drop out. The cycle keeps its place and carries on when the tag comes back. A
// request while it is down is refused. A program wires it to the line running, so a Stop or a trip holds the
// dispense and a Start finishes it.
//
// LOADING: an empty magazine parks its carriage down with the forks out, and a stack of two or more real pallets
// set down in it from the open -Z side and left standing for LOAD_SETTLE seconds is gripped where it stands; the
// forks go into the bottom one and lift the stack to the holding position. More pallets than the magazine has
// positions: the ones above the top position are not held, and stay real cargo standing on the stack.
//
// STOCK is authored: pallets placed at the holding positions (the Inspector's Fill, from the manifest's holds) are
// gripped where they stand when the run starts, so the stopped scene shows what a run starts with. Reload by itself
// when empty is a SOURCE and makes new ones.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

// The mechanism works the pallet's two SHORT ends (the forks enter along ±X, the conveying direction), so both LONG
// sides are free, and the -Z one is left open: no guide across it and no tie rail at stack height. That is the side
// a fork truck loads from, because a truck can only fork a pallet through its long faces (its blades are too widely
// spaced for the narrow channels the other way).
//
// Geometry is code, not a model: the frame, carriage, forks and cylinders are plain engineered steel, and the fork
// stroke, pallet pitch and conveyor height all have to agree with the behavior.

// 8 decimals, near-zero to 0: the rounding rig.json's derived numbers carry

// ---- from examples/parts/_shared/hardware.js ----
// SEAT: how far a piece sinks into the face it stands on. VERT_CAP: stop adding to one submesh well short of
// the host's per-mesh vertex budget.
var SEAT = 0.0005, VERT_CAP = 150000
// one submesh under construction, counting its vertices against VERT_CAP
function mesh(g) { return { sb: g.surface(), n: 0, full: false } }
function room(m, k) {
  if (m.full || m.n + k > VERT_CAP) { m.full = true; return false }
  m.n += k
  return true
}
// an oriented box: centre c, half-extent axes e[0..2] (right-handed: e0 x e1 = e2), each face its own four
// vertices wound CCW from outside
function obox(m, c, e) {
  if (!room(m, 24)) return
  var sb = m.sb
  var pt = function (s0, s1, s2) {
    return sb.vertex(c[0] + s0 * e[0][0] + s1 * e[1][0] + s2 * e[2][0], c[1] + s0 * e[0][1] + s1 * e[1][1] + s2 * e[2][1], c[2] + s0 * e[0][2] + s1 * e[1][2] + s2 * e[2][2])
  }
  // the face normal to axis n (sign sg): its other two axes a, b with a x b = +n, walked CCW seen from outside
  var face = function (n, sg) {
    var a = (n + 1) % 3, b = (n + 2) % 3
    var q = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    var idx = []
    for (var k = 0; k < 4; k++) {
      var sv = [0, 0, 0]
      sv[n] = sg
      sv[a] = q[k][0] * sg // flipping one in-plane axis reverses the winding for the negative face
      sv[b] = q[k][1]
      idx.push(pt(sv[0], sv[1], sv[2]))
    }
    sb.quad(idx[0], idx[1], idx[2], idx[3])
  }
  for (var n = 0; n < 3; n++) { face(n, 1); face(n, -1) }
}
// an axis-aligned box from its min and max corners
function abox(m, x0, y0, z0, x1, y1, z1) {
  obox(m, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [[(x1 - x0) / 2, 0, 0], [0, (y1 - y0) / 2, 0], [0, 0, (z1 - z0) / 2]])
}
// a square-section member of side t from point a to point b (any direction), its width axis kept horizontal
// where it can be (so a diagonal brace in a vertical plane shows its flat side to that plane)
function member(m, a, b, t) {
  var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  var len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
  if (len < 1e-6) return
  var u = [d[0] / len, d[1] / len, d[2] / len]
  // side = u x up, or u x X when the member is vertical; then e2 = u x side completes a right-handed set
  var s = Math.abs(u[1]) > 0.999 ? [0, u[2], -u[1]] : [-u[2], 0, u[0]]
  var sl = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2])
  s = [s[0] / sl, s[1] / sl, s[2] / sl]
  var w = [u[1] * s[2] - u[2] * s[1], u[2] * s[0] - u[0] * s[2], u[0] * s[1] - u[1] * s[0]]
  var h = t / 2
  obox(m, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [[u[0] * len / 2, u[1] * len / 2, u[2] * len / 2], [s[0] * h, s[1] * h, s[2] * h], [w[0] * h, w[1] * h, w[2] * h]])
}
// the in-plane axes (u, v) of a face normal to axis ax, with u x v = +ax
var PLANE = [[1, 2], [2, 0], [0, 1]]
// a hex prism (bolt head, nut, thread end) standing on a face: base centre p, rising h along axis ax in
// direction s (+1/-1), af across flats. The base sits on the face and is never seen, so it isn't emitted.
function hex(m, p, ax, s, af, h) {
  if (!room(m, 31)) return
  var sb = m.sb, u = PLANE[ax][0], v = PLANE[ax][1], r = af / Math.sqrt(3)
  var ring = function (t) {
    var out = []
    for (var k = 0; k < 6; k++) {
      var a = (k * Math.PI) / 3, q = [p[0], p[1], p[2]]
      q[u] += r * Math.cos(a)
      q[v] += r * Math.sin(a)
      q[ax] += s * t
      out.push(q)
    }
    return out
  }
  var lo = ring(-SEAT), hi = ring(h)
  var V = function (q) { return sb.vertex(q[0], q[1], q[2]) }
  for (var k = 0; k < 6; k++) {
    var k1 = (k + 1) % 6
    var b0 = V(lo[k]), b1 = V(lo[k1]), f1 = V(hi[k1]), f0 = V(hi[k])
    // CCW about +ax, so tangent x (+ax) points outward; a prism rising along -ax walks the other way
    if (s > 0) sb.quad(b0, b1, f1, f0)
    else sb.quad(b1, b0, f0, f1)
  }
  var cc = [p[0], p[1], p[2]]
  cc[ax] += s * h
  var c = V(cc), cap = []
  for (var k2 = 0; k2 < 6; k2++) cap.push(V(hi[k2]))
  for (var k3 = 0; k3 < 6; k3++) {
    if (s > 0) sb.triangle(c, cap[k3], cap[(k3 + 1) % 6])
    else sb.triangle(c, cap[(k3 + 1) % 6], cap[k3])
  }
}
// a floor anchor on a plate whose top is at y: a square washer, a hex nut, and the stud end standing out of it
function anchor(m, x, y, z, af) {
  af = af || 0.022
  var w = af * 1.45, wt = 0.003, nh = af * 0.55
  abox(m, x - w / 2, y - SEAT, z - w / 2, x + w / 2, y + wt, z + w / 2)
  hex(m, [x, y + wt, z], 1, 1, af, nh)
  hex(m, [x, y + wt + nh, z], 1, 1, af * 0.55, af * 0.4)
}

const r8 = (n) => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8))

// ---- the pallet, copied from src/core/pallet.ts --------------------------------------------------------------
// These must match src/core/pallet.ts; src/sim/palletDispenser.test.ts fails when they drift.
// The footprints a pallet offers (PALLET_STANDARDS), length (x) first, and the default one (DEFAULT_PALLET_STANDARD).
const PALLET_STANDARDS = [
  { value: '1219x1016', label: '48 x 40 in (1219 x 1016 mm)', length: 1.22, width: 1.02 },
  { value: '1200x800', label: '1200 x 800 mm', length: 1.2, width: 0.8 },
  { value: '1200x1000', label: '1200 x 1000 mm', length: 1.2, width: 1.0 },
  { value: '1165x1165', label: '1165 x 1165 mm', length: 1.165, width: 1.165 },
  { value: '1100x1100', label: '1100 x 1100 mm', length: 1.1, width: 1.1 },
  { value: '1067x1067', label: '1067 x 1067 mm', length: 1.067, width: 1.067 },
]
const DEFAULT_PALLET_STANDARD = '1219x1016'
const PALLET_HEIGHT = 0.135 // PALLET_SIZE[1], the one height of every pallet
const PALLET_RUNNER_T = 0.0245 // the bottom runners' thickness
const PALLET_DECK_T = 0.0405 // the top slab, deck boards and stringers together (palletCollider's deckThickness)
const PALLET_BLOCK_HZ = 0.0455 // a block's half-width across the pallet (z)
const PALLET_BLOCK_INSET_Z = 0.05 // an outer block's centre in from the side it runs along

// ---- the numbers the frame, the rig and the behavior share ----------------------------------------------------
// Part frame: the origin is the CONVEYING SURFACE under the magazine's centre (y = 0 is the top of the conveyor the
// pallet is set down on), +X along that conveyor. A pallet stands with its length along X.
const PITCH = PALLET_HEIGHT // a pallet's height, so the pitch of a stack
const HOLD = 0.25 // the held stack's underside above the conveyor: a dispensed pallet (0.135) leaves under it
const MAX = 10 // magazine positions (one drawn pallet each)
const TOPY = 1.95 // top of the frame, above the conveyor: a full magazine is HOLD + MAX·PITCH = 1.6
const COL_X = 0.86 // column centres: outside the pallet's ends plus the carriage that works them ...
const COL_Z = 0.7 // ... and outside a conveyor up to 1.2 m wide plus its side frames
const COL = 0.12 // square column section
const TINE_DEPTH = 0.2 // how far the fork tips reach into the pockets through a pallet's end face
const STROKE = 0.23 // fork travel: out, the tips stand 0.03 clear of the pallet's end
const TINE_BAR = 0.71 // |x| of the bar the tines hang on (the carriage, which does not move with the size)
const GUIDE_GAP = 0.015 // the magazine guides stand this far off the pallet's ends and sides

// SIZES. The magazine takes any of the pallet footprints, picked by its Pallet size param: the frame and carriage are
// built round the largest, and what follows the size is what touches the pallet. The guides close in on its ends and
// sides, the forks reach the same depth into its end faces, and the tines sit in the middle of its fork channels.
// Per pallet size: [length, width] in m, the fork tips' |x| when in, the tines' |z| (the middle of the fork channel
// between the centre block and the outer one, across the end face), and the guides' |x| and |z|. The tines' height is
// the same for every size, as the pocket is.
const SIZES = Object.fromEntries(PALLET_STANDARDS.map((s) => {
  const outer = s.width / 2 - PALLET_BLOCK_INSET_Z // the outer blocks' centre; the centre blocks stand at z = 0
  const channel = [PALLET_BLOCK_HZ, outer - PALLET_BLOCK_HZ] // between the centre block and the outer one
  return [s.value, {
    length: s.length,
    width: s.width,
    tip: r8(s.length / 2 - TINE_DEPTH),
    tz: r8((channel[0] + channel[1]) / 2),
    gx: r8(s.length / 2 + GUIDE_GAP),
    gz: r8(s.width / 2 + GUIDE_GAP),
  }]
}))
const sizeOf = (v) => SIZES[v] || SIZES[DEFAULT_PALLET_STANDARD]
// a tine: 0.1 across, 0.04 thick, centred in the pocket's height (over the runners, under the deck boards)
const TINE_W = 0.1
const TINE_T = 0.04
const TINE_Y = r8((PALLET_RUNNER_T + (PITCH - PALLET_DECK_T)) / 2)
const STAND_DEFAULT = 1.0
const PARK = -40 // where a magazine position that holds no pallet stands: under the floor, gripping nothing

const DWELL = 0.15 // the pause between strokes, as a real valve sequence has
const AUTO_WAIT = 1.5 // Auto dispense: how long the bay stands empty before the next pallet goes down
const REFILL_WAIT = 12 // Reload when empty: this long after the last pallet leaves the magazine
// A stack is taken in only once it has stood on the conveyor this long: long enough for the truck that set it down
// to have let go of it (a gripper opens a moment after it arrives) and started backing its blades out.
const LOAD_SETTLE = 2
// A gripped stack is held where it stood, a few mm settled into itself, so a pallet from high in it is held slightly
// LOW of its position. The stack is set down this far above the conveyor, and each pallet drops the last few mm on its
// own, rather than being pressed into the deck (measured 2026-09-28: up to 9 mm into it from a 10-stack).
const SET_GAP = 0.012
// Once the bottom pallet is let go, the stack above it is held this far clear of it, so the held pallet does not
// press the free one into the conveyor or drag on it as it leaves.
const CLEAR = 0.01
const SPAWN_BATCH = 8 // the host's ctx.spawn limit per tick (sim/embeddedBehavior MAX_SPAWNS_PER_TICK)

// The magazine positions, bottom first: the copies of the gripper array `pos` (see rig()), named `pos#i`
const POSITIONS = Array.from({ length: MAX }, (_, i) => `pos#${i}`)

let phase = 'start' // start | idle | lower | release | index | engage | separate | takeup | raise | refill
let lift = HOLD // the underside of the pallet the forks are in (the carriage datum)
let fork = 0 // fork retraction, 0 (in) .. STROKE (out)
let bottom = MAX // the magazine position of the bottom pallet; positions below it are empty
let held = false // the positions from bottom up are gripping (false while parked, and while a stack is taken up)
let stackY = 0 // the underside of the bottom HELD pallet: where the gripping positions are posed from
let setAt = 0 // the carriage height the last pallet was let go at
let making = 0 // new pallets being made (a stack of this many), and how many of them so far
let made = 0
const gripped = [] // per magazine position: its gripper has reported holding a pallet (so a later false means it lost it)
let wait = 0
let pending = false
let bayClearFor = 0
let emptyFor = 0
let loadFor = 0
let dispensed = 0
let blink = 0

function hexRgb(hex) {
  const h = (hex || '').replace('#', '')
  if (h.length < 6) return [1, 1, 1]
  const v = (i) => { const n = parseInt(h.slice(i, i + 2), 16); return Number.isFinite(n) ? n / 255 : 0.5 }
  return [v(0), v(2), v(4)]
}

definePart({
  interactive: true, // Use dispenses one pallet (by hand, when no program owns the dispense tag)
  joints: ['lift', 'forkW', 'forkE'],
  lamps: ['ready', 'low'],
  params: {
    capacity: { type: 'number', default: MAX, min: 1, max: MAX, step: 1, label: 'Magazine capacity', desc: 'How many empty pallets a full magazine holds: the positions it grips, from the bottom up. A stack loaded taller than this keeps the pallets above the top position, standing loose on the stack.' },
    // RETIRED, kept for saved scenes: a count the run turned into new pallets. The stock is authored now (Fill, in
    // the Inspector, places real pallets in the magazine), so the stopped scene shows what a run starts with
    stock: { type: 'number', default: 0, min: 0, max: MAX, step: 1, hidden: true, label: 'Pallets at start', desc: 'Retired: place pallets in the magazine instead (Fill, in the Inspector). A scene saved with a count here still starts with that many new pallets when none are placed.' },
    autoFeed: { type: 'boolean', default: true, label: 'Auto dispense', desc: 'With no program driving the dispense tag, keep the bay stocked: set down the next pallet whenever the last one has been carried clear. Off, it dispenses only on Use.' },
    autoRefill: { type: 'boolean', default: false, label: 'Reload by itself when empty', desc: 'Fill an empty magazine with new pallets a few seconds after the last one leaves it and the bay is clear. Off (the default), it waits to be loaded: set a stack of two or more pallets down in it from its open -Z side.' },
    liftSpeed: { type: 'number', default: 0.15, min: 0.03, max: 0.6, step: 0.01, label: 'Lift speed (m/s)', group: 'Machine', desc: 'Carriage speed up and down. A cycle travels about two pallet heights plus the hold gap twice, so this sets most of the cycle time.' },
    forkTime: { type: 'number', default: 0.6, min: 0.2, max: 3, step: 0.05, label: 'Fork stroke time (s)', group: 'Machine', desc: 'How long the forks take to go in or out of a pallet.' },
    standHeight: { type: 'number', default: STAND_DEFAULT, min: 0.2, max: 2.5, step: 0.01, label: 'Stand height (m)', desc: 'Height of the conveying surface the pallets are set down on. The part stands with its origin on that surface, and its columns run from here down to the floor.' },
    frameColor: { type: 'color', default: '#24507a', label: 'Frame color', group: 'Colors', desc: 'Paint of the columns, beams, ties and knee braces.' },
    guardColor: { type: 'color', default: '#f2bd0f', label: 'Guide color', group: 'Colors', desc: 'Paint of the magazine guides and the lift carriage, the parts that move or touch the pallets.' },
    palletSize: {
      type: 'enum', default: DEFAULT_PALLET_STANDARD, label: 'Pallet size', group: 'Pallet',
      desc: 'The pallets it holds: its guides and forks are set for this footprint, Fill places pallets of it, and the new pallets it makes are this size.',
      options: PALLET_STANDARDS.map((s) => ({ value: s.value, label: s.label })),
    },
    palletColor: { type: 'color', default: '#ffffff', label: 'Pallet color', group: 'Pallet', desc: 'Tint over the pallet wood of the new pallets it is filled with (Pallets at start, Reload by itself). White leaves them untinted, like a hand-placed pallet. A pallet loaded into it keeps its own.' },
    mass: { type: 'number', default: 25, min: 1, max: 200, step: 1, label: 'Mass (kg)', group: 'Pallet', desc: 'Mass of the new pallets it is filled with. A pallet loaded into it keeps its own.' },
    dispenseTag: { type: 'tag', dir: 'in', stType: 'BOOL', autoWhenDriven: true, default: '', label: 'Dispense tag (rising edge)', group: 'Comms', desc: 'Each rising edge dispenses ONE pallet; holding it true does not dispense more. While a program drives this tag it owns the machine: Use and Auto dispense stand aside.' },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Enable tag', group: 'Comms', desc: 'The dispenser moves only while this is true. Drop it and the carriage and forks stop where they are, holding the stack; raise it and the cycle carries on from there. A request while it is false is refused. Wire it to the line running, so a Stop or a trip holds the dispense and a Start finishes it. Until a program drives it, or with it empty, the dispenser is always enabled, so a merely-typed tag does not hold it.' },
    busyTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Busy tag', group: 'Comms', desc: 'True from a dispense request until the stack is lifted clear of the pallet it set down. Hold the conveyor under the magazine until it falls.' },
    bayTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Pallet in bay tag', group: 'Comms', desc: 'The bay photo-eye: true while a pallet stands under the magazine. A line that keeps one pallet waiting dispenses whenever this is false and it is not busy.' },
    countTag: { type: 'tag', dir: 'out', stType: 'DINT', default: '', label: 'Dispensed count tag', group: 'Comms', desc: 'Running total of pallets set down.' },
    levelTag: { type: 'tag', dir: 'out', stType: 'INT', default: '', label: 'Pallets left tag', group: 'Comms', desc: 'How many pallets are still in the magazine. Zero means it is parked, waiting to be loaded.' },
  },
  // The machine, drawn. Everything static is on the part root; the carriage (sleeves on the columns, a cross beam at
  // each end, the fork cylinders) rides 'carriage', and each end's fork bar, tines and piston rods ride its fork link.
  // Positions on the carriage are in its frame: y = 0 is the underside of the pallet its forks are in.
  geometry(g, p) {
    var num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d }
    var sh = num(p.standHeight, STAND_DEFAULT)
    var size = sizeOf(p.palletSize)
    var CX = COL_X, CZ = COL_Z, C = COL, B = 0.004
    var box = function (list, x0, x1, y0, y1, z0, z1, square) {
      list.push(g.bevelBox([Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)], [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], B, square))
    }
    // a round bar along an axis: [radius, from, to] about a centre point on that axis
    var bar = function (list, axis, center, rad, from, to, seg) {
      list.push(g.lathe([[0, from], [rad, from], [rad, to], [0, to]], { axis: axis, center: center, segments: seg || 12 }))
    }
    var frame = [], guide = [], dark = [], panel = [], alu = []

    // --- the frame: four columns on base plates, a top ring of beams, and ties squaring three sides. The -Z side is
    //     the LOADING side and has no tie: a stack comes in there under the top beam ---
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sz = -1; sz <= 1; sz += 2) {
        box(frame, sx * CX - C / 2, sx * CX + C / 2, -sh + 0.012, TOPY, sz * CZ - C / 2, sz * CZ + C / 2, ['y-'])
        box(dark, sx * CX - 0.13, sx * CX + 0.13, -sh, -sh + 0.012, sz * CZ - 0.13, sz * CZ + 0.13, ['y-'])
      }
    }
    for (var s1 = -1; s1 <= 1; s1 += 2) {
      box(frame, -CX - C / 2, CX + C / 2, TOPY - 0.12, TOPY, s1 * CZ - 0.05, s1 * CZ + 0.05) // along x, over each side
      box(frame, s1 * CX - 0.05, s1 * CX + 0.05, TOPY - 0.1, TOPY, -CZ + C / 2, CZ - C / 2, ['z-', 'z+']) // along z, each end
      box(frame, s1 * CX - 0.04, s1 * CX + 0.04, 1.16, 1.24, -CZ + C / 2, CZ - C / 2, ['z-', 'z+']) // end tie
    }
    box(frame, -CX + C / 2, CX - C / 2, 1.16, 1.24, CZ - 0.04, CZ + 0.04, ['x-', 'x+']) // the closed side's tie

    // --- the joints, made the way a fabricator makes them: a knee brace under every top-beam corner (on all four
    //     sides; the loading side's sit above the tallest stack a truck sets down), stiffener fins round each column
    //     foot, anchors through each base plate, and a pair of bolts wherever a beam or a tie meets a column ---
    var hw = mesh(g), fr = mesh(g), KB = 0.3, KT = 0.06, BAF = 0.02
    var bolt = function (x, y, z, ax, s) { hex(hw, [x, y, z], ax, s, BAF, BAF * 0.4) }
    for (var kx = -1; kx <= 1; kx += 2) {
      for (var kz = -1; kz <= 1; kz += 2) {
        var cx0 = kx * CX, cz0 = kz * CZ, yp = -sh + 0.012
        // knee braces: in the side plane (under the along-x beam) and in the end plane (under the end beam)
        var ys = TOPY - 0.12, ye = TOPY - 0.1
        member(fr, [kx * (CX - C / 2 + 0.01), ys - KB, cz0], [kx * (CX - C / 2 - KB), ys + 0.01, cz0], KT)
        member(fr, [cx0, ye - KB, kz * (CZ - C / 2 + 0.01)], [cx0, ye + 0.01, kz * (CZ - C / 2 - KB)], KT)
        bolt(kx * (CX - C / 2 - KB + 0.05), ys - 0.03, kz * (CZ + KT / 2), 2, kz)
        bolt(kx * (CX - C / 2 - 0.02), ys - KB + 0.05, kz * (CZ + KT / 2), 2, kz)
        bolt(kx * (CX + KT / 2), ye - 0.03, kz * (CZ - C / 2 - KB + 0.05), 0, kx)
        bolt(kx * (CX + KT / 2), ye - KB + 0.05, kz * (CZ - C / 2 - 0.02), 0, kx)
        // the top beams bolted through the column: into the side beam, and into the end beam
        bolt(cx0 - 0.03, TOPY - 0.04, kz * (CZ + C / 2), 2, kz)
        bolt(cx0 + 0.03, TOPY - 0.08, kz * (CZ + C / 2), 2, kz)
        bolt(kx * (CX + C / 2), TOPY - 0.05, cz0 - kz * 0.03, 0, kx)
        // the end ties through the column's outer face, and the closed side's tie through the +Z columns
        bolt(kx * (CX + C / 2), 1.2, cz0 - 0.025, 0, kx)
        bolt(kx * (CX + C / 2), 1.2, cz0 + 0.025, 0, kx)
        if (kz > 0) { bolt(cx0 - 0.025, 1.2, CZ + C / 2, 2, 1); bolt(cx0 + 0.025, 1.2, CZ + C / 2, 2, 1) }
        // the foot: a stiffener fin off each face of the column, and four anchors through the plate
        for (var f = -1; f <= 1; f += 2) {
          frame.push(g.extrude([[cx0 + f * C / 2, yp], [cx0 + f * (C / 2 + 0.06), yp], [cx0 + f * C / 2, yp + 0.14]], cz0 - 0.005, cz0 + 0.005, { axis: 'z' }))
          frame.push(g.extrude([[yp, cz0 + f * C / 2], [yp, cz0 + f * (C / 2 + 0.06)], [yp + 0.14, cz0 + f * C / 2]], cx0 - 0.005, cx0 + 0.005, { axis: 'x' }))
          for (var f2 = -1; f2 <= 1; f2 += 2) anchor(hw, cx0 + f * 0.095, yp, cz0 + f2 * 0.095, 0.02)
        }
      }
    }

    // --- the magazine guides: an angle leg against each END of the stack at every corner, and a backstop leg across
    //     the closed +Z side; the open side has none. Each is braced to the frame and flared at the top ---
    var GX = size.gx, GZ = size.gz, G0 = 0.46, GT = 0.008
    var flare = function (piece, q, at) { guide.push(g.transform(piece, { rotate: q, translate: at })) }
    for (var gx = -1; gx <= 1; gx += 2) {
      for (var gz = -1; gz <= 1; gz += 2) {
        // the end leg (a plate across z, just outside the pallet's end), braced to the end beam and the end tie
        box(guide, gx * GX, gx * (GX + GT), G0, TOPY + 0.02, gz * (GZ - 0.11), gz * (GZ + GT))
        box(guide, gx * (GX + GT), gx * (CX - 0.05), TOPY - 0.09, TOPY - 0.02, gz * (GZ - 0.06), gz * (GZ + GT))
        box(guide, gx * (GX + GT), gx * (CX - 0.04), 1.17, 1.23, gz * (GZ - 0.06), gz * (GZ + GT))
        flare(g.box([GT, 0.14, 0.11], [0, 0.07, 0]), [0, 0, -gx * Math.sin(0.2), Math.cos(0.2)], [gx * (GX + GT / 2), TOPY + 0.02, gz * (GZ - 0.055)])
        if (gz > 0) {
          // the backstop leg across the closed side, braced to its tie
          box(guide, gx * (GX - 0.11), gx * (GX + GT), G0, TOPY + 0.02, GZ, GZ + GT)
          box(guide, gx * (GX - 0.06), gx * (GX + GT), 1.17, 1.23, GZ + GT, CZ - 0.04)
          flare(g.box([0.11, 0.14, GT], [0, 0.07, 0]), [Math.sin(0.2), 0, 0, Math.cos(0.2)], [gx * (GX - 0.055), TOPY + 0.02, GZ + GT / 2])
        }
      }
    }

    // --- the lift drive: a gearmotor on the east end beam turning a cross shaft, and a shaft down each side ---
    box(dark, CX - 0.07, CX + 0.07, TOPY, TOPY + 0.16, -0.14, 0.14)
    bar(dark, 'z', [CX, TOPY + 0.08, 0], 0.075, 0.14, 0.46, 16)
    bar(alu, 'z', [CX, TOPY + 0.04, 0], 0.022, -CZ, CZ)
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      bar(alu, 'x', [0, TOPY + 0.04, s2 * CZ], 0.022, -CX, CX)
      for (var s3 = -1; s3 <= 1; s3 += 2) box(dark, s3 * CX - 0.045, s3 * CX + 0.045, TOPY, TOPY + 0.07, s2 * CZ - 0.045, s2 * CZ + 0.045, ['y-'])
    }

    // --- the bay sensor: an emitter and reflector on the west columns, looking across the pallet's footprint ---
    box(dark, -CX - 0.03, -CX + 0.03, 0.03, 0.11, -CZ + C / 2, -CZ + C / 2 + 0.06, ['z-'])
    box(dark, -CX - 0.03, -CX + 0.03, 0.03, 0.11, CZ - C / 2 - 0.02, CZ - C / 2, ['z+'])

    // --- the operator station on the east face of the +Z column: an enclosure with a hinged door under a rain hood,
    //     the two lamps (rig links) in bezels, a handle and a nameplate, and a gland plate underneath taking the
    //     cables in. No screen, selector or buttons ---
    var PX = CX + C / 2, PF = PX + 0.17
    box(panel, PX, PF - 0.008, 0.32, 0.84, CZ - 0.2, CZ + 0.2, ['x-'])
    box(panel, PF - 0.009, PF, 0.328, 0.832, CZ - 0.192, CZ + 0.192, ['x-'])
    box(panel, PX, PF + 0.02, 0.84, 0.855, CZ - 0.215, CZ + 0.215, ['x-'])
    for (var sw = -1; sw <= 1; sw += 2) {
      bar(alu, 'x', [0, 0.72, CZ + sw * 0.08], 0.035, PF, PF + 0.008, 20)
      bar(dark, 'y', [PF + 0.004, 0, CZ - 0.197], 0.007, sw > 0 ? 0.74 : 0.36, sw > 0 ? 0.8 : 0.42, 8)
    }
    box(dark, PF, PF + 0.018, 0.61, 0.68, CZ + 0.155, CZ + 0.175, ['x-'])
    box(alu, PF, PF + 0.003, 0.785, 0.815, CZ - 0.09, CZ + 0.09, ['x-'])
    box(dark, PX + 0.01, PF - 0.02, 0.305, 0.32, CZ - 0.18, CZ + 0.18, ['y+'])
    for (var gl = -1; gl <= 1; gl++) bar(dark, 'y', [PX + 0.085, 0, CZ + gl * 0.1], 0.014, 0.27, 0.305, 12)

    // --- the carriage: a sleeve around each column, a beam across each END, the fork cylinders out beyond them ---
    var car = [], carAlu = [], ch = mesh(g)
    for (var cx = -1; cx <= 1; cx += 2) {
      for (var cz = -1; cz <= 1; cz += 2) {
        var x0 = cx * CX, z0 = cz * CZ, o = C / 2 + 0.025, t = 0.018
        box(car, x0 - o, x0 + o, 0, 0.34, z0 - o, z0 - o + t)
        box(car, x0 - o, x0 + o, 0, 0.34, z0 + o - t, z0 + o)
        box(car, x0 - o, x0 - o + t, 0, 0.34, z0 - o + t, z0 + o - t, ['z-', 'z+'])
        box(car, x0 + o - t, x0 + o, 0, 0.34, z0 - o + t, z0 + o - t, ['z-', 'z+'])
        // the sleeve's guide-shoe bolts, on its outboard face
        for (var by = 0; by < 2; by++) for (var bz = -1; bz <= 1; bz += 2) hex(ch, [x0 + cx * o, 0.06 + by * 0.22, z0 + bz * 0.035], 0, cx, 0.02, 0.008)
      }
      // the cross beam, sleeve to sleeve, high enough over the conveyor that a dispensed pallet leaves under it
      box(car, cx * 0.66, cx * (CX - o + 0.002), 0.14, 0.3, -(CZ - o + 0.002), CZ - o + 0.002, ['z-', 'z+'])
      for (var s5 = -1; s5 <= 1; s5 += 2) {
        // cylinder mount plate off the beam's underside, a clamp, and the cylinder body, aimed at the pallet
        box(car, cx * (CX - o), cx * 1.25, 0.14, 0.16, s5 * 0.45 - 0.06, s5 * 0.45 + 0.06, ['y+'])
        box(car, cx * 1.02, cx * 1.1, 0.105, 0.14, s5 * 0.45 - 0.035, s5 * 0.45 + 0.035, ['y+'])
        bar(carAlu, 'x', [0, 0.08, s5 * 0.45], 0.032, Math.min(cx * 0.86, cx * 1.25), Math.max(cx * 0.86, cx * 1.25), 16)
        // square end caps, the ISO cylinder's head and cap
        box(carAlu, Math.min(cx * 0.86, cx * 0.895), Math.max(cx * 0.86, cx * 0.895), 0.0375, 0.1225, s5 * 0.45 - 0.0425, s5 * 0.45 + 0.0425)
        box(carAlu, Math.min(cx * 1.215, cx * 1.25), Math.max(cx * 1.215, cx * 1.25), 0.0375, 0.1225, s5 * 0.45 - 0.0425, s5 * 0.45 + 0.0425)
      }
    }

    // --- each end's forks: two tines in the pallet's fork channels, the bar they hang on, two piston rods. A tine
    //     runs from its tip back to the bar, so a shorter pallet gets longer tines, not a gap ---
    var forks = function (s) {
      var list = []
      var tineLen = TINE_BAR - size.tip
      for (var tz = -1; tz <= 1; tz += 2) {
        list.push(g.bevelBox([tineLen, TINE_T, TINE_W], [s * (size.tip + tineLen / 2), TINE_Y, tz * size.tz], 0.006))
        bar(list, 'x', [0, 0.08, tz * 0.45], 0.014, Math.min(s * 0.76, s * 0.99), Math.max(s * 0.76, s * 0.99))
      }
      box(list, s * 0.71, s * 0.76, 0.04, 0.12, -0.5, 0.5)
      return list
    }

    var m = function (list) { return g.merge.apply(g, list) }
    frame.push(fr.sb.build())
    dark.push(hw.sb.build())
    carAlu.push(ch.sb.build())
    return [
      { desc: m(frame), material: 'frame', colorParam: 'frameColor' },
      { desc: m(guide), material: 'guide', colorParam: 'guardColor', doubleSided: true },
      { desc: m(dark), material: 'dark' },
      { desc: m(panel), material: 'panel' },
      { desc: m(alu), material: 'alu' },
      { desc: m(car), material: 'guide', colorParam: 'guardColor', link: 'carriage' },
      { desc: m(carAlu), material: 'alu', link: 'carriage' },
      { desc: m(forks(-1)), material: 'steel', link: 'forkW' },
      { desc: m(forks(1)), material: 'steel', link: 'forkE' },
    ]
  },
  step(ctx) {
    const p = ctx.params
    const cap = Math.max(1, Math.min(MAX, Math.round(p.capacity)))
    // new pallets (a SOURCE: the start's stock and a reload), made straight into the held magazine at the positions
    // from bottom up, whose grippers are already closed and take each as it appears. Never on the conveyor, which may
    // be running. SPAWN_BATCH a tick: the host's per-tick spawn limit drops the rest without a word.
    const fill = (n) => { bottom = cap - n; held = true; making = n; made = 0; gripped.length = 0 }
    const size = sizeOf(p.palletSize)
    for (let k = 0; k < SPAWN_BATCH && made < making; k++, made++) {
      ctx.spawn({ kind: 'pallet', size: [size.length, PITCH, size.width], color: hexRgb(p.palletColor), mass: p.mass, offset: [0, stackY + made * PITCH + PITCH / 2 + 0.001, 0] })
    }
    if (phase === 'start') {
      // first tick. Pallets placed at the holding positions (the Inspector's Fill) are its stock, gripped where they
      // stand. A stack placed STANDING on the conveyor reaches up into those positions too, but it is a load: the
      // machine parks, and takes it in as it would a truck's. With neither, a saved scene's retired Pallets at start
      // count makes new ones, held up on the forks; with none of these, it parks and waits for a truck
      const standing = ctx.zone('seat') >= 1 && ctx.zone('second') >= 1
      const inHold = standing ? 0 : Math.min(cap, ctx.zone('held'))
      const stock = standing ? 0 : Math.max(0, Math.min(cap, Math.round(p.stock)))
      if (inHold > 0) { lift = HOLD; fork = 0; stackY = HOLD; bottom = cap - inHold; held = true; phase = 'idle' }
      else if (stock > 0) { lift = HOLD; fork = 0; stackY = HOLD; fill(stock); phase = 'idle' }
      else { lift = 0; fork = STROKE; phase = 'idle' }
    }
    const driven = ctx.tagDriven(p.dispenseTag)
    const enabled = !ctx.tagDriven(p.enableTag) || ctx.readTag(p.enableTag) === true
    const bayClear = ctx.zone('bay') === 0
    const left = Math.max(0, cap - bottom)

    // requests: the program's edge while it owns the machine, else a Use or an empty bay
    if (driven) {
      if (ctx.rising(p.dispenseTag)) pending = true
    } else {
      if (ctx.used()) pending = true
      bayClearFor = bayClear && phase === 'idle' ? bayClearFor + ctx.dt : 0
      if (p.autoFeed && bayClearFor >= AUTO_WAIT && left > 0) pending = true
    }

    // a request while the machine is held is refused, not kept for when it comes back
    if (!enabled) pending = false

    // held, nothing moves: the stack eased clear of a released pallet stays where it is too
    const v = enabled ? Math.max(0.01, p.liftSpeed) * ctx.dt : 0
    const fv = enabled ? STROKE / Math.max(0.05, p.forkTime) * ctx.dt : 0

    // an EMPTY magazine parks for loading, and takes in a stack that has been set down in it and left standing
    const parked = left === 0 && phase === 'idle'
    if (parked && enabled) {
      held = false
      lift = ctx.approach(lift, 0, v)
      fork = ctx.approach(fork, STROKE, fv)
      const standing = ctx.zone('seat') >= 1 && ctx.zone('magazine') >= 2
      loadFor = standing && lift === 0 && fork === STROKE ? loadFor + ctx.dt : 0
      if (loadFor >= LOAD_SETTLE) {
        // the stack is gripped where it stands (takeup), so its pallets stay the pallets they are
        bottom = cap - Math.min(cap, ctx.zone('magazine'))
        gripped.length = 0
        loadFor = 0
        emptyFor = 0
        phase = 'takeup'
        wait = DWELL
      } else {
        // a reload waits for the bay too: it would stand the new stack on the pallet waiting there
        emptyFor = ctx.zone('magazine') === 0 ? emptyFor + ctx.dt : 0
        if (p.autoRefill && emptyFor >= REFILL_WAIT) { emptyFor = 0; phase = 'refill' }
      }
    } else {
      loadFor = 0
      emptyFor = 0
    }

    if (!enabled) {
      // held: the cycle keeps its place, dwell and all
    } else if (wait > 0) wait -= ctx.dt
    else if (phase === 'idle') {
      // a position that has LOST its pallet (a person lifted it out) is skipped, so the next dispense lets go of one.
      // Lost = seen gripping, then not: a gripper that has never reported a hold (the stopped editor's preview, which
      // has no sim to grip in, or one a tick after it closed) is not taken for an empty position
      const got = ctx.measured && ctx.measured.grips
      if (got) for (let i = 0; i < cap; i++) if (got[POSITIONS[i]]) gripped[i] = true
      while (held && got && bottom < cap && gripped[bottom] && !got[POSITIONS[bottom]]) { gripped[bottom] = false; bottom++ }
      if (pending && cap - bottom > 0 && bayClear) { pending = false; phase = 'lower' }
    } else if (phase === 'lower') {
      lift = ctx.approach(lift, SET_GAP, v)
      if (lift === SET_GAP) {
        // the stack stands on the conveyor and the forks start out of the bottom pallet: it is let go, and the
        // position above it is the bottom one now, held just where it is
        setAt = lift
        gripped[bottom] = false // let go on purpose, not lost
        bottom++
        dispensed++
        stackY = lift + PITCH
        phase = 'release'
        wait = DWELL
      }
    } else if (phase === 'release') {
      fork = ctx.approach(fork, STROKE, fv)
      if (fork === STROKE) { phase = 'index'; wait = DWELL }
    } else if (phase === 'index') {
      lift = ctx.approach(lift, setAt + PITCH + CLEAR, v)
      if (lift === setAt + PITCH + CLEAR) { phase = 'engage'; wait = DWELL }
    } else if (phase === 'engage') {
      fork = ctx.approach(fork, 0, fv)
      if (fork === 0) { phase = 'separate'; wait = DWELL }
    } else if (phase === 'separate') {
      lift = ctx.approach(lift, HOLD, v)
      if (lift === HOLD) phase = 'idle'
    } else if (phase === 'takeup') {
      // a stack stands on the conveyor: carriage down, forks into its bottom pallet, and every position grips ...
      lift = ctx.approach(lift, 0, v)
      if (lift === 0) fork = ctx.approach(fork, 0, fv)
      if (lift === 0 && fork === 0) { held = true; phase = 'raise'; wait = DWELL }
    } else if (phase === 'raise') {
      // ... and up to the holding position
      lift = ctx.approach(lift, HOLD, v)
      if (lift === HOLD) phase = 'idle'
    } else if (phase === 'refill') {
      // Reload by itself: forks in, up to the holding position, and a full magazine is made on them
      fork = ctx.approach(fork, 0, fv)
      if (fork === 0) lift = ctx.approach(lift, HOLD, v)
      if (fork === 0 && lift === HOLD) { stackY = HOLD; fill(cap); phase = 'idle' }
    }

    ctx.joints.lift = lift - HOLD
    ctx.joints.forkW = fork
    ctx.joints.forkE = fork

    // the magazine: riding the forks, except between letting a pallet go and the forks taking the next one, when
    // the stack is held where it stood, eased CLEAR of the pallet under it
    const between = phase === 'release' || phase === 'index' || phase === 'engage'
    stackY = between ? ctx.approach(stackY, setAt + PITCH + CLEAR, v) : lift
    for (let i = 0; i < ctx.arrayCount('pos'); i++) {
      const inUse = i >= bottom && i < cap
      ctx.setSubPose('pos', { position: [0, inUse ? stackY + (i - bottom) * PITCH : PARK, 0] }, i)
      ctx.setGrip('pos', held && inUse, i)
    }

    const nowLeft = Math.max(0, cap - bottom)
    const busy = pending || phase !== 'idle'
    blink = (blink + ctx.dt) % 1
    ctx.lamps.ready = !busy && nowLeft > 0
    ctx.lamps.low = nowLeft === 0 ? blink < 0.5 : nowLeft <= 2
    if (p.busyTag) ctx.writeTag(p.busyTag, busy)
    if (p.bayTag) ctx.writeTag(p.bayTag, !bayClear)
    if (p.countTag) ctx.writeNumber(p.countTag, dispensed)
    if (p.levelTag) ctx.writeNumber(p.levelTag, nowLeft)
  },
})
