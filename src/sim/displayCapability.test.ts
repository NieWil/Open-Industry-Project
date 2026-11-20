import { afterEach, describe, expect, it } from 'vitest'
import { create, destroy, stepDirect } from './embeddedBehavior'
import type { BehaviorOutput } from './embeddedBehavior'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import { validatePartPackage } from '../core/parts/partValidate'

// `ctx.display` - a part publishing a named value for its own live caption (`label.textFrom`) to draw.
//
// The rule pinned here is one a screenshot cannot check: a display is published only when the part
// actually computed it, so a name nothing publishes reads blank rather than 0. An unbound tag reads 0
// through the tag table, so a naive implementation would paint "0" on a plate wired to nothing, which
// looks exactly like a line that is genuinely stopped. The bag is also cleared every tick, so a feed that
// dies goes blank instead of freezing on its last number.

const DT = 1 / 60
const tickWith = (h: number, tags: Record<string, number | boolean> = {}): BehaviorOutput =>
  stepDirect(h, { simTime: 0, position: [0, 0, 0], forward: [1, 0, 0], tags }, DT)!

describe('ctx.display', () => {
  let h = 0
  afterEach(() => {
    if (h > 0) destroy(h)
    h = 0
  })

  it('publishes numbers, booleans and strings under the author\'s own names', () => {
    h = create(`definePart({ step(ctx) { ctx.display('count', 42); ctx.display('run', true); ctx.display('status', 'READY') } })`, '{}')
    const out = tickWith(h)
    expect(out.displays).toEqual({ count: 42, run: true, status: 'READY' })
  })

  it('publishes nothing when the part publishes nothing - blank, not zero', () => {
    h = create(`definePart({ step() {} })`, '{}')
    expect(Object.keys(tickWith(h).displays)).toHaveLength(0)
  })

  it('clears every tick, so a display that stops being published goes blank rather than stale', () => {
    h = create(`definePart({ step(ctx) { if (ctx.readTag('feed')) ctx.display('count', 7) } })`, '{}')
    expect(tickWith(h, { feed: true }).displays['count']).toBe(7)
    expect(tickWith(h, { feed: false }).displays['count']).toBeUndefined()
  })

  it('drops a non-finite number instead of publishing NaN - a broken value must not read as a measurement', () => {
    h = create(`definePart({ step(ctx) { ctx.display('x', 0 / 0); ctx.display('y', 1 / 0) } })`, '{}')
    expect(Object.keys(tickWith(h).displays)).toHaveLength(0)
  })

  it('ignores an empty display name (nothing could ever bind to it)', () => {
    h = create(`definePart({ step(ctx) { ctx.display('', 1) } })`, '{}')
    expect(Object.keys(tickWith(h).displays)).toHaveLength(0)
  })

  it('caps a published string, so a per-tick display can\'t become an unbounded worker payload', () => {
    h = create(`definePart({ step(ctx) { ctx.display('s', 'x'.repeat(500)) } })`, '{}')
    expect(String(tickWith(h).displays['s']).length).toBe(64)
  })

  it('is separate from ctx.report - a display is a caption, a report is an effective param value', () => {
    h = create(`definePart({ params: { speed: { type: 'number', default: 1 } }, step(ctx) { ctx.report('speed', 0.5); ctx.display('speed', 0.5) } })`, '{}')
    const out = tickWith(h)
    expect(out.values['speed']).toBe(0.5)
    expect(out.displays['speed']).toBe(0.5)
  })
})

describe('label.textFrom validation', () => {
  const labelPkg = (shape: Record<string, unknown>): unknown => ({
    format: PACKAGE_FORMAT,
    id: 'demo.plate',
    name: 'Plate',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: { kind: 'rig', links: [{ name: 'plate', shape: { kind: 'label', ...shape }, offset: [0, 0, 0] }], joints: [], bounds: { length: 1, width: 1, top: 1 } },
  })

  it('accepts a live caption bound to a display name', () => {
    expect(validatePartPackage(labelPkg({ textFrom: 'count', size: [0.2, 0.05] }))).toEqual([])
  })

  it('rejects an empty display name', () => {
    expect(validatePartPackage(labelPkg({ textFrom: '' })).map((p) => p.field)).toContain('geometry.links[0].shape.textFrom')
  })
})
