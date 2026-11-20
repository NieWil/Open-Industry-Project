// Shape — a parametric primitive: box, cylinder, cone or ramp (geometry-function tier). Sized by length (X),
// width (Z) and height (Y), all three of which carry viewport resize dots; the round shapes take their two
// radii from length/2 and width/2, so a squashed cylinder is an elliptical one and the footprint stays exact.
// Base-origin (the shape sits ON local y=0) so it seats on the floor, a platform deck, or another shape.
//
// Solid by default via collision: 'hull' — a convex hull of the emitted vertices, which is EXACT for the
// box and honest for the round/wedge shapes (the 'box' channel would collide a cylinder as its bounding
// square and a ramp as a full block, so nothing could roll up it). Clear 'Solid' for pure massing/decoration.
// No behavior: inert scenery, never a conveying surface — cargo motion belongs to a real conveyor part.

definePart({
  // No snap declaration on purpose. Ambient face-flush (snap: { flush: true }) is the flag for parts that get
  // tiled, and a wall built from blocks looks like the case for it — but box/pallet/rack each carried it
  // briefly and were REVERTED: snapping to every neighbour on every drop reads as over-eager. The explicit
  // alternatives already cover a block: hold-B Face mode, vertex snap, floor rest. A shape also advertises the
  // four vertical faces of its footprint for 'face' MOUNTS implicitly, so a push button or HMI panel lands on
  // one used as a cabinet/column with nothing declared here.
  params: {
    shape: {
      type: 'enum',
      default: 'box',
      label: 'Shape',
      desc: 'Which primitive is built. All four are sized by the same three dimensions below, so switching kind keeps the footprint you already set.',
      options: [
        { value: 'box', label: 'Box' },
        { value: 'cylinder', label: 'Cylinder' },
        { value: 'cone', label: 'Cone' },
        { value: 'ramp', label: 'Ramp' },
      ],
    },
    // the three face handles = the viewport resize dots (±X length, ±Z width, ±Y height). 'height' is the
    // canonical vertical key the resize write path uses.
    length: { type: 'number', default: 1, min: 0.02, max: 40, step: 0.05, label: 'Length X (m)', handle: { kind: 'face', axis: 'x' }, desc: 'Extent along local X, with a viewport dot on each end face. A round shape takes its X radius from half of this, so a cylinder whose length and width differ is an elliptical one.' },
    width: { type: 'number', default: 1, min: 0.02, max: 40, step: 0.05, label: 'Width Z (m)', handle: { kind: 'face', axis: 'z' }, desc: 'Extent along local Z, with a viewport dot on each side face. A round shape takes its Z radius from half of this.' },
    height: { type: 'number', default: 1, min: 0.02, max: 20, step: 0.05, label: 'Height Y (m)', handle: { kind: 'face', axis: 'y' }, desc: 'Extent along local Y. The shape is BASE-ORIGIN, sitting on local y=0, so it seats flat on the floor or a deck and grows upward.' },
    sides: { type: 'number', default: 20, min: 3, max: 48, step: 1, label: 'Sides', group: 'Shape', desc: 'How many facets go around a cylinder or cone. No effect on a box or a ramp.' },
    color: { type: 'color', default: '#9aa3ad', label: 'Color', desc: 'Surface tint.' },
    solid: { type: 'boolean', default: true, label: 'Solid (blocks cargo)', group: 'Physics', desc: 'Give the shape a collision hull, so cargo and a walking pilot are stopped by it. The hull is exact for all four shapes, which is what lets a ramp actually be walked up rather than colliding as a full block. Clear it for pure massing or decoration.' },
  },
  geometry(g, p) {
    var L = typeof p.length === 'number' && p.length > 0 ? p.length : 1
    var W = typeof p.width === 'number' && p.width > 0 ? p.width : 1
    var H = typeof p.height === 'number' && p.height > 0 ? p.height : 1
    var shape = typeof p.shape === 'string' ? p.shape : 'box'
    var N = Math.max(3, Math.min(48, Math.round(typeof p.sides === 'number' ? p.sides : 20)))

    // WINDING: three derives normals from the faces, so every face below is ordered CCW seen from OUTSIDE
    // (normal = (C-B) x (A-B) for a triangle A,B,C). g.box() already does this; the surface()-built shapes
    // follow the same rule face by face.
    var desc
    if (shape === 'box') {
      desc = g.box([L, H, W], [0, H / 2, 0])
    } else if (shape === 'ramp') {
      // a right triangular prism: the deck rises along +X, from the floor at x=-L/2 to full height at x=+L/2,
      // where a vertical back face closes it. Cargo slides DOWN toward -X.
      var s = g.surface()
      var x0 = -L / 2, x1 = L / 2, z0 = -W / 2, z1 = W / 2
      // low edge (y=0) and high edge (y=H), each with its own verts per face so the edges stay crisp
      var slope = [s.vertex(x0, 0, z0, 0, 0), s.vertex(x0, 0, z1, 1, 0), s.vertex(x1, H, z1, 1, 1), s.vertex(x1, H, z0, 0, 1)]
      s.quad(slope[0], slope[1], slope[2], slope[3]) // sloped deck (up + toward -X)
      var bot = [s.vertex(x0, 0, z0, 0, 0), s.vertex(x1, 0, z0, 1, 0), s.vertex(x1, 0, z1, 1, 1), s.vertex(x0, 0, z1, 0, 1)]
      s.quad(bot[0], bot[1], bot[2], bot[3]) // underside (-Y)
      var back = [s.vertex(x1, 0, z1, 0, 0), s.vertex(x1, 0, z0, 1, 0), s.vertex(x1, H, z0, 1, 1), s.vertex(x1, H, z1, 0, 1)]
      s.quad(back[0], back[1], back[2], back[3]) // vertical back face (+X)
      var sideA = [s.vertex(x0, 0, z0, 0, 0), s.vertex(x1, H, z0, 1, 1), s.vertex(x1, 0, z0, 1, 0)]
      s.triangle(sideA[0], sideA[1], sideA[2]) // -Z flank
      var sideB = [s.vertex(x0, 0, z1, 0, 0), s.vertex(x1, 0, z1, 1, 0), s.vertex(x1, H, z1, 1, 1)]
      s.triangle(sideB[0], sideB[1], sideB[2]) // +Z flank
      desc = s.build()
    } else {
      // cylinder / cone: an N-gon ring of radii (L/2, W/2) about the origin, base on y=0. The barrel shares
      // verts around the ring (so it shades ROUND, not faceted) with a duplicated seam column for the u wrap;
      // the caps get their own verts so the rim stays a hard edge.
      var cone = shape === 'cone'
      var rx = L / 2, rz = W / 2
      var sf = g.surface()
      var ax = function (k) { return ((k % N) / N) * Math.PI * 2 }
      var bx = function (k) { return Math.cos(ax(k)) * rx }
      var bz = function (k) { return Math.sin(ax(k)) * rz }
      if (cone) {
        // flanks: one triangle per segment up to the apex. (A=ring k+1, B=ring k, C=apex) faces outward.
        for (var k = 0; k < N; k++) {
          var a1 = sf.vertex(bx(k + 1), 0, bz(k + 1), (k + 1) / N, 0)
          var a0 = sf.vertex(bx(k), 0, bz(k), k / N, 0)
          var ap = sf.vertex(0, H, 0, (k + 0.5) / N, 1)
          sf.triangle(a1, a0, ap)
        }
      } else {
        // barrel: (A=bottom k+1, B=bottom k, C=top k, D=top k+1) faces outward
        var bot0 = [], top0 = []
        for (var c = 0; c <= N; c++) {
          bot0.push(sf.vertex(bx(c), 0, bz(c), c / N, 0))
          top0.push(sf.vertex(bx(c), H, bz(c), c / N, 1))
        }
        for (var w = 0; w < N; w++) sf.quad(bot0[w + 1], bot0[w], top0[w], top0[w + 1])
        // top cap (+Y): the fan runs BACKWARDS around the ring (a forward fan faces -Y)
        var capT = []
        for (var t = 0; t < N; t++) capT.push(sf.vertex(bx(t), H, bz(t), 0.5 + 0.5 * Math.cos(ax(t)), 0.5 + 0.5 * Math.sin(ax(t))))
        for (var ti = 1; ti < N - 1; ti++) sf.triangle(capT[0], capT[ti + 1], capT[ti])
      }
      // base cap (-Y), shared by both: the forward fan, which faces down (hidden against whatever it rests on)
      var capB = []
      for (var b = 0; b < N; b++) capB.push(sf.vertex(bx(b), 0, bz(b), 0.5 + 0.5 * Math.cos(ax(b)), 0.5 + 0.5 * Math.sin(ax(b))))
      for (var bi = 1; bi < N - 1; bi++) sf.triangle(capB[0], capB[bi], capB[bi + 1])
      desc = sf.build()
    }

    var mp = { desc: desc, finish: 'mesh', colorParam: 'color' }
    // Every shape here is convex, so ONE hull is the exact solid (the box's hull is its 8 corners). Solid is
    // opt-out: a massing block someone only wants to LOOK at shouldn't stop the line.
    if (p.solid !== false) mp.collision = 'hull'
    return [mp]
  },
  react() {
    // inert scenery — no tags, no motion
  },
})
