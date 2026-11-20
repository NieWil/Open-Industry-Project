import { describe, expect, it } from 'vitest'
import { describeSlmpPoint, looksLikeSlmpAddress, slmpClientFromTags, slmpDrivenTags, slmpEndpoint, slmpPointFor, slmpAddressName, slmpWords } from './slmpIo'

describe('a device address is its device', () => {
  it('number and code, with X and Y in hex and M and D in decimal', () => {
    expect(slmpPointFor('D100')).toMatchObject({ device: 'D', number: 100, type: 'INT', text: 'D100' })
    expect(slmpPointFor('M10')).toMatchObject({ device: 'M', number: 10, type: 'BOOL', text: 'M10' })
    expect(slmpPointFor('X1A')).toMatchObject({ device: 'X', number: 0x1a, type: 'BOOL', text: 'X1A' })
    expect(slmpPointFor('Y0FF')).toMatchObject({ device: 'Y', number: 0xff, text: 'YFF' })
    expect(slmpPointFor('M0010')).toMatchObject({ device: 'M', number: 10 })
    expect(slmpPointFor('d100')).toMatchObject({ device: 'D', number: 100, text: 'D100' })
    expect(slmpPointFor('x1a')).toMatchObject({ device: 'X', number: 0x1a })
    expect(slmpPointFor('X0x1A')).toMatchObject({ device: 'X', number: 0x1a })
  })

  it('counts X8 as a valid X address: X and Y are hexadecimal on an iQ-R', () => {
    expect(slmpPointFor('X18')).toMatchObject({ device: 'X', number: 0x18 })
  })

  it('refuses what does not travel', () => {
    expect(slmpPointFor('M1A')).toEqual({ error: 'M1A: M addresses are decimal, like M100' })
    expect(slmpPointFor('D100000')).toEqual({ error: 'D100000 is past the last D address an iQ-R reaches (D32767)' })
    expect(slmpPointFor('X2000')).toEqual({ error: 'X2000 is past the last X address an iQ-R reaches (X1FFF)' })
    expect(slmpPointFor('Q100')).toMatchObject({ error: expect.stringMatching(/is not a device address/) })
  })

  it('reads a tag as an address only when a digit follows the device letters', () => {
    expect(looksLikeSlmpAddress('D100')).toBe(true)
    expect(looksLikeSlmpAddress('x1a')).toBe(true)
    expect(looksLikeSlmpAddress('B1A')).toBe(true)
    expect(looksLikeSlmpAddress('X0FF')).toBe(true)
    expect(looksLikeSlmpAddress('X0xFF')).toBe(true)
    // a program name, not X 0xFF or S 0xAFE1: names come first, so an address has a digit after its letters
    expect(looksLikeSlmpAddress('XFF')).toBe(false)
    expect(looksLikeSlmpAddress('Safe1')).toBe(false)
    expect(looksLikeSlmpAddress('Bad1')).toBe(false)
    expect(looksLikeSlmpAddress('Motor2')).toBe(false)
    expect(looksLikeSlmpAddress('MAIN.Eye')).toBe(false)
  })
})

describe('the table a scene makes', () => {
  it('gives every device the direction the parts use it in', () => {
    const { io, problems } = slmpClientFromTags({ host: '10.0.0.7' }, [
      { name: 'D100', type: 'REAL', writers: 0 },
      { name: 'X1A', type: 'BOOL', writers: 1 },
      { name: 'M10', type: 'BOOL', writers: 1 },
      { name: 'Y0', type: 'BOOL', writers: 0 },
      { name: 'D200', type: 'INT', writers: 1 },
      'Named',
    ])
    expect(problems).toEqual([])
    expect(io).toMatchObject({ protocol: 'slmp', host: '10.0.0.7', port: 5000 })
    expect(io.points.map(describeSlmpPoint)).toEqual([
      'X1A  written to the PLC',
      'Y0  read from the PLC',
      'M10  written to the PLC',
      'D100  REAL  read from the PLC',
      'D200  written to the PLC',
    ])
    expect(slmpDrivenTags(io)).toEqual(['Y0', 'D100'])
  })

  it('lets two bits be two signals, but not two tags on one register', () => {
    const { io, problems } = slmpClientFromTags({ host: 'cpu' }, ['M0', 'M1', 'D10', 'd10', 'D20', { name: 'D21', type: 'DINT' }, 'D22'])
    // the first of a clashing pair keeps its place: a DINT at D21 takes D22 too
    expect(io.points.map(describeSlmpPoint)).toEqual(['M0  read from the PLC', 'M1  read from the PLC', 'D10  read from the PLC', 'D20  read from the PLC', 'D21  DINT  read from the PLC'])
    expect(problems).toEqual([
      { tag: 'd10', message: expect.stringMatching(/^is D10, which D10 already carries spelled another way/) },
      { tag: 'D22', message: expect.stringMatching(/^shares a register with D21/) },
    ])
  })

  it('reports a type its device cannot carry', () => {
    const { io, problems } = slmpClientFromTags({ host: 'cpu' }, [{ name: 'M10', type: 'INT' }, { name: 'D10', type: 'BOOL' }, { name: 'D20', type: 'DINT' }])
    expect(io.points.map(describeSlmpPoint)).toEqual(['D20  DINT  read from the PLC'])
    expect(problems).toEqual([
      { tag: 'M10', message: expect.stringMatching(/^is a bit device, which carries a BOOL/) },
      { tag: 'D10', message: expect.stringMatching(/^is a register, which carries words/) },
    ])
    expect(slmpWords({ type: 'REAL' })).toBe(2)
    expect(slmpWords({ type: 'INT' })).toBe(1)
    expect(slmpWords({ type: 'BOOL' })).toBe(1)
  })

  it('names its endpoint without the port unless it is not 5000', () => {
    expect(slmpEndpoint({ host: '192.168.0.1', port: 5000 })).toBe('192.168.0.1')
    expect(slmpEndpoint({ host: '127.0.0.1', port: 5511 })).toBe('127.0.0.1:5511')
  })

  it('spells a point back the CPU way', () => {
    expect(slmpAddressName({ device: 'X', number: 0x1a })).toBe('X1A')
    expect(slmpAddressName({ device: 'D', number: 100 })).toBe('D100')
    expect(slmpAddressName({ device: 'Y', number: 0 })).toBe('Y0')
  })
})

describe('the rest of the MELSEC devices', () => {
  it('parses each family with its own base and kind', () => {
    expect(slmpPointFor('B1A')).toMatchObject({ device: 'B', number: 0x1a, type: 'BOOL', text: 'B1A' })
    expect(slmpPointFor('W0xFF')).toMatchObject({ device: 'W', number: 0xff, type: 'INT', text: 'WFF' })
    expect(slmpPointFor('SM10')).toMatchObject({ device: 'SM', number: 10, type: 'BOOL' })
    expect(slmpPointFor('SD5')).toMatchObject({ device: 'SD', number: 5, type: 'INT' })
    expect(slmpPointFor('TN3')).toMatchObject({ device: 'TN', number: 3, type: 'INT' })
    expect(slmpPointFor('CN2')).toMatchObject({ device: 'CN', number: 2, type: 'INT' })
    expect(slmpPointFor('ZR100')).toMatchObject({ device: 'ZR', number: 100, type: 'INT' })
    expect(slmpPointFor('Z1')).toMatchObject({ device: 'Z', number: 1, type: 'INT' })
    // the longest device letters win: SM10 is a special relay, not S with a hex number
    expect(slmpPointFor('SM10')).toMatchObject({ device: 'SM' })
    expect(slmpPointFor('SB1A')).toMatchObject({ device: 'SB', number: 0x1a })
  })

  it('takes the accumulated timer either way it is spelled: STS/STC/STN or SS/SC/SN', () => {
    expect(slmpPointFor('SS10')).toMatchObject({ device: 'STS', text: 'STS10' })
    expect(slmpPointFor('SC10')).toMatchObject({ device: 'STC', text: 'STC10' })
    expect(slmpPointFor('SN10')).toMatchObject({ device: 'STN', text: 'STN10' })
    // one device, two spellings: the later tag is reported and left out
    const { io, problems } = slmpClientFromTags({ host: 'cpu' }, ['STS10', 'SS10'])
    expect(io.points.map((p) => p.tag)).toEqual(['STS10'])
    expect(problems).toEqual([{ tag: 'SS10', message: expect.stringMatching(/^is STS10, which STS10 already carries spelled another way/) }])
  })

  it('carries a register as INT, DINT or REAL, and a bit device as BOOL only', () => {
    const { io, problems } = slmpClientFromTags({ host: 'cpu' }, [
      { name: 'W10', type: 'REAL', writers: 1 },
      { name: 'TN5', type: 'INT', writers: 1 },
      { name: 'B1A', type: 'BOOL' },
      { name: 'CN2', type: 'DINT' },
    ])
    expect(problems).toEqual([])
    expect(io.points.map(describeSlmpPoint)).toEqual(['B1A  read from the PLC', 'TN5  written to the PLC', 'CN2  DINT  read from the PLC', 'W10  REAL  written to the PLC'])
  })

  it('does not read the long devices: the extended form alone names them', () => {
    for (const tag of ['LTS0', 'LTC1', 'LTN2', 'LSTS0', 'LSTC1', 'LSTN2', 'LCS0', 'LCC1', 'LCN2', 'LZ0']) {
      expect(looksLikeSlmpAddress(tag), tag).toBe(false)
      expect(slmpPointFor(tag), tag).toMatchObject({ error: expect.stringMatching(/is not a device address/) })
    }
  })
})
