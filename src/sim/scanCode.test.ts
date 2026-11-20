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

// A mixed product stream read by code: the Spawner hands each item a value of one attribute from a cycle list (ctx.spawn
// `marks`), and the Barcode Scanner reads it off each case crossing its scan line onto its code tag, marking the one
// case it read (ctx.markHit). What has to hold: the codes come out in the order the spawner gave them, each case is
// read once, and a case carries both the code and the scanned mark downstream.

const Jolt = await initJolt()
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadExample(dir: string): { manifest: PackageManifest; behavior: string } {
  const rig = JSON.parse(readFileSync(join(repo, 'examples', 'parts', dir, 'rig.json'), 'utf8')) as PackageManifest
  const behavior = readFileSync(join(repo, 'examples', 'parts', dir, 'behavior.ts'), 'utf8')
  return { manifest: rig, behavior }
}
const pkg = (dir: string) => {
  const e = loadExample(dir)
  return buildPackage(e.manifest, e.behavior)
}

const DECK_Y = 1
/** a long deck along x at DECK_Y, running at 0.6 m/s */
const deck = buildPackage(
  { id: 'acme.deck', name: 'Deck', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [12, 0.1, 1.4] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 12, width: 1.4, top: 0.1 } } },
  'definePart({ step(ctx) { ctx.setSurfaceVelocity({ x: 0.6, y: 0, z: 0 }) } })',
)

function world(mix: Record<string, string | boolean>): SimWorld {
  const res = validateScene({
    version: SCENE_VERSION,
    packages: [deck, pkg('box'), pkg('box-spawner'), pkg('barcode-scanner')],
    parts: [
      { id: 'deck', type: 'part', packageId: 'acme.deck', position: [0, DECK_Y, 0], rotationY: 0, params: {} },
      { id: 'feed', type: 'part', packageId: 'oip.box-spawner', position: [-5, DECK_Y + 0.7, 0], rotationY: 0, params: { boxesPerMinute: 20, ...mix } },
      // its local Z (travel) turned onto the deck's +x
      { id: 'scan', type: 'part', packageId: 'oip.barcode-scanner', position: [1, 0, 0], rotationY: Math.PI / 2, params: { width: 1.6, surfaceHeight: DECK_Y, readTag: 'Read', countTag: 'Count', codeTag: 'Code' } },
    ],
  })
  if (!res.ok) throw new Error(`scene invalid: ${res.errors.join('; ')}`)
  return new SimWorld(Jolt, res.scene)
}

const tag = (w: SimWorld, name: string): unknown => w.frame().tags?.scan?.[name]

/** run `seconds`, returning the code on the tag at each rising edge of the good-read pulse */
function codesRead(w: SimWorld, seconds: number): number[] {
  const out: number[] = []
  let was = false
  for (let i = 0; i < seconds * 60; i++) {
    w.step()
    const read = tag(w, 'Read') === true
    if (read && !was) out.push(tag(w, 'Code') as number)
    was = read
  }
  return out
}

describe('a mixed stream read by code (spawner marks, scanner code tag)', () => {
  it('reads each case once, in the order the spawner coded them', () => {
    const w = world({ mixAttribute: 'code', mixValues: '7, 9, 9' })
    const codes = codesRead(w, 20)
    expect(codes.length).toBeGreaterThanOrEqual(4)
    expect(codes).toEqual([7, 9, 9, 7, 9, 9, 7].slice(0, codes.length))
    expect(tag(w, 'Count')).toBe(codes.length)
    // every case read carries its code and the scanned mark, and no case was read twice
    const marks = w.cargoMarks().filter((m) => m?.scanned === true)
    expect(marks.length).toBe(codes.length)
    expect(marks.map((m) => m!.code)).toEqual(codes)
    w.dispose()
  })

  it('reads 0 for a case with no code, and counts it all the same', () => {
    const w = world({})
    const codes = codesRead(w, 16)
    expect(codes.length).toBeGreaterThanOrEqual(2)
    expect(codes.every((c) => c === 0)).toBe(true)
    w.dispose()
  })
})
