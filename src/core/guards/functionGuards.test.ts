import { beforeEach, describe, expect, it } from 'vitest'
import { functionStaticHulls, functionStaticWalls } from './functionGuards'
import { clearPackages, registerPackage } from '../parts/partRegistry'
import type { PartPackage } from '../parts/partPackage'
import type { PartInstance } from '../types'
import { PACKAGE_FORMAT } from '../parts/partPackage'

// The static-wall / hull enumerations are memoized on (package, resolved params). A package edited in place
// (the browser behavior editor) keeps its id and its params, so the memo must also see the package's
// revision. Keyed on the id alone, the sim would keep building the old geometry's colliders while the renderer
// redraws the new one.

const source = (len: number): string => `
definePart({
  params: {},
  geometry: (g) => [
    { desc: g.box([${len}, 0.3, 0.005], [0, 0.15, 0.5]), finish: 'guard', collision: 'box', sideGuard: 'right' },
    { desc: g.box([${len}, 0.2, 0.2], [0, 0.1, 0]), collision: 'hull' },
  ],
  step: () => {},
})
`
const pkg = (len: number): PartPackage =>
  ({ format: PACKAGE_FORMAT, id: 'test.fn', name: 'Fn', params: {}, behavior: source(len), geometry: { kind: 'drawn' } }) as unknown as PartPackage
const part: PartInstance = { id: 'p', type: 'part', packageId: 'test.fn', position: [0, 0, 0], rotationY: 0, params: {} } as unknown as PartInstance

beforeEach(() => clearPackages())

describe('function static walls follow an in-place package edit', () => {
  it('re-registering the same id with new geometry yields the new walls and hulls', () => {
    registerPackage(pkg(2))
    expect(functionStaticWalls(part, pkg(2))[0]!.hx).toBeCloseTo(1, 9)
    const hullX = (): number => Math.max(...functionStaticHulls(part, pkg(2))[0]!.points.map((p) => p.x))
    expect(hullX()).toBeCloseTo(1, 9)

    registerPackage(pkg(3)) // same id, same (empty) params: only the source changed
    expect(functionStaticWalls(part, pkg(3))[0]!.hx).toBeCloseTo(1.5, 9)
    expect(Math.max(...functionStaticHulls(part, pkg(3))[0]!.points.map((p) => p.x))).toBeCloseTo(1.5, 9)
  })

  it('an unchanged re-registration keeps the memo (the same shared result)', () => {
    registerPackage(pkg(2))
    const first = functionStaticWalls(part, pkg(2))
    registerPackage(pkg(2))
    expect(functionStaticWalls(part, pkg(2))).toBe(first)
  })
})
