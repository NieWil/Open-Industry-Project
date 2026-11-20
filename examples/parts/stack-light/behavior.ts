// Stack Light — a parametric 1-8 segment signal tower. Each segment is an emissive lens lamp; one integer
// bitmask lights them — bit i (LSB = the bottom segment) lights segment i+1, colours cycling bottom-up
// green → amber → red → blue → white. The bitmask comes from a PLC INT tag while a program actually DRIVES it
// (ctx.tagDriven); any other time the authored 'value' param drives the same lamps. Bits above the
// segment count are masked off. Use/click is a LAMP TEST: every tier lights briefly, then the pattern returns.
//
// The tower: a black housing (foot + stem + base collar + seam rings + floating cap under a low cone roof)
// carrying 1-8 tinted lens tiers around a pale inner core. 'segments' drives the tower height: the cap, core,
// seam rings and the hidden collision shell all track it.
//
// Per-tier links (not array-links): each lens needs its own emissive colour + lamp name, which an array's
// shared shape can't express, so all 8 are built and the unused ones collapse out of sight (see `tier`).
// That costs no draws: the host folds same-shape lamp links into ONE instanced lamp bank
// (src/render/parts/lampBank.ts), so the 8 tiers are a single draw however many are in use.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

// ---- geometry (primitive cylinders) ------------------------------------------------------------------------
const MAX_SEGS = 8
const DEF_SEGS = 3

const LAMPS = ['seg1', 'seg2', 'seg3', 'seg4', 'seg5', 'seg6', 'seg7', 'seg8']
// How long a lamp test holds. Keep it under half a second: the stopped editor's C preview (sim/idlePose.ts
// recordPress) stops watching a press after 30 still ticks, and a test still lit then reads as a LATCH, which
// the preview answers with a second press.
const LAMP_TEST_S = 0.4
let test = 0 // seconds of lamp test left

definePart({
  interactive: true, // Use/click runs a lamp test
  lamps: LAMPS,
  params: {
    segments: { type: 'number', default: DEF_SEGS, min: 1, max: MAX_SEGS, step: 1, label: 'Tiers', desc: 'How many lamp tiers are stacked. Colours are fixed and cycle bottom-up: green, amber, red, blue, white.' },
    value: { type: 'number', bits: 'segments', default: 1, min: 0, max: 255, step: 1, label: 'Lit tiers', group: 'Start state', desc: 'Which tiers are lit, one box per tier, the BOTTOM tier first (bit 0 of the bitmask the tag carries: 1 lights green, 2 amber, 3 both). Bits above the segment count are masked off. A program driving the tag below replaces this value.' },
    // autoWhenDriven: this tag COMMANDS the lamps (the step's auto gate reads it), so a program driving it
    // owns the device — the pilot prompt shows "In auto - PLC controlled" instead of a dead "Use".
    tag: { type: 'tag', dir: 'in', stType: 'INT', autoWhenDriven: true, setpointFor: 'value', default: '', label: 'Lamp bitmask tag', group: 'Comms', desc: 'The program writes the lit-tier bitmask here. While it drives the tag it OWNS the light, so the Value field above becomes a read-only readout and a hand Use is refused with "In auto - PLC controlled".' },
  },
  step(ctx) {
    const segs = Math.min(MAX_SEGS, Math.max(1, Math.round(ctx.params.segments)))
    const all = (1 << segs) - 1
    // Output ownership (ctx.tagDriven): the tag lights the lamps only while a controller actually drives it —
    // gating on the tag NAME instead would pin the tower to a dead tag the moment one was typed. Release falls
    // back to the authored pattern instead of freezing the last commanded one (right for an indicator).
    const auto = ctx.tagDriven(ctx.params.tag)
    // Use = a lamp test, in hand mode only: while a program drives the tag it owns the light, and the press is
    // refused ("In auto - PLC controlled"). It never changes the pattern — that is the Value field's, or the PLC's.
    if (ctx.used() && !auto) test = LAMP_TEST_S
    test = Math.max(0, test - ctx.dt)
    const v = (auto ? ctx.readNumber(ctx.params.tag) : Math.round(ctx.params.value)) & all // mask to the segment count
    ctx.report('value', v) // the pattern (masked), which is what 'value' means; a lamp test doesn't change it
    const lit = test > 0 ? all : v
    for (let i = 0; i < LAMPS.length; i++) ctx.lamps[LAMPS[i]] = i < segs && ((lit >> i) & 1) === 1
  },
})
