/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest'
import { create, destroy, stepDirect } from './embeddedBehavior'
import type { BehaviorOutput } from './embeddedBehavior'

// The committed push-button behavior (examples/parts/push-button), driven directly through the embeddable
// runtime (no Jolt/world). Pins the lamp source, which is declared rather than inferred: inferring it (lit from
// `lampTag` when bound, else echoing the press) leaves two real devices unauthorable, a plain unlit button and a
// lamp lit by anything other than this button's own press. On real
// 22 mm gear the light block is a separate module with its own terminals; `lampSource` makes that circuit
// declared. The press-side behaviour (depress, momentary pulse, NC output) must be untouched by all four.
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const SOURCE = BEHAVIORS['../../examples/parts/push-button/behavior.ts']!.replace(/\r\n/g, '\n')

const DT = 1 / 60

describe('push button behavior - the lamp is its own circuit', () => {
  let h = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })

  const open = (params: Record<string, unknown>) => { h = create(SOURCE, JSON.stringify(params)) }
  const tick = (used = false, tags: Record<string, boolean> = {}): BehaviorOutput =>
    stepDirect(h, { simTime: 0, position: [0, 0, 0], forward: [0, 0, 1], tags, used }, DT)!

  it("'press' (the default) echoes the button, so a freshly placed part still visibly lights", () => {
    open({ momentary: false }) // maintained, so the press latches instead of expiring
    expect(tick().lamps['cap']).toBe(false)
    expect(tick(true).lamps['cap']).toBe(true)
    expect(tick().lamps['cap']).toBe(true) // held by the latch, not by the press tick
  })

  it("'on' lights the cap with no PLC and no press - the power-on indicator wiring", () => {
    open({ lampSource: 'on' })
    expect(tick().lamps['cap']).toBe(true)
  })

  it("'off' stays dark THROUGH a press - a button with no light block fitted", () => {
    open({ lampSource: 'off', momentary: false })
    expect(tick(true).lamps['cap']).toBe(false)
    expect(tick().lamps['cap']).toBe(false)
  })

  it("'tag' hands the lamp to the program: the tag lights it, the press does not", () => {
    open({ lampSource: 'tag', lampTag: 'RunLamp', momentary: false })
    expect(tick(true, { RunLamp: false }).lamps['cap']).toBe(false) // pressed, but the program says dark
    expect(tick(false, { RunLamp: true }).lamps['cap']).toBe(true) // released, but the program says lit
  })

  it("'tag' with nothing wired reads dark - an unbound tag must not fall back to the press", () => {
    open({ lampSource: 'tag', momentary: false }) // no lampTag
    expect(tick(true).lamps['cap']).toBe(false)
  })

  it('the cap depress and the tag output are unaffected by the lamp source', () => {
    for (const lampSource of ['press', 'tag', 'on', 'off']) {
      open({ lampSource, momentary: false, tag: 'Start' })
      expect(tick().subPoses['cap']?.position?.[2] ?? 0).toBe(0)
      const down = tick(true)
      expect(down.subPoses['cap']!.position![2]).toBeLessThan(0) // travels into the housing
      expect(down.tags['Start']).toBe(true)
      destroy(h)
      h = 0
    }
  })

  it('a normally-closed contact still reads TRUE at rest under an always-on lamp', () => {
    open({ lampSource: 'on', normallyClosed: true, tag: 'Stop' })
    const out = tick()
    expect(out.tags['Stop']).toBe(true)
    expect(out.lamps['cap']).toBe(true)
  })
})
