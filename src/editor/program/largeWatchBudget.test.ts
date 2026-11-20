// The budget for a large program's value table: half a million values, which large arrays of structures reach. Its
// cost is in the keys, not the values: listing them is hundreds of milliseconds, so anything done per table or per
// tag holds the main thread. Nothing else notices such work coming back: every program in the other tests publishes a
// few dozen values.
//
// Both gates are ratios taken in one process, so the machine's load divides out. Each was measured to fail with the
// thing it guards switched off.

import { afterEach, describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, type PartPackage } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import { markKeySet } from '../../core/watchKeys'
import { LocalPlcLink, type TagValue } from '../../plc'
import { checkWiring, type WiringPart } from '../../plc/wiring'
import { forceKeyOf } from './plcForces'
import { resolveWatch } from './plcWatchList'
import { keysByUpper } from './stLang'

const ARRAYS = 200
const FIELDS = ['a', 'b', 'c', 'd', 'e']
const WIRED = 60

/** A table with the keys the program below publishes, built directly: this half needs no compile. */
function table(tick: number): Record<string, TagValue> {
  const out: Record<string, TagValue> = {}
  for (let t = 0; t < ARRAYS; t++) for (let i = 0; i < 512; i++) for (const f of FIELDS) out[`Main.T${t}[${i}].${f}`] = f === 'c' ? i % 2 === 0 : i + tick
  for (let w = 0; w < WIRED; w++) out[`Main.Eye${w}`] = false
  return out
}

const ms = (run: () => void): number => {
  const t = performance.now()
  run()
  return performance.now() - t
}

afterEach(() => clearPackages())

describe("a large program's value table", () => {
  it('is indexed once per program by its readers, not once per send', () => {
    const set = {}
    const read = (tick: number): void => {
      const values = table(tick)
      markKeySet(values, set) // as the sim client marks each table of one program
      expect(forceKeyOf('main.eye0', values)).toBe('Main.Eye0')
      expect(resolveWatch('MAIN.T7[3].A', values).value).toBe(3 + tick)
      expect(resolveWatch('Main.T7[3]', values).members).toHaveLength(FIELDS.length)
      expect(keysByUpper(values).get('MAIN.EYE1')).toBe('Main.Eye1')
    }
    const building = ms(() => table(0)) // what a send costs this test before any reader sees it
    const first = ms(() => read(0)) - building
    const SENDS = 20
    const later =
      ms(() => {
        for (let tick = 1; tick <= SENDS; tick++) read(tick)
      }) -
      building * SENDS
    // each later send is a few lookups; the first one built three indexes. Per send that was ~1x the first.
    expect(later).toBeLessThan(Math.max(first, 50) * 4)
  })

  it('is read once by the wiring check, however many tags are wired', () => {
    const SENSOR: PartPackage = {
      format: PACKAGE_FORMAT,
      id: 't.sensor',
      name: 't.sensor',
      commsParam: 'enableComms',
      params: { enableComms: { type: 'boolean', default: false }, tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
      behavior: 'definePart({step(){}})',
      geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
    }
    registerPackage(SENSOR)
    const link = new LocalPlcLink(`TYPE Rec : STRUCT a : DINT; b : DINT; c : BOOL; d : DINT; e : DINT; END_STRUCT; END_TYPE
VAR
${Array.from({ length: ARRAYS }, (_, t) => `  T${t} : ARRAY[0..511] OF Rec;`).join('\n')}
${Array.from({ length: WIRED }, (_, w) => `  Eye${w} : BOOL;`).join('\n')}
END_VAR
Eye0 := Eye1;`)
    expect(Object.keys(link.watch).length).toBeGreaterThan(500_000)
    const parts: WiringPart[] = Array.from({ length: WIRED }, (_, w) => ({ id: `s${w}`, type: 'part', packageId: 't.sensor', params: { enableComms: true, tag: `Eye${w}` } }))
    const oneRead = Math.min(ms(() => void link.watch), ms(() => void link.watch))
    const check = ms(() => expect(checkWiring(parts, link).tags).toHaveLength(WIRED))
    expect(check).toBeLessThan(Math.max(oneRead, 20) * 6)
  })
})
