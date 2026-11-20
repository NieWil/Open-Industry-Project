import { describe, it, expect } from 'vitest'
import { Group, Mesh, MeshStandardMaterial } from 'three'
import { NodeFrame } from 'three/webgpu'
// deep src import: reads a private method's source, so the cast goes through unknown
import Renderer from 'three/src/renderers/common/Renderer.js'
import { classifyBundleObject, deriveCamNodes, deriveNodeCover, isCameraSensitiveObject } from './bundleReplayRefresh'

/** three r185 Renderer.prototype._renderScene, as text - the two source canaries below read it */
const renderSceneSource = (): string =>
  (Renderer as unknown as { prototype: { _renderScene: () => void } }).prototype._renderScene.toString()

// The selective camera-refresh path's whole correctness surface is this predicate: a captured
// draw is refreshed on camera-only frames iff its ancestry carries a viewTick (the camera-driven
// mutator hook). The renderer-internals plumbing around it is exercised by the headed bundle
// probes (e2e/probes/bundle-campatch.mjs, e2e/probes/bundle-rig-freeze.mjs); this pins the tagging rule.

describe('isCameraSensitiveObject', () => {
  it('tags a mesh whose ancestor carries a viewTick (the part-root pattern)', () => {
    const root = new Group()
    root.userData.viewTick = () => {}
    const inner = new Group()
    const mesh = new Mesh()
    inner.add(mesh)
    root.add(inner)
    expect(isCameraSensitiveObject(mesh)).toBe(true)
  })

  it('tags a mesh carrying its own viewTick', () => {
    const mesh = new Mesh()
    mesh.userData.viewTick = () => {}
    expect(isCameraSensitiveObject(mesh)).toBe(true)
  })

  it('does not tag plain content, non-function tags, or null', () => {
    const root = new Group()
    const mesh = new Mesh()
    root.add(mesh)
    expect(isCameraSensitiveObject(mesh)).toBe(false)
    root.userData.viewTick = 'not a function'
    expect(isCameraSensitiveObject(mesh)).toBe(false)
    expect(isCameraSensitiveObject(null)).toBe(false)
  })
})

describe('classifyBundleObject - the active-frame dirty-list buckets', () => {
  // The always bucket holds only unmarkable mutators (pool output without a mark id, dynamicInstances,
  // unowned draws). Everything else is byPart, refreshed on frames its part was marked (owned walk /
  // tick returns / syncScene). A missed always case renders one frame stale mid-sim, so these pin
  // every rule.

  function partMesh(rootTag?: (root: Group) => void): { root: Group; mesh: Mesh } {
    const root = new Group()
    root.userData.partId = 'p1'
    rootTag?.(root)
    const mesh = new Mesh(undefined, new MeshStandardMaterial())
    root.add(mesh)
    return { root, mesh }
  }

  it('a plain part mesh is not always-active and carries its partId', () => {
    const { mesh } = partMesh()
    expect(classifyBundleObject(mesh)).toEqual({ part: 'p1', always: false })
  })

  it('dynamicInstances banks and pool output are always-active', () => {
    const dyn = partMesh()
    dyn.mesh.userData.dynamicInstances = true
    expect(classifyBundleObject(dyn.mesh).always).toBe(true)

    // a pool with no mark id (not minted by InstancePoolManager) has nothing to be marked by
    const pool = new Mesh(undefined, new MeshStandardMaterial())
    pool.userData.instancePool = true
    expect(classifyBundleObject(pool).always).toBe(true)
  })

  it('a manager-minted pool rides its own mark id', () => {
    const pool = new Mesh(undefined, new MeshStandardMaterial())
    pool.userData.instancePool = true
    pool.userData.poolMarkId = '#pool:7'
    expect(classifyBundleObject(pool)).toEqual({ part: '#pool:7', always: false })
  })

  it('a side guard is an ordinary per-part draw: its beam holes are geometry, not scene-global uniforms', () => {
    // The holes are drawn geometry (core/guards/guardHoles.ts), so a guard refreshes only when its own part changes and
    // stays out of the always-active bucket. A leftover tag must not matter.
    const guard = partMesh()
    ;(guard.mesh.material as MeshStandardMaterial).userData.guardBeams = true
    expect(classifyBundleObject(guard.mesh)).toEqual({ part: 'p1', always: false })
  })

  it('a draw with no owning part is always-active (conservative: refresh what we cannot attribute)', () => {
    const orphan = new Mesh(undefined, new MeshStandardMaterial())
    expect(classifyBundleObject(orphan)).toEqual({ part: null, always: true })
    expect(classifyBundleObject(null).always).toBe(true)
  })

  it('a viewTick subtree rides the marked byPart bucket - viewTicks report their mutation', () => {
    // A viewTick mutation can happen on a frame that is neither active nor camera-moved, whose walk
    // doesn't run (the post-stop stale-roof frame). viewTick returns whether it mutated (building.ts
    // roof flip), the view marks the part, and part 1's gate opens on marks alone, so the mark
    // cannot be dropped on a parked frame.
    const building = partMesh((r) => { r.userData.viewTick = () => {} })
    expect(classifyBundleObject(building.mesh)).toEqual({ part: 'p1', always: false })
  })

  it('ticks, rigs, spin materials and lamp appliers ride the marked byPart bucket - ticks report, the walk marks matrices', () => {
    // tick ancestry alone doesn't put a part's whole subtree on the per-frame walk: the tick
    // returns whether it mutated and the view marks the part (a stopped conveyor isn't refreshed)
    const ticked = partMesh((r) => { r.userData.tick = () => {} })
    expect(classifyBundleObject(ticked.mesh)).toEqual({ part: 'p1', always: false })
    // frame-driven matrix motion (applyJoints → poseRev) marks via the owned walk's re-bake
    const rig = partMesh((r) => { r.userData.runtimeMovable = true })
    expect(classifyBundleObject(rig.mesh)).toEqual({ part: 'p1', always: false })
    // spin advances need no walk and no mark: the spin uniform is in the shared tick group
    // (tickUniformGroup.ts), uploaded directly by the replay (part 1.5)
    const spin = partMesh()
    ;(spin.mesh.material as MeshStandardMaterial).userData.spinUniform = { value: 0 }
    expect(classifyBundleObject(spin.mesh)).toEqual({ part: 'p1', always: false })
    // lamp paints mark on invocation (applyBoxFrame)
    const lamps = partMesh((r) => { r.userData.applyLamps = () => {} })
    expect(classifyBundleObject(lamps.mesh)).toEqual({ part: 'p1', always: false })
  })
})

describe('deriveNodeCover - part 2 camera walk = one draw per unique NodeBuilderState', () => {
  // Builder states are shared per pipeline (three's nodeBuilderCache), so the cover's
  // updateNodes/updateBeforeNodes union equals the full drawn list's. Walking more than one
  // draw per state only adds per-(draw, node) overhead plus ungated object-scope callbacks.
  type CoverInput = Parameters<typeof deriveNodeCover>[0]
  const ro = (state: object) => ({ getBindings: () => [], getNodeBuilderState: () => state })

  it('keeps the first draw per builder state, in draw order', () => {
    const a = {}
    const b = {}
    const drawn = [ro(a), ro(a), ro(b), ro(a), ro(b)]
    expect(deriveNodeCover(drawn as CoverInput)).toEqual([drawn[0], drawn[2]])
  })

  it('returns undefined when getNodeBuilderState is missing (three internals moved → callers full-walk)', () => {
    const bare = { getBindings: () => [] }
    expect(deriveNodeCover([ro({}), bare] as CoverInput)).toBeUndefined()
  })

  it('empty capture → empty cover', () => {
    expect(deriveNodeCover([] as CoverInput)).toEqual([])
  })
})

describe('deriveCamNodes - part 2 camera walk = deduped non-OBJECT nodes, grouped by builder state', () => {
  // The camera pass only uploads shared (render/frame-scope) uniform bytes, so object-scope nodes
  // are dropped and every remaining node appears exactly once across the whole recording, in
  // first-visit context, same as the stock walk's renderId gate.
  type CamInput = Parameters<typeof deriveCamNodes>[0]
  const node = (updateType: string, beforeType = 'none') => ({
    getUpdateType: () => updateType,
    getUpdateBeforeType: () => beforeType,
  })
  const ro = (state: object) => ({ getBindings: () => [], getNodeBuilderState: () => state })

  it('filters OBJECT-scope nodes and dedups shared nodes across builder states (first state wins)', () => {
    const camera = node('render') // the singleton camera family: shared by every state
    const objectScope = node('object') // e.g. modelNormalMatrix - per-object, dropped
    const stateA = { updateNodes: [camera, objectScope], updateBeforeNodes: [] }
    const stateB = { updateNodes: [camera, node('frame')], updateBeforeNodes: [] }
    const drawn = [ro(stateA), ro(stateA), ro(stateB)]
    const groups = deriveCamNodes(drawn as CamInput)!
    expect(groups).toHaveLength(2)
    expect(groups[0]!.ro).toBe(drawn[0])
    expect(groups[0]!.update).toEqual([camera]) // objectScope dropped
    expect(groups[1]!.update).toHaveLength(1) // camera already claimed by state A
  })

  it('a node carrying both gates lands in both lists; states with nothing left contribute no group', () => {
    const both = node('render', 'render')
    const state = { updateNodes: [both], updateBeforeNodes: [both] }
    const onlyObjects = { updateNodes: [node('object')], updateBeforeNodes: [] }
    const groups = deriveCamNodes([ro(state), ro(onlyObjects)] as CamInput)!
    expect(groups).toHaveLength(1)
    expect(groups[0]!.before).toEqual([both])
    expect(groups[0]!.update).toEqual([both])
  })

  it('returns undefined when an internal moved (missing method / non-array lists) → callers fall back', () => {
    expect(deriveCamNodes([{ getBindings: () => [] }] as CamInput)).toBeUndefined()
    const noLists = { updateNodes: undefined, updateBeforeNodes: [] }
    expect(deriveCamNodes([ro(noLists)] as CamInput)).toBeUndefined()
    const badNode = { updateNodes: [{}], updateBeforeNodes: [] }
    expect(deriveCamNodes([ro(badNode)] as CamInput)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Part 2's camera repair pass relies on three r185 behaviours that three
// doesn't document as guarantees. These are canaries, as in matrixWalk.test.ts: a three bump that
// changes them fails a test instead of silently rendering a bundle from a light's orthographic
// camera. Background: the "nested renders poison the camera singletons" entry in
// docs/three-coupling.md.

describe('three r185 nested-render canaries (part 2 camera repair)', () => {
  it('NodeFrame RENDER-scope updates are renderId-stamped, so a restored renderId re-opens them', () => {
    // The property the repair pass is built on. A nested render runs the camera family under its
    // own renderId and stamps them with it; _renderScene then restores the outer renderId, so the
    // stamp no longer matches and a second updateNode re-runs the node with the right camera.
    // Without this, re-running the update lists would be a silent no-op and the repair useless.
    const frame = new NodeFrame()
    const seen: unknown[] = []
    const node = {
      getUpdateType: () => 'render',
      updateReference: () => node,
      update: (f: { camera: unknown }) => {
        seen.push(f.camera)
      },
    }
    const outer = { name: 'view' }
    const light = { name: 'light' }

    frame.renderId = 10
    frame.camera = outer as never
    frame.updateNode(node as never)
    expect(seen).toEqual([outer]) // first visit of this renderId

    frame.camera = light as never
    frame.updateNode(node as never)
    expect(seen).toEqual([outer]) // gated: same renderId, no second run

    frame.renderId = 11 // the nested render
    frame.updateNode(node as never)
    expect(seen).toEqual([outer, light]) // ran under the light camera, stamped at 11

    frame.renderId = 10 // _renderScene restores the outer renderId
    frame.camera = outer as never
    frame.updateNode(node as never)
    expect(seen).toEqual([outer, light, outer]) // stamp 11 !== 10 ⇒ the repair re-runs it
  })

  it('Renderer._renderScene restores renderId but not the node frame camera (source canary)', () => {
    // Why a repair is needed at all. If a bump starts restoring nodeFrame.camera/object/material,
    // three fixes the stale camera itself and this patch can be retired; this test reports it.
    // (The in-walk re-fetch in part 2 covers the same-group case either way.)
    const src = renderSceneSource()
    expect(src).toMatch(/nodeFrame\.renderId\s*=\s*previousRenderId/)
    expect(src).not.toMatch(/nodeFrame\.(camera|object|material)\s*=/)
  })

  it('Renderer._renderScene bumps info.calls and never restores it (source canary)', () => {
    // The repair's detector: `info.calls` moving across the cam-node walk is how part 2 knows a
    // nested render happened, so a frame without one does no repair work. A bump that restores it
    // (or stops incrementing per render) would make the repair silently stop running. That fails
    // without a crash, which is why it gets a canary.
    const src = renderSceneSource()
    expect(src).toMatch(/this\.info\.calls\s*\+\+/)
    expect(src).not.toMatch(/info\.calls\s*=\s*previous/)
  })
})
