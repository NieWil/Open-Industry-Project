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

const f4 = (n) => +n.toFixed(4)

// ---- colours (sRGB sources → linear rig values) ------------------------------------------------------------
const s2l = (c) => f4(c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const hex2lin = (hex) => [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)]
const HOUSING = hex2lin(0x17181b)
// An unlit lens is DARK, faintly tinted plastic: a trace of its hue over a dark neutral, so a dark tower still
// says which tier is which. Keep the tint faint: AgX (view.ts) keeps dark colours saturated but fades bright ones
// toward pastel, so a strong tint reads MORE colourful than a lit lamp and the eye takes it for the one that's on
// (0.35 did exactly that). A lit lens must be both brighter and more saturated than an unlit one.
const LENS_DARK = hex2lin(0x222428)
const OFF_TINT = 0.14 // how much of the hue shows through an unlit lens
const offLens = (hue) => hue.map((c, k) => f4(LENS_DARK[k] + (c - LENS_DARK[k]) * OFF_TINT))
const CORE = [0.792, 0.819, 0.933] // pale inner core - already linear (GLB "Stack-light" factor)
// segment palette, bottom-up, repeating past 5 (green run-state at the base, red on top)
const PALETTE = [hex2lin(0x2a9d3a), hex2lin(0xf2bd0f), hex2lin(0xd62828), hex2lin(0x2864d6), hex2lin(0xe8e8e8)]
const LIT_OPACITY = f4(235 / 255)

// ---- geometry (primitive cylinders) ------------------------------------------------------------------------
const MAX_SEGS = 8
const DEF_SEGS = 3
const R = 0.035 // lens tier radius
const STAND = 0.196 // pole height before the lit tiers
const BASE = 0.025 // collar height
const SEG = 0.05 // per tier; also the tier pitch
const TOP = 0.014 // cap height
const DOME = 0.012 // the low cone roofing the cap (render-only, like the cap it sits on)
const RING_H = 0.006 // black band straddling each tier seam
const RING_R = R + 0.0015 // a hair wider than the lens so it reads as a ring
const CORE_R = R - 0.006 // the pale core the translucent lit lenses wrap
const FOOT_H = 0.012
const FOOT_R = 0.05 // wider than the lens (R), so the tower stands on its foot instead of balancing on it
const LENS_BOTTOM = STAND + BASE // y of the first lens' bottom
const tierY = (i) => f4(LENS_BOTTOM + (i + 0.5) * SEG) // centre of tier i
const cyl = (radius, height) => ({ kind: 'cylinder', radius, height })

const LAMPS = ['seg1', 'seg2', 'seg3', 'seg4', 'seg5', 'seg6', 'seg7', 'seg8']
// How long a lamp test holds. Keep it under half a second: the stopped editor's C preview (sim/idlePose.ts
// recordPress) stops watching a press after 30 still ticks, and a test still lit then reads as a LATCH, which
// the preview answers with a second press.
const LAMP_TEST_S = 0.4
let test = 0 // seconds of lamp test left

definePart({
  manifest: { id: 'oip.stack-light', name: 'Stack Light', category: 'Devices' },
  interactive: true, // Use/click runs a lamp test
  lamps: LAMPS,
  params: {
    segments: { type: 'number', default: DEF_SEGS, min: 1, max: MAX_SEGS, step: 1, label: 'Tiers', desc: 'How many lamp tiers are stacked. Colours are fixed and cycle bottom-up: green, amber, red, blue, white.' },
    value: { type: 'number', bits: 'segments', default: 1, min: 0, max: 255, step: 1, label: 'Lit tiers', group: 'Start state', desc: 'Which tiers are lit, one box per tier, the BOTTOM tier first (bit 0 of the bitmask the tag carries: 1 lights green, 2 amber, 3 both). Bits above the segment count are masked off. A program driving the tag below replaces this value.' },
    // autoWhenDriven: this tag COMMANDS the lamps (the step's auto gate reads it), so a program driving it
    // owns the device — the pilot prompt shows "In auto - PLC controlled" instead of a dead "Use".
    tag: { type: 'tag', dir: 'in', stType: 'INT', autoWhenDriven: true, setpointFor: 'value', default: '', label: 'Lamp bitmask tag', group: 'Comms', desc: 'The program writes the lit-tier bitmask here. While it drives the tag it OWNS the light, so the Value field above becomes a read-only readout and a hand Use is refused with "In auto - PLC controlled".' },
  },
  rig(p) {
    const n = p.segments
    // a lens tier. Tiers past `segments` hide: the height floors at a sliver and the offset stops at the top seam,
    // y = LENS_BOTTOM + segments·SEG, enclosed by the wider top ring, so nothing shows. The compiler keeps only the
    // clamps that bite inside 1..8 tiers: tier 1 is always lit, so it compiles to fixed numbers, and tier 8's
    // height ceiling sits on the range's end. No path sets `segments` outside 1..8, so nothing reads the rest.
    const tier = (i) => ({
      name: LAMPS[i],
      shape: cyl(R, Math.min(Math.max((n - i) * SEG, 0.0002), SEG)),
      offset: [0, Math.min(LENS_BOTTOM + n * SEG, tierY(i)), 0],
      lamps: [{ emissive: PALETTE[i % PALETTE.length], offColor: offLens(PALETTE[i % PALETTE.length]), opacity: LIT_OPACITY }],
      collision: 'none', // the hidden shell is the collision body
    })
    const stackTop = LENS_BOTTOM + n * SEG // the top seam
    const towerH = stackTop + TOP
    return {
      links: [
        { name: 'foot', shape: cyl(FOOT_R, FOOT_H), offset: [0, FOOT_H / 2, 0], color: HOUSING, collision: 'none' },
        { name: 'stem', shape: cyl(0.013, STAND - FOOT_H), offset: [0, FOOT_H + (STAND - FOOT_H) / 2, 0], color: HOUSING, collision: 'none' },
        { name: 'base', shape: cyl(R, BASE), offset: [0, f4(STAND + BASE / 2), 0], color: HOUSING, collision: 'none' },
        // the pale core spanning the lens stack (height = segments·SEG) - glows through the translucent lit
        // lenses
        {
          name: 'core',
          shape: cyl(CORE_R, n * SEG),
          offset: [0, LENS_BOTTOM + (n * SEG) / 2, 0],
          color: CORE,
          collision: 'none',
        },
        ...LAMPS.map((_, i) => tier(i)),
        // black seam bands: one per tier bottom + the top seam ring
        { name: 'ring', shape: cyl(RING_R, RING_H), offset: [0, LENS_BOTTOM, 0], color: HOUSING, collision: 'none', array: { count: 'segments', step: [0, SEG, 0] } },
        { name: 'ringTop', shape: cyl(RING_R, RING_H), offset: [0, stackTop, 0], color: HOUSING, collision: 'none' },
        { name: 'cap', shape: cyl(R * 0.9, TOP), offset: [0, stackTop + TOP / 2, 0], color: HOUSING, collision: 'none' },
        { name: 'dome', shape: { kind: 'cone', radius: f4(R * 0.9), height: DOME }, offset: [0, stackTop + TOP + DOME / 2, 0], color: HOUSING, collision: 'none' },
        // the collision body: one box spanning the tower. `hidden` renders nothing but still builds the sim body.
        { name: 'shell', shape: { kind: 'box', size: [2 * RING_R, towerH, 2 * RING_R] }, offset: [0, towerH / 2, 0], hidden: true },
      ],
      joints: [],
      bounds: { length: 2 * RING_R, width: 2 * RING_R, top: f4(LENS_BOTTOM + DEF_SEGS * SEG + TOP) },
    }
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
