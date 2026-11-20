import { describe, expect, it } from 'vitest'
import { bindEipPoint, cipTypeName, eipEndpoint, eipListingFailure, eipNothingAnswered, eipPointsFromTags, eipStatusMessage, eipTagNames, eipTarget, eipUnreachable, fromEipValue, isBitTag, isEipFamily, toEipValue } from './eip'
import type { EipPoint } from './eip'

const BOOL = 0xc1
const INT = 0xc3
const DINT = 0xc4
const REAL = 0xca

describe('which tags travel over EtherNet/IP', () => {
  it('carries every named tag: written when a part publishes it, read when parts only read it', () => {
    const r = eipPointsFromTags([
      { name: 'Run', writers: [], readers: ['belt'], type: 'BOOL' },
      { name: 'Eye', writers: ['eye'], readers: ['lamp'], type: 'BOOL' },
      { name: 'Program:MainProgram.Speed', writers: [], readers: ['belt'], type: 'REAL' },
      { name: 'Idle', writers: [], readers: [], type: null },
    ])
    expect(r.points).toEqual([
      { tag: 'Eye', dir: 'toPlc', type: 'BOOL', bit: false },
      { tag: 'Program:MainProgram.Speed', dir: 'fromPlc', type: 'REAL', bit: false },
      { tag: 'Run', dir: 'fromPlc', type: 'BOOL', bit: false },
    ])
    expect(r.problems).toEqual([])
  })

  it('takes the shapes a Logix tag name comes in: array elements, members, a bit of an integer', () => {
    const names = ['Lane[3]', 'Grid[1,2]', 'Conveyor.Motor.Run', 'Zones[2].Eye', 'Status.3', 'Program:Packer.Word.15']
    const r = eipPointsFromTags(names.map((name) => ({ name, writers: [], readers: ['p'], type: 'BOOL' as const })))
    expect(r.problems).toEqual([])
    expect(r.points.filter((p) => p.bit).map((p) => p.tag)).toEqual(['Program:Packer.Word.15', 'Status.3'])
    expect(isBitTag('Lane[3]')).toBe(false)
  })

  it('says an address is not a name, and refuses what no controller could hold', () => {
    const r = eipPointsFromTags([
      { name: '%IX0.0', writers: ['eye'], readers: [], type: 'BOOL' },
      { name: 'Cell1/Motor', writers: [], readers: ['m'], type: 'BOOL' },
      { name: 'MAIN.Eye&path=1,9', writers: ['eye'], readers: [], type: 'BOOL' },
      { name: '"Conveyor".Eye', writers: ['eye'], readers: [], type: 'BOOL' },
      { name: 'Status.3', writers: [], readers: ['m'], type: 'REAL' },
    ])
    expect(r.points).toEqual([])
    expect(r.problems).toEqual([
      expect.stringMatching(/^%IX0.0 is an I\/O address/),
      expect.stringMatching(/^Cell1\/Motor is not a tag name a Logix controller can hold/),
      expect.stringMatching(/^MAIN.Eye&path=1,9 is not a tag name a Logix controller can hold/),
      expect.stringMatching(/^"Conveyor".Eye is not a tag name/),
      'Status.3 is one bit, and the parts carry a number',
    ])
  })
})

describe('binding a point to the type the controller answered with', () => {
  const eye: EipPoint = { tag: 'Eye', dir: 'toPlc', type: 'BOOL', bit: false }
  const speed: EipPoint = { tag: 'Speed', dir: 'fromPlc', type: 'REAL', bit: false }

  it('binds a bit to a BOOL and a number to any number', () => {
    expect(bindEipPoint(eye, BOOL)).toEqual({ binding: { ...eye, cip: BOOL } })
    expect(bindEipPoint(speed, REAL)).toEqual({ binding: { ...speed, cip: REAL } })
    // a REAL the parts carry can land in a DINT: the value is rounded on the way (a scaled count is common)
    expect(bindEipPoint(speed, DINT)).toEqual({ binding: { ...speed, cip: DINT } })
    // parts that never said what they carry take whatever the controller holds
    expect(bindEipPoint({ ...eye, type: null }, INT)).toHaveProperty('binding')
  })

  it('refuses a bit on a number and the reverse, naming the controller\'s type', () => {
    expect(bindEipPoint(eye, DINT)).toEqual({ error: 'Eye: the parts carry a bit, and the controller holds it as DINT' })
    expect(bindEipPoint(speed, BOOL)).toEqual({ error: 'Speed: the parts carry a number, and the controller holds it as BOOL' })
  })

  it('refuses a structure and a 64-bit integer, which no scene value travels as', () => {
    expect(bindEipPoint(eye, 0xa0)).toEqual({ error: 'Eye: the controller holds it as a structure, not a single bit or number' })
    expect(bindEipPoint(speed, 0xc5)).toEqual({ error: 'Speed: the controller holds it as LINT, not a single bit or number' })
    expect(cipTypeName(0xd3)).toBe('CIP type 0xd3')
  })

  it('takes a bit from an integer tag only', () => {
    const bit: EipPoint = { tag: 'Status.3', dir: 'fromPlc', type: 'BOOL', bit: true }
    expect(bindEipPoint(bit, DINT)).toEqual({ binding: { ...bit, cip: DINT } })
    expect(bindEipPoint(bit, REAL)).toEqual({ error: 'Status.3: a bit is taken from an integer tag, and this one is REAL' })
  })
})

describe('values', () => {
  it('writes a scene value as the tag takes it: a bit as true/false, a whole number rounded and held in range', () => {
    expect(toEipValue({ cip: BOOL, bit: false }, 1)).toBe(true)
    expect(toEipValue({ cip: DINT, bit: true }, 0)).toBe(false)
    expect(toEipValue({ cip: INT, bit: false }, 40000.4)).toBe(32767)
    expect(toEipValue({ cip: DINT, bit: false }, 2.6)).toBe(3)
    expect(toEipValue({ cip: DINT, bit: false }, Number.NaN)).toBe(0)
    expect(toEipValue({ cip: REAL, bit: false }, 1.25)).toBe(1.25)
    expect(toEipValue({ cip: REAL, bit: false }, true)).toBe(1)
  })

  it('reads a tag as a scene value', () => {
    expect(fromEipValue({ cip: BOOL, bit: false }, true)).toBe(true)
    expect(fromEipValue({ cip: DINT, bit: true }, true)).toBe(true)
    expect(fromEipValue({ cip: DINT, bit: false }, 41)).toBe(41)
    expect(fromEipValue({ cip: REAL, bit: false }, null)).toBe(0)
  })
})

describe('what a status means', () => {
  it('tells a controller that cannot be reached from one tag that is wrong', () => {
    expect(eipUnreachable('PLCTAG_ERR_TIMEOUT')).toBe(true)
    expect(eipUnreachable('PLCTAG_ERR_BAD_GATEWAY')).toBe(true)
    expect(eipUnreachable('PLCTAG_ERR_NOT_FOUND')).toBe(false)
    expect(eipUnreachable('ok')).toBe(false)
    // libplctag's "Unknown error code" / "Miscellaneous" / "Store operation failure": the controller answered
    expect(eipUnreachable('PLCTAG_ERR_REMOTE_ERR')).toBe(false)
  })

  // what a ControlLogix chassis answers, as libplctag v2.7.2 translates it (src/libplctag/protocols/ab/error_codes.c)
  describe('when no tag answered', () => {
    const tags = ['Eye', 'Run', 'Speed']

    it('a route to an empty or wrong slot: says to check the path, once, instead of every tag "missing"', () => {
      // 0x01/0x0312 Link Address Not Valid, 0x05 Path Destination Error -> BAD_PARAM
      const said = eipNothingAnswered(tags, ['PLCTAG_ERR_BAD_PARAM', 'PLCTAG_ERR_BAD_PARAM', 'PLCTAG_ERR_BAD_PARAM'], '1,3')
      expect(said).toBe(
        "the address answered, but none of the tags did (Eye, Run, Speed; PLCTAG_ERR_BAD_PARAM). Check the path (1,3: the backplane, then the controller's slot) first: a route to the wrong slot makes every tag look missing, then check the tag names",
      )
      // 0x01/0x0311 Port Not Available, 0x01/0x0800 Network Link Offline -> BAD_DEVICE
      expect(eipNothingAnswered(tags, ['PLCTAG_ERR_BAD_DEVICE', 'PLCTAG_ERR_BAD_DEVICE', 'PLCTAG_ERR_BAD_DEVICE'], '1,0')).toMatch(/^the address answered, but none/)
      // a right path to a controller that holds none of them (0x04 -> NOT_FOUND) reads the same: the path is the cheaper check
      expect(eipNothingAnswered(tags, ['PLCTAG_ERR_NOT_FOUND', 'PLCTAG_ERR_NOT_FOUND', 'PLCTAG_ERR_NOT_FOUND'], '')).toMatch(/Check that the address is the controller itself \(the path is empty\)/)
      expect(eipNothingAnswered(['A', 'B', 'C', 'D', 'E'], Array(5).fill('PLCTAG_ERR_NOT_FOUND'), '1,0')).toMatch(/\(A, B, C and 2 more; /)
    })

    it('stays out of it when any tag answered, or a failure says something a path cannot', () => {
      expect(eipNothingAnswered(tags, ['ok', 'PLCTAG_ERR_NOT_FOUND', 'PLCTAG_ERR_NOT_FOUND'], '1,0')).toBeNull()
      // 0x0F Permission denied -> NOT_ALLOWED: the tags are there
      expect(eipNothingAnswered(tags, ['PLCTAG_ERR_NOT_FOUND', 'PLCTAG_ERR_NOT_ALLOWED', 'PLCTAG_ERR_NOT_FOUND'], '1,0')).toBeNull()
      expect(eipNothingAnswered([], [], '1,0')).toBeNull()
    })
  })

  it('says it in a sentence', () => {
    // a ControlLogix answers a missing tag with NOT_FOUND, libplctag's own simulator with BAD_PARAM: one meaning
    expect(eipStatusMessage('Eye', 'PLCTAG_ERR_NOT_FOUND')).toBe('the controller has no tag named Eye')
    expect(eipStatusMessage('Eye', 'PLCTAG_ERR_BAD_PARAM')).toBe('the controller has no tag named Eye')
    expect(eipStatusMessage('Eye', 'PLCTAG_ERR_NOT_ALLOWED')).toMatch(/External Access/)
    expect(eipStatusMessage('Eye', 'PLCTAG_ERR_BAD_DEVICE')).toBe('Eye: the path does not lead to a controller (PLCTAG_ERR_BAD_DEVICE)')
    expect(eipStatusMessage('Eye', 'PLCTAG_ERR_REMOTE_ERR')).toMatch(/^Eye: the controller refused the request/)
    expect(eipStatusMessage('Eye', 'PLCTAG_ERR_BUSY')).toBe('Eye: PLCTAG_ERR_BUSY')
  })
})

describe('the tag listing as the tag picker lists it', () => {
  it('offers the BOOL and number tags, controller and program scoped, sorted', () => {
    const names = eipTagNames([
      { name: 'Speed', type: REAL },
      { name: 'Eye', type: BOOL },
      { name: 'Program:MainProgram.Run', type: BOOL },
      { name: 'Program:MainProgram.Count', type: DINT },
      { name: 'Level', type: INT },
    ])
    expect(names).toEqual(['Eye', 'Level', 'Program:MainProgram.Count', 'Program:MainProgram.Run', 'Speed'])
  })

  it('takes a BOOL whose type carries its bit position', () => {
    expect(eipTagNames([{ name: 'Fault', type: 0x05c1 }])).toEqual(['Fault'])
  })

  it('leaves out structures, arrays, system and hidden tags, and types no part carries', () => {
    const names = eipTagNames([
      { name: 'Recipe', type: 0x8f21 },
      { name: 'Lane', type: 0x2000 | DINT },
      { name: 'Grid', type: 0x4000 | DINT },
      { name: 'Sys', type: 0x1000 | DINT },
      { name: '__hidden', type: DINT },
      { name: 'Program:Main.__hidden', type: DINT },
      { name: 'Big', type: 0xc5 },
      { name: 'Odd', type: 0x0300 | DINT },
      { name: 'Map:Local', type: DINT },
    ])
    expect(names).toEqual([])
  })
})

describe('a tag listing that failed', () => {
  it('says what the status means', () => {
    expect(eipListingFailure('PLCTAG_ERR_UNSUPPORTED', '1,0')).toMatch(/does not list its tags/)
    expect(eipListingFailure('PLCTAG_ERR_TIMEOUT', '1,0')).toMatch(/did not answer/)
    expect(eipListingFailure('PLCTAG_ERR_BAD_DEVICE', '1,3')).toMatch(/Check the path \(1,3/)
    expect(eipListingFailure('PLCTAG_ERR_NOT_ALLOWED', '1,0')).toMatch(/refused to list/)
  })
})

describe('eipTarget / eipEndpoint', () => {
  it('drops the path for a Micro800 and names the family in the endpoint', () => {
    const logix = eipTarget({ eipGateway: '10.0.0.5', eipPath: '1,0', eipFamily: 'logix' })
    expect(logix).toEqual({ gateway: '10.0.0.5', path: '1,0', family: 'logix' })
    expect(eipEndpoint(logix)).toBe('10.0.0.5 (path 1,0)')
    expect(eipEndpoint({ ...logix, path: '' })).toBe('10.0.0.5')
    const micro = eipTarget({ eipGateway: '10.0.0.6', eipPath: '1,0', eipFamily: 'micro800' })
    expect(micro).toEqual({ gateway: '10.0.0.6', path: '', family: 'micro800' })
    expect(eipEndpoint(micro)).toBe('10.0.0.6 (Micro800)')
    expect(isEipFamily('micro800')).toBe(true)
    expect(isEipFamily('ControlLogix')).toBe(false)
  })
})
