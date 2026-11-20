// Not offered in the catalog any more: the Spawner (examples/parts/box-spawner) with Product: Pallet and Release: On
// each enable does what this does (core/builtInVersion.ts UNLISTED_BUILT_INS). Kept so a project that uses it runs.
//
// Pallet Spawner — a magazine that emits pallets, or another product. Demonstrates ctx.spawn by product: a rate timer
// emits the product every 60/palletsPerMinute seconds via ctx.spawn({ part, params }); the host creates that part's
// body at the part's pose, as if placed. A Pallet takes the size, colour and mass set here. A pilot "Use" toggles the line on/off (a runtime latch, so it resets on
// stop/reload); pallets drop at the exact spawn point (no positional scatter). Optionally gated by a conveyor
// interlock (conveyorId → ctx.conveyorRunning) or a PLC run tag.
//
// A magazine is COMMANDED rather than paced, so the gate RE-ARMS it: every time it is enabled the next pallet
// drops on that first eligible tick and the rate only paces it while it stays enabled. That is what makes the
// usual wiring - a controller pulsing the run tag for less than one period per pallet change - dispense exactly
// one pallet, every time. Carry the countdown across the hold instead and only the FIRST pulse ever dispenses
// (the timer happens to start at zero); each later pulse just takes its own length off a period that never
// reaches zero, so the line silently runs on with no pallet under it.

let countdown = 0 // seconds until the next spawn
let armed = false // drop on the first eligible tick after each enable, not a period later
let usedOff = false
let spawned = 0

// Publish what this feed has dispensed, every tick (a display not republished goes blank): the infeed half
// of the line's numbers, which a despawner's count is the other half of - the two differ by the work in
// progress. It counts REQUESTS: past the physics engine's 10,240-body table a spawn is skipped, uncounted
// by the host but still counted here.
function publish(ctx) {
  ctx.display('spawned', spawned)
  if (ctx.params.countTag) ctx.writeNumber(ctx.params.countTag, spawned)
}

function hexRgb(hex) {
  const h = (hex || '').replace('#', '')
  if (h.length < 6) return [1, 1, 1]
  const v = (i) => { const n = parseInt(h.slice(i, i + 2), 16); return Number.isFinite(n) ? n / 255 : 0.5 }
  return [v(0), v(2), v(4)]
}

definePart({
  interactive: true, // a pilot "Use" toggles the line
  params: {
    palletsPerMinute: { type: 'number', unit: '/min', default: 12, min: 0, max: 200, step: 1, label: 'Feed rate', desc: 'Pallets per minute. 0 halts the magazine without pausing the part.' },
    fixedRate: { type: 'boolean', default: true, label: 'Fixed rate (off = ±50% jitter)', desc: 'On, pallets arrive on an exact metronome. Off, each gap is randomised between half and one-and-a-half times the nominal period.' },
    // WHITE = untinted, matching oip.pallet's own default: the colour multiplies the pallet wood model
    // rather than replacing it, so any non-white default makes a dispensed pallet a different colour from
    // every hand-placed one beside it. It used to default to '#8a5a2b', which is why the demo's magazine
    // dropped visibly dark pallets onto a build deck stocked with pale ones.
    product: { type: 'string', product: true, default: 'oip.pallet', label: 'Product', desc: 'The cargo part every drop is, from the parts in the project: dispensed as if placed, with its own size, colour, mass and product attributes. A Pallet takes the size, colour and mass below.' },
    palletSize: {
      type: 'enum', default: '1219x1016', label: 'Pallet size', group: 'Pallet', visibleWhen: { param: 'product', is: 'oip.pallet' },
      desc: 'Footprint of every dispensed pallet, from the six of ISO 6780 (the same choice as the Size of a placed Pallet).',
      options: [
        { value: '1219x1016', label: '48 x 40 in (1219 x 1016 mm)' },
        { value: '1200x800', label: '1200 x 800 mm' },
        { value: '1200x1000', label: '1200 x 1000 mm' },
        { value: '1165x1165', label: '1165 x 1165 mm' },
        { value: '1100x1100', label: '1100 x 1100 mm' },
        { value: '1067x1067', label: '1067 x 1067 mm' },
      ],
    },
    palletColor: { type: 'color', default: '#ffffff', label: 'Pallet color', group: 'Pallet', visibleWhen: { param: 'product', is: 'oip.pallet' }, desc: 'Tint multiplied over the pallet wood model. Leave it white unless you want dispensed pallets to read differently from hand-placed ones beside them.' },
    mass: { type: 'number', default: 25, min: 1, max: 200, step: 1, label: 'Mass (kg)', group: 'Pallet', visibleWhen: { param: 'product', is: 'oip.pallet' }, desc: 'Mass given to every dispensed pallet, before anything is stacked on it.' },
    disable: { type: 'boolean', default: false, label: 'Paused', desc: 'Stop dispensing entirely. Use (C, or E while walking) is a separate hand stop: it pauses and resumes the magazine during a run without changing this setting, and is cleared when the run stops.' },
    conveyorId: { type: 'partRef', default: '', label: 'Pause when conveyor stopped', desc: 'Interlock: while the named conveyor is stopped, this spawner holds. Wire that conveyor to the PLC and the feed gates itself, with no tag of its own.' },
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Run tag (spawn only while true)', group: 'Comms', desc: 'Gate the magazine from the program. Note this only takes over once a program actually DRIVES the tag - until then the spawner keeps running, so a merely-declared tag is not a stopped feed.' },
    countTag: { type: 'tag', dir: 'out', stType: 'DINT', default: '', label: 'Spawned count tag', group: 'Comms', desc: 'Running total of pallets this spawner has dispensed. Subtract the despawner counts to get the work in progress.' },
  },
  step(ctx) {
    const p = ctx.params
    if (ctx.used()) usedOff = !usedOff
    // hold while a linked conveyor is stopped, or while a controller DRIVES the run tag de-energized
    // (ctx.tagDriven = output ownership; gating on the tag NAME alone would brick the spawner the moment one
    // was typed — the hand Use above can only latch it MORE off). Undriven, the authored/hand state rules.
    const stopped = !ctx.conveyorRunning(p.conveyorId) || (ctx.tagDriven(p.runTag) && !ctx.readTag(p.runTag))
    if (p.disable || usedOff || stopped || p.palletsPerMinute <= 0) { armed = false; publish(ctx); return }
    const period = 60 / p.palletsPerMinute
    // held off = disarmed, so this is the first eligible tick of a fresh command: drop now, then pace
    if (!armed) { armed = true; countdown = 0 }
    countdown -= ctx.dt
    let n = 0
    while (countdown <= 0 && n < 4) {
      countdown += p.fixedRate ? period : Math.max(ctx.dt, period * (0.5 + ctx.rng()))
      n++
      if (p.product === 'oip.pallet') ctx.spawn({ part: p.product, params: { size: p.palletSize }, color: hexRgb(p.palletColor), mass: p.mass, offset: [0, -0.2, 0] })
      else ctx.spawn({ part: p.product, offset: [0, -0.2, 0] })
      spawned++
    }
    publish(ctx)
  },
})
