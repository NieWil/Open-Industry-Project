// Light Curtain — a multi-beam safety light grid guarding an opening: two slim columns, the emitter at local -X and
// the receiver at +X, and four beams across the gap between them. Its output is the curtain's OSSD: TRUE while every
// beam is clear, FALSE the moment anything breaks one, a load or a person alike. Fail-safe by construction: a curtain
// that never publishes, or loses its wire, reads the same as a tripped one.
//
// It does NOT mute itself. On a conveyor opening a load breaks the beams on its way through, and what lets it pass is
// MUTING, which on a real line is the safety program's job: the curtain's OSSD and a set of muting sensors (ordinary
// photo-eyes, placed on the conveyor as their own parts) go to the controller, and a muting block there (PLCopen
// Safety's SF_MutingSeq, or a muting function of the controller's own safety library) decides when a break is a load
// arriving the way loads do and may be ignored. So the layout of those sensors, their wiring and the block's settings are all things an author
// can get wrong, exactly as on a real line. The program lights the curtain's muting lamp through `mutingLampTag`.
//
// Demonstrates several beams on one part (ctx.sense per beam link), a beam-length param (`rangeParam`), an indicator
// lamp the PLC drives (`readTag`), and procedural hardware whose lamps (geometry() `lamps` submeshes) follow
// param-driven column heights.

const BEAMS = ['beam1', 'beam2', 'beam3', 'beam4']

definePart({
  lamps: ['ossd', 'stop', 'muting'],
  params: {
    width: { type: 'number', default: 1.4, min: 0.3, max: 4, step: 0.01, label: 'Protected width (m)', desc: 'The clear gap between the two columns, which the beams span. The part origin is its centre, on the floor.' },
    fieldBottom: { type: 'number', default: 0.3, min: 0, max: 2, step: 0.01, label: 'Lowest beam (m)', desc: 'Height of the bottom beam above the floor. Where a conveyor passes through, put it just above the conveying surface: nothing can pass below that.' },
    fieldHeight: { type: 'number', default: 0.9, min: 0.2, max: 2, step: 0.01, label: 'Beam span (m)', desc: 'From the lowest beam to the highest. The four beams are spread evenly across it, and the columns stand 0.1 m above the top one.' },
    showBeam: { type: 'boolean', default: true, label: 'Show beams', desc: 'Draw the beams in the viewport. A viewing aid only - hiding them does not change what the curtain sees.' },
    tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'OSSD tag (true = clear)', group: 'Comms', desc: 'The safety output: true while every beam is clear, false while anything interrupts one. Muting a load through is the program\'s job: feed this and the muting sensors to a muting block, and its output into the run permit.' },
    mutingLampTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Muting lamp tag', group: 'Comms', desc: 'Optional: the program lights the muting lamp on the emitter\'s cap with this while it is muting the curtain.' },
  },
  geometry(g, p) {
    const width = typeof p.width === 'number' && p.width > 0 ? p.width : 1.4
    const y0 = typeof p.fieldBottom === 'number' ? p.fieldBottom : 0.3
    const span = typeof p.fieldHeight === 'number' && p.fieldHeight > 0 ? p.fieldHeight : 0.9
    // a column: a PW x PD aluminium profile on a floor plate, a yellow cap at each end, and the optics window down
    // its inner face over the field. The window's face is at x = +-width/2, which is where the beams leave from.
    const PW = 0.036, PD = 0.05, FOOT_X = 0.09, FOOT_Z = 0.11, FOOT_T = 0.01, FOOT_OUT = 0.02
    const CAP = 0.03, WIN_Z = 0.03, WIN_T = 0.002, WIN_OVER = 0.04, TOP_OVER = 0.1
    const top = y0 + span + TOP_OVER
    const hw = width / 2
    const parts = []
    const caps = [], windows = []
    for (const s of [-1, 1]) {
      const cx = s * (hw + PW / 2)
      // the profile and its plate are the column's collision (its own submesh, so the AABB is one column, not the gap)
      const column = g.merge(
        g.box([PW, top - FOOT_T - 2 * CAP, PD], [cx, (FOOT_T + CAP + top - CAP) / 2, 0]),
        g.box([FOOT_X, FOOT_T, FOOT_Z], [cx + s * FOOT_OUT, FOOT_T / 2, 0]),
      )
      parts.push({ desc: column, material: 'housing', collision: 'box' })
      caps.push(g.box([PW + 0.004, CAP, PD + 0.004], [cx, FOOT_T + CAP / 2, 0]), g.box([PW + 0.004, CAP, PD + 0.004], [cx, top - CAP / 2, 0]))
      const w0 = Math.max(FOOT_T + CAP, y0 - WIN_OVER), w1 = Math.min(top - CAP, y0 + span + WIN_OVER)
      windows.push(g.box([WIN_T, w1 - w0, WIN_Z], [s * (hw - WIN_T / 2 + 0.0005), (w0 + w1) / 2, 0]))
    }
    parts.push({ desc: g.merge(...caps), material: 'cap' })
    parts.push({ desc: g.merge(...windows), material: 'window' })
    // the receiver's status LEDs on its cap, OSSD green beside stop red; the muting lamp on the emitter's cap
    const rx = hw + PW / 2
    parts.push({ desc: g.box([0.016, 0.012, 0.016], [rx, top + 0.006, -0.012]), material: 'lens', lamps: [{ name: 'ossd', emissive: [0.1, 1, 0.2] }] })
    parts.push({ desc: g.box([0.016, 0.012, 0.016], [rx, top + 0.006, 0.012]), material: 'lens', lamps: [{ name: 'stop', emissive: [1, 0.06, 0.03] }] })
    parts.push({ desc: g.lathe([[0, 0], [0.017, 0], [0.017, 0.03], [0.012, 0.045], [0, 0.05]], { axis: 'y', center: [-rx, top, 0], segments: 16 }), material: 'lens', lamps: [{ name: 'muting', emissive: [1, 0.45, 0.02] }] })
    return parts
  },
  react(ctx) {
    const w = ctx.params.width
    let clear = true
    for (const b of BEAMS) {
      const s = ctx.sense(b)
      if (s.hit && s.distance <= w) clear = false
    }
    // a PLC that drives this tag is watching a real curtain (Watch only): the lamps show what that curtain reports
    if (ctx.params.tag && ctx.tagDriven(ctx.params.tag)) clear = !!ctx.readTag(ctx.params.tag)
    ctx.lamps.ossd = clear
    ctx.lamps.stop = !clear
    ctx.lamps.muting = !!ctx.params.mutingLampTag && ctx.readTag(ctx.params.mutingLampTag)
    if (ctx.params.tag) ctx.writeTag(ctx.params.tag, clear)
  },
})
