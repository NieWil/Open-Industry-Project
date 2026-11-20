// EtherNet/IP: the external-PLC link by name to a Logix controller (ControlLogix, CompactLogix), a Micro800, or
// anything that answers CIP the same way. core/io/opcUa.ts is the other by-name link; core/io/externalIo.ts the by-address one, over
// Modbus.
//
// A Logix controller's tags are symbolic: the simulator asks for `Eye`, `Program:MainProgram.Eye`, `Lane[3]` or
// `Status.3` (bit 3 of a DINT) by the name the PLC itself uses, and the controller answers with the value and its
// CIP type. So nothing is browsed and nothing is matched: a part's PLC tag is the request. This module decides
// what to ask for and what the answers mean: which tags travel which way, whether the PLC's type for a tag fits
// what the parts carry, and how a scene value is written as that type. Logix names ignore case, and so does the
// controller, so a tag is sent as the part spells it.
//
// This module is pure: libplctag speaks the protocol in the desktop shell (apps/desktop/eipIo.cjs), and the
// session that joins it to the running scene is editor/links/externalPlc.ts.

export { eipEndpoint, eipTarget, isEipFamily } from './eipTarget'
export type { EipFamily, EipTarget } from './eipTarget'
import { looksLikeAddress } from './iecAddress'
import type { SceneTagWiring } from './opcUa'
import { groupVariables } from './plcVariables'
import type { PlcVariable, PlcVariableGroup } from './plcVariables'

/** A scene tag the link carries, and which way. */
export interface EipPoint {
  tag: string
  /** toPlc: a part publishes it and the simulator writes the tag; fromPlc: parts read it and the simulator reads it */
  dir: 'toPlc' | 'fromPlc'
  /** what the parts carry, when they agree */
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
  /** a bit of an integer tag (`Status.3`): read and written as that one bit */
  bit: boolean
}

/** A point with the PLC's own type for it, learned from its first answer. */
export interface EipBinding extends EipPoint {
  /** the CIP elementary type code the controller answered with (0xC1 BOOL ... 0xCA REAL) */
  cip: number
}

/** `Status.3`, `Prog:Main.Word.15`: a bit member, which libplctag reads and writes as one bit of the integer. */
export function isBitTag(tag: string): boolean {
  return /\.\d+$/.test(tag)
}

/** A Logix tag name: a symbol, optionally a program scope (`Program:Main.`), members, array indices, a bit. */
const TAG_NAME = /^(Program:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*(\[\d+(,\d+){0,2}\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d+(,\d+){0,2}\])?)*(\.\d+)?$/

/**
 * The points a scene makes over EtherNet/IP: every tag a part is wired to by name. A tag a part publishes is
 * written to the PLC (a part that also reads it reads the scene's own value); one parts only read is read from it.
 * An I/O address is not a Logix name, so it is reported rather than carried, and so is a name the controller
 * could never hold.
 */
export function eipPointsFromTags(tags: readonly SceneTagWiring[]): { points: EipPoint[]; problems: string[] } {
  const points: EipPoint[] = []
  const problems: string[] = []
  for (const t of tags) {
    if (t.writers.length === 0 && t.readers.length === 0) continue
    if (looksLikeAddress(t.name)) {
      problems.push(`${t.name} is an I/O address; over EtherNet/IP a part is wired by the controller's tag name (like Eye or Program:MainProgram.Eye)`)
      continue
    }
    if (!TAG_NAME.test(t.name)) {
      problems.push(`${t.name} is not a tag name a Logix controller can hold (letters, digits and _, like Eye, Program:MainProgram.Eye, Lane[3] or Status.3)`)
      continue
    }
    const bit = isBitTag(t.name)
    if (bit && t.type !== null && t.type !== 'BOOL') {
      problems.push(`${t.name} is one bit, and the parts carry a number`)
      continue
    }
    points.push({ tag: t.name, dir: t.writers.length > 0 ? 'toPlc' : 'fromPlc', type: t.type, bit })
  }
  points.sort((a, b) => a.tag.localeCompare(b.tag))
  return { points, problems }
}

/** CIP elementary types a scene value can travel as, by code (CIP Vol 1, C-6.1). */
const CIP: Record<number, { name: string; kind: 'bool' | 'int' | 'float'; min?: number; max?: number }> = {
  0xc1: { name: 'BOOL', kind: 'bool' },
  0xc2: { name: 'SINT', kind: 'int', min: -128, max: 127 },
  0xc3: { name: 'INT', kind: 'int', min: -32768, max: 32767 },
  0xc4: { name: 'DINT', kind: 'int', min: -2147483648, max: 2147483647 },
  0xc6: { name: 'USINT', kind: 'int', min: 0, max: 255 },
  0xc7: { name: 'UINT', kind: 'int', min: 0, max: 65535 },
  0xc8: { name: 'UDINT', kind: 'int', min: 0, max: 4294967295 },
  0xca: { name: 'REAL', kind: 'float' },
  0xcb: { name: 'LREAL', kind: 'float' },
}

/** The type's Logix name ("DINT"), or what the code is when no scene value travels as it. */
export function cipTypeName(cip: number): string {
  if (CIP[cip]) return CIP[cip].name
  if (cip === 0xc5) return 'LINT'
  if (cip === 0xa0 || cip === 0xa002) return 'a structure'
  return `CIP type 0x${cip.toString(16)}`
}

/**
 * Bind a point to the type the controller answered with. Refused, with the reason: a structure or another type no
 * scene value travels as, and a bit on a number or the reverse. A bit member is a bit whatever its integer's type.
 */
export function bindEipPoint(p: EipPoint, cip: number): { binding: EipBinding } | { error: string } {
  const t = CIP[cip]
  if (!t) return { error: `${p.tag}: the controller holds it as ${cipTypeName(cip)}, not a single bit or number` }
  if (p.bit) {
    if (t.kind !== 'int') return { error: `${p.tag}: a bit is taken from an integer tag, and this one is ${t.name}` }
    return { binding: { ...p, cip } }
  }
  if (p.type !== null && (p.type === 'BOOL') !== (t.kind === 'bool')) {
    return { error: `${p.tag}: the parts carry a ${p.type === 'BOOL' ? 'bit' : 'number'}, and the controller holds it as ${t.name}` }
  }
  return { binding: { ...p, cip } }
}

/** A scene value as a tag of `cip` takes it: a bit as true/false, a whole number rounded and held in range. */
export function toEipValue(b: Pick<EipBinding, 'cip' | 'bit'>, v: unknown): boolean | number {
  const t = CIP[b.cip]
  if (b.bit || !t || t.kind === 'bool') return typeof v === 'string' ? v !== '' : Boolean(v)
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number.NaN
  const x = Number.isFinite(n) ? n : 0
  if (t.kind === 'float') return x
  return Math.min(t.max!, Math.max(t.min!, Math.round(x)))
}

/** A tag's value as a scene tag: a BOOL or a bit as true/false, any other as a number. */
export function fromEipValue(b: Pick<EipBinding, 'cip' | 'bit'>, v: unknown): boolean | number {
  if (b.bit || b.cip === 0xc1) return Boolean(v)
  const n = typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * libplctag status names that mean nothing answered: no reply in time, or the socket, session or connection failed.
 * On these the link retries the whole connection; anything else came back from the far end and is about the request.
 *
 * Read off libplctag's own table of CIP errors (src/libplctag/protocols/ab/error_codes.c, v2.7.2): a
 * controller's answer is translated there, and a status that only an answer can produce is left out, however it
 * sounds. So REMOTE_ERR is not here: it is that table's "Unknown error code", "Miscellaneous" and "Store operation
 * failure", every one of them a reply. Treating it as silence would cycle the connection forever on one bad tag.
 */
const UNREACHABLE = new Set(['PLCTAG_ERR_TIMEOUT', 'PLCTAG_ERR_BAD_CONNECTION', 'PLCTAG_ERR_BAD_GATEWAY', 'PLCTAG_ERR_WINSOCK', 'PLCTAG_ERR_OPEN', 'PLCTAG_ERR_READ', 'PLCTAG_ERR_WRITE', 'PLCTAG_ERR_BAD_REPLY', 'PLCTAG_ERR_ABORT'])

export function eipUnreachable(status: string): boolean {
  return UNREACHABLE.has(status)
}

/**
 * Statuses a wrong path produces as well as a missing tag. A real Ethernet module answers a route to an empty or
 * wrong slot itself (CIP 0x01/0x0312 "Link Address Not Valid" and 0x05 "Path Destination Error" are BAD_PARAM,
 * 0x01/0x0311 "Port Not Available" and 0x01/0x0800 "Network Link Offline" BAD_DEVICE), and a missing tag is 0x04
 * NOT_FOUND - or BAD_PARAM from libplctag's own simulator. One tag failing so is that tag; every tag failing so is
 * far more often the path, which is why {@link eipNothingAnswered} exists.
 */
const MISSING_OR_ROUTE = new Set(['PLCTAG_ERR_NOT_FOUND', 'PLCTAG_ERR_BAD_PARAM', 'PLCTAG_ERR_BAD_DEVICE'])

/**
 * When the controller answered for none of the tags, and every answer is one a wrong path also gives: one sentence
 * that says to check the path first, rather than a "no tag named ..." for each tag, which sends you to the program
 * for what is a slot number. Null when any tag answered, or a failure says something else.
 */
export function eipNothingAnswered(tags: readonly string[], statuses: readonly string[], path: string): string | null {
  if (tags.length === 0 || statuses.length !== tags.length || !statuses.every((s) => MISSING_OR_ROUTE.has(s))) return null
  const shown = tags.length <= 3 ? tags.join(', ') : `${tags.slice(0, 3).join(', ')} and ${tags.length - 3} more`
  return `the address answered, but none of the tags did (${shown}; ${statuses[0]}). Check ${routeText(path)} first: a route to the wrong slot makes every tag look missing, then check the tag names`
}

function routeText(path: string): string {
  return path ? `the path (${path}: the backplane, then the controller's slot)` : 'that the address is the controller itself (the path is empty)'
}

/** A tag as the controller lists it (apps/desktop/eipIo.cjs listTags): its name and its symbol type. */
export interface EipListedTag {
  name: string
  type: number
}

/**
 * The listed tags a part can be wired to, sorted: a BOOL or a number each. In a symbol type, bit 15 marks a
 * structure, bit 12 a system tag and bits 13-14 array dimensions, so any of those is left out. Otherwise the low byte
 * is the CIP type code, and bits 8-10 hold a BOOL's bit position. A hidden name (`__`) is left out too.
 */
export function eipTagNames(tags: readonly EipListedTag[]): string[] {
  return tags
    .filter(eipWireable)
    .map((t) => t.name)
    .sort((a, b) => a.localeCompare(b))
}

function eipWireable(t: EipListedTag): boolean {
  const code = t.type & 0xff
  if ((t.type & 0xf000) !== 0 || !CIP[code] || ((t.type & 0x0f00) !== 0 && code !== 0xc1)) return false
  return TAG_NAME.test(t.name) && !isBitTag(t.name) && !/(^|\.)__/.test(t.name)
}

/**
 * The listing as the PLC connections window shows it: the tags {@link eipTagNames} keeps, the controller's own in the
 * '' group first, then one group per program (`Program:MainProgram`).
 */
export function eipVariableGroups(tags: readonly EipListedTag[]): PlcVariableGroup[] {
  const variables: PlcVariable[] = tags.filter(eipWireable).map((t) => {
    const scoped = /^(Program:[^.]+)\.(.+)$/.exec(t.name)
    const c = CIP[t.type & 0xff]!
    return { name: t.name, short: scoped ? scoped[2]! : t.name, typeName: c.name, kind: c.kind === 'bool' ? 'bool' : 'number' }
  })
  return groupVariables(variables, (v) => (v.name === v.short ? '' : v.name.slice(0, v.name.length - v.short.length - 1)), (g) => (g === '' ? 0 : 1))
}

/** Why the controller's tags could not be listed, from libplctag's status for the listing. */
export function eipListingFailure(status: string, path: string): string {
  if (status === 'PLCTAG_ERR_UNSUPPORTED') return `the controller does not list its tags (${status}); type them as the program names them`
  if (eipUnreachable(status)) return `the controller did not answer (${status})`
  if (MISSING_OR_ROUTE.has(status)) return `the address answered, but no controller did (${status}). Check ${routeText(path)}`
  return `the controller refused to list its tags (${status})`
}

/** What a libplctag status means for one tag, in a sentence. */
export function eipStatusMessage(tag: string, status: string): string {
  if (status === 'PLCTAG_ERR_NOT_FOUND' || status === 'PLCTAG_ERR_BAD_PARAM') return `the controller has no tag named ${tag}`
  if (status === 'PLCTAG_ERR_BAD_DEVICE') return `${tag}: the path does not lead to a controller (${status})`
  if (status === 'PLCTAG_ERR_REMOTE_ERR') return `${tag}: the controller refused the request with an error libplctag does not name (${status})`
  if (status === 'PLCTAG_ERR_NOT_ALLOWED') return `the controller does not let this client write ${tag} (its External Access is Read Only or None)`
  if (status === 'PLCTAG_ERR_TOO_SMALL' || status === 'PLCTAG_ERR_TOO_LARGE' || status === 'PLCTAG_ERR_OUT_OF_BOUNDS') return `${tag}: the controller's answer is not the size its type says (${status})`
  if (status === 'PLCTAG_ERR_UNSUPPORTED') return `${tag}: the controller does not support that request (${status})`
  return `${tag}: ${status}`
}
