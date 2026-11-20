// Stairs — an industrial access flight. Demonstrates array links + parametric geometry + a
// constant-slope rotation: 'numSteps' closed-riser steps rise up-and-forward by a constant rise/run (a
// diagonal array `step`), carried by two sloped side stringers, with a full stair rail — sloped top, hand & mid rails,
// a bottom newel and posts about every metre and a half — that showHandrails toggles off. Invisible guard colliders line
// both open sides (slope + landing) so a walker can't step off. Two-tone: tread-plate treads/risers you
// walk on (the treads collide), steel structure tinted by `color`. Purely structural — the params reshape the
// rig, the step does nothing.
//
// geometry() details it as the steel stair it is (tread-plate treads, closed risers): a steel nosing angle
// along every tread's front edge, whatever the handrail setting; and, with the handrails, the intermediate posts
// (below), two bolt heads on each stringer where every tread is clipped to it, and each post bolted through
// the stringer. Nothing on the top landing: a deck connection drops the landing (dropWhenMounted), which geometry()
// can't see, so hardware there would float. Everything rides the 'railFrame' link, so a snapped stair's
// lift carries it with the flight. No floor anchors: the foot links stretch down to the floor under that lift
// (anchor: 'floor'), which geometry() can't see, so a plate at the foot would float. Render-only.
//
// The flight, as the rig lays it out:
//   - standard 0.178 rise / 0.28 tread → the run/rise follow a `numSteps` count (array `step` is a constant
//     diagonal) rather than independent length/height params. The slope is therefore a fixed angle
//     atan2(rise, run), so the stringers + rails are a static-quat rotation whose length (and centre) track
//     numSteps linearly - the one shape a param-driven angle couldn't express.
//   - two-tone: treads/risers/landing are steel tread plate (finish:'tread' → the rig DeckSurface),
//     the steel structure (stringers/posts/rails/newel) tints with `color`.
//   - top landing: a fixed-depth flat plate + its flat handrail continuation, for a freestanding flight. Snapped
//     to a platform, the flight's TOP meets the deck edge and the deck is the landing: every landing link is
//     `dropWhenMounted`, the deck connection lifts the flight flush, and the sloped rails end on the posts the
//     platform frames its railing gap with.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { hardwareMaterial, SEAT, mesh, abox, hex, anchor, emitMeshes } from '../_shared/hardware.js'

// derived constants at 8 decimals (near-zero to 0), so the manifest's numbers and refs stay exact
function r8(n) { return Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8) }

var STEEL = [0.949, 0.741, 0.059] // #f2bd0f (fallback; the `color` param drives the real sRGB→linear tint)
var RISE = 0.178 // standard rise (m) - 7 in, the building-code maximum (STAIRS_STANDARD_RISE)
var TREAD = 0.28 // standard tread run (m) - 11 in, the building-code minimum (STAIRS_STANDARD_TREAD)
var THICK = 0.005 // tread plate thickness
var NOSING = 0.025 // tread nose overhang DOWN-flight past the riser below
var DEPTH = TREAD + NOSING // tread depth (run + the nosing)
var RISER_T = 0.03 // closed-riser plate thickness (local X)
var WIDTH0 = 1.2 // default width (static fallback for a sparse instance)
var DEFAULT_STEPS = 11

// the fixed flight slope (a constant rise/run → a static rotation the stringers/rails share)
var DIAG = Math.hypot(TREAD, RISE) // per-step distance along the slope
var ANG = Math.atan2(RISE, TREAD) // slope angle above horizontal
var SIN = Math.sin(ANG)
var COS = Math.cos(ANG)
// a quaternion rotating local +X up the slope (about +Z by ANG) - treats the box's length axis as the rail line
var SLOPE_Q = [0, 0, r8(Math.sin(ANG / 2)), r8(Math.cos(ANG / 2))]

// steel section sizes
var STRINGER_H = 0.25 // side skirt beam height
var STRINGER_W = 0.012 // side skirt beam thickness (local Z)
var POST = 0.04 // handrail post cross-section
var NEWEL = r8(POST * 1.2) // thicker bottom newel post; the handrail's bottom bend ends on its inner face
var RAIL = 0.032 // top rail cross-section: the platform railing's, so the two meet at one size
// the handrail you grip: round tube (1-1/2 in, 38 mm outside: inside the 1.25-2 in a graspable round rail runs, and
// narrower than the 40 mm post its ends weld to), on brackets INSIDE the post line so a sliding hand clears every
// post by OSHA 1910.29(f)'s 2.25 in. Square bar on the post line (as the other rails are) is neither graspable nor
// clear: a hand running up it met each post.
var HR_R = 0.019 // handrail tube radius
var HR_CLEAR = 0.06 // clear gap, post inner face -> handrail surface
var BEND_R = 0.05 // centreline radius of the handrail's two bends (newel end, top end)
// a post's top stands this far above the top rail it carries, so a rail meeting it never pokes over it (the stair's
// sloped top rail, arriving at a slope, rises a few mm above the post's top at its end face otherwise)
var POST_CAP = 0.005
var MIDRAIL = 0.032 // mid rail cross-section
var HRAIL_H = 1.07 // top rail height above the tread nosing line: 42 in, OSHA 1910.29(f)'s stair rail minimum
var HAND_H = 0.91 // handrail TOP above the nosing line: 36 in, inside OSHA 1910.29(f)'s 30-38 in band
var MRAIL_H = 0.54 // mid-rail height
var NEWEL_H = r8(HRAIL_H + 0.05) // newel spans floor → the rail line + a 0.05 cap; our rail is the NOSING
// line, which passes (0, HRAIL_H) at the newel
var SIDE_Z = STRINGER_W / 2 // the stringers (and their skirts) sit just OUTSIDE the tread width (± this past ±width/2)
// the POST LINE: posts, newels and the top and mid rails stand ON the tread edge. A platform frames the railing gap it
// opens for a flight at the flight's width, so its gap posts stand there too, and the flight's rails run square into
// them; on the stringer line, 6 mm out, each top rail sat off-centre on its gap post, proud of the post's outer face.
var POST_Z = 0
// the handrail centre's offset from the tread edge (±width/2 + this; negative = inward): a post half-width, the
// clearance and the pipe radius inside the post line
var HR_Z = r8(POST_Z - POST / 2 - HR_CLEAR - HR_R)

// The stringer band is a slope-rotated box (see rig()). Its foot is trimmed along the slope by H·tan(ANG), and it
// hangs STRINGER_DROP (vertically) below the riser-base line.
var STRINGER_TRIM = r8(STRINGER_H * RISE / TREAD) // foot trim along the slope = H·tan(ANG)
var STRINGER_DROP = 0.05
var FOOT_LEN = r8(SIN * STRINGER_H) // the trim's x-extent (= the perpendicular cut's lean-back)
var FOOT_H = r8(STRINGER_H / COS - STRINGER_DROP) // the band's top edge's height at x=0 (its vertical thickness, less the drop)
var HEAD_TOP = r8(STRINGER_H / COS - STRINGER_DROP - FOOT_LEN * RISE / TREAD) // the stringer head's cut, over the top tread
var HEAD_H = r8(HEAD_TOP + STRINGER_DROP)

// ---- handrail posts (steel) - intermediate posts between the newel and the landing post, both sides --------
// Industrial stair rail carries a post every metre or so, not one per tread (a post per step read as a baby
// gate). The spacing isn't a linear function of numSteps, so no array link can place them: geometry() does, on
// the tread nearest each even division of the run. Standing on the tread's surface at
// mid-tread, topping out on the sloped rail line. The RAIL LINE runs through the tread NOSING corners + HRAIL_H
// - the line through ((i+1)·TREAD, (i+1)·RISE + h), which passes through the landing start (numSteps·TREAD,
// numSteps·RISE + h) EXACTLY, so the sloped rail SHARES its top endpoint with the flat landing rail. A post at
// mid-tread meets that line at (i+1)·RISE + h − RISE/2, so the posts are HRAIL_H − RISE/2 tall.
var POST_H = r8(HRAIL_H - RISE / 2) // post height: tread top → the nosing-line rail
var POST_MAX_RUN = 1.4 // max horizontal run between posts (newel → posts → landing post)

// ---- handrail (steel tube) - drawn by geometry(), with the posts and brackets it hangs from --------------------
// ONE swept tube per side: out of the newel's inner face, bent up the flight, along the nosing line + HAND_H (its
// TOP at 36 in), bent again and back into the top post's inner face. Bends, not two straight pieces meeting: the
// sloped run's end face stood proud of a separate return. The top post is the platform's gap post when the flight
// is mounted and the landing's own first post when it is not; both stand just down-flight of the flight top
// (their deck-side face on it), so one top bend fits both.
// tube centre above the nosing line: a round tube on a slope stands HR_R / cos(slope) above its centreline
// (measured plumb, as a handrail's height is), so its top lands on HAND_H exactly. The tube's centre is HR_Y above
// the nosing line and HR_Z off the tread edge (inside the posts).
var HR_Y = r8(HAND_H - HR_R / COS)

// ---- top landing ---------------------------------------------------------------------------------------------
// 0.76 m = 30 in, OSHA 1910.25(b)(4)'s minimum landing depth in the direction of travel (STAIRS_LANDING_DEPTH
// in core/types/base.ts must match)
var LANDING = 0.76 // top landing depth
var LAND_POST_H = r8(HRAIL_H + RAIL / 2 + POST_CAP) // the landing posts stand POST_CAP over the top rail
var GUARD_T = r8(POST * 1.5) // the hidden guard colliders' thickness
// bounds follow the flight: from the foot (FOOT_BACK behind the origin, measured with `npm run check-part`) to the
// far landing post's outer face
var FOOT_BACK = 0.028
var FAR_END = r8(LANDING + POST / 2) // the far landing post is centred on the landing's end

// NOSE_*: the nosing angle's top leg (run back over the tread), front leg (down the tread's front edge),
// thickness, and how far it stands proud of the tread. BOLT_AF: a hex's across-flats.
var NOSE_TOP = 0.045, NOSE_FRONT = 0.035, NOSE_T = 0.003, NOSE_PROUD = 0.0015, BOLT_AF = 0.016

// ---- the rig's link placement, as plain numbers of the params (n = numSteps, w = width) ---------------------
// a link centred on the flight midpoint: x = n·TREAD/2, y = n·RISE/2 (+ a per-link add)
function midX(n, add) { return n * r8(TREAD / 2) + r8(add) }
function midY(n, add) { return n * r8(RISE / 2) + r8(add) }
// a sloped beam whose length tracks the flight exactly (n · per-step diagonal): foot→landing start
function slopeLen(n) { return n * r8(DIAG) }
// a link placed off the flight TOP: x = n·TREAD + an add; y = n·RISE (top-tread level) + an add
function landX(n, add) { return n * r8(TREAD) + r8(add) }
function landY(n, add) { return n * r8(RISE) + r8(add) }
// z on a side member: ±(w/2 + SIDE_Z); on the post line: ±(w/2 + POST_Z); on a guard: ±(w/2 + STRINGER_W)
function sideZ(w, s) { return s * w / 2 + r8(SIDE_Z * s) }
function postZ(w, s) { return s * w / 2 + r8(POST_Z * s) }
function guardZ(w, s) { return s * w / 2 + r8(STRINGER_W * s) }
var LR = function (s) { return s < 0 ? 'L' : 'R' }
var STEEL_RAIL = { color: STEEL, colorParam: 'color', showParam: 'showHandrails', collision: 'none' } // steel, gated with the handrails

// ---- stringers (steel, the sloped side skirt beams) ---------------------------------------------------------
// The ideal band is a PARALLELOGRAM - height measured VERTICALLY, end cuts VERTICAL (the bottom edge offset
// straight up by its height) - which a rig box can't express (no shear), so this band is a slope-rotated
// box: height perpendicular to the slope, ends cut perpendicular. Untrimmed, the FOOT end's perpendicular cut
// leaned its top corner SIN·H down-flight PAST the newel - a floating blade at the foot of the stairs. Trim
// the foot by H·tan(ANG) along the slope: the cut's top corner lands exactly on the newel centreline (x=0),
// so the band dies into the newel like a flush vertical end.
// The band hangs STRINGER_DROP (vertically) below the riser-base line. Riding that line exactly, every step
// poked out under it: a riser is a RISER_T plate standing on the step's inner corner, so its back-bottom corner
// sits RISER_T·tan(ANG) = 19 mm below the line, and a tread's back-bottom corner THICK below it. The drop also
// brings the band's top edge down to within a few mm of the landing skirt's (46 mm proud of it without the drop).
function stringer(n, w, s) {
  return {
    name: 'stringer' + LR(s),
    // TOP end: the band's bottom edge stops at the flight top (x = n·TREAD, the deck edge once snapped), so
    // its perpendicular cut leans back down-flight and the stringer HEAD below squares it off. Net length: n ·
    // per-step diagonal less one TRIM (the foot's).
    shape: { kind: 'box', size: [slopeLen(n) - STRINGER_TRIM, STRINGER_H, STRINGER_W] },
    // the band's BOTTOM edge rides STRINGER_DROP under the riser-base line, from the trimmed foot (x = SIN·H) to the
    // flight top - centre = that bottom edge's midpoint + half the band height along the slope's upward normal
    // (−SIN, COS). The SIN·H/2 the midpoint gains in x the normal takes back, so centre x is the bare flight
    // midpoint; y adds TRIM·SIN/2 + COS·H/2 and takes off the drop.
    offset: [midX(n, 0), midY(n, STRINGER_TRIM * SIN / 2 + COS * STRINGER_H / 2 - STRINGER_DROP), sideZ(w, s)],
    quat: SLOPE_Q,
    ...STEEL_RAIL,
  }
}
// The trim leaves a daylight wedge between the newel and the band's angled start (a parallelogram band would reach the
// floor at x=0 with a VERTICAL end no rig box can express) - a FOOT PLATE closes it: a vertical-ended box from
// the floor up to the band's top-edge start (the band's VERTICAL thickness H/COS), spanning exactly the trim's
// x-extent, so the union silhouette reads as a vertical foot + rising top edge. 2 mm thinner than
// the band (their side faces overlap along the cut and would z-fight); anchor: 'floor' keeps it floor-seated when a
// deck connection lifts the flight.
function stringerFoot(w, s) {
  return {
    name: 'stringerFoot' + LR(s),
    shape: { kind: 'box', size: [FOOT_LEN, FOOT_H, r8(STRINGER_W - 0.002)] },
    offset: [r8(FOOT_LEN / 2), r8(FOOT_H / 2), sideZ(w, s)],
    anchor: 'floor',
    ...STEEL_RAIL,
  }
}
// The stringer HEAD, the foot plate's mirror at the top: the band's perpendicular top cut leans back SIN·H
// down-flight, and this vertical-ended box fills the wedge between that cut and the flight top, from the band's
// bottom edge there up to the cut's top corner. The union reads as a level top cut HEAD_TOP above the top tread and
// a plumb end at the flight top: where a snapped stringer meets the deck edge, and where a freestanding one hands on
// to the landing kick plate at the same height. 2 mm thinner than the band, like the foot plate.
function stringerHead(n, w, s) {
  return {
    name: 'stringerHead' + LR(s),
    shape: { kind: 'box', size: [FOOT_LEN, HEAD_H, r8(STRINGER_W - 0.002)] },
    offset: [landX(n, -FOOT_LEN / 2), landY(n, HEAD_TOP - HEAD_H / 2), sideZ(w, s)],
    ...STEEL_RAIL,
  }
}

// ---- sloped rails (steel) - top + mid on the post line, both sides ---------------------------------------------
// A stair rail system needs the 42 in top rail AND a separate handrail to grip (OSHA 1910.29(f)); the handrail
// runs the flight only, since the landing is a platform edge, guarded by its top and mid rails.
// A beam on the NOSING LINE + rail height (see posts): flight-parallel through ((i+1)·TREAD, (i+1)·RISE + h),
// which lands EXACTLY on the flat landing rail's start point (n·TREAD, n·RISE + h) - the two
// rails share the corner. Centre (at x = n·TREAD/2) = n·RISE/2 + h.
var RAIL_KIND = { top: { h: HRAIL_H, sec: RAIL, name: 'Top' }, mid: { h: MRAIL_H, sec: MIDRAIL, name: 'Mid' } }
// The TOP end is trimmed along the slope: a perpendicular end cut at the flight top leaned its lower corner
// sec/2·SIN past it, a nub standing proud of the post it ends in (the platform's gap post, whose deck-side face is
// the flight top, or the landing post). Trimmed, that corner stops a millimetre short of the flight top.
function rail(n, w, s, which) {
  var k = RAIL_KIND[which]
  var trim = r8((k.sec / 2 * SIN + 0.001) / COS)
  return {
    name: 'rail' + k.name + LR(s),
    shape: { kind: 'box', size: [slopeLen(n) - trim, k.sec, k.sec] },
    offset: [midX(n, -trim * COS / 2), midY(n, k.h - trim * SIN / 2), postZ(w, s)],
    quat: SLOPE_Q,
    ...STEEL_RAIL,
  }
}

// ---- bottom newel (steel) - a thicker anchor post at the foot of each rail -----------------------------------
function newel(w, s) {
  return {
    name: 'newel' + LR(s),
    shape: { kind: 'box', size: [NEWEL, NEWEL_H, NEWEL] },
    offset: [0, r8(NEWEL_H / 2), postZ(w, s)],
    anchor: 'floor', // deck connection lifts the flight; the newel stretches down so it stays planted on the floor
    ...STEEL_RAIL,
  }
}

// ---- top landing ---------------------------------------------------------------------------------------------
// A flat plate at the flight top with its own rail, posts and kick plates, for a FREESTANDING flight. Every landing
// link is `dropWhenMounted`: snapped, the flight's top meets the deck edge and the deck is the landing (a landing
// left standing hung 0.76 m off the platform on nothing, its far posts doubling the platform's gap posts).
// flat top + mid handrail across the landing (fixed LANDING length), both sides - continues the sloped rails
function landingRail(n, w, s, which) {
  var h = which === 'top' ? HRAIL_H : MRAIL_H
  var sec = which === 'top' ? RAIL : MIDRAIL
  return {
    name: 'landRail' + (which === 'top' ? 'Top' : 'Mid') + LR(s),
    shape: { kind: 'box', size: [LANDING, sec, sec] },
    offset: [landX(n, LANDING / 2), landY(n, h), postZ(w, s)],
    ...STEEL_RAIL,
    dropWhenMounted: true,
  }
}
// posts at the landing's near end (top of steps) + far end (frame the flat rail, close the gap to the sloped rail).
// The near post stands where a platform's gap post does when the flight is mounted, its deck-side face on the flight
// top, so the handrail's top bend meets a post in the same place either way. Both stand POST_CAP over the top rail.
function landingPost(n, w, s, end) { // end 0 = landing start (flight top), 1 = landing far end
  return {
    name: 'landPost' + end + LR(s),
    shape: { kind: 'box', size: [POST, LAND_POST_H, POST] },
    offset: [landX(n, end * LANDING - (end === 0 ? POST / 2 : 0)), landY(n, LAND_POST_H / 2), postZ(w, s)],
    ...STEEL_RAIL,
    dropWhenMounted: true,
  }
}
// side KICK PLATES on the landing - a toe band ABOVE the plate (it does NOT hang under it), starting at the flight
// top where the stringer head's level cut ends, at that same height, so the two read as one line. 2 mm thinner
// than the band, like the head.
function landingSkirt(n, w, s) {
  return {
    name: 'landSkirt' + LR(s),
    shape: { kind: 'box', size: [LANDING, HEAD_TOP, r8(STRINGER_W - 0.002)] },
    offset: [landX(n, LANDING / 2), landY(n, HEAD_TOP / 2), sideZ(w, s)],
    ...STEEL_RAIL,
    dropWhenMounted: true,
  }
}

// ---- guard colliders (invisible, physics-only) ---------------------------------------------------------------
// `hidden` collision-only boxes along both open sides (mesh hidden, body built) so a walker can't step off
// the flight, gated by showHandrails like every other rail member - showParam omits the mesh AND the body.
function slopeGuard(n, w, s) {
  return {
    name: 'guardSlope' + LR(s),
    shape: { kind: 'box', size: [slopeLen(n), HRAIL_H, GUARD_T] },
    // flight midpoint + guard height/2 VERTICALLY, the box then rotated onto the slope about that centre
    offset: [midX(n, 0), midY(n, HRAIL_H / 2), guardZ(w, s)],
    quat: SLOPE_Q,
    hidden: true,
    showParam: 'showHandrails',
  }
}
function landingGuard(n, w, s) {
  return {
    name: 'guardLand' + LR(s),
    shape: { kind: 'box', size: [LANDING, HRAIL_H, GUARD_T] },
    offset: [landX(n, LANDING / 2), landY(n, HRAIL_H / 2), guardZ(w, s)],
    hidden: true,
    showParam: 'showHandrails',
    dropWhenMounted: true,
  }
}

// a quarter bend of radius r at corner C, arriving along unit a and leaving along unit b (a perpendicular to b):
// the points from C - r·a round to C + r·b, appended to pts
function bend(pts, C, a, b, r, segs) {
  var O = [C[0] - r * a[0] + r * b[0], C[1] - r * a[1] + r * b[1], C[2] - r * a[2] + r * b[2]]
  for (var k = 0; k <= segs; k++) {
    var t = (k / segs) * Math.PI / 2, co = Math.cos(t), si = Math.sin(t)
    pts.push([O[0] - r * co * b[0] + r * si * a[0], O[1] - r * co * b[1] + r * si * a[1], O[2] - r * co * b[2] + r * si * a[2]])
  }
}
// both handrails, one swept tube each: newel inner face -> bend -> up the nosing line -> bend -> top post inner face
function handrails(g, n, width) {
  var L = Math.sqrt(TREAD * TREAD + RISE * RISE), d = [TREAD / L, RISE / L, 0]
  var ring = []
  // counter-clockwise in g.sweep's [up, width] section coordinates, so the faces point OUT (clockwise turned the
  // tube inside out: its far wall's inside passed for a tube until the angle showed the open shell)
  for (var k = 0; k < 16; k++) { var t = (k / 16) * Math.PI * 2; ring.push([HR_R * Math.cos(t), HR_R * Math.sin(t)]) }
  var tubes = []
  for (var s = -1; s <= 1; s += 2) {
    var zh = s * (width / 2 + HR_Z)
    var xTop = n * TREAD - POST / 2 // the top post's centre: its deck-side face is the flight top
    var pts = [[0, HR_Y, s * (width / 2 + POST_Z - NEWEL / 2)]]
    bend(pts, [0, HR_Y, zh], [0, 0, -s], d, BEND_R, 6)
    bend(pts, [xTop, (xTop * RISE) / TREAD + HR_Y, zh], d, [0, 0, s], BEND_R, 6)
    pts.push([xTop, (xTop * RISE) / TREAD + HR_Y, s * (width / 2 + POST_Z - POST / 2)])
    tubes.push(g.sweep(ring, pts, { caps: true }))
  }
  return g.merge(tubes[0], tubes[1])
}
definePart({
  manifest: {
    id: 'oip.stairs',
    name: 'Stairs',
    category: 'Structure',
    // Seat the flight on a platform deck edge, facing INTO the deck: the host advertises its deck via a 'deck' snap
    // surface (with a heightParam), the flight stands on the deck's floor with numSteps fitted to the deck height
    // (fromFloor: the step count drives the contact's rise), and its TOP (at) butts the nearest edge, the whole flight
    // outside the deck. Met, it opens the railing, notches a deck it passes through, lifts flush, and drops its own
    // landing for the deck's (dropWhenMounted).
    snap: {
      edgeMount: {
        accepts: 'deck', alongParam: 'width', reach: 3, facing: 'into',
        at: [0, 0, 0],
        atParams: [{ axis: 0, param: 'numSteps', scale: TREAD }, { axis: 1, param: 'numSteps', scale: RISE }],
        fromFloor: { param: 'numSteps' },
        opens: true, notch: true, lift: true,
      },
    },
    materials: [{ id: 'stairSteel', color: STEEL, metalness: 0.3, roughness: 0.6 }, hardwareMaterial('stairHardware')],
  },
  params: {
    numSteps: { type: 'number', default: DEFAULT_STEPS, min: 2, max: 40, step: 1, label: 'Steps', desc: 'Number of steps in the flight, which is what sets both its rise and its run: the slope is fixed at the standard 0.178 m rise over a 0.28 m tread, so a flight grows along the diagonal rather than getting steeper. Count the steps you need to reach the deck.' },
    width: { type: 'number', default: WIDTH0, min: 0.4, max: 4, step: 0.05, label: 'Width (m)', desc: 'Tread width across local Z.' },
    showHandrails: { type: 'boolean', default: true, label: 'Handrails', desc: 'Handrails up both sides of the flight.' },
    color: { type: 'color', default: '#f2bd0f', label: 'Steel color', desc: 'Steel tint of the stringers and rails.' },
  },
  rig(p) {
    var n = p.numSteps, w = p.width
    return {
      links: [
        // ---- treads + risers (steel tread plate, the walking surface) ----
        // treads: the collidable walking slabs, a numSteps array stepping up (+y RISE) and forward (+x TREAD).
        {
          name: 'tread',
          shape: { kind: 'box', size: [r8(DEPTH), THICK, w] },
          // tread 0 spans x −NOSING..TREAD (the nose overhangs DOWN-flight past the riser below:
          // tread i starts at i·run − nosing); its TOP surface sits exactly at y=RISE (the
          // walking surface rides the rise lattice, so the mount needs no topOffset)
          offset: [r8(TREAD / 2 - NOSING / 2), r8(RISE - THICK / 2), 0],
          array: { count: 'numSteps', step: [TREAD, RISE, 0] },
          finish: 'tread', // steel tread plate (rig DeckSurface)
          notchable: true,
        },
        // risers: a thin plate closing each step's front face, spanning one RISE below its tread. Visual-only
        // (collision: 'none') - the treads are the collidable surface.
        {
          name: 'riser',
          shape: { kind: 'box', size: [RISER_T, RISE, w] },
          offset: [r8(RISER_T / 2), r8(RISE / 2), 0], // riser 0: front at x=0, spanning y 0..RISE
          array: { count: 'numSteps', step: [TREAD, RISE, 0] },
          finish: 'tread',
          notchable: true,
          anchor: 'floor', // deck connection lifts the flight; a filler plate under riser 0 keeps the foot floor-seated
          collision: 'none',
        },
        stringer(n, w, -1), stringer(n, w, 1),
        stringerFoot(w, -1), stringerFoot(w, 1),
        stringerHead(n, w, -1), stringerHead(n, w, 1),
        // The posts (geometry()) ride this frame (world-aligned, at the foot) rather than the part root, because a
        // snapped stair's deck-connection lift shifts every rig LINK (structureCuts.applyStairLift) and geometry() on
        // the root would stay behind.
        { name: 'railFrame', shape: { kind: 'frame' }, offset: [0, 0, 0] },
        rail(n, w, -1, 'top'), rail(n, w, 1, 'top'),
        rail(n, w, -1, 'mid'), rail(n, w, 1, 'mid'),
        newel(w, -1), newel(w, 1),
        // the landing's walking plate - steel tread plate, collides like the treads
        {
          name: 'landing',
          shape: { kind: 'box', size: [LANDING, THICK, w] },
          // plate TOP at n·RISE exactly - coplanar with the last tread's top
          offset: [landX(n, LANDING / 2), landY(n, -THICK / 2), 0],
          finish: 'tread', // the same surface as a tread-plate platform deck
          notchable: true,
          dropWhenMounted: true,
        },
        landingRail(n, w, -1, 'top'), landingRail(n, w, 1, 'top'),
        landingRail(n, w, -1, 'mid'), landingRail(n, w, 1, 'mid'),
        landingPost(n, w, -1, 0), landingPost(n, w, 1, 0),
        landingPost(n, w, -1, 1), landingPost(n, w, 1, 1),
        landingSkirt(n, w, -1), landingSkirt(n, w, 1),
        slopeGuard(n, w, -1), slopeGuard(n, w, 1),
        landingGuard(n, w, -1), landingGuard(n, w, 1),
      ],
      joints: [],
      // bounds follow the flight: it runs FORWARD from the origin at its foot, so the box is centred on the run,
      // from the foot to the far landing post's outer face; across, the treads and the side rails; up, the rise plus
      // the landing posts. The footprint the editor selects, overlaps and rests by is this box, so a box centred on
      // the origin put half the flight outside it.
      bounds: {
        length: n * TREAD + FAR_END + FOOT_BACK,
        width: w + 0.04,
        top: n * RISE + LAND_POST_H,
        centerX: (n * TREAD + FAR_END - FOOT_BACK) / 2,
      },
    }
  },
  geometry(g, p) {
    var n = typeof p.numSteps === 'number' && p.numSteps >= 2 ? Math.round(p.numSteps) : DEFAULT_STEPS
    var width = typeof p.width === 'number' && p.width > 0 ? p.width : WIDTH0
    var rails = p.showHandrails !== false
    var steel = mesh(g), hw = mesh(g)
    var i, s

    // nosing: an angle over each tread's front edge, its ends run a hair into the stringers
    var zw = width / 2 + 0.001
    for (i = 0; i < n; i++) {
      var front = i * TREAD - NOSING, top = (i + 1) * RISE
      abox(steel, front - NOSE_T, top - NOSE_T, -zw, front + NOSE_TOP, top + NOSE_PROUD, zw)
      abox(steel, front - NOSE_T, top - NOSE_FRONT, -zw, front + SEAT, top - NOSE_T + SEAT, zw)
    }
    if (rails) {
      // stringer bolts: two heads on each stringer's outer face per tread, just under the tread's level
      var zOut = width / 2 + STRINGER_W
      for (i = 0; i < n; i++) {
        for (s = -1; s <= 1; s += 2) {
          hex(hw, [i * TREAD + TREAD * 0.3, (i + 1) * RISE - 0.03, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
          hex(hw, [i * TREAD + TREAD * 0.7, (i + 1) * RISE - 0.03, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
        }
      }
      // The intermediate handrail posts: a rig array can only place one per tread, and industrial stair rail has
      // one every metre or so. Evenly divide the run from the newel (x = 0) to the landing post (x = numSteps x
      // tread) into spans no longer than POST_MAX_RUN and stand a post on the tread nearest each division, bolted
      // through the stringer twice.
      var spans = Math.max(1, Math.ceil((n * TREAD) / POST_MAX_RUN))
      var last = -1
      for (var j = 1; j < spans; j++) {
        i = Math.min(n - 2, Math.max(1, Math.round((j * n) / spans - 0.5))) // tread index, never beside an end post
        if (i === last) continue
        last = i
        var px = (i + 0.5) * TREAD, py = (i + 1) * RISE
        for (s = -1; s <= 1; s += 2) {
          var pz = s * (width / 2 + POST_Z)
          abox(steel, px - POST / 2, py, pz - POST / 2, px + POST / 2, py + POST_H, pz + POST / 2)
          // handrail bracket: an arm from the post's inner face under the pipe, its top just into the pipe
          var hy = (px * RISE) / TREAD + HR_Y, hz = s * (width / 2 + HR_Z), fz = s * (width / 2 + POST_Z - POST / 2)
          abox(steel, px - 0.012, hy - HR_R - 0.025, Math.min(hz, fz), px + 0.012, hy - HR_R + 0.006, Math.max(hz, fz))
          hex(hw, [px, py + 0.05, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
          hex(hw, [px, py + 0.12, s * zOut], 2, s, BOLT_AF, BOLT_AF * 0.35)
        }
      }
    }
    var out = emitMeshes([
      { mesh: steel, material: 'stairSteel', colorParam: 'color', link: 'railFrame' },
      { mesh: hw, material: 'stairHardware', link: 'railFrame' },
    ])
    if (rails) out.splice(1, 0, { desc: handrails(g, n, width), material: 'stairSteel', colorParam: 'color', link: 'railFrame' })
    return out
  },
  react() {},
})
