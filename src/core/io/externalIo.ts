// External I/O: how a controller outside the simulator reaches the scene's tags.
//
// An attached program reads tags by name (src/plc/DEVICE-IO.md); a real PLC exchanges numbered fieldbus points,
// and this table says which point carries which tag, in which direction - a PLC's I/O configuration seen from
// the plant.
//
// The main topology is the simulator as a Modbus TCP server, polled by the PLC as master (how OpenPLC and most
// soft PLCs talk to field I/O). It is the only direction that lets a PLC take sensors as inputs: no Modbus
// function code writes a discrete input or input register. The client topology is further down.
//
// Direction comes from the area, as on a real Modbus device:
//   discrete inputs, input registers   the sim writes them, the PLC reads them   (a sensor, a count)
//   coils, holding registers           the PLC writes them, the sim reads them   (a motor, a setpoint)
// A tag the PLC writes is driven by it (ctx.tagDriven): its devices switch to auto while the link runs.
//
// Structure only, like core/controller.ts: shapes and self-conflicts. Whether a tag exists is check-wiring's
// question; a table naming a tag no part uses yet must still load.
//
// Usually derived: a direct-address tag (`%IX100.0`, core/io/iecAddress.ts) fixes its point (modbusPointFor), so
// modbusServerFromTags builds the table and an address-wired scene needs none.

import { canonicalAddress, looksLikeAddress, parseDirectAddress, sizeWord } from './iecAddress'

/** A Modbus data area, named the way the protocol names it. */
export type ModbusArea = 'coil' | 'discreteInput' | 'holdingRegister' | 'inputRegister'

/**
 * How registers hold a tag's number. INT and UINT take one register; DINT and REAL take two, low word
 * first - the order OpenPLC's Modbus master uses, measured against the real runtime (see
 * {@link modbusPointFor}).
 */
export type RegisterType = 'INT' | 'UINT' | 'DINT' | 'REAL'

export interface ExternalIoPoint {
  /** the scene tag (its global key) this point carries */
  tag: string
  area: ModbusArea
  /** the protocol address in its area, 0-65535. Not the 1-based "00001 / 10001 / 40001" label some tools print. */
  address: number
  /** registers only: how the word maps to a number (INT when left out). A bit area carries BOOL and takes none. */
  type?: RegisterType
}

/** How many 16-bit registers a point occupies: two for a 32-bit value, one for anything else. */
export function registerWords(type: RegisterType | undefined): 1 | 2 {
  return type === 'DINT' || type === 'REAL' ? 2 : 1
}

export interface ModbusServerIo {
  protocol: 'modbus-tcp-server'
  /** the address the simulator listens on; 127.0.0.1 keeps it off the network */
  host: string
  port: number
  points: ExternalIoPoint[]
}

/** The whole table. A union of one today; a second transport (the sim as a client) joins it here. */
export type ExternalIo = ModbusServerIo

export type IoDirection = 'toPlc' | 'fromPlc'

const AREAS: readonly ModbusArea[] = ['coil', 'discreteInput', 'holdingRegister', 'inputRegister']
const REGISTER_TYPES: readonly RegisterType[] = ['INT', 'UINT', 'DINT', 'REAL']

/** Which way a point's value travels. */
export function ioDirection(area: ModbusArea): IoDirection {
  return area === 'coil' || area === 'holdingRegister' ? 'fromPlc' : 'toPlc'
}

/** Does the area hold single bits (BOOL) rather than 16-bit words? */
export function isBitArea(area: ModbusArea): boolean {
  return area === 'coil' || area === 'discreteInput'
}

/** The tags the external controller writes, in table order without repeats: what it drives (ctx.tagDriven). */
export function externalDrivenTags(io: ExternalIo): string[] {
  return [...new Set(io.points.filter((p) => ioDirection(p.area) === 'fromPlc').map((p) => p.tag))]
}

/**
 * The Modbus point that carries an I/O address, by one fixed rule both ends reproduce without a table: a bit
 * travels at its bit number, a word at its index.
 *
 *   %IXb.n  discrete input   b*8 + n        %IWn  input register    n       %IDn  input registers   2n, 2n+1
 *   %QXb.n  coil             b*8 + n        %QWn  holding register  n       %QDn  holding registers 2n, 2n+1
 *
 * %ID100 is the register pair 200-201, the same words as %IW200/%IW201 in IEC memory, so a word / double-word
 * overlap is a real conflict: {@link modbusServerFromTags} carries only the first and plc/wiring.ts flags it.
 *
 * Word order is measured. OpenPLC's Modbus master converts a 32-bit point low word first
 * (use_big_endian=False at every call site), confirmed by a probe against the real runtime: served 12.5 as
 * a float32 pair, `Speed AT %ID100 : REAL` computed Speed * 2.0 and wrote back 25.0. So a REAL travels as its
 * IEEE754 bits, no scaling convention. Bytes (%IB), 64-bit (%IL) and memory (%M) do not travel.
 */
export function modbusPointFor(address: string): { area: ModbusArea; address: number; words: 1 | 2 } | { error: string } {
  const a = parseDirectAddress(address)
  if ('error' in a) return a
  if (a.area === 'M') return { error: `${a.text} is a memory address; only inputs (%I) and outputs (%Q) travel over Modbus` }
  if (a.size === 'X') {
    const bit = a.fields[0]! * 8 + a.fields[1]!
    if (bit > 65535) return { error: `${a.text} is bit ${bit}, past the last Modbus bit (65535)` }
    return { area: a.area === 'I' ? 'discreteInput' : 'coil', address: bit, words: 1 }
  }
  const registers = a.area === 'I' ? 'inputRegister' : 'holdingRegister'
  if (a.size === 'W') {
    if (a.fields[0]! > 65535) return { error: `${a.text} is past the last Modbus register (65535)` }
    return { area: registers, address: a.fields[0]!, words: 1 }
  }
  if (a.size === 'D') {
    const first = a.fields[0]! * 2
    if (first + 1 > 65535) return { error: `${a.text} is past the last Modbus register (65535)` }
    return { area: registers, address: first, words: 2 }
  }
  return { error: `${a.text} is a ${sizeWord(a.size)} address; bits (%IX), words (%IW) and double words (%ID) travel over Modbus, a ${sizeWord(a.size)} does not` }
}

/** The IEC address a Modbus point carries: the inverse of {@link modbusPointFor}. */
export function addressForModbusPoint(area: ModbusArea, address: number, words: 1 | 2 = 1): string {
  const letter = area === 'discreteInput' || area === 'inputRegister' ? 'I' : 'Q'
  if (isBitArea(area)) return `%${letter}X${Math.floor(address / 8)}.${address % 8}`
  return words === 2 ? `%${letter}D${address / 2}` : `%${letter}W${address}`
}

/** A tag as the wiring check knows it: its name, and what the parts on it carry. */
export interface TagSignal {
  name: string
  type?: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
}

/**
 * The table a scene's address tags make: every tag that is an input or output address becomes the point
 * {@link modbusPointFor} gives it. A word is INT; a double word is DINT when the tag carries a whole
 * number and REAL otherwise, since a REAL is what a double word is usually there for (a speed, a
 * distance) and it carries whole numbers exactly up to 2^24 anyway. Tags that are not addresses are left
 * out (they are program names, which only the in-process program reads); an address that cannot travel is
 * reported, not dropped. Two addresses that land on one register (a word inside a double word) are a
 * conflict the link would carry as two tags fighting over one value, so the later one is reported and left
 * out: its device visibly gets nothing, instead of both flickering.
 */
export function modbusServerFromTags(
  server: { host: string; port: number },
  tags: readonly (string | TagSignal)[],
): { io: ExternalIo; problems: { tag: string; message: string }[] } {
  const points: ExternalIoPoint[] = []
  const problems: { tag: string; message: string }[] = []
  const seen = new Set<string>()
  const taken = new Map<string, string>() // `${area}:${address}` -> the tag already there
  for (const entry of tags) {
    const raw = typeof entry === 'string' ? entry : entry.name
    if (!looksLikeAddress(raw)) continue
    const tag = canonicalAddress(raw) ?? raw
    if (seen.has(tag)) continue
    seen.add(tag)
    const point = modbusPointFor(tag)
    if ('error' in point) {
      problems.push({ tag, message: point.error })
      continue
    }
    const at = Array.from({ length: point.words }, (_, w) => `${point.area}:${point.address + w}`)
    const clash = at.map((k) => taken.get(k)).find((t) => t !== undefined)
    if (clash !== undefined) {
      const area = point.area.replace(/([A-Z])/g, ' $1').toLowerCase()
      const where = point.words === 2 ? `${area}s ${point.address}-${point.address + 1}` : `${area} ${point.address}`
      problems.push({ tag, message: `shares ${where} with ${clash}, so over the link the two would overwrite each other; ${tag} is left out. Give one of them an address of its own` })
      continue
    }
    for (const k of at) taken.set(k, tag)
    const carries = typeof entry === 'string' ? undefined : entry.type
    const type: RegisterType = point.words === 2 ? (carries === 'INT' || carries === 'DINT' ? 'DINT' : 'REAL') : 'INT'
    points.push({ tag, area: point.area, address: point.address, ...(isBitArea(point.area) ? {} : { type }) })
  }
  const order = (p: ExternalIoPoint): number => AREAS.indexOf(p.area) * 0x10000 + p.address
  points.sort((a, b) => order(a) - order(b))
  return { io: { protocol: 'modbus-tcp-server', host: server.host, port: server.port, points }, problems }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

// ---- the other topology: the simulator as a Modbus client, the PLC as the server ----
//
// For PLCs easier to set up as a Modbus server (src/plc/DEVICE-IO.md). The simulator polls, so it sets the pace.
//
// The server is read as exposing the PLC's process image byte-wise (our layout rule): register n is image bytes
// 2n and 2n+1, low byte first. The client writes holding registers to reach the PLC's inputs and reads input
// registers to see its outputs:
//
//   %IXb.n  holding register b>>1, bit (b&1)*8 + n      %QXb.n  input register b>>1, bit (b&1)*8 + n
//   %IWn    holding register n                          %QWn    input register n
//   %IDn    holding registers 2n, 2n+1 (low word first) %QDn    input registers 2n, 2n+1
//
// The rule has no upper bound; how many registers the device maps is the PLC's own I/O configuration. (Coils
// are not used.)

/** Where a client finds an I/O address in a server's register image. */
export interface RegisterImagePoint {
  /** holding registers carry the PLC's inputs (the client writes them), input registers its outputs */
  area: 'holdingRegister' | 'inputRegister'
  /** the first register */
  register: number
  /** for a bit: which bit of that register (0 = least significant) */
  bit?: number
  words: 1 | 2
}

/**
 * Where a server device's registers sit in the PLC's process image: the %IW word its holding register 0 is,
 * and the %QW word its input register 0 is. Both 0 for a device that is the PLC's only I/O; a PLC with other
 * I/O ahead of it maps it further up, and its I/O mapping page says where.
 */
export interface RegisterBase {
  input: number
  output: number
}

export const REGISTER_BASE_ZERO: RegisterBase = Object.freeze({ input: 0, output: 0 })

/** The register image point that carries an I/O address, or why it cannot travel this way. */
export function registerImagePointFor(address: string, base: RegisterBase = REGISTER_BASE_ZERO): RegisterImagePoint | { error: string } {
  const a = parseDirectAddress(address)
  if ('error' in a) return a
  if (a.area === 'M') return { error: `${a.text} is a memory address; only inputs (%I) and outputs (%Q) travel to a PLC` }
  if (a.size !== 'X' && a.size !== 'W' && a.size !== 'D') {
    return { error: `${a.text} is a ${sizeWord(a.size)} address; bits, words and double words travel this way, a ${sizeWord(a.size)} does not` }
  }
  const area = a.area === 'I' ? 'holdingRegister' : 'inputRegister'
  // the image word the address starts in, and how many it spans
  const word = a.size === 'X' ? a.fields[0]! >> 1 : a.size === 'W' ? a.fields[0]! : a.fields[0]! * 2
  const words = a.size === 'D' ? 2 : 1
  const first = a.area === 'I' ? base.input : base.output
  const register = word - first
  if (register < 0) return { error: `${a.text} is below the server device's first register (%${a.area}W${first})` }
  if (register + words - 1 > 65535) return { error: `${a.text} is past the last Modbus register (65535)` }
  return a.size === 'X' ? { area, register, bit: (a.fields[0]! & 1) * 8 + a.fields[1]!, words: 1 } : { area, register, words }
}

/** One tag a client carries: where it sits in the server's register image, and how its registers hold it. */
export interface ClientIoPoint extends RegisterImagePoint {
  tag: string
  /** registers only: BOOL points are bits and take none */
  type?: RegisterType
}

/** The simulator as a Modbus TCP client of the PLC. */
export interface ModbusClientIo {
  protocol: 'modbus-tcp-client'
  /** the PLC's Modbus server */
  host: string
  port: number
  unitId: number
  /** where the server's registers sit in the PLC's process image */
  base: RegisterBase
  points: ClientIoPoint[]
}

/**
 * The table a scene's address tags make when the simulator is the client: every input or output address
 * becomes the register image point {@link registerImagePointFor} gives it. A double word is DINT when the
 * tag carries a whole number and REAL otherwise, as on the server side. In a register image a bit lives
 * inside a register, so beyond the word-in-a-double-word conflict the server side has, a bit and a word on
 * one register also fight (%IX0.0 is bit 0 of %IW0's register). The later of two such tags is reported and
 * left out, as on the server side; two different bits of one register are fine.
 */
export function modbusClientFromTags(
  server: { host: string; port: number; unitId?: number; base?: RegisterBase },
  tags: readonly (string | TagSignal)[],
): { io: ModbusClientIo; problems: { tag: string; message: string }[] } {
  const base = { ...(server.base ?? REGISTER_BASE_ZERO) }
  const points: ClientIoPoint[] = []
  const problems: { tag: string; message: string }[] = []
  const seen = new Set<string>()
  // per `${area}:${register}`: the tag holding the whole register, or the tags holding bits of it
  const whole = new Map<string, string>()
  const bits = new Map<string, string[]>()
  for (const entry of tags) {
    const raw = typeof entry === 'string' ? entry : entry.name
    if (!looksLikeAddress(raw)) continue
    const tag = canonicalAddress(raw) ?? raw
    if (seen.has(tag)) continue
    seen.add(tag)
    const point = registerImagePointFor(tag, base)
    if ('error' in point) {
      problems.push({ tag, message: point.error })
      continue
    }
    const regs = Array.from({ length: point.words }, (_, w) => `${point.area}:${point.register + w}`)
    const clash = regs.map((k) => whole.get(k) ?? (point.bit === undefined ? bits.get(k)?.[0] : undefined)).find((t) => t !== undefined)
    if (clash !== undefined) {
      problems.push({ tag, message: `shares ${registerImagePointWhere(point)} with ${clash}, so over the link the two would overwrite each other; ${tag} is left out. Give one of them an address of its own` })
      continue
    }
    if (point.bit === undefined) for (const k of regs) whole.set(k, tag)
    else bits.set(regs[0]!, [...(bits.get(regs[0]!) ?? []), tag])
    const carries = typeof entry === 'string' ? undefined : entry.type
    const type: RegisterType | undefined = point.bit !== undefined ? undefined : point.words === 2 ? (carries === 'INT' || carries === 'DINT' ? 'DINT' : 'REAL') : 'INT'
    points.push({ tag, ...point, ...(type ? { type } : {}) })
  }
  points.sort((a, b) => (a.area === b.area ? a.register - b.register || (a.bit ?? 0) - (b.bit ?? 0) : a.area < b.area ? -1 : 1))
  return { io: { protocol: 'modbus-tcp-client', host: server.host, port: server.port, unitId: server.unitId ?? 1, base, points }, problems }
}

/** The tags a client table's PLC drives: its outputs, which the client reads from the input registers. */
export function clientDrivenTags(io: ModbusClientIo): string[] {
  return [...new Set(io.points.filter((p) => p.area === 'inputRegister').map((p) => p.tag))]
}

/** "holding register 50 bit 0", "input registers 2-3": where a client point sits, in the protocol's words. */
export function registerImagePointWhere(p: RegisterImagePoint): string {
  const area = p.area === 'holdingRegister' ? 'holding register' : 'input register'
  if (p.words === 2) return `${area}s ${p.register}-${p.register + 1}`
  return p.bit === undefined ? `${area} ${p.register}` : `${area} ${p.register} bit ${p.bit}`
}

/**
 * Structural validation of an untrusted table. Returns a fresh copy holding only the known fields, in a
 * fixed key order, so two equal tables serialize identically. `at` prefixes each error with where the
 * table sits in its document.
 *
 * Refused as conflicts, because each one makes the link fight itself rather than fail visibly:
 * - two points at one address, which would carry two tags in one bit or word;
 * - a tag the PLC writes from two points, which would flap between them every poll;
 * - a tag that travels both ways, which is the part-writes-an-output oscillation the in-sim bus
 *   already refuses (docs: src/plc/DEVICE-IO.md, output ownership).
 */
export function validateExternalIo(raw: unknown, at = 'externalIo'): { ok: true; io: ExternalIo } | { ok: false; errors: string[] } {
  if (!isObject(raw)) return { ok: false, errors: [`${at} must be an object`] }
  if (raw.protocol !== 'modbus-tcp-server') return { ok: false, errors: [`${at}.protocol must be "modbus-tcp-server"`] }
  const errors: string[] = []
  if (typeof raw.host !== 'string' || raw.host.trim() === '') errors.push(`${at}.host must be the address to listen on, e.g. "127.0.0.1"`)
  if (!isWhole(raw.port, 1, 65535)) errors.push(`${at}.port must be a whole number from 1 to 65535`)
  if (!Array.isArray(raw.points)) errors.push(`${at}.points must be an array`)

  const points: ExternalIoPoint[] = []
  ;(Array.isArray(raw.points) ? raw.points : []).forEach((p: unknown, i: number) => {
    const w = `${at}.points[${i}]`
    if (!isObject(p)) {
      errors.push(`${w} must be an object`)
      return
    }
    const before = errors.length
    if (typeof p.tag !== 'string' || p.tag.trim() === '') errors.push(`${w}.tag must name a scene tag`)
    const area = AREAS.find((a) => a === p.area)
    if (!area) errors.push(`${w}.area must be one of ${AREAS.join(', ')}`)
    if (!isWhole(p.address, 0, 65535)) errors.push(`${w}.address must be a whole number from 0 to 65535`)
    if (p.type !== undefined) {
      if (area && isBitArea(area)) errors.push(`${w}.type is for registers only: a ${area} carries a BOOL`)
      else if (!REGISTER_TYPES.includes(p.type as RegisterType)) errors.push(`${w}.type must be one of ${REGISTER_TYPES.join(', ')}`)
    }
    if (errors.length === before && area) {
      points.push({
        tag: p.tag as string,
        area,
        address: p.address as number,
        ...(p.type !== undefined ? { type: p.type as RegisterType } : {}),
      })
    }
  })

  const byAddress = new Map<string, number>()
  const writers = new Map<string, number>()
  const directions = new Map<string, Set<IoDirection>>()
  points.forEach((p, i) => {
    // a 32-bit point holds two registers, so it collides with a word sitting on either of them
    for (let w = 0; w < registerWords(p.type); w++) {
      const key = `${p.area}:${p.address + w}`
      const first = byAddress.get(key)
      if (first !== undefined) errors.push(`${at}.points[${i}] uses ${p.area} ${p.address + w}, which points[${first}] already uses`)
      else byAddress.set(key, i)
    }
    const dir = ioDirection(p.area)
    if (dir === 'fromPlc') {
      const w = writers.get(p.tag)
      if (w !== undefined) errors.push(`${at}.points[${i}] is a second point the PLC writes "${p.tag}" through (points[${w}] is the first)`)
      else writers.set(p.tag, i)
    }
    const seen = directions.get(p.tag) ?? new Set<IoDirection>()
    seen.add(dir)
    directions.set(p.tag, seen)
  })
  for (const [tag, dirs] of directions) {
    if (dirs.size > 1) errors.push(`${at}: "${tag}" travels both ways; a tag is either the PLC's input or its output`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, io: { protocol: 'modbus-tcp-server', host: (raw.host as string).trim(), port: raw.port as number, points } }
}
