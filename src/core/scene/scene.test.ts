import { describe, expect, it } from 'vitest'
import { PART_DEFS, SCENE_VERSION } from '../types'
import type { ParamValue, PartInstance, PartType, SceneJSON } from '../types'
import {
  cloneScene,
  createSdkPart,
  createPart,
  emptyScene,
  nextId,
  pilotUsable,
  serializeScene,
  usePart,
  validateScene,
} from './scene'
import type { ValidationResult } from './scene'
import { registerPackage, unregisterPackage } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import { PACKAGE_FORMAT } from '../parts/partPackage'

const ALL_TYPES = Object.keys(PART_DEFS) as PartType[]

function expectValid(res: ValidationResult): SceneJSON {
  if (!res.ok) throw new Error(`expected valid scene: ${res.errors.join('; ')}`)
  return res.scene
}

function expectErrors(res: ValidationResult): string[] {
  if (res.ok) throw new Error('expected validation errors')
  return res.errors
}

function paramsOf(scene: SceneJSON, i: number): Record<string, ParamValue> {
  return scene.parts[i]!.params as unknown as Record<string, ParamValue>
}

// Two plain group nodes used as generic scene fixtures (serialize / validate / round-trip / clone
// coverage that doesn't care about the part type). A group is always valid and needs no package, so it's
// a neutral stand-in. The ids rc_1/bst_1 match the id-based assertions below.
function sampleScene(): SceneJSON {
  return {
    version: SCENE_VERSION,
    parts: [
      createPart('group', 'rc_1', [1, 0.75, 2], 0.5),
      createPart('group', 'bst_1', [0, 0.75, 0]),
    ],
  }
}

// An oip.box cargo custom-part package. Cargo (box/pallet) is a `custom` part whose package declares
// geometry.kind:'cargo'. Params mirror the
// built-in Box (length/height/width/mass/color, same bounds/defaults), so the param-clamping / default-filling
// / deep-copy / key-order tests below keep their exact assertions. Registered globally so serializeScene can
// resolve its param specs from the registry (the key-order test embeds no packages).
function boxPackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'oip.box',
    name: 'Box',
    params: {
      length: { type: 'number', default: 0.6, min: 0.1, max: 1.2, step: 0.05, label: 'Length (m)' },
      height: { type: 'number', default: 0.4, min: 0.1, max: 1.2, step: 0.05, label: 'Height (m)' },
      width: { type: 'number', default: 0.4, min: 0.1, max: 1.2, step: 0.05, label: 'Width (m)' },
      mass: { type: 'number', default: 10, min: 0.5, max: 100, step: 0.5, label: 'Mass (kg)' },
      color: { type: 'color', default: '#ffffff', label: 'Color' },
    },
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 0.6, width: 0.4, height: 0.4 } },
  }
}
registerPackage(boxPackage())

// A package with an `enum` param, so the enum spec kind (default filling / listed-option clamping) keeps its
// coverage (shadow-map resolution, the obvious enum, is a per-client preference in src/render/quality.ts, not
// scene data).
function enumPackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.enum',
    name: 'Enum',
    params: {
      mode: { type: 'enum', default: 'b', options: [{ value: 'a' }, { value: 'b' }, { value: 'c' }], label: 'Mode' },
    },
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 1, width: 1, height: 1 } },
  }
}
registerPackage(enumPackage())

// A minimal legged part whose standHeight is a `rest:'surfaceBelow'` fact (max 3 m slider), for the reload
// regression: a deck on a tall surface resolves standHeight > 3 and must survive validation un-clamped.
function leggedPackage(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.legged',
    name: 'Legged',
    params: {
      standHeight: { type: 'number', default: 2, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)' },
      speed: { type: 'number', default: 1, min: -3, max: 3, step: 0.1, label: 'Speed' },
    },
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 1, width: 1, height: 1 } },
  }
}

// Two cargo boxes with the built-in-box param schema, package embedded (so validateScene resolves it), for the
// tests that assert on box params (clamp / defaults / deep copy / clone). parts[0] sits at x=1 so the position
// assertions read unchanged.
function boxScene(): SceneJSON {
  return {
    version: SCENE_VERSION,
    parts: [createSdkPart(boxPackage(), 'cp_1', [1, 0.75, 2], 0.5), createSdkPart(boxPackage(), 'cp_2', [0, 0.75, 0])],
    packages: [boxPackage()],
  }
}

// A v1 document (version 1). v1 scenes can only hold roller_conveyor / box_spawner parts, which are SDK
// parts rather than built-in types, so a v1 doc fails validation (see the v1-rejection test). Untyped JSON
// to drive that path.
function v1Doc(): Record<string, unknown> {
  return {
    version: 1,
    parts: [
      {
        id: 'rc_1',
        type: 'roller_conveyor',
        position: [1, 0.75, 2],
        rotationY: 0.5,
        params: { length: 4, width: 0.8, speed: -1 },
      },
    ],
  }
}

describe('createPart', () => {
  it('builds the full part shape with default params (empty for a param-less group)', () => {
    const p = createPart('group', 'grp_1', [1, 0.75, 2])
    expect(p).toEqual({
      id: 'grp_1',
      type: 'group',
      position: [1, 0.75, 2],
      rotationY: 0,
      params: {},
    })
  })

  it('fills boolean, enum and list defaults for every spec kind', () => {
    const building = createPart('building', 'bld_1', [0, 0, 0])
    expect(building.params).toEqual({
      lengthSections: 4,
      widthSections: 3,
      heightSections: 1,
      columnSpacing: 0,
      rules: [], // list (wallRules) default, deep-copied per instance
      floorVisible: true, // booleans
      wallsVisible: true,
      roofVisible: true,
      brightness: 1,
      backgroundColor: '#9fb1c4',
    })
    // enum default (a package param - no built-in type has an enum spec any more)
    expect(createSdkPart(enumPackage(), 'enum_1', [0, 0, 0]).params).toEqual({ mode: 'b' })
  })

  it('fills every PART_DEFS key for every type', () => {
    for (const type of ALL_TYPES) {
      const p = createPart(type, 'x_1', [0, 0, 0])
      const keys = PART_DEFS[type].params.map((s) => s.key)
      expect(Object.keys(p.params)).toEqual(keys)
      for (const spec of PART_DEFS[type].params) {
        const v = (p.params as unknown as Record<string, ParamValue>)[spec.key]
        // array/object defaults (belt segments, guard openings, stack-light tiers) are
        // deep-copied per instance, so compare by value; scalar defaults share the reference
        if (typeof spec.default === 'object' && spec.default !== null) expect(v).toStrictEqual(spec.default)
        else expect(v).toBe(spec.default)
      }
    }
  })

  it('copies the position array', () => {
    const pos: [number, number, number] = [1, 2, 3]
    const p = createPart('group', 'grp_1', pos)
    pos[0] = 99
    expect(p.position[0]).toBe(1)
  })
})

describe('nextId', () => {
  it('starts at 1 with the right prefix for every type', () => {
    // mirrors scene.ts ID_PREFIXES (box/pallet retired; custom->part v4; annotation added)
    const prefixes: Record<PartType, string> = {
      building: 'bld',
      group: 'grp',
      part: 'pt',
      annotation: 'note',
    }
    for (const type of ALL_TYPES) {
      expect(nextId(emptyScene(), type)).toBe(`${prefixes[type]}_1`)
    }
  })

  it('uses max numeric suffix + 1, skipping gaps', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [
        createPart('group', 'grp_1', [0, 0, 0]),
        createPart('group', 'grp_5', [1, 0, 0]),
        createPart('group', 'grp_3', [2, 0, 0]),
      ],
    }
    expect(nextId(scene, 'group')).toBe('grp_6')
  })

  it('keeps prefixes independent and ignores non-numeric suffixes', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [
        createPart('group', 'grp_7', [0, 0, 0]),
        createPart('group', 'grp_foo', [1, 0, 0]),
        createPart('building', 'bld_2', [2, 0, 0]),
      ],
    }
    expect(nextId(scene, 'building')).toBe('bld_3')
    expect(nextId(scene, 'group')).toBe('grp_8')
  })

  it('keeps grp (group) and bld (building) ids disjoint', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [
        createPart('group', 'grp_4', [0, 0, 0]),
        createPart('building', 'bld_9', [1, 0, 0]),
      ],
    }
    expect(nextId(scene, 'group')).toBe('grp_5')
    expect(nextId(scene, 'building')).toBe('bld_10')
  })

  it('does not count bld ids toward the grp prefix or vice versa', () => {
    const buildings: SceneJSON = {
      version: SCENE_VERSION,
      parts: [createPart('building', 'bld_3', [0, 0, 0])],
    }
    expect(nextId(buildings, 'group')).toBe('grp_1')
    const groups: SceneJSON = {
      version: SCENE_VERSION,
      parts: [createPart('group', 'grp_3', [0, 0, 0])],
    }
    expect(nextId(groups, 'building')).toBe('bld_1')
  })
})

describe('validateScene v1 documents', () => {
  it('rejects a v1 document: its only legal part types (roller_conveyor/box_spawner) were retired', () => {
    // v1 scenes can only contain roller_conveyor / box_spawner, which are SDK custom parts and not in
    // PART_DEFS. With no legal v1 part type, a v1 doc does not migrate: validateScene rejects the unknown
    // part type.
    const errors = expectErrors(validateScene(v1Doc()))
    expect(errors.join(' ')).toMatch(/type/)
  })
})

describe('validateScene', () => {
  it('accepts a round-tripped scene unchanged', () => {
    const scene = sampleScene()
    const res = validateScene(JSON.parse(serializeScene(scene)))
    expect(expectValid(res)).toEqual(scene)
  })

  it('migrates a pre-v4 scene: the generic part discriminant "custom" -> "part", version -> current', () => {
    // v4 names the SDK-part type 'part'; a v1/v2/v3 scene stores 'custom', which is not in PART_DEFS.
    // validateScene rewrites it (before the known-type check) so older saved/shared scenes still load. Part ids are preserved verbatim; the embedded package still resolves.
    const pkg = boxPackage()
    const v3 = {
      version: 3,
      parts: [{ id: 'cp_1', type: 'custom', packageId: pkg.id, position: [1, 0.2, 2], rotationY: 0, params: { mass: 12 } }],
      packages: [pkg],
    }
    const scene = expectValid(validateScene(v3))
    expect(scene.version).toBe(SCENE_VERSION)
    expect(scene.parts[0]!.type).toBe('part')
    expect(scene.parts[0]!.id).toBe('cp_1')
    expect((scene.parts[0] as { packageId: string }).packageId).toBe(pkg.id)
  })

  it('rejects a v4 scene that still uses the old "custom" discriminant (only pre-v4 migrates)', () => {
    const pkg = boxPackage()
    const v4 = {
      version: SCENE_VERSION,
      parts: [{ id: 'cp_1', type: 'custom', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params: {} }],
      packages: [pkg],
    }
    expect(expectErrors(validateScene(v4)).join(' ')).toMatch(/type/)
  })

  it('drops a retired tagScope and reports it, since copies of a cell share their tags', () => {
    const inst = createPart('group', 'rc_1', [1, 0.75, 2], 0.5)
    const res = validateScene({ version: SCENE_VERSION, parts: [{ ...inst, name: 'Cell A', tagScope: 'Cell3' }] })
    if (!res.ok) throw new Error(res.errors.join('; '))
    expect('tagScope' in res.scene.parts[0]!).toBe(false)
    expect(res.repairs).toEqual(['parts[0] (Cell A).tagScope "Cell3" is retired, so the tags below it are no longer prefixed with it'])
    // a blank one was never a scope, so it is dropped without a word
    const blank = validateScene({ version: SCENE_VERSION, parts: [{ ...inst, tagScope: '' }] })
    expect(blank.ok && blank.repairs).toBeFalsy()
  })

  it('loads a scene saved while assemblies were linked, dropping the link fields and nothing else', () => {
    // A placed copy of a linked assembly carries masterId / instanceId / masterKey / overrides. Linking is
    // retired. The copy is a full set of world-space parts, so it loads unchanged, just unlinked.
    const raw = {
      version: SCENE_VERSION,
      parts: [
        { ...createPart('group', 'grp_1', [1, 0, 2], 0.5), masterId: 'prefab_1', instanceId: 'inst_7', masterKey: 'grp_root' },
        { ...createPart('group', 'grp_2', [2, 0, 2]), parent: 'grp_1', masterId: 'prefab_1', instanceId: 'inst_7', masterKey: 'grp_x', overrides: { mass: 25 } },
      ],
    }
    const back = expectValid(validateScene(JSON.parse(JSON.stringify(raw))))
    expect(back.parts.map((p) => [p.id, p.parent, p.position])).toEqual([
      ['grp_1', undefined, [1, 0, 2]],
      ['grp_2', 'grp_1', [2, 0, 2]],
    ])
    for (const p of back.parts) for (const k of ['masterId', 'instanceId', 'masterKey', 'overrides']) expect(k in p).toBe(false)
  })

  it('round-trips createPart defaults for every part type', () => {
    // 'custom' is package-driven (createSdkPart + an embedded package), not createPart-able - its
    // round-trip is covered in sdkPart.test.ts.
    for (const type of ALL_TYPES.filter((t) => t !== 'part')) {
      const scene: SceneJSON = {
        version: SCENE_VERSION,
        parts: [createPart(type, 'part_1', [1, PART_DEFS[type].defaultY, -2], 0.3)],
      }
      const first = expectValid(validateScene(JSON.parse(JSON.stringify(scene))))
      expect(first).toEqual(scene)
      const json = serializeScene(first)
      const second = expectValid(validateScene(JSON.parse(json)))
      expect(second).toEqual(scene)
      expect(serializeScene(second)).toBe(json)
    }
  })

  it('round-trips a hidden part and omits visible for shown parts', () => {
    const base = createPart('group', 'rc_1', [0, 0.75, 0])
    const json = serializeScene({ version: SCENE_VERSION, parts: [{ ...base, visible: false }] })
    expect(json).toContain('"visible": false')
    expect(expectValid(validateScene(JSON.parse(json))).parts[0]?.visible).toBe(false)
    // a visible (default) part must not emit the key...
    expect(serializeScene({ version: SCENE_VERSION, parts: [base] })).not.toContain('visible')
    // ...and an explicit visible:true input is normalized back to the default (omitted)
    const shown = expectValid(validateScene({ version: SCENE_VERSION, parts: [{ ...base, visible: true }] }))
    expect('visible' in (shown.parts[0] as object)).toBe(false)
  })

  it('round-trips a locked part and omits locked for unlocked parts', () => {
    const base = createPart('group', 'rc_1', [0, 0.75, 0])
    const json = serializeScene({ version: SCENE_VERSION, parts: [{ ...base, locked: true }] })
    expect(json).toContain('"locked": true')
    expect(expectValid(validateScene(JSON.parse(json))).parts[0]?.locked).toBe(true)
    // an unlocked (default) part must not emit the key...
    expect(serializeScene({ version: SCENE_VERSION, parts: [base] })).not.toContain('locked')
    // ...and an explicit locked:false input is normalized back to the default (omitted)
    const open = expectValid(validateScene({ version: SCENE_VERSION, parts: [{ ...base, locked: false }] }))
    expect('locked' in (open.parts[0] as object)).toBe(false)
  })

  it('bundles a non-empty ST program and round-trips it', () => {
    const program = 'IF Start THEN Motor := TRUE; END_IF'
    const json = serializeScene(sampleScene(), program)
    expect(json).toContain('"stProgram"')
    const res = validateScene(JSON.parse(json))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.stProgram).toBe(program)
      // the program lives at the file's top level, not inside the spatial scene
      expect('stProgram' in res.scene).toBe(false)
    }
  })

  it('omits stProgram when empty or absent, leaving an importer untouched', () => {
    expect(serializeScene(sampleScene())).not.toContain('stProgram')
    expect(serializeScene(sampleScene(), '')).not.toContain('stProgram')
    // no bundled program -> undefined, so the import path skips overwriting the editor
    const res = validateScene(JSON.parse(serializeScene(sampleScene())))
    if (res.ok) expect(res.stProgram).toBeUndefined()
  })

  it('ignores a non-string stProgram rather than erroring', () => {
    const data = JSON.parse(serializeScene(sampleScene())) as Record<string, unknown>
    data.stProgram = 42
    const res = validateScene(data)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.stProgram).toBeUndefined()
  })

  it('returns a deep fresh copy', () => {
    const data = JSON.parse(serializeScene(boxScene()))
    const scene = expectValid(validateScene(data))
    expect(scene.parts[0]).not.toBe(data.parts[0])
    expect(scene.parts[0]?.position).not.toBe(data.parts[0].position)
    data.parts[0].position[0] = 999
    data.parts[0].params.length = 999
    expect(scene.parts[0]?.position[0]).toBe(1)
    expect(scene.parts[0]?.params).toEqual({ length: 0.6, height: 0.4, width: 0.4, mass: 10, color: '#ffffff' })
  })

  it('rejects non-object input', () => {
    expect(validateScene(null).ok).toBe(false)
    expect(validateScene('scene').ok).toBe(false)
    expect(validateScene([1, 2]).ok).toBe(false)
  })

  it('rejects unsupported versions', () => {
    expect(expectErrors(validateScene({ version: 99, parts: [] })).join(' ')).toMatch(/version/)
    expect(expectErrors(validateScene({ version: '2', parts: [] })).join(' ')).toMatch(/version/)
  })

  it('rejects missing or non-array parts', () => {
    expect(expectErrors(validateScene({ version: SCENE_VERSION })).join(' ')).toMatch(/parts/)
    expect(validateScene({ version: SCENE_VERSION, parts: 'nope' }).ok).toBe(false)
  })

  it('rejects duplicate ids', () => {
    const data = JSON.parse(serializeScene(sampleScene()))
    data.parts[1].id = 'rc_1'
    const errors = expectErrors(validateScene(data))
    expect(errors.join(' ')).toMatch(/rc_1/)
  })

  it('rejects empty or non-string ids', () => {
    const data = JSON.parse(serializeScene(sampleScene()))
    data.parts[0].id = ''
    expect(validateScene(data).ok).toBe(false)
    data.parts[0].id = 7
    expect(validateScene(data).ok).toBe(false)
  })

  it('rejects unknown part types', () => {
    const data = JSON.parse(serializeScene(sampleScene()))
    data.parts[0].type = 'teleporter'
    const errors = expectErrors(validateScene(data))
    expect(errors.join(' ')).toMatch(/type/)
  })

  it('rejects bad positions and non-finite rotation', () => {
    const base = () => JSON.parse(serializeScene(sampleScene()))
    let data = base()
    data.parts[0].position = [0, 1]
    expect(validateScene(data).ok).toBe(false)
    data = base()
    data.parts[0].position = [0, Infinity, 0]
    expect(validateScene(data).ok).toBe(false)
    data = base()
    data.parts[0].position = 'origin'
    expect(validateScene(data).ok).toBe(false)
    data = base()
    data.parts[0].rotationY = NaN
    expect(validateScene(data).ok).toBe(false)
    data = base()
    data.parts[0].rotationY = '0'
    expect(validateScene(data).ok).toBe(false)
  })

  it('clamps out-of-range number params', () => {
    const data = JSON.parse(serializeScene(boxScene()))
    data.parts[0].params = { length: 99, width: 0.001, mass: -100 }
    const scene = expectValid(validateScene(data))
    // each number param is clamped to its ParamSpec [min, max]; the unset ones fall back to defaults
    expect(scene.parts[0]?.params).toEqual({ length: 1.2, height: 0.4, width: 0.1, mass: 0.5, color: '#ffffff' })
  })

  it('preserves a rest param above its manual max on load, still clamping normal number params', () => {
    // A conveyor deck standing on a tall surface gets a host-resolved standHeight above the 3 m slider max.
    // Load must not shrink it to the max: that keeps the deck in place but shortens the legs, leaving them off
    // the floor on reload. A non-rest param (speed) is still clamped.
    registerPackage(leggedPackage())
    try {
      const scene: SceneJSON = {
        version: SCENE_VERSION,
        parts: [{ id: 'cp_1', type: 'part', packageId: 'test.legged', position: [0, 3.51, 0], rotationY: 0, params: { standHeight: 3.5, speed: 99 } } as unknown as PartInstance],
        packages: [leggedPackage()],
      }
      const data = JSON.parse(serializeScene(scene))
      const out = expectValid(validateScene(data))
      expect(paramsOf(out, 0).standHeight).toBe(3.5) // rest fact survives above max
      expect(paramsOf(out, 0).speed).toBe(3) // ordinary number still clamped to [min, max]
    } finally {
      unregisterPackage('test.legged')
    }
  })

  it('fills missing or non-finite params with defaults', () => {
    const data = JSON.parse(serializeScene(boxScene()))
    data.parts[0].params = { length: 1, mass: NaN, width: 'wide' } // valid length kept; NaN + wrong-type default out
    data.parts[1].params = undefined
    const scene = expectValid(validateScene(data))
    expect(scene.parts[0]?.params).toEqual({ length: 1, height: 0.4, width: 0.4, mass: 10, color: '#ffffff' })
    expect(scene.parts[1]?.params).toEqual({ length: 0.6, height: 0.4, width: 0.4, mass: 10, color: '#ffffff' })
  })

  it('keeps listed enum values and defaults unlisted ones', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [createSdkPart(enumPackage(), 'enum_1', [0, 0, 0])],
      packages: [enumPackage()], // validateScene resolves specs from the embedded package
    }
    const data = JSON.parse(serializeScene(scene))
    data.parts[0].params.mode = 'c' // a listed option
    const out = expectValid(validateScene(data))
    expect(paramsOf(out, 0).mode).toBe('c')

    data.parts[0].params.mode = 7 // not a listed option -> default
    expect(paramsOf(expectValid(validateScene(data)), 0).mode).toBe('b')
  })

  it('keeps strict booleans and defaults everything else', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [
        createPart('building', 'bld_1', [0, 0, 0]),
      ],
    }
    const data = JSON.parse(serializeScene(scene))
    data.parts[0].params.roofVisible = false // a strict boolean is kept
    data.parts[0].params.floorVisible = 'yes' // non-boolean -> default (true)
    const out = expectValid(validateScene(data))
    expect(paramsOf(out, 0).roofVisible).toBe(false)
    expect(paramsOf(out, 0).floorVisible).toBe(true)
  })

  it('accepts a non-empty string name and drops invalid ones', () => {
    const data = JSON.parse(serializeScene(sampleScene()))
    data.parts[0].name = 'Main line'
    data.parts[1].name = ''
    const scene = expectValid(validateScene(data))
    expect(scene.parts[0]?.name).toBe('Main line')
    expect('name' in (scene.parts[1] ?? {})).toBe(false)

    data.parts[1].name = 42
    expect('name' in (expectValid(validateScene(data)).parts[1] ?? {})).toBe(false)
  })

  it('drops unknown fields', () => {
    const data = JSON.parse(serializeScene(sampleScene()))
    data.extra = true
    data.parts[0].color = 'red'
    data.parts[0].params.glow = 9
    const scene = expectValid(validateScene(data))
    expect('extra' in scene).toBe(false)
    expect('color' in (scene.parts[0] ?? {})).toBe(false)
    expect('glow' in (scene.parts[0]?.params ?? {})).toBe(false)
  })

  it('collects multiple errors', () => {
    // a known type (group), so validation doesn't bail early on an unknown type - the version, empty id
    // and non-finite position all accumulate
    const data = {
      version: 99,
      parts: [{ id: '', type: 'group', position: [NaN, 0, 0], rotationY: 0, params: {} }],
    }
    const errors = expectErrors(validateScene(data))
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('building', () => {
  it('validates a scene with one building', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [
        createPart('building', 'bld_1', [0, 0, 0]),
        createPart('group', 'rc_1', [0, 0.75, 0]),
      ],
    }
    const back = expectValid(validateScene(JSON.parse(serializeScene(scene))))
    expect(back).toEqual(scene)
    expect(back.parts[0]?.params).toEqual({
      lengthSections: 4,
      widthSections: 3,
      heightSections: 1,
      columnSpacing: 0,
      rules: [],
      floorVisible: true,
      wallsVisible: true,
      roofVisible: true,
      brightness: 1,
      backgroundColor: '#9fb1c4',
    })
  })

  it('rejects a second building', () => {
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [
        createPart('building', 'bld_1', [0, 0, 0]),
        createPart('building', 'bld_2', [30, 0, 0]),
      ],
    }
    const errors = expectErrors(validateScene(JSON.parse(serializeScene(scene))))
    expect(errors.join(' ')).toMatch(/only one building allowed/)
    expect(errors.join(' ')).toContain('parts[1]')
  })

  it('nextId uses the bld prefix', () => {
    expect(nextId(emptyScene(), 'building')).toBe('bld_1')
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [createPart('building', 'bld_4', [0, 0, 0])],
    }
    expect(nextId(scene, 'building')).toBe('bld_5')
  })
})

// Cargo is the SDK custom part oip.box / oip.pallet (a `custom` part whose package declares
// geometry.kind:'cargo'); its create/validate/round-trip + cargoView resolution is covered by
// render/parts/cargoPartsParity.test.ts and the custom-part round-trip by core/sdkPart.test.ts.

// Side-guard parameters live on the SDK conveyor custom parts, whose authoring/round-trip is covered
// by the part-SDK and belt-parity suites, not this core scene test.

describe('serializeScene', () => {
  it('emits stable key order, 2-space indent, trailing newline', () => {
    // a custom oip.box part; the package is registered globally, so serializeScene resolves its canonical
    // param spec order (length/height/width/mass/color) from the registry even without an embedded copy
    const scene: SceneJSON = {
      version: SCENE_VERSION,
      parts: [
        {
          // shuffled insertion order - serializeScene must emit the canonical spec order
          params: { color: '#ffffff', mass: 12, width: 0.5, length: 0.9, height: 0.3 },
          rotationY: 0,
          position: [1, 0.75, 2] as [number, number, number],
          packageId: 'oip.box',
          type: 'part',
          id: 'pt_1',
        } as SceneJSON['parts'][number],
      ],
    }
    const json = serializeScene(scene)
    expect(json).toBe(
      [
        '{',
        '  "version": 4,',
        '  "parts": [',
        '    {',
        '      "id": "pt_1",',
        '      "type": "part",',
        '      "packageId": "oip.box",',
        '      "position": [',
        '        1,',
        '        0.75,',
        '        2',
        '      ],',
        '      "rotationY": 0,',
        '      "params": {',
        '        "length": 0.9,',
        '        "height": 0.3,',
        '        "width": 0.5,',
        '        "mass": 12,',
        '        "color": "#ffffff"',
        '      }',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('places name between id and type when present', () => {
    const scene = sampleScene()
    scene.parts[0]!.name = 'Main line'
    const json = serializeScene(scene)
    expect(json).toContain('"name": "Main line"')
    const idAt = json.indexOf('"id": "rc_1"')
    const nameAt = json.indexOf('"name"')
    const typeAt = json.indexOf('"type": "group"')
    expect(idAt).toBeGreaterThanOrEqual(0)
    expect(nameAt).toBeGreaterThan(idAt)
    expect(typeAt).toBeGreaterThan(nameAt)
    const back = expectValid(validateScene(JSON.parse(json)))
    expect(back).toEqual(scene)
  })

  it('omits name when absent', () => {
    expect(serializeScene(sampleScene())).not.toContain('"name"')
  })

  it('round-trips through parse and validate to an identical scene', () => {
    const scene = sampleScene()
    const back = expectValid(validateScene(JSON.parse(serializeScene(scene))))
    expect(back).toEqual(scene)
    expect(serializeScene(back)).toBe(serializeScene(scene))
  })
})

describe('cloneScene', () => {
  it('deep-copies parts, positions and params', () => {
    const scene = boxScene() // a part with params (box), so the params deep-copy assertion has something to check
    const clone = cloneScene(scene)
    expect(clone).toEqual(scene)
    expect(clone).not.toBe(scene)
    expect(clone.parts[0]).not.toBe(scene.parts[0])
    clone.parts[0]!.position[0] = 42
    ;(clone.parts[0]!.params as { length: number }).length = 42
    expect(scene.parts[0]?.position[0]).toBe(1)
    expect((scene.parts[0]?.params as { length: number }).length).toBe(0.6)
  })

  it('carries name', () => {
    const scene = sampleScene()
    scene.parts[0]!.name = 'Main line'
    const clone = cloneScene(scene)
    expect(clone.parts[0]?.name).toBe('Main line')
    expect('name' in (clone.parts[1] ?? {})).toBe(false)
  })
})

describe('emptyScene', () => {
  it('returns a fresh empty scene', () => {
    expect(emptyScene()).toEqual({ version: SCENE_VERSION, parts: [] })
    expect(emptyScene().parts).not.toBe(emptyScene().parts)
  })
})

describe('pilotUsable', () => {
  const at: [number, number, number] = [0, 0, 0]

  function testPackage(interactive: boolean): PartPackage {
    return {
      format: PACKAGE_FORMAT,
      id: 'test.pilot-use',
      name: 'Pilot Use',
      params: {},
      behavior: '',
      geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
      interactive,
    }
  }

  function sdkPart(): PartInstance {
    return { id: 'cp_1', type: 'part', packageId: 'test.pilot-use', position: at, rotationY: 0, params: {} }
  }

  // No built-in type has a use() action, so pilot usability is decided entirely by the custom-part
  // interactive flag, covered below.
  it('excludes a non-interactive part from pilot use (no built-in use action)', () => {
    // a plain group has no use() action at all, so it is neither editor-usable nor pilot-usable
    const group = createPart('group', 'grp_1', at)
    expect(usePart(group)).toBeNull()
    expect(pilotUsable(group)).toBe(false)
  })

  it('a custom part is usable only while its package declares interactive', () => {
    try {
      registerPackage(testPackage(true))
      expect(pilotUsable(sdkPart())).toBe(true)
      registerPackage(testPackage(false))
      expect(pilotUsable(sdkPart())).toBe(false)
      unregisterPackage('test.pilot-use')
      expect(pilotUsable(sdkPart())).toBe(false) // unregistered package: nothing to route the use to
    } finally {
      unregisterPackage('test.pilot-use')
    }
  })
})

describe('validateScene repairs', () => {
  // what loading changes to make a file valid is applied silently in the app; validate-project prints it
  const PKG: PartPackage = {
    format: PACKAGE_FORMAT,
    id: 'test.deck',
    name: 'Deck',
    params: {
      length: { type: 'number', min: 0.5, max: 10, default: 2 },
      count: { type: 'number', min: 1, max: 9, step: 1, default: 1 },
      mode: { type: 'enum', options: [{ value: 'a' }, { value: 'b' }], default: 'a' },
      tint: { type: 'color', default: '#112233' },
      tag: { type: 'tag', default: '' },
    },
    behavior: 'definePart({step(){}})',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
  const scene = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    version: SCENE_VERSION,
    packages: [PKG],
    parts: [{ id: 'a', type: 'part', packageId: 'test.deck', name: 'Infeed', position: [0, 0, 0], rotationY: 0, params, ...extra }],
  })
  const repairsOf = (data: unknown): string[] => {
    const r = validateScene(data)
    return r.ok ? (r.repairs ?? []) : [`invalid: ${r.errors.join('; ')}`]
  }

  it('refuses a scene whose embedded package still has a chain lane', () => {
    // an older scene embeds the chain transfer as it was then: its lanes a kind:'chain' link. Such a scene fails
    // to load rather than having the link dropped.
    const old = {
      version: SCENE_VERSION,
      packages: [{ ...PKG, geometry: { kind: 'rig', links: [
        { name: 'deck', shape: { kind: 'box', size: [1, 0.05, 1] }, offset: [0, 0, 0] },
        { name: 'lanes', parent: 'deck', shape: { kind: 'chain', laneLengthParam: 'length' }, offset: [0, 0, 0] },
      ], joints: [] } }],
      parts: [{ id: 'a', type: 'part', packageId: 'test.deck', position: [0, 0, 0], rotationY: 0, params: {} }],
    }
    const r = validateScene(old)
    expect(r.ok).toBe(false)
  })

  it('reports each value the file gave that loading changed, located and explained', () => {
    const repairs = repairsOf(scene({ length: 40, count: 2.4, mode: 'c', tint: 'red', lenght: 3 }))
    expect(repairs).toEqual([
      'parts[0] (Infeed).params.length: 40 is outside 0.5 to 10, so it loads as 10',
      'parts[0] (Infeed).params.count: 2.4 is not a whole step of 1, so it loads as 2',
      'parts[0] (Infeed).params.mode: "c" is not one of a, b, so it loads as "a"',
      'parts[0] (Infeed).params.tint: "red" is not a colour, so it loads as "#112233"',
      'parts[0] (Infeed).params.lenght is not a parameter of test.deck, so it is dropped',
    ])
  })

  it('is silent for an absent param, a colour in capitals, and an address it only respells', () => {
    const r = validateScene(scene({ tint: '#AABBCC', tag: '%ix0.0' }))
    expect(r.ok && r.repairs).toBe(undefined)
  })

  it('reports a parent link it cuts, and a program-less controller table it ignores', () => {
    const repairs = repairsOf({ ...scene({}, { parent: 'gone' }), controller: { tasks: [], programs: [] } })
    expect(repairs).toContain('parts[0] (Infeed).parent "gone" names no part, so it is dropped')
    expect(repairs).toContain('controller is ignored: the file has no stProgram for it to run')
  })
})

// A switch that changes what a part's existing numbers mean (a conveyor's speed from m/s to feet per minute) must be
// on for the next part placed and off for every part already saved: ParamSpec.whenAbsent. And a built-in part is
// checked against the schema that will run it, not the snapshot of some earlier build the scene happens to embed.
describe('a param added to a part after scenes were saved with it', () => {
  const drive = (extra: Record<string, unknown> = {}): PartPackage => ({
    format: PACKAGE_FORMAT,
    id: 'test.drive',
    name: 'Drive',
    params: { speed: { type: 'number', default: 2, label: 'Speed' }, ...extra } as PartPackage['params'],
    behavior: 'definePart({ step() {} })',
    geometry: { kind: 'cargo', cargoKind: 'box', size: { length: 1, width: 1, height: 1 } },
  })
  const NEWER = { fpmUnits: { type: 'boolean', default: true, whenAbsent: false, label: 'FPM' }, velocityTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', label: 'Velocity' } }
  const saved = (params: Record<string, unknown>, embedded: PartPackage) => ({ version: SCENE_VERSION, packages: [embedded], parts: [{ id: 'd_1', type: 'part', packageId: 'test.drive', position: [0, 0, 0], rotationY: 0, params }] })
  const paramsOfFirst = (r: ValidationResult): Record<string, unknown> => (r.ok ? ((r.scene.parts[0] as unknown as { params: Record<string, unknown> }).params) : { error: r.errors })

  it('a part a person places takes the default; one built in code, or saved without the key, takes whenAbsent', () => {
    expect(createSdkPart(drive(NEWER), 'd_new', [0, 0, 0], 0, { placed: true }).params.fpmUnits).toBe(true)
    expect(createSdkPart(drive(NEWER), 'd_code', [0, 0, 0]).params.fpmUnits).toBe(false) // code that then sets `speed` means m/s
    expect(paramsOfFirst(validateScene(saved({ speed: 1.5 }, drive(NEWER)))).fpmUnits).toBe(false)
    expect(paramsOfFirst(validateScene(saved({ speed: 1.5, fpmUnits: true }, drive(NEWER)))).fpmUnits).toBe(true)
  })

  it('a built-in is checked against the live schema: a key the embedded snapshot never heard of survives the load', () => {
    registerPackage(drive(NEWER), true) // this build's own copy, authoritative
    try {
      const loaded = paramsOfFirst(validateScene(saved({ speed: 1.5, fpmUnits: true, velocityTag: 'Belt101_Velocity' }, drive()))) // embeds the older schema
      expect(loaded).toMatchObject({ speed: 1.5, fpmUnits: true, velocityTag: 'Belt101_Velocity' })
    } finally {
      unregisterPackage('test.drive')
    }
    // ...while a part nobody ships is still checked against the copy the scene carries, which is all there is
    expect(paramsOfFirst(validateScene(saved({ speed: 1.5, velocityTag: 'x' }, drive()))).velocityTag).toBeUndefined()
  })

  // The live schema decides in both directions, and this is the direction that is easy to leave untested: a param
  // the shipped part has dropped is gone from what will run, so a value still in the file for it is not revived by
  // the snapshot the scene embeds. Otherwise loading would give the sim a param its behaviour does not read, and
  // the Inspector a field with nothing behind it.
  it('a built-in is checked against the live schema the other way too: a param it has since dropped does not come back', () => {
    registerPackage(drive(), true) // this build ships the plain drive: `speed` and nothing else
    try {
      const loaded = paramsOfFirst(validateScene(saved({ speed: 1.5, velocityTag: 'Belt101_Velocity' }, drive(NEWER)))) // embeds the richer schema
      expect(loaded).toEqual({ speed: 1.5 })
    } finally {
      unregisterPackage('test.drive')
    }
    // and with nothing registered, the embedded copy is authority again, so the same file keeps the key
    expect(paramsOfFirst(validateScene(saved({ speed: 1.5, velocityTag: 'Belt101_Velocity' }, drive(NEWER)))).velocityTag).toBe('Belt101_Velocity')
  })
})

describe('scene unit system (SceneJSON.units)', () => {
  const switched = (): PartPackage => ({
    ...enumPackage(),
    id: 'test.units',
    params: {
      fpmUnits: { type: 'boolean', default: true, whenAbsent: false, imperialUnits: true, label: 'Speeds in FPM' },
      other: { type: 'boolean', default: true, whenAbsent: false, label: 'Other switch' },
    },
  })
  it('a part a person places takes its units switch from the scene; nothing else changes', () => {
    expect(createSdkPart(switched(), 'u1', [0, 0, 0], 0, { placed: true, units: 'metric' }).params).toEqual({ fpmUnits: false, other: true })
    expect(createSdkPart(switched(), 'u2', [0, 0, 0], 0, { placed: true, units: 'imperial' }).params).toEqual({ fpmUnits: true, other: true })
    // a scene that never chose is metric, which its conveyors (saved before the switch) already are
    expect(createSdkPart(switched(), 'u3', [0, 0, 0], 0, { placed: true }).params.fpmUnits).toBe(false)
    // a part built in code keeps whenAbsent, whatever the scene says
    expect(createSdkPart(switched(), 'u4', [0, 0, 0], 0, { units: 'imperial' }).params.fpmUnits).toBe(false)
  })
  it('loads, keeps and repairs the field', () => {
    const ok = validateScene({ version: SCENE_VERSION, parts: [], units: 'metric' })
    expect(ok.ok && ok.scene.units).toBe('metric')
    const absent = validateScene({ version: SCENE_VERSION, parts: [] })
    expect(absent.ok && 'units' in absent.scene).toBe(false)
    const bad = validateScene({ version: SCENE_VERSION, parts: [], units: 'furlongs' })
    expect(bad.ok && bad.scene.units).toBe(undefined)
    expect(bad.ok && bad.repairs?.some((r) => r.includes('units'))).toBe(true)
  })
  it('loads, keeps and repairs the Length', () => {
    const ok = validateScene({ version: SCENE_VERSION, parts: [], units: 'imperial', lengthUnit: 'mm' })
    expect(ok.ok && [ok.scene.units, ok.scene.lengthUnit]).toEqual(['imperial', 'mm'])
    expect(ok.ok && ok.repairs).toBeFalsy()
    const bad = validateScene({ version: SCENE_VERSION, parts: [], lengthUnit: 'cubits' })
    expect(bad.ok && 'lengthUnit' in bad.scene).toBe(false)
    expect(bad.ok && bad.repairs?.some((r) => r.includes('lengthUnit'))).toBe(true)
  })
  it("reads the 'metric-mm' units one release saved as metric with a Length of mm, without a repair", () => {
    const old = validateScene({ version: SCENE_VERSION, parts: [], units: 'metric-mm' })
    expect(old.ok && [old.scene.units, old.scene.lengthUnit]).toEqual(['metric', 'mm'])
    expect(old.ok && old.repairs).toBeFalsy()
  })
})

describe('serializeScene carries the unit system', () => {
  it('round-trips through the scene file', () => {
    const back = validateScene(JSON.parse(serializeScene({ version: SCENE_VERSION, parts: [], units: 'metric', lengthUnit: 'in' })))
    expect(back.ok && [back.scene.units, back.scene.lengthUnit]).toEqual(['metric', 'in'])
  })
})
