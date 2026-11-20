import { beforeEach, describe, expect, it } from 'vitest'
import type { PartPackage } from './partPackage'
import { PACKAGE_FORMAT } from './partPackage'
import {
  clearPackages,
  getPackage,
  onPackagesChanged,
  packageRev,
  registerPackage,
  registerScenePackages,
  unregisterPackage,
} from './partRegistry'

// The registry's change-detection contract, which the hot-reload seam relies on.
// A content-identical re-register is a silent no-op (no listener fan-out, no rev bump). The dev-HMR sweep rebuilds
// every bundled part on any one-file save, so only the part that actually changed reaches the render/sim reload seam.
// A real change notifies and bumps the rev that partSignature folds in.

const pkg = (id: string, behavior: string, extra?: Partial<PartPackage>): PartPackage =>
  ({ format: PACKAGE_FORMAT, id, name: id, params: {}, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } }, behavior, ...extra }) as unknown as PartPackage

describe('partRegistry change detection (rev + no-op re-register)', () => {
  beforeEach(clearPackages)

  it('a content-identical re-register is silent: no notify, no rev bump, original object kept', () => {
    const events: string[] = []
    const off = onPackagesChanged((id) => events.push(id))
    const original = pkg('p.a', 'definePart({})')
    expect(registerPackage(original, true)).toBe(true)
    const rev = packageRev('p.a')
    expect(rev).toBeGreaterThan(0)

    // a fresh object with identical content - exactly what the HMR sweep rebuilds for unchanged parts
    expect(registerPackage(pkg('p.a', 'definePart({})'), true)).toBe(false)
    expect(events).toEqual(['p.a'])
    expect(packageRev('p.a')).toBe(rev)
    expect(getPackage('p.a')).toBe(original) // the registered object survives a no-op replace
    off()
  })

  it('a content change notifies and bumps the rev', () => {
    const events: string[] = []
    const off = onPackagesChanged((id) => events.push(id))
    registerPackage(pkg('p.a', 'definePart({})'))
    const rev = packageRev('p.a')
    expect(registerPackage(pkg('p.a', 'definePart({ step() {} })'))).toBe(true)
    expect(events).toEqual(['p.a', 'p.a'])
    expect(packageRev('p.a')).toBeGreaterThan(rev)
    off()
  })

  it('re-registering after unregister gets a fresh, never-repeated rev', () => {
    const p = pkg('p.a', 'definePart({})')
    registerPackage(p)
    const rev = packageRev('p.a')
    unregisterPackage('p.a')
    expect(packageRev('p.a')).toBe(0)
    registerPackage(p)
    expect(packageRev('p.a')).toBeGreaterThan(rev) // the counter is global - a rev can't repeat
  })

  it('unregister clears authoritative status: a scene snapshot of the id can register again', () => {
    registerPackage(pkg('p.user', 'v2'), true) // the user's own library copy
    unregisterPackage('p.user') // deleted from the library
    registerScenePackages([pkg('p.user', 'v1')]) // a scene that embeds the old snapshot
    expect(getPackage('p.user')?.behavior).toBe('v1') // not skipped: the scene stays self-contained
  })

  it('registerScenePackages still skips authoritative ids and diff-registers the rest', () => {
    const events: string[] = []
    registerPackage(pkg('p.mine', 'v2'), true) // the locally-edited authoritative copy
    registerPackage(pkg('p.foreign', 'v1'))
    const off = onPackagesChanged((id) => events.push(id))
    registerScenePackages([
      pkg('p.mine', 'v1'), // stale scene snapshot of an authoritative id → ignored
      pkg('p.foreign', 'v1'), // identical content → silent no-op
      pkg('p.new', 'v1'), // genuinely new → registers
    ])
    expect(events).toEqual(['p.new'])
    expect(getPackage('p.mine')?.behavior).toBe('v2')
    off()
  })
})
