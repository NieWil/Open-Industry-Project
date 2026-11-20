// Platform — an elevated walkway/storage deck. Purely structural: its length/width/height params
// drive a deck (steel tread plate or a solid deck: deckSurface), a steel column/beam frame and a perimeter safety railing
// (parametric geometry + per-link steel colour), and the step does nothing. showSupports adds the OSHA
// middle-column grid + under-deck beams (off → a bare table on 4 corner legs); showRailings toggles the whole
// perimeter railing (the links' showParam).
//
// geometry() adds what makes the frame read as bolted steel, which a rig can't place because it all sits at
// the columns, and the column grid moves with length, width and showSupports: four anchors on every base
// plate; a shear tab bolted through the beam web on each side of a column a beam runs from; and a knee brace
// from each perimeter column up to the beam beside it, bolted at both ends. The railing gets none of it on
// purpose: a stair landing cuts openings into it (core/structureCuts.ts), which geometry() never sees, so
// hardware there would float in the gap. Render-only; the columns and deck collide.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { hardwareMaterial, SEAT, VERT_CAP, mesh, abox, member, throughBolt, anchor, emitMeshes } from '../_shared/hardware.js'

// the rig's constants; geometry() draws with some of them too
var STEEL = [0.949, 0.741, 0.059] // #f2bd0f
var DECK = 0.006 // deck thickness - thin plate or panel carried by the beam grid
var COL = 0.1 // column cross-section
var COL_SPAN = 2.4 // max column spacing (OSHA 8 ft)
var RAIL_TOP = 1.07 // railing height (42 in)
var RAIL_MID = 0.54 // mid-rail height (21 in)
var TOE_H = 0.1 // toe-board height (4 in)
var TOE_T = 0.02 // toe-board thickness
var POST = 0.04 // post cross-section
var POST_CAP = 0.005 // a post's top stands this far over the top rail, so no rail arriving at it pokes over it
var RAIL = 0.032 // rail cross-section
var POST_SPAN = 2.4 // max post spacing (OSHA 8 ft)
var POST_H = RAIL_TOP + RAIL / 2 + POST_CAP // post height: floor to just over the top rail's top face
var BEAM_H = 0.15 // under-deck support beam height
var BEAM_T = 0.006
var PLATE = COL * 2 // column base-plate footprint (0.2)
var PLATE_T = 0.008
var WALL_T = 0.06 // hidden railing-collision wall thickness
var NUDGE = POST / 2 // each railing edge is nudged outward by half a post so it sits on the deck edge
// ...so each edge's railing runs 2 x NUDGE past the deck's own length to reach the CORNER, where the two edges'
// lines cross: both edges' end posts land on the one corner point (coincident, so one post shows, and an edge a
// stair opens near the corner still leaves the other edge's), and each rail, toe board and wall runs a further
// half its own section on so the two meet without a notch at the outside corner. Run only to the deck length,
// every corner showed two posts side by side and two rails stopping short of each other.
var CORNER = 2 * NUDGE
var BEAM_Y = -DECK - BEAM_H / 2 // under-deck beam centre y
// ANCHOR_IN: an anchor's offset from the plate centre along X and Z. TAB_*: a shear tab's run past the column
// face, height, thickness. BOLT_AF: a hex's across-flats. KNEE: the brace's reach along the beam (it drops the
// same amount down the column, so 45 degrees), shortened on a low deck or a short span; KNEE_T its section.
var ANCHOR_IN = 0.07, ANCHOR_AF = 0.022, TAB_RUN = 0.075, TAB_H = 0.11, TAB_T = 0.008, BOLT_AF = 0.018
var KNEE = 0.6, KNEE_T = 0.05, KNEE_MIN = 0.2

// ---- the rig's links ----
var STEEL_LINK = { color: STEEL, colorParam: 'color' } // per-link steel colour
function supportGrid() {
  return { grid: { x: { sizeParam: 'length', maxSpacing: COL_SPAN, size: 4 }, z: { sizeParam: 'width', maxSpacing: COL_SPAN, size: 4 } } }
}
var side = function (s, pos, neg) { return s > 0 ? pos : neg }
// support columns: 4 corners (always, colliding) + a param-gated OSHA grid of middle columns (decorative). A
// column runs deck top to floor (height − deck), centred at −(height+deck)/2.
function cornerColumn(p, sx, sz) {
  return { name: 'col' + side(sx, 'R', 'L') + side(sz, 'R', 'F'), shape: { kind: 'box', size: [COL, p.height - DECK, COL] }, offset: [sx * p.length / 2, -p.height / 2 - DECK / 2, sz * p.width / 2], ...STEEL_LINK }
}
// a base plate on the floor (−height)
function cornerPlate(p, sx, sz) {
  return { name: 'plate' + side(sx, 'R', 'L') + side(sz, 'R', 'F'), shape: { kind: 'box', size: [PLATE, PLATE_T, PLATE] }, offset: [sx * p.length / 2, -p.height + PLATE_T / 2, sz * p.width / 2], ...STEEL_LINK, collision: 'none' }
}
function perimBeamX(p, sz) {
  return { name: 'beamX' + side(sz, 'P', 'N'), shape: { kind: 'box', size: [p.length, BEAM_H, BEAM_T] }, offset: [0, BEAM_Y, sz * p.width / 2], ...STEEL_LINK, collision: 'none' }
}
function perimBeamZ(p, sx) {
  return { name: 'beamZ' + side(sx, 'P', 'N'), shape: { kind: 'box', size: [BEAM_T, BEAM_H, p.width] }, offset: [sx * p.length / 2, BEAM_Y, 0], ...STEEL_LINK, collision: 'none' }
}
// perimeter railing - one edge per side: posts + a top rail + a mid rail + a toe board (all decorative), plus
// a hidden full-height wall (mesh hidden, body built) doing the collision.
var RAIL_GATE = { showParam: 'showRailings' } // the railing toggle, on every railing link
var POST_GATE_Z = { distribute: { axis: 2, spanParam: 'width', spanAdd: CORNER, maxSpacing: POST_SPAN } }
var POST_GATE_X = { distribute: { axis: 0, spanParam: 'length', spanAdd: CORNER, maxSpacing: POST_SPAN } }
// ±X edges (fixed x = ±length/2, nudged out; they run along Z: the deck's width + CORNER + the member's own
// section). `onEdge` tags each perimeter link with the deck edge it runs on - the declarative marker a neighbour
// that opens the edge (a stair's edgeMount) cuts it by, never link names.
function edgeX(p, sx) {
  var tag = side(sx, 'XP', 'XN'), onEdge = side(sx, 'posX', 'negX')
  var x = sx * (p.length / 2 + NUDGE), run = function (sec) { return p.width + CORNER + sec }
  return [
    { name: 'post' + tag, onEdge, shape: { kind: 'box', size: [POST, POST_H, POST] }, offset: [x, POST_H / 2, 0], ...STEEL_LINK, collision: 'none', array: POST_GATE_Z, ...RAIL_GATE },
    { name: 'railTop' + tag, onEdge, shape: { kind: 'box', size: [RAIL, RAIL, run(RAIL)] }, offset: [x, RAIL_TOP, 0], ...STEEL_LINK, collision: 'none', ...RAIL_GATE },
    { name: 'railMid' + tag, onEdge, shape: { kind: 'box', size: [RAIL, RAIL, run(RAIL)] }, offset: [x, RAIL_MID, 0], ...STEEL_LINK, collision: 'none', ...RAIL_GATE },
    { name: 'toe' + tag, onEdge, shape: { kind: 'box', size: [TOE_T, TOE_H, run(TOE_T)] }, offset: [x, TOE_H / 2, 0], ...STEEL_LINK, collision: 'none', ...RAIL_GATE },
    { name: 'wall' + tag, onEdge, shape: { kind: 'box', size: [WALL_T, RAIL_TOP, run(WALL_T)] }, offset: [x, RAIL_TOP / 2, 0], hidden: true, ...RAIL_GATE },
  ]
}
// ±Z edges (fixed z = ±width/2, nudged out; they run along X)
function edgeZ(p, sz) {
  var tag = side(sz, 'ZP', 'ZN'), onEdge = side(sz, 'posZ', 'negZ')
  var z = sz * (p.width / 2 + NUDGE), run = function (sec) { return p.length + CORNER + sec }
  return [
    { name: 'post' + tag, onEdge, shape: { kind: 'box', size: [POST, POST_H, POST] }, offset: [0, POST_H / 2, z], ...STEEL_LINK, collision: 'none', array: POST_GATE_X, ...RAIL_GATE },
    { name: 'railTop' + tag, onEdge, shape: { kind: 'box', size: [run(RAIL), RAIL, RAIL] }, offset: [0, RAIL_TOP, z], ...STEEL_LINK, collision: 'none', ...RAIL_GATE },
    { name: 'railMid' + tag, onEdge, shape: { kind: 'box', size: [run(RAIL), RAIL, RAIL] }, offset: [0, RAIL_MID, z], ...STEEL_LINK, collision: 'none', ...RAIL_GATE },
    { name: 'toe' + tag, onEdge, shape: { kind: 'box', size: [run(TOE_T), TOE_H, TOE_T] }, offset: [0, TOE_H / 2, z], ...STEEL_LINK, collision: 'none', ...RAIL_GATE },
    { name: 'wall' + tag, onEdge, shape: { kind: 'box', size: [run(WALL_T), RAIL_TOP, WALL_T] }, offset: [0, RAIL_TOP / 2, z], hidden: true, ...RAIL_GATE },
  ]
}

// the rig's grid coordinates along one axis (core/rigPose: maxSpacing = every gap <= COL_SPAN, spread edge to
// edge), or just the two corners without the middle supports
function columnsAlong(span, supports) {
  if (!supports) return [-span / 2, span / 2]
  var n = Math.max(1, Math.min(63, Math.ceil(span / COL_SPAN))), out = []
  for (var i = 0; i <= n; i++) out.push(-span / 2 + (i * span) / n)
  return out
}
function num(v, d) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : d }

definePart({
  manifest: {
    id: 'oip.platform',
    name: 'Platform',
    category: 'Structure',
    // The deck advertises a 'deck' snap surface: a Stairs flight seats its top against a deck edge and sizes
    // itself to heightParam (the deck's elevation above its own floor).
    // 'tile' is the deck-to-deck half (docs/part-snap-edges.md): two platforms of the SAME height tile
    // edge-to-edge, orientation in 90-degree steps of the target, sliding along the shared edge - the structural
    // twin of the floor marking's tiling, and what lets a big mezzanine be built out of several decks. Decks of
    // DIFFERENT height refuse (the snap height gate), which is the documented stepping-mezzanine non-goal.
    snap: {
      surfaces: [{ kind: 'deck', lengthParam: 'length', widthParam: 'width', heightParam: 'height' }],
      tile: { group: 'platformDeck', lengthParam: 'length', widthParam: 'width' },
    },
    // geometry()'s materials: the steel it adds (shear tabs, knee braces) under the same colour param as the frame,
    // and the shared dark hardware. Two submeshes per platform, on top of the deck's one, keeps an extra copy
    // within e2e/verify-draw-budget.mjs's 3 draws.
    materials: [{ id: 'platformSteel', color: STEEL, metalness: 0.2, roughness: 0.5 }, hardwareMaterial('platformHardware')],
  },
  params: {
    // 'face' handles put resize dots in the viewport on that axis (clamped to the param's min/max); the host
    // reflows the deck/frame/railing parametrically.
    length: { type: 'number', default: 4, min: 0.5, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, desc: 'Deck extent along local X. Drag the dot on either end face to resize in the viewport; the frame, railing and columns reflow to match.' },
    width: { type: 'number', default: 4, min: 0.5, max: 20, step: 0.1, label: 'Width (m)', handle: { kind: 'face', axis: 'z' }, desc: 'Deck extent along local Z. Drag the dot on either side face to resize in the viewport.' },
    // deck elevation above the floor — drives the column length. The origin is the deck TOP (the columns hang
    // below it), so rest:'surfaceBelow' makes the host stand the origin `height` above whatever surface is
    // beneath at drop/snap/translate: the columns always reach the floor, and dragging the platform up regrows
    // them.
    height: { type: 'number', default: 2, min: 0.3, max: 8, step: 0.05, rest: 'surfaceBelow', label: 'Height (m)', desc: 'Height of the deck top above whatever it stands on, which is also the column length. The origin is the deck top, so raising the platform regrows the columns to reach the floor rather than leaving them hanging.' },
    // the deck link's finishParam: each option value IS a rig finish. An access platform is walked on (tread
    // plate); one carrying conveyors or machines has a solid deck that takes the load and stops small items
    // falling through. Only the look changes: the deck collides and seats parts the same either way.
    deckSurface: { type: 'enum', default: 'tread', options: [{ value: 'tread', label: 'Tread plate' }, { value: 'deck', label: 'Solid deck' }], label: 'Deck surface', desc: 'What the deck is made of. Tread plate is the steel walking surface of an access platform; a solid deck is what an equipment platform carrying conveyors or machines has. Only the look changes.' },
    color: { type: 'color', default: '#f2bd0f', label: 'Steel color', desc: 'Steel tint of the frame, columns and railing.' },
    showRailings: { type: 'boolean', default: true, label: 'Perimeter railing', desc: 'Guard railing around the deck edge. Turning it off removes the barrier a walking pilot leans on, not just the visual.' },
    showSupports: { type: 'boolean', default: true, label: 'Middle supports', desc: 'Interior columns under a large deck, in addition to the corner ones. Cosmetic on a small platform, which the corners already carry.' },
  },
  rig(p) {
    return {
      links: [
        // the standing deck, top face at the part origin (the walking/cargo surface). Its look is the deckSurface
        // param's choice; `finish` is what shows if that ever holds something else.
        { name: 'deck', shape: { kind: 'box', size: [p.length, DECK, p.width] }, offset: [0, -DECK / 2, 0], finish: 'tread', finishParam: 'deckSurface', notchable: true },
        cornerColumn(p, -1, -1), cornerColumn(p, -1, 1), cornerColumn(p, 1, -1), cornerColumn(p, 1, 1),
        { name: 'columnGrid', shape: { kind: 'box', size: [COL, p.height - DECK, COL] }, offset: [0, -p.height / 2 - DECK / 2, 0], ...STEEL_LINK, collision: 'none', array: supportGrid(), showParam: 'showSupports' },
        cornerPlate(p, -1, -1), cornerPlate(p, -1, 1), cornerPlate(p, 1, -1), cornerPlate(p, 1, 1),
        { name: 'plateGrid', shape: { kind: 'box', size: [PLATE, PLATE_T, PLATE] }, offset: [0, -p.height + PLATE_T / 2, 0], ...STEEL_LINK, collision: 'none', array: supportGrid(), showParam: 'showSupports' },
        perimBeamX(p, -1), perimBeamX(p, 1), perimBeamZ(p, -1), perimBeamZ(p, 1),
        { name: 'beamGridX', shape: { kind: 'box', size: [p.length, BEAM_H, BEAM_T] }, offset: [0, BEAM_Y, 0], ...STEEL_LINK, collision: 'none', array: { distribute: { axis: 2, spanParam: 'width', maxSpacing: COL_SPAN } }, showParam: 'showSupports' },
        { name: 'beamGridZ', shape: { kind: 'box', size: [BEAM_T, BEAM_H, p.width] }, offset: [0, BEAM_Y, 0], ...STEEL_LINK, collision: 'none', array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: COL_SPAN } }, showParam: 'showSupports' },
        ...edgeX(p, -1), ...edgeX(p, 1), ...edgeZ(p, -1), ...edgeZ(p, 1),
      ],
      joints: [],
      bounds: { length: 4, width: 4, top: RAIL_TOP },
    }
  },
  geometry(g, p) {
    var length = num(p.length, 4), width = num(p.width, 4), height = num(p.height, 2)
    var supports = p.showSupports !== false
    var xs = columnsAlong(length, supports), zs = columnsAlong(width, supports)
    var floor = -height, beamTop = -DECK, beamBot = -DECK - BEAM_H, beamMid = (beamTop + beamBot) / 2
    var steel = mesh(g), hw = mesh(g)
    var i, k, d

    // anchors: four per base plate, one near each corner
    for (i = 0; i < xs.length; i++) for (k = 0; k < zs.length; k++)
      for (var ax = -1; ax <= 1; ax += 2) for (var az = -1; az <= 1; az += 2) anchor(hw, xs[i] + ax * ANCHOR_IN, floor + PLATE_T, zs[k] + az * ANCHOR_IN, ANCHOR_AF)

    // knee braces on the perimeter frame: from the column face KNEE down, up to the beam's underside KNEE along
    // it, in the beam's plane; each end runs a hair on into what it meets, and is bolted through
    var gap = function (list) { var m = 1e9; for (var q = 0; q + 1 < list.length; q++) m = Math.min(m, list[q + 1] - list[q]); return m }
    var knee = Math.min(KNEE, (height - DECK - BEAM_H) * 0.35, (Math.min(gap(xs), gap(zs)) - COL) / 2 - TAB_RUN)
    if (knee >= KNEE_MIN) {
      var brace = function (c, along, dir, plane) {
        var n = along === 0 ? 2 : 0
        var a = [0, beamBot - knee, 0], b = [0, beamBot, 0]
        a[along] = c + dir * COL / 2; b[along] = c + dir * (COL / 2 + knee)
        a[n] = plane; b[n] = plane
        var e = KNEE_T / 2 / (Math.sqrt(2) * knee)
        member(steel, [a[0] - (b[0] - a[0]) * e, a[1] - (b[1] - a[1]) * e, a[2] - (b[2] - a[2]) * e], [b[0] + (b[0] - a[0]) * e, b[1] + (b[1] - a[1]) * e, b[2] + (b[2] - a[2]) * e], KNEE_T)
        for (var t = 0; t < 2; t++) {
          var f = t === 0 ? 0.12 : 0.88
          throughBolt(hw, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], n, plane - KNEE_T / 2, plane + KNEE_T / 2, BOLT_AF * 0.85)
        }
      }
      var zEdge = [zs[0], zs[zs.length - 1]], xEdge = [xs[0], xs[xs.length - 1]]
      for (i = 0; i < xs.length; i++) for (var e1 = 0; e1 < 2; e1++) for (d = -1; d <= 1; d += 2)
        if ((d < 0 && i > 0) || (d > 0 && i < xs.length - 1)) brace(xs[i], 0, d, zEdge[e1])
      for (k = 0; k < zs.length; k++) for (var e2 = 0; e2 < 2; e2++) for (d = -1; d <= 1; d += 2)
        if ((d < 0 && k > 0) || (d > 0 && k < zs.length - 1)) brace(zs[k], 2, d, xEdge[e2])
    }


    // shear tabs: at every column, on each side a beam leaves from, along X (the beam at this z) and along Z (the
    // beam at this x). The tab sits on one face of the web; two bolts go through tab and web - one, or none, if a
    // big deck's column grid would run the hardware out of budget (these are under the deck; the braces come first).
    //   c: the column's coordinate along the beam; along: 0 = the beam runs along X (web normal Z), 2 = along Z;
    //   dir: which way the beam leaves; web: the web's centre on its normal axis; out: the face the tab is on
    var tab = function (c, along, dir, web, out) {
      var n = along === 0 ? 2 : 0
      var f0 = web + out * (BEAM_T / 2 - SEAT), f1 = web + out * (BEAM_T / 2 + TAB_T)
      var a0 = c + dir * (COL / 2 - SEAT), a1 = c + dir * (COL / 2 + TAB_RUN)
      var lo = [0, beamMid - TAB_H / 2, 0], hi = [0, beamMid + TAB_H / 2, 0]
      lo[along] = Math.min(a0, a1); hi[along] = Math.max(a0, a1)
      lo[n] = Math.min(f0, f1); hi[n] = Math.max(f0, f1)
      abox(steel, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2])
      var back = web - out * BEAM_T / 2
      for (var yy = 0; yy < tabBolts; yy++) {
        var pt = [0, beamMid + (tabBolts === 1 ? 0 : (yy * 2 - 1) * TAB_H * 0.27), 0]
        pt[along] = c + dir * (COL / 2 + TAB_RUN / 2)
        throughBolt(hw, pt, n, Math.min(back, f1), Math.max(back, f1), BOLT_AF)
      }
    }
    // each column has a tab per beam side: 2 per axis, less one at each end of the axis
    var tabCount = (2 * xs.length - 2) * zs.length + (2 * zs.length - 2) * xs.length
    var tabBolts = 2
    while (tabBolts > 0 && tabCount * tabBolts * 3 * 31 > VERT_CAP - hw.n) tabBolts--
    for (i = 0; i < xs.length; i++) {
      for (k = 0; k < zs.length; k++) {
        // a perimeter web gets its tab on the inside face, where it's seen from under the deck; a grid web on +
        var outZ = k === zs.length - 1 ? -1 : 1
        var outX = i === xs.length - 1 ? -1 : 1
        for (d = -1; d <= 1; d += 2) {
          if ((d < 0 && i > 0) || (d > 0 && i < xs.length - 1)) tab(xs[i], 0, d, zs[k], outZ)
          if ((d < 0 && k > 0) || (d > 0 && k < zs.length - 1)) tab(zs[k], 2, d, xs[i], outX)
        }
      }
    }

    return emitMeshes([
      { mesh: steel, material: 'platformSteel', colorParam: 'color' },
      { mesh: hw, material: 'platformHardware' },
    ])
  },
  react() {},
})
