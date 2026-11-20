import { describe, it, expect, vi } from 'vitest'
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three'
import { InstancePoolManager } from './instancePool'

// Deterministic, headless coverage of the InstancePoolManager's dynamic correctness, which the
// headed-GPU e2e (verify-instance-pool.mjs) doesn't reach: what happens to the pooled set across
// selection, drag, repeated edits, and scene switches. The pool is pure three.js scene-graph work, so
// this pins the merge/teardown/restore logic exactly, without a GPU. The e2e checks pixel-identity
// and the draw-call reduction; this checks that the manager never leaks a hidden source or a stale pool.

// one shared geometry + material so identical parts collapse into one signature bucket (the whole point)
const sharedGeo = new BoxGeometry(1, 1, 1)

function stdMat(): MeshStandardMaterial {
  // distinct objects per part, identical render identity - proves materialKey merges by content, not ref
  return new MeshStandardMaterial({ color: 0x808080, metalness: 0.4, roughness: 0.6 })
}

interface Part {
  root: Group
  mesh: InstancedMesh
}

function addPart(
  partsGroup: Group,
  id: string,
  count: number,
  opts: { geo?: BufferGeometry; mat?: Material; x?: number } = {},
): Part {
  const root = new Group()
  root.userData.partId = id
  root.position.x = opts.x ?? 0
  const mesh = new InstancedMesh(opts.geo ?? sharedGeo, opts.mat ?? stdMat(), count)
  const im = new Matrix4()
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, im.makeTranslation(i, 0, 0))
  mesh.instanceMatrix.needsUpdate = true
  root.add(mesh)
  partsGroup.add(root)
  return { root, mesh }
}

/** every pool mesh currently under the manager's pool group */
function pools(scene: Scene): InstancedMesh[] {
  const out: InstancedMesh[] = []
  scene.traverse((o) => {
    if ((o as InstancedMesh).isInstancedMesh && o.userData.instancePool === true) out.push(o as InstancedMesh)
  })
  return out
}

function setup(): { scene: Scene; partsGroup: Group; mgr: InstancePoolManager } {
  const scene = new Scene()
  const partsGroup = new Group()
  scene.add(partsGroup)
  const mgr = new InstancePoolManager(scene, [partsGroup])
  return { scene, partsGroup, mgr }
}

const NONE: ReadonlySet<string> = new Set()

describe('InstancePoolManager - scene mount order', () => {
  it('mounts its output group ahead of the parts group it merges from', () => {
    // Not cosmetic. Render bundles execute at the end of the pass in scene-child order
    // (bundleGroups.mountOpaqueBundleGroupBefore), so an opaque merge sitting after the parts group
    // paints over that group's depthWrite:false translucent cues - the conveyor behind a spawner
    // marker punching through its fill instead of being tinted by it.
    const { scene, partsGroup } = setup()
    const poolGroup = scene.children.find((c) => c.userData.instancePoolGroup === true)
    expect(poolGroup).toBeDefined()
    expect(scene.children.indexOf(poolGroup!)).toBeLessThan(scene.children.indexOf(partsGroup))
  })

  it('mounts immediately before it, leaving whatever the env put in front alone', () => {
    // Only the merge's order relative to the group it merges from matters, so the reorder
    // stays that small: env.ts mounts lights and containers before the parts, and they keep their
    // places rather than having a bundle hoisted over them.
    const scene = new Scene()
    const light = new Group() // stands in for the env lights/containers mounted before the parts
    const partsGroup = new Group()
    scene.add(light, partsGroup)
    new InstancePoolManager(scene, [partsGroup])
    expect(scene.children[0]).toBe(light)
    expect(scene.children[1]!.userData.instancePoolGroup).toBe(true)
    expect(scene.children[2]).toBe(partsGroup)
  })
})

describe('InstancePoolManager - per-instance render identity', () => {
  // The class this exists for: state that lives on the material, differs per part, and that material
  // identity cannot see. Deck tiling (common.ts createDeckSurface) is the shipped example: every
  // deck shares one texture pair and one set of PBR props, so without userData in the merge key a
  // 13.5 m catwalk and a 0.6 m stair tread hash identically and one bank draws both at one tiling.
  const deckMat = (rx: number, ry: number): MeshStandardMaterial => {
    const m = stdMat()
    m.userData.deckRepeat = new Vector2(rx, ry)
    return m
  }

  it('splits banks by per-instance material state, and still merges the ones that match', () => {
    const { scene, partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 2, { mat: deckMat(2, 2) })
    addPart(partsGroup, 'b', 2, { mat: deckMat(2, 2) }) // same tiling, different object → merges with a
    addPart(partsGroup, 'c', 2, { mat: deckMat(27, 3.8) }) // different tiling → must not join them

    mgr.rebuild(NONE)

    // a+b merge; c is alone on its tiling, so it has nothing to merge with and stays live
    const ps = pools(scene)
    expect(ps).toHaveLength(1)
    expect(ps[0]!.count).toBe(4)
    expect((ps[0]!.material as MeshStandardMaterial).userData.deckRepeat.x).toBe(2)
  })

  it('a value nested in a per-frame uniform bag does not re-sign the pool', () => {
    // spinUniform is `{ value }` advanced every frame (rollers). Hashing nested scalars would move
    // the signature every frame and rebuild the whole pool; the identity hash reads resources out of
    // a plain object, never its raw numbers.
    const { partsGroup, mgr } = setup()
    const spin = { value: 0 }
    const mat = stdMat()
    mat.userData.spinBag = spin
    addPart(partsGroup, 'a', 2, { mat })
    addPart(partsGroup, 'b', 2, { mat: (() => { const m = stdMat(); m.userData.spinBag = spin; return m })() })

    mgr.rebuild(NONE)
    expect(mgr.auditCoherence(NONE).ok).toBe(true)

    spin.value = 42 // one frame later
    expect(mgr.auditCoherence(NONE).ok).toBe(true)
  })

  it('auditGrouping catches a pooled member mutated in place to differ from its head', () => {
    // The backstop for state nobody registered: mutate a member after the bake so it no longer
    // renders like the head it draws as. auditGrouping re-derives identity from the material objects
    // themselves, so it fires even when the merge key is blind to the property.
    const { partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 2, { mat: deckMat(2, 2) })
    const b = addPart(partsGroup, 'b', 2, { mat: deckMat(2, 2) })

    mgr.rebuild(NONE)
    expect(mgr.auditGrouping().ok).toBe(true)

    // setExtent writes the live Vector2 in place - same material object, different render
    ;(b.mesh.material as MeshStandardMaterial).userData.deckRepeat.set(27, 3.8)

    const r = mgr.auditGrouping()
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('b')
  })

  it('auditCoherence subsumes the grouping check', () => {
    const { partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 2, { mat: deckMat(2, 2) })
    const b = addPart(partsGroup, 'b', 2, { mat: deckMat(2, 2) })
    mgr.rebuild(NONE)
    expect(mgr.auditCoherence(NONE).ok).toBe(true)

    ;(b.mesh.material as MeshStandardMaterial).userData.deckRepeat.set(27, 3.8)
    expect(mgr.auditCoherence(NONE).ok).toBe(false)
  })
})

describe('InstancePoolManager - merging', () => {
  it('merges structurally-identical hardware across two parts into one pool and hides the sources', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)

    mgr.rebuild(NONE)

    const ps = pools(scene)
    expect(ps).toHaveLength(1)
    expect(ps[0]!.count).toBe(7) // 3 + 4 instances concatenated
    // draws a wrapper: the head's vertex data cloned, plus the pool-owned aSel selection channel
    expect(ps[0]!.geometry).not.toBe(a.mesh.geometry)
    expect(ps[0]!.geometry.getAttribute('position').count).toBe(a.mesh.geometry.getAttribute('position').count)
    expect(ps[0]!.geometry.getAttribute('aSel')).toBeDefined()
    expect(a.mesh.visible).toBe(false) // originals hidden (still raycastable - visible=false only)
    expect(b.mesh.visible).toBe(false)
  })

  it('leaves a lone unique mesh live (nothing to merge with)', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3) // shared geo
    const b = addPart(partsGroup, 'b', 3) // shared geo - merges with a
    const uniq = addPart(partsGroup, 'u', 3, { geo: new BoxGeometry(2, 0.5, 1) }) // distinct content

    mgr.rebuild(NONE)

    expect(pools(scene)).toHaveLength(1) // only a+b
    expect(a.mesh.visible).toBe(false)
    expect(b.mesh.visible).toBe(false)
    expect(uniq.mesh.visible).toBe(true) // lone signature stays live
  })

  it('pool copies never raycast - picking stays on the hidden exact-geometry sources', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2)

    mgr.rebuild(NONE)

    const ray = new Raycaster(new Vector3(0, 0, -5), new Vector3(0, 0, 1)) // through a's instance 0 at the origin
    expect(ray.intersectObject(pools(scene)[0]!, false)).toHaveLength(0) // merged copy is raycast-inert
    expect(ray.intersectObject(a.mesh, false).length).toBeGreaterThan(0) // hidden source still hits (Raycaster ignores visible)
  })

  it('merges distinct-but-byte-identical geometry objects (content hash, not object identity)', () => {
    const { scene, partsGroup, mgr } = setup()
    // two separate BoxGeometry objects with identical params → identical content hash → one bucket
    const a = addPart(partsGroup, 'a', 2, { geo: new BoxGeometry(1, 1, 1) })
    const b = addPart(partsGroup, 'b', 2, { geo: new BoxGeometry(1, 1, 1) })

    mgr.rebuild(NONE)

    expect(pools(scene)).toHaveLength(1)
    expect(pools(scene)[0]!.count).toBe(4)
    expect(a.mesh.visible).toBe(false)
    expect(b.mesh.visible).toBe(false)
  })
})

describe('InstancePoolManager - selection bypass', () => {
  it('excludes the selected part (kept live) and re-includes it on deselect', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)
    const c = addPart(partsGroup, 'c', 5)

    mgr.rebuild(new Set(['a']))
    expect(a.mesh.visible).toBe(true) // selected → live so it outlines/drags
    expect(b.mesh.visible).toBe(false)
    expect(c.mesh.visible).toBe(false)
    expect(pools(scene)[0]!.count).toBe(9) // only b + c

    mgr.rebuild(NONE) // deselect
    expect(a.mesh.visible).toBe(false) // now pooled
    expect(pools(scene)[0]!.count).toBe(12) // a + b + c
  })

  it('restores every source when all parts are selected (nothing eligible)', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)

    mgr.rebuild(NONE)
    expect(a.mesh.visible).toBe(false)

    mgr.rebuild(new Set(['a', 'b'])) // e.g. box-select everything
    expect(pools(scene)).toHaveLength(0)
    expect(a.mesh.visible).toBe(true)
    expect(b.mesh.visible).toBe(true)
  })
})

describe('InstancePoolManager - drag stability (signature early-out)', () => {
  it('does not rebuild the pool when only the selected (excluded) part moves', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 4)
    addPart(partsGroup, 'c', 5)

    mgr.rebuild(new Set(['a']))
    const before = pools(scene)[0]!

    // simulate dragging the selected part across several frames
    for (let f = 0; f < 5; f++) {
      a.root.position.set(f, 0, f * 2)
      mgr.rebuild(new Set(['a']))
    }
    const after = pools(scene)[0]!
    expect(after).toBe(before) // same object → the early-out held → zero churn during the drag
  })

  it('re-bakes in place (same pool object) when a pooled (non-selected) part moves', () => {
    const { scene, partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)

    mgr.rebuild(new Set(['a'])) // a live, b pooled... b alone can't pool
    // give it a third so b actually pools with c
    const c = addPart(partsGroup, 'c', 5)
    mgr.rebuild(new Set(['a']))
    const before = pools(scene)[0]!

    b.root.position.set(10, 0, 0) // move a pooled part
    mgr.rebuild(new Set(['a']))
    const after = pools(scene)[0]!
    // signature changed so the pool did re-bake - but into the same object (uuid stable → the WebGPU
    // pipeline is not recompiled, as it would be for a freshly minted mesh).
    expect(after).toBe(before)
    expect(after.count).toBe(9) // b + c
    const m = new Matrix4()
    after.getMatrixAt(0, m) // b's first instance is baked first (eligible order b, then c)
    expect(m.elements[12]).toBe(10) // world x picked up the new pose → the re-bake really happened
    void c
  })
})

describe('InstancePoolManager - rebuild-signature coverage (no stale copies)', () => {
  // The early-out signature must see every change that alters a baked pool row. Two cases, both
  // "data moved, pixels did not": a transform hash of only translation + diagonal aliases a one-shot
  // Inspector sign flip (yaw +θ/−θ share cos θ), and without sampling buffer contents an in-place bank
  // rewrite at constant count (a non-drag param edit re-spreading legs via writeInstanceMatrices)
  // aliases on id:count:material:pose.

  it('re-bakes when a pooled part flips rotation sign (yaw +θ → −θ, one-shot non-drag edit)', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2, { x: 10 })
    a.root.rotation.y = 0.6
    mgr.rebuild(NONE)
    const before = new Matrix4()
    pools(scene)[0]!.getMatrixAt(1, before) // a's instance 1 sits off-origin, so yaw moves its baked row

    a.root.rotation.y = -0.6 // Inspector sign flip / undo - no drag, single sync
    mgr.rebuild(NONE)

    const after = new Matrix4()
    pools(scene)[0]!.getMatrixAt(1, after)
    expect(after.equals(before)).toBe(false) // the pooled copy tracked the new yaw
  })

  it('re-bakes when a pooled bank rewrites its instance matrices in place at constant count', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2, { x: 10 })
    mgr.rebuild(NONE)
    const before = new Matrix4()
    pools(scene)[0]!.getMatrixAt(0, before)

    // param edit at constant count: same mesh object, same count, same world pose - only the
    // buffer contents move (what writeInstanceMatrices does for a leg height/spacing change)
    const im = new Matrix4()
    a.mesh.setMatrixAt(0, im.makeTranslation(0, 5, 0))
    a.mesh.setMatrixAt(1, im.makeTranslation(1, 5, 0))
    a.mesh.instanceMatrix.needsUpdate = true // bumps the version the signature samples
    mgr.rebuild(NONE)

    const after = new Matrix4()
    pools(scene)[0]!.getMatrixAt(0, after)
    expect(after.equals(before)).toBe(false) // the pooled copy reflects the rewritten bank
  })

  it('re-groups when a pooled member flips a shadow flag at constant pose/count/material', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    const b = addPart(partsGroup, 'b', 2, { x: 10 })
    mgr.rebuild(NONE)
    expect(pools(scene)).toHaveLength(1)

    a.mesh.castShadow = true // same everything else - only the flag (part of the merge key) moved
    mgr.rebuild(NONE)

    // a and b no longer share a merge key; each is a lone mesh → both render live, no pool draws
    expect(pools(scene)).toHaveLength(0)
    expect(a.mesh.visible).toBe(true)
    expect(b.mesh.visible).toBe(true)
  })
})

describe('InstancePoolManager - dirty-scoped update (tryUpdateParts)', () => {
  // The O(edited-part) fast path: when a sync knows which parts changed and membership provably
  // couldn't move, the pool validates the dirty parts' recorded rows and rewrites them in place.
  // Any structural surprise on a dirty part must return false - the caller then runs rebuild().

  it('rewrites only the dirty part rows in place and never visits clean parts', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    const b = addPart(partsGroup, 'b', 2, { x: 10 })
    const c = addPart(partsGroup, 'c', 2, { x: 20 })
    mgr.rebuild(NONE)
    const pool = pools(scene)[0]!

    const spyB = vi.spyOn(b.root, 'updateWorldMatrix')
    const spyC = vi.spyOn(c.root, 'updateWorldMatrix')
    a.root.position.x = 5
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(true)

    expect(spyB).not.toHaveBeenCalled() // clean parts: not walked, not hashed, not re-baked
    expect(spyC).not.toHaveBeenCalled()
    expect(pools(scene)[0]).toBe(pool) // same object - no membership change, no mint
    const m = new Matrix4()
    pool.getMatrixAt(0, m) // a's rows bake first (eligible order a, b, c)
    expect(m.elements[12]).toBe(5) // the moved pose landed in the merged buffer
    expect(a.mesh.visible).toBe(false) // still pooled - no visibility churn
  })

  it('picks up an in-place instance-buffer rewrite at constant count', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2, { x: 10 })
    mgr.rebuild(NONE)

    const im = new Matrix4()
    a.mesh.setMatrixAt(0, im.makeTranslation(0, 7, 0)) // the leg-height-scrub shape
    a.mesh.instanceMatrix.needsUpdate = true
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(true)

    const m = new Matrix4()
    pools(scene)[0]!.getMatrixAt(0, m)
    expect(m.elements[13]).toBe(7)
  })

  it('falls back (false) when a dirty bank was re-counted', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2)
    mgr.rebuild(NONE)

    a.mesh.count = 1 // slot ranges would shift - only a rebuild can re-lay the pool
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(false)
  })

  it('falls back when a dirty bank swapped its geometry or material in place', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    const b = addPart(partsGroup, 'b', 2)
    mgr.rebuild(NONE)

    a.mesh.geometry = new BoxGeometry(1, 1, 1) // byte-identical but a different object than the pinned one
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(false)

    mgr.rebuild(NONE) // re-pin, then taint the other part's material
    b.mesh.material = stdMat()
    expect(mgr.tryUpdateParts(new Set(['b']))).toBe(false)
  })

  it('falls back when a dirty member flips a shadow flag (part of the merge key)', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2)
    mgr.rebuild(NONE)

    a.mesh.castShadow = true // rows were baked into a non-casting pool - they belong elsewhere now
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(false)
  })

  it('falls back when a dirty part with pooled rows is hidden or gone', () => {
    const { partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 2)
    const b = addPart(partsGroup, 'b', 2)
    mgr.rebuild(NONE)

    b.root.visible = false
    expect(mgr.tryUpdateParts(new Set(['b']))).toBe(false)

    b.root.visible = true
    mgr.rebuild(NONE)
    partsGroup.remove(b.root)
    expect(mgr.tryUpdateParts(new Set(['b']))).toBe(false)
  })

  it('no-ops (true) for a dirty part that was never pooled, leaving the pool untouched', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2)
    addPart(partsGroup, 'c', 2)
    mgr.rebuild(new Set(['a'])) // a exempt → un-pooled; b + c merge

    const pool = pools(scene)[0]!
    expect(pool.count).toBe(4)
    a.root.position.x = 9 // exempt part moves - it renders live, the pool owes it nothing
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(true)
    expect(pools(scene)[0]).toBe(pool)
    expect(pool.count).toBe(4)
    expect(a.mesh.visible).toBe(true)
  })

  it('poisons the signature so the next rebuild re-bakes (a move-back cannot early-out)', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2, { x: 10 })
    mgr.rebuild(NONE)

    a.root.position.x = 5
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(true)
    a.root.position.x = 0 // back to the pose of the last full bake
    mgr.rebuild(NONE) // must not match the stale signature and keep the x=5 rows

    const m = new Matrix4()
    pools(scene)[0]!.getMatrixAt(0, m)
    expect(m.elements[12]).toBe(0)
  })

  it('returns false before any full bake exists', () => {
    const { partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2)
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(false)
  })
})

describe('InstancePoolManager - persistent pool objects (keep WebGPU pipelines warm)', () => {
  it('preserves the pool object identity across select and deselect', () => {
    const { scene, partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 4)
    addPart(partsGroup, 'c', 5)

    mgr.rebuild(NONE)
    const p0 = pools(scene)[0]!
    const uuid = p0.uuid

    mgr.rebuild(new Set(['a'])) // select a → it leaves the pool
    const p1 = pools(scene)[0]!
    expect(p1).toBe(p0) // Same object → uuid stable → three does not compile a fresh pipeline
    expect(p1.count).toBe(9) // b + c only

    mgr.rebuild(NONE) // deselect
    const p2 = pools(scene)[0]!
    expect(p2).toBe(p0)
    expect(p2.uuid).toBe(uuid)
    expect(p2.count).toBe(12) // a + b + c, re-baked in place
  })

  it('parks the pool object (keeps it) when its group empties, and reuses it on return', () => {
    const { scene, partsGroup, mgr } = setup()
    addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 4)

    mgr.rebuild(NONE)
    const p0 = pools(scene)[0]!

    mgr.rebuild(new Set(['a', 'b'])) // all selected → nothing to pool → the pool is detached from the scene
    expect(pools(scene)).toHaveLength(0)

    mgr.rebuild(NONE) // back → the same warm object is reused, not a fresh compile
    const p1 = pools(scene)[0]!
    expect(p1).toBe(p0)
    expect(p1.count).toBe(7)
  })

  it('exposes the hidden sources for pipeline pre-warming', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)
    const uniq = addPart(partsGroup, 'u', 3, { geo: new BoxGeometry(2, 0.5, 1) }) // lone → never pooled/hidden

    mgr.rebuild(NONE)
    const hidden = mgr.hiddenSourceMeshes()
    expect(new Set(hidden)).toEqual(new Set([a.mesh, b.mesh])) // exactly the pooled (hidden) sources
    expect(hidden).not.toContain(uniq.mesh) // the lone live mesh is not hidden, so not in the warm set
    expect(hidden.every((m) => m.visible === false)).toBe(true)
  })

  it('grows a pool in place when a pooled part gains instances (no new object)', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 2)

    mgr.rebuild(NONE)
    const p0 = pools(scene)[0]!
    expect(p0.count).toBe(5)

    // a param edit bumps a's instance count well past the pool's initial capacity
    a.mesh.count = 40
    const im = new Matrix4()
    for (let i = 0; i < 40; i++) a.mesh.setMatrixAt(i, im.makeTranslation(i, 0, 0))
    mgr.rebuild(NONE)

    const p1 = pools(scene)[0]!
    expect(p1).toBe(p0) // grew the instance buffer in place; object identity (pipeline) preserved
    expect(p1.count).toBe(42) // 40 + 2, all addressable in the grown buffer
  })
})

describe('InstancePoolManager - edit-stress (no leaks across many rebuilds)', () => {
  it('restores a source and drops its pool when a part is removed, over repeated churn', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)
    const c = addPart(partsGroup, 'c', 5)

    // hammer rebuilds with alternating instance counts + selection, like a param/structure edit storm
    for (let i = 0; i < 40; i++) {
      a.mesh.count = 3 + (i % 3)
      mgr.rebuild(i % 2 === 0 ? NONE : new Set(['b']))
    }
    // after churn, exactly one bucket, no accumulation of stale pools
    expect(pools(scene).length).toBeLessThanOrEqual(1)

    // remove c (its mesh must be restored visible, not left baked into a stale pool)
    partsGroup.remove(c.root)
    mgr.rebuild(NONE)
    expect(c.mesh.visible).toBe(true) // restored
    const p = pools(scene)
    expect(p).toHaveLength(1)
    expect(p[0]!.count).toBe(a.mesh.count + b.mesh.count) // only the remaining parts
  })

  it('never leaves a hidden source stranded after it becomes ineligible', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)

    mgr.rebuild(NONE)
    expect(a.mesh.visible).toBe(false)

    // a goes ineligible via user-hide (root.visible=false); it must be restored, not stuck hidden
    a.root.visible = false
    mgr.rebuild(NONE)
    // b is now lone → also live; a's mesh visibility was restored to true before b un-pooled
    expect(a.mesh.visible).toBe(true)
    expect(b.mesh.visible).toBe(true)
  })
})

describe('InstancePoolManager - multi-scene / dispose', () => {
  it('re-pools the survivors and restores the dropped parts when the scene changes', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)
    const c = addPart(partsGroup, 'c', 5)
    mgr.rebuild(NONE)

    // simulate loading a different scene: drop two parts, add a new identical one
    partsGroup.remove(b.root)
    partsGroup.remove(c.root)
    const d = addPart(partsGroup, 'd', 6)
    mgr.rebuild(NONE)

    expect(b.mesh.visible).toBe(true) // dropped sources restored
    expect(c.mesh.visible).toBe(true)
    expect(pools(scene)[0]!.count).toBe(a.mesh.count + d.mesh.count) // a + d
  })

  it('dispose restores all sources and detaches the pool group from the scene', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)
    mgr.rebuild(NONE)
    expect(a.mesh.visible).toBe(false)

    mgr.dispose()
    expect(a.mesh.visible).toBe(true)
    expect(b.mesh.visible).toBe(true)
    expect(pools(scene)).toHaveLength(0)
    expect(scene.children.some((o) => o.userData.instancePoolGroup === true)).toBe(false)
  })
})

describe('InstancePoolManager - author-hidden subtrees stay out of the pool', () => {
  // An author-`hidden` rig link (a collision-only wall - e.g. the SDK platform railing's barrier) is an
  // InstancedMesh that is itself visible = true but sits inside a visible = false Group. three's renderer
  // skips the Group, so the pool must too; otherwise its baked world-space copy draws the geometry the
  // original never showed - a grey fallback box where the slim railing should be (the reported bug).
  const greyWallMat = (): MeshStandardMaterial =>
    new MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.4, roughness: 0.5 }) // distinct render identity from stdMat

  function addHiddenWall(part: Part, mat: Material): InstancedMesh {
    const hiddenGroup = new Group()
    hiddenGroup.visible = false // the author-eye "hidden" flag, applied to the link's render Group
    const mesh = new InstancedMesh(sharedGeo, mat, 1)
    mesh.setMatrixAt(0, new Matrix4())
    mesh.instanceMatrix.needsUpdate = true
    hiddenGroup.add(mesh)
    part.root.add(hiddenGroup)
    return mesh
  }

  it('never pools an InstancedMesh inside a visible=false group, nor bakes it into a pool copy', () => {
    const { scene, partsGroup, mgr } = setup()
    // two ordinary steel parts so pooling itself is exercised (they merge by render-identity)
    addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 3)
    // a platform-like part: a visible steel mesh plus two hidden "collision walls" that share one distinct
    // (grey) signature. If traverse() reaches them, they form their own 2-member pool.
    const host = addPart(partsGroup, 'host', 2)
    const w1 = addHiddenWall(host, greyWallMat())
    const w2 = addHiddenWall(host, greyWallMat())

    mgr.rebuild(NONE)

    const ps = pools(scene)
    expect(ps).toHaveLength(1) // only the steel bucket (a + b + host) - no grey-wall pool
    expect(ps[0]!.count).toBe(8) // 3 + 3 + 2 steel instances; the two walls are absent
    // the hidden walls are untouched: never made a pool source, so their state is exactly as authored
    expect(w1.visible).toBe(true)
    expect(w2.visible).toBe(true)
    expect(w1.parent!.visible).toBe(false) // still inside the hidden group the renderer skips
  })

  it('keeps the wall out even when a visible twin of the same signature would merge with it', () => {
    const { scene, partsGroup, mgr } = setup()
    const wallMat = greyWallMat()
    // a visible grey mesh on part 'a' and a hidden grey mesh on part 'b' share a signature. Only the
    // visible one is eligible → it's a lone member → nothing pools; the hidden one is never dragged in.
    addPart(partsGroup, 'a', 3, { mat: wallMat })
    const b = addPart(partsGroup, 'b', 3)
    const hidden = addHiddenWall(b, wallMat)

    mgr.rebuild(NONE)

    expect(pools(scene)).toHaveLength(0) // the visible grey mesh is lone; the hidden twin can't complete a pair
    expect(hidden.visible).toBe(true)
    expect(hidden.parent!.visible).toBe(false)
  })

  it('never pools a leaf hidden by someone else (author hide, staticFold source) - only its own pool-hidden leaves', () => {
    const { scene, partsGroup, mgr } = setup()
    const wallMat = greyWallMat()
    const a = addPart(partsGroup, 'a', 3, { mat: wallMat })
    const b = addPart(partsGroup, 'b', 3, { mat: greyWallMat() }) // identical render identity → would merge with a
    b.mesh.visible = false // hidden directly on the leaf, without the pool's poolHidden tag

    mgr.rebuild(NONE)

    expect(pools(scene)).toHaveLength(0) // a's mesh is lone; the foreign-hidden twin can't complete the pair
    expect(b.mesh.visible).toBe(false) // and it isn't resurrected by a pool generation
    void a
  })
})

describe('InstancePoolManager - exclusions stay live', () => {
  const cases: { name: string; taint: (m: InstancedMesh) => void }[] = [
    { name: 'dynamicInstances', taint: (m) => { m.userData.dynamicInstances = true } },
    { name: 'instanceColor', taint: (m) => { m.setColorAt(0, new Color(1, 1, 1)) } },
    { name: 'non-default layer', taint: (m) => { m.layers.set(1) } },
    { name: 'spinUniform material', taint: (m) => { (m.material as Material).userData.spinUniform = { value: 0 } } },
    // multi-material draws by geometry groups, which the pool wrapper doesn't carry - the copy would draw nothing
    { name: 'array material', taint: (m) => { m.material = [m.material as Material] } },
  ]
  for (const { name, taint } of cases) {
    it(`excludes a ${name} mesh even when a twin would otherwise merge with it`, () => {
      const { scene, partsGroup, mgr } = setup()
      const a = addPart(partsGroup, 'a', 3)
      const b = addPart(partsGroup, 'b', 3)
      const t = addPart(partsGroup, 't', 3)
      taint(t.mesh)

      mgr.rebuild(NONE)
      expect(t.mesh.visible).toBe(true) // never pooled
      // the untainted twins still merge (2 members), so pooling itself isn't broken
      expect(pools(scene)[0]!.count).toBe(6)
      void a
      void b
    })
  }

  // two identical see-through banks would merge with each other, so this fails if the rule is missing
  const seeThrough: { name: string; mat: () => Material }[] = [
    { name: 'transparent', mat: () => new MeshStandardMaterial({ color: 0x334455, transparent: true, opacity: 0.4 }) },
    { name: 'transmissive', mat: () => new MeshPhysicalMaterial({ color: 0x334455, transmission: 1 }) },
  ]
  for (const { name, mat } of seeThrough) {
    it(`keeps ${name} instanced twins live (three sorts them per object), as the poolUnit path does`, () => {
      const { scene, partsGroup, mgr } = setup()
      addPart(partsGroup, 'a', 3)
      addPart(partsGroup, 'b', 3)
      const g1 = addPart(partsGroup, 'g1', 2, { mat: mat() })
      const g2 = addPart(partsGroup, 'g2', 2, { mat: mat() })

      mgr.rebuild(NONE)
      expect(g1.mesh.visible).toBe(true)
      expect(g2.mesh.visible).toBe(true)
      const all = pools(scene)
      expect(all).toHaveLength(1) // only the opaque twins
      expect(all[0]!.count).toBe(6)
    })
  }
})

describe('InstancePoolManager - runtime-mobile rig subtrees stay out of the pool', () => {
  // A link FK moves every frame (a joint, an aim constraint, a setSubPose) is stamped `poolMobile` by
  // rig.ts. The bake is world-space and only re-runs on structural events, so merging such a bank leaves
  // a copy frozen at the last-baked pose - the turntable's roller-holder rails and rim bolts standing
  // still at the old deck angle while the rollers (spin material ⇒ already exempt) turned with the platter.
  /** a bank on a `poolMobile` group, optionally one level down (the turntable's shape: its holders
   *  hang off the roller link, a child of the rotating deck) */
  function addMobileBank(part: Part, mat: Material, nested: boolean): InstancedMesh {
    const deck = new Group()
    deck.userData.poolMobile = true
    const host = nested ? new Group() : deck
    if (nested) deck.add(host)
    const mesh = new InstancedMesh(sharedGeo, mat, 1)
    mesh.setMatrixAt(0, new Matrix4())
    mesh.instanceMatrix.needsUpdate = true
    host.add(mesh)
    part.root.add(deck)
    return mesh
  }

  for (const nested of [false, true]) {
    it(`never pools a bank ${nested ? 'under a child of' : 'on'} a mobile link, even when a twin would merge with it`, () => {
      const { scene, partsGroup, mgr } = setup()
      const mat = stdMat()
      // 'a' and 'b' are ordinary static twins that must still merge; the mobile bank shares their signature
      addPart(partsGroup, 'a', 3, { mat })
      const b = addPart(partsGroup, 'b', 3, { mat: stdMat() })
      const deckBank = addMobileBank(b, stdMat(), nested)

      mgr.rebuild(NONE)

      expect(deckBank.visible).toBe(true) // never pooled ⇒ it draws live and follows the joint
      expect(deckBank.userData.poolHidden).toBeUndefined()
      expect(pools(scene)[0]!.count).toBe(6) // a + b only: the mobile bank's instance is absent
    })
  }

  it('keeps a poolUnit leaf under a mobile link live too (the plain-mesh half of the same rule)', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 1)
    const b = addPart(partsGroup, 'b', 1)
    const mobile = new Group()
    mobile.userData.poolMobile = true
    const cap = new Mesh(sharedGeo, stdMat()) // a push-button cap: tagged poolUnit but moved by setSubPose
    cap.userData.poolUnit = true
    mobile.add(cap)
    b.root.add(mobile)

    mgr.rebuild(NONE)

    expect(cap.visible).toBe(true)
    expect(pools(scene)[0]!.count).toBe(2) // the two banks; the cap contributed nothing
    void a
  })

  it('restores a bank that becomes mobile after it was already pooled (the runtime backstop)', () => {
    const { scene, partsGroup, mgr } = setup()
    const mat = stdMat()
    const a = addPart(partsGroup, 'a', 3, { mat })
    const b = addPart(partsGroup, 'b', 3, { mat: stdMat() })
    mgr.rebuild(NONE)
    expect(b.mesh.visible).toBe(false) // merged
    expect(pools(scene)[0]!.count).toBe(6)

    // rig.ts's unpoolSubtree: the link turned out to move, so it stamps the group and hands the source back
    b.root.userData.poolMobile = true
    b.mesh.visible = true
    delete b.mesh.userData.poolHidden

    mgr.rebuild(NONE)

    expect(b.mesh.visible).toBe(true) // stays live from here on
    // 'a' is left alone in its bucket, so its pool is parked (a lone member never merges) and it draws live
    expect(pools(scene)).toHaveLength(0)
    expect(a.mesh.visible).toBe(true)
  })
})

describe('InstancePoolManager - plain poolUnit meshes (static rig unit-primitive links)', () => {
  // rig.ts tags a static rig's box/cylinder/cone link meshes with userData.poolUnit: a plain Mesh whose
  // size lives in mesh.scale. The pool ingests each as one instance (its world matrix), so a straight
  // roller conveyor's walls/flanges/guards merge across parts exactly like the instanced leg banks.
  function addUnitLink(part: Part, mat: Material, opts: { x?: number; sx?: number; tag?: boolean } = {}): Mesh {
    const mesh = new Mesh(sharedGeo, mat)
    mesh.position.x = opts.x ?? 0
    mesh.scale.set(opts.sx ?? 1, 1, 1)
    if (opts.tag !== false) mesh.userData.poolUnit = true
    part.root.add(mesh)
    return mesh
  }

  it('merges tagged unit meshes across parts into one pool, baking position and scale via the world matrix', () => {
    const { scene, partsGroup, mgr } = setup()
    const linkMat = new MeshStandardMaterial({ color: 0x334455, metalness: 0.7, roughness: 0.3 })
    const a = addPart(partsGroup, 'a', 2)
    const b = addPart(partsGroup, 'b', 2, { x: 10 })
    const la = addUnitLink(a, linkMat, { x: 1, sx: 4 })
    const lb = addUnitLink(b, linkMat, { x: 1, sx: 7 })

    mgr.rebuild(NONE)

    const ps = pools(scene)
    expect(ps).toHaveLength(2) // the instanced steel bucket + the unit-link bucket
    const linkPool = ps.find((p) => (p.material as MeshStandardMaterial).color.getHex() === 0x334455)!
    expect(linkPool.count).toBe(2)
    expect(la.visible).toBe(false)
    expect(lb.visible).toBe(false)
    // instance 1 carries part b's translation (10 + 1) and the link's own scale (7) in one matrix
    const m = new Matrix4()
    linkPool.getMatrixAt(1, m)
    expect(m.elements[12]).toBeCloseTo(11)
    expect(m.elements[0]).toBeCloseTo(7)
  })

  it('selection excludes the part: its unit links come back live; deselect re-pools them', () => {
    const { scene, partsGroup, mgr } = setup()
    const linkMat = new MeshStandardMaterial({ color: 0x334455, metalness: 0.7, roughness: 0.3 })
    const a = addPart(partsGroup, 'a', 2)
    const b = addPart(partsGroup, 'b', 2)
    const la = addUnitLink(a, linkMat)
    const lb = addUnitLink(b, linkMat)

    mgr.rebuild(NONE)
    expect(la.visible).toBe(false)
    mgr.rebuild(new Set(['a']))
    expect(la.visible).toBe(true) // selected part renders live (outline + drag)
    expect(lb.visible).toBe(true) // its lone twin has nothing to merge with → left live too
    mgr.rebuild(NONE)
    expect(la.visible).toBe(false)
    expect(lb.visible).toBe(false)
    expect(pools(scene).find((p) => (p.material as MeshStandardMaterial).color.getHex() === 0x334455)!.count).toBe(2)
  })

  it('ignores untagged plain meshes, tagged meshes with children (edges), and transparent materials', () => {
    const { scene, partsGroup, mgr } = setup()
    const linkMat = new MeshStandardMaterial({ color: 0x334455, metalness: 0.7, roughness: 0.3 })
    const a = addPart(partsGroup, 'a', 2)
    const b = addPart(partsGroup, 'b', 2)
    const untagged1 = addUnitLink(a, linkMat, { tag: false })
    const untagged2 = addUnitLink(b, linkMat, { tag: false })
    const withChild = addUnitLink(a, linkMat)
    withChild.add(new Group()) // stand-in for an edges/label child the pool copy would drop
    const withChild2 = addUnitLink(b, linkMat)
    withChild2.add(new Group())
    const glassMat = new MeshStandardMaterial({ color: 0x334455, transparent: true, opacity: 0.5 })
    const glassy1 = addUnitLink(a, glassMat)
    const glassy2 = addUnitLink(b, glassMat)

    mgr.rebuild(NONE)

    for (const m of [untagged1, untagged2, withChild, withChild2, glassy1, glassy2]) expect(m.visible).toBe(true)
    expect(pools(scene)).toHaveLength(1) // only the instanced steel bucket pooled
  })

  it('leaves the subtree of a static-fold root to the fold', () => {
    // the building's wall runs are fold roots: a bank the fold leaves live (one source in its bucket) must
    // stay drawn from inside its run, or hiding it for the pool reads as a stale fold
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 2)
    addPart(partsGroup, 'b', 2)
    const run = new Group()
    run.userData.staticFoldRoot = true
    a.root.add(run)
    const folded = new InstancedMesh(sharedGeo, stdMat(), 1)
    run.add(folded)

    mgr.rebuild(NONE)

    expect(folded.visible).toBe(true)
    expect(folded.userData.poolHidden).toBeUndefined()
    expect(a.mesh.visible).toBe(false) // the part's own hardware still pools
    expect(pools(scene)[0]!.count).toBe(4)
  })

  // A GLB mesh link (rig.ts tagPoolLeaves) is a different shape from a unit primitive: an async-loaded
  // subtree of per-primitive leaves under nested nodes, whose geometry+material objects are shared
  // across parts (prepareMeshInstance clones the cached scene, and three's clone() shares both). These
  // pin what that shape must do - the pool needs no per-leaf transform of its own, only world matrices.
  describe('GLB mesh-link leaves (an async-attached dressing subtree)', () => {
    /** a two-primitive "GLB" under a node with its own offset - the housing/lens split of a sensor */
    function addGlbLink(part: Part, mats: readonly Material[], nodeY: number): { node: Group; leaves: Mesh[] } {
      const link = new Group() // the rig link group
      const node = new Group() // the GLB's own node transform (fitHeight/authored offset)
      node.position.y = nodeY
      const leaves = mats.map((mat, i) => {
        const m = new Mesh(sharedGeo, mat) // shared geometry, as a cloned GLB has
        m.position.x = i * 0.1
        m.userData.poolUnit = true
        node.add(m)
        return m
      })
      link.add(node)
      part.root.add(link)
      return { node, leaves }
    }

    it('merges each primitive across parts and bakes the intermediate node transform into the instance', () => {
      const { scene, partsGroup, mgr } = setup()
      const housing = new MeshStandardMaterial({ color: 0x223344 })
      const lens = new MeshStandardMaterial({ color: 0xaa2211 })
      const a = addPart(partsGroup, 'a', 2)
      const b = addPart(partsGroup, 'b', 2, { x: 10 })
      const ga = addGlbLink(a, [housing, lens], 0.5)
      const gb = addGlbLink(b, [housing, lens], 0.5)

      mgr.rebuild(NONE)

      // one pool per primitive (distinct material), each holding both parts - this is the merge that
      // scales: N copies of one dressing asset cost one draw per primitive, not N.
      const dressing = pools(scene).filter((p) => {
        const hex = (p.material as MeshStandardMaterial).color.getHex()
        return hex === 0x223344 || hex === 0xaa2211
      })
      expect(dressing).toHaveLength(2)
      for (const p of dressing) expect(p.count).toBe(2)
      for (const m of [...ga.leaves, ...gb.leaves]) expect(m.visible).toBe(false)

      // part b's housing instance = part translation (10) + leaf offset (0), with the GLB node's Y
      const housingPool = dressing.find((p) => (p.material as MeshStandardMaterial).color.getHex() === 0x223344)!
      const m4 = new Matrix4()
      housingPool.getMatrixAt(1, m4)
      expect(m4.elements[12]).toBeCloseTo(10)
      expect(m4.elements[13]).toBeCloseTo(0.5)
    })

    it('re-bakes when the link subtree moves (a subPose the tag survived) - no stale merged copy', () => {
      // rig.ts keeps subPose'd links out of the pool, and rigPlacement.ts untags at the first move as a backstop.
      // This pins the layer below that: if a pooled leaf's ancestor moves, the signature must notice.
      const { scene, partsGroup, mgr } = setup()
      const mat = new MeshStandardMaterial({ color: 0x223344 })
      const a = addPart(partsGroup, 'a', 2)
      const b = addPart(partsGroup, 'b', 2, { x: 10 })
      const ga = addGlbLink(a, [mat], 0)
      addGlbLink(b, [mat], 0)
      mgr.rebuild(NONE)
      const pool = pools(scene).find((p) => (p.material as MeshStandardMaterial).color.getHex() === 0x223344)!
      const m4 = new Matrix4()
      pool.getMatrixAt(0, m4)
      expect(m4.elements[14]).toBeCloseTo(0)

      ga.node.position.z = -0.02 // the "cap depresses"
      mgr.rebuild(NONE)
      pool.getMatrixAt(0, m4)
      expect(m4.elements[14]).toBeCloseTo(-0.02)
    })

    it('leaves a lone dressing part live (nothing to merge with)', () => {
      const { scene, partsGroup, mgr } = setup()
      const mat = new MeshStandardMaterial({ color: 0x223344 })
      const a = addPart(partsGroup, 'a', 2)
      const ga = addGlbLink(a, [mat], 0)
      mgr.rebuild(NONE)
      for (const m of ga.leaves) expect(m.visible).toBe(true)
      expect(pools(scene).some((p) => (p.material as MeshStandardMaterial).color.getHex() === 0x223344)).toBe(false)
    })
  })
})

describe('InstancePoolManager - write-through drag (pose row rewrites, no membership change)', () => {
  /** the pooled row's world translation for the first instance of part `id` */
  const firstRowX = (scene: Scene, mgr: InstancePoolManager, id: string): number | null => {
    const pool = pools(scene)[0]
    if (!pool) return null
    const attrs = (mgr as unknown as { pools: Map<string, { attrs?: { members: { partId: string; offset: number }[] } }> }).pools
    for (const entry of attrs.values()) {
      const mem = entry.attrs?.members.find((m) => m.partId === id)
      if (!mem) continue
      const m4 = new Matrix4()
      pool.getMatrixAt(mem.offset, m4)
      return m4.elements[12]!
    }
    return null
  }

  it('rewrites only the dragged part rows in place and leaves membership/visibility untouched', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3, { x: 0 })
    const b = addPart(partsGroup, 'b', 3, { x: 10 })
    mgr.rebuild(NONE)
    expect(pools(scene)).toHaveLength(1)
    expect(firstRowX(scene, mgr, 'a')).toBeCloseTo(0)
    expect(firstRowX(scene, mgr, 'b')).toBeCloseTo(10)

    // the drag moves part a's root; write-through follows without a rebuild
    a.root.position.x = 5
    mgr.writeThrough(new Set(['a']))
    expect(firstRowX(scene, mgr, 'a')).toBeCloseTo(5)
    expect(firstRowX(scene, mgr, 'b')).toBeCloseTo(10) // untouched
    expect(a.mesh.visible).toBe(false) // still pooled - no eject
    expect(b.mesh.visible).toBe(false)
    expect(pools(scene)).toHaveLength(1)
  })

  it('poisons the signature so an aborted drag (back to the start pose) still re-bakes', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3, { x: 0 })
    addPart(partsGroup, 'b', 3, { x: 10 })
    mgr.rebuild(NONE)

    a.root.position.x = 7
    mgr.writeThrough(new Set(['a']))
    expect(firstRowX(scene, mgr, 'a')).toBeCloseTo(7)
    // abort: the transient reverts the root to its start pose - the recomputed signature now
    // matches the last bake's poses, so without poisoning the rebuild would early-out and leave
    // the mid-drag row (7) in the buffer
    a.root.position.x = 0
    mgr.rebuild(NONE)
    expect(firstRowX(scene, mgr, 'a')).toBeCloseTo(0)
  })

  it('skips a stale member whose source count changed (structural fallback territory)', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3, { x: 0 })
    addPart(partsGroup, 'b', 3, { x: 10 })
    mgr.rebuild(NONE)
    a.mesh.count = 2 // structural change the caller should have ejected for
    a.root.position.x = 5
    expect(() => mgr.writeThrough(new Set(['a']))).not.toThrow()
    // row not rewritten (stale member skipped); the poisoned-or-next rebuild trues it up
    mgr.rebuild(NONE)
    expect(pools(scene)[0]!.count).toBe(5) // 2 + 3 after the re-bake
  })
})

describe('InstancePoolManager - auditCoherence (merge-coherence invariant)', () => {
  it('passes after a bake; fails when a folded bank is rewritten with no re-bake; recovers on rebuild', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 4)
    mgr.rebuild(NONE)
    expect(mgr.auditCoherence(NONE).ok).toBe(true)
    // a structure cut rewriting a pooled source bank in place (count + buffer version) - the
    // stair→platform railing class: without a re-bake the merged copy on screen is stale
    a.mesh.count = 2
    a.mesh.instanceMatrix.needsUpdate = true
    expect(mgr.auditCoherence(NONE).ok).toBe(false)
    mgr.rebuild(NONE)
    expect(mgr.auditCoherence(NONE).ok).toBe(true)
  })

  it('fails at idle while write-through-poisoned (a drag ended without its re-bake), recovers on rebuild', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 4)
    mgr.rebuild(NONE)
    a.root.position.x = 2 // mid-drag pose stream
    mgr.writeThrough(new Set(['a'])) // rows rewritten in place; signature poisoned
    expect(mgr.auditCoherence(NONE).ok).toBe(false)
    mgr.rebuild(NONE) // the release's guaranteed re-bake
    expect(mgr.auditCoherence(NONE).ok).toBe(true)
  })

  it('after a dirty-scoped edit (no re-bake follows), audits the rewritten rows against their sources', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 4)
    mgr.rebuild(NONE)
    a.root.position.x = 2 // an idle commit that moved the part
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(true)
    expect(mgr.auditCoherence(NONE).ok).toBe(true) // rows match the sources: nothing stale
    a.root.position.x = 3 // ...then the source moves with no rewrite: stale merged copies
    expect(mgr.auditCoherence(NONE).ok).toBe(false)
    // a drag's poison is never downgraded by a later scoped rewrite
    mgr.writeThrough(new Set(['a']))
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(true)
    expect(mgr.auditCoherence(NONE).reason).toMatch(/drag ended/)
  })
})

describe('InstancePoolManager - ejectParts (scoped mid-drag ejection)', () => {
  it('zeroes the part rows in place, drops member records, restores sources live, poisons the sig', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 4)
    mgr.rebuild(NONE)
    const pool = pools(scene)[0]!
    expect(pool.count).toBe(7)

    mgr.ejectParts(new Set(['a']))
    expect(a.mesh.visible).toBe(true) // source renders live again
    expect(a.mesh.userData.poolHidden).toBeUndefined()
    expect(b.mesh.visible).toBe(false) // untouched member stays pooled
    expect(pool.count).toBe(7) // rows zeroed, NOT compacted - no other member's offset moved
    const m = new Matrix4()
    pool.getMatrixAt(0, m) // 'a' baked first → offset 0
    expect(m.elements[0]).toBe(0) // degenerate zero-scale row
    // member record dropped: a later writeThrough for 'a' must not resurrect the dead rows
    a.root.position.x = 5
    mgr.writeThrough(new Set(['a']))
    pool.getMatrixAt(0, m)
    expect(m.elements[0]).toBe(0)
    // poisoned signature → audit fails until the release's full re-bake trues everything up
    expect(mgr.auditCoherence(NONE).ok).toBe(false)
    mgr.rebuild(new Set(['a'])) // the release, 'a' still exempt (promoted until drag end)
    expect(mgr.auditCoherence(new Set(['a'])).ok).toBe(true)
    expect(b.mesh.visible).toBe(true) // lone survivor un-pools and draws live
  })
})

describe('InstancePoolManager - in-place repaint (colorParam links)', () => {
  // rig.ts's `colorParam` links repaint via `mat.color.set(...)` on the same material object, and the
  // merge key folds colour in - so a repaint has to move that mesh into a different pool. Material
  // identity cannot see it, which is why the bake signature and tryUpdateParts track the tint. These
  // are the specs that let those links into the pool at all (rig.ts poolUnit opt-in).
  const hexOf = (m: InstancedMesh): number => (m.material as MeshStandardMaterial).color.getHex()

  it('splits a repainted twin out of its pool instead of recolouring the others', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 3)
    const c = addPart(partsGroup, 'c', 3)
    mgr.rebuild(NONE)
    expect(pools(scene)).toHaveLength(1)
    expect(pools(scene)[0]!.count).toBe(9)

    // repaint one - the head of the pool, the case that can drag its twins' colour along
    ;(a.mesh.material as MeshStandardMaterial).color.set(0xff0000)
    mgr.rebuild(NONE)

    const ps = pools(scene)
    expect(ps).toHaveLength(1) // b + c still merge; 'a' is now a lone colour
    expect(ps[0]!.count).toBe(6)
    expect(hexOf(ps[0]!)).toBe(0x808080) // ...and draws the original grey, not a's red
    expect(a.mesh.visible).toBe(true) // the repainted one renders live with its own material
    expect(b.mesh.visible).toBe(false)
    expect(c.mesh.visible).toBe(false)
  })

  it('re-merges when a twin is repainted back to match', () => {
    const { scene, partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 3)
    mgr.rebuild(NONE)
    expect(pools(scene)[0]!.count).toBe(6)

    ;(a.mesh.material as MeshStandardMaterial).color.set(0xff0000)
    mgr.rebuild(NONE)
    expect(pools(scene)).toHaveLength(0) // two lone colours - nothing left to merge

    ;(a.mesh.material as MeshStandardMaterial).color.set(0x808080)
    mgr.rebuild(NONE)
    expect(pools(scene)[0]!.count).toBe(6)
    expect(hexOf(pools(scene)[0]!)).toBe(0x808080)
  })

  it('a repaint moves the bake signature, so the coherence audit catches a missed rebuild', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 3)
    mgr.rebuild(NONE)
    expect(mgr.auditCoherence(NONE).ok).toBe(true)

    ;(a.mesh.material as MeshStandardMaterial).color.set(0x00ff00)
    expect(mgr.auditCoherence(NONE).ok).toBe(false) // stale merged copies until a re-bake
    mgr.rebuild(NONE)
    expect(mgr.auditCoherence(NONE).ok).toBe(true)
  })

  it('tryUpdateParts refuses a repaint - its rows belong in another pool', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    addPart(partsGroup, 'b', 3)
    mgr.rebuild(NONE)
    // a pure pose edit is still row-rewritable (the fast path this must not break)
    a.root.position.x = 2
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(true)
    mgr.rebuild(NONE)

    ;(a.mesh.material as MeshStandardMaterial).color.set(0x0000ff)
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(false) // caller must fall back to rebuild()
  })

  it('drops the orphaned colour pool instead of parking one per colour scrubbed through', () => {
    const { partsGroup, mgr } = setup()
    const a = addPart(partsGroup, 'a', 3)
    const b = addPart(partsGroup, 'b', 3)
    mgr.rebuild(NONE)
    expect(mgr.debugPoolCount()).toBe(1)

    // a colour-picker drag: both twins tracking the same new colour each step, so each step's pool
    // is orphaned by the next. Parking them all would grow the map by one dead pool per colour.
    for (const hex of [0x111111, 0x222222, 0x333333, 0x444444, 0x555555]) {
      ;(a.mesh.material as MeshStandardMaterial).color.set(hex)
      ;(b.mesh.material as MeshStandardMaterial).color.set(hex)
      mgr.rebuild(NONE)
    }
    expect(mgr.debugPoolCount()).toBe(1) // only the live colour's pool survives
  })
})

describe('InstancePoolManager - plain meshes with their own geometry, rewritten in place (function parts)', () => {
  // A function part (functionMesh.ts) realizes each submesh into a geometry of its own, and on a param
  // change at constant topology rewrites that geometry's buffers in place. Identical parts still merge
  // (the pool matches by content), and an in-place rewrite must reach the merged copy.
  const matOf = (): MeshStandardMaterial => new MeshStandardMaterial({ color: 0x556677, metalness: 0.2, roughness: 0.7 })
  function addOwnGeoMesh(part: Part, mat: Material): Mesh {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), mat)
    mesh.userData.poolUnit = true
    part.root.add(mesh)
    return mesh
  }
  const stretchX = (mesh: Mesh, k: number): void => {
    const pos = mesh.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) * k)
    pos.needsUpdate = true
  }
  const poolOf = (scene: Scene): InstancedMesh | undefined => pools(scene).find((p) => (p.material as MeshStandardMaterial).color.getHex() === 0x556677)

  it('merges byte-identical geometries that are distinct objects', () => {
    const { scene, partsGroup, mgr } = setup()
    const mat = matOf()
    const ma = addOwnGeoMesh(addPart(partsGroup, 'a', 2), mat)
    const mb = addOwnGeoMesh(addPart(partsGroup, 'b', 2, { x: 5 }), mat)
    expect(ma.geometry).not.toBe(mb.geometry)
    mgr.rebuild(NONE)
    expect(poolOf(scene)?.count).toBe(2)
    expect(ma.visible).toBe(false)
  })

  it('an in-place rewrite of one member is seen: the dirty-scoped path refuses, the audit flags it, a rebuild splits it out', () => {
    const { scene, partsGroup, mgr } = setup()
    const mat = matOf()
    const ma = addOwnGeoMesh(addPart(partsGroup, 'a', 2), mat)
    const mb = addOwnGeoMesh(addPart(partsGroup, 'b', 2, { x: 5 }), mat)
    mgr.rebuild(NONE)
    stretchX(ma, 2) // same object, same topology, same pose: only the vertices moved
    expect(mgr.tryUpdateParts(new Set(['a']))).toBe(false)
    expect(mgr.auditCoherence(NONE).ok).toBe(false)
    mgr.rebuild(NONE)
    expect(poolOf(scene)).toBeUndefined() // two different shapes now: nothing to merge
    expect(ma.visible).toBe(true)
    expect(mb.visible).toBe(true)
    expect(mgr.auditCoherence(NONE).ok).toBe(true)
  })

  it('both members rewritten the same way re-merge onto the new vertices', () => {
    const { scene, partsGroup, mgr } = setup()
    const mat = matOf()
    const ma = addOwnGeoMesh(addPart(partsGroup, 'a', 2), mat)
    const mb = addOwnGeoMesh(addPart(partsGroup, 'b', 2, { x: 5 }), mat)
    mgr.rebuild(NONE)
    stretchX(ma, 3)
    stretchX(mb, 3)
    mgr.rebuild(NONE)
    const pool = poolOf(scene)!
    expect(pool.count).toBe(2)
    pool.geometry.computeBoundingBox()
    expect(pool.geometry.boundingBox!.max.x).toBeCloseTo(1.5) // 0.5 * 3, not the baked 0.5
  })
})
