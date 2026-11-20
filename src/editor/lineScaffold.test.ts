import { beforeAll, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { findSnap } from '../core/snap/snapFeatures'
import { conveyingSurfaceAt } from '../core/conveyor/conveyorSurface'
import { bedView, conveyorEndsOf } from '../core/parts/partGeometry'
import { scaffoldLine } from '../core/lineScaffold'
import { formatParamArgs, hiddenParamArgs, parseParamArgs, withParamArgs } from '../core/parts/partParamArgs'
import type { PartInstance, SdkPart } from '../core/types'
import { buildPackage } from '../sim/buildPackage'
import { bundledBehaviors, bundledManifests } from './parts/bundledExamples'

// core/lineScaffold.ts (npm run add-part --scaffold) and core/parts/partParamArgs.ts (--params / --host-params) against
// the real shipped parts: a scaffold is only as good as the snaps the shipped parts declare.

const pkgs = new Map<string, PartPackage>()
beforeAll(() => {
  clearPackages()
  const behaviors = bundledBehaviors()
  for (const m of bundledManifests()) {
    const pkg = buildPackage(m, behaviors.get(m.id)!)
    pkgs.set(pkg.id, pkg)
    registerPackage(pkg)
  }
})

const fresh = (packageId: string, id: string, params: Record<string, unknown> = {}): SdkPart => {
  const p = createSdkPart(pkgs.get(packageId)!, id, [0, 0, 0], 0, { placed: true })
  return Object.keys(params).length ? withParamArgs(p, params) : p
}

describe('parseParamArgs', () => {
  it('reads k=v pairs as JSON where they parse, strings where not, and keeps bracketed commas', () => {
    expect(parseParamArgs('width=0.8,on=true,tag=Belt1Run,segments=[[3,0],[1,10]],s="a,b"')).toEqual({
      width: 0.8,
      on: true,
      tag: 'Belt1Run',
      segments: [
        [3, 0],
        [1, 10],
      ],
      s: 'a,b',
    })
    expect(parseParamArgs('{"width":0.8}')).toEqual({ width: 0.8 })
    expect(() => parseParamArgs('width')).toThrow(/key=value/)
  })

  it('lets a bare string run on past a comma (an unquoted colour list), but not a JSON value', () => {
    expect(parseParamArgs('boxColors=#e33333,#33e333,width=1')).toEqual({ boxColors: '#e33333,#33e333', width: 1 })
    expect(() => parseParamArgs('width=1,#33e333')).toThrow(/"#33e333" is not key=value/)
  })

  it('refuses a list with each entry quoted, showing the whole line in the form that parses', () => {
    expect(() => parseParamArgs('boxColors="#e33333","#33e333",width=1')).toThrow(/ONE comma-joined value.*'boxColors=#e33333,#33e333,width=1'/)
    // what it shows parses to what was meant
    expect(parseParamArgs('boxColors=#e33333,#33e333,width=1')).toEqual({ boxColors: '#e33333,#33e333', width: 1 })
    // a stray piece after a JSON number has no reading to offer
    expect(() => parseParamArgs('width=1,#33e333')).not.toThrow(/comma-joined/)
  })

  it('formats args back into text that parses to the same values', () => {
    const args = { boxColors: '#e33333,#33e333', width: 0.8, on: true, tag: 'Belt1Run', text: 'two words', t: 'true', empty: '', segments: [[3, 0]], s: 'a,1' }
    expect(parseParamArgs(formatParamArgs(args))).toEqual(args)
    expect(formatParamArgs({ boxColors: '#e33333,#33e333', width: 1 })).toBe('boxColors=#e33333,#33e333,width=1')
  })
})

describe('withParamArgs', () => {
  it("gives a belt its length through the resize path (its segments) and refuses a param it doesn't have", () => {
    const belt = fresh('oip.belt-conveyor', 'b', { width: 0.8, length: 3 })
    expect(belt.params.width).toBe(0.8)
    expect(bedView(belt, 'path')!.segments.map((s) => s.length)).toEqual([3])
    expect(() => fresh('oip.belt-conveyor', 'b', { wdith: 0.8 })).toThrow(/no param "wdith"/)
  })

  it('checks each value against its declared type, naming the form it expects', () => {
    // the real case: a colour list is one comma-joined string, never a JSON array
    expect(() => fresh('oip.box-spawner', 's', { boxColors: ['#ff0000', '#00ff00'] })).toThrow(/boxColors is a list of #rrggbb colours joined by commas, as ONE string/)
    // ...with the whole line rewritten, ready to paste; but no rewrite to offer when an entry is not a colour
    expect(() => fresh('oip.box-spawner', 's', { boxColors: ['#ff0000', '#00ff00'], boxSize: 0.3 })).toThrow(/written so it parses: 'boxColors=#ff0000,#00ff00,boxSize=0.3'/)
    expect(() => fresh('oip.box-spawner', 's', { boxColors: ['#ff0000', 'blue'] })).not.toThrow(/written so it parses/)
    expect(() => fresh('oip.box-spawner', 's', { boxColors: '#ff0000,blue' })).toThrow(/"blue" is not a colour/)
    expect(fresh('oip.box-spawner', 's', { boxColors: '#FF0000, 00ff00' }).params.boxColors).toBe('#ff0000,#00ff00')
    expect(() => fresh('oip.box-spawner', 's', { boxColor: 'red' })).toThrow(/a colour, #rrggbb/)
    expect(() => fresh('oip.belt-conveyor', 'b', { accelTime: 'fast' })).toThrow(/accelTime is a number from 0 to 30/)
    expect(() => fresh('oip.belt-conveyor', 'b', { accelTime: 31 })).toThrow(/from 0 to 30/)
    expect(() => fresh('oip.belt-conveyor', 'b', { leftGuard: 'yes' })).toThrow(/true or false/)
    expect(() => fresh('oip.belt-conveyor', 'b', { beltTexture: 'woven' })).toThrow(/one of standard \| alternate/)
    expect(() => fresh('oip.belt-conveyor', 'b', { segments: [3, 0] })).toThrow(/rows of 2 numbers/)
    expect(() => fresh('oip.belt-conveyor', 'b', { segments: [] })).toThrow(/at least one row/)
    expect(() => fresh('oip.belt-conveyor', 'b', { runTag: 7 })).toThrow(/a PLC tag name/)
    expect(() => fresh('oip.box-spawner', 's', { conveyorId: [1] })).toThrow(/the id of a part/)
    // the forms that fit go through; a stand height (a host-resolved fact) is not held to its slider's max
    expect(fresh('oip.belt-conveyor', 'b', { segments: [[2, 0], [1, 10]], beltTexture: 'alternate', standHeight: 5 }).params.standHeight).toBe(5)
  })

  it('warns, with the fix, about a param its visibleWhen switch hides, from the spec alone', () => {
    const warnings: string[] = []
    const belt = createSdkPart(pkgs.get('oip.belt-conveyor')!, 'b', [0, 0, 0], 0, { placed: true, units: 'imperial' }) // an imperial scene: fpmUnits on
    expect(belt.params.fpmUnits).toBe(true)
    withParamArgs(belt, { speed: 1 }, warnings)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/speed is ignored: it is used only while fpmUnits = false/)
    expect(warnings[0]).toMatch(/Add fpmUnits=false, or give speedFpm instead/)
    // setting the switch with it, or giving the twin, is quiet
    expect(hiddenParamArgs(withParamArgs(belt, { speed: 1, fpmUnits: false }), { speed: 1, fpmUnits: false })).toEqual([])
    const quiet: string[] = []
    withParamArgs(belt, { speedFpm: 200 }, quiet)
    expect(quiet).toEqual([])
  })

  it('with followSwitches, turns the switch a given param needs (a units switch carrying its twins), unless told the switch', () => {
    const metric = (): SdkPart => createSdkPart(pkgs.get('oip.belt-conveyor')!, 'b', [0, 0, 0], 0, { placed: true, units: 'metric' })
    expect(metric().params.fpmUnits).toBe(false)
    // off (the default): the switch stays and the param is warned about
    const warned: string[] = []
    expect(withParamArgs(metric(), { speedFpm: 200 }, warned).params.fpmUnits).toBe(false)
    expect(warned[0]).toMatch(/speedFpm is ignored/)
    // on: the switch follows, the given value stands, the twin is carried (2 m/s -> 393.7 FPM), and it is said
    const notes: string[] = []
    const warnings: string[] = []
    const b = withParamArgs(metric(), { speedFpm: 200 }, warnings, { followSwitches: true, notes })
    expect(b.params.fpmUnits).toBe(true)
    expect(b.params.speedFpm).toBe(200)
    expect(b.params.speedAt30Fpm).toBeCloseTo(393.7, 1)
    expect(warnings).toEqual([])
    expect(notes[0]).toMatch(/fpmUnits set to true: speedFpm is used only while fpmUnits = true/)
    // a switch given explicitly is never overridden: the hidden param is still only warned about
    const kept: string[] = []
    const c = withParamArgs(metric(), { fpmUnits: false, speedFpm: 200 }, kept, { followSwitches: true, notes: [] })
    expect(c.params.fpmUnits).toBe(false)
    expect(kept[0]).toMatch(/speedFpm is ignored/)
    // params that want both settings of one switch leave it alone
    const both: string[] = []
    expect(withParamArgs(metric(), { speed: 1, speedFpm: 200 }, both, { followSwitches: true }).params.fpmUnits).toBe(false)
    expect(both[0]).toMatch(/speedFpm is ignored/)
    // the switch and its param given together: both kept
    const d = withParamArgs(metric(), { fpmUnits: true, speedFpm: 200 }, [], { followSwitches: true })
    expect([d.params.fpmUnits, d.params.speedFpm]).toEqual([true, 200])
  })

  it('names a tag without adding a comms switch the part does not declare', () => {
    const eye = fresh('oip.diffuse-sensor', 'e', { tag: 'Eye' })
    expect(eye.params.tag).toBe('Eye')
    expect('enableComms' in eye.params).toBe(false)
  })
})

describe('scaffoldLine', () => {
  it('seats the eye on the guard across a 3 m x 0.8 m belt, the spawner above its infeed, and programs a held stop', () => {
    const out = scaffoldLine([fresh('oip.belt-conveyor', 'belt', { width: 0.8, length: 3 }), fresh('oip.diffuse-sensor', 'eye'), fresh('oip.box-spawner', 'src')])
    const [belt, eye, src] = out.parts as [SdkPart, SdkPart, SdkPart]
    expect(out.roles.get('eye')).toBe('guard')
    // the snap engine fitted the beam to the belt (width + the mount's reach), and re-snapping finds it seated
    expect(eye.params.maxRange).toBeCloseTo(0.84, 6)
    const again = findSnap(eye as PartInstance, { position: eye.position, rotationY: eye.rotationY }, [belt as PartInstance])
    expect(again?.targetId).toBe('belt')
    expect(again!.pose.position[2]).toBeCloseTo(eye.position[2], 6)
    // on the line, before its discharge end, off the centreline
    const front = conveyorEndsOf(belt).find((e) => e.end === 'front')!
    expect(eye.position[0]).toBeLessThan(front.x)
    expect(Math.abs(eye.position[2])).toBeGreaterThan(0.4)
    // the spawner over the belt's infeed, its box (0.2 m below + half its 0.4 m height) clear of the surface
    const surface = conveyingSurfaceAt(belt, src.position[0], 0)
    expect(surface).not.toBeNull()
    expect(src.position[1] - 0.4).toBeGreaterThan(surface!.y)
    // held with that belt, so a stopped belt can't stack boxes under it (check-layout's feed warning)
    expect(src.params.conveyorId).toBe('belt')
    expect(src.params.keepSpacing).toBe(true)
    // wiring: meaningful names, and a program that drives rather than passes through
    expect(belt.params.runTag).toBe('Belt1Run')
    expect(eye.params.tag).toBe('DischargeEye')
    expect(src.params.runTag).toBe('SpawnerRun')
    expect(out.program).toContain('Belt1Run := Running AND NOT DischargeEye;')
    expect(out.program).toContain('SpawnerRun := Running AND NOT DischargeEye;')
    expect(out.program).not.toMatch(/Cmd\b/)
    expect(JSON.stringify(out.test)).toContain('DischargeEye')
    // a count nothing reads is not wired: the program's interface is what it uses
    expect(src.params.countTag ?? '').toBe('')
    expect(out.program).not.toContain('Count')
  })

  it('writes a Start/Stop latch that starts stopped, and a starter test that presses Start first', () => {
    const out = scaffoldLine([fresh('oip.belt-conveyor', 'belt', { length: 3 }), fresh('oip.diffuse-sensor', 'eye'), fresh('oip.box-spawner', 'src')])
    expect(out.program).toContain('Running := (Start OR Running) AND NOT Stop;')
    expect(out.program).toMatch(/^ {2}Running : BOOL; {2}\(\* starts stopped/m)
    expect(out.program).not.toMatch(/:= TRUE/)
    // no buttons in the scene: Start and Stop are still program inputs, for the test to drive
    expect(out.program).toMatch(/VAR_INPUT[\s\S]*Start : BOOL;[\s\S]*Stop : BOOL;[\s\S]*END_VAR/)
    const test = out.test as { inputs: { at: number; tag: string; value: boolean }[]; checks: Record<string, unknown>[] }
    expect(test.inputs).toEqual([
      { at: 0.5, tag: 'Start', value: true },
      { at: 1, tag: 'Start', value: false },
    ])
    // and it checks the line is stopped before the press
    expect(test.checks[0]).toEqual({ always: true, until: 0.4, tag: 'Running', equals: false })
    // with buttons, the press is the start button's tag
    const pb = scaffoldLine([fresh('oip.belt-conveyor', 'belt'), fresh('oip.box', 'box'), fresh('oip.push-button', 'b1'), fresh('oip.push-button', 'b2')])
    expect((pb.test as { inputs: { tag: string }[] }).inputs[0]!.tag).toBe('StartPB')
    expect(pb.program).not.toMatch(/Start : BOOL/)
  })

  it('wires a sink count only when the test reads it, and leaves a device nothing uses blank, saying so', () => {
    const withSink = scaffoldLine([fresh('oip.belt-conveyor', 'belt', { length: 3 }), fresh('oip.diffuse-sensor', 'eye'), fresh('oip.box-spawner', 'src'), fresh('oip.despawner', 'sink')])
    expect(withSink.parts.find((p) => p.id === 'sink')!.params.countTag).toBe('SinkCount')
    expect(JSON.stringify(withSink.test)).toContain('"tag":"SinkCount"')
    // no feed, so no test: the sink's count and the eye are read by nothing
    const bare = scaffoldLine([fresh('oip.belt-conveyor', 'belt', { length: 3 }), fresh('oip.diffuse-sensor', 'eye'), fresh('oip.despawner', 'sink'), fresh('oip.diverter', 'div')])
    const get = (id: string): SdkPart => bare.parts.find((p) => p.id === id)!
    expect(get('sink').params.countTag ?? '').toBe('')
    expect(get('eye').params.tag ?? '').toBe('')
    expect(bare.program).not.toMatch(/Diverter|Count|Eye/)
    expect(bare.notes.find((n) => n.startsWith('left blank'))).toMatch(/; div tag/)
  })

  it('never writes over a param that was given', () => {
    const given = { belt: ['standHeight'], eye: ['maxRange'], b1: ['text'] }
    const out = scaffoldLine([fresh('oip.belt-conveyor', 'belt', { standHeight: 1.1 }), fresh('oip.diffuse-sensor', 'eye', { maxRange: 2 }), fresh('oip.box', 'box'), fresh('oip.push-button', 'b1', { text: 'GO' })], { given })
    const get = (id: string): SdkPart => out.parts.find((p) => p.id === id)!
    expect(get('belt').params.standHeight).toBe(1.1)
    expect(get('belt').position[1]).toBe(1.1)
    expect(get('eye').params.maxRange).toBe(2)
    expect(get('b1').params.text).toBe('GO')
    // without `given`, the scaffold's own choices
    const plain = scaffoldLine([fresh('oip.belt-conveyor', 'belt', { standHeight: 1.1 }), fresh('oip.push-button', 'b1', { text: 'GO' })])
    expect(plain.parts[0]!.params.standHeight).toBe(0.8)
    expect(plain.parts[1]!.params.text).toBe('START')
  })

  it('butts conveyors end to end through the snap engine and names them per kind', () => {
    const out = scaffoldLine([fresh('oip.belt-conveyor', 'a', { length: 2 }), fresh('oip.roller-conveyor', 'b'), fresh('oip.belt-conveyor', 'c', { length: 2 })])
    const [a, b, c] = out.parts as [SdkPart, SdkPart, SdkPart]
    const gap = (u: SdkPart, v: SdkPart): number => conveyorEndsOf(v).find((e) => e.end === 'back')!.x - conveyorEndsOf(u).find((e) => e.end === 'front')!.x
    expect(Math.abs(gap(a, b))).toBeLessThan(0.05)
    expect(Math.abs(gap(b, c))).toBeLessThan(0.05)
    expect([a.params.runTag, b.params.runTag, c.params.runTag]).toEqual(['Belt1Run', 'Roller1Run', 'Belt2Run'])
    expect(out.notes.filter((n) => n.includes('no end-to-end snap'))).toEqual([])
  })

  it('mounts Start / Stop buttons on the frame, parented, and spreads several eyes infeed to discharge', () => {
    const out = scaffoldLine(
      [fresh('oip.belt-conveyor', 'belt'), fresh('oip.diffuse-sensor', 'e1'), fresh('oip.diffuse-sensor', 'e2'), fresh('oip.push-button', 'b1'), fresh('oip.push-button', 'b2'), fresh('oip.box-spawner', 'src')],
      { takenTags: ['Running'] },
    )
    const get = (id: string): SdkPart => out.parts.find((p) => p.id === id)!
    expect([get('e1').params.tag, get('e2').params.tag]).toEqual(['InfeedEye', 'DischargeEye'])
    expect(get('e1').position[0]).toBeLessThan(get('e2').position[0])
    expect([get('b1').params.tag, get('b2').params.tag]).toEqual(['StartPB', 'StopPB'])
    expect(get('b1').parent).toBe('belt')
    expect(get('b1').params.text).toBe('START')
    // a name the scene already uses is not reused
    expect(out.program).toContain('Running2 := (StartPB OR Running2) AND NOT StopPB;')
    const names = out.tags.map((t) => t.name.toUpperCase())
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps tag names given in --params, in the program and the test, and makes the rest up around them', () => {
    const out = scaffoldLine(
      [fresh('oip.belt-conveyor', 'belt', { length: 4, runTag: 'MainRun' }), fresh('oip.diffuse-sensor', 'eye', { tag: 'BoxAtEnd' }), fresh('oip.box-spawner', 'src'), fresh('oip.belt-conveyor', 'b2', { runTag: 'Belt1Run' })],
      { takenTags: ['MainRun'] }, // a given name is kept even if the scene has it: naming it is the point
    )
    const get = (id: string): SdkPart => out.parts.find((p) => p.id === id)!
    expect(get('belt').params.runTag).toBe('MainRun')
    expect(get('eye').params.tag).toBe('BoxAtEnd')
    expect(get('b2').params.runTag).toBe('Belt1Run')
    expect(out.program).toContain('MainRun : BOOL;')
    expect(out.program).toContain('Belt1Run := Running AND NOT BoxAtEnd;')
    expect(out.program).toContain('SpawnerRun := Running AND NOT BoxAtEnd;')
    expect(JSON.stringify(out.test)).toContain('"tag":"BoxAtEnd"')
    expect(out.program).not.toContain('DischargeEye')
    // two belts given one run tag share one variable, declared once
    const shared = scaffoldLine([fresh('oip.belt-conveyor', 'a', { length: 2, runTag: 'LineRun' }), fresh('oip.belt-conveyor', 'b', { length: 2, runTag: 'LineRun' })])
    expect(shared.program!.match(/LineRun : BOOL/g)).toHaveLength(1)
    expect(shared.program!.match(/LineRun :=/g)).toHaveLength(1)
    expect(shared.tags.find((t) => t.name === 'LineRun')!.owner).toBe('a.runTag, b.runTag')
  })

  it('declares any other tag given a name, and wires no tag that its visibleWhen hides', () => {
    const out = scaffoldLine([fresh('oip.belt-conveyor', 'belt', { fpmUnits: false, runningTag: 'BeltMoving', speedFpmTag: 'Hidden' })])
    expect(out.program).toContain('BeltMoving : BOOL;')
    expect(out.program).not.toContain('Hidden')
  })

  it('puts a device given --at at that spot along the line and names eyes by where they sit', () => {
    const out = scaffoldLine(
      [fresh('oip.belt-conveyor', 'belt', { length: 4 }), fresh('oip.diverter', 'div'), fresh('oip.diffuse-sensor', 'eye'), fresh('oip.despawner', 'sink'), fresh('oip.box', 'box')],
      { at: { div: [2.6, 0, 0], eye: [2, 0, 0], sink: [6, 0, 1] }, rotationY: { sink: Math.PI / 2 } },
    )
    const get = (id: string): SdkPart => out.parts.find((p) => p.id === id)!
    expect(get('eye').position[0]).toBeCloseTo(2, 1)
    expect(get('div').position[0]).toBeCloseTo(2.6, 1)
    // still seated by the snap: on the belt's guard, off the centreline
    expect(Math.abs(get('eye').position[2])).toBeGreaterThan(0.4)
    expect(out.notes.filter((n) => /unseated|no conveyor/.test(n))).toEqual([])
    expect(get('eye').params.tag).toBe('DischargeEye') // the only eye, whatever order it came in
    expect(get('sink').position).toEqual([6, 0, 1])
    expect(get('sink').rotationY).toBeCloseTo(Math.PI / 2, 9)
  })

  it('refuses a position for a conveyor and a yaw for a snapped device', () => {
    expect(() => scaffoldLine([fresh('oip.belt-conveyor', 'belt')], { at: { belt: [1, 0, 0] } })).toThrow(/end to end/)
    expect(() => scaffoldLine([fresh('oip.belt-conveyor', 'belt'), fresh('oip.diffuse-sensor', 'eye')], { rotationY: { eye: 1 } })).toThrow(/snap decides/)
  })
})
