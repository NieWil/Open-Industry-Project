// ADS: the external-PLC link by name to a TwinCAT runtime. core/io/eip.ts and core/io/opcUa.ts are the other by-name
// links; core/io/externalIo.ts and core/io/s7Io.ts the by-address ones.
//
// A TwinCAT PLC's variables are symbolic: the simulator asks for `MAIN.Eye` or `GVL.Run` by the name the program
// uses, and the runtime answers with the symbol's type and size (ADS "symbol info by name"), then a handle the value
// is read and written through. So, as over EtherNet/IP, a part's PLC tag is the request. This module decides what to
// ask for and what the answers mean. ADS names ignore case, and so does the runtime.
//
// The link goes through the TwinCAT router on this PC, using Beckhoff's TcAdsDll. That is how a local ADS client is
// meant to reach a PLC, and what oip-comms' driver does (tcads_loader.cpp). The router owns the routes and the
// transport to each PLC, so the app has no ADS transport of its own (apps/desktop/adsIo.cjs). The router already
// holds the routes the engineering PC uses to reach its PLCs, so the link needs only the PLC's AMS Net ID.
//
// Pure: TcAdsDll speaks the protocol in the desktop shell (apps/desktop/adsIo.cjs), and the session that joins it to
// the running scene is editor/links/externalPlc.ts.

import { looksLikeAddress } from './iecAddress'
import type { SceneTagWiring } from './opcUa'
import { groupVariables } from './plcVariables'
import type { PlcVariable, PlcVariableGroup } from './plcVariables'

/** A scene tag the link carries, and which way. */
export interface AdsPoint {
  tag: string
  /** toPlc: a part publishes it and the simulator writes the symbol; fromPlc: parts read it and the simulator reads it */
  dir: 'toPlc' | 'fromPlc'
  /** what the parts carry, when they agree */
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
}

/** A point with the runtime's own type for it, from its symbol info. */
export interface AdsBinding extends AdsPoint {
  /** the ADS data type (ADST_*) the runtime reported */
  adsType: number
  /** the symbol's size in bytes */
  size: number
  /** the runtime's name for its type: BOOL, INT, REAL, TIME, E_Mode ... */
  typeName: string
}

/** A TwinCAT symbol: dotted identifiers (`MAIN.Eye`, `GVL.Station.Run`), each optionally indexed (`MAIN.Lane[3]`). */
const SYMBOL = /^[A-Za-z_][A-Za-z0-9_]*(\[\d+(,\d+){0,2}\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d+(,\d+){0,2}\])?)+$/

/**
 * The points a scene makes over ADS: every tag a part is wired to by name. A tag a part publishes is written to the
 * PLC; one parts only read is read from it. An I/O address is reported rather than carried, and so is a name that is
 * not a TwinCAT symbol path - which always names its POU or global list (`MAIN.Eye`, not `Eye`).
 */
export function adsPointsFromTags(tags: readonly SceneTagWiring[]): { points: AdsPoint[]; problems: string[] } {
  const points: AdsPoint[] = []
  const problems: string[] = []
  for (const t of tags) {
    if (t.writers.length === 0 && t.readers.length === 0) continue
    if (looksLikeAddress(t.name)) {
      problems.push(`${t.name} is an I/O address; over ADS a part is wired by the PLC's own name for it (like MAIN.Eye or GVL.Run)`)
      continue
    }
    if (!SYMBOL.test(t.name)) {
      problems.push(`${t.name} is not a TwinCAT symbol name: it starts with the program or global list it lives in, like MAIN.Eye or GVL.Run`)
      continue
    }
    points.push({ tag: t.name, dir: t.writers.length > 0 ? 'toPlc' : 'fromPlc', type: t.type })
  }
  points.sort((a, b) => a.tag.localeCompare(b.tag))
  return { points, problems }
}

/** ADS data types (the ADST_* codes of Beckhoff's published ADS documentation) a scene value can travel as, with their sizes. */
const ADST: Record<number, { name: string; kind: 'bool' | 'int' | 'float'; size: number; min?: number; max?: number }> = {
  33: { name: 'BOOL', kind: 'bool', size: 1 },
  16: { name: 'SINT', kind: 'int', size: 1, min: -128, max: 127 },
  17: { name: 'USINT', kind: 'int', size: 1, min: 0, max: 255 },
  2: { name: 'INT', kind: 'int', size: 2, min: -32768, max: 32767 },
  18: { name: 'UINT', kind: 'int', size: 2, min: 0, max: 65535 },
  3: { name: 'DINT', kind: 'int', size: 4, min: -2147483648, max: 2147483647 },
  19: { name: 'UDINT', kind: 'int', size: 4, min: 0, max: 4294967295 },
  4: { name: 'REAL', kind: 'float', size: 4 },
  5: { name: 'LREAL', kind: 'float', size: 8 },
}

/** The ADS data type's IEC name, or what it is when no scene value travels as it. */
export function adsTypeName(adsType: number): string {
  if (ADST[adsType]) return ADST[adsType].name
  if (adsType === 20 || adsType === 21) return adsType === 20 ? 'LINT' : 'ULINT'
  if (adsType === 30 || adsType === 31) return 'a string'
  if (adsType === 65) return 'a structure or array'
  return `ADS type ${adsType}`
}

/** A symbol's size on the wire: a BOOL may report size 0 (oip-comms init_ads_tag), and it is still one byte. */
function adsBytes(adsType: number, size: number): number {
  return ADST[adsType]?.kind === 'bool' ? Math.max(1, size) : size
}

/** One entry of the runtime's symbol table, as the desktop shell lists it (apps/desktop/adsIo.cjs `ads:symbols`). */
export interface AdsSymbol {
  name: string
  adsType: number
  size: number
  typeName: string
}

/**
 * The names in a symbol table a part's tag can be wired to, sorted: a symbol path whose type is a single bit or number
 * at its own size, the same rule {@link bindAdsPoint} binds by. The table lists each variable whole, so the members of
 * a structure or function block instance (`MAIN.Station.Run`) are not among them.
 */
export function adsTagNames(symbols: readonly AdsSymbol[]): string[] {
  return symbols
    .filter(adsWireable)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b))
}

/** Whether a part's tag can be wired to a symbol: a symbol path whose type is a single bit or number at its own size. */
function adsWireable(s: AdsSymbol): boolean {
  return SYMBOL.test(s.name) && ADST[s.adsType]?.size === adsBytes(s.adsType, s.size)
}

/**
 * The symbol table as the PLC connections window lists it: the symbols {@link adsTagNames} keeps, grouped by the program
 * or list a name starts with. MAIN comes first, as the program a new TwinCAT project starts with; TwinCAT's own lists
 * (`TwinCAT_SystemInfoVarList`) come last.
 */
export function adsSymbolGroups(symbols: readonly AdsSymbol[]): PlcVariableGroup[] {
  const variables: PlcVariable[] = symbols.filter(adsWireable).map((s) => {
    const t = ADST[s.adsType]!
    return { name: s.name, short: s.name.slice(s.name.indexOf('.') + 1), typeName: s.typeName || t.name, kind: t.kind === 'bool' ? 'bool' : 'number' }
  })
  const rank = (g: string): number => (g.toUpperCase() === 'MAIN' ? 0 : g.startsWith('TwinCAT_') ? 2 : 1)
  return groupVariables(variables, (v) => v.name.slice(0, v.name.indexOf('.')), rank)
}

/** An ADS code as a sentence, with this PC's AMS Net ID where a route back to it is the cure. */
export function adsRouteText(code: number, localNetId: string): string {
  const text = adsErrorText(code)
  return (code === 0x7 || code === 0x749) && localNetId ? `${text}. This PC's AMS Net ID is ${localNetId}` : text
}

/**
 * Bind a point to the symbol the runtime described. Refused, with the reason: a structure, a string, a 64-bit integer
 * (a scene number cannot hold one exactly), a size that does not match the type, and a bit where the parts carry a
 * number or the reverse. An enumeration or a TIME arrives as its base integer, which is what it is on the wire.
 */
export function bindAdsPoint(p: AdsPoint, adsType: number, size: number, typeName: string): { binding: AdsBinding } | { error: string } {
  const t = ADST[adsType]
  if (!t) return { error: `${p.tag}: the PLC holds it as ${typeName || adsTypeName(adsType)}, not a single bit or number` }
  const bytes = adsBytes(adsType, size)
  if (bytes !== t.size) return { error: `${p.tag}: the PLC says it is ${typeName} in ${size} bytes, which a ${t.name} is not` }
  if (p.type !== null && (p.type === 'BOOL') !== (t.kind === 'bool')) {
    return { error: `${p.tag}: the parts carry a ${p.type === 'BOOL' ? 'bit' : 'number'}, and the PLC holds it as ${typeName || t.name}` }
  }
  return { binding: { ...p, adsType, size: bytes, typeName: typeName || t.name } }
}

/** A scene value as a symbol of `adsType` takes it: a bit as true/false, a whole number rounded and held in range. */
export function toAdsValue(adsType: number, v: unknown): boolean | number {
  const t = ADST[adsType]
  if (!t || t.kind === 'bool') return typeof v === 'string' ? v !== '' : Boolean(v)
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number.NaN
  const x = Number.isFinite(n) ? n : 0
  if (t.kind === 'float') return x
  return Math.min(t.max!, Math.max(t.min!, Math.round(x)))
}

/** A symbol's value as a scene tag. */
export function fromAdsValue(adsType: number, v: unknown): boolean | number {
  if (adsType === 33) return Boolean(v)
  const n = typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** `192.168.1.20.1.1`, or '' for the runtime on this PC. */
export function isAmsNetId(v: unknown): v is string {
  return typeof v === 'string' && (v === '' || /^(\d{1,3})(\.\d{1,3}){5}$/.test(v)) && v.split('.').every((x) => x === '' || Number(x) <= 255)
}

// ---- what the router and the runtime answer with ----
//
// ADS return codes (Beckhoff's published "ADS Return Codes"), worded as oip-comms ads_err_name words them, with
// what to do about each where there is something to do.

const ROUTE = 'add a route to this PC on the PLC, or check its AMS Net ID'
const ERRORS: Record<number, string> = {
  0x6: 'target port not found: TwinCAT is not running there, or the AMS port is wrong (851 is the first PLC)',
  0x7: `target machine not found: ${ROUTE}`,
  0xf: 'invalid AMS Net ID',
  0x12: 'the port is disabled: the runtime is in Config mode, or the PLC project is not activated',
  0x19: 'out of memory',
  0x1b: 'host unreachable',
  0x700: 'device error',
  0x701: 'service not supported',
  0x702: 'invalid index group',
  0x703: 'invalid index offset or handle',
  0x704: 'read/write access denied',
  0x705: 'invalid data size',
  0x706: 'invalid data',
  0x707: 'device not ready: the runtime is not in Run mode',
  0x708: 'device busy',
  0x70a: 'out of memory',
  0x70b: 'invalid parameter',
  0x70c: 'not found',
  0x70d: 'syntax error',
  0x710: 'the PLC has no symbol by that name',
  0x711: 'the symbol version changed: the PLC was downloaded again',
  0x712: 'invalid state',
  0x718: 'device not initialized',
  0x719: 'device timeout',
  0x721: 'invalid array index',
  0x722: 'the symbol is not active: the PLC was downloaded again',
  0x723: 'access denied',
  0x745: 'no answer in time',
  0x748: 'port not open',
  0x749: `no AMS address: ${ROUTE}`,
}

/** "target port not found: ... (0x6)". */
export function adsErrorText(code: number): string {
  return `${ERRORS[code] ?? 'ADS error'} (0x${code.toString(16)})`
}

/**
 * Codes that mean the whole runtime did not answer, not just one symbol. The router has no route there, the runtime
 * or its PLC is not running, or the answer never came. On these the link drops its handles and asks again after a pause.
 */
const UNREACHABLE = new Set([0x6, 0x7, 0x12, 0x1b, 0x707, 0x718, 0x719, 0x745, 0x748, 0x749])

export function adsUnreachable(code: number): boolean {
  return UNREACHABLE.has(code)
}

/**
 * Codes that mean the PLC was downloaded again under the link: its handles are stale, so it binds anew (the symbols,
 * their types and their handles), as it does after a reconnect. Not a fault the user has to act on.
 */
const STALE = new Set([0x703, 0x711, 0x722])

export function adsStale(code: number): boolean {
  return STALE.has(code)
}

/** What one symbol's code means, in a sentence. */
export function adsSymbolMessage(tag: string, code: number): string {
  if (code === 0x710) return `the PLC has no symbol named ${tag} (0x710)`
  if (code === 0x704 || code === 0x723) return `the PLC does not let this client write ${tag} (${adsErrorText(code)})`
  return `${tag}: ${adsErrorText(code)}`
}
