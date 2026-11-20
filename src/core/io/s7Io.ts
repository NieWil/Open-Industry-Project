// S7 over PUT/GET: which scene tag travels in which byte of an S7-1200 / S7-1500's memory.
//
// PUT/GET is the S7 protocol's plain read and write of a CPU's memory areas over TCP port 102, answered once one
// checkbox is ticked in the CPU's properties (src/plc/DEVICE-IO.md). The simulator is the client; the protocol is
// plc/link/s7Client.ts, and this is only the table.
//
// No mapping table is needed: S7 memory is byte-addressed exactly as IEC direct addresses are, so a part's address
// tag is its S7 address (%IX80.4 is I80.4, %QW4 is QW4 = bytes 4-5, %MD10 is MD10 = bytes 10-13). Numbers are
// big-endian: a word's first byte is its high byte, and a REAL is its IEEE 754 bits in that order.
//
// Data blocks are spelled without the % (a % tag is an IEC address to the whole scene): DB10.DBX0.0, DB10.DBB2,
// DB10.DBW4, DB10.DBD6. Only a standard DB has those offsets. A new 1200/1500 DB is "optimized" by default, which
// leaves PUT/GET nothing to address, so the link says to untick "Optimized block access" when the CPU refuses one
// (plc/link/s7Client.ts). A DB address is not an IEC address, so the table reports a second spelling of one address
// instead of letting two tags write the same bytes.
//
// Direction: I is the program's inputs (the simulator writes them), Q its outputs (the simulator reads them).
// Writing I works on any address no module occupies (the CPU refreshes module addresses every cycle). M and a DB
// have no direction of their own, so they take the wiring's: a tag a part writes travels to the PLC, one a part only
// reads comes from it.

import { canonicalAddress, looksLikeAddress, parseDirectAddress, sizeWord } from './iecAddress'
import type { TagSignal } from './externalIo'

export type S7Area = 'I' | 'Q' | 'M' | 'DB'
/** bit, byte, word (2 bytes), double word (4 bytes) */
export type S7Size = 'X' | 'B' | 'W' | 'D'
/** How a point's bytes hold its value. BOOL is a bit; BYTE is unsigned, INT and DINT signed, REAL IEEE 754. */
export type S7Type = 'BOOL' | 'BYTE' | 'INT' | 'DINT' | 'REAL'

/** Where a point sits in the CPU's memory. */
export interface S7Location {
  area: S7Area
  /** DB only: which data block */
  db?: number
  /** the first byte */
  byte: number
  /** for a bit: which bit of that byte */
  bit?: number
  size: S7Size
}

export interface S7Point extends S7Location {
  /** the scene tag: an I/O address's canonical spelling, or a DB address as the parts spell it */
  tag: string
  type: S7Type
  /** toPlc: the simulator writes it (a sensor); fromPlc: the PLC writes it (a motor) */
  dir: 'toPlc' | 'fromPlc'
}

/** The simulator as an S7 client of a CPU. */
export interface S7ClientIo {
  protocol: 's7'
  host: string
  /** 102, the ISO-on-TCP port, unless something forwards it */
  port: number
  /** where the CPU sits: rack 0, slot 1 on an S7-1200 or S7-1500 (slot 0 also reaches a 1200) */
  rack: number
  slot: number
  points: S7Point[]
}

/** The bytes a size occupies. */
export function s7Bytes(size: S7Size): 1 | 2 | 4 {
  return size === 'W' ? 2 : size === 'D' ? 4 : 1
}

/** The last byte an S7 address reaches: its offset is carried in bits, in 3 bytes (and 1200/1500 areas are far smaller anyway). */
const MAX_BYTE = 0xffff
/** DB numbers run 1-65535 (DB0 does not exist). */
const MAX_DB = 0xffff

/** The S7 location an IEC direct address names, or why it cannot travel over S7. */
export function s7PointFor(address: string): S7Location | { error: string } {
  const a = parseDirectAddress(address)
  if ('error' in a) return a
  if (a.size === 'L') return { error: `${a.text} is a ${sizeWord(a.size)} address; bits, bytes, words and double words travel over S7, a ${sizeWord(a.size)} does not` }
  const byte = a.fields[0]!
  if (byte + s7Bytes(a.size) - 1 > MAX_BYTE) return { error: `${a.text} is past the last byte S7 reaches (${MAX_BYTE})` }
  return a.size === 'X' ? { area: a.area, byte, bit: a.fields[1]!, size: 'X' } : { area: a.area, byte, size: a.size }
}

/** DB10.DBX0.0, db10.dbw4, DB10.DBD6: a data block address in any case. Anything else is not one. */
const DB_SHAPE = /^DB(\d+)\.DB([XBWD])(\d+)(?:\.(\d+))?$/i

/** Does the tag read as a data block address at all (well-formed or not)? */
export function looksLikeDbAddress(tag: string): boolean {
  return /^DB\d+\.DB/i.test(tag.trim())
}

/** The location a data block address names (DB10.DBW4), or why it is not one S7 can reach. */
export function s7DbPointFor(raw: string): (S7Location & { text: string }) | { error: string } {
  const s = raw.trim()
  const m = DB_SHAPE.exec(s)
  if (!m) return { error: `${s} is not a data block address; one reads like DB10.DBX0.0 (a bit), DB10.DBB2 (a byte), DB10.DBW4 (a word) or DB10.DBD6 (a double word)` }
  const db = Number(m[1])
  const size = m[2]!.toUpperCase() as S7Size
  const byte = Number(m[3])
  if (db < 1 || db > MAX_DB) return { error: `${s}: data blocks are numbered 1 to ${MAX_DB}` }
  if (size === 'X') {
    if (m[4] === undefined) return { error: `${s}: a bit address is byte.bit, like DB${db}.DBX${byte}.0` }
    if (Number(m[4]) > 7) return { error: `${s}: bit ${m[4]} does not exist in a byte (0-7)` }
  } else if (m[4] !== undefined) return { error: `${s}: only a bit (DBX) has a .bit; a ${sizeWord(size)} is one number, like DB${db}.DB${size}${byte}` }
  if (byte + s7Bytes(size) - 1 > MAX_BYTE) return { error: `${s} is past the last byte S7 reaches (${MAX_BYTE})` }
  const loc: S7Location = size === 'X' ? { area: 'DB', db, byte, bit: Number(m[4]), size } : { area: 'DB', db, byte, size }
  return { ...loc, text: s7AddressName(loc) }
}

/** "I80.4", "IB3", "QW4", "MD10", "DB10.DBX0.0", "DB10.DBW4": a point in the S7 spelling, as the CPU's own tools show it. */
export function s7AddressName(p: Pick<S7Location, 'area' | 'db' | 'byte' | 'bit' | 'size'>): string {
  if (p.area === 'DB') return p.size === 'X' ? `DB${p.db}.DBX${p.byte}.${p.bit}` : `DB${p.db}.DB${p.size}${p.byte}`
  return p.size === 'X' ? `${p.area}${p.byte}.${p.bit}` : `${p.area}${p.size}${p.byte}`
}

/** The tag a scene part carries, with which way the parts use it (plc/wiring.ts SceneTagWiring has both). */
export interface S7TagSignal extends TagSignal {
  /** how many parts write the tag; an M or DB tag a part writes travels to the PLC */
  writers?: number
}

/**
 * The table a scene's address tags make: every %I, %Q and %M tag at the bytes its address names, and every data block
 * address (DB10.DBW4) at its block's. A word is INT and a byte BYTE; a double word is DINT when the tag carries a whole
 * number and REAL otherwise (a speed, a distance), as over Modbus (core/io/externalIo.ts). Tags that are neither are left
 * out: they are program names, which only the in-process program reads.
 *
 * Two points that share a byte clash unless both are bits (I80.0 and I80.1 are two signals; IB80 and I80.0 are
 * one value written two ways). The later of a clashing pair is reported and left out, so its device visibly gets
 * nothing instead of both flickering. The same goes for one DB address spelled two ways (db10.dbw4 and
 * DB10.DBW4 are two scene tags, but one word in the CPU).
 */
export function s7ClientFromTags(
  cpu: { host: string; port?: number; rack?: number; slot?: number },
  tags: readonly (string | S7TagSignal)[],
): { io: S7ClientIo; problems: { tag: string; message: string }[] } {
  const points: S7Point[] = []
  const problems: { tag: string; message: string }[] = []
  const seen = new Set<string>()
  // per `${area}${db}:${byte}`: the tag holding the whole byte, or the tags holding bits of it
  const whole = new Map<string, string>()
  const bits = new Map<string, string>()
  // a DB address by its S7 spelling: the tag that spelled it first
  const spelled = new Map<string, string>()
  for (const entry of tags) {
    const raw = typeof entry === 'string' ? entry : entry.name
    let tag: string
    let at: S7Location
    if (looksLikeAddress(raw)) {
      tag = canonicalAddress(raw) ?? raw
      if (seen.has(tag)) continue
      seen.add(tag)
      const point = s7PointFor(tag)
      if ('error' in point) {
        problems.push({ tag, message: point.error })
        continue
      }
      at = point
    } else {
      // a DB address: kept as the part spells it, since that is the scene tag's key
      if (!looksLikeDbAddress(raw)) continue
      tag = raw
      if (seen.has(tag)) continue
      seen.add(tag)
      const point = s7DbPointFor(raw)
      if ('error' in point) {
        problems.push({ tag, message: point.error })
        continue
      }
      const first = spelled.get(point.text)
      if (first !== undefined) {
        problems.push({ tag, message: `is ${point.text}, which ${first} already carries spelled another way, so over the link the two would overwrite each other; ${tag} is left out. Spell it the same in both parts` })
        continue
      }
      spelled.set(point.text, tag)
      const { text: _text, ...loc } = point
      at = loc
    }
    const area = at.area === 'DB' ? `DB${at.db}` : at.area
    const keys = Array.from({ length: s7Bytes(at.size) }, (_, i) => `${area}:${at.byte + i}`)
    const clash = keys.map((k) => whole.get(k) ?? (at.size === 'X' ? undefined : bits.get(k))).find((t) => t !== undefined)
    if (clash !== undefined) {
      problems.push({ tag, message: `shares a byte with ${clash}, so over the link the two would overwrite each other; ${tag} is left out. Give one of them an address of its own` })
      continue
    }
    for (const k of keys) {
      if (at.size !== 'X') whole.set(k, tag)
      else if (!bits.has(k)) bits.set(k, tag)
    }
    const carries = typeof entry === 'string' ? undefined : entry.type
    const type: S7Type = at.size === 'X' ? 'BOOL' : at.size === 'B' ? 'BYTE' : at.size === 'W' ? 'INT' : carries === 'INT' || carries === 'DINT' ? 'DINT' : 'REAL'
    const writers = typeof entry === 'string' ? 0 : (entry.writers ?? 0)
    const dir = at.area === 'I' ? 'toPlc' : at.area === 'Q' ? 'fromPlc' : writers > 0 ? 'toPlc' : 'fromPlc'
    points.push({ tag, ...at, type, dir })
  }
  const order = (p: S7Point): number => ['I', 'Q', 'M', 'DB'].indexOf(p.area) * 2 ** 40 + (p.db ?? 0) * 2 ** 20 + p.byte * 8 + (p.bit ?? 0)
  points.sort((a, b) => order(a) - order(b))
  return { io: { protocol: 's7', host: cpu.host, port: cpu.port ?? 102, rack: cpu.rack ?? 0, slot: cpu.slot ?? 1, points }, problems }
}

/** "192.168.0.1 (rack 0, slot 1)", with the port only when it is not ISO-on-TCP's 102. */
export function s7Endpoint(cpu: Pick<S7ClientIo, 'host' | 'port' | 'rack' | 'slot'>): string {
  return `${cpu.host}${cpu.port === 102 ? '' : `:${cpu.port}`} (rack ${cpu.rack}, slot ${cpu.slot})`
}

/** The tags the PLC drives: everything the simulator reads back. */
export function s7DrivenTags(io: S7ClientIo): string[] {
  return io.points.filter((p) => p.dir === 'fromPlc').map((p) => p.tag)
}

/**
 * "%IX80.4  I80.4  written to the PLC", "%QD84  QD84  REAL  read from the PLC", "DB10.DBW4  written to the PLC": a
 * point as the dock lists it, its S7 spelling only where the tag is spelled otherwise.
 */
export function describeS7Point(p: S7Point): string {
  const type = p.size === 'D' ? `  ${p.type}` : ''
  const name = s7AddressName(p)
  return `${p.tag}${name === p.tag ? '' : `  ${name}`}${type}  ${p.dir === 'toPlc' ? 'written to the PLC' : 'read from the PLC'}`
}
