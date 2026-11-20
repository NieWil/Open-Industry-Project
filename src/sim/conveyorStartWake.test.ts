import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { PartInstance, SdkPart } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// A deck that starts wakes the cargo resting on it, and nothing else (world.ts wakeCargoOn).
//
// Cargo standing on a stopped deck falls asleep, and a sleeping body gets no contact callbacks, so without a wake
// a starting belt never reaches it (physicsFidelity.test.ts pins that the wake is needed). Waking every cargo body
// on every deck start anywhere keeps re-settling resting stacks until a pallet stack falls through itself
// (palletStack.test.ts). These pin both halves: the box
// on the belt rides away, and a pile standing elsewhere sleeps straight through the start.

const Jolt = await initJolt()

const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage(
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...((manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}

interface LiveBody {
  partId: string | null
  body: { IsActive(): boolean; GetPosition(): { GetX(): number } }
}
const bodiesOf = (w: SimWorld, prefix: string): LiveBody[] =>
  (w as unknown as { boxes: LiveBody[] }).boxes.filter((b) => b.partId?.startsWith(prefix))

describe('a deck starting wakes its own cargo, not the whole scene', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('the box asleep on the belt rides away; a pile asleep on the floor elsewhere stays asleep', { timeout: 60000 }, () => {
    const belt = loadPkg('belt-conveyor')
    const box = loadPkg('box')
    // a 4 m belt along +x, held at 0 by its speed tag until the start
    const conveyor = createSdkPart(belt, 'belt', [0, 1, 0], 0) as SdkPart
    Object.assign(conveyor.params, { segments: [[4, 0]], speed: 0.5, speedTag: 'sp' })
    const parts: PartInstance[] = [conveyor, createSdkPart(box, 'ride', [1, 1.6, 0], 0)]
    // a three-high pile of cases on the floor, 6 m off the belt's side
    for (let i = 0; i < 3; i++) parts.push(createSdkPart(box, `pile${i}`, [2, 0.2 + 0.4 * i, 6], 0))
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts, packages: [belt, box] }, { hz: 60 })

    world.setBehaviorInputTags({ sp: 0 })
    for (let i = 0; i < 60 * 3; i++) world.step()
    const [rider] = bodiesOf(world, 'ride')
    const pile = bodiesOf(world, 'pile')
    expect(pile).toHaveLength(3)
    // the precondition the wake exists for: everything has gone to sleep on the stopped line
    expect(rider!.body.IsActive()).toBe(false)
    expect(pile.some((b) => b.body.IsActive())).toBe(false)

    const x0 = rider!.body.GetPosition().GetX()
    world.setBehaviorInputTags({ sp: 0.5 })
    let pileWoke = false
    for (let i = 0; i < 60 * 2; i++) {
      world.step()
      if (pile.some((b) => b.body.IsActive())) pileWoke = true
    }
    // 0.5 m/s for 2 s, less the friction pickup
    expect(rider!.body.GetPosition().GetX() - x0).toBeGreaterThan(0.8)
    expect(pileWoke).toBe(false)
  })
})
