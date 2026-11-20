/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { validateScene } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// The committed Turntable Conveyor (examples/parts/turntable-conveyor) driven headless: its enable tag is a safety
// stop that brakes a turn in hand, holds it, and finishes it when the tag comes back.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const D2R = Math.PI / 180

function turntableWorld(): SimWorld {
  const dir = join(repo, 'examples', 'parts', 'turntable-conveyor')
  const manifest = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as PackageManifest
  const pkg = buildPackage(manifest, readFileSync(join(dir, 'behavior.ts'), 'utf8'))
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [pkg],
    parts: [{ id: 'tt', type: 'part', packageId: manifest.id, position: [0, 1, 0], rotationY: 0, params: { angleTag: 'Ang', enableTag: 'En', doneTag: 'Done', rotationSpeedDeg: 20 } }],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

describe('turntable enable', () => {
  it('brakes a turn in hand and holds it while its enable is down, waits to begin one, and finishes when it is back', () => {
    const w = turntableWorld()
    const deg = (): number => (w.frame().joints?.['tt']?.['rotate'] ?? 0) / D2R
    const done = (): unknown => w.frame().tags?.['tt']?.['Done']
    // a program drives the enable tag: it counts only while driven
    w.setBehaviorDrivenTags(['En'])
    const run = (inputs: Record<string, number | boolean>, steps: number): void => {
      w.setBehaviorInputTags(inputs)
      for (let s = 0; s < steps; s++) w.step()
    }
    run({ Ang: 0, En: true }, 10)
    expect(done()).toBe(true)
    // commanded while held: it does not begin
    run({ Ang: 90, En: false }, 60)
    expect(deg()).toBe(0)
    expect(done()).toBe(false)
    // enabled: it turns; dropped partway, it stops within a few degrees and holds there
    for (let s = 0; s < 10 * 60 && deg() < 40; s++) run({ Ang: 90, En: true }, 1)
    const atDrop = deg()
    expect(atDrop).toBeGreaterThanOrEqual(40)
    run({ Ang: 90, En: false }, 30)
    const held = deg()
    expect(held - atDrop).toBeGreaterThan(0)
    expect(held - atDrop).toBeLessThan(4)
    run({ Ang: 90, En: false }, 3 * 60)
    expect(deg()).toBe(held)
    expect(done()).toBe(false)
    // back: it finishes the turn
    run({ Ang: 90, En: true }, 10 * 60)
    expect(deg()).toBeCloseTo(90, 3)
    expect(done()).toBe(true)
    w.dispose()
  })

  it('a named enable tag no program drives does not hold the deck, like every run-style tag', () => {
    const w = turntableWorld()
    const deg = (): number => (w.frame().joints?.['tt']?.['rotate'] ?? 0) / D2R
    // En reads FALSE, but nothing drives it, so the deck is enabled and turns to the commanded angle
    w.setBehaviorInputTags({ Ang: 90, En: false })
    for (let s = 0; s < 10 * 60; s++) w.step()
    expect(deg()).toBeCloseTo(90, 3)
    w.dispose()
  })
})
