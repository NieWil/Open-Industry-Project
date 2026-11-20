import { describe, expect, it } from 'vitest'
import { bindOpcUaPoints, builtinOf, closestOpcUaTagNames, discoveryServerMessage, fromOpcUaValue, matchOpcUaTag, MAX_BROWSE_ROOTS, opcUaBrowseRoot, opcUaPointsFromTags, opcUaTagNames, parseOpcUaBrowseRoots, tagSegments, toOpcUaValue } from './opcUa'
import type { OpcUaNodeInfo, OpcUaVariable } from './opcUa'

/**
 * Three made-up servers laying out the same program differently: deep under the DI companion spec's DeviceSet,
 * through a device name holding spaces, with string NodeIds; shallow under a runtime object; and in a global-data
 * folder with numeric NodeIds.
 */
const DEEP: OpcUaVariable[] = [
  { path: ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs', 'Main', 'Eye'], nodeId: 'ns=4;s=App.Main.Eye' },
  { path: ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs', 'Main', 'Run'], nodeId: 'ns=4;s=App.Main.Run' },
  { path: ['DeviceSet', 'Example Soft PLC', 'Resources', 'App', 'Programs', 'Packer', 'Run'], nodeId: 'ns=4;s=App.Packer.Run' },
]
const SHALLOW: OpcUaVariable[] = [{ path: ['Runtime1', 'Main', 'Eye'], nodeId: 'ns=4;s=Main.Eye' }]
const GLOBALS: OpcUaVariable[] = [{ path: ['Controller', 'GlobalData', 'Conveyor', 'Eye'], nodeId: 'ns=3;i=1007' }]

describe('which tags travel over OPC UA', () => {
  it('carries every named tag: written when a part publishes it, read when parts only read it', () => {
    const r = opcUaPointsFromTags([
      { name: 'Run', writers: [], readers: ['belt'], type: 'BOOL' },
      { name: 'Eye', writers: ['eye'], readers: ['lamp'], type: 'BOOL' },
      { name: 'Idle', writers: [], readers: [], type: null },
    ])
    expect(r.points).toEqual([
      { tag: 'Eye', dir: 'toPlc', type: 'BOOL' },
      { tag: 'Run', dir: 'fromPlc', type: 'BOOL' },
    ])
    expect(r.problems).toEqual([])
  })

  it('says an address is not a name', () => {
    const r = opcUaPointsFromTags([{ name: '%IX0.0', writers: ['eye'], readers: [], type: 'BOOL' }])
    expect(r.points).toEqual([])
    expect(r.problems).toEqual([expect.stringMatching(/%IX0.0 is an I\/O address/)])
  })
})

describe('finding a tag\'s node by name', () => {
  it('matches the end of the browse path, whatever the server puts above it', () => {
    expect(matchOpcUaTag('Main.Eye', DEEP)).toEqual({ variable: DEEP[0] })
    expect(matchOpcUaTag('Eye', DEEP)).toEqual({ variable: DEEP[0] })
    expect(matchOpcUaTag('Main.Eye', SHALLOW)).toEqual({ variable: SHALLOW[0] })
    // a quoted segment may hold a dot; the quotes are not part of the browse name
    expect(matchOpcUaTag('"Conveyor".Eye', GLOBALS)).toEqual({ variable: GLOBALS[0] })
    expect(tagSegments('"Line.1".Eye')).toEqual(['Line.1', 'Eye'])
  })

  it('ignores case as IEC names do, preferring the exact spelling', () => {
    expect(matchOpcUaTag('main.eye', DEEP)).toEqual({ variable: DEEP[0] })
    const both: OpcUaVariable[] = [
      { path: ['A', 'eye'], nodeId: 'n1' },
      { path: ['A', 'Eye'], nodeId: 'n2' },
    ]
    expect(matchOpcUaTag('Eye', both)).toEqual({ variable: both[1] })
  })

  it('refuses a name that fits several tags, naming them, rather than guessing', () => {
    const r = matchOpcUaTag('Run', DEEP)
    expect(r).toEqual({ error: expect.stringMatching(/^Run names 2 tags on the PLC \(.*Main\.Run, .*Packer\.Run\): name it by more of its path$/) })
    expect(matchOpcUaTag('Packer.Run', DEEP)).toEqual({ variable: DEEP[2] })
  })

  it('says when there is no such tag, and takes a NodeId as written', () => {
    expect(matchOpcUaTag('Missing', DEEP)).toEqual({ error: 'the PLC has no tag named Missing' })
    expect(matchOpcUaTag('ns=4;s=Main.Eye', [])).toEqual({ variable: { path: ['ns=4;s=Main.Eye'], nodeId: 'ns=4;s=Main.Eye' } })
    expect(matchOpcUaTag('ns=3;i=1007', [])).toEqual({ variable: { path: ['ns=3;i=1007'], nodeId: 'ns=3;i=1007' } })
    expect(matchOpcUaTag('Lane[3]', DEEP)).toHaveProperty('error', expect.stringContaining('array element'))
  })
})

describe('the names a tag picker offers', () => {
  it('offers each variable by the shortest end of its path that names it alone', () => {
    expect(opcUaTagNames(DEEP)).toEqual(['Eye', 'Main.Run', 'Packer.Run'])
    expect(opcUaTagNames([...SHALLOW, ...GLOBALS])).toEqual(['Conveyor.Eye', 'Main.Eye'])
  })

  it('offers only names the link binds to exactly that variable', () => {
    const vars: OpcUaVariable[] = [
      ...DEEP,
      { path: ['Device1', 'Line2', 'eye'], nodeId: 'm1' },
      { path: ['Device1', 'Line.1', 'Run'], nodeId: 'm2' },
      { path: ['Device1', 'Cell', 'Line', 'Run'], nodeId: 'm3' },
    ]
    const names = opcUaTagNames(vars)
    expect(names).toContain('"Line.1".Run')
    const bound = names.map((name) => {
      const m = matchOpcUaTag(name, vars)
      expect(m, name).toHaveProperty('variable')
      return 'variable' in m ? m.variable.nodeId : ''
    })
    // one name per variable, each binding a different one
    expect(new Set(bound).size).toBe(vars.length)
    expect(names).toHaveLength(vars.length)
  })

  it('leaves out array elements, structures and names a tag field cannot hold', () => {
    const vars: OpcUaVariable[] = [
      { path: ['Device1', 'Main', 'Lanes', '[0]'], nodeId: 'a0' },
      { path: ['Device1', 'Main', 'Lanes', '[1]', 'Run'], nodeId: 'a1' },
      { path: ['Device1', 'Main', 'Motor'], nodeId: 's' },
      { path: ['Device1', 'Main', 'Motor', 'Run'], nodeId: 's1' },
      { path: ['Device1', 'Main', 'Has Space'], nodeId: 'w' },
      { path: ['Device1', 'Main', 'Eye'], nodeId: 'e' },
    ]
    expect(opcUaTagNames(vars)).toEqual(['Eye', 'Motor.Run'])
  })
})

describe('names close to one the PLC does not hold', () => {
  const names = ['Main.PhotoEye_1', 'Main.PE_01', 'Main.Motor', 'Packer.PhotoEye_2']
  it('ranks by the last segment, ignoring case and separators', () => {
    expect(closestOpcUaTagNames('PhotoEye1', names)).toEqual(['Main.PhotoEye_1', 'Packer.PhotoEye_2'])
    expect(closestOpcUaTagNames('motor', names)).toEqual(['Main.Motor'])
  })
  it('offers nothing when nothing is close', () => {
    expect(closestOpcUaTagNames('Conveyor', names)).toEqual([])
  })
})

describe('binding points to nodes', () => {
  const info: Record<string, OpcUaNodeInfo> = {
    [DEEP[0]!.nodeId]: { dataType: 'ns=0;i=1', access: 3 },
    [DEEP[1]!.nodeId]: { dataType: 'ns=0;i=1', access: 1 },
    [DEEP[2]!.nodeId]: { dataType: 'ns=0;i=10', access: 3 },
  }
  const describe_ = (id: string) => info[id]

  it('binds each point with the type it is written as', () => {
    const r = bindOpcUaPoints(
      [
        { tag: 'Main.Eye', dir: 'toPlc', type: 'BOOL' },
        { tag: 'Main.Run', dir: 'fromPlc', type: 'BOOL' },
      ],
      DEEP,
      describe_,
    )
    expect(r.problems).toEqual([])
    expect(r.bindings.map((b) => [b.tag, b.nodeId, b.builtin])).toEqual([
      ['Main.Eye', DEEP[0]!.nodeId, 1],
      ['Main.Run', DEEP[1]!.nodeId, 1],
    ])
  })

  it('refuses a bit on a number, a node it may not write, and a type that is not a value', () => {
    const r = bindOpcUaPoints(
      [
        { tag: 'Packer.Run', dir: 'fromPlc', type: 'BOOL' },
        { tag: 'Main.Run', dir: 'toPlc', type: 'BOOL' },
      ],
      DEEP,
      describe_,
    )
    expect(r.bindings).toEqual([])
    expect(r.problems).toEqual([expect.stringMatching(/carry a bit, and .*Packer\.Run is Float/), expect.stringMatching(/does not let this client write .*Main\.Run \(a PLC's own inputs usually cannot be written/)])
    const odd = bindOpcUaPoints([{ tag: 'Eye', dir: 'toPlc', type: null }], SHALLOW, () => ({ dataType: 'ns=0;i=12', access: 3 }))
    expect(odd.problems).toEqual([expect.stringMatching(/not a single bit or number \(its type is ns=0;i=12\)/)])
  })

  it('binds a PLC\'s own type by the built-in it comes down to, and names a refused one', () => {
    const r = bindOpcUaPoints([{ tag: 'Eye', dir: 'toPlc', type: 'INT' }], SHALLOW, () => ({ dataType: 'ns=4;i=3005', builtin: 6, access: 3 }))
    expect(r.problems).toEqual([])
    expect(r.bindings.map((b) => b.builtin)).toEqual([6])
    const wide = bindOpcUaPoints([{ tag: 'Eye', dir: 'toPlc', type: 'DINT' }], SHALLOW, () => ({ dataType: 'ns=0;i=8', builtin: 8, access: 3 }))
    expect(wide.problems).toEqual([expect.stringMatching(/not a single bit or number \(its type is Int64\)/)])
  })
})

describe('a discovery server where a PLC was expected', () => {
  it('names the servers it lists, by their opc.tcp address', () => {
    expect(
      discoveryServerMessage('opc.tcp://127.0.0.1:4840', [
        { name: 'Example Soft PLC', urls: ['https://plc:4843', 'opc.tcp://plc:4841'] },
        { name: 'Other', urls: [] },
      ]),
    ).toBe(
      'opc.tcp://127.0.0.1:4840 is an OPC UA discovery server, not a PLC: it only lists the OPC UA servers on its machine. It knows of Example Soft PLC at opc.tcp://plc:4841. Put that address in the Server field.',
    )
    expect(discoveryServerMessage('opc.tcp://x:4840', [{ name: 'A', urls: ['opc.tcp://x:4841'] }, { name: 'B', urls: ['opc.tcp://x:4842'] }])).toMatch(/It knows of A at opc\.tcp:\/\/x:4841, B at opc\.tcp:\/\/x:4842\. Put one of those addresses/)
  })

  it('says where to look when it lists none', () => {
    expect(discoveryServerMessage('opc.tcp://x:4840', [])).toMatch(/it knows of none\. A PLC's OPC UA server listens on a port of its own/)
  })
})

describe('values on the wire', () => {
  it('knows the built-in types a scene value travels as', () => {
    expect([builtinOf('ns=0;i=1'), builtinOf('i=10'), builtinOf('ns=0;i=12'), builtinOf('ns=3;i=1')]).toEqual([1, 10, null, null])
  })

  it('writes a whole number rounded and held in its range, and reads a Boolean as a bit', () => {
    expect(toOpcUaValue(4, 70000)).toBe(32767)
    expect(toOpcUaValue(5, -3)).toBe(0)
    expect(toOpcUaValue(6, 2.6)).toBe(3)
    expect(toOpcUaValue(10, 0.3)).toBe(0.3)
    expect(toOpcUaValue(1, 1)).toBe(true)
    expect(toOpcUaValue(4, Number.NaN)).toBe(0)
    expect(fromOpcUaValue(1, 1)).toBe(true)
    expect(fromOpcUaValue(10, 0.5)).toBe(0.5)
    expect(fromOpcUaValue(4, true)).toBe(1)
  })
})

describe('browse start points', () => {
  it('reads a path of browse names as a tag is written, or a NodeId as it is', () => {
    expect(opcUaBrowseRoot('DeviceSet.PLC.Programs')).toEqual({ path: ['DeviceSet', 'PLC', 'Programs'] })
    expect(opcUaBrowseRoot(' "Cell.A".Data ')).toEqual({ path: ['Cell.A', 'Data'] })
    expect(opcUaBrowseRoot('ns=4;s=Programs')).toEqual({ nodeId: 'ns=4;s=Programs' })
    expect(opcUaBrowseRoot('i=85')).toEqual({ nodeId: 'i=85' })
    for (const bad of ['', '   ', 'DeviceSet..PLC', 'Programs.', 'Main.Arr[0]', 'x'.repeat(513)]) expect(opcUaBrowseRoot(bad)).toBeNull()
  })

  it('splits a field at commas outside quotes, and refuses it whole when one start point is wrong', () => {
    expect(parseOpcUaBrowseRoots('')).toEqual([])
    expect(parseOpcUaBrowseRoots(' , ')).toEqual([])
    expect(parseOpcUaBrowseRoots('DeviceSet.PLC.Programs, ns=4;s=GVL')).toEqual(['DeviceSet.PLC.Programs', 'ns=4;s=GVL'])
    expect(parseOpcUaBrowseRoots('"Line 1, Cell 2".Data')).toEqual(['"Line 1, Cell 2".Data'])
    expect(parseOpcUaBrowseRoots('Programs, Main..Eye')).toBeNull()
    expect(parseOpcUaBrowseRoots('"Programs')).toBeNull()
    expect(parseOpcUaBrowseRoots(Array.from({ length: MAX_BROWSE_ROOTS + 1 }, (_, i) => `F${i}`).join(','))).toBeNull()
  })
})
