import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { allPartDiagnostics, clearPartDiagnostics } from '../core/parts/partDiagnostics'
import type { PackageManifest } from '../core/parts/partPackage'
import { registerPackage, unregisterPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SceneJSON, SdkPart } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// grip.forks at the host seam (rigDriver.checkForkFit): a gripper that declares itself a pair of forks is checked,
// on taking a pallet, against the face its blades went in through, and a misfit is reported on the part. The rig
// here is just the declaration: a gripper whose blades run along +X, closing on whatever pallet stands in its zone.

const Jolt = await initJolt()
const FORKS = 'test.forks'

const RIGS = import.meta.glob('../../examples/parts/pallet/rig.json', { eager: true, import: 'default' }) as Record<string, PackageManifest>
const BEHAVIORS = import.meta.glob('../../examples/parts/pallet/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const PALLET = buildPackage(Object.values(RIGS)[0]!, Object.values(BEHAVIORS)[0]!.replace(/\r\n/g, '\n'))

function world(spread: number, palletYaw: number, size = '1219x1016'): SimWorld {
  registerPackage(PALLET)
  const forks = buildPackage(
    {
      id: FORKS,
      name: 'Forks',
      geometry: {
        kind: 'rig',
        links: [
          { name: 'base', shape: { kind: 'frame' }, offset: [0, 0, 0] },
          {
            name: 'hand',
            parent: 'base',
            shape: { kind: 'frame' },
            offset: [0, 0.07, 0],
            grip: { zone: { size: [1.6, 0.3, 1.6] }, forks: { spreadParam: 'spread', bladeWidth: 0.11, bladeThickness: 0.051 } },
          },
        ],
        joints: [],
      },
    },
    `let ticks = 0
    definePart({
      grippers: ['hand'],
      params: { spread: { type: 'number', default: 0.73, min: 0.2, max: 1, step: 0.01, label: 'Spread' } },
      step(ctx) { ticks += 1; ctx.grips.hand = ticks > 10 },
    })`,
  )
  registerPackage(forks)
  const rig: SdkPart = { id: 'f', type: 'part', packageId: FORKS, position: [0, 0, 0], rotationY: 0, params: { spread } }
  const pallet = createSdkPart(PALLET, 'p', [0, 0.0675, 0], palletYaw)
  pallet.params.size = size
  const parts: PartInstance[] = [rig, pallet]
  return new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [forks, PALLET] } as SceneJSON)
}

const fitReports = (): string[] => allPartDiagnostics().filter((d) => d.source === 'fit').map((d) => d.message)

describe('grip.forks: a pallet taken through a face the blades do not fit is reported', () => {
  let w: SimWorld | null = null
  afterEach(() => {
    w?.dispose()
    w = null
    unregisterPackage(FORKS)
    clearPartDiagnostics()
  })

  it('reports the short face of a 48 x 40 in pallet at the AGV\'s default 730 mm, with the spreads that fit', () => {
    w = world(0.73, 0) // pallet length along +X, the blades' direction: in through its end, the short face
    for (let i = 0; i < 40; i++) w.step()
    const reports = fitReports()
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('do not fit the short face of a 1220 x 1020 mm pallet')
    expect(reports[0]).toMatch(/a spread of \d+-\d+ mm fits it/)
  })

  it('says nothing for the long face, or for a spread the short face fits', () => {
    w = world(0.73, Math.PI / 2) // turned: in through the long face
    for (let i = 0; i < 40; i++) w.step()
    expect(fitReports()).toEqual([])
    w.dispose()
    w = world(0.45, 0) // the short face again, at a spread that enters it
    for (let i = 0; i < 40; i++) w.step()
    expect(fitReports()).toEqual([])
  })
})
