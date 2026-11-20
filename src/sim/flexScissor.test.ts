/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { flexStations } from '../core/conveyor/flexPath'
import { evalPartGeometry } from '../core/geometry/geometryEval'
import { resolvePartParams } from '../core/parts/partScript'
import type { ParamSchema, ParamValue } from '../core/parts/partApi'
import { buildPackage } from './buildPackage'

// The Flex Conveyor's scissor truss (examples/parts/flex-conveyor): its links are one fixed length, as a real unit's
// are, so the truss deepens as the bed closes, flattens as it opens, and stands taller on the inside of a bend than
// the outside. Checked on the part's own lazy-tongs rule (scissorBottoms) and on the geometry it draws.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dir = join(repo, 'examples', 'parts', 'flex-conveyor')
const source = readFileSync(join(dir, 'behavior.ts'), 'utf8')
const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as { id: string; name: string; geometry: never; materials?: never }
const pkg = buildPackage({ id: rig.id, name: rig.name, geometry: rig.geometry, materials: rig.materials }, source)
const N = 16
const K = 8
const TOP = -0.024 // the roller axles: the truss's top pivots
/** the part's own lazy-tongs rule, run from its source: bottom pivots under the rollers between the ends of `xs` */
const scissorBottoms = new Function('definePart', `${source}\n;return scissorBottoms`)(() => {}) as (xs: number[], top: number, link: number) => [number, number][]
/** the scissor link length, pivot to pivot: the part's own SCISSOR_LINK, read from its source the same way */
const LINK = new Function('definePart', `${source}\n;return SCISSOR_LINK`)(() => {}) as number

/** the steel drawn for section `i`, its vertices part-local to the section */
function sectionSteel(params: Record<string, ParamValue>, i: number): number[] {
  const parts = evalPartGeometry(source, resolvePartParams(pkg.params as ParamSchema, params))!
  const steel = parts.find((p) => (p as { link?: string }).link === `s${i}` && (p as { material?: string }).material === 'steel')!
  return (steel as unknown as { desc: { positions: number[] } }).desc.positions
}
const lowest = (pos: number[], side?: 1 | -1): number => {
  let min = Infinity
  for (let v = 0; v < pos.length; v += 3) if (side === undefined || Math.sign(pos[v + 2]!) === side) min = Math.min(min, pos[v + 1]!)
  return min
}
const straight = (length: number): Record<string, ParamValue> => ({ points: [[length / 3, 0], [(2 * length) / 3, 0], [length, 0]], length })

describe('Flex Conveyor scissor truss', () => {
  it('every link is the same length, whatever the rollers do', () => {
    // roller spacings anywhere from fully collapsed (58 mm) to fully extended (188 mm), uneven as a bend makes them
    let x = 0
    const xs = [x]
    for (let i = 0; i < 40; i++) xs.push((x += 0.058 + ((i * 7919) % 131) / 1000))
    const b = scissorBottoms(xs, TOP, LINK)
    expect(b).toHaveLength(xs.length - 2)
    for (let j = 0; j < b.length; j++) {
      // bottom pivot j sits under roller j+1, joined to the rollers either side of it
      for (const t of [xs[j]!, xs[j + 2]!]) expect(Math.hypot(b[j]![0] - t, b[j]![1] - TOP)).toBeCloseTo(LINK, 9)
    }
  })

  it('the truss is deep fully collapsed and shallow fully extended, and never flat', () => {
    // a section with no stand under it (odd, not the last), so its lowest steel is the truss's bottom pivots
    const closed = lowest(sectionSteel(straight(7.43), 5))
    const open = lowest(sectionSteel(straight(24), 5))
    const depth = (length: number) => Math.sqrt(LINK * LINK - (length / (N * K)) ** 2)
    // the link plates are 30 mm deep, so the drawn bottom is a plate-width below the pivot
    expect(closed).toBeCloseTo(TOP - depth(7.43), 1)
    expect(open).toBeCloseTo(TOP - depth(24), 1)
    expect(open - closed).toBeGreaterThan(0.1)
    expect(depth(24)).toBeGreaterThan(0.06)
  })

  it('on a bend the truss stands taller on the inside than the outside', () => {
    // bending toward -z (a left turn heading +X): the -z side is the inside
    const points: [number, number][] = [[5, 0], [10, -2], [14, -6]]
    const length = flexStations(points, N).pitch * N
    const pos = sectionSteel({ points, length }, 9)
    expect(lowest(pos, -1)).toBeLessThan(lowest(pos, 1) - 0.005)
  })
})
