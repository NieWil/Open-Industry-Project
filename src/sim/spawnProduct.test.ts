/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { CARGO_KIND_TOTE } from '../core/frame'
import { clearPackages } from '../core/parts/partRegistry'
import { partDiagnosticsFor, clearPartDiagnostics } from '../core/parts/partDiagnostics'
import { validateScene } from '../core/scene/scene'
import type { PartPackage } from '../core/parts/partPackage'
import { SCENE_VERSION } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// Spawning a product (ctx.spawn({ part, params })) and counting one (ctx.zone(zone, { part | kind })), through the
// shipped Spawner and Despawner: a spawned tote is the Tote part as if placed, at the size its settings pick, and a
// sink set to count totes counts a tote carrying a case once.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function example(dir: string): PartPackage {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as { id: string; name: string; category?: string; geometry: PackageManifest['geometry'] }
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return buildPackage({ id: rig.id, name: rig.name, category: rig.category, geometry: rig.geometry }, behavior)
}

/** A part of the Containers library (libraries/containers), from its source. */
function containersPart(dir: string): PartPackage {
  const manifest = JSON.parse(readFileSync(join(repo, 'libraries', 'containers', dir, 'manifest.json'), 'utf8')) as PackageManifest
  return buildPackage(manifest, readFileSync(join(repo, 'libraries', 'containers', dir, 'behavior.js'), 'utf8'))
}

function world(packages: PartPackage[], parts: object[]): SimWorld {
  const res = validateScene({ version: SCENE_VERSION, packages, parts: parts as never })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

const run = (w: SimWorld, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds * 60); i++) w.step()
}

describe('spawning and counting products', () => {
  let w: SimWorld | null = null
  afterEach(() => {
    w?.dispose()
    w = null
    clearPackages()
    clearPartDiagnostics()
  })

  it('the Spawner drops the Tote part at the size its product settings pick, as if placed', () => {
    w = world([example('box-spawner'), containersPart('tote'), example('box')], [
      { id: 'sp', type: 'part', packageId: 'oip.box-spawner', position: [0, 5, 0], rotationY: 0, params: { boxesPerMinute: 60, product: 'oip.tote', productSettings: '{"size":"400x300x220","color":"#d9a020"}' } },
    ])
    run(w, 0.1)
    const f = w.frame()
    expect(f.count).toBe(1)
    expect(f.kinds[0]).toBe(CARGO_KIND_TOTE)
    expect([0, 1, 2].map((k) => Math.round(f.halfExtents[k]! * 1000))).toEqual([200, 110, 150])
    // its own colour, not the spawner's cardboard one
    expect([0, 1, 2].map((k) => Math.round(f.colors[k]! * 255))).toEqual([0xd9, 0xa0, 0x20])
  })

  it('a product that is not in the run spawns nothing and says so on the spawner', () => {
    w = world([example('box-spawner')], [
      { id: 'sp', type: 'part', packageId: 'oip.box-spawner', position: [0, 5, 0], rotationY: 0, params: { product: 'acme.nothing' } },
    ])
    run(w, 0.1)
    expect(w.frame().count).toBe(0)
    expect(partDiagnosticsFor('sp').map((d) => d.message)).toEqual(["spawn of 'acme.nothing' skipped: no such part in this project"])
  })

  it('a Despawner set to count totes counts a tote carrying a case once, and still removes both', () => {
    const H = 0.32
    const tote = { id: 't1', type: 'part', packageId: 'oip.tote', position: [0, H / 2, 0], rotationY: 0, params: {} }
    const kase = { id: 'c1', type: 'part', packageId: 'oip.box', position: [0, H / 2 - H / 2 + 0.023 + 0.1 + 0.005, 0], rotationY: 0, params: { length: 0.2, width: 0.2, height: 0.2 } }
    const sink = (id: string, x: number, countOnly: string) => ({ id, type: 'part', packageId: 'oip.despawner', position: [x, 0, 0], rotationY: 0, params: { length: 1, width: 1, height: 1, countOnly } })
    const at = (p: { id: string; position: number[] }, x: number) => ({ ...p, id: `${p.id}_${x}`, position: [x, p.position[1], p.position[2]] })
    w = world([example('despawner'), containersPart('tote'), example('box')], [
      sink('all', 0, ''), at(tote, 0), at(kase, 0),
      sink('totes', 5, 'oip.tote'), at(tote, 5), at(kase, 5),
    ])
    run(w, 0.2)
    const displays = (w.frame().displays ?? {}) as Record<string, Record<string, unknown>>
    const count = (id: string): unknown => displays[id]?.count
    expect(count('all')).toBe(2)
    expect(count('totes')).toBe(1)
    expect(w.frame().count).toBe(0)
  })
})
