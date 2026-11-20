/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest'
import { create, destroy, stepDirect } from './embeddedBehavior'
import type { BehaviorOutput } from './embeddedBehavior'

// The committed chain-transfer behavior (examples/parts/chain-transfer), driven directly through the
// embeddable runtime (no Jolt/world). Pins the pop-up lift motion that placement parity needs:
//   - the pop-up lift tweens over the `raiseTime` param (0.095 m over its 0.15 s default), not a one-tick jump;
//   - a pilot Use/click toggles the pop-up state on and off;
//   - the conveys-deck surface velocity switches between THROUGH (forward +X) and DIVERT (perpendicular +Z) with the pop-up.
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const SOURCE = BEHAVIORS['../../examples/parts/chain-transfer/behavior.ts']!.replace(/\r\n/g, '\n')

const RAISE = 0.095 // pop-up active position
const RAISE_SECONDS = 0.15 // lift tween duration - the `raiseTime` param's default, applied when none is authored
const DT = 1 / 60

describe('chain transfer behavior (tweened pop-up lift)', () => {
  let h = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })

  const tick = (used = false): BehaviorOutput =>
    stepDirect(h, { simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags: {}, used }, DT)!

  it('seeds at the authored state on the first step (no spurious slew), lowered by default', () => {
    h = create(SOURCE, '{}')
    expect(tick().joints['lift']).toBe(0)
    destroy(h)
    h = create(SOURCE, JSON.stringify({ raised: true }))
    expect(tick().joints['lift']).toBeCloseTo(RAISE, 10) // authored raised → starts raised, no ramp
  })

  it('a Use/click pops the chains up over ~0.15 s of sim time, not in one tick', () => {
    h = create(SOURCE, '{}')
    expect(tick().joints['lift']).toBe(0) // settled lowered
    // Use → the lift begins to rise at RAISE/0.15 per second
    let out = tick(true)
    expect(out.joints['lift']).toBeCloseTo((RAISE / RAISE_SECONDS) * DT, 10)
    expect(out.joints['lift']).toBeLessThan(RAISE * 0.2) // nowhere near the top in one tick
    // mid-stroke after ~half the tween
    for (let i = 0; i < 3; i++) out = tick()
    expect(out.joints['lift']).toBeCloseTo((RAISE / RAISE_SECONDS) * DT * 4, 10)
    expect(out.joints['lift']).toBeLessThan(RAISE)
    // full stroke completes at 0.15 s (9 ticks at 60 Hz), then holds
    for (let i = 0; i < 5; i++) out = tick()
    expect(out.joints['lift']).toBeCloseTo(RAISE, 10)
    expect(tick().joints['lift']).toBeCloseTo(RAISE, 10)
  })

  // A geared lift, not a fixed one: a cell with a short cycle wants the chains up before the deck is allowed to
  // drive, and the program's own "wait the stroke out" dwell is sized against this number (see the demo's Raised
  // timer). An authored value has to actually change the rate, or that dwell is guarding a stroke that is still
  // running underneath it.
  it('honours an authored raiseTime instead of the default rate', () => {
    h = create(SOURCE, JSON.stringify({ raiseTime: 0.05 }))
    expect(tick().joints['lift']).toBe(0)
    const out = tick(true)
    expect(out.joints['lift']).toBeCloseTo((RAISE / 0.05) * DT, 10) // three times the default rate
    for (let i = 0; i < 3; i++) tick()
    expect(tick().joints['lift']).toBeCloseTo(RAISE, 10) // topped out inside 0.05 s, not 0.15
  })

  it('a second Use/click lowers the chains at the same rate (use() toggles)', () => {
    h = create(SOURCE, '{}')
    tick(true) // raise…
    for (let i = 0; i < 12; i++) tick() // …to the top
    let out = tick(true) // Use again → lowering
    expect(out.joints['lift']).toBeCloseTo(RAISE - (RAISE / RAISE_SECONDS) * DT, 10)
    for (let i = 0; i < 12; i++) out = tick()
    expect(out.joints['lift']).toBe(0)
  })

  it('the deck surface velocity switches THROUGH (forward +X) ↔ DIVERT (perpendicular +Z) with the pop-up', () => {
    h = create(SOURCE, JSON.stringify({ speed: 2 }))
    // lowered: THROUGH along the part's forward (+X, the main line - like every other conveyor)
    let out = tick()
    expect(out.surfaceVelocity![0]).toBeCloseTo(2, 10)
    expect(out.surfaceVelocity![2]).toBeCloseTo(0, 10)
    // raised (Use): DIVERT 90° off the line, along the chains (perpendicular to forward). The sign is pinned, not
    // absolute-valued: forward +X sends the load to the part's −Z, so which side of the line a transfer discharges
    // onto is part of its contract. The demo's layer table is placed on that side, and flipping it silently would
    // shift rows into open floor.
    out = tick(true)
    expect(out.surfaceVelocity![0]).toBeCloseTo(0, 10)
    expect(out.surfaceVelocity![2]).toBeCloseTo(-2, 10)
  })
})

// Output ownership (ctx.tagDriven): the pop-up tag commands the chains only while a controller actually
// drives it. Gating on `popupTag` (the truthiness of the tag name) would pin the transfer to
// any typed tag, and a hand Use would go dead even with no program attached. Same handoff the blade stop and
// diverter ship (src/plc/DEVICE-IO.md); the generic guard is idlePose.test.ts, the
// end-to-end one e2e/verify-tag-driven-auto.mjs.
describe('chain transfer pop-up ownership (hand vs auto)', () => {
  let h = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })

  const TAGGED = JSON.stringify({ popupTag: 'Popup', speed: 2 })
  // one tick. `driven` is keyed by presence (ctx.tagDriven reads the key, not the value), so a tag is only
  // "owned" when the driven table carries it - exactly how the host projects a program's outputs.
  const tick = (opts: { used?: boolean; tag?: boolean; driven?: boolean } = {}): BehaviorOutput =>
    stepDirect(h, {
      simTime: 0,
      position: [0, 0, 0],
      forward: [1, 0, 0],
      tags: { Popup: opts.tag === true },
      driven: opts.driven === true ? { Popup: opts.tag === true } : {},
      used: opts.used === true,
    }, DT)!
  const press = (opts: { tag?: boolean; driven?: boolean } = {}): BehaviorOutput => tick({ ...opts, used: true })
  /** run the tween out (12 ticks > the 9-tick stroke) and return the final frame */
  const settle = (opts: { tag?: boolean; driven?: boolean } = {}): BehaviorOutput => {
    let out = tick(opts)
    for (let i = 0; i < 12; i++) out = tick(opts)
    return out
  }

  it('a tag set but nothing driving it: a hand Use still pops the chains', () => {
    h = create(SOURCE, TAGGED)
    expect(tick().joints['lift']).toBe(0)
    press() // pinned to a tag no controller owns, which must not leave Use dead
    expect(settle().joints['lift']).toBeCloseTo(RAISE, 10)
    press()
    expect(settle().joints['lift']).toBe(0)
  })

  it('a driven tag seizes the pop-up, and a hand Use is ignored while owned', () => {
    h = create(SOURCE, TAGGED)
    press() // hand-raise first…
    expect(settle().joints['lift']).toBeCloseTo(RAISE, 10)
    // …then a program declaring the tag attaches commanding false: auto overwrites the hand latch
    expect(settle({ tag: false, driven: true }).joints['lift']).toBe(0)
    // a press while owned is undone the same tick - the chains stay down
    press({ tag: false, driven: true })
    expect(settle({ tag: false, driven: true }).joints['lift']).toBe(0)
    // and the program raises them with no hand press at all
    expect(settle({ tag: true, driven: true }).joints['lift']).toBeCloseTo(RAISE, 10)
  })

  it('releasing ownership is bumpless - the chains hold, then hand control returns', () => {
    h = create(SOURCE, TAGGED)
    expect(settle({ tag: true, driven: true }).joints['lift']).toBeCloseTo(RAISE, 10)
    expect(settle().joints['lift']).toBeCloseTo(RAISE, 10) // detach: holds its last commanded state
    press()
    expect(settle().joints['lift']).toBe(0) // hand works again
  })

  it('the divert direction follows the driven tag, not only the hand latch', () => {
    h = create(SOURCE, TAGGED)
    expect(tick({ tag: false, driven: true }).surfaceVelocity![0]).toBeCloseTo(2, 10) // THROUGH
    const out = tick({ tag: true, driven: true })
    expect(out.surfaceVelocity![0]).toBeCloseTo(0, 10)
    expect(Math.abs(out.surfaceVelocity![2])).toBeCloseTo(2, 10) // DIVERT, on the tag alone
  })
})
