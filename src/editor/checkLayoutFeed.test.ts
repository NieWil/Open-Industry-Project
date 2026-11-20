// core/checkLayout.ts's box-feed warning against the real first-party box spawner and belt (only this layer can load
// the committed part folders), and against the demo scene and its program, which it must pass clean.
//
// The case it exists for: a spawner over a belt whose run tag a program drives, not held with that belt, stacks
// boxes on the belt every time the program stops it (otherwise found only from a position dump), and one held with
// it but with keepSpacing off drops a box the instant the belt restarts, onto the one still under the drop.

import { beforeAll, describe, expect, it } from 'vitest'
import { checkLayout, exerciseProgram, formatLayoutFinding, type LayoutCheckOptions } from '../core/checkLayout'
import { clearPackages, getPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import type { PartInstance, SdkPartParams } from '../core/types'
import { LocalPlcLink, runnableSource } from '../plc'
import { checkWiring, wiredBindings } from '../plc/wiring'
import { registerBundledPackages } from './parts/bundledExamples'
import { createPlcDemoScene, DEMO_CONTROLLER, DEMO_PROGRAM } from './demo/demoScenes'

beforeAll(() => {
  clearPackages()
  registerBundledPackages()
})

const place = (packageId: string, id: string, pos: [number, number, number], params: SdkPartParams): PartInstance => {
  const part = createSdkPart(getPackage(packageId)!, id, pos)
  return { ...part, params: { ...part.params, ...params } } as PartInstance
}

// a 3 m belt whose tail is at the origin, top at y ~0.85, and a spawner 0.4 m along it, half a metre above
const belt = (params: SdkPartParams = {}): PartInstance =>
  place('oip.belt-conveyor', 'belt', [0, 0.8, 0], { segments: [[3, 0]] as unknown as SdkPartParams[string], runTag: 'BeltRun', ...params })
const spawner = (params: SdkPartParams = {}, pos: [number, number, number] = [0.4, 1.3, 0]): PartInstance =>
  place('oip.box-spawner', 'src', pos, params)

const feeds = (parts: PartInstance[], options: LayoutCheckOptions) => checkLayout(parts, options).filter((f) => f.kind === 'feed')
const driven = (...tags: string[]): LayoutCheckOptions => ({ drivenTags: new Set(tags) })

describe('box feed onto a driven belt', () => {
  it('warns when nothing holds the feed, naming the fix', () => {
    const [f, ...rest] = feeds([belt(), spawner()], driven('BeltRun'))
    expect(rest).toEqual([])
    expect(f).toMatchObject({ partId: 'src', kind: 'feed', severity: 'warning' })
    expect(f!.detail).toMatch(/nothing holds it/)
    expect(f!.detail).toMatch(/boxes stack/)
    expect(f!.detail).toContain('conveyorId = "belt" and keepSpacing = true')
    expect(formatLayoutFinding(f!)).toContain('[oip.box-spawner]')
  })

  it('warns when the feed holds with the belt but keepSpacing is off: the restart drop', () => {
    for (const held of [{ conveyorId: 'belt' }, { runTag: 'BeltRun' }] as SdkPartParams[]) {
      const [f] = feeds([belt(), spawner({ ...held, keepSpacing: false })], driven('BeltRun'))
      expect(f?.detail).toMatch(/keepSpacing is off/)
      expect(f?.detail).toMatch(/Fix: keepSpacing = true$/)
    }
  })

  it('is quiet when the feed holds with the belt and keeps spacing', () => {
    expect(feeds([belt(), spawner({ conveyorId: 'belt', keepSpacing: true })], driven('BeltRun'))).toEqual([])
    expect(feeds([belt(), spawner({ runTag: 'BeltRun', keepSpacing: true })], driven('BeltRun'))).toEqual([])
  })

  it('does not ask for keepSpacing on an On each enable spawner, which drops at every enable and ignores it', () => {
    for (const held of [{ conveyorId: 'belt' }, { runTag: 'BeltRun' }] as SdkPartParams[]) {
      expect(feeds([belt(), spawner({ ...held, release: 'enable' })], driven('BeltRun'))).toEqual([])
    }
    const [f] = feeds([belt(), spawner({ release: 'enable' })], driven('BeltRun'))
    expect(f?.detail).toMatch(/nothing holds it/)
    expect(f?.detail).toContain('Fix: conveyorId = "belt" (')
    expect(f?.detail).not.toContain('keepSpacing')
  })

  it('still warns with keepSpacing on when nothing holds the feed: spacing only matters while held', () => {
    const [f] = feeds([belt(), spawner({ keepSpacing: true })], driven('BeltRun'))
    expect(f?.detail).toMatch(/nothing holds it/)
    expect(f?.detail).toContain('conveyorId = "belt" (') // keepSpacing already on, so not asked for
  })

  it('is quiet for a belt nobody drives (it runs on its own), or one with no run tag', () => {
    expect(feeds([belt(), spawner()], driven())).toEqual([])
    expect(feeds([belt({ runTag: '' }), spawner()], driven('BeltRun'))).toEqual([])
  })

  it('is quiet without drivenTags (the Problems dock), for a paused feed, and for a feed over no belt', () => {
    expect(feeds([belt(), spawner()], {})).toEqual([])
    expect(feeds([belt(), spawner({ disable: true })], driven('BeltRun'))).toEqual([])
    expect(feeds([belt(), spawner({}, [10, 1.3, 0])], driven('BeltRun'))).toEqual([])
    // below the belt top is not dropping onto it
    expect(feeds([belt(), spawner({}, [0.4, 0.2, 0])], driven('BeltRun'))).toEqual([])
  })

  it('follows a turned belt', () => {
    const turned = { ...belt(), rotationY: Math.PI / 2 } as PartInstance // runs toward world -Z
    expect(feeds([turned, spawner({}, [0, 1.3, -1])], driven('BeltRun'))).toHaveLength(1)
    expect(feeds([turned, spawner({}, [1, 1.3, 0])], driven('BeltRun'))).toEqual([])
  })

  it('reports a feed on its own driven tag only on evidence that the program runs it with the belt off', () => {
    const parts = [belt(), spawner({ runTag: 'Feed' })]
    const opts = (seen: boolean): LayoutCheckOptions => ({ ...driven('BeltRun', 'Feed'), feedRunsWithoutBelt: (a, b) => seen && a === 'Feed' && b === 'BeltRun' })
    const [f] = feeds(parts, opts(true))
    expect(f?.detail).toMatch(/runs on its own runTag "Feed", which the program drives on while the belt's "BeltRun" is off/)
    expect(feeds(parts, opts(false))).toEqual([])
    expect(feeds(parts, driven('BeltRun', 'Feed'))).toEqual([])
  })
})

describe('exerciseProgram: the evidence', () => {
  const link = (src: string) => new LocalPlcLink(src)
  const ACCUMULATE = `VAR_INPUT Start : BOOL; Stop : BOOL; Eye : BOOL; END_VAR
VAR_OUTPUT Running : BOOL; Feed : BOOL; BeltRun : BOOL; END_VAR
Running := (Start OR Running) AND NOT Stop;
Feed := Running;
BeltRun := Running AND NOT Eye;`

  it('sees a feed that stays on while its belt accumulates (the merge an agent wrote)', () => {
    const seen = exerciseProgram(link(ACCUMULATE), 0.1)
    expect(seen('Feed', 'BeltRun')).toBe(true)
    // ...and never the belt on with the feed off: BeltRun implies Running = Feed
    expect(seen('BeltRun', 'Feed')).toBe(false)
  })

  it('repeats: it is seeded', () => {
    const a = exerciseProgram(link(ACCUMULATE), 0.1, 300)
    const b = exerciseProgram(link(ACCUMULATE), 0.1, 300)
    expect(a('Feed', 'BeltRun')).toBe(b('Feed', 'BeltRun'))
  })
})

describe('the demo scene', () => {
  it('passes the feed check with its own program: its case source runs only while the flex does', () => {
    const scene = createPlcDemoScene()
    const parts = scene.parts as PartInstance[]
    const base = new LocalPlcLink(runnableSource(DEMO_PROGRAM, DEMO_CONTROLLER))
    const bound = base.withBindings(wiredBindings(parts, base))
    const tags = new Set(checkWiring(parts, bound).tags.filter((t) => t.programWrites || t.writers.length > 0).map((t) => t.name))
    // not vacuous: the source drops onto the flex, whose run tag the program drives
    expect(tags.has('FlexRun')).toBe(true)
    const source = parts.find((p) => p.type === 'part' && p.packageId === 'oip.box-spawner')!
    const asked: string[] = []
    const seen = exerciseProgram(base.withBindings(wiredBindings(parts, base)), 0.1)
    const found = checkLayout(parts, { drivenTags: tags, feedRunsWithoutBelt: (a, b) => (asked.push(`${a}>${b}`), seen(a, b)) })
    expect(found.filter((f) => f.kind === 'feed')).toEqual([])
    expect(asked).toEqual(['LoadFlex>FlexRun'])
    expect((source.params as SdkPartParams).runTag).toBe('LoadFlex')
  })
})
