import { describe, expect, it } from 'vitest'
import { addressForModbusPoint, externalDrivenTags, ioDirection, modbusClientFromTags, modbusPointFor, modbusServerFromTags, validateExternalIo } from './externalIo'

const table = (points: unknown[], extra: Record<string, unknown> = {}) => ({ protocol: 'modbus-tcp-server', host: '127.0.0.1', port: 5020, points, ...extra })

describe('external I/O table', () => {
  it('direction follows the Modbus area: the PLC writes coils and holding registers, reads the other two', () => {
    expect(ioDirection('coil')).toBe('fromPlc')
    expect(ioDirection('holdingRegister')).toBe('fromPlc')
    expect(ioDirection('discreteInput')).toBe('toPlc')
    expect(ioDirection('inputRegister')).toBe('toPlc')
  })

  it('accepts a well-formed table and returns a copy with only the known fields, in a fixed order', () => {
    const r = validateExternalIo({
      port: 502,
      points: [
        { address: 3, area: 'discreteInput', tag: 'Eye', note: 'dropped' },
        { tag: 'Speed', area: 'holdingRegister', address: 0, type: 'UINT' },
      ],
      host: ' 0.0.0.0 ',
      protocol: 'modbus-tcp-server',
    })
    expect(r).toEqual({
      ok: true,
      io: {
        protocol: 'modbus-tcp-server',
        host: '0.0.0.0',
        port: 502,
        points: [
          { tag: 'Eye', area: 'discreteInput', address: 3 },
          { tag: 'Speed', area: 'holdingRegister', address: 0, type: 'UINT' },
        ],
      },
    })
    if (r.ok) expect(JSON.stringify(Object.keys(r.io))).toBe('["protocol","host","port","points"]')
  })

  it('names every malformed field, with where it is', () => {
    const r = validateExternalIo(
      table([{ tag: '', area: 'register', address: 70000 }, 'x', { tag: 'Eye', area: 'coil', address: 0, type: 'INT' }], { port: 0, host: '' }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      'externalIo.host must be the address to listen on, e.g. "127.0.0.1"',
      'externalIo.port must be a whole number from 1 to 65535',
      'externalIo.points[0].tag must name a scene tag',
      'externalIo.points[0].area must be one of coil, discreteInput, holdingRegister, inputRegister',
      'externalIo.points[0].address must be a whole number from 0 to 65535',
      'externalIo.points[1] must be an object',
      'externalIo.points[2].type is for registers only: a coil carries a BOOL',
    ])
  })

  it('refuses an unknown protocol outright rather than guessing its fields', () => {
    expect(validateExternalIo(table([], { protocol: 'opc-ua' }))).toEqual({ ok: false, errors: ['externalIo.protocol must be "modbus-tcp-server"'] })
    expect(validateExternalIo(null, 'scene.io')).toEqual({ ok: false, errors: ['scene.io must be an object'] })
  })

  it('refuses two points at one address', () => {
    const r = validateExternalIo(table([
      { tag: 'A', area: 'discreteInput', address: 1 },
      { tag: 'B', area: 'discreteInput', address: 1 },
      { tag: 'C', area: 'coil', address: 1 }, // same number, different area: fine
    ]))
    expect(r).toEqual({ ok: false, errors: ['externalIo.points[1] uses discreteInput 1, which points[0] already uses'] })
  })

  it('refuses a tag the PLC writes through two points, but lets a sensor feed two inputs', () => {
    const r = validateExternalIo(table([
      { tag: 'Run', area: 'coil', address: 0 },
      { tag: 'Run', area: 'coil', address: 1 },
      { tag: 'Eye', area: 'discreteInput', address: 0 },
      { tag: 'Eye', area: 'discreteInput', address: 1 },
    ]))
    expect(r).toEqual({ ok: false, errors: ['externalIo.points[1] is a second point the PLC writes "Run" through (points[0] is the first)'] })
  })

  it('refuses a tag that travels both ways', () => {
    const r = validateExternalIo(table([
      { tag: 'Run', area: 'coil', address: 0 },
      { tag: 'Run', area: 'inputRegister', address: 0 },
    ]))
    expect(r).toEqual({ ok: false, errors: ['externalIo: "Run" travels both ways; a tag is either the PLC\'s input or its output'] })
  })

  it('the driven set is what the PLC writes, once each, in table order', () => {
    const r = validateExternalIo(table([
      { tag: 'Speed', area: 'holdingRegister', address: 0 },
      { tag: 'Eye', area: 'discreteInput', address: 0 },
      { tag: 'Run', area: 'coil', address: 0 },
    ]))
    expect(r.ok && externalDrivenTags(r.io)).toEqual(['Speed', 'Run'])
  })
})

describe('the Modbus point an I/O address travels at', () => {
  it('a bit at its bit number, a word at its index', () => {
    expect(modbusPointFor('%IX100.0')).toEqual({ area: 'discreteInput', address: 800, words: 1 })
    expect(modbusPointFor('%qx0.7')).toEqual({ area: 'coil', address: 7, words: 1 })
    expect(modbusPointFor('%IW3')).toEqual({ area: 'inputRegister', address: 3, words: 1 })
    expect(modbusPointFor('%QW12')).toEqual({ area: 'holdingRegister', address: 12, words: 1 })
  })

  it('a double word at the register pair it covers, so it aliases those two words', () => {
    expect(modbusPointFor('%ID100')).toEqual({ area: 'inputRegister', address: 200, words: 2 })
    expect(modbusPointFor('%QD0')).toEqual({ area: 'holdingRegister', address: 0, words: 2 })
    // %ID100 IS %IW200 and %IW201: a table holding both is a conflict, not two points
    const both = { protocol: 'modbus-tcp-server', host: '127.0.0.1', port: 5020, points: [
      { tag: '%ID100', area: 'inputRegister', address: 200, type: 'REAL' },
      { tag: '%IW201', area: 'inputRegister', address: 201, type: 'INT' },
    ] }
    const checked = validateExternalIo(both)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.errors.join(' ')).toMatch(/inputRegister 201, which points\[0\] already uses/)
  })

  it('and back, which is how the PLC side is configured', () => {
    for (const a of ['%IX100.0', '%QX0.7', '%IX8191.7', '%IW3', '%QW65535', '%ID100', '%QD7']) {
      const p = modbusPointFor(a)
      if ('error' in p) throw new Error(p.error)
      expect(addressForModbusPoint(p.area, p.address, p.words)).toBe(a)
    }
  })

  it('refuses what does not travel, saying why', () => {
    expect(modbusPointFor('%IB0')).toEqual({ error: expect.stringMatching(/byte address; bits .* words .* and double words .* travel over Modbus, a byte does not/) })
    expect(modbusPointFor('%IL0')).toEqual({ error: expect.stringMatching(/long-word address/) })
    expect(modbusPointFor('%MW0')).toEqual({ error: expect.stringMatching(/memory address/) })
    expect(modbusPointFor('%IX8192.0')).toEqual({ error: expect.stringMatching(/past the last Modbus bit/) })
    expect(modbusPointFor('%IX1')).toEqual({ error: expect.stringMatching(/byte.bit/) })
  })
})

describe('the table a scene wired to addresses makes', () => {
  it('turns every address tag into its point, leaves names out, and reports what cannot travel', () => {
    const { io, problems } = modbusServerFromTags({ host: '127.0.0.1', port: 5020 }, ['%QX100.0', 'Start', '%ix100.0', '%IW2', '%IX100.0', '%IB1'])
    expect(io).toEqual({
      protocol: 'modbus-tcp-server',
      host: '127.0.0.1',
      port: 5020,
      points: [
        { tag: '%QX100.0', area: 'coil', address: 800 },
        { tag: '%IX100.0', area: 'discreteInput', address: 800 },
        { tag: '%IW2', area: 'inputRegister', address: 2, type: 'INT' },
      ],
    })
    expect(problems).toEqual([{ tag: '%IB1', message: expect.stringMatching(/byte address/) }])
    expect(validateExternalIo(io).ok).toBe(true)
  })

  it('carries a double word as REAL, or as DINT when the tag is a whole number', () => {
    const { io } = modbusServerFromTags({ host: '127.0.0.1', port: 5020 }, [
      { name: '%ID100', type: 'REAL' },
      { name: '%QD101', type: 'INT' },
      { name: '%IW3', type: 'INT' },
    ])
    expect(io.points).toEqual([
      { tag: '%QD101', area: 'holdingRegister', address: 202, type: 'DINT' },
      { tag: '%IW3', area: 'inputRegister', address: 3, type: 'INT' },
      { tag: '%ID100', area: 'inputRegister', address: 200, type: 'REAL' },
    ])
    expect(validateExternalIo(io).ok).toBe(true)
  })
})

describe('two tags on one register', () => {
  // carrying both would have each overwrite the other every poll, so the first keeps the register
  it('serving: a word inside a double word is reported, and only the first travels', () => {
    const { io, problems } = modbusServerFromTags({ host: '127.0.0.1', port: 5020 }, ['%ID100', '%IW201', '%IW202'])
    expect(io.points.map((p) => p.tag)).toEqual(['%ID100', '%IW202'])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.tag).toBe('%IW201')
    expect(problems[0]!.message).toMatch(/shares input register 201 with %ID100/)
    expect(validateExternalIo(io).ok).toBe(true)
  })

  it('serving: a bit and a word never collide, since bits and registers are separate tables', () => {
    const { io, problems } = modbusServerFromTags({ host: '127.0.0.1', port: 5020 }, ['%IX0.0', '%IW0'])
    expect(problems).toEqual([])
    expect(io.points).toHaveLength(2)
  })

  it('polling a register image: a bit inside a word collides too, two bits of one register do not', () => {
    const server = { host: '127.0.0.1', port: 502 }
    const word = modbusClientFromTags(server, ['%IW0', '%IX0.0'])
    expect(word.io.points.map((p) => p.tag)).toEqual(['%IW0'])
    expect(word.problems[0]!.message).toMatch(/shares holding register 0 bit 0 with %IW0/)
    // the other order: the bit is there first, and the word is the one left out
    expect(modbusClientFromTags(server, ['%IX0.0', '%IW0']).problems[0]!.tag).toBe('%IW0')
    const twoBits = modbusClientFromTags(server, ['%IX0.0', '%IX0.1', '%IX1.0'])
    expect(twoBits.problems).toEqual([])
    expect(twoBits.io.points).toHaveLength(3)
  })
})
