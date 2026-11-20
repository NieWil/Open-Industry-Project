// The published reference page (guides/reference/index.html, /guides/reference/) states defaults, address rules,
// timings and types as plain tables, for people. Each table it marks `data-check` is read here and compared with
// the code that decides it, so a change to a default, a rule or a type mapping fails this spec, naming the row,
// until the page says the same. The step-by-step guides are checked by following them (e2e/guide-*.mjs); this page
// has no steps to follow, so it is checked against the code instead.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { adsPointsFromTags, adsTypeName, bindAdsPoint } from '../core/io/ads'
import { modbusPointFor, registerImagePointFor, registerImagePointWhere } from '../core/io/externalIo'
import { s7AddressName, s7ClientFromTags } from '../core/io/s7Io'
import { planIoAssignment } from '../plc/ioAssign'
import type { IoTagUse } from '../plc/ioAssign'
import { CLIENT_ANSWER_MS, CLIENT_POLL_MS, CLIENT_RETRY_MS, POLL_TIMEOUT_MS } from './links/externalPlc'
import { builtinFor } from './links/opcUaServer'
import { DEFAULT_EXTERNAL_PLC } from './store/storePrefs'

const html = readFileSync(new URL('../../guides/reference/index.html', import.meta.url), 'utf8')

const text = (cell: string): string =>
  cell
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

/** The body rows of the table marked `data-check="<name>"`: each row's attributes and its cells' text. */
function rows(name: string): { attrs: Record<string, string>; cells: string[] }[] {
  const table = new RegExp(`<table[^>]*data-check="${name}"[^>]*>([\\s\\S]*?)</table>`).exec(html)?.[1]
  if (!table) throw new Error(`the reference page has no table data-check="${name}"`)
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? ''
  const found = [...body.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map((m) => ({
    attrs: Object.fromEntries([...m[1]!.matchAll(/data-([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])),
    cells: [...m[2]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]!)),
  }))
  // an empty table would pass every check below without checking anything
  if (found.length === 0) throw new Error(`the reference page's table data-check="${name}" has no rows`)
  return found
}

const AREA_WORD = { discreteInput: 'discrete input', coil: 'coil', inputRegister: 'input register', holdingRegister: 'holding register' } as const
/** OPC UA built-in type ids by name (OPC UA Part 6). */
const BUILTIN_NAME: Record<number, string> = { 1: 'Boolean', 2: 'SByte', 3: 'Byte', 4: 'Int16', 5: 'UInt16', 6: 'Int32', 7: 'UInt32', 10: 'Float', 11: 'Double', 12: 'String' }

describe('the published PLC connection reference (guides/reference/)', () => {
  it('states the defaults the app ships', () => {
    for (const { attrs, cells } of rows('defaults')) {
      const key = attrs.key as keyof typeof DEFAULT_EXTERNAL_PLC
      expect(key in DEFAULT_EXTERNAL_PLC, `no default named ${key}`).toBe(true)
      // an empty default is said in words (`data-empty`), since a blank cell reads as a missing one
      const said = attrs.empty !== undefined ? '' : cells[1]
      expect(said, `the default for ${key} ("${cells[0]}")`).toBe(String(DEFAULT_EXTERNAL_PLC[key]))
    }
  })

  it("states where an address lands when the simulator is the Modbus server", () => {
    for (const { cells } of rows('server-points')) {
      const point = modbusPointFor(cells[0]!)
      if ('error' in point) throw new Error(`${cells[0]}: ${point.error}`)
      const where = point.words === 2 ? `${AREA_WORD[point.area]}s ${point.address}-${point.address + 1}` : `${AREA_WORD[point.area]} ${point.address}`
      expect(cells[1], cells[0]).toBe(where)
    }
  })

  it('states which register an address is when the simulator polls the PLC (bases 0)', () => {
    for (const { cells } of rows('client-points')) {
      const point = registerImagePointFor(cells[0]!)
      if ('error' in point) throw new Error(`${cells[0]}: ${point.error}`)
      expect(cells[1], cells[0]).toBe(registerImagePointWhere(point))
    }
  })

  it('states the first address Assign I/O gives each kind of tag', () => {
    for (const { attrs, cells } of rows('assign')) {
      const use: IoTagUse = { name: 'Tag', dir: attrs.dir as 'in' | 'out', stType: attrs.type as IoTagUse['stType'] }
      const plan = planIoAssignment('', [use], [])
      expect(plan.assignments[0]?.address, `${cells[0]} ${cells[1]}`).toBe(cells[2])
    }
  })

  it('states the link timings', () => {
    const value: Record<string, number> = { POLL_TIMEOUT_MS, CLIENT_POLL_MS, CLIENT_ANSWER_MS, CLIENT_RETRY_MS }
    for (const { attrs, cells } of rows('timing')) {
      expect(attrs.key! in value, `no timing named ${attrs.key}`).toBe(true)
      expect(cells[1], cells[0]).toBe(`${value[attrs.key!]} ms`)
    }
  })

  it('states where an S7 address lands in the CPU, as what, and which way', () => {
    for (const { attrs, cells } of rows('s7-points')) {
      const tag = { name: cells[0]!, type: (attrs.type ?? null) as 'DINT' | null, writers: Number(attrs.writers ?? 0) }
      const { io, problems } = s7ClientFromTags({ host: 'cpu' }, [tag])
      expect(problems, cells[0]).toEqual([])
      const p = io.points[0]!
      expect([s7AddressName(p), p.type, p.dir === 'toPlc' ? 'written to the PLC' : 'read from the PLC'], cells[0]).toEqual(cells.slice(1))
    }
  })

  it('states what S7 refuses', () => {
    for (const { cells } of rows('s7-refused')) {
      const { io, problems } = s7ClientFromTags({ host: 'cpu' }, [{ name: cells[0]!, type: null, writers: 1 }])
      expect(io.points, cells[0]).toEqual([])
      expect(problems.length, cells[0]).toBe(1)
    }
  })

  it('states which names travel over ADS', () => {
    for (const { cells } of rows('ads-symbols')) {
      const { points } = adsPointsFromTags([{ name: cells[0]!, writers: ['part'], readers: [], type: 'BOOL' }])
      expect(points.length === 1 ? 'yes' : 'no', cells[0]).toBe(cells[1]!.split(':')[0])
    }
  })

  it('states which ADS types travel', () => {
    for (const { attrs, cells } of rows('ads-types')) {
      const codes = attrs.ads!.split(',').map(Number)
      const carried = cells[1]!.split(':')[0] === 'yes'
      if (carried) expect(codes.map(adsTypeName).join(', ')).toBe(cells[0])
      for (const code of codes) {
        // a bit for BOOL, a number for the rest; any size the type could be
        const point = { tag: 'MAIN.X', dir: 'toPlc' as const, type: code === 33 ? ('BOOL' as const) : null }
        const binds = [0, 1, 2, 4, 8, 81].some((size) => 'binding' in bindAdsPoint(point, code, size, ''))
        expect(binds, `${adsTypeName(code)} (ADS type ${code})`).toBe(carried)
      }
    }
  })

  it('states the OPC UA type each IEC type is published as', () => {
    for (const { cells } of rows('ua-types')) {
      for (const iec of cells[0]!.split(',').map((t) => t.trim())) {
        const builtin = builtinFor('Main.X', { type: iec } as Parameters<typeof builtinFor>[1], 0)
        expect(BUILTIN_NAME[builtin], iec).toBe(cells[1])
      }
    }
  })
})
