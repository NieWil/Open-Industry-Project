// Fence — a safety barrier: yellow posts auto-spaced along the length (each with a cap and a floor plate) + a
// black wire-mesh grid (a frame rectangle + vertical/horizontal wires) filling every span, clamped to its posts and
// anchored to the floor — not a solid slab. Demonstrates a
// rig dressed by procedural geometry: geometry() emits the mesh (render-only); the hidden full-span 'barrier'
// rig link is the collision. Length/height-parametric (both with viewport resize dots) + per-surface colour.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { mesh, anchor } from '../_shared/hardware.js'

// fixed dimensions (m)
var POST = 0.06, MAX_SPACING = 1.5, FRAME = 0.03, WIRE = 0.008, SPACING = 0.1
var CAP_H = 0.03, CAP_FP = POST * 1.08, INSET = 0.08
// Post hardware, SHARED with the Safety Gate (same numbers, same heights) so a gate in a fence line matches it:
// a floor plate under every post, and a clamp COLLAR round the post at each clamp height with a STRAP from the
// collar into the panel frame. Every piece is a little bigger or smaller than what it meets, never flush with it,
// so no two faces share a plane (a shared plane z-fights). Four floor anchors on every plate, ANCHOR_IN out from
// the post's centre on each diagonal. Render-only: the hidden 'barrier' is the collision.
var FOOT = 0.12, FOOT_T = 0.01, COLLAR = POST + 0.012, COLLAR_H = 0.05, STRAP_H = 0.04, STRAP_T = 0.012
var CLAMP_IN = 0.2, SINK = 0.005, ANCHOR_IN = 0.043, ANCHOR_AF = 0.016
// the clamp heights for a panel spanning yb..yt: near the top and the bottom, or one mid-height on a short panel
function clampHeights(yb, yt) { return yt - yb > CLAMP_IN * 3 ? [yb + CLAMP_IN, yt - CLAMP_IN] : [(yb + yt) / 2] }

definePart({
  manifest: {
    id: 'oip.fence',
    name: 'Fence',
    category: 'Structure',
    // End-to-end chaining (declarative SnapChain, docs/part-snap-chain.md): a fence extends collinearly off
    // another fence-family barrier's nearer end, or forms a 90-degree L-corner sharing ONE post - the corner
    // handshake toggles the omitPost* booleans so the shared post draws once. Group 'barrierFence' is shared
    // with the Safety Gate (they chain together); guard rails are their own group and never mix. reach 1 m is
    // the fence family's tight engage distance (SNAP_FENCE_VISIBLE_THRESHOLD).
    snap: { chain: { group: 'barrierFence', lengthParam: 'length', reach: 1, omitStartParam: 'omitPostStart', omitEndParam: 'omitPostEnd' } },
    // the `color` only seeds the pre-tint; each submesh's colorParam repaints it live from its param
    materials: [
      { id: 'postMetal', color: [0.949, 0.741, 0.059], metalness: 0.1, roughness: 0.45 },
      { id: 'meshMetal', color: [0.05, 0.05, 0.05], metalness: 0.3, roughness: 0.6 },
    ],
  },
  params: {
    // both sizes are viewport-editable: a 'face' handle puts a resize dot on that axis's faces (docs/part-gizmos.md).
    // X is centre-origin (the opposite end holds); Y is base-origin, so the +Y dot drags the top and the base stays put.
    // The floor is a FILLER PANEL, not a usable run. A guard line is only closed where it meets the machine,
    // and the piece that closes it is whatever the leftover measures — commonly a few hundred mm, as where the
    // demo cell's north run returns to the case line (a 0.48 m slot, so 0.40 m of fence). At 0.5 no fence could
    // shut that at all and the param quietly clamped, which reads as a guarded cell with a person-sized hole in
    // it. 0.2 is where a panel stops being one: the two end posts leave 0.12 of mesh between them.
    length: { type: 'number', default: 4, min: 0.2, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, desc: 'Fence run length along local +X. Drag the dot on either end face to resize in the viewport; short runs are legitimate filler panels where a guard line meets a machine.' },
    height: { type: 'number', default: 2, min: 0.5, max: 4, step: 0.1, label: 'Height (m)', handle: { kind: 'face', axis: 'y' }, desc: 'Panel height. The base stays on the floor and the top face moves, so the viewport dot drags the top.' },
    postColor: { type: 'color', default: '#f2bd0f', label: 'Post color', group: 'Colors', desc: 'Post tint.' },
    meshColor: { type: 'color', default: '#0d0d0d', label: 'Mesh color', group: 'Colors', desc: 'Tint of the frame and the wire panel it holds.' },
    omitPostStart: { type: 'boolean', default: false, label: 'Omit start post', group: 'Posts', desc: 'Suppress the post at local -X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
    omitPostEnd: { type: 'boolean', default: false, label: 'Omit end post', group: 'Posts', desc: 'Suppress the post at local +X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
  },
  // One hidden full-span box is the collision barrier (a `hidden` box builds its body but never renders); its
  // base sits on the floor.
  rig(p) {
    return {
      links: [{ name: 'barrier', shape: { kind: 'box', size: [p.length, p.height, POST] }, offset: [0, p.height / 2, 0], hidden: true }],
      joints: [],
      bounds: { length: 4, width: 0.12, top: 2 },
    }
  },
  geometry(g, p) {
    var length = typeof p.length === 'number' && p.length > 0 ? p.length : 4
    var height = typeof p.height === 'number' && p.height > 0 ? p.height : 2
    var omitStart = p.omitPostStart === true
    var omitEnd = p.omitPostEnd === true
    var box = function (cx, cy, cz, sx, sy, sz) { return g.box([sx, sy, sz], [cx, cy, cz]) }
    var posts = []
    var wires = [] // the frame, wires, caps and clamps: one meshColor submesh
    var hw = mesh(g) // the floor anchors, merged into it (the fixings share the clamps' colour, and a fence line is
    //                  many fences, so a draw of their own each would add up)
    // fill [xa,xb] x [yb,yt] with a frame rectangle + a wire grid
    var panel = function (xa, xb, yb, yt) {
      var cx = (xa + xb) / 2, cy = (yb + yt) / 2, w = xb - xa, h = yt - yb
      wires.push(box(cx, yb, 0, w, FRAME, FRAME), box(cx, yt, 0, w, FRAME, FRAME))
      wires.push(box(xa, cy, 0, FRAME, h, FRAME), box(xb, cy, 0, FRAME, h, FRAME))
      var cols = Math.max(1, Math.round(w / SPACING)), colStep = w / cols
      for (var i = 1; i < cols; i++) wires.push(box(xa + i * colStep, cy, 0, WIRE, h, WIRE))
      var rows = Math.max(1, Math.round(h / SPACING)), rowStep = h / rows
      for (var j = 1; j < rows; j++) wires.push(box(cx, yb + j * rowStep, 0, w, WIRE, WIRE))
    }
    var hl = length / 2
    var numSpans = Math.max(1, Math.ceil(length / MAX_SPACING))
    var span = length / numSpans
    var inset = Math.min(INSET, height * 0.1)
    var yb = inset, yt = height - inset
    var margin = POST * 0.5 + 0.01
    var clampYs = clampHeights(yb, yt)
    var postXs = []
    for (var s0 = 0; s0 <= numSpans; s0++) postXs.push(-hl + s0 * span)
    for (var i = 0; i < postXs.length; i++) {
      if ((i === 0 && omitStart) || (i === numSpans && omitEnd)) continue // a snapped neighbour supplies the corner post
      var x = postXs[i]
      posts.push(box(x, height / 2, 0, POST, height, POST))
      posts.push(box(x, FOOT_T / 2, 0, FOOT, FOOT_T, FOOT))
      wires.push(box(x, height + CAP_H / 2, 0, CAP_FP, CAP_H, CAP_FP))
      for (var c = 0; c < clampYs.length; c++) wires.push(box(x, clampYs[c], 0, COLLAR, COLLAR_H, COLLAR))
      for (var ax = -1; ax <= 1; ax += 2) for (var az = -1; az <= 1; az += 2) anchor(hw, x + ax * ANCHOR_IN, FOOT_T, az * ANCHOR_IN, ANCHOR_AF)
    }
    // a strap from the collar round the post at px into the frame's vertical bar at fx (either side)
    var strap = function (px, fx, y) {
      var dir = fx > px ? 1 : -1
      var x0 = px + dir * (COLLAR / 2 - SINK)
      wires.push(box((x0 + fx) / 2, y, 0, Math.abs(fx - x0), STRAP_H, STRAP_T))
    }
    for (var s = 0; s < numSpans; s++) {
      var xa = postXs[s] + margin, xb = postXs[s + 1] - margin
      if (xb > xa) {
        panel(xa, xb, yb, yt)
        for (var k = 0; k < clampYs.length; k++) { strap(postXs[s], xa, clampYs[k]); strap(postXs[s + 1], xb, clampYs[k]) }
      }
    }
    var parts = []
    if (posts.length) parts.push({ desc: g.merge.apply(g, posts), material: 'postMetal', colorParam: 'postColor' })
    wires.push(hw.sb.build())
    parts.push({ desc: g.merge.apply(g, wires), material: 'meshMetal', colorParam: 'meshColor' })
    return parts
  },
  react() {},
})
