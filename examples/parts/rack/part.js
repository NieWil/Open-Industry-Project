// Storage Rack — a pallet rack: an upright frame carrying evenly-spaced shelves. Demonstrates
// array links: numShelves + shelfSpacing drive a stacked shelf array and the derived frame height (a mulParam
// product); enableAutoPoles stands an end frame every poleInterval along the width. Purely structural — the params
// reshape the rig, the step does nothing. Cargo rests on each shelf (a collision slab).
//
// geometry() dresses the rig with the one thing a rig can't express: the end-frame LACING (the horizontal and
// diagonal struts between the front and back uprights of every frame). A diagonal's angle depends on the depth
// AND the height at once, which no linear param map reaches. Render-only (the uprights and shelves collide), and
// ONE merged submesh for every strut of the rack. Each strut is an oriented box written through g.surface()
// (g.box is axis-aligned), four vertices per face so the host-derived normals stay flat.
//
// It also carries the HARDWARE that makes the frame read as bolted steel rather than blue sticks, for the same
// reason: every piece sits where the lacing meets an upright, at a beam end, or on an upright's face, and all
// of those move with the pole grid. A footplate under each upright with its anchor bolts; a hex bolt through
// the upright at every lacing joint, head on one face and nut + thread on the other; a connector plate at each
// beam end with its bolts; a cap on each post; and the teardrop slots punched down each upright's aisle face.
// And the WIRE DECKING on every level - welded mesh on front-to-back channels, one set of panels per bay - which
// is what you see of a shelf: the rig's shelf slab is hidden and only carries the cargo. And a LOCATION LABEL on
// the beams of every bay at every level (plate, code, bar code). Four submeshes in all (frame, deck, hardware,
// label plates), however many uprights, and every piece sinks a hair into the face it sits on so no two
// surfaces share a plane.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { hardwareMaterial, SEAT, VERT_CAP, mesh, obox, abox, hex, throughBolt, anchor, teardrop, emitMeshes } from '../_shared/hardware.js'

// the rig's dimensions (m); geometry() draws with some of them too
var UPRIGHT = 0.08 // upright thickness
var SHELF_T = 0.04 // shelf thickness
// Load beams are a pallet rack's step beams: taller than they are deep, seated on the upright centreline. Being
// shallower than an upright, a beam runs THROUGH the interior uprights with the upright standing proud on both
// faces; a beam face flush with an upright face would share its plane and z-fight across the whole junction.
// The TOP stands LIP proud of the shelf slab - low enough that a truck's forks, threading a load's pockets over
// it, keep their clearance (e2e/verify-shelf-pick.mjs threads at 1.647 over a 1.62 slab).
var BEAM_H = 0.12, BEAM_T = 0.05, LIP = 0.01
var BEAM_TOP = SHELF_T / 2 + LIP // a beam's top above its level
var DEFAULT_SPACING = 1.6 // default shelfSpacing (static fallback for a sparse instance)
var DEFAULT_SHELVES = 4 // default numShelves
// Selective pallet racking's common sizes: bays of 96-108 in (2.44-2.74 m) take two 48 x 40 in pallets side by
// side, on frames about 42 in (1.07 m) deep, so a pallet's 48 in side overhangs each load beam a little.
var DEFAULT_LENGTH = 5.4 // default length (the param is labelled "Width"): two bays
var DEFAULT_DEPTH = 1.1 // default depth: the frame, front upright to back upright
var DEFAULT_BAY = 2.7 // default poleInterval: one bay, along the width only
var DEFAULT_TOP = DEFAULT_SHELVES * DEFAULT_SPACING // default top-shelf height (6.4)
// The uprights stand this far past the top shelf, as a real frame's do: ending flush with the top level left the
// top beam (LIP proud of its slab) standing over the posts, which read as a beam balanced on sticks.
var OVER = 0.15
// Pallet-rack livery: blue uprights and end-frame lacing, orange load beams, galvanized decking. These are the
// pre-tint fallbacks; the frameColor/beamColor/shelfColor params drive the real sRGB→linear tint.
var FRAME_COLOR = [0.028, 0.107, 0.314] // #2e5c96
var BEAM_COLOR = [0.807, 0.147, 0.013] // #e86a1c
var SHELF_COLOR = [0.275, 0.296, 0.319] // #8e939a
// any metalness makes the uprights reflect the env map instead of showing their albedo
var FINISH = { metalness: 0, roughness: 0.8 }
// The AISLE SIGN: a plate across the top of each end frame, facing out along X, printed with the `aisle` param
// (empty = no sign, which is the default). It stands SIGN_OUT clear of the upright's centreline - past the upright
// face and the lacing bolts' heads - and its top SIGN_DROP under the post tops, below the top lacing strut.
var SIGN = [1.1, 0.32]
var SIGN_OUT = UPRIGHT / 2 + 0.03
var SIGN_DROP = 0.14 + SIGN[1] / 2

// the upright height: numShelves × shelfSpacing + OVER
function frameHeight(p) {
  return p.numShelves * p.shelfSpacing + OVER
}
// one shelf level per numShelves, a shelf pitch apart
function shelfArray(p) {
  return { count: 'numShelves', step: [0, p.shelfSpacing, 0] }
}

// The four structural corner posts always stand - the auto-poles-off layout and the collidable frame.
function cornerPost(p, name, sx, sz) {
  return {
    name,
    shape: { kind: 'box', size: [UPRIGHT, frameHeight(p), UPRIGHT] },
    offset: [(sx * p.length) / 2, frameHeight(p) / 2, (sz * p.depth) / 2],
    color: FRAME_COLOR,
    colorParam: 'frameColor',
    ...FINISH,
  }
}
// Front/back load beams under every shelf level: a numShelves array from one pitch up (the floor level has no
// beam, like a real pallet rack), each beam's top LIP proud of its slab. The span is length − upright thickness.
function beam(p, name, sz) {
  return {
    name,
    shape: { kind: 'box', size: [p.length - UPRIGHT, BEAM_H, BEAM_T] },
    offset: [0, p.shelfSpacing + BEAM_TOP - BEAM_H / 2, (sz * p.depth) / 2],
    color: BEAM_COLOR,
    colorParam: 'beamColor',
    ...FINISH,
    array: shelfArray(p),
  }
}
function aisleSign(p, name, sx) {
  return {
    name,
    shape: { kind: 'label', textParam: 'aisle', size: SIGN, color: [0.05, 0.06, 0.09] },
    offset: [sx * (p.length / 2 + SIGN_OUT), frameHeight(p) - SIGN_DROP, 0],
    rotation: [0, (sx * Math.PI) / 2, 0],
  }
}

// lacing (m): strut section, the bottom/top horizontals' heights, the target height of one diagonal panel
// SINK: how far each strut end runs into its upright, so no end cap shares the upright's face plane
var STRUT = 0.035, LACE_BOTTOM = 0.15, LACE_TOP_GAP = 0.1, LACE_PANEL = 1.0, SINK = 0.01
// hardware (m). PLATE_*: footplate thickness and how far it runs past the upright in X / Z (clamped to the
// rack's outline, so a rack flushed against this one never overlaps a plate). BOLT_AF: a hex's across-flats,
// oversized a touch from M12 so it reads at aisle distance. BOLT_IN: a lacing bolt's offset from the upright
// face its strut enters. CONN_*: the beam-end connector plate. SLOT_*: the aisle-face teardrops. The drawing
// helpers (mesh, abox, hex, throughBolt, anchor, teardrop, SEAT, VERT_CAP) are examples/parts/_shared/hardware.js,
// shared with the other structural parts.
var PLATE_T = 0.008, PLATE_X = 0.045, PLATE_Z = 0.025, ANCHOR_AF = 0.022
var BOLT_AF = 0.02, BOLT_IN = 0.02
var CONN_T = 0.005, CONN_W = 0.066, CONN_DROP = 0.09, CONN_AF = 0.014, CONN_BOLT_H = 0.005
var SLOT_W = 0.012, SLOT_H = 0.03, SLOT_PITCH = 0.1, SLOT_INSET = 0.02, PROUD = 0.0015
// wire decking (m): its top is the hidden shelf slab's (DECK_TOP above the level), a step below the beams' top.
// Welded mesh - wires along X on top of wires along Z, WIRE_PITCH both ways - on channels running front to
// back, in panels no wider than DECK_PANEL with DECK_GAP between them and UPRIGHT_GAP clear of each upright.
var DECK_TOP = SHELF_T / 2, WIRE = 0.006, WIRE_PITCH = 0.1, DECK_PANEL = 1.25, DECK_GAP = 0.012, UPRIGHT_GAP = 0.006
var CHANNEL_W = 0.03, CHANNEL_H = 0.04, CHANNEL_INSET = 0.12

// the rig's grid axis (core/rigPose gridAxisCoords): count = floor(span/pitch)+1, spread edge-to-edge
function gridCoords(span, pitch) {
  var n = Math.max(1, Math.min(64, Math.floor(span / Math.max(pitch, 1e-4) + 1e-6) + 1))
  if (n === 1) return [0]
  var out = []
  for (var i = 0; i < n; i++) out.push(-span / 2 + (i * span) / (n - 1))
  return out
}
// the uprights along the width: the corner pair always, plus the auto-pole grid's (across the depth there are
// only ever the front and back rows)
function uprights(span, pitch, auto) {
  var out = [-span / 2, span / 2]
  if (auto) {
    var g = gridCoords(span, pitch)
    for (var i = 0; i < g.length; i++) {
      var dup = false
      for (var j = 0; j < out.length; j++) if (Math.abs(out[j] - g[i]) < 1e-4) dup = true
      if (!dup) out.push(g[i])
    }
  }
  return out.sort(function (a, b) { return a - b })
}
function num(v, d) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : d }

// location label (m): the plate, how far it stands off the beam face, how far its printing stands off the plate
var LABEL_W = 0.17, LABEL_H = 0.08, LABEL_T = 0.002, INK_T = 0.0006
// a seven-segment figure: segment boxes as [u0, v0, u1, v1] fractions of the glyph, and the segments per character
var SEG = { a: [0, 1, 1, 1], b: [1, 0.5, 1, 1], c: [1, 0, 1, 0.5], d: [0, 0, 1, 0], e: [0, 0, 0, 0.5], f: [0, 0.5, 0, 1], g: [0, 0.5, 1, 0.5] }
var GLYPH = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g' }
var GLYPH_W = 0.017, GLYPH_H = 0.038, STROKE = 0.0045, GLYPH_GAP = 0.006, BAR = 0.0016
// One label, centred at (x, y) on a beam face at z whose outward normal is s (-1 = the front, -Z face). Plate
// coordinates (u right, v up, both from the plate's lower-left corner, as its reader sees it) map to X through
// r: a reader facing the -Z face has -X on their right.
function label(plates, ink, x, y, z, s, code, seed) {
  var r = s
  var zp0 = s < 0 ? z - LABEL_T : z - SEAT, zp1 = s < 0 ? z + SEAT : z + LABEL_T
  var zi0 = s < 0 ? z - LABEL_T - INK_T : z + LABEL_T - SEAT, zi1 = s < 0 ? z - LABEL_T + SEAT : z + LABEL_T + INK_T
  var X = function (u) { return x + r * (u - LABEL_W / 2) }
  var Y = function (v) { return y + v - LABEL_H / 2 }
  var print = function (u0, v0, u1, v1) {
    var xa = X(u0), xb = X(u1)
    abox(ink, Math.min(xa, xb), Y(v0), zi0, Math.max(xa, xb), Y(v1), zi1)
  }
  abox(plates, x - LABEL_W / 2, Y(0), zp0, x + LABEL_W / 2, Y(LABEL_H), zp1)
  // the code, left-aligned
  var u = 0.01, v = (LABEL_H - GLYPH_H) / 2
  for (var c = 0; c < code.length; c++) {
    var segs = GLYPH[code.charAt(c)] || ''
    for (var q = 0; q < segs.length; q++) {
      var sg = SEG[segs.charAt(q)]
      // a segment is STROKE thick across whichever way it runs, and centred on its line
      var su0 = u + sg[0] * (GLYPH_W - STROKE), su1 = u + sg[2] * (GLYPH_W - STROKE) + STROKE
      var sv0 = v + sg[1] * (GLYPH_H - STROKE), sv1 = v + sg[3] * (GLYPH_H - STROKE) + STROKE
      print(su0, sv0, su1, sv1)
    }
    u += GLYPH_W + GLYPH_GAP
  }
  // the bar code: bars and gaps of one to three modules, from a per-slot sequence, filling the right of the plate
  var bu = u + 0.004, end = LABEL_W - 0.008, state = seed
  var next = function () { state = (state * 1103515245 + 12345) & 0x7fffffff; return state >> 16 }
  print(bu, 0.014, bu + BAR, LABEL_H - 0.014)
  bu += 2 * BAR
  while (bu < end - 2 * BAR) {
    var w = BAR * (1 + (next() % 3))
    if (bu + w > end - 2 * BAR) break
    print(bu, 0.014, bu + w, LABEL_H - 0.014)
    bu += w + BAR * (1 + (next() % 2))
  }
  print(end - BAR, 0.014, end, LABEL_H - 0.014)
}

definePart({
  manifest: {
    id: 'oip.rack',
    name: 'Rack',
    category: 'Structure',
    // AMBIENT FACE-FLUSH: dropped near a neighbour, the rack's footprint box lands flush against that
    // neighbour's nearest vertical face (90-degree-stepped, sliding along it plus the corner spots), so a row of
    // racking builds by dropping one beside the last - and compounds with Shift+drag duplicate into a whole aisle.
    // The RACK is the part this fits: ambient flush engages within 0.75 m, and a rack is 5.4 x 1.1, so the gate
    // is comfortably narrower than the part. Box (0.6 x 0.4) and pallet (1.22 x 1.02) do NOT get this - a box
    // dropped 0.7 m clear of another, obvious air to the eye, is still inside the gate and gets yanked flush,
    // so cargo does not opt in. Undeclared parts never flush ambiently; hold-B Face
    // mode is the explicit path for those.
    snap: { flush: true },
    // geometry()'s materials: the end-frame lacing, footplates and beam-end connectors (frameColor repaints them
    // live), the wire decking (shelfColor), and the hardware - bolts, nuts, washers, post caps and the uprights'
    // teardrop slots - in one dark untinted steel, which also prints the location labels on their plates (rackLabel).
    // FOUR draws however big the rack grows: geometry() submeshes pool by content (render/parts/sdk/rig.ts), so
    // identical racks share them rather than each adding a draw per extra rack against e2e/verify-draw-budget.mjs.
    // (The connectors are frame blue rather than beam orange to fit a three-material cap that pooling makes moot.)
    materials: [
      { id: 'rackFrame', color: FRAME_COLOR, ...FINISH },
      hardwareMaterial('rackHardware'),
      { id: 'rackDeck', color: SHELF_COLOR, metalness: 0.1, roughness: 0.6 },
      { id: 'rackLabel', color: [0.82, 0.82, 0.8], metalness: 0, roughness: 0.7 },
    ],
  },
  params: {
    // 'face' handles put resize dots in the viewport on that axis (clamped to the param's min/max);
    // bayParam/bayGateParam snap the width drag to whole poleInterval bays while auto-poles are on; the depth is
    // the frame's and resizes freely.
    length: { type: 'number', default: DEFAULT_LENGTH, min: 0.5, step: 0.1, label: 'Width (m)', handle: { kind: 'face', axis: 'x', bayParam: 'poleInterval', bayGateParam: 'enableAutoPoles' }, group: 'Size', desc: 'Rack width along local X, the run of bays. Drag the dot on either end face to resize in the viewport; while auto poles are on that drag snaps to whole bays, so the rack always ends on an upright.' },
    depth: { type: 'number', default: DEFAULT_DEPTH, min: 0.4, max: 4, step: 0.05, label: 'Depth (m)', handle: { kind: 'face', axis: 'z' }, group: 'Size', desc: 'Frame depth along local Z, front upright to back upright. Real frames are about 1.07 m (42 in), a little less than the pallet, so a 1.22 m (48 in) pallet overhangs each load beam. Drag the dot on either side face to resize in the viewport.' },
    numShelves: { type: 'number', default: DEFAULT_SHELVES, min: 1, max: 10, step: 1, label: 'Shelves', group: 'Size', desc: 'How many shelf levels sit above the floor. With the spacing below, this is what sets the total height.' },
    shelfSpacing: { type: 'number', default: DEFAULT_SPACING, min: 0.5, max: 3, step: 0.05, label: 'Shelf spacing (m)', group: 'Size', desc: 'Vertical gap between shelf levels. Leave room for the tallest load you mean to store, plus the truck reaching it.' },
    enableAutoPoles: { type: 'boolean', default: true, label: 'Auto poles', group: 'Size', desc: 'Stand an end frame at every bay along the width. Off leaves four corner posts only, which reads as a light shelving unit rather than pallet racking.' },
    poleInterval: { type: 'number', default: DEFAULT_BAY, min: 0.5, max: 4, step: 0.1, label: 'Bay width (m)', group: 'Size', desc: 'Centre-to-centre spacing of the end frames along the width: one bay. Real bays are 2.4-2.7 m (96-108 in), two pallets wide. This is also the step a viewport resize of the width snaps to.' },
    shelfColor: { type: 'color', default: '#8e939a', label: 'Shelf color', group: 'Colors', desc: 'Tint of the shelf decking.' },
    frameColor: { type: 'color', default: '#2e5c96', label: 'Frame color', group: 'Colors', desc: 'Tint of the uprights and the bracing between them.' },
    beamColor: { type: 'color', default: '#e86a1c', label: 'Beam color', group: 'Colors', desc: 'Tint of the load beams under each shelf.' },
    aisle: { type: 'string', default: '', label: 'Aisle sign', group: 'Labels', desc: 'Text on a sign across the top of each end frame, such as AISLE 03. Leave it empty for no sign.' },
    locationLabels: { type: 'boolean', default: true, label: 'Location labels', group: 'Labels', desc: 'A location label on the front and back load beam of every bay at every level: a bar code, the bay number and the level, the way a warehouse system names each slot.' },
  },
  rig(p) {
    return {
      links: [
        cornerPost(p, 'postLF', -1, -1),
        cornerPost(p, 'postLR', -1, 1),
        cornerPost(p, 'postRF', 1, -1),
        cornerPost(p, 'postRR', 1, 1),
        // Decorative infill (collision: 'none') so the grid's edge copies never double the collidable corner posts.
        // An end frame at every bay along X; across Z a pallet rack's frame is always TWO uprights, front and back,
        // so that axis is pitched by the depth itself (count = 2, at ±depth/2). Pitching both axes by poleInterval
        // would tie the bay to the frame depth and stand a middle row of uprights in any frame deeper than one bay.
        {
          name: 'poleGrid',
          shape: { kind: 'box', size: [UPRIGHT, frameHeight(p), UPRIGHT] },
          offset: [0, frameHeight(p) / 2, 0],
          color: FRAME_COLOR,
          colorParam: 'frameColor',
          ...FINISH,
          collision: 'none',
          array: {
            grid: {
              x: { sizeParam: 'length', pitchParam: 'poleInterval', size: DEFAULT_LENGTH, pitch: DEFAULT_BAY },
              z: { sizeParam: 'depth', pitchParam: 'depth', size: DEFAULT_DEPTH, pitch: DEFAULT_DEPTH },
            },
          },
          showParam: 'enableAutoPoles',
        },
        // Bottom floor left open: the base sits one pitch up, so shelf i lands at (i+1)×spacing. HIDDEN: the slab is
        // the cargo surface (and still solid to the walking pilot, render/parts/sdk/rig.ts), but what you SEE is
        // geometry()'s wire decking, whose top face is the slab's.
        {
          name: 'shelf',
          shape: { kind: 'box', size: [p.length, SHELF_T, p.depth] },
          offset: [0, p.shelfSpacing, 0],
          color: SHELF_COLOR,
          colorParam: 'shelfColor',
          ...FINISH,
          array: shelfArray(p),
          hidden: true,
        },
        beam(p, 'beamFront', -1),
        beam(p, 'beamBack', 1),
        aisleSign(p, 'aisleSignL', -1),
        aisleSign(p, 'aisleSignR', 1),
      ],
      joints: [],
      // static bounds, sized to the default rack
      bounds: { length: DEFAULT_LENGTH, width: DEFAULT_DEPTH, top: DEFAULT_TOP + OVER },
    }
  },
  geometry(g, p) {
    var length = num(p.length, DEFAULT_LENGTH), depth = num(p.depth, DEFAULT_DEPTH), pitch = num(p.poleInterval, DEFAULT_BAY)
    var levels = Math.round(num(p.numShelves, DEFAULT_SHELVES)), spacing = num(p.shelfSpacing, DEFAULT_SPACING)
    var height = levels * spacing
    var auto = p.enableAutoPoles !== false
    var xs = uprights(length, pitch, auto)
    var zs = [-depth / 2, depth / 2]
    var nx = xs.length, nz = zs.length, hf = UPRIGHT / 2
    var postTop = height + OVER
    var frame = mesh(g), hw = mesh(g)
    var i, k, j, sx

    // beam-end connectors: a plate on the front and back uprights' X faces at every beam level, on each side a
    // beam actually arrives from (a corner upright's outer face has none). Most of it hangs below the beam, where
    // its two bolts go; its top stops just under the beam's.
    var beamBottom = function (lv) { return (lv + 1) * spacing + BEAM_TOP - BEAM_H }
    var connTop = function (lv) { return (lv + 1) * spacing + BEAM_TOP - 0.003 }
    var connBottom = function (lv) { return beamBottom(lv) - CONN_DROP }
    var hasConn = function (ui, uk, side) { return (uk === 0 || uk === nz - 1) && (side > 0 ? ui < nx - 1 : ui > 0) }
    var onConn = function (y) {
      for (var lv = 0; lv < levels; lv++) if (y > connBottom(lv) - BOLT_AF / 2 && y < connTop(lv) + BOLT_AF / 2) return true
      return false
    }
    for (i = 0; i < nx; i++) {
      for (k = 0; k < nz; k += nz - 1) {
        for (sx = -1; sx <= 1; sx += 2) {
          if (!hasConn(i, k, sx)) continue
          var x0 = xs[i] + sx * (hf - SEAT), x1 = xs[i] + sx * (hf + CONN_T)
          for (j = 0; j < levels; j++) {
            abox(frame, Math.min(x0, x1), connBottom(j), zs[k] - CONN_W / 2, Math.max(x0, x1), connTop(j), zs[k] + CONN_W / 2)
            hex(hw, [x1, beamBottom(j) - 0.028, zs[k]], 0, sx, CONN_AF, CONN_BOLT_H)
            hex(hw, [x1, beamBottom(j) - 0.062, zs[k]], 0, sx, CONN_AF, CONN_BOLT_H)
          }
        }
      }
    }

    // the lacing, with a bolt through the upright at every joint: head on the +X face, nut and thread end on the
    // -X face, BOLT_IN in from the face the strut enters (side sz), started off a connector plate where one
    // covers the face. Joints two struts share get one bolt.
    var strut = function (x, za, ya, zb, yb2) {
      var dz = zb - za, dy = yb2 - ya
      var len = Math.sqrt(dz * dz + dy * dy)
      var uy = dy / len, uz = dz / len
      obox(frame, [x, (ya + yb2) / 2, (za + zb) / 2], [[0, uy * len / 2, uz * len / 2], [STRUT / 2, 0, 0], [0, uz * STRUT / 2, -uy * STRUT / 2]])
    }
    var joints = {}
    var bolt = function (ui, uk, sz, y) {
      var key = ui + ':' + uk + ':' + sz + ':' + y.toFixed(4)
      if (joints[key]) return
      joints[key] = true
      var z = zs[uk] + sz * (hf - BOLT_IN)
      var off = function (side) { return hasConn(ui, uk, side) && onConn(y) ? CONN_T : 0 }
      throughBolt(hw, [0, y, z], 0, xs[ui] - hf - off(-1), xs[ui] + hf + off(1), BOLT_AF)
    }
    var yb = LACE_BOTTOM, yt = postTop - LACE_TOP_GAP
    if (yt - yb >= STRUT * 4) {
      var panels = Math.max(1, Math.round((yt - yb) / LACE_PANEL))
      for (i = 0; i < nx; i++) {
        for (k = 0; k + 1 < nz; k++) {
          var za = zs[k] + hf - SINK, zb = zs[k + 1] - hf + SINK
          if (zb - za < STRUT + 2 * SINK) continue
          strut(xs[i], za, yb, zb, yb)
          strut(xs[i], za, yt, zb, yt)
          bolt(i, k, 1, yb); bolt(i, k + 1, -1, yb); bolt(i, k, 1, yt); bolt(i, k + 1, -1, yt)
          for (j = 0; j < panels; j++) {
            var y0 = yb + ((yt - yb) * j) / panels, y1 = yb + ((yt - yb) * (j + 1)) / panels
            if (j % 2 === 0) { strut(xs[i], za, y0, zb, y1); bolt(i, k, 1, y0); bolt(i, k + 1, -1, y1) }
            else { strut(xs[i], zb, y0, za, y1); bolt(i, k + 1, -1, y0); bolt(i, k, 1, y1) }
          }
        }
      }
    }

    // a footplate under every upright, clamped to the rack's outline, with an anchor (washer, nut, stud end) on
    // each side it runs out far enough past the upright to take one
    var xLo = -length / 2 - hf + 0.001, xHi = length / 2 + hf - 0.001
    var zLo = -depth / 2 - hf + 0.001, zHi = depth / 2 + hf - 0.001
    for (i = 0; i < nx; i++) {
      for (k = 0; k < nz; k++) {
        var px0 = Math.max(xLo, xs[i] - hf - PLATE_X), px1 = Math.min(xHi, xs[i] + hf + PLATE_X)
        var pz0 = Math.max(zLo, zs[k] - hf - PLATE_Z), pz1 = Math.min(zHi, zs[k] + hf + PLATE_Z)
        abox(frame, px0, 0, pz0, px1, PLATE_T, pz1)
        for (sx = -1; sx <= 1; sx += 2) {
          var run = sx > 0 ? px1 - (xs[i] + hf) : xs[i] - hf - px0
          if (run < ANCHOR_AF * 1.45) continue
          var ax = xs[i] + sx * (hf + run / 2)
          anchor(hw, ax, PLATE_T, zs[k], ANCHOR_AF)
        }
      }
    }

    // a cap on every post top, a hair wider than the upright so its sides stand clear of the upright's faces
    for (i = 0; i < nx; i++) for (k = 0; k < nz; k++) abox(hw, xs[i] - hf - 0.002, postTop - 0.02, zs[k] - hf - 0.002, xs[i] + hf + 0.002, postTop + 0.008, zs[k] + hf + 0.002)

    // LOCATION LABELS: one on the front and one on the back load beam of every bay, at every level, centred in the
    // bay on the beam's face - a plate carrying the slot's code (bay number, a dash, the level: 03-2) in seven-
    // segment figures, and a bar code. Bays count from the -X end on both faces, so a slot has ONE number
    // whichever aisle you read it from; the text runs left to right for the reader on each face. The plate is
    // its own submesh; the printing is the hardware's dark steel and rides its submesh, drawn BEFORE the teardrops
    // so the slots coarsen to make room on a huge rack rather than a label losing its figures. (A submesh of its
    // own would be a fifth draw for every rack of a different size, which verify-draw-budget holds to four.)
    var plates = null
    if (p.locationLabels !== false && nx > 1) {
      plates = mesh(g)
      for (i = 0; i + 1 < nx; i++) {
        if (xs[i + 1] - xs[i] - UPRIGHT < LABEL_W + 0.04) continue
        var bx = (xs[i] + xs[i + 1]) / 2
        for (j = 0; j < levels; j++) {
          var code = (i + 1 < 10 ? '0' : '') + (i + 1) + '-' + ((j + 1) % 10)
          var ly = (j + 1) * spacing + BEAM_TOP - BEAM_H / 2
          label(plates, hw, bx, ly, zs[0] - BEAM_T / 2, -1, code, i * 31 + j * 7 + 1)
          label(plates, hw, bx, ly, zs[nz - 1] + BEAM_T / 2, 1, code, i * 31 + j * 7 + 17)
        }
      }
    }

    // two columns of teardrops down every upright's aisle face (the front row's -Z face, the back row's +Z)
    // the slots go in last and take what the hardware budget has left, coarsening their pitch evenly rather than
    // running out part-way up the rack
    var slotPitch = SLOT_PITCH, faces = nx * 2
    while (faces * 2 * Math.floor((postTop - 0.05) / slotPitch) * 5 > VERT_CAP - hw.n && slotPitch < 1) slotPitch *= 1.25
    var rows = Math.floor((postTop - 0.05 - SLOT_H / 2) / slotPitch)
    for (i = 0; i < nx; i++) {
      for (k = 0; k < nz; k += nz - 1) {
        var s = k === 0 ? -1 : 1, fz = zs[k] + s * (hf + PROUD)
        for (j = 1; j <= rows; j++) {
          teardrop(hw, xs[i] - (hf - SLOT_INSET), j * slotPitch, fz, s, SLOT_W, SLOT_H)
          teardrop(hw, xs[i] + (hf - SLOT_INSET), j * slotPitch, fz, s, SLOT_W, SLOT_H)
        }
      }
    }

    // wire decking on every level: one set of panels per bay between neighbouring uprights, spanning beam to beam
    // (its wire ends and channels run a hair into the beams' inner faces). Its wire pitch coarsens rather than
    // lose levels if a huge rack would pass VERT_CAP.
    var dz0 = zs[0] + BEAM_T / 2 - 0.002, dz1 = zs[nz - 1] - BEAM_T / 2 + 0.002
    var panelsOf = function (a, b) {
      var n = Math.max(1, Math.ceil((b - a) / DECK_PANEL)), w = (b - a - (n - 1) * DECK_GAP) / n, out = []
      for (var q = 0; q < n; q++) out.push([a + q * (w + DECK_GAP), a + q * (w + DECK_GAP) + w])
      return out
    }
    var bays = []
    for (i = 0; i + 1 < nx; i++) {
      var ps = panelsOf(xs[i] + hf + UPRIGHT_GAP, xs[i + 1] - hf - UPRIGHT_GAP)
      for (var q = 0; q < ps.length; q++) if (ps[q][1] - ps[q][0] > WIRE * 4) bays.push(ps[q])
    }
    var wirePitch = WIRE_PITCH
    if (dz1 - dz0 > WIRE * 4 && bays.length) {
      var boxes = function (pt) {
        var n = 0
        for (var b = 0; b < bays.length; b++) n += Math.round((bays[b][1] - bays[b][0]) / pt) + 1 + Math.round((dz1 - dz0) / pt) + 1 + 3
        return n * levels
      }
      while (boxes(wirePitch) * 24 > VERT_CAP && wirePitch < 1) wirePitch *= 1.25
      var deck = mesh(g)
      var ticks = function (a, b) {
        var n = Math.max(1, Math.round((b - a) / wirePitch)), out = []
        for (var t = 0; t <= n; t++) out.push(a + WIRE / 2 + ((b - a - WIRE) * t) / n)
        return out
      }
      var zt = ticks(dz0 + 0.002, dz1 - 0.002)
      for (j = 0; j < levels; j++) {
        var top = (j + 1) * spacing + DECK_TOP
        for (var b = 0; b < bays.length; b++) {
          var bx0 = bays[b][0], bx1 = bays[b][1], xt = ticks(bx0, bx1)
          // the top layer runs along X, the layer under it along Z (seated a hair into the top one), then the channels
          for (k = 0; k < zt.length; k++) abox(deck, bx0, top - WIRE, zt[k] - WIRE / 2, bx1, top, zt[k] + WIRE / 2)
          for (k = 0; k < xt.length; k++) abox(deck, xt[k] - WIRE / 2, top - 2 * WIRE, dz0, xt[k] + WIRE / 2, top - WIRE + SEAT, dz1)
          var cx = bx1 - bx0 > 3 * CHANNEL_INSET ? [bx0 + CHANNEL_INSET, (bx0 + bx1) / 2, bx1 - CHANNEL_INSET] : [(bx0 + bx1) / 2]
          for (k = 0; k < cx.length; k++) abox(deck, cx[k] - CHANNEL_W / 2, top - 2 * WIRE - CHANNEL_H, dz0, cx[k] + CHANNEL_W / 2, top - 2 * WIRE + SEAT, dz1)
        }
      }
    }

    return emitMeshes([
      { mesh: frame, material: 'rackFrame', colorParam: 'frameColor' },
      { mesh: hw, material: 'rackHardware' },
      { mesh: deck, material: 'rackDeck', colorParam: 'shelfColor' },
      { mesh: plates, material: 'rackLabel' },
    ])
  },
  react() {},
})
