import { describe, expect, it } from 'vitest'
import { isRealRange, labelHead, numberLabelUnit, schemaToParamSpecs, switchValue, visibleWhenHolds } from './packageParams'
import type { ParamSchema } from './parts/partApi'
import type { ColorParamSpec, EnumParamSpec, NumberParamSpec } from './types'

// The SDK->editor param bridge. Focus: the `'enum'` type added for shape-preset pickers (a belt's shapePreset
// stamping segments) - the rest of the pipeline is exercised by sdkPart.test.ts / bundledPackageData.test.ts.

describe('schemaToParamSpecs - enum params', () => {
  const schema: ParamSchema = {
    shapePreset: {
      type: 'enum',
      default: 'straight',
      label: 'Shape preset',
      stamps: 'segments',
      options: [
        { value: 'straight', label: 'Straight', rows: [[4, 0]] },
        { value: 'zframe', label: 'Z-Frame', rows: [[2, 0], [3, 12], [2, -12]] },
        { value: 'custom', label: 'Custom' },
      ],
    },
    segments: { type: 'numberList', arity: 2, default: [[4, 0]] },
  }

  const enumSpec = (): EnumParamSpec => {
    const spec = schemaToParamSpecs(schema).find((s) => s.key === 'shapePreset')
    if (!spec || spec.kind !== 'enum') throw new Error('expected an enum spec')
    return spec
  }

  it('maps type:"enum" to an editor EnumParamSpec with options, default, and stamps', () => {
    const spec = enumSpec()
    expect(spec.default).toBe('straight')
    expect(spec.stamps).toBe('segments')
    expect(spec.options.map((o) => o.value)).toEqual(['straight', 'zframe', 'custom'])
    expect(spec.options.map((o) => o.label)).toEqual(['Straight', 'Z-Frame', 'Custom'])
  })

  it('carries per-option template rows (deep-copied), and the row-less "custom" escape has none', () => {
    const spec = enumSpec()
    expect(spec.options[0]!.rows).toEqual([[4, 0]])
    expect(spec.options[1]!.rows).toEqual([[2, 0], [3, 12], [2, -12]])
    expect(spec.options[2]!.rows).toBeUndefined()
    // deep copy - mutating the emitted rows must not reach back into another instance's schema
    spec.options[0]!.rows![0]![0] = 99
    expect(enumSpec().options[0]!.rows).toEqual([[4, 0]])
  })

  it('falls back to the first option when default is not a listed value', () => {
    const spec = schemaToParamSpecs({
      mode: { type: 'enum', default: 'nope', options: [{ value: 'a' }, { value: 'b' }] },
    })[0] as EnumParamSpec
    expect(spec.default).toBe('a')
    expect(spec.options[0]!.label).toBe('a') // label defaults to value
  })
})

describe('schemaToParamSpecs - color params', () => {
  const colorSpec = (schema: ParamSchema): ColorParamSpec => {
    const spec = schemaToParamSpecs(schema)[0]
    if (!spec || spec.kind !== 'color') throw new Error('expected a color spec')
    return spec
  }

  it('maps type:"color" to an opaque-only ColorParamSpec by default (no alpha channel)', () => {
    // without alpha the picker stays #rrggbb and the scene normalizer strips any 8-digit value
    expect(colorSpec({ tint: { type: 'color', default: '#f2b705', label: 'Tint' } }).alpha).toBeUndefined()
  })

  it('carries alpha:true through so the picker exposes an A slider and #rrggbbaa survives normalization', () => {
    // the floor marking's transparent-band cutout depends on this: alpha off ⇒ isHexColor rejects #rrggbbaa
    expect(colorSpec({ tint: { type: 'color', default: '#1a1a1a', label: 'Tint', alpha: true } }).alpha).toBe(true)
  })
})

describe('schemaToParamSpecs - number params', () => {
  it('carries `rest` onto a host-resolved number spec (so load skips its max clamp) and omits it otherwise', () => {
    const specs = schemaToParamSpecs({
      standHeight: { type: 'number', default: 2, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height' },
      speed: { type: 'number', default: 1, min: -3, max: 3, step: 0.1 },
    })
    const byKey = Object.fromEntries(specs.map((s) => [s.key, s]))
    expect(byKey.standHeight!.kind).toBe('number')
    expect((byKey.standHeight as NumberParamSpec).rest).toBe('surfaceBelow')
    expect((byKey.speed as NumberParamSpec).rest).toBeUndefined()
  })
})

describe('schemaToParamSpecs - Inspector groups', () => {
  it('carries `group` onto every param kind, and omits it when unset', () => {
    const specs = schemaToParamSpecs({
      speed: { type: 'number', default: 1 },
      enabled: { type: 'boolean', default: true, group: 'Comms' },
      tag: { type: 'tag', default: '', group: 'Comms' },
      openings: { type: 'numberList', arity: 3, default: [], group: 'Legs/Middle Legs' },
    })
    const byKey = Object.fromEntries(specs.map((s) => [s.key, s]))
    expect(byKey.speed!.group).toBeUndefined()
    expect(byKey.enabled!.group).toBe('Comms')
    expect(byKey.tag!.group).toBe('Comms')
    expect(byKey.openings!.group).toBe('Legs/Middle Legs') // nested section preserved verbatim
  })
})

describe('schemaToParamSpecs - param descriptions', () => {
  it('carries `desc` onto every param kind, and omits it when unset or blank', () => {
    const specs = schemaToParamSpecs({
      speed: { type: 'number', default: 1, desc: 'Belt surface speed. Negative runs it backwards.' },
      enabled: { type: 'boolean', default: true, desc: 'Expose this part to the PLC.' },
      tag: { type: 'tag', default: '', desc: 'Run command from the program.' },
      tint: { type: 'color', default: '#ffffff', desc: 'Fabric tint.' },
      style: { type: 'enum', default: 'a', options: [{ value: 'a' }], desc: 'Which pattern is painted.' },
      poses: { type: 'numberList', arity: 3, default: [], desc: 'Taught waypoints.' },
      note: { type: 'string', default: '', desc: 'Face label.' },
      target: { type: 'partRef', default: '', desc: 'The conveyor this interlocks with.' },
      plain: { type: 'number', default: 0 },
      blank: { type: 'number', default: 0, desc: '' },
    })
    const byKey = Object.fromEntries(specs.map((s) => [s.key, s]))
    expect(byKey.speed!.desc).toBe('Belt surface speed. Negative runs it backwards.')
    expect(byKey.enabled!.desc).toBe('Expose this part to the PLC.')
    expect(byKey.tag!.desc).toBe('Run command from the program.')
    expect(byKey.tint!.desc).toBe('Fabric tint.')
    expect(byKey.style!.desc).toBe('Which pattern is painted.')
    expect(byKey.poses!.desc).toBe('Taught waypoints.')
    expect(byKey.note!.desc).toBe('Face label.')
    expect(byKey.target!.desc).toBe('The conveyor this interlocks with.')
    // an absent or empty desc leaves the field off entirely, so the Inspector falls through to its own table
    expect(byKey.plain!.desc).toBeUndefined()
    expect(byKey.blank!.desc).toBeUndefined()
  })
})

// A switch that changes what existing numbers mean (a conveyor's speed tag from m/s to feet per minute), and the two
// fields it chooses between: ParamSpec.whenAbsent and ParamSpec.visibleWhen. Both are presentation / defaulting
// facts that have to pass through the bridge, or the Inspector and the scene loader never receive them.
describe('schemaToParamSpecs - a switch between two ways of saying one thing', () => {
  const schema: ParamSchema = {
    fpmUnits: { type: 'boolean', default: true, whenAbsent: false, label: 'Speeds in FPM' },
    speed: { type: 'number', default: 2, label: 'Speed (m/s)', visibleWhen: { param: 'fpmUnits', is: false } },
    speedFpm: { type: 'number', default: 394, label: 'Speed (FPM)', visibleWhen: { param: 'fpmUnits', is: true } },
    speedFpmTag: { type: 'tag', dir: 'in', stType: 'DINT', default: '', label: 'Speed tag' },
  }
  it('carries whenAbsent, visibleWhen and a DINT tag type across', () => {
    const [sw, ms, fpm, tag] = schemaToParamSpecs(schema)
    expect(sw).toMatchObject({ kind: 'boolean', default: true, whenAbsent: false })
    expect(ms!.visibleWhen).toEqual({ param: 'fpmUnits', is: false })
    expect(fpm!.visibleWhen).toEqual({ param: 'fpmUnits', is: true })
    expect(tag).toMatchObject({ kind: 'tagRef', stType: 'DINT', dir: 'in' })
  })
  it('a part whose saved params lack the key resolves to whenAbsent; one that carries it, to what it carries', async () => {
    const { resolvePartParams } = await import('./parts/partScript')
    expect(resolvePartParams(schema, {}).fpmUnits).toBe(false) // written before the switch existed
    expect(resolvePartParams(schema, { fpmUnits: true }).fpmUnits).toBe(true)
    expect(resolvePartParams(schema, {}).speedFpm).toBe(394) // (an ordinary param still takes its default)
  })
})

// A tag's unit is the unit of the value on the wire. A setpoint tag carries its param's value, so it is in that
// param's unit unless it says otherwise (TagRefParamSpec.unit).
describe('schemaToParamSpecs - the unit a tag carries', () => {
  const schema: ParamSchema = {
    speed: { type: 'number', default: 2, unit: 'm/s', label: 'Speed' },
    speedTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '', setpointFor: 'speed', label: 'Speed tag' },
    distanceTag: { type: 'tag', dir: 'out', stType: 'REAL', default: '', unit: 'm', label: 'Distance tag' },
    rateTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '', setpointFor: 'speed', unit: 'FPM', label: 'Rate tag' },
    runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Run tag' },
  }
  const byKey = (key: string): Record<string, unknown> => schemaToParamSpecs(schema).find((s) => s.key === key) as unknown as Record<string, unknown>
  it("carries a declared unit, and gives a setpoint tag that declares none its param's", () => {
    expect(byKey('distanceTag').unit).toBe('m')
    expect(byKey('speedTag').unit).toBe('m/s')
    expect(byKey('rateTag').unit).toBe('FPM') // a declared unit wins over the param's
    expect(byKey('runTag').unit).toBeUndefined()
  })
})

// A part with modes (the gantry: waypoints / position / follow): an enum switch, and fields some modes share.
describe('visibleWhen on an enum switch', () => {
  const schema: ParamSchema = {
    mode: { type: 'enum', default: 'waypoints', label: 'Mode', options: [{ value: 'waypoints', label: 'W' }, { value: 'position', label: 'P' }, { value: 'follow', label: 'F' }] },
    commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: '', visibleWhen: { param: 'mode', is: 'waypoints' } },
    targetTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '', visibleWhen: { param: 'mode', is: ['position', 'follow'] } },
  }
  const specs = schemaToParamSpecs(schema)
  const shown = (params: Record<string, unknown>) =>
    specs.filter((s) => visibleWhenHolds(s.visibleWhen, s.visibleWhen && switchValue(specs, params, s.visibleWhen.param))).map((s) => s.key)

  it('carries a value and a list across the bridge', () => {
    expect(specs.find((s) => s.key === 'commandTag')!.visibleWhen).toEqual({ param: 'mode', is: 'waypoints' })
    expect(specs.find((s) => s.key === 'targetTag')!.visibleWhen).toEqual({ param: 'mode', is: ['position', 'follow'] })
  })
  it('shows a field while the switch holds its value, or any value of its list; an absent value reads the default', () => {
    expect(shown({})).toEqual(['mode', 'commandTag'])
    expect(shown({ mode: 'position' })).toEqual(['mode', 'targetTag'])
    expect(shown({ mode: 'follow' })).toEqual(['mode', 'targetTag'])
  })
  it('a boolean is never an enum value, and a malformed is is dropped rather than half-read', () => {
    expect(visibleWhenHolds({ param: 'mode', is: ['true'] }, true)).toBe(false)
    expect(visibleWhenHolds({ param: 'mode', is: true }, 'true')).toBe(false)
    const [bad] = schemaToParamSpecs({ x: { type: 'number', default: 1, visibleWhen: { param: 'mode', is: [] as string[] } } })
    expect(bad!.visibleWhen).toBeUndefined()
  })
})

describe('number params - unit and range', () => {
  it('reads a unit off the end of the label, once', () => {
    expect(numberLabelUnit('Width (m)', undefined)).toEqual({ label: 'Width', unit: 'm' })
    expect(numberLabelUnit('Speed at 30 revolutions (FPM)', undefined)).toEqual({ label: 'Speed at 30 revolutions', unit: 'FPM' })
    // a parenthetical that says more than a unit stays in the label
    expect(numberLabelUnit('Speed (m/s, − reverses)', undefined)).toEqual({ label: 'Speed (m/s, − reverses)', unit: '' })
    expect(numberLabelUnit('Posts', undefined)).toEqual({ label: 'Posts', unit: '' })
  })

  it("a row shows a label without the bracket explaining it, keeping a unit it starts with", () => {
    expect(labelHead('Run tag (rollers run while true)')).toBe('Run tag')
    expect(labelHead('Normally closed (inverts the signal)')).toBe('Normally closed')
    expect(labelHead('Command tag (0 = home, 1+ = waypoint)')).toBe('Command tag')
    expect(labelHead('Speed tag (m/s)')).toBe('Speed tag (m/s)')
    expect(labelHead('Speed tag (FPM)')).toBe('Speed tag (FPM)')
    expect(labelHead('Throughput rate tag (per min)')).toBe('Throughput rate tag (per min)')
    expect(labelHead('Actual Z tag (m, down)')).toBe('Actual Z tag (m)')
    expect(labelHead('Speed (m/s, − reverses)')).toBe('Speed (m/s)')
    expect(labelHead('Encoder tag (travel, m)')).toBe('Encoder tag')
    // only a trailing bracket: one inside the label is part of its name
    expect(labelHead('Move to X/Y/Z (gantry) slowly')).toBe('Move to X/Y/Z (gantry) slowly')
    expect(labelHead('Posts')).toBe('Posts')
  })

  it('a declared unit wins, and cuts only a matching label unit', () => {
    expect(numberLabelUnit('Width (m)', 'm')).toEqual({ label: 'Width', unit: 'm' })
    expect(numberLabelUnit('Width (m)', 'mm')).toEqual({ label: 'Width (m)', unit: 'mm' })
    expect(schemaToParamSpecs({ w: { type: 'number', default: 1, label: 'Width', unit: 'm' } })[0]).toMatchObject({ label: 'Width', unit: 'm' })
    expect(schemaToParamSpecs({ w: { type: 'number', default: 1, label: 'Width (m)' } })[0]).toMatchObject({ label: 'Width', unit: 'm' })
  })

  it('only a chosen range is a range: a missing bound (the ±1e6 stand-in) is not', () => {
    const [open] = schemaToParamSpecs({ length: { type: 'number', default: 4, min: 0.5 } }) as NumberParamSpec[]
    expect(isRealRange(open!.min, open!.max)).toBe(false)
    expect(isRealRange(0.2, 3)).toBe(true)
    expect(isRealRange(0, Infinity)).toBe(false)
    expect(isRealRange(undefined, 3)).toBe(false)
    expect(isRealRange(3, 3)).toBe(false)
  })
})
