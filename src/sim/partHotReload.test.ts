import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { clearPackages } from '../core/parts/partRegistry'
import { SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import type { SdkPart, SceneJSON } from '../core/types'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'
import { SimWorld } from './world'

// Hot-reload a part into a running sim. The render half is
// onPackagesChanged → refreshPackage; this is the sim half: world.updateScene(scene, syncPackages) re-registers
// the scene's embedded packages, registerPackage bumps the package's rev only on real content change, and
// partSignature folds that rev in, so exactly the changed package's parts rebuild through the ordinary
// reconcile (params/transform/neighbours are unchanged). We drive it exactly as the worker does: SimWorld
// registers the scene's packages on construct (non-authoritative - like the worker, never via
// registerPackage(_, true)), so a syncPackages update can replace them. A belt whose speed param doubles
// after reload must convey markedly faster, which shows the running world picked up the new build.

const Jolt = await initJolt()

const beltSrc = (speed: number): string => `
definePart({
  params: { speed: { type: 'number', default: ${speed} } },
  geometry(g) { return g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], g.fillet([[0, 0, 0], [6, 0, 0]], 0.28)) },
  step(ctx) { var s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
})
`
const ID = 'oip.reload-belt'
const head: PackageManifest = { id: ID, name: 'Reload Belt', geometry: { kind: 'drawn', conveys: true, bounds: { length: 6, width: 1, top: 0.3 } } }
const sceneWith = (pkg: ReturnType<typeof buildPackage>): SceneJSON => {
  const part = { id: 'belt', type: 'part', packageId: ID, position: [0, 1, 0], rotationY: 0, params: {} } as unknown as SdkPart
  return { version: SCENE_VERSION, parts: [part], packages: [pkg] } as unknown as SceneJSON
}
// horizontal box travel over `secs` of stepping (the box is the first/only frame body)
const travel = (w: SimWorld, secs: number): number => {
  const x0 = w.frame().positions[0] ?? 0
  for (let i = 0; i < DEFAULT_SIM_HZ * secs; i++) w.step()
  return (w.frame().positions[0] ?? 0) - x0
}

describe('part hot-reload into a running sim (world.updateScene syncPackages + package rev in partSignature)', () => {
  it('rebuilds the running part from the re-registered package: a faster belt conveys faster after reload', () => {
    clearPackages()
    const w = new SimWorld(Jolt, sceneWith(buildPackage(head, beltSrc(0.3))))
    w.spawnBoxAt(0.5, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) w.step() // settle onto the deck
    const slow = travel(w, 1)

    // hot-reload: a faster build of the same id, pushed like the controller's reloadSimPackage (fresh pkg
    // embedded + syncPackages). The re-register bumps the package rev → the belt's signature mismatches → rebuild.
    w.updateScene(sceneWith(buildPackage(head, beltSrc(4))), true)
    const fast = travel(w, 1)
    w.dispose()

    expect(slow).toBeGreaterThan(0.1) // the slow belt did convey
    expect(fast).toBeGreaterThan(slow * 3) // the reload took effect in the live world - markedly faster
  })

  it('an ordinary update (no syncPackages) does not pick up a new build - stale drag-stream embeds must not swap', () => {
    clearPackages()
    const w = new SimWorld(Jolt, sceneWith(buildPackage(head, beltSrc(0.3))))
    w.spawnBoxAt(0.5, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1])
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) w.step()
    const before = travel(w, 1)
    w.updateScene(sceneWith(buildPackage(head, beltSrc(4)))) // no re-register → same rev → same signature → no rebuild
    const after = travel(w, 1)
    w.dispose()
    expect(after).toBeLessThan(before * 2.5) // still ~slow, not the fast belt
  })

  it('an ordinary update that introduces a new package registers it so its body builds (dragged-in cargo box)', () => {
    // The drag-into-a-running-scene bug: a scene played with no cargo never embedded oip.box, so the worker's
    // registry lacks it; dropping the first box streams an ordinary update (no syncPackages). Unregistered,
    // addSdkPart can't resolve the package and skips the body, so the box renders invisible (its scene stub
    // is hidden, the instanced batch is its only draw). registerNewScenePackages registers the new id so it builds.
    clearPackages()
    const CARGO_ID = 'oip.test-box'
    const boxPkg = buildPackage(
      { id: CARGO_ID, name: 'Test Box', geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.4, width: 0.4, height: 0.4 } } },
      'definePart({ step() {} })',
    )
    // Play with a cargo-free scene: the worker never learns the box package
    const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [], packages: [] } as unknown as SceneJSON)
    expect(w.frame().count).toBe(0)

    // drop the first box: an ordinary update (no syncPackages) embedding the never-registered cargo package
    const boxPart = { id: 'box1', type: 'part', packageId: CARGO_ID, position: [0, 2, 0], rotationY: 0, params: {} } as unknown as SdkPart
    w.updateScene({ version: SCENE_VERSION, parts: [boxPart], packages: [boxPkg] } as unknown as SceneJSON)
    const count = w.frame().count
    w.dispose()

    expect(count).toBe(1) // the dynamic body was built (0 would mean an unresolved package)
  })

  it('a later syncPackages update embedding the same fresh package does not regress it: a subsequent rebuild keeps the edit', () => {
    // The reverted-edit trap: hot-reload belt A, then hot-reload belt B - B's sync re-registers A's embedded
    // copy too. The controller embeds fresh registry copies for every id (reloadSimPackage), so A's copy is
    // the edited one; re-registering identical content must not bump A's rev (no needless rebuild), and A's
    // next ordinary rebuild (here: moved → signature change) must still compile the edited behavior.
    clearPackages()
    const ID_B = 'oip.reload-belt-b'
    const headB: PackageManifest = { ...head, id: ID_B, name: 'Reload Belt B' }
    const partAt = (id: string, pkgId: string, z: number): SdkPart =>
      ({ id, type: 'part', packageId: pkgId, position: [0, 1, z], rotationY: 0, params: {} } as unknown as SdkPart)
    const scene = (pkgA: ReturnType<typeof buildPackage>, pkgB: ReturnType<typeof buildPackage>, aZ = 0): SceneJSON =>
      ({ version: SCENE_VERSION, parts: [partAt('a', ID, aZ), partAt('b', ID_B, 4)], packages: [pkgA, pkgB] } as unknown as SceneJSON)

    const w = new SimWorld(Jolt, scene(buildPackage(head, beltSrc(0.3)), buildPackage(headB, beltSrc(0.3))))
    w.spawnBoxAt(0.5, 1.3, 0, 0.2, 0.2, 0.2, 0, 10, [1, 1, 1]) // riding belt 'a'
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) w.step()

    const fastA = buildPackage(head, beltSrc(4))
    w.updateScene(scene(fastA, buildPackage(headB, beltSrc(0.3))), true) // hot-reload A
    // hot-reload B; A's embedded copy is the fresh registry build (identical content → rev unchanged)
    w.updateScene(scene(buildPackage(head, beltSrc(4)), buildPackage(headB, beltSrc(4))), true)
    // ordinary edit rebuilds A (moved sideways → signature change): must compile the edited (fast) behavior
    w.updateScene(scene(buildPackage(head, beltSrc(0.3)), buildPackage(headB, beltSrc(0.3)), 0.2))
    const after = travel(w, 1)
    w.dispose()
    expect(after).toBeGreaterThan(1) // still the fast belt - the stale-snapshot regression would leave ~0.3 m/s
  })
})
