import { describe, expect, it } from 'vitest'
import { declaredTags, programTagChoices, rankTagNames, tagMisfit } from './tagSuggest'
import { buildSections } from './tagField'
import type { TagSources } from './tagField'
import type { TagRow } from '../../../plc/tags'
import { plcTagListOf, readAdsTagList, readEipTagList, readOpcUaTagList } from '../../links/externalPlc'
import type { AdsHost, EipHost, OpcUaHost } from '../../links/externalPlc'

describe('ranking a tag field\'s suggestions', () => {
  const names = ['Sorter.Motor', 'Sorter.MotorFault', 'Packer.Motor', 'Line2.ConveyorMotor', 'MotorSpeed', 'Sorter.Eye']

  it('puts the name itself first, then a last segment that starts with it, then a contained one', () => {
    expect(rankTagNames('motor', names, 10).shown).toEqual(['MotorSpeed', 'Packer.Motor', 'Sorter.Motor', 'Sorter.MotorFault', 'Line2.ConveyorMotor'])
    expect(rankTagNames('Packer.Motor', names, 10).shown[0]).toBe('Packer.Motor')
  })

  it('shows at most the limit and says how many more fit', () => {
    expect(rankTagNames('motor', names, 2)).toEqual({ shown: ['MotorSpeed', 'Packer.Motor'], more: 3 })
    expect(rankTagNames('', names, 2)).toEqual({ shown: names.slice(0, 2), more: 4 })
    expect(rankTagNames('zzz', names, 2)).toEqual({ shown: [], more: 0 })
  })
})

const row = (name: string, type: string, extra: Partial<TagRow> = {}): TagRow => ({ name, type, section: 'VAR', scope: { kind: 'controller' }, description: '', init: '', constant: false, offset: 0, ...extra })

describe('the program\'s tags a field offers', () => {
  const rows = [row('Start', 'BOOL'), row('Speed', 'REAL'), row('Limit', 'REAL', { constant: true }), row('Timer1', 'TON'), row('Local', 'BOOL', { scope: { kind: 'pou', name: 'Fb' } })]
  it('offers controller-scope variables of the field\'s type', () => {
    expect(programTagChoices(declaredTags(rows), 'BOOL')).toEqual([{ name: 'Start', type: 'BOOL' }])
    expect(programTagChoices(declaredTags(rows), 'REAL')).toEqual([{ name: 'Speed', type: 'REAL' }])
  })
  it('offers any bit or number when the field declares no type, never a block', () => {
    expect(programTagChoices(declaredTags(rows), undefined).map((c) => c.name)).toEqual(['Start', 'Speed'])
  })
  it('carries how each one is declared', () => {
    expect(declaredTags([row('Eye', 'BOOL', { section: 'VAR_INPUT' }), row('Run', 'BOOL', { section: 'VAR_OUTPUT' }), row('Flag', 'BOOL')])).toEqual([
      { name: 'Eye', type: 'BOOL', dir: 'in' },
      { name: 'Run', type: 'BOOL', dir: 'out' },
      { name: 'Flag', type: 'BOOL' },
    ])
  })
})

describe('which program variables would leave a field unconnected', () => {
  const none = new Set<string>()
  it('a field the part reads misses an input, and an undirected tag another part writes', () => {
    expect(tagMisfit({ name: 'Eye', type: 'BOOL', dir: 'in' }, 'in', none)).toBe('input')
    expect(tagMisfit({ name: 'Run', type: 'BOOL', dir: 'out' }, 'in', none)).toBeNull()
    expect(tagMisfit({ name: 'Flag', type: 'BOOL' }, 'in', none)).toBeNull()
    expect(tagMisfit({ name: 'Flag', type: 'BOOL' }, 'in', new Set(['Flag']))).toBe('written')
  })
  it('a field the part writes misses an output', () => {
    expect(tagMisfit({ name: 'Run', type: 'BOOL', dir: 'out' }, 'out', none)).toBe('output')
    expect(tagMisfit({ name: 'Eye', type: 'BOOL', dir: 'in' }, 'out', none)).toBeNull()
    expect(tagMisfit({ name: 'Flag', type: 'BOOL' }, 'out', new Set(['Flag']))).toBeNull()
  })
})

describe('the sections of the list', () => {
  const variables = [
    { path: ['PLC1', 'MAIN', 'Motor'], nodeId: 'a' },
    { path: ['PLC1', 'MAIN', 'Eye'], nodeId: 'b' },
  ]
  const sources = (over: Partial<TagSources> = {}): TagSources => ({ check: { source: '', dialect: undefined, controller: null, scanMs: 10 }, plc: null, canReadPlc: true, readPlc: () => {}, plcLinked: true, external: true, controllers: [], ...over })

  const program = [{ name: 'Motor1', type: 'BOOL' }, { name: 'Start', type: 'BOOL' }, { name: 'Speed', type: 'REAL' }]

  it("lists the program's tags of the field's type with their uses, and no name the program lacks", () => {
    const s = buildSections('', new Map([['Motor1', 2], ['Motr', 1], ['Speed', 1]]), program, 'BOOL', sources({ plcLinked: false }))
    expect(s.map((x) => x.id)).toEqual(['program'])
    expect(s[0]!.rows).toEqual([
      { kind: 'name', name: 'Motor1', detail: 'BOOL', uses: 2 },
      { kind: 'name', name: 'Start', detail: 'BOOL', uses: 0 },
    ])
  })

  it('offers to read the PLC\'s tags before any have been read', () => {
    const s = buildSections('', new Map(), [], undefined, sources())
    expect(s).toHaveLength(1)
    expect(s[0]!.rows).toEqual([{ kind: 'action', label: 'Read the PLC\'s tags', run: expect.any(Function) }])
  })

  it('lists the PLC\'s tags only once something is typed', () => {
    const plc = plcTagListOf('opc.tcp://plc:4840', [], { variables, truncated: false })
    const idle = buildSections('', new Map(), [], undefined, sources({ plc }))
    expect(idle[0]!.title).toBe('On the PLC (2 tags)')
    expect(idle[0]!.rows.filter((r) => r.kind === 'name')).toEqual([])
    expect(idle[0]!.notes).toEqual(['Type to search them.'])
    const typed = buildSections('mot', new Map(), [], undefined, sources({ plc }))
    expect(typed[0]!.rows.filter((r) => r.kind === 'name')).toEqual([{ kind: 'name', name: 'Motor' }])
  })

  it('says when the PLC holds more than was read', () => {
    const plc = plcTagListOf('opc.tcp://plc:4840', [], { variables, truncated: true })
    expect(buildSections('e', new Map(), [], undefined, sources({ plc, canReadPlc: false }))[0]!.notes).toEqual([expect.stringContaining('more tags than were read')])
  })

  it('says to stop the scene to read an ADS PLC, which a run does not browse', () => {
    expect(buildSections('', new Map(), [], undefined, sources({ plcProtocol: 'ads', canReadPlc: false }))[0]!.notes).toEqual(["Stop the scene to read the PLC's tags."])
  })

  it('says the same for an EtherNet/IP controller', () => {
    expect(buildSections('', new Map(), [], undefined, sources({ plcProtocol: 'eip', canReadPlc: false }))[0]!.notes).toEqual(["Stop the scene to read the PLC's tags."])
  })

  it('leaves the PLC out when the link does not list its tags', () => {
    expect(buildSections('', new Map(), [], undefined, sources({ plcLinked: false }))).toEqual([])
  })

  it('lists the variables that connect first, then the others with why not', () => {
    const io = [{ name: 'Eye', type: 'BOOL', dir: 'in' as const }, { name: 'Run', type: 'BOOL', dir: 'out' as const }, { name: 'Flag', type: 'BOOL' }]
    const reads = buildSections('', new Map(), io, 'BOOL', sources({ plcLinked: false, external: false }), 'in', new Set(['Flag']))[0]!.rows
    expect(reads.map((r) => (r.kind === 'name' ? [r.name, r.misfit?.note ?? ''] : []))).toEqual([
      ['Run', ''],
      ['Eye', 'program reads it'],
      ['Flag', 'another part writes it'],
    ])
    const writes = buildSections('', new Map(), io, 'BOOL', sources({ plcLinked: false, external: false }), 'out')[0]!.rows
    expect(writes.map((r) => (r.kind === 'name' ? r.name : ''))).toEqual(['Eye', 'Flag', 'Run'])
  })

  it('says why there is nothing to pick', () => {
    const notes = (program: { name: string; type: string }[] | null, src: string, query = '') =>
      buildSections(query, new Map(), program, 'BOOL', sources({ plcLinked: false, external: false, check: { source: src, dialect: undefined, controller: null, scanMs: 10 } }))[0]?.notes
    expect(notes([], '')).toEqual(['No program yet. Type a name, then declare it in the program.'])
    expect(notes([{ name: 'Speed', type: 'REAL' }], 'x')).toEqual(['The program declares no BOOL variables yet. Type a name, then declare it in the program.'])
    expect(notes([{ name: 'Run', type: 'BOOL' }], 'x', 'zz')).toEqual(['Nothing in the program fits. A new name connects once the program declares it.'])
    // still loading: no note that would claim the program has nothing
    expect(notes(null, 'x')).toBeUndefined()
    // an external PLC's tags are the ones wired to: an empty program is no gap
    expect(buildSections('', new Map(), [], 'BOOL', sources({ plcLinked: false }))).toEqual([])
  })
})

describe('reading the PLC\'s tags while stopped', () => {
  const host = (over: Partial<OpcUaHost> = {}): OpcUaHost & { closed: number } => {
    const h = {
      closed: 0,
      connect: async () => ({ error: '' }),
      browse: async () => ({ error: '', variables: [{ path: ['PLC1', 'MAIN', 'Eye'], nodeId: 'e' }], truncated: false }),
      describe: async () => ({ error: '', nodes: [] }),
      exchange: async () => ({ error: '' }),
      close: async () => {
        h.closed++
      },
      onClosed: () => () => {},
      ...over,
    }
    return h
  }

  it('connects, browses and lets go', async () => {
    const h = host()
    const list = await readOpcUaTagList(h, 'opc.tcp://plc:4840', [], () => true)
    expect(list).toMatchObject({ state: 'ready', names: ['Eye'], truncated: false })
    expect(h.closed).toBe(1)
  })

  it('never closes a link a run has taken over meanwhile', async () => {
    const h = host()
    await readOpcUaTagList(h, 'opc.tcp://plc:4840', [], () => false)
    expect(h.closed).toBe(0)
  })

  it('says why it could not read', async () => {
    expect(await readOpcUaTagList(host({ connect: async () => ({ error: 'refused' }) }), 'opc.tcp://plc:4840', [], () => true)).toMatchObject({ state: 'failed', error: 'refused' })
    const lds = await readOpcUaTagList(host({ connect: async () => ({ error: '', discovery: [] }) }), 'opc.tcp://pc:4840', [], () => true)
    expect(lds.error).toMatch(/discovery server/)
  })
})

describe('reading an ADS PLC\'s tags while stopped', () => {
  const host = (over: Partial<AdsHost> = {}): AdsHost & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      open: async (o) => (calls.push(`open ${o.netId}:${o.port}`), { error: '', localNetId: '10.0.0.5.1.1' }),
      bind: async () => ({ error: '' }),
      exchange: async () => ({ error: '' }),
      symbols: async () => (calls.push('symbols'), { error: '', code: 0, symbols: [{ name: 'MAIN.Extend', adsType: 33, size: 1, typeName: 'BOOL' }, { name: 'MAIN.tCycle', adsType: 65, size: 32, typeName: 'TON' }] }),
      close: async () => void calls.push('close'),
      ...over,
    }
  }

  it('opens, lists the symbol table and lets go', async () => {
    const h = host()
    const list = await readAdsTagList(h, '5.1.2.3.1.1', 851, () => true)
    expect(list).toMatchObject({ protocol: 'ads', state: 'ready', names: ['MAIN.Extend'], endpoint: '5.1.2.3.1.1, AMS port 851' })
    expect(h.calls).toEqual(['open 5.1.2.3.1.1:851', 'symbols', 'close'])
  })

  it('never closes a link a run has taken over meanwhile', async () => {
    const h = host()
    await readAdsTagList(h, '', 851, () => false)
    expect(h.calls).not.toContain('close')
  })

  it('says why it could not read, naming this PC where a route is missing', async () => {
    expect(await readAdsTagList(host({ open: async () => ({ error: 'no router' }) }), '', 851, () => true)).toMatchObject({ state: 'failed', error: 'no router' })
    const route = await readAdsTagList(host({ symbols: async () => ({ error: '', code: 0x7 }) }), '5.1.2.3.1.1', 851, () => true)
    expect(route.error).toMatch(/This PC's AMS Net ID is 10\.0\.0\.5\.1\.1$/)
    const old = host()
    delete old.symbols
    expect(await readAdsTagList(old, '', 851, () => true)).toMatchObject({ state: 'failed' })
    expect(old.calls).toEqual([])
  })
})

describe('reading an EtherNet/IP controller\'s tags while stopped', () => {
  const host = (over: Partial<EipHost> = {}): EipHost & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      open: async (o) => (calls.push(`open ${o.gateway} ${o.path}`), { error: '' }),
      bind: async () => ({ error: '' }),
      exchange: async () => ({ error: '' }),
      tags: async () => (calls.push('tags'), { error: '', status: 'ok', tags: [{ name: 'Program:MainProgram.Eye', type: 0xc1 }, { name: 'Recipe', type: 0x8f21 }, { name: 'Speed', type: 0xca }] }),
      close: async () => void calls.push('close'),
      ...over,
    }
  }

  it('opens, lists the controller\'s and its programs\' tags and lets go', async () => {
    const h = host()
    const list = await readEipTagList(h, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, () => true)
    expect(list).toMatchObject({ protocol: 'eip', state: 'ready', names: ['Program:MainProgram.Eye', 'Speed'], endpoint: '10.0.0.5 (path 1,0)' })
    expect(h.calls).toEqual(['open 10.0.0.5 1,0', 'tags', 'close'])
  })

  it('never closes a link a run has taken over meanwhile', async () => {
    const h = host()
    await readEipTagList(h, { gateway: '10.0.0.5', path: '', family: 'logix' }, () => false)
    expect(h.calls).not.toContain('close')
  })

  it('says why it could not read', async () => {
    expect(await readEipTagList(host({ open: async () => ({ error: 'no libplctag' }) }), { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, () => true)).toMatchObject({ state: 'failed', error: 'no libplctag' })
    const unsupported = await readEipTagList(host({ tags: async () => ({ error: '', status: 'PLCTAG_ERR_UNSUPPORTED' }) }), { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, () => true)
    expect(unsupported.error).toMatch(/does not list its tags/)
    const old = host()
    delete old.tags
    expect(await readEipTagList(old, { gateway: '10.0.0.5', path: '1,0', family: 'logix' }, () => true)).toMatchObject({ state: 'failed' })
    expect(old.calls).toEqual([])
  })
})
