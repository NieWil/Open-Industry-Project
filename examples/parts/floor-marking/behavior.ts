// Floor Marking — painted floor bands (geometry-function tier). Five styles (solid / hazard stripes / dashed /
// border / stripes) as flat two-colour geometry, all quads in the part-local x ∈ [−L/2, L/2], z ∈ [−W/2, W/2]
// rectangle: geometry(g, p) partitions it into bands and returns one MeshPart per colour, each tinted live from
// a 'color' param via MeshPart.colorParam. Render-only — no collision, no conveying; the part is pure paint.

definePart({
  params: {
    // 'face' handles = viewport resize dots (±X length, ±Z width)
    length: { type: 'number', default: 2, min: 0.1, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, desc: 'Extent along local X. Drag the dot on either end face to resize in the viewport.' },
    width: { type: 'number', default: 8, min: 0.1, max: 30, step: 0.1, label: 'Width (m)', handle: { kind: 'face', axis: 'z' }, desc: 'Extent along local Z. Drag the dot on either side face to resize in the viewport.' },
    style: {
      type: 'enum',
      default: 'hazard',
      label: 'Style',
      desc: 'Which pattern is painted into the rectangle. Border draws an outline only and leaves the interior bare floor; every other style covers the whole footprint.',
      options: [
        { value: 'solid', label: 'Solid' },
        { value: 'hazard', label: 'Hazard stripes' },
        { value: 'dashed', label: 'Dashed' },
        { value: 'border', label: 'Border' },
        { value: 'stripes', label: 'Stripes' },
      ],
    },
    stripeSize: { type: 'number', default: 0.3, min: 0.05, max: 2, step: 0.05, label: 'Stripe size (m)', group: 'Pattern', desc: "Width of one stripe or dash (the pattern repeats every two of them). Bands are phased from this part's own origin, so two markings laid end to end won't necessarily line up." },
    borderWidth: { type: 'number', default: 0.1, min: 0.02, max: 1, step: 0.01, label: 'Border width (m)', group: 'Pattern', desc: 'Width of the border band. Only the Border style draws one.' },
    // alpha:true accepts #rrggbbaa colours — the picker gains an A slider; a fully-transparent secondary cuts
    // its bands out (see secOn below).
    primaryColor: { type: 'color', default: '#f2b705', label: 'Primary color', group: 'Colors', alpha: true, desc: 'The base colour: the solid fill, the first hazard/stripe band, the dashed field, the border itself. Always painted, and always opaque - the bands are geometry, so partial alpha does nothing here.' },
    secondaryColor: { type: 'color', default: '#1a1a1a', label: 'Secondary color', group: 'Colors', alpha: true, desc: 'The alternating colour: the second hazard/stripe band and the dashes. Take its alpha all the way to zero to drop those bands entirely and leave bare floor between the primary ones; any other alpha paints opaque. Unused by Solid and Border.' },
  },
  // Bands never overlap in-plane — only the dashed style layers, and its dashes float clear of the field.
  geometry(g, p) {
    var L = typeof p.length === 'number' && p.length > 0 ? p.length : 2
    var W = typeof p.width === 'number' && p.width > 0 ? p.width : 8
    var s = typeof p.stripeSize === 'number' && p.stripeSize > 0 ? p.stripeSize : 0.3
    var bw = typeof p.borderWidth === 'number' && p.borderWidth > 0 ? p.borderWidth : 0.1
    var style = typeof p.style === 'string' ? p.style : 'hazard'
    var Y = 0.01 // lift above the floor plane (m) so the bands don't z-fight it
    var x0 = -L / 2, x1 = L / 2, z0 = -W / 2, z1 = W / 2
    var prim = g.surface()
    var sec = g.surface()
    // a fully-transparent secondary (#rrggbb00) emits no secondary bands, so the floor shows through the gaps.
    // Partial alpha is not supported — bands are opaque geometry.
    var secOn = !(typeof p.secondaryColor === 'string' && /^#[0-9a-fA-F]{6}00$/.test(p.secondaryColor))

    // clip a convex [x, z] polygon to the half-plane f(pt) >= 0 (Sutherland–Hodgman, one edge)
    function clip(poly, f) {
      var out = []
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], b = poly[(i + 1) % poly.length]
        var fa = f(a), fb = f(b)
        if (fa >= 0) out.push(a)
        if (fa >= 0 !== fb >= 0) {
          var t = fa / (fa - fb)
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        }
      }
      return out
    }
    // fan a convex [x, z] polygon into a surface as an up-facing flat face at height y
    function emit(sfc, poly, y) {
      if (poly.length < 3) return
      var idx = []
      for (var i = 0; i < poly.length; i++) idx.push(sfc.vertex(poly[i][0], y, poly[i][1], poly[i][0], poly[i][1]))
      for (var k = 1; k < poly.length - 1; k++) sfc.triangle(idx[0], idx[k], idx[k + 1])
    }
    // an axis-aligned band rectangle, clamped to the marking; CCW seen from above (+Y normal)
    function rectPoly(rx0, rz0, rx1, rz1) {
      rx0 = Math.max(rx0, x0); rz0 = Math.max(rz0, z0); rx1 = Math.min(rx1, x1); rz1 = Math.min(rz1, z1)
      if (rx1 - rx0 < 1e-6 || rz1 - rz0 < 1e-6) return null
      return [[rx0, rz0], [rx0, rz1], [rx1, rz1], [rx1, rz0]]
    }
    var rect = rectPoly(x0, z0, x1, z1)

    if (style === 'solid') {
      emit(prim, rect, Y)
    } else if (style === 'hazard') {
      // diagonal hazard bands over the sum x+z, period 2s: primary for the first s, secondary for the next.
      // Band phase is part-local, so two abutting markings don't necessarily align.
      var k0 = Math.floor((x0 + z0) / (2 * s)), k1 = Math.ceil((x1 + z1) / (2 * s))
      for (var k = k0; k < k1; k++) {
        var a = 2 * s * k
        var pBand = clip(clip(rect, function (pt) { return pt[0] + pt[1] - a }), function (pt) { return a + s - pt[0] - pt[1] })
        emit(prim, pBand, Y)
        var sBand = clip(clip(rect, function (pt) { return pt[0] + pt[1] - (a + s) }), function (pt) { return a + 2 * s - pt[0] - pt[1] })
        if (secOn) emit(sec, sBand, Y)
      }
    } else if (style === 'dashed') {
      // a primary field with secondary dashes (length s, period 2s) down the centre fifth of the short axis,
      // running along the long axis. Dashes float 0.6 mm over the field (two layers can't z-fight).
      emit(prim, rect, Y)
      var longX = L >= W
      var a0 = longX ? x0 : z0, a1 = longX ? x1 : z1
      var c0 = longX ? z0 + 0.4 * W : x0 + 0.4 * L, c1 = longX ? z0 + 0.6 * W : x0 + 0.6 * L
      var dk0 = Math.floor(a0 / (2 * s)), dk1 = Math.ceil(a1 / (2 * s))
      for (var dk = dk0; dk < dk1; dk++) {
        var d0 = Math.max(2 * s * dk, a0), d1 = Math.min(2 * s * dk + s, a1)
        if (d1 - d0 < 1e-6) continue
        var dash = longX ? rectPoly(d0, c0, d1, c1) : rectPoly(c0, d0, c1, d1)
        if (secOn) emit(sec, dash, Y + 0.0006)
      }
    } else if (style === 'border') {
      // outline only — four non-overlapping bands (two full-width sides + two ends between them), interior open
      var b = Math.min(bw, L / 2, W / 2)
      emit(prim, rectPoly(x0, z0, x0 + b, z1), Y)
      emit(prim, rectPoly(x1 - b, z0, x1, z1), Y)
      emit(prim, rectPoly(x0 + b, z0, x1 - b, z0 + b), Y)
      emit(prim, rectPoly(x0 + b, z1 - b, x1 - b, z1), Y)
    } else {
      // 'stripes' — alternating bands over the long axis measured from the edge, period 2s: primary for the
      // first s, secondary for the next.
      var sLongX = L >= W
      var sa0 = sLongX ? x0 : z0, sa1 = sLongX ? x1 : z1
      var n = Math.ceil((sa1 - sa0) / (2 * s))
      for (var sk = 0; sk < n; sk++) {
        var p0 = sa0 + 2 * s * sk, p1 = Math.min(p0 + s, sa1), q1 = Math.min(p0 + 2 * s, sa1)
        var pBand2 = sLongX ? rectPoly(p0, z0, p1, z1) : rectPoly(x0, p0, x1, p1)
        emit(prim, pBand2, Y)
        if (q1 - p1 > 1e-6) {
          var sBand2 = sLongX ? rectPoly(p1, z0, q1, z1) : rectPoly(x0, p1, x1, q1)
          if (secOn) emit(sec, sBand2, Y)
        }
      }
    }

    // an empty surface (e.g. solid's secondary) is dropped by the host's normalizer
    return [
      { desc: prim.build(), finish: 'mesh', colorParam: 'primaryColor' },
      { desc: sec.build(), finish: 'mesh', colorParam: 'secondaryColor' },
    ]
  },
  react() {
    // pure paint — nothing to do
  },
})
