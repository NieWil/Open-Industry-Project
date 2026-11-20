/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest'
import { create, destroy, stepDirect } from './embeddedBehavior'
import { IdleUseSession } from './idlePose'
import type { BehaviorOutput } from './embeddedBehavior'

// The committed stack-light behavior (examples/parts/stack-light), driven directly through the embeddable
// runtime (no Jolt/world). Pins output ownership (ctx.tagDriven) on the lamp bitmask: the tag lights the
// tower only while a controller actually drives it, and the authored 'value' param applies any other time, where
// a hand Use/click runs a lamp test (every tier briefly, then the pattern back) without changing the pattern.
// Gating on the truthiness of the tag name would not do: merely typing a tag would put it in the dead-tag state,
// every lamp dark and hand Use inert. Same seam as the diverter/blade stop/chain transfer (src/plc/DEVICE-IO.md).
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const SOURCE = BEHAVIORS['../../examples/parts/stack-light/behavior.ts']!.replace(/\r\n/g, '\n')

const DT = 1 / 60

describe('stack light lamp ownership (hand vs auto)', () => {
  let h = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })

  // `driven` is keyed by presence (ctx.tagDriven reads the key, not the value)
  const tick = (opts: { used?: boolean; tag?: number; driven?: boolean } = {}): BehaviorOutput =>
    stepDirect(h, {
      simTime: 0,
      position: [0, 0, 0],
      forward: [1, 0, 0],
      tags: { Tower: opts.tag ?? 0 },
      driven: opts.driven === true ? { Tower: opts.tag ?? 0 } : {},
      used: opts.used === true,
    }, DT)!
  /** lit segments as a bitmask, so expectations read like the authored `value` */
  const lit = (out: BehaviorOutput): number => {
    let v = 0
    for (let i = 0; i < 8; i++) if (out.lamps[`seg${i + 1}`] === true) v |= 1 << i
    return v
  }

  it('a tag set but nothing driving it: the authored value lights the tower', () => {
    h = create(SOURCE, JSON.stringify({ segments: 3, value: 5, tag: 'Tower' }))
    expect(lit(tick())).toBe(5) // was 0 - pinned to a tag no controller owns
  })

  it('…and a hand Use runs a lamp test: every tier lit briefly, then the same pattern back', () => {
    h = create(SOURCE, JSON.stringify({ segments: 3, value: 2, tag: 'Tower' }))
    expect(lit(tick())).toBe(2)
    expect(lit(tick({ used: true }))).toBe(7) // all three tiers
    let t = 0
    while (lit(tick()) === 7 && t < 120) t++
    expect(t).toBeGreaterThan(10) // long enough to see
    expect(lit(tick())).toBe(2) // back to the authored pattern, not stepped on from it
  })

  it('a stopped-scene Use runs one lamp test that comes home by itself, and so holds nothing afterwards', () => {
    // A replayed press counter flickers the pattern after next on a second press: a stopped Use must be one
    // press, played live.
    const u = IdleUseSession.open(SOURCE, { segments: 3, value: 2, tag: '' })!
    u.press()
    const seen: number[] = []
    for (let i = 0; i < 240; i++) {
      u.advance(1 / 60)
      seen.push(lit({ lamps: u.pose.lamps ?? {} } as BehaviorOutput))
    }
    expect(new Set(seen)).toEqual(new Set([7, 2])) // the test, then home - nothing else
    expect(seen[0]).toBe(7)
    expect(seen[seen.length - 1]).toBe(2)
    expect(u.atRest).toBe(true)
    u.dispose()
  })

  it('a driven tag owns the lamps and a hand Use is ignored while owned', () => {
    h = create(SOURCE, JSON.stringify({ segments: 3, value: 5, tag: 'Tower' }))
    expect(lit(tick({ tag: 2, driven: true }))).toBe(2) // the program's bitmask, not the authored 5
    expect(lit(tick({ tag: 2, driven: true, used: true }))).toBe(2) // press ignored while owned
  })

  it('releasing ownership falls back to the authored pattern (an indicator displays, it does not latch)', () => {
    h = create(SOURCE, JSON.stringify({ segments: 3, value: 5, tag: 'Tower' }))
    expect(lit(tick({ tag: 2, driven: true }))).toBe(2)
    expect(lit(tick())).toBe(5) // detach → back to the authored value, not frozen at the last command
  })

  it('with no tag named, the authored value rules whatever else is driven', () => {
    h = create(SOURCE, JSON.stringify({ segments: 3, value: 5, tag: '' }))
    expect(lit(tick({ tag: 2, driven: true }))).toBe(5)
  })

  it('bits above the segment count stay masked off, driven or not', () => {
    h = create(SOURCE, JSON.stringify({ segments: 2, value: 255, tag: 'Tower' }))
    expect(lit(tick())).toBe(3) // authored 255 masked to 2 segments
    expect(lit(tick({ tag: 255, driven: true }))).toBe(3) // and the same for a driven command
  })
})
