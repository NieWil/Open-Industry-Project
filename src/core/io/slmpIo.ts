// SLMP (MELSEC Communication Protocol): which scene tag travels in which device of a MELSEC CPU.
//
// SLMP is the protocol MELSEC CPUs answer on an Ethernet module (SH-080956); this client speaks the 3E binary
// frame in the QnA-compatible form, which Q, L, iQ-R and iQ-F CPUs all accept. The simulator is the client
// (plc/link/slmpClient.ts), and this is only the table.
//
// A tag is a device address, spelled the way the CPU's own tools spell it: D100 is data register 100, M10
// internal relay 10, X1A input 0x1A, W10 link register 0x10. Each device counts its own way - X, Y, B, W, SB,
// SW, DX and DY in hexadecimal (iQ-R and Q; an FX5U counts X and Y in octal, which this table refuses to guess
// at), the rest in decimal. The device codes are the QnA one-byte form (SH-080008's device code list).
//
// The long devices - LTS/LTC/LTN, LSTS/LSTC/LSTN, LCS/LCC/LCN and LZ - are NOT here on purpose: they are
// double-word devices that only the extended (iQ-R) form names, with two-byte codes this frame does not carry.
//
// Direction: every device takes the wiring's direction: a tag a part writes travels to the PLC, one a part only
// reads comes from it. X is the CPU's inputs: on a CPU with a real input module at that address the module's
// refresh overwrites what the simulator wrote every scan, so a scene driving X wants addresses no module occupies
// (the same rule as S7's I; core/io/s7Io.ts).
//
// A bit device carries a BOOL. A word device carries INT (one register); DINT and REAL are two registers, low
// word first, which is what the byte order of a little-endian machine already gives (core/io/externalIo.ts
// registerWords says the same for Modbus). A tag that asks for the other is reported and left out, since both
// would silently read as something else.
//
// A tag reads as an address when a digit follows the device letters (M10, X1A, W1FF). That keeps program names
// out: Safe1, Feed1 or Bad1 are names, while X0FF or X0xFF spell the input 0xFF. GX Works3 spells the
// accumulated timer STS/STC/STN and other tools SS/SC/SN: both spell the same devices here.

import type { TagSignal } from './externalIo'
import { registerWords } from './externalIo'

export type SlmpDevice =
  | 'X'
  | 'Y'
  | 'M'
  | 'D'
  | 'SM'
  | 'SD'
  | 'L'
  | 'F'
  | 'V'
  | 'B'
  | 'SB'
  | 'SW'
  | 'DX'
  | 'DY'
  | 'S'
  | 'TS'
  | 'TC'
  | 'STS'
  | 'STC'
  | 'TN'
  | 'STN'
  | 'CS'
  | 'CC'
  | 'CN'
  | 'W'
  | 'R'
  | 'ZR'
  | 'Z'

/** How a device's points hold their values. BOOL is a bit; INT one word, DINT and REAL two (low word first). */
export type SlmpType = 'BOOL' | 'INT' | 'DINT' | 'REAL'

/** What each device is, on the wire and in its own spelling. */
export interface SlmpDeviceKind {
  /** the QnA one-byte device code (SH-080008's list) */
  code: number
  kind: 'bit' | 'word'
  /** how the device numbers count: hexadecimal or decimal */
  base: 16 | 10
  /** the last number this client checks against. The CPU's answer is the real limit */
  max: number
}

/** Where a 3E request stops naming device numbers. Ranges beyond it are the CPU model's business. */
const PROTOCOL_MAX = 0xffffff

/**
 * Every device this client speaks, in the order the dock lists them. The long devices (LTS/LTC/LTN,
 * LSTS/LSTC/LSTN, LCS/LCC/LCN, LZ) are absent: the extended form alone names them (two-byte codes).
 */
export const SLMP_DEVICES: Record<SlmpDevice, SlmpDeviceKind> = {
  X: { code: 0x9c, kind: 'bit', base: 16, max: 0x1fff },
  Y: { code: 0x9d, kind: 'bit', base: 16, max: 0x1fff },
  M: { code: 0x90, kind: 'bit', base: 10, max: 65535 },
  D: { code: 0xa8, kind: 'word', base: 10, max: 32767 },
  SM: { code: 0x91, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  SD: { code: 0xa9, kind: 'word', base: 10, max: PROTOCOL_MAX },
  L: { code: 0x92, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  F: { code: 0x93, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  V: { code: 0x94, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  B: { code: 0xa0, kind: 'bit', base: 16, max: PROTOCOL_MAX },
  SB: { code: 0xa1, kind: 'bit', base: 16, max: PROTOCOL_MAX },
  SW: { code: 0xb5, kind: 'word', base: 16, max: PROTOCOL_MAX },
  DX: { code: 0xa2, kind: 'bit', base: 16, max: PROTOCOL_MAX },
  DY: { code: 0xa3, kind: 'bit', base: 16, max: PROTOCOL_MAX },
  S: { code: 0x98, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  TS: { code: 0xc1, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  TC: { code: 0xc0, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  STS: { code: 0xc7, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  STC: { code: 0xc6, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  TN: { code: 0xc2, kind: 'word', base: 10, max: PROTOCOL_MAX },
  STN: { code: 0xc8, kind: 'word', base: 10, max: PROTOCOL_MAX },
  CS: { code: 0xc4, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  CC: { code: 0xc3, kind: 'bit', base: 10, max: PROTOCOL_MAX },
  CN: { code: 0xc5, kind: 'word', base: 10, max: PROTOCOL_MAX },
  W: { code: 0xb4, kind: 'word', base: 16, max: PROTOCOL_MAX },
  R: { code: 0xaf, kind: 'word', base: 10, max: PROTOCOL_MAX },
  ZR: { code: 0xb0, kind: 'word', base: 10, max: PROTOCOL_MAX },
  Z: { code: 0xcc, kind: 'word', base: 10, max: PROTOCOL_MAX },
}

/** GX Works3 spells the accumulated timer STS/STC/STN; other tools SS/SC/SN. Same devices. */
const ALIASES: Record<string, SlmpDevice> = { SS: 'STS', SC: 'STC', SN: 'STN' }

/** Device letters, longest first, so SM10 is SM and SB1A is SB rather than S. */
const PREFIXES = [...Object.keys(SLMP_DEVICES), ...Object.keys(ALIASES)].sort((a, b) => b.length - a.length)

/** Where a point sits in the CPU's memory. */
export interface SlmpLocation {
  device: SlmpDevice
  /** the device number (its own base, above: X and Y in hex, M and D in decimal) */
  number: number
  type: SlmpType
}

export interface SlmpPoint extends SlmpLocation {
  /** the scene tag: the address as the parts spell it */
  tag: string
  /** toPlc: the simulator writes it (a sensor); fromPlc: the PLC writes it (a motor) */
  dir: 'toPlc' | 'fromPlc'
}

/** The simulator as an SLMP client of a MELSEC CPU. */
export interface SlmpClientIo {
  protocol: 'slmp'
  host: string
  /** 5000, the SLMP port, unless something forwards it */
  port: number
  points: SlmpPoint[]
}

/** The registers a point occupies: DINT and REAL span two, everything else one. */
export function slmpWords(p: Pick<SlmpLocation, 'type'>): 1 | 2 {
  return p.type === 'BOOL' ? 1 : registerWords(p.type)
}

/** The device letters a tag begins with, and the rest of it; null when no device starts it. */
function splitDevice(tag: string): { name: string; rest: string } | null {
  const upper = tag.toUpperCase()
  for (const prefix of PREFIXES) {
    if (upper.startsWith(prefix) && prefix.length < tag.length) return { name: prefix, rest: tag.slice(prefix.length) }
  }
  return null
}

/** The rest of an address: the optional 0x prefix, then one or more digits of any base. */
const DIGITS_SHAPE = /^(0x)?[0-9A-Fa-f]+$/i

/** Does the tag read as a device address at all (well-formed or not)? A digit follows the device letters. */
export function looksLikeSlmpAddress(tag: string): boolean {
  const split = splitDevice(tag.trim())
  return split !== null && /^[0-9]/.test(split.rest) && DIGITS_SHAPE.test(split.rest)
}

/** The location a device address names (D100), or why it is not one SLMP can reach. */
export function slmpPointFor(raw: string): (SlmpLocation & { text: string }) | { error: string } {
  const s = raw.trim()
  const split = splitDevice(s)
  if (!split || !/^[0-9]/.test(split.rest) || !DIGITS_SHAPE.test(split.rest)) return { error: `${s} is not a device address; one reads like D100 (a data register), M10 (an internal relay), X1A (an input), Y0 (an output), B1A (a link relay) or W10 (a link register)` }
  const device = (ALIASES[split.name] ?? split.name) as SlmpDevice
  const kind = SLMP_DEVICES[device]
  const digits = split.rest.replace(/^0x/i, '')
  if (kind.base === 10 && /[^0-9]/.test(digits)) return { error: `${s}: ${device} addresses are decimal, like ${device}100` }
  const number = parseInt(digits, kind.base)
  if (number > kind.max) {
    return kind.max === PROTOCOL_MAX
      ? { error: `${s}: a device number runs 0 to ${PROTOCOL_MAX} in a 3E request` }
      : { error: `${s} is past the last ${device} address an iQ-R reaches (${device}${kind.max.toString(kind.base).toUpperCase()})` }
  }
  return { device, number, type: kind.kind === 'bit' ? 'BOOL' : 'INT', text: slmpAddressName({ device, number }) }
}

/** "X1A", "Y0", "M10", "D100", "W1FF": a point in the CPU's own spelling, as its tools show it. */
export function slmpAddressName(p: Pick<SlmpLocation, 'device' | 'number'>): string {
  return `${p.device}${p.number.toString(SLMP_DEVICES[p.device].base).toUpperCase()}`
}

/** The tag a scene part carries, with which way the parts use it (plc/wiring.ts SceneTagWiring has both). */
export interface SlmpTagSignal extends TagSignal {
  /** how many parts write the tag; a tag a part writes travels to the PLC */
  writers?: number
}

/**
 * The table a scene's device addresses make: every tag at its device, with the type its tag carries. Tags that
 * read as no address are left out: they are program names, which only the in-process program reads.
 *
 * Two tags that name one register clash, spelled the same or not (D100 and d100 are one register; SS10 and
 * STS10 are one device; a DINT at D100 takes D101 too). The later of a clashing pair is reported and left out,
 * so its device visibly gets nothing instead of both flickering. A bit device carries a BOOL and a word device
 * carries words: a tag that asks for the other is reported and left out.
 */
export function slmpClientFromTags(
  cpu: { host: string; port?: number },
  tags: readonly (string | SlmpTagSignal)[],
): { io: SlmpClientIo; problems: { tag: string; message: string }[] } {
  const points: SlmpPoint[] = []
  const problems: { tag: string; message: string }[] = []
  const seen = new Set<string>()
  // per device and number: the tag holding it
  const held = new Map<string, string>()
  // one address spelled two ways: the tag that spelled it first
  const spelled = new Map<string, string>()
  for (const entry of tags) {
    const raw = typeof entry === 'string' ? entry : entry.name
    if (!looksLikeSlmpAddress(raw)) continue
    const tag = raw.trim()
    if (seen.has(tag)) continue
    seen.add(tag)
    const point = slmpPointFor(tag)
    if ('error' in point) {
      problems.push({ tag, message: point.error })
      continue
    }
    const { text, ...at } = point
    const first = spelled.get(text)
    if (first !== undefined) {
      problems.push({ tag, message: `is ${text}, which ${first} already carries spelled another way, so over the link the two would overwrite each other; ${tag} is left out. Spell it the same in both parts` })
      continue
    }
    const carries = typeof entry === 'string' ? undefined : entry.type
    const bit = SLMP_DEVICES[at.device].kind === 'bit'
    if (bit ? carries !== undefined && carries !== 'BOOL' : carries === 'BOOL') {
      problems.push({
        tag,
        message: bit
          ? `is a bit device, which carries a BOOL; ${carries ?? 'a word'} needs a register (D, W, SD, SW, TN, STN, CN, R, ZR or Z). ${tag} is left out`
          : `is a register, which carries words (INT, DINT or REAL); a BOOL travels on a bit device (M, X, Y, B, SM...). ${tag} is left out`,
      })
      continue
    }
    const type: SlmpType = bit ? 'BOOL' : carries === 'DINT' || carries === 'REAL' ? carries : 'INT'
    const clash = Array.from({ length: slmpWords({ type }) }, (_, i) => held.get(`${at.device}${at.number + i}`)).find((t) => t !== undefined)
    if (clash !== undefined) {
      problems.push({ tag, message: `shares a register with ${clash}, so over the link the two would overwrite each other; ${tag} is left out. Give one of them an address of its own` })
      continue
    }
    for (let i = 0; i < slmpWords({ type }); i++) held.set(`${at.device}${at.number + i}`, tag)
    spelled.set(text, tag)
    const writers = typeof entry === 'string' ? 0 : (entry.writers ?? 0)
    points.push({ tag, ...at, type, dir: writers > 0 ? 'toPlc' : 'fromPlc' })
  }
  const order = (p: SlmpPoint): number => Object.keys(SLMP_DEVICES).indexOf(p.device) * 2 ** 20 + p.number
  points.sort((a, b) => order(a) - order(b))
  return { io: { protocol: 'slmp', host: cpu.host, port: cpu.port ?? 5000, points }, problems }
}

/** "192.168.0.1" or "192.168.0.1:5511": where the link goes, with the port only when it is not SLMP's 5000. */
export function slmpEndpoint(cpu: Pick<SlmpClientIo, 'host' | 'port'>): string {
  return `${cpu.host}${cpu.port === 5000 ? '' : `:${cpu.port}`}`
}

/** The tags the PLC drives: everything the simulator reads back. */
export function slmpDrivenTags(io: SlmpClientIo): string[] {
  return io.points.filter((p) => p.dir === 'fromPlc').map((p) => p.tag)
}

/**
 * "X1A  read from the PLC", "M10  written to the PLC", "D100  REAL  read from the PLC": a point as the dock
 * lists it, the CPU's spelling only where the tag is spelled otherwise, and the type where two registers
 * carry it.
 */
export function describeSlmpPoint(p: SlmpPoint): string {
  const type = slmpWords(p) === 2 ? `  ${p.type}` : ''
  const name = slmpAddressName(p)
  return `${p.tag}${name === p.tag ? '' : `  ${name}`}${type}  ${p.dir === 'toPlc' ? 'written to the PLC' : 'read from the PLC'}`
}
