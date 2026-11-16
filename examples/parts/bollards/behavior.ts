// Safety Bollards — a row of protective steel posts. Demonstrates MeshPart.instances: geometry(g, p) builds
// one unit bollard template (a capped cylinder, radius 1 x height 1, base at y=0) and returns it as a single
// MeshPart whose 'instances' place 'count' copies along X, each scaled to the chosen post radius/height. The
// host draws the row as one InstancedMesh — one draw call regardless of count — and since the template is built
// from constants (only the per-instance transforms use params), two bollard parts share the same unit geometry
// in the scene-global instance pool. Each post stands on a painted base plate held to the slab by four anchor
// bolts, the way a surface-mounted bollard is installed; both are banks of their own, built from constants too.
// Render-only: no collision, no conveying.

definePart({
  params: {
    count: { type: 'number', default: 5, min: 1, max: 16, step: 1, label: 'Posts', desc: 'How many posts in the row. They run along local X from the part origin.' },
    spacing: { type: 'number', default: 1.2, min: 0.4, max: 3, step: 0.05, label: 'Spacing (m)', desc: 'Centre-to-centre gap between posts. Set it narrower than whatever you mean to keep out, since the posts stop nothing that fits between them.' },
    height: { type: 'number', default: 0.9, min: 0.4, max: 1.5, step: 0.05, label: 'Height (m)', desc: 'Height of each post above the floor.' },
    radius: { type: 'number', default: 0.06, min: 0.03, max: 0.2, step: 0.005, label: 'Post radius (m)', desc: 'Thickness of each post.' },
    color: { type: 'color', default: '#f2b90c', label: 'Color', desc: 'Post tint.' },
  },
  geometry(g, p) {
    // one unit bollard: a straight shaft (y 0..0.86) + a chamfered shoulder (0.86..1.0, radius 1 -> 0.6) + top
    // and base caps, all at radius 1 / height 1 so every size shares one pooled geometry (size lives in 'scale')
    var N = 16
    var sfc = g.surface()
    function ring(y, r) {
      var v = []
      for (var k = 0; k < N; k++) { var a = (k / N) * Math.PI * 2; v.push(sfc.vertex(Math.cos(a) * r, y, Math.sin(a) * r)) }
      return v
    }
    var r0 = ring(0, 1), r1 = ring(0.86, 1), r2 = ring(1, 0.6)
    function wall(L, U) { for (var k = 0; k < N; k++) { var k2 = (k + 1) % N; sfc.quad(L[k], U[k], U[k2], L[k2]) } } // CCW from outside
    wall(r0, r1)
    wall(r1, r2)
    for (var k = 1; k < N - 1; k++) sfc.triangle(r2[0], r2[k + 1], r2[k]) // top cap (+Y)
    for (var k = 1; k < N - 1; k++) sfc.triangle(r0[0], r0[k], r0[k + 1]) // base cap (-Y, hidden against floor)
    var template = sfc.build()

    // base plate: a unit box (half-size 1 in X/Z, 1 tall, base at y=0); its size lives in the instance scale
    var pl = g.surface()
    function boxCorner(x, y, z) { return pl.vertex(x, y, z) }
    var b0 = boxCorner(-1, 0, -1), b1 = boxCorner(1, 0, -1), b2 = boxCorner(1, 0, 1), b3 = boxCorner(-1, 0, 1)
    var t0 = boxCorner(-1, 1, -1), t1 = boxCorner(1, 1, -1), t2 = boxCorner(1, 1, 1), t3 = boxCorner(-1, 1, 1)
    pl.quad(t0, t3, t2, t1) // top
    pl.quad(b0, b1, b2, b3) // bottom (hidden against the floor)
    pl.quad(b0, t0, t1, b1) // -Z
    pl.quad(b2, t2, t3, b3) // +Z
    pl.quad(b1, t1, t2, b2) // +X
    pl.quad(b3, t3, t0, b0) // -X
    var plateTemplate = pl.build()

    // anchor bolt, at its real size (an M12 wedge anchor): a hex nut on the plate with the threaded end standing
    // proud of it. Fixed size whatever the post, so every row's bolts share one template.
    var bs = g.surface()
    function bring(n, y, r, phase) {
      var v = []
      for (var k = 0; k < n; k++) { var a = phase + (k / n) * Math.PI * 2; v.push(bs.vertex(Math.cos(a) * r, y, Math.sin(a) * r)) }
      return v
    }
    function bwall(L, U) { for (var k = 0; k < L.length; k++) { var k2 = (k + 1) % L.length; bs.quad(L[k], U[k], U[k2], L[k2]) } }
    function bcap(R) { for (var k = 1; k < R.length - 1; k++) bs.triangle(R[0], R[k + 1], R[k]) } // facing +Y
    var nutLo = bring(6, 0, 0.011, Math.PI / 6), nutHi = bring(6, 0.01, 0.011, Math.PI / 6)
    bwall(nutLo, nutHi)
    bcap(nutHi)
    var studLo = bring(8, 0.01, 0.006, 0), studHi = bring(8, 0.022, 0.006, 0)
    bwall(studLo, studHi)
    bcap(studHi)
    var boltTemplate = bs.build()

    var count = Math.max(1, Math.min(16, Math.round(typeof p.count === 'number' ? p.count : 5)))
    var spacing = typeof p.spacing === 'number' && p.spacing > 0 ? p.spacing : 1.2
    var height = typeof p.height === 'number' && p.height > 0 ? p.height : 0.9
    var radius = typeof p.radius === 'number' && p.radius > 0 ? p.radius : 0.06
    var x0 = -((count - 1) * spacing) / 2
    var PLATE_T = 0.012 // plate thickness (m)
    var plateHalf = radius * 2.25 // a square plate 4.5 post radii across
    var boltOff = plateHalf * 0.72 // bolts on the plate's diagonals, clear of the post
    var insts = [], plates = [], bolts = []
    for (var i = 0; i < count; i++) {
      var x = x0 + i * spacing
      insts.push({ position: [x, 0, 0], scale: [radius, height, radius] })
      plates.push({ position: [x, 0, 0], scale: [plateHalf, PLATE_T, plateHalf] })
      for (var sx = -1; sx <= 1; sx += 2) for (var sz = -1; sz <= 1; sz += 2) bolts.push({ position: [x + sx * boltOff, PLATE_T, sz * boltOff], scale: [1, 1, 1] })
    }

    return [
      { desc: template, finish: 'guard', colorParam: 'color', instances: insts },
      { desc: plateTemplate, finish: 'guard', colorParam: 'color', instances: plates },
      { desc: boltTemplate, finish: 'bolt', instances: bolts },
    ]
  },
  react() {},
})
