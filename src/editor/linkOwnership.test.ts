import { describe, expect, it } from 'vitest'
import { linkFieldOwnership, resolvedBoxSize, resolvedCylinder, rigWorldPoses } from '../core/rig/rigPose'
import type { RigParams } from '../core/rig/rigPose'
import { rigInclineRad } from '../core/parts/partGeometry'
import { resolvePartParams } from '../core/parts/partScript'
import type { PartPackage, RigLink } from '../core/parts/partPackage'
import { listPackages } from '../core/parts/partRegistry'
import { registerBundledPackages } from './parts/bundledExamples'

// core's linkFieldOwnership says which of a link's fields an author may usefully edit. The editor locks what it
// reports as owned, so a wrong answer either hides a field that works or offers one the part overwrites - the
// "the node won't move" family. So every first-party part is held to it through the resolver the renderer and the
// sim place links with: nudge a field the answer calls authored and the result must move; nudge one it calls owned
// and the result must not. The answer cannot drift from what the part actually does.

type Rig = Extract<PartPackage['geometry'], { kind: 'rig' }>
// every first-party part, as the app builds and registers them at boot (through the HMR-safe door, bundledExamples)
registerBundledPackages()
const rigs = listPackages().filter((p): p is PartPackage & { geometry: Rig } => p.id.startsWith('oip.') && p.geometry.kind === 'rig')
const withLink = (geo: Rig, name: string, patch: (l: RigLink) => RigLink): Rig => ({ ...geo, links: geo.links.map((l) => (l.name === name ? patch(l) : l)) })
const pose = (geo: Rig, name: string, params: RigParams) => rigWorldPoses(geo, {}, undefined, 1, params, rigInclineRad(geo, params)).get(name)!
const moved = (a: readonly number[], b: readonly number[]): boolean => a.some((v, i) => Math.abs(v - b[i]!) > 1e-9)

describe('linkFieldOwnership agrees with the resolver, on every first-party part', () => {
  it('covers real parts', () => expect(rigs.length).toBeGreaterThan(10))

  for (const pkg of rigs) {
    it(pkg.id, () => {
      const geo = pkg.geometry
      const params = resolvePartParams(pkg.params, {}) as RigParams
      for (const link of geo.links) {
        const own = linkFieldOwnership(geo, link.name, params, pkg.behavior)!
        const at = pose(geo, link.name, params)
        // position, axis by axis
        for (const k of [0, 1, 2] as const) {
          const bumped = pose(withLink(geo, link.name, (l) => ({ ...l, offset: l.offset.map((v, i) => (i === k ? v + 0.137 : v)) as RigLink['offset'] })), link.name, params)
          const did = moved(at.pos, bumped.pos)
          expect(did, `${link.name} offset[${k}] ${own.offset[k] ? `owned by ${JSON.stringify(own.offset[k])} but an edit MOVED it` : 'reported editable but an edit did nothing'}`).toBe(own.offset[k] === null)
        }
        // the rest rotation
        const turned = pose(withLink(geo, link.name, (l) => {
          const next = { ...l, rotation: [0.21, -0.33, 0.17] as RigLink['rotation'] }
          delete next.quat
          return next
        }), link.name, params)
        expect(moved(at.quat, turned.quat), `${link.name} rotation ${own.rotation ? 'owned but an edit TURNED it' : 'reported editable but an edit did nothing'}`).toBe(own.rotation === null)
        // a box's size, axis by axis
        const s = link.shape
        if (s.kind === 'box') {
          const base = resolvedBoxSize(s.size, s.sizeParams, params)
          for (const k of [0, 1, 2] as const) {
            const grown = resolvedBoxSize(s.size.map((v, i) => (i === k ? v + 0.137 : v)) as typeof s.size, s.sizeParams, params)
            expect(moved(base, grown), `${link.name} box size[${k}]`).toBe(own.boxSize![k] === null)
          }
        } else if (s.kind === 'cylinder') {
          const base = resolvedCylinder(s, params)
          const r = resolvedCylinder({ ...s, radius: s.radius + 0.0137 }, params)
          const h = resolvedCylinder({ ...s, height: s.height + 0.137 }, params)
          expect(r.radius !== base.radius, `${link.name} radius`).toBe(own.cylinder!.radius === null)
          expect(h.height !== base.height, `${link.name} height`).toBe(own.cylinder!.height === null)
        }
      }
    })
  }
})

describe('linkFieldOwnership names the owners the editor shows', () => {
  const pkg = (id: string) => rigs.find((p) => p.id === id)!
  const own = (id: string, link: string) => {
    const p = pkg(id)
    return linkFieldOwnership(p.geometry, link, resolvePartParams(p.params, {}) as RigParams, p.behavior)!
  }

  it("a roller conveyor's side wall: its across-the-bed position belongs to the width", () => {
    const o = own('oip.roller-conveyor', 'wallL')
    expect(o.offset[0]).toBeNull()
    expect(o.offset[2]).toMatchObject({ by: 'param' })
  })

  it("the roller grid node: editable, but repeated on a world pitch, and drawn on by the script", () => {
    const o = own('oip.roller-conveyor', 'roller')
    expect(o.offset).toEqual([null, null, null])
    expect(o.notes).toContainEqual({ kind: 'array', worldPhase: true })
    expect(o.notes).toContainEqual({ kind: 'drawn' })
  })

  it("the robot's aimed hydraulic strut: its rotation belongs to the aim", () => {
    const p = pkg('oip.six-axis-robot')
    const aimed = p.geometry.links.find((l) => l.aim)!
    expect(own('oip.six-axis-robot', aimed.name).rotation).toEqual({ by: 'aim', target: aimed.aim!.target })
  })

  it('a jointed node notes its joint and keeps its rest pose editable', () => {
    const p = pkg('oip.six-axis-robot')
    const j = p.geometry.joints[0]!
    const o = own('oip.six-axis-robot', j.link)
    expect(o.notes).toContainEqual({ kind: 'joint', joint: j.name, type: j.type })
    expect(o.rotation).toBeNull()
  })
})
