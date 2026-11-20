import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart } from '../../core/types'
import { ROLLER_MODEL_RADIUS } from './common'
import { createCustomVisual, rigRollerSpinRadius } from './sdkPart'
import { examplePart, type RigGeo } from './examplePart'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

const pkg = (length: number, width: number): PartPackage => ({
  format: PACKAGE_FORMAT,
  id: 'acme.deck',
  name: 'Deck',
  params: {},
  behavior: 'definePart({ step(){} })',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [length, 0.1, width] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length, width, top: 0.05, bottom: -0.1 } },
})

const part = (): SdkPart => ({ id: 'cp_1', type: 'part', packageId: 'acme.deck', position: [1, 2, 3], rotationY: 0, params: {} })

beforeEach(() => clearPackages())

describe('createCustomVisual', () => {
  it('sizes the deck from the registered package and places the group at the part', () => {
    registerPackage(pkg(6, 2))
    const v = createCustomVisual(part())
    expect(v.object.position.toArray()).toEqual([1, 2, 3])
    // a one-box conveyor is a rig: its 'deck' link carries the slab, a 0.1-thick box with its top at the origin
    const link = findLink(v.object, 'deck')!
    const deck = link.children.find((c) => (c as Mesh).isMesh) as Mesh
    expect(deck.scale.x).toBe(6)
    expect(deck.scale.z).toBe(2)
    expect(link.position.y).toBeCloseTo(-0.05)
    v.dispose()
  })

  it('reflows on update when the package geometry changes (hot-reload resize)', () => {
    registerPackage(pkg(6, 2))
    const v = createCustomVisual(part())
    registerPackage(pkg(10, 3)) // author resized the deck on disk
    v.update(part())
    const deck = findLink(v.object, 'deck')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    expect(deck.scale.x).toBe(10)
    expect(deck.scale.z).toBe(3)
    v.dispose()
  })

  it('falls back to a unit deck when the package is not registered', () => {
    const v = createCustomVisual(part())
    const deck = v.object.children[0] as Mesh
    expect(deck.scale.x).toBe(1)
    expect(deck.scale.z).toBe(1)
    v.dispose()
  })
})

const rigPkg = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): PartPackage =>
  ({
    format: PACKAGE_FORMAT,
    id: 'acme.arm',
    name: 'Arm',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
        { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0.3, 0] },
      ],
      joints: [{ name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI }],
      ...over,
    },
    ...top,
  }) as PartPackage

const rigPart = (): SdkPart => ({ id: 'cp_1', type: 'part', packageId: 'acme.arm', position: [0, 0, 0], rotationY: 0, params: {} })
const findLink = (root: Object3D, name: string): Object3D | undefined => {
  let found: Object3D | undefined
  root.traverse((o) => { if (o.userData.linkName === name) found = o })
  return found
}

describe('createCustomVisual (rig geometry)', () => {
  it('builds the link hierarchy at its rest pose', () => {
    registerPackage(rigPkg())
    const v = createCustomVisual(rigPart())
    const base = findLink(v.object, 'base')!
    const arm = findLink(v.object, 'arm')!
    expect(base).toBeTruthy()
    expect(arm.parent).toBe(base) // parented per link.parent
    expect(arm.position.toArray()).toEqual([0, 0.3, 0]) // rest offset
    v.dispose()
  })

  it('applyJoints rotates a revolute joint and clamps to its limits', () => {
    registerPackage(rigPkg())
    const v = createCustomVisual(rigPart())
    const arm = findLink(v.object, 'arm')!
    const applyJoints = v.object.userData.applyJoints as (j: Record<string, number>) => void
    applyJoints({ shoulder: Math.PI / 2 })
    expect(arm.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2))).toBeLessThan(1e-6)
    applyJoints({ shoulder: 100 }) // clamped to max π
    expect(arm.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI))).toBeLessThan(1e-6)
    v.dispose()
  })

  it('applyJoints translates a prismatic joint along its axis', () => {
    registerPackage(rigPkg({ joints: [{ name: 'lift', link: 'arm', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 1 }] }))
    const v = createCustomVisual(rigPart())
    const arm = findLink(v.object, 'arm')!
    ;(v.object.userData.applyJoints as (j: Record<string, number>) => void)({ lift: 0.5 })
    expect(arm.position.y).toBeCloseTo(0.8, 6) // rest 0.3 + axis·0.5
    v.dispose()
  })

  it('applySubPoses overrides a link local pose (setSubPose)', () => {
    registerPackage(rigPkg())
    const v = createCustomVisual(rigPart())
    const arm = findLink(v.object, 'arm')!
    ;(v.object.userData.applySubPoses as (p: Record<string, { position?: [number, number, number]; rotation?: [number, number, number] }>) => void)({ arm: { position: [1, 2, 3] } })
    expect(arm.position.toArray()).toEqual([1, 2, 3])
    v.dispose()
  })

  it('resetRunPose drops the run\'s subPoses, so a refresh after Stop lays the link at rest', () => {
    // a jointless rig driven only by setSubPose (a sorter's shoes): applyJoints({}) has nothing to clear
    registerPackage(rigPkg())
    const part = rigPart()
    const v = createCustomVisual(part)
    const arm = findLink(v.object, 'arm')!
    const rest = arm.position.toArray()
    ;(v.object.userData.applySubPoses as (p: Record<string, { position?: [number, number, number] }>) => void)({ arm: { position: [1, 2, 3] } })
    v.update(part)
    expect(arm.position.toArray()).toEqual([1, 2, 3]) // a refresh alone keeps the run's last subPose
    const before = v.object.userData.poseRev as number
    ;(v.object.userData.resetRunPose as () => void)()
    v.update(part)
    expect(arm.position.toArray()).toEqual(rest)
    expect(v.object.userData.poseRev as number).toBeGreaterThan(before)
    v.dispose()
  })

  // the matrix freeze (viewMatrices.ts) keeps every rig frozen and relies on these self-reports to know
  // when to re-bake - a mutator that moves transforms without bumping poseRev renders stale
  it('applyJoints bumps the visual poseRev (frozen-subtree self-invalidation)', () => {
    registerPackage(rigPkg())
    const v = createCustomVisual(rigPart())
    const before = v.object.userData.poseRev as number
    ;(v.object.userData.applyJoints as (j: Record<string, number>) => void)({ shoulder: 0.5 })
    expect(v.object.userData.poseRev as number).toBeGreaterThan(before)
    v.dispose()
  })

  it('applySubPoses bumps poseRev only when a named link actually exists', () => {
    registerPackage(rigPkg())
    const v = createCustomVisual(rigPart())
    const applySubPoses = v.object.userData.applySubPoses as (p: Record<string, { position?: [number, number, number] }>) => void
    const before = v.object.userData.poseRev as number
    applySubPoses({ nosuchlink: { position: [1, 1, 1] } })
    expect(v.object.userData.poseRev as number).toBe(before) // nothing moved - no re-bake
    applySubPoses({ arm: { position: [1, 2, 3] } })
    expect(v.object.userData.poseRev as number).toBeGreaterThan(before)
    v.dispose()
  })

  it('omits the in-scene pose gizmo for a jointed rig that does not opt in with posable', () => {
    registerPackage(rigPkg()) // has a posable joint, but geometry.posable is absent
    const v = createCustomVisual(rigPart())
    // no robotGizmo means view.hasRigGizmo() is false → no joint/IK gizmo on selection (a sim/PLC-driven rig)
    expect(v.object.userData.robotGizmo).toBeUndefined()
    v.dispose()
  })

  it('builds the in-scene pose gizmo when the rig opts in with posable: true', () => {
    registerPackage(rigPkg({ posable: true }))
    const v = createCustomVisual(rigPart())
    expect((v.object.userData.robotGizmo as { rig?: boolean } | undefined)?.rig).toBe(true)
    v.dispose()
  })

  it('reads a sliding joint of the idle pose in metres, as Capture Pose writes it', () => {
    const pose = { type: 'numberList', rows: 1, arity: 1, default: [[0]], label: 'Idle pose' }
    registerPackage(rigPkg({ posable: true, joints: [{ name: 'lift', link: 'arm', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 1 }] }, { params: { pose } }))
    const v = createCustomVisual({ ...rigPart(), params: { pose: [[0.5]] } })
    expect(findLink(v.object, 'arm')!.position.y).toBeCloseTo(0.3 + 0.5)
    v.dispose()
  })

  it('opting in with posable but with only cosmetic joints still shows no gizmo (nothing author-posable)', () => {
    registerPackage(rigPkg({ posable: true, joints: [{ name: 'spin', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI, cosmetic: true }] }))
    const v = createCustomVisual(rigPart())
    expect(v.object.userData.robotGizmo).toBeUndefined()
    v.dispose()
  })

  it('a link `color` gives that link its own tinted material (vs the shared gray fallback)', () => {
    registerPackage(
      rigPkg({
        links: [
          { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0.3, 0], color: [1, 0, 0] },
        ],
        joints: [],
      }),
    )
    const v = createCustomVisual(rigPart())
    const armMesh = findLink(v.object, 'arm')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    const baseMesh = findLink(v.object, 'base')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    expect((armMesh.material as MeshStandardMaterial).color.getHex()).toBe(0xff0000) // its own red tint
    expect((baseMesh.material as MeshStandardMaterial).color.getHex()).toBe(0x9aa3ad) // uncoloured → gray fallback
    expect(armMesh.material).not.toBe(baseMesh.material) // a dedicated material, not the shared fallback
    v.dispose()
  })

  it('a link metalness/roughness overrides the default gloss (built-in flat non-metallic steel parity)', () => {
    registerPackage(
      rigPkg({
        links: [
          { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0.3, 0], color: [0.3, 0.3, 0.3], metalness: 0, roughness: 0.8 },
        ],
        joints: [],
      }),
    )
    const v = createCustomVisual(rigPart())
    const armMat = (findLink(v.object, 'arm')!.children.find((c) => (c as Mesh).isMesh) as Mesh).material as MeshStandardMaterial
    expect(armMat.metalness).toBe(0) // non-metallic - shows albedo, no env reflection
    expect(armMat.roughness).toBe(0.8)
    const baseMat = (findLink(v.object, 'base')!.children.find((c) => (c as Mesh).isMesh) as Mesh).material as MeshStandardMaterial
    expect(baseMat.metalness).toBe(0.4) // an unfinished link keeps the default fallback gloss
    v.dispose()
  })

  it('a translucent cue link casts no shadow (three ignores opacity in the shadow pass)', () => {
    registerPackage(
      rigPkg({
        links: [
          { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
          { name: 'marker', parent: 'base', shape: { kind: 'box', size: [0.5, 0.5, 0.5] }, offset: [0, 0.3, 0], color: [0.2, 0.45, 0.69], opacity: 0.3 },
        ],
        joints: [],
      }),
    )
    const v = createCustomVisual(rigPart())
    const marker = findLink(v.object, 'marker')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    const base = findLink(v.object, 'base')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    // the spawner/despawner marker shape: a ghost volume, not a body. Casting would paint a solid
    // silhouette (the shadow pass has no opacity), so a 30%-opaque cube would throw a hard black cube.
    expect(marker.castShadow).toBe(false)
    expect(marker.receiveShadow).toBe(true) // still lit by the room
    expect(base.castShadow).toBe(true) // an opaque link is unaffected
    v.dispose()
  })

  it('a `hidden` link is not rendered (the author-mode eye), but other links stay visible', () => {
    registerPackage(
      rigPkg({
        links: [
          { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
          { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0.3, 0], hidden: true },
        ],
        joints: [],
      }),
    )
    const v = createCustomVisual(rigPart())
    expect(findLink(v.object, 'base')!.visible).toBe(true)
    expect(findLink(v.object, 'arm')!.visible).toBe(false) // render-only; its link group is hidden
    v.dispose()
  })

  it('a link offset change reflows the same group in place (no rebuild), unlike a structural change', () => {
    registerPackage(rigPkg())
    const v = createCustomVisual(rigPart())
    const armBefore = findLink(v.object, 'arm')!
    expect(armBefore.position.toArray()).toEqual([0, 0.3, 0])

    // author drags the 'arm' node: only its rest offset changed → reflow in place, don't rebuild the tree
    registerPackage(rigPkg({
      links: [
        { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
        { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0.4, 0.5, 0] },
      ],
    }))
    v.update(rigPart())
    const armAfterMove = findLink(v.object, 'arm')!
    expect(armAfterMove).toBe(armBefore) // SAME Object3D - reflowed, not rebuilt
    expect(armAfterMove.position.toArray()).toEqual([0.4, 0.5, 0]) // followed the new offset

    // a structural edit (box resized) still rebuilds the tree → a fresh link Object3D
    registerPackage(rigPkg({
      links: [
        { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
        { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.2, 0.2, 1.2] }, offset: [0.4, 0.5, 0] },
      ],
    }))
    v.update(rigPart())
    expect(findLink(v.object, 'arm')!).not.toBe(armBefore) // rebuilt
    v.dispose()
  })

  it('applyLamps lights/darkens an emissive lamp link material (C-emissive)', () => {
    registerPackage(
      rigPkg({
        links: [
          { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
          { name: 'red', parent: 'base', shape: { kind: 'cylinder', radius: 0.1, height: 0.1 }, offset: [0, 0.3, 0], lamps: [{ emissive: [1, 0, 0] }] },
        ],
        joints: [],
      }),
    )
    const v = createCustomVisual(rigPart())
    const mesh = findLink(v.object, 'red')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    const mat = mesh.material as MeshStandardMaterial
    const applyLamps = v.object.userData.applyLamps as (l: Record<string, boolean>) => void
    expect(mat.emissive.getHex()).toBe(0x000000) // off at rest
    applyLamps({ red: true })
    expect(mat.emissive.getHex()).toBe(0xff0000)
    expect(mat.emissiveIntensity).toBe(1)
    applyLamps({ red: false })
    expect(mat.emissive.getHex()).toBe(0x000000)
    v.dispose()
  })

  it('a lamp with an authored color + opacity is a lens: grey unlit albedo, translucent tinted when lit', () => {
    registerPackage(
      rigPkg({
        links: [
          { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
          { name: 'lens', parent: 'base', shape: { kind: 'cylinder', radius: 0.1, height: 0.1 }, offset: [0, 0.3, 0], lamps: [{ emissive: [1, 0, 0], offColor: [0.448, 0.448, 0.448], opacity: 235 / 255 }] },
        ],
        joints: [],
      }),
    )
    const v = createCustomVisual(rigPart())
    const mesh = findLink(v.object, 'lens')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    const mat = mesh.material as MeshStandardMaterial
    const applyLamps = v.object.userData.applyLamps as (l: Record<string, boolean>) => void
    expect(mat.color.r).toBeCloseTo(0.448) // unlit = the authored off albedo, not the dark neutral
    expect(mat.transparent).toBe(false)
    applyLamps({ lens: true })
    expect(mat.color.getHex()).toBe(0xff0000) // lit = tinted…
    expect(mat.transparent).toBe(true) // …translucent lens (the built-in stack light's 235/255 optics)
    expect(mat.opacity).toBeCloseTo(235 / 255)
    applyLamps({ lens: false })
    expect(mat.color.r).toBeCloseTo(0.448) // back to the opaque off lens
    expect(mat.transparent).toBe(false)
    expect(mat.opacity).toBe(1)
    v.dispose()
  })

  it('MeshPart.link attaches a geometry() submesh to the named link group; an untagged one → the rig root', () => {
    // the fence/gate capability: a rig dressed by procedural geometry(); a link-tagged submesh follows that link
    // (a frame 'leaf' here has no primitive mesh + no joint gizmo, so its only child is the procedural submesh).
    const SRC = `definePart({ geometry(g){ return [ { desc: g.box([0.2,0.2,0.2],[0,0,0]), link:'leaf', finish:'mesh' }, { desc: g.box([0.1,0.1,0.1],[0,0,0]), finish:'mesh' } ] }, step(){} })`
    registerPackage(
      rigPkg(
        {
          links: [
            { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
            { name: 'leaf', parent: 'base', shape: { kind: 'frame' }, offset: [0, 0.3, 0] },
          ],
          joints: [],
        },
        { behavior: SRC },
      ),
    )
    const v = createCustomVisual(rigPart())
    const leaf = findLink(v.object, 'leaf')!
    expect(leaf.children.filter((c) => (c as Mesh).isMesh)).toHaveLength(1) // ONLY the link-tagged procedural submesh
    expect(v.object.children.filter((c) => (c as Mesh).isMesh)).toHaveLength(1) // the untagged submesh → the rig root
    v.dispose()
  })

  it('the SDK Safety Gate renders its wire-mesh leaf on the visible hinge (a hidden link hides its children)', () => {
    const gate = examplePart<RigGeo>('oip.safety-gate')
    registerPackage({ format: PACKAGE_FORMAT, id: gate.head.id, name: gate.head.name, params: {}, behavior: gate.behavior, geometry: gate.geometry, materials: gate.materials, assets: gate.assets } as PartPackage)
    const v = createCustomVisual({ id: 'cp_1', type: 'part', packageId: gate.head.id, position: [0, 0, 0], rotationY: 0, params: {} })
    const hinge = findLink(v.object, 'hinge')!
    const leafLink = findLink(v.object, 'leaf')!
    expect(hinge.visible).toBe(true) // the swinging frame that hosts the wire mesh
    expect(leafLink.visible).toBe(false) // the collision box is hidden (would hide the mesh if the mesh rode it)
    // the wire-mesh grid (hundreds of verts, vs a gizmo handle's ~100) is a child of the hinge, and every
    // ancestor up to the root is visible - so it actually renders (the black-slab/invisible regression guard)
    const meshes: Mesh[] = []
    hinge.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh) })
    const grid = meshes.reduce((a, b) => (b.geometry.attributes.position!.count > a.geometry.attributes.position!.count ? b : a))
    expect(grid.geometry.attributes.position!.count).toBeGreaterThan(500)
    for (let o: Object3D | null = grid; o; o = o.parent) expect(o.visible).toBe(true)
    v.dispose()
  })

  it('refresh paints a param-bound lamp from its boolean param (idle lit-state, default-resolved)', () => {
    registerPackage(
      rigPkg(
        {
          links: [
            { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
            { name: 'lens', parent: 'base', shape: { kind: 'cylinder', radius: 0.1, height: 0.1 }, offset: [0, 0.3, 0], lamps: [{ emissive: [0, 1, 0], param: 'on' }] },
          ],
          joints: [],
        },
        { params: { on: { type: 'boolean', default: true } } },
      ),
    )
    const v = createCustomVisual(rigPart())
    const mesh = findLink(v.object, 'lens')!.children.find((c) => (c as Mesh).isMesh) as Mesh
    const mat = mesh.material as MeshStandardMaterial
    expect(mat.emissive.getHex()).toBe(0x00ff00) // lit at REST from the param default - no behavior step needed
    v.update({ ...rigPart(), params: { on: false } }) // author toggles it off
    expect(mat.emissive.getHex()).toBe(0x000000)
    // sim runs and lights it, then an update (param edit / sim stop) re-asserts the authored state
    const applyLamps = v.object.userData.applyLamps as (l: Record<string, boolean>) => void
    applyLamps({ lens: true })
    expect(mat.emissive.getHex()).toBe(0x00ff00)
    v.update({ ...rigPart(), params: { on: false } })
    expect(mat.emissive.getHex()).toBe(0x000000)
    v.dispose()
  })
})

// The roller-spin tick's no-slip rate is speed / rendered radius; dividing by a roller model's native 0.12 m
// instead of the 0.024 m it is drawn at spins SDK roller beds ~5× slow. rigRollerSpinRadius resolves the
// drawn radius per rig.
describe('rigRollerSpinRadius (SDK roller visual spin rate)', () => {
  const rig = (links: unknown[]): RigGeo => ({ kind: 'rig', links, joints: [] }) as unknown as RigGeo

  it("the shipped roller conveyor draws its own rollers: no roller link, and its bank spins at its own radius", () => {
    // its geometry() emits the tubes as a spinning bank (examples/parts/_shared/rollerBed.js), whose spin radius is the class
    // radius the part itself declares - nothing for rigRollerSpinRadius to resolve
    const { geometry, behavior } = examplePart<RigGeo>('oip.roller-conveyor')
    expect(geometry.links.some((l) => (l.shape.kind as string) === 'roller')).toBe(false) // the retired link kind
    const tubes = (evalPartGeometry(behavior, { length: 2, width: 1 }) ?? []).find((p) => p.finish === 'roller' && p.instances)
    expect(tubes?.spin?.radius).toBeCloseTo(0.024, 9) // ROLLER_CLASSES.light.radius
  })

  it('a "roller"-role cylinder link spins at its own (param-resolved) radius', () => {
    const geo = rig([{ name: 'r', finish: 'roller', shape: { kind: 'cylinder', radius: 0.05, height: 1 }, offset: [0, 0, 0] }])
    expect(rigRollerSpinRadius(geo, {})).toBeCloseTo(0.05, 9)
    const parametric = rig([
      { name: 'r', finish: 'roller', shape: { kind: 'cylinder', radius: 0.05, height: 1, sizeParams: [{ axis: 0, param: 'rollerRadius' }] }, offset: [0, 0, 0] },
    ])
    expect(rigRollerSpinRadius(parametric, { rollerRadius: 0.09 })).toBeCloseTo(0.09, 9)
  })

  it('a rig with no roller links falls back to the GLB native radius (a "roller"-role mesh keeps native scale)', () => {
    const geo = rig([{ name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1] }, offset: [0, -0.02, 0] }])
    expect(rigRollerSpinRadius(geo, {})).toBe(ROLLER_MODEL_RADIUS)
  })
})

// A posable conveying array's belt look (a cross-belt sorter's carriers): a `finish: 'belt'` submesh on the array is
// drawn as belt fabric whose copies scroll at their own copy's belt speed, through the shared fabric-bank shader.
describe('conveying copies: per-copy belt fabric', () => {
  // the belt weave is an <img> the browser decodes; node has none, and nothing here needs its pixels
  beforeEach(() => {
    vi.stubGlobal('Image', class { src = ''; addEventListener(): void {} })
  })
  afterEach(() => vi.unstubAllGlobals())
  const BELT_BEHAVIOR = `definePart({
    params: { length: { type: 'number', default: 2 } },
    geometry(g) { return [{ desc: g.box([0.6, 0.01, 0.4], [0, 0.05, 0]), finish: 'belt', link: 'carrier' }] },
    step() {},
  })`
  const register = (): void => {
    registerPackage({
      format: PACKAGE_FORMAT,
      id: 'test.belts',
      name: 'Belts',
      params: { length: { type: 'number', default: 2 } },
      behavior: BELT_BEHAVIOR,
      geometry: {
        kind: 'rig',
        links: [{ name: 'carrier', shape: { kind: 'frame' }, offset: [0, 0, 0], collision: { box: [0.6, 0.1, 0.4] }, conveys: true, array: { pitch: { axis: 0, spanParam: 'length', pitch: 1 }, posable: true } }],
        joints: [],
      },
    } as PartPackage)
  }
  const rates = (v: ReturnType<typeof createCustomVisual>): number[] => {
    let bank: { geometry: { getAttribute(n: string): { array: ArrayLike<number> } }; count: number } | null = null
    v.object.traverse((o) => { if ((o as { userData: { beltFabricBank?: boolean } }).userData.beltFabricBank) bank = o as never })
    const b = bank!
    const a = b.geometry.getAttribute('fabricScroll').array
    return Array.from({ length: b.count }, (_, i) => a[i * 2 + 1]!)
  }

  it("each copy's belt scrolls at its own speed while running, and every belt stops on Stop", () => {
    register()
    const v = createCustomVisual({ id: 'cp_1', type: 'part', packageId: 'test.belts', position: [0, 0, 0], rotationY: 0, params: {} } as SdkPart)
    const ud = v.object.userData as { applyCopySpeeds: (s: Record<string, number[]>) => void; tick: (dt: number, running: boolean) => void; resetRunPose: () => void }
    expect(rates(v)).toEqual([0, 0]) // two copies at rest
    ud.applyCopySpeeds({ carrier: [0, 1.5] })
    ud.tick(1 / 60, true)
    expect(rates(v)).toEqual([0, -1.5]) // copy 1 runs (the weave walks back so the pattern moves along +u); copy 0 holds
    ud.resetRunPose()
    ud.tick(1 / 60, false)
    expect(rates(v)).toEqual([0, 0])
    v.dispose()
  })
})
