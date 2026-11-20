import { describe, expect, it } from 'vitest'
import { behaviorMentions, PACKAGE_FORMAT, renameRigJoint, renameRigLink, renameRigNameRefs, subPosedLinkNames } from '../parts/partPackage'
import { validatePartPackage } from '../parts/partValidate'
import { checkGeometryRefs } from '../parts/partAuthoringChecks'
import type { ParamSchema } from '../parts/partApi'
import { dropRetiredRigLinks } from '../parts/partUpgrade'
import type { PartPackage, RigJoint, RigLink } from '../parts/partPackage'

// Validation of the rig geometry format (multi-body custom parts). The kinematic rig = a tree of links
// + joints a behavior drives via ctx.setJoint. Structural validation matters even though determinism is
// the consumer's call - a malformed rig (cycle, dangling ref) would crash render/sim, not just misbehave.

function rigPackage(geometryOverride = {}): unknown {
  return {
    format: PACKAGE_FORMAT,
    id: 'acme.arm',
    name: 'Arm',
    params: {},
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [
        { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
        { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0.3, 0], rotation: [0, 0, 0] },
      ],
      joints: [{ name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -3.14, max: 3.14 }],
      ...geometryOverride,
    },
  }
}

const fields = (pkg: unknown): string[] => validatePartPackage(pkg).map((p) => p.field)

describe('rig geometry validation', () => {
  it('accepts a well-formed rig package', () => {
    expect(validatePartPackage(rigPackage())).toEqual([])
    // it round-trips as a typed PartPackage with a rig discriminant
    const pkg = rigPackage() as PartPackage
    expect(pkg.geometry.kind).toBe('rig')
  })

  it('rejects an empty/missing links array', () => {
    expect(fields(rigPackage({ links: [] }))).toContain('geometry.links')
  })

  it('checks a leg frameDepthParam: { param, scale?, add?, min?, max? }', () => {
    const leg = (frameDepthParam: unknown): unknown => rigPackage({ links: [{ name: 'legs', shape: { kind: 'leg', spanParam: 'length', widthParam: 'width', standParam: 'stand', frameDepth: 0.175, frameDepthParam }, offset: [0, 0, 0] }], joints: [] })
    expect(fields(leg({ param: 'frameHeight', add: 0.005 }))).toEqual([])
    expect(fields(leg({ param: '' }))).toContain('geometry.links[0].shape.frameDepthParam')
    expect(fields(leg(0.2))).toContain('geometry.links[0].shape.frameDepthParam')
    expect(fields(leg({ param: 'frameHeight', add: 'x' }))).toContain('geometry.links[0].shape.frameDepthParam.add')
  })

  it('checks rotationParams like offsetParams, a plus flag, and refuses rotationParams beside a quat', () => {
    const arm = (extra: Record<string, unknown>): unknown => rigPackage({ links: [{ name: 'arm', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0], ...extra }], joints: [] })
    expect(fields(arm({ rotation: [0, 0, 0], rotationParams: [{ axis: 1, param: 'splay', scale: 0.0174 }, { axis: 1, param: 'trim', plus: true }] }))).toEqual([])
    expect(fields(arm({ rotationParams: [{ axis: 3, param: 'splay' }] }))).toContain('geometry.links[0].rotationParams[0].axis')
    expect(fields(arm({ offsetParams: [{ axis: 0, param: 'gap', plus: 'yes' }] }))).toContain('geometry.links[0].offsetParams[0].plus')
    expect(fields(arm({ quat: [0, 0, 0, 1], rotationParams: [{ axis: 1, param: 'splay' }] }))).toContain('geometry.links[0].rotationParams')
  })

  it('rejects duplicate link names', () => {
    const pkg = rigPackage({
      links: [
        { name: 'a', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] },
        { name: 'a', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] },
      ],
      joints: [],
    })
    expect(fields(pkg).join(' ')).toMatch(/links\[1\]\.name/)
  })

  it('rejects a bad shape, offset, and missing-kind', () => {
    const pkg = rigPackage({
      links: [{ name: 'x', shape: { kind: 'cylinder', radius: -1, height: 0 }, offset: [0, 'nope', 0] }],
      joints: [],
    })
    const f = fields(pkg)
    expect(f).toContain('geometry.links[0].shape.radius')
    expect(f).toContain('geometry.links[0].shape.height')
    expect(f).toContain('geometry.links[0].offset')
  })

  it('accepts a translucent, edge-outlined marker + a render-only cone cue (the spawner marker)', () => {
    const pkg = rigPackage({
      links: [
        { name: 'marker', shape: { kind: 'box', size: [0.5, 0.5, 0.5] }, offset: [0, 0, 0], color: [0.2, 0.45, 0.69], opacity: 0.3, outline: [0.35, 0.64, 0.87], collision: 'none' },
        { name: 'cue', shape: { kind: 'cone', radius: 0.1, height: 0.2 }, offset: [0, -0.2, 0], rotation: [Math.PI, 0, 0], color: [0.6, 0.8, 0.9], opacity: 0.8 },
      ],
      joints: [],
    })
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it('rejects a cone with a non-positive radius/height, an out-of-range opacity, and malformed edges', () => {
    const pkg = rigPackage({
      links: [{ name: 'c', shape: { kind: 'cone', radius: 0, height: -1 }, offset: [0, 0, 0], opacity: 2, edges: [0.5, 0.5] }],
      joints: [],
    })
    const f = fields(pkg)
    expect(f).toContain('geometry.links[0].shape.radius')
    expect(f).toContain('geometry.links[0].shape.height')
    expect(f).toContain('geometry.links[0].opacity')
    expect(f).toContain('geometry.links[0].edges')
  })

  it('rejects a parent that references an unknown link, and a parent cycle', () => {
    expect(fields(rigPackage({ links: [{ name: 'a', parent: 'ghost', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }], joints: [] })))
      .toContain('geometry.links[0].parent')
    const cyclic = rigPackage({
      links: [
        { name: 'a', parent: 'b', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] },
        { name: 'b', parent: 'a', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] },
      ],
      joints: [],
    })
    expect(fields(cyclic)).toContain('geometry.links')
  })

  it('rejects joints with an unknown link, a zero axis, a bad type, or inverted limits', () => {
    const pkg = rigPackage({
      joints: [
        { name: 'j1', link: 'nope', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 },
        { name: 'j2', link: 'arm', type: 'wobble', axis: [0, 0, 0], min: 2, max: 1 },
      ],
    })
    const f = fields(pkg).join(' ')
    expect(f).toMatch(/joints\[0\]\.link/)
    expect(f).toMatch(/joints\[1\]\.type/)
    expect(f).toMatch(/joints\[1\]\.axis/)
    expect(f).toMatch(/joints\[1\]\.limits/)
  })

  it('still accepts a deck package (back-compat)', () => {
    expect(validatePartPackage({ format: PACKAGE_FORMAT, id: 'x', name: 'X', params: {}, behavior: 'definePart({step(){}})', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } } })).toEqual([])
  })
})

describe('mesh shape + embedded assets validation', () => {
  const base = (over: Record<string, unknown> = {}): unknown => ({
    format: PACKAGE_FORMAT,
    id: 'acme.m',
    name: 'M',
    params: {},
    behavior: 'definePart({ step(){} })',
    assets: [{ id: 'arm-glb', mime: 'model/gltf-binary', data: 'AAAA' }],
    geometry: { kind: 'rig', links: [{ name: 'arm', shape: { kind: 'mesh', asset: 'arm-glb' }, offset: [0, 0, 0] }], joints: [] },
    ...over,
  })
  const fieldsOf = (pkg: unknown): string[] => validatePartPackage(pkg).map((p) => p.field)

  it('accepts a mesh link referencing an embedded asset (with scale + a collision box)', () => {
    expect(
      validatePartPackage(
        base({ geometry: { kind: 'rig', links: [{ name: 'arm', shape: { kind: 'mesh', asset: 'arm-glb', scale: 1.5 }, collision: { box: [0.2, 0.2, 0.8] }, offset: [0, 0, 0] }], joints: [] } }),
      ),
    ).toEqual([])
  })

  it('rejects a mesh referencing an unknown asset', () => {
    expect(fieldsOf(base({ geometry: { kind: 'rig', links: [{ name: 'arm', shape: { kind: 'mesh', asset: 'ghost' }, offset: [0, 0, 0] }], joints: [] } }))).toContain('geometry.links[0].shape.asset')
  })

  it('validates the assets array (duplicate id, empty data)', () => {
    const f = fieldsOf(base({ assets: [{ id: 'arm-glb', mime: 'model/gltf-binary', data: 'AAAA' }, { id: 'arm-glb', mime: 'x', data: '' }] })).join(' ')
    expect(f).toMatch(/assets\[1\]\.id/)
    expect(f).toMatch(/assets\[1\]\.data/)
  })

  it('accepts a url asset (referenced, not embedded) and rejects both/neither data+url', () => {
    expect(validatePartPackage(base({ assets: [{ id: 'arm-glb', mime: 'model/gltf-binary', url: '/models/x.glb' }] }))).toEqual([])
    expect(fieldsOf(base({ assets: [{ id: 'arm-glb', mime: 'm', data: 'AAAA', url: '/x.glb' }] }))).toContain('assets[0].data') // both set
    expect(fieldsOf(base({ assets: [{ id: 'arm-glb', mime: 'm' }] }))).toContain('assets[0].data') // neither set
  })

  it('rejects a malformed collision box, a box on a primitive, and the format 3 spelling', () => {
    const link = (extra: Record<string, unknown>, shape: Record<string, unknown> = { kind: 'mesh', asset: 'arm-glb' }) =>
      fieldsOf(base({ geometry: { kind: 'rig', links: [{ name: 'arm', shape, offset: [0, 0, 0], ...extra }], joints: [] } }))
    expect(link({ collision: { box: [1, 1, 0] } })).toContain('geometry.links[0].collision')
    expect(link({ collision: { box: [1, 1, 1] } }, { kind: 'box', size: [1, 1, 1] })).toContain('geometry.links[0].collision.box')
    expect(link({}, { kind: 'mesh', asset: 'arm-glb', collision: { size: [1, 1, 1] } })).toContain('geometry.links[0].shape.collision')
    expect(link({ noCollision: true })).toContain('geometry.links[0].noCollision')
  })

  it('accepts a per-node mesh ref (one GLB → per-link nodes) and rejects an empty node name', () => {
    expect(validatePartPackage(base({ geometry: { kind: 'rig', links: [{ name: 'arm', shape: { kind: 'mesh', asset: 'arm-glb', node: 'Linkage_02' }, offset: [0, 0, 0] }], joints: [] } }))).toEqual([])
    expect(fieldsOf(base({ geometry: { kind: 'rig', links: [{ name: 'arm', shape: { kind: 'mesh', asset: 'arm-glb', node: '' }, offset: [0, 0, 0] }], joints: [] } }))).toContain('geometry.links[0].shape.node')
  })
})

// C-paramgeo: a box link's size axis can track an instance param (width/length reshaping the rig).
describe('param-driven box size (sizeParams)', () => {
  const fieldsOf = (pkg: unknown): string[] => validatePartPackage(pkg).map((p) => p.field)
  const withSizeParams = (sizeParams: unknown): unknown =>
    rigPackage({
      links: [{ name: 'blade', shape: { kind: 'box', size: [0.05, 0.3, 0.5], sizeParams }, offset: [0, 0, 0] }],
      joints: [],
    })

  it('accepts a well-formed sizeParams override', () => {
    expect(validatePartPackage(withSizeParams([{ axis: 2, param: 'width' }]))).toEqual([])
    expect(validatePartPackage(withSizeParams([{ axis: 2, param: 'width', scale: 0.5, add: 0.1 }]))).toEqual([])
  })

  it('rejects a bad axis, empty param, or non-finite scale/add', () => {
    const f = fieldsOf(withSizeParams([{ axis: 3, param: '' }, { axis: 1, param: 'w', scale: 'x', add: 'y' }])).join(' ')
    expect(f).toMatch(/sizeParams\[0\]\.axis/)
    expect(f).toMatch(/sizeParams\[0\]\.param/)
    expect(f).toMatch(/sizeParams\[1\]\.scale/)
    expect(f).toMatch(/sizeParams\[1\]\.add/)
  })

  it('rejects a non-array sizeParams', () => {
    expect(fieldsOf(withSizeParams({ axis: 2, param: 'width' }))).toContain('geometry.links[0].shape.sizeParams')
  })

  it('accepts a conveying deck link + a detection zone, and rejects malformed ones (C-convey / C-despawn)', () => {
    const ok = rigPackage({ links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, 0, 0], conveys: true, zone: { size: [1, 1, 1] } }], joints: [] })
    expect(validatePartPackage(ok)).toEqual([])
    const bad = rigPackage({ links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, 0, 0], conveys: 'yes', zone: { size: [1, 0, 1] } }], joints: [] })
    const f = fieldsOf(bad)
    expect(f).toContain('geometry.links[0].conveys')
    expect(f).toContain('geometry.links[0].zone.size')
  })

  it('accepts a `hidden` link flag and rejects a non-boolean (author-mode visibility)', () => {
    const ok = rigPackage({ links: [{ name: 'arm', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0, 0], hidden: true }], joints: [] })
    expect(validatePartPackage(ok)).toEqual([])
    const bad = rigPackage({ links: [{ name: 'arm', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0, 0], hidden: 'yes' }], joints: [] })
    expect(fieldsOf(bad)).toContain('geometry.links[0].hidden')
  })

  it('accepts a link lamp and rejects a malformed one (C-emissive)', () => {
    const lampLink = (lamps: unknown) => ({ name: 'lamp', shape: { kind: 'cylinder' as const, radius: 0.1, height: 0.1 }, offset: [0, 0, 0] as [number, number, number], lamps }) as unknown as RigLink
    expect(validatePartPackage(rigPackage({ links: [lampLink([{ emissive: [1, 0.6, 0] }])], joints: [] }))).toEqual([])
    expect(fieldsOf(rigPackage({ links: [lampLink([{ emissive: [1, 0] }])], joints: [] }))).toContain('geometry.links[0].lamps[0].emissive')
    // a primitive's lamp is its own material: one at most, and no GLB material to name
    expect(fieldsOf(rigPackage({ links: [lampLink([{ emissive: [1, 0, 0] }, { name: 'b', emissive: [0, 1, 0] }])], joints: [] }))).toContain('geometry.links[0].lamps')
    expect(fieldsOf(rigPackage({ links: [lampLink([{ emissive: [1, 0, 0], material: 'X' }])], joints: [] }))).toContain('geometry.links[0].lamps[0].material')
    // one ctx.lamps entry per name, across the whole rig: a second link named like the first's lamp collides
    const twin = { ...lampLink([{ name: 'lamp', emissive: [0, 1, 0] }]), name: 'other' } as RigLink
    expect(fieldsOf(rigPackage({ links: [lampLink([{ emissive: [1, 0, 0] }]), twin], joints: [] }))).toContain('geometry.links[1].lamps[0].name')
    // squash compresses a mesh link's clones; on a primitive it would do nothing, so it is refused
    const squashed = { ...lampLink([{ emissive: [1, 0, 0] }]), squash: { amount: 0.2 } } as RigLink
    expect(fieldsOf(rigPackage({ links: [squashed], joints: [] }))).toContain('geometry.links[0].squash')
  })

  it('accepts a link colorParam (a param-driven albedo tint) and rejects a malformed one (C-paramgeo colour)', () => {
    const ok = rigPackage({ links: [{ name: 'rail', shape: { kind: 'box', size: [2, 0.05, 0.05] }, offset: [0, 0, 0], color: [0.95, 0.74, 0.06], colorParam: 'color' }], joints: [] })
    expect(validatePartPackage(ok)).toEqual([])
    const bad = rigPackage({ links: [{ name: 'rail', shape: { kind: 'box', size: [2, 0.05, 0.05] }, offset: [0, 0, 0], colorParam: '' }], joints: [] })
    expect(fieldsOf(bad)).toContain('geometry.links[0].colorParam')
  })

  it('accepts a link metalness/roughness finish and rejects out-of-range values', () => {
    const ok = rigPackage({ links: [{ name: 'rail', shape: { kind: 'box', size: [2, 0.05, 0.05] }, offset: [0, 0, 0], color: [0.3, 0.3, 0.3], metalness: 0, roughness: 0.8 }], joints: [] })
    expect(validatePartPackage(ok)).toEqual([])
    const bad = rigPackage({ links: [{ name: 'rail', shape: { kind: 'box', size: [2, 0.05, 0.05] }, offset: [0, 0, 0], metalness: 1.5, roughness: -1 }], joints: [] })
    expect(fieldsOf(bad)).toEqual(expect.arrayContaining(['geometry.links[0].metalness', 'geometry.links[0].roughness']))
  })

  it('accepts/validates a link offsetParams (a param positioning a sub-part)', () => {
    const ok = rigPackage({
      links: [{ name: 'hinge', shape: { kind: 'frame' }, offset: [0, 0, 0], offsetParams: [{ axis: 0, param: 'length', scale: -0.5 }] }],
      joints: [],
    })
    expect(validatePartPackage(ok)).toEqual([])
    const bad = rigPackage({
      links: [{ name: 'hinge', shape: { kind: 'frame' }, offset: [0, 0, 0], offsetParams: [{ axis: 5, param: '' }] }],
      joints: [],
    })
    const f = fieldsOf(bad).join(' ')
    expect(f).toMatch(/links\[0\]\.offsetParams\[0\]\.axis/)
    expect(f).toMatch(/links\[0\]\.offsetParams\[0\]\.param/)
  })
})

// The articulated-robot capabilities: transform-only 'frame' links (joint pivots), quaternion rest
// rotations (arbitrary CAD-export bases), and a per-mesh PBR (ORM) material referenced by id.
describe('frame links, quat rotations, and materials', () => {
  const fieldsOf = (pkg: unknown): string[] => validatePartPackage(pkg).map((p) => p.field)
  const pkg = (over: Record<string, unknown> = {}): unknown => ({
    format: PACKAGE_FORMAT,
    id: 'acme.robot',
    name: 'Robot',
    params: {},
    behavior: 'definePart({ step(){} })',
    assets: [{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA' }, { id: 'albedo', mime: 'image/webp', data: 'AAAA' }, { id: 'orm', mime: 'image/webp', data: 'AAAA' }],
    materials: [{ id: 'metal', albedo: 'albedo', orm: 'orm' }],
    geometry: {
      kind: 'rig',
      links: [
        { name: 'pivot', shape: { kind: 'frame' }, offset: [0, 0, 0] },
        { name: 'arm', parent: 'pivot', shape: { kind: 'mesh', asset: 'glb', node: 'L1', material: 'metal' }, offset: [0, 0.23, 0], quat: [0, 0.7071, 0, 0.7071] },
      ],
      joints: [{ name: 'j1', link: 'pivot', type: 'revolute', axis: [0, 1, 0], min: -3.14, max: 3.14 }],
    },
    ...over,
  })

  it('accepts a frame link + quat + a mesh referencing a package material', () => {
    expect(validatePartPackage(pkg())).toEqual([])
  })

  it('rejects a malformed quat (not 4 numbers)', () => {
    expect(fieldsOf(pkg({ geometry: { kind: 'rig', links: [{ name: 'a', shape: { kind: 'frame' }, offset: [0, 0, 0], quat: [0, 0, 1] }], joints: [] } }))).toContain('geometry.links[0].quat')
  })

  it('rejects a mesh material ref that names no package material', () => {
    expect(fieldsOf(pkg({ geometry: { kind: 'rig', links: [{ name: 'a', shape: { kind: 'mesh', asset: 'glb', material: 'ghost' }, offset: [0, 0, 0] }], joints: [] } }))).toContain('geometry.links[0].shape.material')
  })

  it('validates the materials array (duplicate id, bad texture ref, bad scalar)', () => {
    const f = fieldsOf(pkg({ materials: [{ id: 'metal', albedo: 'albedo' }, { id: 'metal', orm: 'nope', metalness: 'x' }] })).join(' ')
    expect(f).toMatch(/materials\[1\]\.id/)
    expect(f).toMatch(/materials\[1\]\.orm/)
    expect(f).toMatch(/materials\[1\]\.metalness/)
  })
})

describe('renameRigLink (structural cascade)', () => {
  // a small forest where 'base' is referenced four ways: as a name, a parent, an aim target, and a joint link
  const geom = (): { links: RigLink[]; joints: RigJoint[] } => ({
    links: [
      { name: 'base', shape: { kind: 'cylinder', radius: 0.2, height: 0.3 }, offset: [0, 0, 0] },
      { name: 'arm', parent: 'base', shape: { kind: 'box', size: [0.1, 0.1, 0.8] }, offset: [0, 0.3, 0] },
      { name: 'head', parent: 'arm', shape: { kind: 'frame' }, offset: [0, 0.8, 0], aim: { target: 'base' } },
    ],
    joints: [{ name: 'shoulder', link: 'base', type: 'revolute', axis: [0, 1, 0], min: -3.14, max: 3.14 }],
  })

  it('renames the link and cascades through parent, aim.target, and joint.link', () => {
    const out = renameRigLink(geom(), 'base', 'pedestal')!
    expect(out.links.map((l) => l.name)).toEqual(['pedestal', 'arm', 'head'])
    expect(out.links.find((l) => l.name === 'arm')!.parent).toBe('pedestal')
    expect(out.links.find((l) => l.name === 'head')!.aim!.target).toBe('pedestal')
    expect(out.joints[0]!.link).toBe('pedestal')
  })

  it('leaves joint names untouched (a separate setJoint identifier)', () => {
    const out = renameRigLink(geom(), 'base', 'pedestal')!
    expect(out.joints[0]!.name).toBe('shoulder')
  })

  it('trims the new name before applying', () => {
    expect(renameRigLink(geom(), 'base', '  pedestal  ')!.links[0]!.name).toBe('pedestal')
  })

  it('rejects (returns null) a blank, unchanged, unknown, or colliding name', () => {
    expect(renameRigLink(geom(), 'base', '   ')).toBeNull() // blank
    expect(renameRigLink(geom(), 'base', 'base')).toBeNull() // unchanged
    expect(renameRigLink(geom(), 'ghost', 'x')).toBeNull() // unknown source link
    expect(renameRigLink(geom(), 'base', 'arm')).toBeNull() // collides with a sibling
  })

  it('does not mutate the input geometry', () => {
    const g = geom()
    renameRigLink(g, 'base', 'pedestal')
    expect(g.links[0]!.name).toBe('base')
    expect(g.joints[0]!.link).toBe('base')
  })
})

describe('renameRigNameRefs (guarded behavior-source rewrite)', () => {
  it('rewrites whole string-literal args across all three quote styles, preserving the quote', () => {
    const src = `definePart({ step(c){ c.setGrip('hand', true); c.setSubPose("hand", {}); const x = \`hand\` } })`
    const out = renameRigNameRefs(src, 'hand', 'gripper')
    expect(out.count).toBe(3)
    expect(out.source).toBe(`definePart({ step(c){ c.setGrip('gripper', true); c.setSubPose("gripper", {}); const x = \`gripper\` } })`)
  })

  it('leaves substrings and bare identifiers untouched (only whole literals match)', () => {
    const src = `const hand = 1; c.setGrip('hand-tip', true); label('left hand')`
    const out = renameRigNameRefs(src, 'hand', 'gripper')
    expect(out.count).toBe(0)
    expect(out.source).toBe(src)
  })

  it('escapes regex metacharacters in the old name', () => {
    const src = `c.setGrip('a.b', true); c.setGrip('axb', true)` // '.' must be literal, not "any char"
    const out = renameRigNameRefs(src, 'a.b', 'c')
    expect(out.count).toBe(1) // only 'a.b', not 'axb'
    expect(out.source).toBe(`c.setGrip('c', true); c.setGrip('axb', true)`)
  })

  it('reports a zero count and returns the source unchanged when there are no references', () => {
    const src = `definePart({ step(){} })`
    expect(renameRigNameRefs(src, 'hand', 'gripper')).toEqual({ source: src, count: 0 })
  })
})

// The render layer keeps these links out of the scene-global instance pool: pooling bakes world
// matrices, so a pooled link the behavior moves per tick (the push button's cap) would draw at rest
// while the real one travels. Under-reporting renders a part visibly stuck, so the unresolved cases
// must fail safe (ground the whole rig) rather than silently resolve to nothing.
describe('subPosedLinkNames (which links a behavior can move at runtime)', () => {
  it('collects whole string-literal args across all three quote styles', () => {
    const src = `c.setSubPose('cap', {}); c.setSubPose("lid", {}); c.setSubPose(\`door\`, {})`
    expect(subPosedLinkNames(src)).toEqual({ names: new Set(['cap', 'lid', 'door']), unresolved: false })
  })

  it('tolerates whitespace around the call and the argument', () => {
    expect(subPosedLinkNames(`c.setSubPose (  'cap' , {})`)).toEqual({ names: new Set(['cap']), unresolved: false })
  })

  it('flags a computed name as unresolved (a variable arg)', () => {
    const out = subPosedLinkNames(`const n = pick(); c.setSubPose(n, {})`)
    expect(out.unresolved).toBe(true)
    expect(out.names.size).toBe(0)
  })

  it('flags a template with a substitution as unresolved, not as a literal name', () => {
    // the regex sees a backtick literal; its content is dynamic, so resolving it would under-report
    const out = subPosedLinkNames('c.setSubPose(`cup${i}`, {})')
    expect(out.unresolved).toBe(true)
    expect(out.names.has('cup${i}')).toBe(false)
  })

  it('keeps the resolved names alongside an unresolved sibling call', () => {
    const out = subPosedLinkNames(`c.setSubPose('cap', {}); c.setSubPose(name, {})`)
    expect(out.names).toEqual(new Set(['cap']))
    expect(out.unresolved).toBe(true)
  })

  it('is empty for a behavior that never subPoses, and for no behavior at all', () => {
    expect(subPosedLinkNames(`c.setJoint('j', 1); c.setGrip('hand', true)`)).toEqual({ names: new Set(), unresolved: false })
    expect(subPosedLinkNames(undefined)).toEqual({ names: new Set(), unresolved: false })
  })
})

// The retirement mechanism: a stored package loads with a retired kind's links dropped, because a package that fails
// validation fails the whole scene load. RETIRED_SHAPE_KINDS is empty, so the drop is exercised against a table of
// its own.
describe('retired rig shapes', () => {
  const RETIRED = { chain: {}, roller: {} }
  const laneLinks = (): unknown[] => [
    { name: 'deck', shape: { kind: 'box', size: [1, 0.05, 1] }, offset: [0, 0, 0] },
    { name: 'lift', parent: 'deck', shape: { kind: 'frame' }, offset: [0, 0, 0] },
    { name: 'lane', parent: 'lift', shape: { kind: 'chain', laneLengthParam: 'laneLength' }, offset: [0, 0, 0], array: { count: 'chains', step: [0, 0, 0.3] } },
    { name: 'laneCap', parent: 'lane', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] },
  ]
  const joints = (): unknown[] => [
    { name: 'lift', link: 'lift', type: 'prismatic', axis: [0, 1, 0], min: 0, max: 0.1 },
    { name: 'laneTilt', link: 'lane', type: 'revolute', axis: [0, 0, 1], min: -1, max: 1 },
  ]

  it('refuses a chain link as an unknown kind (it has no retirement entry)', () => {
    const problems = validatePartPackage(rigPackage({ links: laneLinks(), joints: joints() }))
    expect(problems.map((p) => p.field)).toContain('geometry.links[2].shape.kind')
  })

  it('drops the chain link, what hangs beneath it and the joints driving them, and the rest validates', () => {
    const { pkg, dropped } = dropRetiredRigLinks(rigPackage({ links: laneLinks(), joints: joints() }), RETIRED)
    expect(dropped.sort()).toEqual(['lane', 'laneCap'])
    const geo = (pkg as { geometry: { links: { name: string }[]; joints: { name: string }[] } }).geometry
    expect(geo.links.map((l) => l.name)).toEqual(['deck', 'lift'])
    expect(geo.joints.map((j) => j.name)).toEqual(['lift'])
    expect(validatePartPackage(pkg)).toEqual([])
  })

  // a roller bed as an older build saved it: every option the engine roller had, on the world-phase grid
  const rollerBed = (): unknown[] => [
    { name: 'deck', shape: { kind: 'box', size: [2, 0.04, 1] }, offset: [0, -0.02, 0], conveys: true },
    {
      name: 'roller',
      finish: 'roller',
      rollerLayout: true,
      shape: { kind: 'roller', radius: 0.024, sizeParams: [{ axis: 0, param: 'width' }], stub: { radius: 0.004, length: 0.03, protrude: 0.01 }, bands: { inset: 0.02 } },
      offset: [0, -0.024, 0],
      array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: 0.075, worldPhase: true } },
    },
    { name: 'plate', parent: 'roller', shape: { kind: 'box', size: [0.1, 0.002, 1] }, offset: [0, 0, 0] },
  ]

  it('refuses a roller link as an unknown kind (it has no retirement entry)', () => {
    const problems = validatePartPackage(rigPackage({ links: rollerBed(), joints: [] }))
    expect(problems.map((p) => p.field)).toContain('geometry.links[1].shape.kind')
  })

  it('refuses a turntable roller deck (the circular bed) the same way', () => {
    const deck = [{ name: 'plate', shape: { kind: 'roller', bed: { kind: 'circular', widthParam: 'width', plateFactor: 1.4, pitch: 0.1, radius: 0.03, frames: true, bolts: true } }, offset: [0, 0, 0] }]
    expect(validatePartPackage(rigPackage({ links: deck, joints: [] })).map((p) => p.field)).toContain('geometry.links[0].shape.kind')
  })

  it('drops the roller link and what hangs beneath it, and the rest validates', () => {
    const { pkg, dropped } = dropRetiredRigLinks(rigPackage({ links: rollerBed(), joints: [] }), RETIRED)
    expect(dropped.sort()).toEqual(['plate', 'roller'])
    const geo = (pkg as { geometry: { links: { name: string }[] } }).geometry
    expect(geo.links.map((l) => l.name)).toEqual(['deck'])
    expect(validatePartPackage(pkg)).toEqual([])
  })

  it('leaves a stored chain link alone under the real (empty) table, so validation refuses it', () => {
    const raw = rigPackage({ links: laneLinks(), joints: joints() })
    expect(dropRetiredRigLinks(raw)).toEqual({ pkg: raw, dropped: [] })
  })

  it('hands back the very same package when there is nothing retired in it', () => {
    const raw = rigPackage()
    expect(dropRetiredRigLinks(raw, RETIRED)).toEqual({ pkg: raw, dropped: [] })
    expect(dropRetiredRigLinks(raw).pkg).toBe(raw)
    for (const junk of [null, undefined, 'x', {}, { geometry: { kind: 'deck' } }]) expect(dropRetiredRigLinks(junk).pkg).toBe(junk)
  })
})

describe('renameRigJoint + behaviorMentions (joint rename, script never rewritten)', () => {
  const j = (name: string, link: string): RigJoint => ({ name, link, type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 })
  const joints = [j('arm-joint', 'arm'), j('wrist', 'hand')]

  it('renames only the named joint, keeping its link and limits', () => {
    const out = renameRigJoint(joints, 'arm-joint', '  shoulder ')
    expect(out?.map((x) => x.name)).toEqual(['shoulder', 'wrist'])
    expect(out?.[0]).toEqual({ ...joints[0], name: 'shoulder' })
    expect(joints[0]!.name).toBe('arm-joint') // pure
  })

  it('refuses a blank, unchanged, unknown or colliding rename', () => {
    expect(renameRigJoint(joints, 'arm-joint', '   ')).toBeNull()
    expect(renameRigJoint(joints, 'arm-joint', 'arm-joint')).toBeNull()
    expect(renameRigJoint(joints, 'nope', 'x')).toBeNull()
    expect(renameRigJoint(joints, 'arm-joint', 'wrist')).toBeNull()
  })

  it('counts every way a script can reach a joint as a mention - the forms a literal rewrite would miss too', () => {
    for (const src of [
      "definePart({ step(ctx) { ctx.setJoint('shoulder', 1) } })",
      'definePart({ step(ctx) { ctx.joints.shoulder = 1 } })',
      'definePart({ step(ctx) { const a = ctx.measured.joints.shoulder } })',
      "definePart({ joints: ['shoulder'], step() {} })",
      'definePart({ step() {} }) // shoulder',
    ]) expect(behaviorMentions(src, 'shoulder')).toBe(true)
    expect(behaviorMentions('definePart({ step() {} })', 'shoulder')).toBe(false)
    expect(behaviorMentions('definePart({ step() {} })', '')).toBe(false)
  })
})

// A posable array (array.posable): a row of carriers the behavior moves one by one, counted by the `pitch` form
describe('posable arrays and the pitch form', () => {
  const carrier = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'shoe', shape: { kind: 'frame' }, offset: [0, 0, 0], collision: { box: [0.06, 0.05, 0.14] },
    array: { pitch: { axis: 0, spanParam: 'length', pitch: 0.076 }, posable: true },
    ...over,
  })
  const rig = (...links: Record<string, unknown>[]): unknown => rigPackage({ links, joints: [] })

  it('accepts a frame with a collision box as a posable pitch array', () => {
    expect(validatePartPackage(rig(carrier()))).toEqual([])
  })

  it('a collision box is for a mesh or a frame, not a primitive', () => {
    expect(fields(rig(carrier({ shape: { kind: 'box', size: [1, 1, 1] } })))).toContain('geometry.links[0].collision.box')
  })

  it('checks the pitch form: a positive pitch, a span param, and one form only', () => {
    expect(fields(rig(carrier({ array: { pitch: { axis: 0, spanParam: 'length', pitch: 0 } } })))).toContain('geometry.links[0].array.pitch.pitch')
    expect(fields(rig(carrier({ array: { pitch: { axis: 0, spanParam: '', pitch: 0.1 } } })))).toContain('geometry.links[0].array.pitch.spanParam')
    expect(fields(rig(carrier({ array: { pitch: { axis: 0, spanParam: 'length', pitch: 0.1 }, count: 'n', step: [1, 0, 0] } })))).toContain('geometry.links[0].array')
  })

  it('refuses a posable label link, a posable worldPhase row, and a posable load cell', () => {
    expect(fields(rig(carrier({ shape: { kind: 'label', text: 'x' } })))).toContain('geometry.links[0].array.posable')
    expect(fields(rig(carrier({ array: { distribute: { axis: 0, spanParam: 'length', maxSpacing: 0.1, worldPhase: true }, posable: true } })))).toContain('geometry.links[0].array.posable')
    expect(fields(rig(carrier({ shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, collision: undefined, loadCell: true })))).toContain('geometry.links[0].array.posable')
  })

  it('accepts a posable gripper: a magazine position per copy', () => {
    expect(validatePartPackage(rig(carrier({ grip: { radius: 0.1 } })))).toEqual([])
  })

  it('accepts a posable conveying deck: a cross-belt carrier is a box that conveys', () => {
    expect(validatePartPackage(rig(carrier({ shape: { kind: 'box', size: [0.5, 0.06, 0.7] }, collision: undefined, conveys: true })))).toEqual([])
  })

  it("reports a pitch array whose span param can ask for more copies than the row holds", () => {
    const shoes = carrier() as unknown as RigLink
    const geo = { kind: 'rig' as const, links: [shoes], joints: [] }
    const length = (max?: number): ParamSchema => ({ length: { type: 'number', default: 3, ...(max !== undefined ? { max } : {}) } })
    expect(checkGeometryRefs(geo, length(8))).toEqual([]) // 8 / 0.076 = 105
    expect(checkGeometryRefs(geo, length(100)).map((p) => p.message).join()).toMatch(/needs 1316 copies/)
    expect(checkGeometryRefs(geo, length()).map((p) => p.message).join()).toMatch(/has no max/)
  })

  it("checks span terms: each names a param, and the row at every param's max must fit", () => {
    const loop = carrier({ array: { pitch: { axis: 0, spanParam: 'length', spanTerms: [{ param: 'radius', scale: 6.3 }], pitch: 0.076 }, posable: true } }) as unknown as RigLink
    const geo = { kind: 'rig' as const, links: [loop], joints: [] }
    const both = (radiusMax?: number): ParamSchema => ({ length: { type: 'number', default: 3, max: 8 }, radius: { type: 'number', default: 1, ...(radiusMax !== undefined ? { max: radiusMax } : {}) } })
    expect(checkGeometryRefs(geo, both(4))).toEqual([]) // (8 + 25.2) / 0.076 = 437
    expect(checkGeometryRefs(geo, both(20)).map((p) => p.message).join()).toMatch(/radius = 20 the row needs/)
    expect(checkGeometryRefs(geo, both()).map((p) => p.message).join()).toMatch(/"radius" has no max/)
    expect(checkGeometryRefs(geo, { length: { type: 'number', default: 3, max: 8 } }).map((p) => p.field)).toContain('geometry.links[0].array.pitch.spanTerms[0].param')
    expect(fields(rig(carrier({ array: { pitch: { axis: 0, spanParam: 'length', spanTerms: [{ param: '' }], pitch: 0.1 }, posable: true } })))).toContain('geometry.links[0].array.pitch.spanTerms[0].param')
  })

  it('refuses a link hung under a posable array: it would follow the row, not an instance', () => {
    expect(fields(rig(carrier(), { name: 'tip', parent: 'shoe', shape: { kind: 'box', size: [0.1, 0.1, 0.1] }, offset: [0, 0, 0] }))).toContain('geometry.links[1].parent')
  })
})
