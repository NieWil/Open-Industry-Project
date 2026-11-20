import { describe, expect, it } from 'vitest'
import { describeS7Point, s7AddressName, s7ClientFromTags, s7DbPointFor, s7DrivenTags, s7Endpoint, s7PointFor } from './s7Io'

describe('an IEC address is its S7 address', () => {
  it('byte for byte, in every area', () => {
    expect(s7PointFor('%IX80.4')).toEqual({ area: 'I', byte: 80, bit: 4, size: 'X' })
    expect(s7PointFor('%QW4')).toEqual({ area: 'Q', byte: 4, size: 'W' })
    expect(s7PointFor('%md10')).toEqual({ area: 'M', byte: 10, size: 'D' })
    expect(s7PointFor('%IB3')).toEqual({ area: 'I', byte: 3, size: 'B' })
  })
  it('and is spelled the S7 way for the dock', () => {
    expect(['%IX80.4', '%IB3', '%QW4', '%MD10'].map((a) => s7AddressName(s7PointFor(a) as never))).toEqual(['I80.4', 'IB3', 'QW4', 'MD10'])
  })
  it('refuses what does not travel', () => {
    expect(s7PointFor('%IL0')).toEqual({ error: expect.stringMatching(/long-word address; bits, bytes, words and double words travel over S7/) })
    expect(s7PointFor('%QD65533')).toEqual({ error: expect.stringMatching(/past the last byte/) })
  })
})

describe('the table a scene makes', () => {
  it('writes I, reads Q, and gives M the direction the parts use it in', () => {
    const { io, problems } = s7ClientFromTags({ host: '10.0.0.7' }, [
      { name: '%QD84', type: 'REAL' },
      { name: '%IX80.4', type: 'BOOL', writers: 1 },
      { name: '%MW20', type: 'INT', writers: 1 },
      { name: '%MX30.0', type: 'BOOL', writers: 0 },
      { name: '%ID88', type: 'DINT', writers: 1 },
      'Named',
    ])
    expect(problems).toEqual([])
    expect(io).toMatchObject({ protocol: 's7', host: '10.0.0.7', port: 102, rack: 0, slot: 1 })
    expect(io.points.map(describeS7Point)).toEqual([
      '%IX80.4  I80.4  written to the PLC',
      '%ID88  ID88  DINT  written to the PLC',
      '%QD84  QD84  REAL  read from the PLC',
      '%MW20  MW20  written to the PLC',
      '%MX30.0  M30.0  read from the PLC',
    ])
    expect(s7DrivenTags(io)).toEqual(['%QD84', '%MX30.0'])
  })

  it('lets bits share a byte, but not a bit and a value', () => {
    const { io, problems } = s7ClientFromTags({ host: 'cpu' }, ['%IX0.0', '%IX0.1', '%IB0', '%IW10', '%ID8'])
    // the first of a clashing pair keeps its place: ID8 is bytes 8-11, which IW10 took first
    expect(io.points.map((p) => p.tag)).toEqual(['%IX0.0', '%IX0.1', '%IW10'])
    expect(problems).toEqual([
      { tag: '%IB0', message: expect.stringMatching(/^shares a byte with %IX0\.0/) },
      { tag: '%ID8', message: expect.stringMatching(/^shares a byte with %IW10/) },
    ])
  })

  it('names its endpoint without the port unless it is not 102', () => {
    expect(s7Endpoint({ host: '192.168.0.1', port: 102, rack: 0, slot: 1 })).toBe('192.168.0.1 (rack 0, slot 1)')
    expect(s7Endpoint({ host: '127.0.0.1', port: 1102, rack: 0, slot: 2 })).toBe('127.0.0.1:1102 (rack 0, slot 2)')
  })
})

describe('data blocks', () => {
  it('reads every size, in any case, spelled back the S7 way', () => {
    expect(s7DbPointFor('DB10.DBX0.3')).toEqual({ area: 'DB', db: 10, byte: 0, bit: 3, size: 'X', text: 'DB10.DBX0.3' })
    expect(s7DbPointFor('db10.dbw4')).toEqual({ area: 'DB', db: 10, byte: 4, size: 'W', text: 'DB10.DBW4' })
    expect(s7DbPointFor('DB1.DBD6')).toMatchObject({ size: 'D', byte: 6, text: 'DB1.DBD6' })
    expect(s7DbPointFor('DB1.DBB2')).toMatchObject({ size: 'B', byte: 2 })
  })
  it('says what is wrong with a DB address that is not one', () => {
    expect(s7DbPointFor('DB10.DBX0')).toEqual({ error: 'DB10.DBX0: a bit address is byte.bit, like DB10.DBX0.0' })
    expect(s7DbPointFor('DB10.DBW4.1')).toMatchObject({ error: expect.stringMatching(/only a bit \(DBX\) has a \.bit/) })
    expect(s7DbPointFor('DB0.DBW4')).toMatchObject({ error: expect.stringMatching(/numbered 1 to 65535/) })
    expect(s7DbPointFor('DB10.DBX0.8')).toMatchObject({ error: expect.stringMatching(/bit 8 does not exist/) })
  })
  it('carries DB tags as the parts spell them, by the wiring\'s direction, after I, Q and M', () => {
    const { io, problems } = s7ClientFromTags({ host: 'cpu' }, [
      { name: 'DB10.DBD4', type: 'REAL', writers: 0 },
      { name: 'db10.dbx0.0', type: 'BOOL', writers: 1 },
      { name: '%QX0.0', type: 'BOOL' },
      { name: 'DB2.DBW0', type: 'INT', writers: 1 },
      'MAIN.Eye',
    ])
    expect(problems).toEqual([])
    expect(io.points.map(describeS7Point)).toEqual([
      '%QX0.0  Q0.0  read from the PLC',
      'DB2.DBW0  written to the PLC',
      'db10.dbx0.0  DB10.DBX0.0  written to the PLC',
      'DB10.DBD4  REAL  read from the PLC',
    ])
  })
  it('reports one address spelled two ways, a clash inside a block, and a name that is no address', () => {
    const { io, problems } = s7ClientFromTags({ host: 'cpu' }, ['DB10.DBW4', 'db10.dbw4', 'DB10.DBB5', 'DB11.DBB5', 'Cell1/DB10.DBW8', 'DB10.DBQ4'])
    expect(io.points.map((p) => p.tag)).toEqual(['DB10.DBW4', 'DB11.DBB5'])
    expect(problems).toEqual([
      { tag: 'db10.dbw4', message: expect.stringMatching(/^is DB10\.DBW4, which DB10\.DBW4 already carries spelled another way/) },
      { tag: 'DB10.DBB5', message: expect.stringMatching(/^shares a byte with DB10\.DBW4/) },
      { tag: 'DB10.DBQ4', message: expect.stringMatching(/is not a data block address/) },
    ])
  })
})
