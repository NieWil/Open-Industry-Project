// A reactive part (definePart's `react`): when the host calls it, and that what it commanded stands in between
// (partSleep.ts).
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import type { SceneJSON } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { validatePart } from './validatePart'
import { SimWorld } from './world'

const Jolt = await initJolt()

const manifest: PackageManifest = {
  id: 'test.reactive-deck',
  name: 'Reactive Deck',
  category: 'Equipment',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } },
}

// counts its calls on a tag, runs its deck while Go is on, and runs on for `hold` more steps after a call that saw Go rise
const source = `
let calls = 0
let left = 0
definePart({
  params: { hold: { type: 'number', default: 0 } },
  react(ctx) {
    calls++
    ctx.writeNumber('Calls', calls)
    if (ctx.rising('Go')) left = ctx.params.hold
    if (left > 0) { left -= 1; ctx.again() }
    const s = ctx.readTag('Go') ? 1 : 0
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
  },
})
`

function worldWith(params: Record<string, unknown> = {}, opts: { wakeAllParts?: boolean } = {}): SimWorld {
  clearPackages()
  const pkg: PartPackage = buildPackage(manifest, source)
  const part = { id: 'p', type: 'part', packageId: pkg.id, position: [0, 1, 0], rotationY: 0, params }
  return new SimWorld(Jolt, { version: SCENE_VERSION, parts: [part], packages: [pkg] } as unknown as SceneJSON, opts)
}
const calls = (w: SimWorld): number => w.behaviorTagWrites().Calls as number
const steps = (w: SimWorld, n: number): void => {
  for (let i = 0; i < n; i++) w.step()
}

describe('a reactive part', () => {
  it('is called on its first step and then only when an input changes', () => {
    const w = worldWith()
    steps(w, 20)
    expect(calls(w)).toBe(1)
    w.setBehaviorInputTags({ Go: true })
    steps(w, 20)
    expect(calls(w)).toBe(2)
    // the same values again are not a change
    w.setBehaviorInputTags({ Go: true })
    steps(w, 5)
    expect(calls(w)).toBe(2)
    w.setBehaviorInputTags({ Go: false })
    steps(w, 5)
    expect(calls(w)).toBe(3)
    w.dispose()
  })

  it('is called on every step while it asks to be, and stops when it stops asking', () => {
    const w = worldWith({ hold: 6 })
    steps(w, 3)
    w.setBehaviorInputTags({ Go: true })
    steps(w, 60)
    // one first call, then the call that saw Go rise and one on each of the 6 steps after it
    expect(calls(w)).toBe(1 + 1 + 6)
    w.dispose()
  })

  it('keeps what it last commanded: a deck it started carries cargo while it is not called', () => {
    const w = worldWith()
    w.spawnBoxAt(-2, 1.2, 0, 0.15, 0.15, 0.15, 0, 5, [1, 1, 1])
    steps(w, 30)
    const x0 = w.frame().positions[0] ?? 0
    w.setBehaviorInputTags({ Go: true })
    steps(w, 90)
    const x1 = w.frame().positions[0] ?? 0
    expect(calls(w)).toBe(2)
    expect(x1 - x0).toBeGreaterThan(1) // 1.5 s at 1 m/s, less the start
    w.dispose()
  })

  it('may be called on any step: with every part woken every step it conveys the same', () => {
    const run = (wakeAllParts: boolean): { x: number; calls: number } => {
      const w = worldWith({}, { wakeAllParts })
      w.spawnBoxAt(-2, 1.2, 0, 0.15, 0.15, 0.15, 0, 5, [1, 1, 1])
      steps(w, 30)
      w.setBehaviorInputTags({ Go: true })
      steps(w, 90)
      const out = { x: w.frame().positions[0] ?? 0, calls: calls(w) }
      w.dispose()
      return out
    }
    const quiet = run(false)
    const woken = run(true)
    expect(woken.calls).toBe(120)
    expect(woken.x).toBe(quiet.x)
  })

  it('has step or react, not both', () => {
    const both = source.replace('react(ctx) {', 'step(ctx) {},\n  react(ctx) {')
    const r = validatePart(manifest, both)
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => d.message).join(' ')).toMatch(/both step\(ctx\) and react\(ctx\)/)
    expect(validatePart(manifest, source).ok).toBe(true)
  })
})
