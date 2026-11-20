// Golden census of what every shipped part means to the host, across the format 4 vocabulary pass
// (docs/sdk-vocabulary.md). The pass renames and regroups fields; it must not change what any part does. So this
// table records derived facts, through the same functions the renderer and the sim call (conveyor classification,
// which links collide, which are guards or frames or walkable decks, lamps, grips, what geometry() draws), in
// neutral words. When a field is renamed, only the small `linkFacts` / `submeshFacts` extractors below change to
// read the new spelling; the printed table must stay byte-identical.
//
// To accept an intended behaviour change: `npx vitest run -u <this file>`, then read the diff.

import { beforeAll, describe, expect, it } from 'vitest'
import { evalPartGeometry, geometryAnimates, geometryLampNames } from '../core/geometry/geometryEval'
import type { ParamValue } from '../core/parts/partApi'
import type { PartPackage, RigLink } from '../core/parts/partPackage'
import { rigLampNames } from '../core/parts/partPackage'
import { upgradeStoredPackage } from '../core/parts/partUpgrade'
import {
  bedView,
  isBeltLike,
  isConveyorLike,
  isGuardPusher,
  isTailOriginConveyor,
  isWorldPhaseRollerBed,
  partFootprint,
  rectangleBedOf,
} from '../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { rigFrameSide, rigGuardSide } from '../core/guards/guardOpenings'
import { rigGuardWallLink, rigLinkEmitsBody } from '../core/rig/rigGuards'
import { createSdkPart } from '../core/scene/scene'
import { plugsOf } from '../core/snap/snapConnectors'
import { platformDeck } from '../core/structureConnections'
import type { PartInstance } from '../core/types'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from './parts/bundledExamples'

const pkgs: PartPackage[] = []
beforeAll(() => {
  clearPackages()
  const behaviors = bundledBehaviors()
  for (const m of bundledManifests()) {
    const p = buildPackage(m, behaviors.get(m.id)!)
    pkgs.push(p)
    registerPackage(p)
  }
  pkgs.sort((a, b) => a.id.localeCompare(b.id))
})

const fx = (n: number): string => (Math.abs(n) < 5e-5 ? '0' : n.toFixed(4))
function fmt(v: unknown): string {
  if (typeof v === 'number') return fx(v)
  if (Array.isArray(v)) return `[${v.map(fmt).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${k}:${fmt((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return String(v)
}

/** The package's param defaults: what an instance resolves to with nothing set. */
function defaults(pkg: PartPackage): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(pkg.params).map(([k, spec]) => [k, spec.default as ParamValue]))
}

// ---- the extractors: the only place that reads field names. Update these when a field is renamed; the
// ---- facts they print must not change.

/** What a rig link means, in neutral words. */
function linkFacts(link: RigLink, resolved: Record<string, unknown>): Record<string, unknown> {
  const l = link as RigLink & Record<string, unknown>
  return {
    shape: link.shape.kind,
    body: rigLinkEmitsBody(link, resolved) || undefined,
    guardSide: rigGuardSide(link) ?? undefined,
    frameSide: rigFrameSide(link) ?? undefined,
    guardWall: rigGuardWallLink(link, resolved) || undefined,
    look: link.finish, // the host material it borrows
    walkableDeck: link.notchable || undefined, // concrete walking surface, and what a deck notch cuts
    conveys: link.conveys || undefined,
    hidden: link.hidden || undefined,
    toggledBy: link.showParam,
    onEdge: link.onEdge,
    floorAnchor: link.anchor === 'floor' || undefined,
    lamps: link.lamps?.map((x) => x.name ?? link.name),
    gripZone: link.grip?.zone ? true : undefined,
    gripRadius: link.grip?.radius,
    outline: l.outline !== undefined || undefined,
    sensesBeam: link.beam ? true : undefined,
    zone: link.zone ? true : undefined,
  }
}

/** What a geometry() submesh means, in neutral words. */
function submeshFacts(m: Record<string, unknown>): Record<string, unknown> {
  return {
    look: m.finish,
    material: m.material,
    // the census's word for each channel predates format 4 ('static' = box, 'staticHull' = hull)
    collision: m.collision === 'box' ? 'static' : m.collision === 'hull' ? 'staticHull' : m.collision,
    lamp: (m.lamps as { name: string }[] | undefined)?.[0]?.name,
    scrolls: m.scroll ? true : undefined,
    spins: m.spin ? true : undefined,
    rides: m.link,
    instances: Array.isArray(m.instances) ? m.instances.length : undefined,
    noShadow: m.castShadow === false || undefined,
    doubleSided: m.doubleSided || undefined,
  }
}

function census(pkg: PartPackage): string[] {
  const part = createSdkPart(pkg, 'p', [0, 0, 0], 0) as unknown as PartInstance
  const resolved = { ...defaults(pkg), ...(part.params as Record<string, unknown>) }
  // the census's word for the drawn kind predates format 4 ('function')
  const lines: string[] = [`## ${pkg.id} (${pkg.geometry.kind === 'drawn' ? 'function' : pkg.geometry.kind})`]
  const straight = rectangleBedOf(part)
  const belt = bedView(part, 'path')
  lines.push(
    'class ' +
      fmt({
        conveyor: isConveyorLike(part) || undefined,
        beltLike: isBeltLike(part) || undefined,
        beltWidth: belt?.width,
        straight: straight ? { length: straight.length, width: straight.width } : undefined,
        spur: bedView(part, 'spur') ? true : undefined,
        curved: bedView(part, 'arc') ? true : undefined,
        rotatingDeck: bedView(part, 'turntable') ? true : undefined,
        worldPhaseRollers: isWorldPhaseRollerBed(part) || undefined,
        tailOrigin: isConveyorLike(part) ? isTailOriginConveyor(part) : undefined,
        guardPusher: isGuardPusher(part) || undefined,
        platformDeck: platformDeck(part) ?? undefined,
      }),
  )
  lines.push(`footprint ${fmt(partFootprint(part))}`)
  // the census's word for the tiling plug predates format 4 ('edges')
  lines.push(`plugs ${fmt(plugsOf(pkg.snap).map((p) => (p.label === 'tile' ? 'edges' : p.label)))}`)
  const reservedParams = ['speed', 'enableComms'].filter((k) => k in pkg.params)
  const tags = Object.entries(pkg.params).filter(([, s]) => s.type === 'tag').map(([k, s]) => `${k}:${s.dir ?? '?'}:${s.stType ?? '?'}`)
  lines.push(`params reserved=${fmt(reservedParams)} tags=${fmt(tags)}`)
  const lamps = [...rigLampNames(pkg.geometry, geometryLampNames(pkg.behavior, pkg.params))].sort()
  lines.push(`lamps ${fmt(lamps)} animates=${geometryAnimates(pkg.behavior, pkg.params)}`)
  if (pkg.geometry.kind === 'rig') {
    for (const link of pkg.geometry.links) lines.push(`  link ${link.name} ${fmt(linkFacts(link, resolved))}`)
  }
  const drawn = evalPartGeometry(pkg.behavior, defaults(pkg))
  drawn?.forEach((m, i) => lines.push(`  drawn[${i}] ${fmt(submeshFacts(m as unknown as Record<string, unknown>))}`))
  return lines
}

describe('declared conveyors (package format 4)', () => {
  it("every shipped part declares exactly what format 3 inferred: its conveyor (handles, drawn bed, speed and reverse names) and its comms switch", () => {
    for (const pkg of pkgs) {
      // the part as a format 3 package: no declarations, so the upgrade infers them by format 3's rules
      const { conveyor, commsParam, ...rest } = pkg
      const inferred = upgradeStoredPackage({ ...rest, format: 3 }).pkg as PartPackage
      // (format 3 had no friction param to infer: a part without one grips as its surface kind)
      const { frictionParam: _friction, ...declared } = conveyor ?? {}
      expect(inferred.conveyor, pkg.id).toEqual(conveyor ? declared : undefined)
      expect(inferred.commsParam, pkg.id).toEqual(commsParam)
    }
    expect(pkgs.filter((p) => p.conveyor?.bed).map((p) => `${p.id}:${p.conveyor!.bed}:${p.conveyor!.surface}`)).toHaveLength(7)
  })
})

describe('part census (what every shipped part means to the host)', () => {
  it('matches the golden table', async () => {
    const table = pkgs.flatMap((p) => [...census(p), '']).join('\n')
    // non-vacuity: the kinds of fact the vocabulary pass touches must all be present somewhere
    for (const needle of ['guardSide:', 'frameSide:', 'guardWall:true', 'walkableDeck:true', 'conveys:true', 'onEdge:', 'floorAnchor:true', 'lamps:', 'gripZone:true', 'outline:true', 'scrolls:true', 'spins:true', 'collision:', 'toggledBy:', 'conveyor:true', 'straight:', 'guardPusher:true', 'platformDeck:']) {
      expect(table, `the census never records ${needle}`).toContain(needle)
    }
    await expect(table).toMatchFileSnapshot('./__snapshots__/partCensus.txt')
  })
})
