// "Assign I/O" and "Import I/O list" over a scene (editor/program/ioAssign.ts): which parts follow their tag onto
// its new address, which are left alone, and what the report says happened.

import initJolt from 'jolt-physics'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { SCENE_VERSION } from '../../core/types'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PartInstance, SceneJSON, SdkPart } from '../../core/types'
import { buildPackage } from '../../sim/buildPackage'
import { assignIo, importIoList, ioListCsv, ioTargetFor, reportSummary } from './ioAssign'
import { DEFAULT_EXTERNAL_PLC } from '../store/storePrefs'
import { parseIoList } from '../../plc/ioAssign'

await initJolt()

const SENSOR = `
definePart({
  params: {
    enableComms: { type: 'boolean', default: true },
    tag: { type: 'tag', default: '', dir: 'out', stType: 'BOOL' },
  },
  step(ctx) {},
})
`

const MOTOR = `
definePart({
  params: {
    enableComms: { type: 'boolean', default: true },
    runTag: { type: 'tag', default: '', dir: 'in', stType: 'BOOL' },
    speedTag: { type: 'tag', default: '', dir: 'in', stType: 'REAL' },
  },
  step(ctx) {},
})
`

const BOX: PartPackage['geometry'] = {
  kind: 'rig',
  links: [{ name: 'base', shape: { kind: 'box', size: [0.2, 0.2, 0.2] }, offset: [0, 0, 0] }],
  joints: [],
}

function part(id: string, packageId: string, params: Record<string, unknown>, extra: Partial<PartInstance> = {}): PartInstance {
  return { id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params, ...extra } as SdkPart
}

const scene = (...parts: PartInstance[]): SceneJSON => ({ version: SCENE_VERSION, parts })
const params = (s: SceneJSON, id: string): Record<string, unknown> => (s.parts.find((p) => p.id === id) as SdkPart).params

const PROGRAM = `VAR
  Eye : BOOL;
  Run : BOOL;
END_VAR
Run := NOT Eye;`

describe('assigning I/O over a scene', () => {
  beforeAll(() => {
    registerPackage(buildPackage({ id: 'test.sensor', name: 'Sensor', commsParam: 'enableComms', geometry: BOX }, SENSOR), true)
    registerPackage(buildPackage({ id: 'test.motor', name: 'Motor', commsParam: 'enableComms', geometry: BOX }, MOTOR), true)
  })
  afterAll(() => {
    unregisterPackage('test.sensor')
    unregisterPackage('test.motor')
  })

  const wired = (): SceneJSON => scene(part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }), part('belt', 'test.motor', { enableComms: true, runTag: 'Run' }))

  it('wires each part to the address its tag was given, and declares it in the program', () => {
    const edit = assignIo(wired(), PROGRAM)
    expect(params(edit.scene!, 'eye').tag).toBe('%IX0.0')
    expect(params(edit.scene!, 'belt').runTag).toBe('%QX0.0')
    expect(edit.source).toContain('Eye AT %IX0.0 : BOOL;')
    expect(edit.source).toContain('Run AT %QX0.0 : BOOL;')
  })

  it('reports each tag with the number of parts now on it', () => {
    const three = scene(
      part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }),
      part('b1', 'test.motor', { enableComms: true, runTag: 'Run' }),
      part('b2', 'test.motor', { enableComms: true, runTag: 'Run' }),
    )
    const edit = assignIo(three, PROGRAM)
    expect(edit.report.assigned).toEqual([
      { name: 'Eye', address: '%IX0.0', parts: 1 },
      { name: 'Run', address: '%QX0.0', parts: 2 },
    ])
    expect(reportSummary(edit.report)).toBe('2 tags at an I/O address, 3 parts wired to them.')
  })

  it('leaves a part whose comms are off, and one already wired to an address', () => {
    const mixed = scene(
      part('off', 'test.sensor', { enableComms: false, tag: 'Eye' }),
      part('already', 'test.sensor', { enableComms: true, tag: '%IX7.0' }),
      part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }),
    )
    const edit = assignIo(mixed, PROGRAM)
    expect(params(edit.scene!, 'off').tag).toBe('Eye')
    expect(params(edit.scene!, 'already').tag).toBe('%IX7.0')
    expect(params(edit.scene!, 'eye').tag).toBe('%IX0.0')
  })

  it('rewires every part wired to the name, wherever it sits in the tree', () => {
    const grouped = scene(
      part('cell', 'test.sensor', { enableComms: true, tag: 'Eye' }, { parent: 'eye' } as Partial<PartInstance>),
      part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }),
    )
    const edit = assignIo(grouped, PROGRAM)
    expect(params(edit.scene!, 'cell').tag).toBe('%IX0.0')
    expect(params(edit.scene!, 'eye').tag).toBe('%IX0.0')
    expect(reportSummary(edit.report)).toMatch(/2 parts wired to it\.$/)
  })

  it('gives an analog tag a double word, which a REAL travels in', () => {
    const real = scene(part('belt', 'test.motor', { enableComms: true, speedTag: 'Speed' }))
    const edit = assignIo(real, 'VAR\n  Speed : REAL;\nEND_VAR')
    expect(params(edit.scene!, 'belt').speedTag).toBe('%QD50')
    expect(edit.source).toContain('Speed AT %QD50 : REAL;')
  })

  it('reports a tag it will not touch, and leaves the parts on the name', () => {
    const odd = scene(part('eye', 'test.sensor', { enableComms: true, tag: 'Level' }))
    const edit = assignIo(odd, 'VAR\n  Level : STRING;\nEND_VAR')
    expect(edit.scene).toBeNull()
    expect(edit.report.skipped[0]?.reason).toMatch(/only a single bit or number/)
    expect(reportSummary(edit.report)).toBe('No tag was given an address. 1 left as it was.')
  })

  it('changes nothing when every part is already on an address', () => {
    const done = scene(part('eye', 'test.sensor', { enableComms: true, tag: '%IX0.0' }))
    const edit = assignIo(done, 'VAR\n  Eye AT %IX0.0 : BOOL;\nEND_VAR')
    expect(edit.scene).toBeNull()
    expect(edit.source).toBe('VAR\n  Eye AT %IX0.0 : BOOL;\nEND_VAR')
    expect(edit.report.assigned).toEqual([{ name: 'Eye', address: '%IX0.0', parts: 1 }])
  })

  it('runs again over a scene that grew, without touching what was already assigned', () => {
    const first = assignIo(wired(), PROGRAM)
    const grown = { ...first.scene!, parts: [...first.scene!.parts, part('eye2', 'test.sensor', { enableComms: true, tag: 'Eye2' })] }
    const second = assignIo(grown, first.source)
    expect(params(second.scene!, 'eye').tag).toBe('%IX0.0')
    expect(params(second.scene!, 'eye2').tag).toBe('%IX0.1')
    expect(second.source.match(/END_VAR/g)).toHaveLength(1)
  })
})

describe('importing an I/O list over a scene', () => {
  beforeAll(() => {
    registerPackage(buildPackage({ id: 'test.sensor', name: 'Sensor', commsParam: 'enableComms', geometry: BOX }, SENSOR), true)
    registerPackage(buildPackage({ id: 'test.motor', name: 'Motor', commsParam: 'enableComms', geometry: BOX }, MOTOR), true)
  })
  afterAll(() => {
    unregisterPackage('test.sensor')
    unregisterPackage('test.motor')
  })

  it("takes the engineer's addresses and wires the parts to them", () => {
    const s = scene(part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }), part('belt', 'test.motor', { enableComms: true, runTag: 'Run' }))
    const edit = importIoList(s, PROGRAM, 'Tag,Address,Description\nEye,%IX3.2,photo eye\nRun,%QX4.0,belt motor\n')
    expect(params(edit.scene!, 'eye').tag).toBe('%IX3.2')
    expect(params(edit.scene!, 'belt').runTag).toBe('%QX4.0')
    expect(edit.source).toContain('Eye AT %IX3.2 : BOOL;')
  })

  it('moves the parts when the list moves a tag that already had an address', () => {
    const s = scene(part('eye', 'test.sensor', { enableComms: true, tag: '%IX100.0' }))
    const edit = importIoList(s, 'VAR\n  Eye AT %IX100.0 : BOOL;\nEND_VAR', 'Eye,%IX3.2')
    expect(params(edit.scene!, 'eye').tag).toBe('%IX3.2')
    expect(edit.source).toContain('Eye AT %IX3.2 : BOOL;')
  })

  it('reports the rows it could not read beside the ones it refused', () => {
    const s = scene(part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }))
    const edit = importIoList(s, PROGRAM, 'Tag,Address\nEye,%IX3.2\nBroken\nPump,%QX9.0\n')
    expect(edit.report.assigned).toEqual([{ name: 'Eye', address: '%IX3.2', parts: 1 }])
    expect(edit.report.skipped.map((s2) => s2.reason)).toEqual([
      'line 3: no IEC address (like %IX100.0) on this row',
      'line 4: neither the program nor any part in the scene uses Pump',
    ])
  })
})

// The I/O list going out: the document a panel builder works from, and the one this app reads back.
describe('exporting the I/O list', () => {
  beforeAll(() => {
    registerPackage(buildPackage({ id: 'test.sensor', name: 'Sensor', commsParam: 'enableComms', geometry: BOX }, SENSOR), true)
    registerPackage(buildPackage({ id: 'test.motor', name: 'Motor', commsParam: 'enableComms', geometry: BOX }, MOTOR), true)
  })
  afterAll(() => {
    unregisterPackage('test.sensor')
    unregisterPackage('test.motor')
  })

  const assigned = (): { scene: SceneJSON; source: string } => {
    const edit = assignIo(
      scene(
        part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }, { name: 'Entry eye' }),
        part('belt', 'test.motor', { enableComms: true, runTag: 'Run', speedTag: 'Speed' }, { name: 'Infeed' }),
      ),
      'VAR\n  Eye : BOOL;\n  Run : BOOL;\n  Speed : REAL;\nEND_VAR',
    )
    return { scene: edit.scene!, source: edit.source }
  }

  it('lists every point with the name, the address and what it is', () => {
    const { scene: s, source } = assigned()
    const lines = ioListCsv(s, source).trim().split('\n')
    expect(lines[0]).toBe('Tag,Address,Type,Direction,Modbus point,Device')
    expect(lines).toContain('Eye,%IX0.0,BOOL,PLC input,discrete input 0,Entry eye.tag')
    expect(lines).toContain('Run,%QX0.0,BOOL,PLC output,coil 0,Infeed.runTag')
    expect(lines).toContain('Speed,%QD50,REAL,PLC output,holding registers 100-101,Infeed.speedTag')
  })

  it('reads its own output back with nothing to change and nothing refused', () => {
    const { scene: s, source } = assigned()
    const back = importIoList(s, source, ioListCsv(s, source, 'Line 1'))
    expect(back.report.skipped).toEqual([])
    expect(back.scene).toBeNull() // every part is already on the address the list gives
    expect(back.source).toBe(source)
  })

  it('names the parts that share a point, and quotes a cell that needs it', () => {
    const shared = scene(
      part('b1', 'test.motor', { enableComms: true, runTag: '%QX0.0' }, { name: 'Belt, upper' }),
      part('b2', 'test.motor', { enableComms: true, runTag: '%QX0.0' }, { name: 'Belt 2' }),
    )
    const row = ioListCsv(shared, 'VAR\n  Run AT %QX0.0 : BOOL;\nEND_VAR').trim().split('\n')[1]!
    expect(row).toBe('Run,%QX0.0,BOOL,PLC output,coil 0,"Belt, upper.runTag + Belt 2.runTag"')
  })

  it('leaves the Tag blank when the program declares nothing at that address', () => {
    const bare = scene(part('eye', 'test.sensor', { enableComms: true, tag: '%IX0.0' }, { name: 'Eye' }))
    expect(ioListCsv(bare, '').trim().split('\n')[1]).toBe(',%IX0.0,BOOL,PLC input,discrete input 0,Eye.tag')
  })

  it('says so rather than handing over an empty file', () => {
    const named = scene(part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }))
    const csv = ioListCsv(named, 'VAR\n  Eye : BOOL;\nEND_VAR')
    expect(csv).toContain('# no part is wired to an I/O address yet')
    expect(parseIoList(csv).rows).toEqual([]) // and it is still a list, not an error
  })
})

describe('I/O for a PLC that serves its process image (the dock\'s "the simulator polls the PLC")', () => {
  beforeAll(() => {
    registerPackage(buildPackage({ id: 'test.sensor', name: 'Sensor', commsParam: 'enableComms', geometry: BOX }, SENSOR), true)
    registerPackage(buildPackage({ id: 'test.motor', name: 'Motor', commsParam: 'enableComms', geometry: BOX }, MOTOR), true)
  })
  afterAll(() => {
    unregisterPackage('test.sensor')
    unregisterPackage('test.motor')
  })

  const settings = { ...DEFAULT_EXTERNAL_PLC, mode: 'poll' as const }
  const assigned = (): { scene: SceneJSON; source: string } => {
    const edit = assignIo(
      scene(
        part('eye', 'test.sensor', { enableComms: true, tag: 'Eye' }, { name: 'Entry eye' }),
        part('belt', 'test.motor', { enableComms: true, runTag: 'Run', speedTag: 'Speed' }, { name: 'Infeed' }),
      ),
      'VAR\n  Eye : BOOL;\n  Run : BOOL;\n  Speed : REAL;\nEND_VAR',
      ioTargetFor(settings),
    )
    return { scene: edit.scene!, source: edit.source }
  }

  it("packs the points from the server device's first register", () => {
    const { scene: s, source } = assigned()
    expect(params(s, 'eye').tag).toBe('%IX0.0')
    expect(params(s, 'belt').runTag).toBe('%QX0.0')
    // the run bit holds output word 0, so the speed takes the next even pair
    expect(params(s, 'belt').speedTag).toBe('%QD1')
    expect(source).toContain('Speed AT %QD1 : REAL;')
    // the target follows the mode, and where the device sits
    expect(ioTargetFor(DEFAULT_EXTERNAL_PLC)).toEqual({ kind: 'modbus-server' })
    expect(ioTargetFor({ ...settings, inputBase: 4, outputBase: 8 })).toEqual({ kind: 'register-image', base: { input: 4, output: 8 } })
  })

  it('exports the registers the simulator will poll, and reads them back unchanged', () => {
    const { scene: s, source } = assigned()
    const csv = ioListCsv(s, source, '', settings)
    const lines = csv.trim().split('\n')
    expect(lines).toContain('Eye,%IX0.0,BOOL,PLC input,holding register 0 bit 0,Entry eye.tag')
    expect(lines).toContain('Run,%QX0.0,BOOL,PLC output,input register 0 bit 0,Infeed.runTag')
    expect(lines).toContain('Speed,%QD1,REAL,PLC output,input registers 2-3,Infeed.speedTag')
    const back = importIoList(s, source, csv, ioTargetFor(settings))
    expect(back.report.skipped).toEqual([])
    expect(back.scene).toBeNull()
  })
})
